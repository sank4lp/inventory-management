import {RETAINED_BACKUP_ROOT,STANDARD_BACKUP_DIRECTORIES,realDirectory} from './backup-discovery.mjs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync,chownSync,copyFileSync,existsSync,lstatSync,mkdirSync,openSync,closeSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync,fsyncSync,constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {CONFIG_ROOT,INSTALL_ROOT,STATE_ROOT} from './pi-package.mjs';
import {sealRecovery,openRecovery,validateRecoveryProfile} from './sealed-backup.mjs';
import {checkAuthority} from './certificate-identity.mjs';
import {refreshWarehouseExcel} from '../../src/services/warehouse-excel.js';

export const RECOVERY_TIMER='lytguide-test-backup.timer';
export const RESTORE_MARKER=join(STATE_ROOT,'restore-in-progress.json');
const statusPath=join(STATE_ROOT,'recovery-status.json');
export const ENCRYPTION_PROFILE=join(CONFIG_ROOT,'recovery-encryption.json');
export function syncDirectory(path){const fd=openSync(path,'r');try{fsyncSync(fd);}catch(error){if(!['EINVAL','ENOTSUP'].includes(error.code))throw error;}finally{closeSync(fd);}}
export function acquireRecoveryLock(path=join(STATE_ROOT,'.setup-lock')) {
  for(let attempt=0;attempt<2;attempt++) {
    try{const fd=openSync(path,'wx',0o600);writeFileSync(fd,String(process.pid));fsyncSync(fd);return fd;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const text=readFileSync(path,'utf8');
      if(/^\d+$/.test(text)&&Number(text)>1){
        try{process.kill(Number(text),0);}catch(probe){if(probe.code==='ESRCH'){rmSync(path);continue;}}
      }
      throw new Error('Another setup, restore or backup is running. Try again shortly. If power failed, retry after the old process is gone.');
    }
  }
  throw new Error('Could not acquire the recovery lock.');
}

