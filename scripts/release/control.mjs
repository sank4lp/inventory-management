#!/usr/bin/env node
import {uninstallWarehouse} from './uninstall.mjs';
import {administratorPassword} from './account-password.mjs';
import {desktopWindowArgs,desktopEnvironment,desktopExecutable} from './desktop.mjs';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {chmodSync,chownSync,closeSync,copyFileSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readlinkSync,renameSync,rmSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {networkInterfaces} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {lanNetwork,renderLanConfig} from '../lib/pi-lan.js';
import {APP_SERVICE,APP_USER,CONFIG_ROOT,INSTALL_ROOT,STATE_ROOT,WEB_SERVICE,WEB_USER,runtimeEnvironment,validateTestConfig,verifyRelease} from './pi-package.mjs';
import {RECOVERY_TIMER,RESTORE_MARKER,ENCRYPTION_PROFILE,acquireRecoveryLock,assertRestoreSettled,createRecoveryCopy,findCardRecoveryDirectory,ownTree,portable,unpackRecovery,recoveryStatus,recoveryVolume,rollbackRestore,saveRestorePoint,syncDirectory,atomicJson} from './card-recovery.mjs';
import {createRecoveryProfile,readSealedHeader,unlockRecoveryProfile} from './sealed-backup.mjs';
import {AUTHORITY_FILES,discardExpiredIntermediate} from './certificate-identity.mjs';
import {packageLanConfig,publishEnrollment} from './lan-enrollment.mjs';
import {WATCHDOG_TIMER,waitForDesktopApp} from './always-on.mjs';

const configPath=join(CONFIG_ROOT,'config.json');
const dbPath=join(STATE_ROOT,'data/inventory.db');
const current=join(INSTALL_ROOT,'current');
const candidate=join(INSTALL_ROOT,'candidate');
const rootCert=join(STATE_ROOT,'caddy/pki/authorities/local/root.crt');
const managedFiles=[configPath,join(CONFIG_ROOT,'runtime.env'),join(CONFIG_ROOT,'Caddyfile'),join(CONFIG_ROOT,'desktop-url'),ENCRYPTION_PROFILE];
function run(command,args=[],options={}) {
  try{return execFileSync(command,args,{encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe'],...options});}
  catch(error){throw new Error(`${command} failed: ${String(error.stderr||error.message).trim()}`);}
}
function serviceState(service,kind='is-active') {
  try{return run('systemctl',[kind,service]).trim();}catch{return 'inactive';}
}
function active(service){return serviceState(service)==='active';}
function requireRoot(){if(process.platform!=='linux'||process.arch!=='arm64')throw new Error('Run on a 64-bit Raspberry Pi, not the development Mac.');if(process.getuid()!==0)throw new Error('Run this command with sudo.');}
function readConfig(){return existsSync(configPath)?validateTestConfig(JSON.parse(readFileSync(configPath,'utf8'))):null;}
function account(user){return {uid:Number(run('id',['-u',user]).trim()),gid:Number(run('id',['-g',user]).trim())};}
function writeOwned(path,data,mode=0o600,owner=null){
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error(`Refusing a symbolic link at ${path}.`);
  const tmp=`${path}.new-${process.pid}`;
  writeFileSync(tmp,data,{mode,flag:'wx'});
  try{chmodSync(tmp,mode);if(owner)chownSync(tmp,owner.uid,owner.gid);renameSync(tmp,path);}finally{if(existsSync(tmp))unlinkSync(tmp);}
}
function pointCurrent(target){const next=`${current}.new-${process.pid}`;symlinkSync(target,next);renameSync(next,current);}
function portAvailable(host,port){return new Promise((resolvePort,reject)=>{const server=createServer();server.once('error',()=>reject(new Error(`Port ${port} at ${host} is already in use. No other service was stopped.`)));server.listen(port,host,()=>server.close(resolvePort));});}
function probe(url,ca){return new Promise((resolveProbe,reject)=>{const req=(url.startsWith('https:')?httpsRequest:httpRequest)(url,{method:'GET',timeout:4000,...(ca?{ca}:{} )},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolveProbe():reject(new Error(`App returned ${res.statusCode}.`)));});req.on('timeout',()=>req.destroy(new Error('App check timed out.')));req.on('error',reject);req.end();});}
async function waitForApp(config){let last;for(let i=0;i<20;i++){try{await probe(`http://127.0.0.1:${config.appPort}/login`);return;}catch(error){last=error;await new Promise(r=>setTimeout(r,500));}}throw last;}
async function waitForHttps(config){let last;for(let i=0;i<20;i++){try{await probe(`https://${config.address}:${config.httpsPort}/login`,readFileSync(rootCert));return;}catch(error){last=error;await new Promise(r=>setTimeout(r,500));}}throw last;}
function refuseOtherHardwareWriter(){
  for(const service of ['inventory-management.service','inventory-management-healthcheck.timer']) {
    if(active(service)||serviceState(service,'is-enabled')==='enabled')throw new Error(`Stop and disable ${service} before enabling real LEDs in the test app. Only one app may own the controller. The installer never stops your existing app for you.`);
  }
}
function parse(args){const [command='help',...rest]=args,options={};const values=new Set(['--address','--app-port','--https-port','--hardware','--serial-port','--admin','--file','--output','--confirm']);for(let i=0;i<rest.length;i++){const key=rest[i];if(['--no-start','--password-stdin','--scheduled','--input-stdin','--recovery-password-stdin','--resume'].includes(key)){options[key]=true;continue;}if(!values.has(key)||!rest[i+1]||rest[i+1].startsWith('--')||options[key]!==undefined)throw new Error('Unknown or repeated option. Run lytguide-test help.');options[key]=rest[++i];}return {command,options};}
async function password(options,{label='Choose an administrator password (hidden): ',confirm=true}={}){
  if(typeof options.__adminPassword==='string')return options.__adminPassword;
  if(options['--password-stdin'])return readFileSync(0,'utf8').replace(/\r?\n$/,'');
  if(!process.stdin.isTTY)throw new Error('Run setup in a terminal, or supply --password-stdin.');
  const rl=createInterface({input:process.stdin,output:process.stdout,terminal:false});
  const abort=new AbortController(),interrupt=()=>abort.abort();process.once('SIGINT',interrupt);
  try {
    process.stdout.write(label);
    run('stty',['-echo'],{stdio:'inherit'});
    const first=await rl.question('',{signal:abort.signal});if(!confirm){process.stdout.write('\n');return first;}process.stdout.write('\nConfirm password: ');
    const second=await rl.question('',{signal:abort.signal});process.stdout.write('\n');
    if(first!==second)throw new Error('Passwords do not match.');return first;
  } finally {run('stty',['echo'],{stdio:'inherit'});rl.close();process.removeListener('SIGINT',interrupt);}
}
function bootstrap(release,config,input){
  return run('runuser',['-u',APP_USER,'--',join(release,'runtime/node'),join(release,'app/bootstrap.cjs')],{cwd:release,input:JSON.stringify(input),env:{...process.env,NODE_ENV:'production',SESSION_SECRET:config.sessionSecret,DEMO_INVENTORY_SEED:'0'}});
}
function backupDatabase(release,config){
  if(!existsSync(dbPath))return null;
  const dir=join(STATE_ROOT,'recovery');mkdirSync(dir,{recursive:true,mode:0o700});
  // The previous process has stopped, so no movement can occur after this snapshot.
  const target=join(dir,`before-package-${Date.now()}-${randomUUID()}.sqlite`);
  run(join(release,'runtime/node'),[join(release,'app/bootstrap.cjs')],{cwd:release,input:JSON.stringify({action:'backup',source:dbPath,destination:target}),env:{...process.env,NODE_ENV:'production',SESSION_SECRET:config.sessionSecret}});
  chmodSync(target,0o600);return target;
}
async function setup(options){
  requireRoot();
  assertRestoreSettled();
  const noStart=options['--no-start']===true;
  if(!noStart&&!existsSync('/run/systemd/system'))throw new Error('A running systemd is required on the Pi. --no-start only prepares an inactive installation.');
  if(!existsSync(candidate))throw new Error('Install the .deb package first.');
  const release=resolve(INSTALL_ROOT,readlinkSync(candidate));
  if(!release.startsWith(`${INSTALL_ROOT}/releases/`))throw new Error('Invalid candidate release path.');
  const manifest=verifyRelease(release),before=readConfig();
  const config=validateTestConfig({appPort:3310,httpsPort:8443,address:null,hardware:'simulator',serialPort:'',sessionSecret:randomBytes(32).toString('hex'),siteId:`test-${randomUUID()}`,...before,
    ...(options['--app-port']?{appPort:Number(options['--app-port'])}:{}),...(options['--https-port']?{httpsPort:Number(options['--https-port'])}:{}),
    ...(options['--address']?{address:options['--address']}:{}),...(options['--hardware']?{hardware:options['--hardware']}:{}),...(options['--serial-port']?{serialPort:options['--serial-port']}:{}),
  });
  if(options.__blankWarehouse===true)config.blankWarehouse=true;
  if(options.__warehouseName)config.warehouseName=String(options.__warehouseName).trim();
  if(options.__enrollPort)config.enrollPort=Number(options.__enrollPort);
  const network=config.address?lanNetwork(config.address,networkInterfaces()):null;
  if(config.recoveryDirectory)recoveryVolume(config.recoveryDirectory);
  else {try{config.recoveryDirectory=findCardRecoveryDirectory();}catch(error){if(!noStart)throw error;}}
  if(config.recoveryDirectory)mkdirSync(config.recoveryDirectory,{recursive:true,mode:0o700});
  if(config.hardware==='rs485'){
    refuseOtherHardwareWriter();
    if(!existsSync(config.serialPort)||!statSync(config.serialPort).isCharacterDevice())throw new Error('The serial device is not present.');
  }
  const appWasActive=active(APP_SERVICE),webWasActive=active(WEB_SERVICE),timerWasActive=active(RECOVERY_TIMER),watchdogWasActive=active(WATCHDOG_TIMER);
  if(noStart&&(appWasActive||webWasActive))throw new Error('--no-start cannot change a running installation. Stop its services first.');
  if(!appWasActive||before?.appPort!==config.appPort)await portAvailable('127.0.0.1',config.appPort);
  if(network&&(!webWasActive||before?.httpsPort!==config.httpsPort||before?.address!==config.address))await portAvailable(config.address,config.httpsPort);
  if(network&&config.enrollPort&&(!webWasActive||before?.enrollPort!==config.enrollPort||before?.address!==config.address))await portAvailable(config.address,config.enrollPort);
  const username=options['--admin']||'admin';
  const existingAdministrator=existsSync(dbPath)&&options.__administratorId!==undefined;
  if(existingAdministrator){
    if(!Number.isSafeInteger(Number(options.__administratorId))||Number(options.__administratorId)<1||!/^[A-Za-z0-9._-]{1,80}$/.test(username))throw new Error('Choose the existing administrator and enter a valid username.');
    if(options.__adminPassword!==undefined&&options.__adminPassword!=='')administratorPassword(options.__adminPassword);
  }
  let newPassword;
  if(!existsSync(dbPath)&&!options.__prepareRestore){
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))throw new Error('Use a simple test administrator username.');
    newPassword=administratorPassword(await password(options));
  }
  const owner=account(APP_USER),webOwner=account(WEB_USER),oldCurrent=existsSync(current)?readlinkSync(current):null;
  const oldFiles=new Map(managedFiles.map(path=>[path,existsSync(path)?{bytes:readFileSync(path),mode:lstatSync(path).mode&0o777}:null]));
  const lock=join(STATE_ROOT,'.setup-lock');let fd;
  fd=acquireRecoveryLock(lock);
  let backup=null;
  try {
    if(webWasActive)run('systemctl',['stop',WEB_SERVICE]);
    if(appWasActive)run('systemctl',['stop',APP_SERVICE]);
    if(before)backup=backupDatabase(oldCurrent?resolve(INSTALL_ROOT,oldCurrent):release,before);
    pointCurrent(release);
    if(options.__recoveryPassword){
      if(existsSync(ENCRYPTION_PROFILE))unlockRecoveryProfile(JSON.parse(readFileSync(ENCRYPTION_PROFILE,'utf8')),options.__recoveryPassword);
      else atomicJson(ENCRYPTION_PROFILE,createRecoveryProfile(options.__recoveryPassword));
    }
    writeOwned(configPath,`${JSON.stringify(config,null,2)}\n`);
    writeOwned(join(CONFIG_ROOT,'runtime.env'),runtimeEnvironment(config),0o640,{uid:0,gid:owner.gid});
    writeOwned(join(CONFIG_ROOT,'desktop-url'),`http://localhost:${config.appPort}/work\n`,0o644);
    if(network){
      const caddy=packageLanConfig(config,network);
      writeOwned(join(CONFIG_ROOT,'Caddyfile'),caddy,0o640,{uid:0,gid:webOwner.gid});
      run('runuser',['-u',WEB_USER,'--',join(release,'runtime/caddy'),'validate','--config',join(CONFIG_ROOT,'Caddyfile'),'--adapter','caddyfile'],{env:{...process.env,HOME:join(STATE_ROOT,'caddy')}});
      publishEnrollment(config,webOwner);
    }
    if(newPassword){bootstrap(release,config,{action:'initialise',username,password:newPassword,blankWarehouse:config.blankWarehouse,warehouseName:config.warehouseName});chmodSync(dbPath,0o600);}
    if(existingAdministrator)bootstrap(release,config,{action:'administrator',userId:Number(options.__administratorId),username,password:options.__adminPassword});
    if(!noStart){
      run('systemctl',['daemon-reload']);run('systemctl',['enable',APP_SERVICE]);run('systemctl',['restart',APP_SERVICE]);await waitForApp(config);
      if(network){run('systemctl',['enable',WEB_SERVICE]);run('systemctl',['restart',WEB_SERVICE]);await waitForHttps(config);}
      else if(webWasActive)run('systemctl',['disable',WEB_SERVICE]);
      run('systemctl',['enable',WATCHDOG_TIMER]);run('systemctl',['start',WATCHDOG_TIMER]);
    }
    if(config.recoveryDirectory&&existsSync(dbPath)){
      const copy=await createRecoveryCopy(run,config);console.log(`SD-card recovery copy: ${copy.path}`);
      if(!noStart){run('systemctl',['enable',RECOVERY_TIMER]);run('systemctl',['start',RECOVERY_TIMER]);}
    }
    console.log(`LytGuide Test ${manifest.version} ${noStart?'prepared; services are not started':'is ready'}.`);
    console.log(`Pi app: http://localhost:${config.appPort}/work`);
    if(network)console.log(`Phone: https://${config.address}:${config.httpsPort}\nExport its public certificate: sudo lytguide-test certificate > ~/lytguide-test-root.cer`);
    if(newPassword)console.log(`Test administrator: ${username}. Your selected password was not saved in configuration.`);
    console.log(`Hardware: ${config.hardware}. Test data: ${STATE_ROOT}/data. Licensing: not required for this test build.`);
    if(backup)console.log(`Recovery snapshot: ${backup}`);
  } catch(error) {
    const repairErrors=[];const repair=fn=>{try{fn();}catch(e){repairErrors.push(e.message);}};
    if(!noStart){repair(()=>run('systemctl',['stop',WEB_SERVICE]));repair(()=>run('systemctl',['stop',APP_SERVICE]));}
    if(!noStart&&!timerWasActive){repair(()=>run('systemctl',['stop',RECOVERY_TIMER]));repair(()=>run('systemctl',['disable',RECOVERY_TIMER]));}
    if(!noStart&&!watchdogWasActive){repair(()=>run('systemctl',['stop',WATCHDOG_TIMER]));repair(()=>run('systemctl',['disable',WATCHDOG_TIMER]));}
    if(oldCurrent)repair(()=>pointCurrent(resolve(INSTALL_ROOT,oldCurrent)));
    for(const [path,file] of oldFiles){if(file)repair(()=>writeOwned(path,file.bytes,file.mode,path.endsWith('runtime.env')?{uid:0,gid:owner.gid}:path.endsWith('Caddyfile')?{uid:0,gid:webOwner.gid}:null));else if(existsSync(path))repair(()=>unlinkSync(path));}
    if(backup)repair(()=>{for(const suffix of ['-wal','-shm'])if(existsSync(dbPath+suffix))unlinkSync(dbPath+suffix);copyFileSync(backup,dbPath);chmodSync(dbPath,0o600);chownSync(dbPath,owner.uid,owner.gid);});
    if(!noStart){if(appWasActive)repair(()=>run('systemctl',['restart',APP_SERVICE]));else repair(()=>run('systemctl',['disable',APP_SERVICE]));if(webWasActive)repair(()=>run('systemctl',['restart',WEB_SERVICE]));else repair(()=>run('systemctl',['disable',WEB_SERVICE]));}
    throw new Error(`Test setup failed; the previous test configuration was restored. ${error.message}${repairErrors.length?` Recovery needs attention: ${repairErrors.join('; ')}`:''}`);
  } finally {closeSync(fd);unlinkSync(lock);}
}
async function confirmRestore(options,message){
  console.log(message);
  if(options['--confirm']==='RESTORE')return;
  if(options['--confirm']||!process.stdin.isTTY)throw new Error('Confirm explicitly with --confirm RESTORE, or run this in a terminal.');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{if(await rl.question('Keep the old Pi off. Type RESTORE to replace this test warehouse: ')!=='RESTORE')throw new Error('Restore cancelled.');}finally{rl.close();}
}
async function restoreWarehouse(options){
  requireRoot();assertRestoreSettled();
  const resetMode=options.__resetMode||'restore';
  if(!['restore','clear-work','fresh'].includes(resetMode))throw new Error('Choose restore, clear stock and work, or start fresh.');
  if(resetMode!=='restore'&&(options.__resetConfirmed!==true||typeof options.__keepHardware!=='boolean'))throw new Error('Confirm the reset level and hardware choice before continuing.');
  if(!options['--file'])throw new Error('Supply --file /path/to/LytGuide-backup.lytbackup.');
  const config=readConfig();if(!config)throw new Error('Run setup on the replacement Pi first.');
  const noStart=options['--no-start']===true;
  if(!noStart&&!existsSync('/run/systemd/system'))throw new Error('A running systemd is required.');
  const appWasActive=active(APP_SERVICE),webWasActive=active(WEB_SERVICE);
  if(noStart&&(appWasActive||webWasActive))throw new Error('--no-start requires stopped test services.');
  const lock=join(STATE_ROOT,'.setup-lock');let fd;
  fd=acquireRecoveryLock(lock);
  const staging=join(STATE_ROOT,'.restore-'+randomUUID());
  const certificateStage=join(STATE_ROOT,'.certificate-'+randomUUID());
  let saved=null,activated=false;
  try {
    let recoveryPassword=options.__recoveryPassword;
    if(readSealedHeader(resolve(options['--file']))&&!recoveryPassword){
      if(options['--recovery-password-stdin'])recoveryPassword=readFileSync(0,'utf8').replace(/\r?\n$/,'');
      else {recoveryPassword=await password({},{label:'Recovery password (hidden): ',confirm:false});}
    }
    const {manifest,profile}=await unpackRecovery(run,resolve(options['--file']),staging,recoveryPassword);
    if(typeof manifest.packageVersion!=='string'||!/^[0-9][0-9A-Za-z.+~:-]*$/.test(manifest.packageVersion))throw new Error('Invalid backup version.');
    const version=JSON.parse(readFileSync(join(current,'release.json'),'utf8')).version;
    try{run('dpkg',['--compare-versions',version,'ge',manifest.packageVersion]);}catch{throw new Error('This backup needs the same or a newer LytGuide package. Update the replacement Pi first.');}
    await confirmRestore(options,`Backup: ${manifest.createdAt}\n${manifest.counts.products} products · ${manifest.counts.cells} locations · ${manifest.counts.users} users · ${manifest.counts.tasks} tasks\nThis replaces the test warehouse on this Pi. Changes after the backup must be checked physically.`);
    const hasCertificate=existsSync(join(staging,'pki'));
    if(hasCertificate)renameSync(join(staging,'pki'),certificateStage);
    // Migrate and pause the extracted copy before touching this Pi's live data.
    let stageData=join(staging,'data');mkdirSync(stageData,{mode:0o700});
    renameSync(join(staging,'inventory.sqlite'),join(stageData,'inventory.db'));
    if(existsSync(join(staging,'archives')))renameSync(join(staging,'archives'),join(stageData,'archives'));
    const owner=account(APP_USER);ownTree(staging,owner);
    const preparation=run('runuser',['-u',APP_USER,'--',join(current,'runtime/node'),join(current,'app/bootstrap.cjs')],{cwd:staging,input:JSON.stringify(resetMode==='restore'?{action:'recover',createdAt:manifest.createdAt,blankWarehouse:manifest.hints?.blankWarehouse===true}:{action:'reset',resetMode,keepHardware:options.__keepHardware,username:options.__newUsername,password:options.__newAdminPassword,warehouseName:options.__warehouseName,destination:join(staging,'reset-warehouse')}),env:{...process.env,NODE_ENV:'production',SESSION_SECRET:config.sessionSecret,DEMO_INVENTORY_SEED:'0'},timeout:120000});
    if(resetMode!=='restore')stageData=join(staging,'reset-warehouse/data');
    if(webWasActive)run('systemctl',['stop',WEB_SERVICE]);
    if(appWasActive)run('systemctl',['stop',APP_SERVICE]);
    saved=saveRestorePoint({certificateReplaced:hasCertificate});
    renameSync(join(STATE_ROOT,'data'),join(saved,'data'));
    syncDirectory(saved);syncDirectory(STATE_ROOT);
    renameSync(stageData,join(STATE_ROOT,'data'));
    syncDirectory(STATE_ROOT);
    const next=validateTestConfig({...config,blankWarehouse:resetMode!=='restore'||manifest.hints?.blankWarehouse===true,sessionSecret:randomBytes(32).toString('hex'),hardware:'simulator',serialPort:''});
    writeOwned(configPath,JSON.stringify(next,null,2)+'\n');
    writeOwned(join(CONFIG_ROOT,'runtime.env'),runtimeEnvironment(next),0o640,{uid:0,gid:owner.gid});
    if(profile)atomicJson(ENCRYPTION_PROFILE,profile);
    if(hasCertificate){
      renameSync(join(STATE_ROOT,'caddy'),join(saved,'caddy'));syncDirectory(saved);
      const target=join(STATE_ROOT,'caddy/pki/authorities/local');mkdirSync(target,{recursive:true,mode:0o700});
      for(const name of AUTHORITY_FILES)copyFileSync(join(certificateStage,name),join(target,name));
      discardExpiredIntermediate(target);ownTree(join(STATE_ROOT,'caddy'),account(WEB_USER));
      if(next.address)run('runuser',['-u',WEB_USER,'--',join(current,'runtime/caddy'),'validate','--config',join(CONFIG_ROOT,'Caddyfile'),'--adapter','caddyfile'],{env:{...process.env,HOME:join(STATE_ROOT,'caddy')}});
    }
    publishEnrollment(next,account(WEB_USER));
    // Data/config are complete before removing the boot guard. A crash before
    // this point prevents automatic startup and leaves a reversible journal.
    rmSync(RESTORE_MARKER);
    syncDirectory(STATE_ROOT);
    if(!noStart){run('systemctl',['start',APP_SERVICE]);await waitForApp(next);if(next.address){run('systemctl',['start',WEB_SERVICE]);await waitForHttps(next);}}
    activated=true;
    console.log(`Warehouse prepared from ${manifest.createdAt}. ${preparation.trim()}\n${resetMode==='fresh'?'Sign in with the new administrator.':'Sign in with the retained warehouse accounts.'} Hardware is in simulator mode. Verify stock and hardware connections before enabling real controllers.\nPrevious test data retained at ${saved}/data`);
    if(next.recoveryDirectory)try{console.log('New recovery copy: '+(await createRecoveryCopy(run,next)).path);}catch(error){console.error('Warehouse restored, but its new SD-card copy failed: '+error.message);}
  } catch(error) {
    if(saved&&!activated){
      try{
        if(!noStart){run('systemctl',['stop',WEB_SERVICE]);run('systemctl',['stop',APP_SERVICE]);}
        if(!existsSync(RESTORE_MARKER))writeOwned(RESTORE_MARKER,JSON.stringify({folder:saved,certificateReplaced:existsSync(join(saved,'caddy')),oldConfig:managedFiles.filter(path=>existsSync(join(saved,path.split('/').pop()))).map(path=>path.split('/').pop())}));
        rollbackRestore();
        if(appWasActive)run('systemctl',['start',APP_SERVICE]);if(webWasActive)run('systemctl',['start',WEB_SERVICE]);
      }catch(repair){throw new Error(`Restore failed: ${error.message}. Recovery needs attention: ${repair.message}. Keep hardware off and run sudo lytguide-test restore-rollback.`);}
    }else if(!saved){if(appWasActive&&!active(APP_SERVICE))run('systemctl',['start',APP_SERVICE]);if(webWasActive&&!active(WEB_SERVICE))run('systemctl',['start',WEB_SERVICE]);}
    throw error;
  } finally {rmSync(staging,{recursive:true,force:true});rmSync(certificateStage,{recursive:true,force:true});closeSync(fd);unlinkSync(lock);}
}
async function main(){
  const {command,options}=parse(process.argv.slice(2));
  if(options['--input-stdin']){
    requireRoot();const input=JSON.parse(readFileSync(0,'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid setup request.');
    if(command==='setup')Object.assign(options,{'--address':input.address||undefined,'--admin':input.username||undefined,'--hardware':input.hardware||undefined,'--serial-port':input.serialPort||undefined,'--no-start':input.prepareRestore===true||input.noStart===true,__administratorId:input.administratorId,__adminPassword:input.adminPassword,__recoveryPassword:input.recoveryPassword,__prepareRestore:input.prepareRestore===true,__blankWarehouse:input.blankWarehouse===true,__warehouseName:input.warehouseName,__enrollPort:input.enrollPort});
    else if(command==='restore')Object.assign(options,{'--file':input.file,'--confirm':input.confirmed===true?'RESTORE':undefined,'--no-start':input.noStart===true,__recoveryPassword:input.recoveryPassword,__resetMode:input.resetMode,__resetConfirmed:input.resetConfirmed,__keepHardware:input.keepHardware,__newUsername:input.newUsername,__newAdminPassword:input.newAdminPassword,__warehouseName:input.warehouseName});
    else if(command==='inspect-backup')Object.assign(options,{'--file':input.file,__recoveryPassword:input.recoveryPassword});
    else throw new Error('That command does not accept a setup request.');
  }
  if(command==='help'){
    console.log('On the Raspberry Pi:\n  sudo lytguide-test setup [--address 192.168.1.140]\n  lytguide-test open\n  lytguide-test status\n  sudo lytguide-test certificate > ~/lytguide-test-root.cer\n  sudo lytguide-test update\n  sudo lytguide-test start|stop|restart\n  sudo lytguide-test backup\n  sudo lytguide-test backup --output /home/admin/warehouse.lytbackup\n  sudo lytguide-test restore --file /home/admin/warehouse.lytbackup\n  sudo lytguide-test restore-rollback\n  sudo lytguide-test setup --hardware rs485 --serial-port /dev/ttyUSB0\nDefaults: separate test data, simulator, app port 3310, HTTPS port 8443.\nSD-card recovery copies run every 15 minutes after setup. An update preserves test data and certificate storage. Finish physical work before updating.\nSee the included Pi test installer guide.');return;
  }
  if(command==='verify-start'){assertRestoreSettled();return;}
  if(command==='wizard'){
    if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid()===0)throw new Error('Open Warehouse Setup as the normal user on the Raspberry Pi desktop.');
    const executable=desktopExecutable(candidate);
    if(!existsSync(executable))throw new Error('Reinstall the complete LytGuide application. Its desktop runtime is missing.');
    const child=spawn(executable,desktopWindowArgs({setup:true,resume:options['--resume']===true}),{detached:true,stdio:'ignore',env:desktopEnvironment(process.env)});child.on('error',error=>console.error(error.message));child.unref();return;
  }
  if(command==='inspect-backup'){
    requireRoot();const stage=join(STATE_ROOT,'.inspect-'+randomUUID());
    try{const {manifest,profile}=await unpackRecovery(run,resolve(options['--file']),stage,options.__recoveryPassword);console.log(JSON.stringify({createdAt:manifest.createdAt,counts:manifest.counts,packageVersion:manifest.packageVersion,protected:!!profile,certificateIdentity:existsSync(join(stage,'pki'))}));}finally{rmSync(stage,{recursive:true,force:true});}return;
  }
  if(command==='restore'){await restoreWarehouse(options);return;}
  if(command==='restore-rollback'){
    requireRoot();if(active(APP_SERVICE)||active(WEB_SERVICE))throw new Error('Stop test services before rolling back an interrupted restore.');
    await confirmRestore(options,'Roll back the interrupted restore to the previously saved test warehouse.');
    const fd=acquireRecoveryLock();try{console.log('Previous test data/configuration restored from '+rollbackRestore()+'. Run sudo lytguide-test start when ready.');}finally{closeSync(fd);rmSync(join(STATE_ROOT,'.setup-lock'));}return;
  }
  if(command==='uninstall'){requireRoot();await uninstallWarehouse();return;}
  if(command==='backup'){
    requireRoot();const config=readConfig();if(!config)throw new Error('Run setup first.');
    let fd;const lock=join(STATE_ROOT,'.setup-lock');
    try{fd=acquireRecoveryLock(lock);}catch(error){if(options['--scheduled']){console.log('Recovery copy deferred: '+error.message);return;}throw error;}
    try{const result=await createRecoveryCopy(run,config,{output:options['--output']});console.log('Recovery backup: '+result.path+'\nSnapshot time: '+result.createdAt);}finally{closeSync(fd);unlinkSync(lock);}return;
  }
  if(command==='setup'||command==='update'){await setup(options);return;}
  if(command==='version'){console.log(JSON.parse(readFileSync(join(candidate,'release.json'),'utf8')).version);return;}
  if(command==='certificate'){requireRoot();if(!existsSync(rootCert))throw new Error('Start warehouse HTTPS first. No certificate has been created.');process.stdout.write(new X509Certificate(readFileSync(rootCert)).raw);return;}
  if(command==='status'){
    console.log(existsSync(configPath)?`Test app: ${serviceState(APP_SERVICE)}; HTTPS: ${serviceState(WEB_SERVICE)}. Run with sudo for configuration changes.\n${recoveryStatus()}`:'Not configured. Run sudo lytguide-test setup.');return;
  }
  if(command==='open'){
    if(process.getuid?.()===0)throw new Error('Open the app as the Pi desktop user, without sudo.');
    if(!existsSync(configPath)||existsSync(join(STATE_ROOT,'setup-pending'))){run('/usr/bin/lytguide-test',['wizard','--resume'],{timeout:360000,stdio:'inherit'});return;}
    const url=readFileSync(join(CONFIG_ROOT,'desktop-url'),'utf8').trim();
    if(!/^http:\/\/localhost:\d+\/work$/.test(url))throw new Error('Invalid local app address. Run setup again.');
    const executable=desktopExecutable(candidate);
    if(!existsSync(executable))throw new Error('Reinstall the complete LytGuide application. Its desktop runtime is missing.');
    const child=spawn(executable,desktopWindowArgs(),{detached:true,stdio:'ignore',env:desktopEnvironment(process.env)});child.on('error',error=>console.error(error.message));child.unref();return;
  }
  if(command==='autostart'){
    if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid?.()===0)throw new Error('Automatic opening runs as the Pi desktop user.');
    if(!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return;
    const executable=desktopExecutable(candidate);if(!existsSync(executable))return;
    const result=await waitForDesktopApp({
      readUrl:()=>existsSync(join(CONFIG_ROOT,'desktop-url'))?readFileSync(join(CONFIG_ROOT,'desktop-url'),'utf8').trim():null,
      isPending:()=>!existsSync(configPath)||existsSync(join(STATE_ROOT,'setup-pending')),
      probe,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
      launch:url=>new Promise((resolveLaunch,reject)=>{const child=spawn(executable,desktopWindowArgs(),{detached:true,stdio:'ignore',env:desktopEnvironment(process.env)});child.once('error',reject);child.once('spawn',()=>{child.unref();resolveLaunch();});}),
    });
    if(!result.opened&&result.reason)console.log(result.reason);return;
  }
  if(['start','stop','restart'].includes(command)){
    requireRoot();const config=readConfig();if(!config)throw new Error('Run setup first.');
    if(command!=='stop')assertRestoreSettled();
    if(command!=='stop'&&config.hardware==='rs485')refuseOtherHardwareWriter();
    if(command==='stop'){if(config.address)run('systemctl',['stop',WEB_SERVICE]);run('systemctl',['stop',APP_SERVICE]);}
    else{run('systemctl',[command,APP_SERVICE]);await waitForApp(config);if(config.address){run('systemctl',[command,WEB_SERVICE]);await waitForHttps(config);}}
    console.log(`LytGuide Test: ${command} complete.`);return;
  }
  throw new Error('Unknown command. Run lytguide-test help.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
