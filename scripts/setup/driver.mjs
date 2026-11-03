import {backupDirectories,discoverBackups,publicBackups,stageDetectedBackup} from '../release/backup-discovery.mjs';
import {loadControllerProfile} from '../../src/services/controller-profiles.js';
import {administratorPassword} from '../release/account-password.mjs';
import {execFile} from 'node:child_process';
import {createHmac,randomUUID,X509Certificate} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,writeFileSync,mkdirSync,rmSync,statSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {CONFIG_ROOT,INSTALL_ROOT,STATE_ROOT,validateTestConfig} from '../release/pi-package.mjs';
import {atomicJson,syncDirectory,ENCRYPTION_PROFILE} from '../release/card-recovery.mjs';
import {publishEnrollment} from '../release/lan-enrollment.mjs';
import {initialSetupState,advance,publicSetupState,requireRevision,validPassword,setupSteps,currentControllerReplies,restartedSetupState,locationSetupProgress,locationCompletion,commissioningSelection} from './model.mjs';

const folder=join(STATE_ROOT,'setup'),statePath=join(folder,'state.json'),pending=join(STATE_ROOT,'setup-pending');
const database=join(STATE_ROOT,'data/inventory.db');
function configuration(){return existsSync(join(CONFIG_ROOT,'config.json'))?validateTestConfig(JSON.parse(readFileSync(join(CONFIG_ROOT,'config.json'),'utf8'))):null;}
function records(sql,...args){if(!existsSync(database))return [];const db=new DatabaseSync(database,{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');return db.prepare(sql).all(...args);}finally{db.close();}}
function clearReconnectHints(){const db=new DatabaseSync(database);try{db.prepare("DELETE FROM app_metadata WHERE key='setup_reconnect_candidates'").run();}finally{db.close();}}
// execFile does not consume an `input` option. Pass secrets through its stdin,
// never through argv, environment variables, shell commands or setup state.
function child(cmd,args,input){return new Promise((resolve,reject)=>{const process=execFile(cmd,args,{encoding:'utf8',timeout:300000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(new Error(String(stderr||error.message).trim())):resolve(stdout));process.stdin.end(input==null?'':typeof input==='string'?input:JSON.stringify(input));});}
async function cli(action,input){return child('/usr/bin/lytguide-test',[action,'--input-stdin'],input);}
async function worker(action,input={}){return JSON.parse(await child(join(INSTALL_ROOT,'candidate/runtime/node'),[join(INSTALL_ROOT,'candidate/app/wizard-system.cjs')],{action,...input}));}
function embedCookie(){
  const config=configuration(),admin=records("SELECT id,role,session_version FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1")[0];
  if(!config||!admin)throw new Error('Create or restore the warehouse first.');
  const value=Buffer.from(JSON.stringify({userId:admin.id,role:admin.role,version:admin.session_version,exp:Date.now()+15*60000})).toString('base64url');
  return `session=${value}.${createHmac('sha256',config.sessionSecret).update(value).digest('base64url')}`;
}
export function commissioningCounts(){
  const controllers=records('SELECT id,controller_code,address,module_count,heartbeat_status,last_seen_at,firmware_version,configured_at FROM controllers WHERE active=1 ORDER BY id');
  if(controllers.length){const db=new DatabaseSync(database,{readOnly:true});try{for(const controller of controllers){const profile=loadControllerProfile(db,controller);controller.physical_count=profile?.physicalCount||controller.module_count;}}finally{db.close();}}
  const cells=records(`SELECT c.id,c.display_name,c.logical_code,c.controller_id,c.hardware_channel,c.binding_verified_at,
    EXISTS(SELECT 1 FROM location_labels l WHERE l.token=c.label_id AND l.cell_id=c.id AND l.state='bound' AND l.scanned_at IS NOT NULL) AS qr_verified
    FROM cells c WHERE c.active=1 ORDER BY c.id`);
  let reconnectCandidates=[];try{reconnectCandidates=JSON.parse(records("SELECT value FROM app_metadata WHERE key='setup_reconnect_candidates'")[0]?.value||'[]').filter(row=>!controllers.some(c=>c.address===row.address));}catch{}
  return {controllers,cells,...locationSetupProgress(controllers,cells),reconnectCandidates};
}
export class SetupDriver {
  constructor(){mkdirSync(folder,{recursive:true,mode:0o700});this.state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):initialSetupState();this.facts=null;this.network=null;this.ports=[];}
  restart(){
    // Only discard the wizard's checklist. Never reset warehouse records,
    // phone trust, recovery keys, controller configuration or ESP32 firmware.
    if(existsSync(join(STATE_ROOT,'restore-in-progress.json'))||existsSync(join(STATE_ROOT,'.setup-lock')))throw new Error('Wait for warehouse maintenance to finish, then reopen Setup.');
    if(records("SELECT value FROM app_metadata WHERE key='firmware_busy'")[0]?.value)throw new Error('Wait for the controller firmware job to finish, then reopen Setup.');
    return this.save(restartedSetupState(this.state));
  }
  save(next){this.state=next;atomicJson(statePath,next);return next;}
  async refresh(){const [facts,ports]=await Promise.all([worker('system'),worker('serial')]);this.facts=facts;this.network=facts.network;this.ports=ports;return this.status();}
  async status(){const config=configuration();let phone=null;try{const cert=new X509Certificate(readFileSync(join(STATE_ROOT,'caddy/pki/authorities/local/root.crt')));if(config?.address)phone={fingerprint:cert.fingerprint256,downloadUrl:config.enrollPort?`http://${config.address}:${config.enrollPort}`:null,appUrl:`https://${config.address}:${config.httpsPort}/work`};}catch{}
    let counts;try{counts=commissioningCounts();}catch(error){if(!['account','backup'].includes(this.state.step))throw error;counts={controllers:[],cells:[],mapped:0,initializing:true};}
    const administrator=records("SELECT id,username FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1")[0];
    return {state:publicSetupState(this.state),detectedBackups:publicBackups(this.detectedBackups()),facts:this.facts,network:this.network,ports:this.ports,counts,hasWarehouse:existsSync(database),hasRecoveryPassword:existsSync(ENCRYPTION_PROFILE),phone,localApp:config?`http://localhost:${config.appPort}/work`:null,pending:existsSync(pending),canResumeLocations:Boolean(config&&existsSync(database)&&(!existsSync(pending)||this.state.locationSetupReady===true)),existingWarehouse:config?{warehouseName:config.warehouseName||'Warehouse',username:administrator?.username||'',administratorId:administrator?.id||null}:null};
  }
  detectedBackups(){return discoverBackups(backupDirectories(configuration()?.recoveryDirectory));}
  async selectBackup(id){const item=stageDetectedBackup(id,join(folder,'uploads'),{directories:backupDirectories(configuration()?.recoveryDirectory)});try{return await this.upload(item.id,item.name,item.bytes,item.path);}catch(error){rmSync(item.path,{force:true});throw error;}}
  async upload(id,name,bytes,path){if(!['backup'].includes(this.state.step))throw new Error('Choose Replace Raspberry Pi and complete the network step first.');const previous=this.state.uploadedBackup?.path;this.save({...this.state,uploadedBackup:{id,name,bytes,path},backupSummary:null,revision:this.state.revision+1});if(previous&&previous!==path)rmSync(previous,{force:true});return this.status();}
  appCookie(){return embedCookie();}
  appPort(){return configuration()?.appPort||3310;}
  async certificate(){return new X509Certificate(readFileSync(join(STATE_ROOT,'caddy/pki/authorities/local/root.crt'))).raw;}
  async app(path,{method='GET',body}={}){const origin=`http://127.0.0.1:${this.appPort()}`;const response=await fetch(origin+path,{method,redirect:'manual',signal:AbortSignal.timeout(90000),headers:{Cookie:embedCookie(),Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Connection:'close'},...(body?{body:new URLSearchParams(body)}:{})});return response;}
  async pauseLocations(){
    const response=await this.app('/api/location-setup/snapshot');
    if(!response.ok)throw new Error('Location setup is unavailable. Check that the warehouse service is running.');
    const snapshot=await response.json();
    for(const session of snapshot.sessions.filter(row=>row.display_id)){
      const paused=await this.app('/api/location-setup/pause',{method:'POST',body:{sessionId:session.id,generation:String(session.generation),requestId:randomUUID()}});
      if(!paused.ok){const result=await paused.json();throw new Error(result.error||'The setup light could not be released. Retry before continuing.');}
    }
  }
  async action(action,input){
    requireRevision(this.state,input);
    const state=this.state;
    if(state.completedAt&&action!=='resumeLocations')throw new Error('Setup is already complete. Open the warehouse to continue.');
    if(action==='resumeLocations'){
      const config=configuration();
      if(!['choose','locations','finish'].includes(state.step)||!config||!existsSync(database)||existsSync(pending)&&state.locationSetupReady!==true)throw new Error('Finish the controller step before resuming location setup.');
      await child('/usr/bin/lytguide-test',['start']);
      const steps=setupSteps('configure').map(([key])=>key);
      this.save({...state,mode:'configure',step:'locations',done:steps.slice(0,steps.indexOf('locations')),completedAt:null,locationSetupReady:true,simulation:config.hardware==='simulator',warehouseName:config.warehouseName,address:config.address,revision:state.revision+1});
    }else if(action==='skipDetectedBackup'){
      if(state.step!=='choose')throw new Error('Open Get started first.');this.save({...state,backupPromptDismissed:true,revision:state.revision+1});
    }else if(action==='selectBackup'){
      if(state.step!=='backup')throw new Error('Open Restore warehouse first.');await this.selectBackup(input.backupId);
    }else if(action==='choose'){
      if(state.step!=='choose'||!['new','replace','configure'].includes(input.mode)||state.completedAt)throw new Error('Choose a setup path for this installation.');
      if(input.detectedBackupId&&(input.mode!=='replace'||!this.detectedBackups().some(row=>row.id===input.detectedBackupId)))throw new Error('The detected backup changed. Refresh the list or choose another file.');
      if(existsSync(database)&&!state.mode){
        if(input.mode==='new')throw new Error('This Pi already has warehouse data. Choose Set up existing warehouse or Replace Raspberry Pi.');
        if(input.pauseExisting!==true)throw new Error('Confirm that everyone stopped work on this Pi before running Setup.');
        if(records("SELECT 1 FROM task_lines WHERE execution_state='working' LIMIT 1").length)throw new Error('Stop or review active physical work in the existing warehouse before running Setup.');
        if(records("SELECT 1 FROM stocktake_display_claims LIMIT 1").length)throw new Error('Pause active stocktaking before running Setup.');
        await child('/usr/bin/lytguide-test',['stop']);
      }
      if(input.mode==='configure'&&!existsSync(database))throw new Error('There is no existing warehouse. Choose New warehouse.');
      writeFileSync(pending,'Warehouse Setup is in progress.\n',{mode:0o644});syncDirectory(STATE_ROOT);
      this.save({...state,mode:input.mode,step:'system',done:['choose'],locationSetupReady:false,detectedBackupId:input.detectedBackupId||null,backupPromptDismissed:true,revision:state.revision+1});
    }else if(action==='back'){
      const steps=setupSteps(state.mode,state).map(([key])=>key),target=steps.indexOf(input.step);
      if(target<1||target>=steps.indexOf(state.step)||!state.done.includes(input.step))throw new Error('Return to a completed setup step.');
      if(state.step==='locations')await this.pauseLocations();
      this.save({...state,step:input.step,done:state.done.filter(key=>steps.indexOf(key)<target),locationSetupReady:target>steps.indexOf('hardware')&&state.locationSetupReady===true,revision:state.revision+1});
    }else if(action==='system'){
      await this.refresh();if(!this.facts.checks.every(row=>row.ok))throw new Error('Resolve the highlighted Pi checks before continuing.');
      this.save(advance(state,'system'));
    }else if(action==='connect'){
      if(state.step!=='network')throw new Error('Open the network step first.');
      this.network=await worker('connect',{ssid:input.ssid,password:input.password,device:input.device});return this.status();
    }else if(action==='network'){
      this.network=await worker('network');
      if(!this.network.addresses.some(row=>row.address===input.address))throw new Error('Choose a current warehouse IP address on this Pi.');
      if(input.addressReserved!==true)throw new Error('Confirm that this address is reserved in the router so phones can keep using it.');
      this.save(advance(state,'network',{address:input.address}));
      if(state.mode==='replace'&&state.detectedBackupId)await this.selectBackup(state.detectedBackupId);
    }else if(action==='account'){
      if(!['new','configure'].includes(state.mode)||state.step!=='account')throw new Error('Open the administrator step first.');
      const existing=existsSync(database);
      if(!existing||input.adminPassword||input.adminConfirm){administratorPassword(input.adminPassword);if(input.adminPassword!==input.adminConfirm)throw new Error('Administrator passwords do not match.');}
      if(!existsSync(ENCRYPTION_PROFILE)){validPassword(input.recoveryPassword,'Recovery password');if(input.recoveryPassword!==input.recoveryConfirm)throw new Error('Recovery passwords do not match.');if(input.recoverySaved!==true)throw new Error('Confirm that you saved the recovery password separately.');}
      if(!/^[A-Za-z0-9._-]{1,80}$/.test(input.username||''))throw new Error('Use an administrator username with letters, numbers, dot, dash or underscore.');
      if(!String(input.warehouseName||'').trim()||String(input.warehouseName).length>80)throw new Error('Enter a warehouse name of 1–80 characters.');
      const administrator=existing?records("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1")[0]:null;
      const administratorId=existing?Number(input.administratorId||state.administratorId||administrator?.id):undefined;
      if(existing&&(!Number.isSafeInteger(administratorId)||!records("SELECT id FROM users WHERE id=? AND role='admin' AND status='active'",administratorId).length))throw new Error('This administrator is no longer available. Reopen Setup and try again.');
      // A service/backup failure can happen after the account was created.
      // Remember only these nonsecret choices so reopening Setup keeps the
      // actual username rather than silently reverting to the default.
      const prepared=this.save({...state,warehouseName:input.warehouseName.trim(),username:input.username,...(administratorId?{administratorId}:{}),revision:state.revision+1});
      await cli('setup',{address:state.address,username:input.username,administratorId,adminPassword:input.adminPassword||undefined,recoveryPassword:existsSync(ENCRYPTION_PROFILE)?undefined:input.recoveryPassword,blankWarehouse:true,warehouseName:input.warehouseName.trim(),enrollPort:8444});
      this.save(advance(prepared,'account'));
    }else if(action==='inspect'||action==='restore'){
      if(state.mode!=='replace'||state.step!=='backup'||!state.uploadedBackup)throw new Error('Choose the recovery file first.');
      if(!configuration()||configuration().address!==state.address||!configuration().enrollPort)await cli('setup',{address:state.address,prepareRestore:true,enrollPort:8444});
      const summary=JSON.parse(await cli('inspect-backup',{file:state.uploadedBackup.path,recoveryPassword:input.recoveryPassword}));
      if(action==='inspect'){this.save({...state,backupSummary:summary,...(['restore','clear-work','fresh'].includes(input.resetMode)?{resetMode:input.resetMode}:{}),...(typeof input.keepHardware==='boolean'?{keepHardware:input.keepHardware}:{}),revision:state.revision+1});return this.status();}
      if(!state.backupSummary)throw new Error('Check the backup and review its date and warehouse details before restoring.');
      if(input.restoreConfirmed!==true)throw new Error('Confirm the backup date and that the old Pi is powered off.');
      if(!summary.protected&&!existsSync(ENCRYPTION_PROFILE)){
        validPassword(input.futureRecoveryPassword,'New recovery password');if(input.futureRecoveryPassword!==input.futureRecoveryConfirm)throw new Error('Recovery passwords do not match.');
        if(input.recoverySaved!==true)throw new Error('Save the new recovery password separately before continuing.');
        await cli('setup',{address:state.address,prepareRestore:true,enrollPort:8444,recoveryPassword:input.futureRecoveryPassword});
      }
      const resetMode=input.resetMode||'restore';
      if(!['restore','clear-work','fresh'].includes(resetMode))throw new Error('Choose what to restore or reset.');
      if(resetMode!=='restore'&&(input.resetConfirmed!==true||typeof input.keepHardware!=='boolean'))throw new Error('Confirm which data to clear and whether to keep the hardware setup.');
      if(resetMode==='fresh'){
        administratorPassword(input.newAdminPassword);
        if(input.newAdminPassword!==input.newAdminConfirm)throw new Error('New administrator passwords do not match.');
        if(!/^[A-Za-z0-9._-]{1,80}$/.test(input.newUsername||''))throw new Error('Enter a new administrator username.');
      }
      await cli('restore',{file:state.uploadedBackup.path,recoveryPassword:input.recoveryPassword,confirmed:true,resetMode,keepHardware:input.keepHardware,resetConfirmed:input.resetConfirmed,newUsername:input.newUsername,newAdminPassword:input.newAdminPassword});
      const config=configuration();await cli('setup',{address:state.address,enrollPort:8444});
      this.save(advance(state,'backup',{backupSummary:summary,certificatePreserved:summary.certificateIdentity,restoredAt:new Date().toISOString(),resetMode,keepHardware:resetMode==='restore'?true:input.keepHardware}));
    }else if(action==='phones'){
      if(state.step!=='phones')throw new Error('Open the phone connection step first.');
      if(input.piOnly!==true&&input.phoneConfirmed!==true)throw new Error('Confirm the phone/tablet test, or choose Pi only for now.');
      const config=configuration(),url=`https://${config.address}:${config.httpsPort}/login`;
      // Use the saved authority explicitly rather than bypassing TLS verification.
      await child(join(INSTALL_ROOT,'current/runtime/node'),['-e',`const h=require('node:https'),f=require('node:fs');const r=h.get(${JSON.stringify(url)},{ca:f.readFileSync(${JSON.stringify(join(STATE_ROOT,'caddy/pki/authorities/local/root.crt'))})},s=>{s.resume();s.on('end',()=>process.exit(s.statusCode===200?0:1))});r.setTimeout(5000,()=>r.destroy());r.on('error',()=>process.exit(1));`]);
      this.save(advance(state,'phones',{phoneAccess:input.piOnly?'later':'confirmed'}));
    }else if(action==='bridge'){
      if(state.step!=='hardware')throw new Error('Open the controller step first.');
      this.ports=await worker('serial');
      if(!this.ports.some(port=>port.path===input.serialPort)||input.bridgeConfirmed!==true)throw new Error('Select and confirm the RS485 USB adapter.');
      if(records("SELECT value FROM app_metadata WHERE key='firmware_busy'")[0]?.value)throw new Error('Wait for controller maintenance to finish.');
      await cli('setup',{hardware:'rs485',serialPort:input.serialPort});
      this.save({...state,serialPort:input.serialPort,revision:state.revision+1});
    }else if(action==='hardware'){
      if(state.step!=='hardware')throw new Error('Open the controller step first.');
      if(input.simulation===true){if(input.simulationConfirmed!==true)throw new Error('Confirm that this is a test without physical lights.');await cli('setup',{hardware:'simulator'});this.save(advance(state,'hardware',{simulation:true,hardwareVerifiedAt:null,locationSetupReady:true}));}
      else {
        if(records("SELECT value FROM app_metadata WHERE key='firmware_busy'")[0]?.value)throw new Error('Wait for the controller firmware job to finish before changing the RS485 connection.');
        this.ports=await worker('serial');if(!this.ports.some(port=>port.path===input.serialPort)||input.bridgeConfirmed!==true)throw new Error('Select and confirm the RS485 USB adapter.');
        const counts=commissioningCounts();if(!counts.controllers.length)throw new Error('Add and verify at least one controller before checking RS485.');
        await cli('setup',{hardware:'rs485',serialPort:input.serialPort});
        const selected=commissioningSelection(counts.controllers,input.controllerIds,input.deferControllers),selectedIds=selected.map(row=>row.id),checkedAt=Date.now();
        for(const controller of selected){const response=await this.app('/devices/controller-test',{method:'POST',body:{controller_id:String(controller.id)}});await response.arrayBuffer();if(response.status>=400)throw new Error(`Controller ${controller.controller_code} check failed. Refresh controller health and retry.`);}
        const after=commissioningCounts();if(!currentControllerReplies(after.controllers.filter(row=>selectedIds.includes(row.id)),checkedAt))throw new Error('A selected controller did not respond. Check power, the selected adapter, A/B wiring and controller address, then retry.');
        this.save(advance(state,'hardware',{simulation:false,hardwareVerifiedAt:new Date().toISOString(),verifiedControllerIds:selectedIds,controllersDeferred:counts.controllers.filter(row=>!selectedIds.includes(row.id)).map(row=>row.id),locationSetupReady:true}));
      }
    }else if(action==='pauseLocationLights'){
      if(state.step!=='locations')throw new Error('Open the location step first.');await this.pauseLocations();
    }else if(action==='locations'){
      if(state.step!=='locations')throw new Error('Open the location step first.');
      const counts=commissioningCounts(),completion=locationCompletion(counts,{deferLocations:input.deferLocations??false,simulation:state.simulation});
      await this.pauseLocations();
      this.save(advance(state,'locations',completion));
    }else if(action==='finish'){
      if(state.step!=='finish')throw new Error('Complete the previous setup steps first.');
      const required=setupSteps(state.mode,state).map(([key])=>key).filter(key=>key!=='finish');
      if(required.some(key=>!state.done.includes(key)))throw new Error('Complete the remaining setup steps first.');
      const counts=commissioningCounts(),verified=state.verifiedControllerIds?counts.controllers.filter(row=>state.verifiedControllerIds.includes(row.id)):counts.controllers;
      if(!state.simulation&&(!verified.length||state.verifiedControllerIds&&verified.length!==state.verifiedControllerIds.length||verified.some(row=>row.heartbeat_status!=='online')))throw new Error('Controller checks changed. Return to Controllers and verify them.');
      if(['new','configure'].includes(state.mode)||state.keepHardware===false)locationCompletion(counts,{deferLocations:state.locationsDeferred===true,simulation:state.simulation});
      if(!existsSync(ENCRYPTION_PROFILE))throw new Error('Protected recovery backups have not been configured.');
      clearReconnectHints();await child('/usr/bin/lytguide-test',['backup']);
      this.save({...state,done:[...new Set([...state.done,'finish'])],completedAt:new Date().toISOString(),revision:state.revision+1});
      rmSync(pending,{force:true});syncDirectory(STATE_ROOT);
      if(this.state.uploadedBackup){rmSync(this.state.uploadedBackup.path,{force:true});this.save({...this.state,uploadedBackup:null});}
    }else throw new Error('Unknown setup step.');
    return this.status();
  }
}