export function recoveryVolume(path,findMount=(target)=>JSON.parse(execFileSync('findmnt',['-J','-T',target,'-o','TARGET,FSTYPE'],{encoding:'utf8'}))) {
  const target=existsSync(path)?path:dirname(path);
  const mount=findMount(target).filesystems?.[0];
  if(!mount||!['vfat','exfat','msdos','fat'].includes(mount.fstype)||!mount.target||mount.target==='/')throw new Error('Recovery storage must be on a mounted FAT/exFAT volume so Finder can read it.');
  if(resolve(path)!==path||path.includes('\n')||path.includes('\0')||existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Recovery storage must be a normal folder, not a symbolic link.');
  const actualParent=realpathSync(existsSync(path)?path:dirname(path));
  if(actualParent!==mount.target&&!actualParent.startsWith(mount.target+'/'))throw new Error('Recovery storage is outside the readable volume.');
  return path;
}
export function findCardRecoveryDirectory() {
  for(const mount of ['/boot/firmware','/boot'])try{return recoveryVolume(join(mount,'LYTGUIDE-RECOVERY'));}catch{}
  throw new Error('No Mac-readable SD-card boot volume was found at /boot/firmware or /boot. Mount the original FAT boot partition before setup.');
}
export function recoveryUnits() {
  return {
    service:`[Unit]
Description=LytGuide Test portable recovery backup
After=local-fs.target
ConditionPathExists=${CONFIG_ROOT}/config.json

[Service]
Type=oneshot
User=root
ExecStart=${INSTALL_ROOT}/current/runtime/node ${INSTALL_ROOT}/current/app/control.cjs backup --scheduled
TimeoutStartSec=5min
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${STATE_ROOT} -/boot/firmware/LYTGUIDE-RECOVERY -/boot/LYTGUIDE-RECOVERY
`,
    timer:`[Unit]
Description=LytGuide Test recovery copy every 15 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
AccuracySec=30s
Unit=lytguide-test-backup.service

[Install]
WantedBy=timers.target
`};
}
export function atomicJson(path,value,mode=0o600) {
  const temp=path+'.new-'+randomUUID();
  try{writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);syncDirectory(dirname(path));}finally{rmSync(temp,{force:true});}
}
export function portable(run,input,script=join(INSTALL_ROOT,'current/app/portable-backup.py')) {
  return JSON.parse(run('python3',[script],{input:JSON.stringify(input),timeout:240000}));
}
export async function createRecoveryCopy(run,config,{output=null,directoryVerified=false,retainAll=false,purpose=null,portableScript=join(INSTALL_ROOT,'current/app/portable-backup.py')}={}) {
  if(existsSync(RESTORE_MARKER))throw new Error('An interrupted restore needs recovery first. Run sudo lytguide-test restore-rollback.');
  const version=JSON.parse(readFileSync(join(INSTALL_ROOT,'current/release.json'),'utf8')).version;
  const recovery=join(STATE_ROOT,'recovery');mkdirSync(recovery,{recursive:true,mode:0o700});
  const staged=join(recovery,`export-${randomUUID()}.lytbackup`);
  const sealed=staged+'.protected';
  const excelSnapshot=staged+'.sqlite';
  const excel=(directory,createdAt)=>{try{return refreshWarehouseExcel(excelSnapshot,directory,{createdAt});}catch(error){return {lastError:error.message};}};
  try {
    const profile=existsSync(ENCRYPTION_PROFILE)?validateRecoveryProfile(JSON.parse(readFileSync(ENCRYPTION_PROFILE,'utf8'))):null;
    const pki=join(STATE_ROOT,'caddy/pki/authorities/local'),includePki=Boolean(profile&&(config.address||existsSync(join(pki,'root.key'))));
    if(includePki)checkAuthority(pki);
    const manifest=portable(run,{action:'create',data:join(STATE_ROOT,'data'),destination:staged,version,excelSnapshot,hints:{siteId:config.siteId,hardware:config.hardware,serialPort:config.serialPort,blankWarehouse:config.blankWarehouse===true,warehouseName:config.warehouseName||'',certificateIdentity:!!includePki},...(includePki?{pki}:{})},portableScript);
    if(profile)await sealRecovery(staged,sealed,profile);
    const source=profile?sealed:staged;
    if(output){const target=resolve(output);copyFileSync(source,target,constants.COPYFILE_EXCL);chmodSync(target,0o600);const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}return {path:target,createdAt:manifest.createdAt,counts:manifest.counts,protected:!!profile,excel:excel(dirname(target),manifest.createdAt)};}
    if(!config.recoveryDirectory)throw new Error('SD-card recovery has not been configured. Run setup on the Pi, or backup --output /path/file.lytbackup.');
    const directory=directoryVerified&&STANDARD_BACKUP_DIRECTORIES.includes(config.recoveryDirectory)?config.recoveryDirectory:recoveryVolume(config.recoveryDirectory);mkdirSync(directory,{recursive:true,mode:0o700});if(!realDirectory(directory))throw new Error('The backup directory is not a normal folder.');
    const copy=portable(run,{action:'publish',source,directory,retainAll,purpose},portableScript);
    // These small files help a Mac user choose the latest copy; the archive itself
    // remains independently restorable if a power loss interrupts this index.
    atomicJson(join(directory,'recovery-info.json'),{...copy,createdAt:manifest.createdAt,packageVersion:version,protected:!!profile},0o600);
    writeFileSync(join(directory,'READ-ME.txt'),`LYTGUIDE RECOVERY\nCopy the newest LytGuide-*.lytbackup file to your Mac. Keep a second copy away from this SD card.\nOn the replacement Pi install the same or a newer package. Open Warehouse Setup, choose Replace Raspberry Pi and select the recovery file.\n${profile?'This copy is protected. Supply the recovery password chosen for this warehouse.':'This is a legacy unencrypted copy; new phone trust may be required.'}\nThe old Pi must stay off. Keep this file private: it contains warehouse and account data.\nCommand-line recovery is also available: sudo lytguide-test restore --file /home/admin/your-backup.lytbackup\n`, {mode:0o600});
    const result={path:join(directory,copy.filename),createdAt:manifest.createdAt,counts:manifest.counts,protected:!!profile,excel:excel(directory,manifest.createdAt)};
    atomicJson(statusPath,{...result,lastAttemptAt:new Date().toISOString(),lastError:null},0o644);
    return result;
  } catch(error) {
    let previous={};try{previous=JSON.parse(readFileSync(statusPath,'utf8'));}catch{}
    atomicJson(statusPath,{...previous,lastAttemptAt:new Date().toISOString(),lastError:error.message},0o644);
    throw error;
  } finally {rmSync(staged,{force:true});rmSync(sealed,{force:true});rmSync(excelSnapshot,{force:true});}
}
export async function unpackRecovery(run,source,destination,password){
  const decrypted=join(STATE_ROOT,'recovery',`unlocked-${randomUUID()}.tar.gz`);
  try{const profile=await openRecovery(source,decrypted,password);const manifest=portable(run,{action:'extract',source:profile?decrypted:source,destination});if(existsSync(join(destination,'pki'))){if(!profile)throw new Error('Phone certificate keys are accepted only inside a protected recovery file.');checkAuthority(join(destination,'pki'));}return {manifest,profile};}
  catch(error){rmSync(destination,{recursive:true,force:true});throw error;}finally{rmSync(decrypted,{force:true});}
}
export function recoveryStatus() {
  try {const value=JSON.parse(readFileSync(statusPath,'utf8'));return `Recovery copy: ${value.createdAt||'none'}${value.path?' · '+value.path:''}${value.lastError?' · Last attempt failed: '+value.lastError:''}`;}catch{return 'Recovery copy: not yet created.';}
}
export function assertRestoreSettled(){if(existsSync(RESTORE_MARKER))throw new Error('Restore was interrupted. Keep hardware off and run sudo lytguide-test restore-rollback.');}
export function ownTree(path,owner) {
  if(lstatSync(path).isSymbolicLink())throw new Error('Unexpected symbolic link in restored data.');
  chownSync(path,owner.uid,owner.gid);chmodSync(path,lstatSync(path).isDirectory()?0o700:0o600);
  if(lstatSync(path).isDirectory())for(const child of readdirSync(path))ownTree(join(path,child),owner);
}
const files=['config.json','runtime.env','Caddyfile','desktop-url','device-access.json','recovery-encryption.json'];
export function saveRestorePoint({certificateReplaced=false}={}) {
  const folder=join(STATE_ROOT,'recovery','pre-restore-'+randomUUID());mkdirSync(folder,{mode:0o700});
  const manifest={folder,certificateReplaced,oldConfig:files.filter(name=>existsSync(join(CONFIG_ROOT,name)))};
  for(const name of manifest.oldConfig){copyFileSync(join(CONFIG_ROOT,name),join(folder,name));chmodSync(join(folder,name),0o600);}
  for(const name of manifest.oldConfig){const fd=openSync(join(folder,name),'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
  syncDirectory(folder);
  atomicJson(RESTORE_MARKER,manifest);
  return folder;
}
export function rollbackRestore() {
  if(!existsSync(RESTORE_MARKER))throw new Error('No interrupted restore was found.');
  const manifest=JSON.parse(readFileSync(RESTORE_MARKER,'utf8'));
  if(!new RegExp('^'+STATE_ROOT+'/recovery/pre-restore-[a-f0-9-]+$').test(manifest.folder)||!Array.isArray(manifest.oldConfig)||manifest.oldConfig.some(name=>!files.includes(name)))throw new Error('Invalid restore recovery record. Keep services stopped and inspect the saved recovery folder.');
  const original=join(manifest.folder,'data'),live=join(STATE_ROOT,'data');
  if(existsSync(original)){
    if(existsSync(live))renameSync(live,join(manifest.folder,'failed-data-'+randomUUID()));
    renameSync(original,live);
  }
  if(manifest.certificateReplaced&&existsSync(join(manifest.folder,'caddy'))){rmSync(join(STATE_ROOT,'caddy'),{recursive:true,force:true});renameSync(join(manifest.folder,'caddy'),join(STATE_ROOT,'caddy'));}
  // Saved files were copied root-only. Restore service-readable ownership too.
  const appGroup=Number(execFileSync('id',['-g','lytguide-test'],{encoding:'utf8'})),webGroup=Number(execFileSync('id',['-g','lytguide-test-web'],{encoding:'utf8'}));
  for(const name of files){const destination=join(CONFIG_ROOT,name);if(manifest.oldConfig.includes(name)){copyFileSync(join(manifest.folder,name),destination);chmodSync(destination,['desktop-url','device-access.json'].includes(name)?0o644:name==='config.json'?0o600:0o640);chownSync(destination,0,name==='runtime.env'?appGroup:name==='Caddyfile'?webGroup:0);}else rmSync(destination,{force:true});}
  rmSync(RESTORE_MARKER);
  syncDirectory(STATE_ROOT);
  return manifest.folder;
}
