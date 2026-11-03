import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {closeSync,cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {CONFIG_ROOT,INSTALL_ROOT,STATE_ROOT} from './pi-package.mjs';
import {acquireRecoveryLock,createRecoveryCopy,findCardRecoveryDirectory,syncDirectory} from './card-recovery.mjs';
import {MANAGED_BACKUP_NAME,RETAINED_BACKUP_ROOT,STANDARD_BACKUP_DIRECTORIES,realDirectory} from './backup-discovery.mjs';

const SERVICES=['lytguide-test-watchdog.timer','lytguide-test-watchdog.service','lytguide-test-setup.service','lytguide-test-backup.timer','lytguide-test-backup.service','lytguide-test-web.service','lytguide-test.service'];
const defaultRun=(command,args=[],options={})=>execFileSync(command,args,{encoding:'utf8',timeout:300000,stdio:['pipe','pipe','pipe'],...options});
export function parseBackupAnswer(value){const answer=String(value??'').trim().toLowerCase();if(['','n','no'].includes(answer))return false;if(['y','yes'].includes(answer))return true;throw new Error('Enter Y or N. Press Enter to keep the backups.');}
export async function askDeleteBackups(input=process.stdin,output=process.stdout){
 const rl=createInterface({input,output});
 try{for(;;){let answer;try{answer=await rl.question('Delete all LytGuide-managed backups too, including the new copy? [y/N] ');}catch(error){if(error.code==='ERR_USE_AFTER_CLOSE')return false;throw error;}try{return parseBackupAnswer(answer);}catch(error){output.write(error.message+'\n');}}}finally{rl.close();}
}
function ownedRoot(path){if(existsSync(path)&&(!realDirectory(path)||lstatSync(path).isSymbolicLink()))throw new Error('Refusing an unexpected linked or non-directory installation path: '+path);}
export function removeManagedBackups(directory,{retainedRoot=RETAINED_BACKUP_ROOT}={}){
 if(!realDirectory(directory))return;
 for(const name of readdirSync(directory)){
  const path=join(directory,name),entry=lstatSync(path);
  if(entry.isSymbolicLink())continue;
  if(entry.isFile()&&MANAGED_BACKUP_NAME.test(name))rmSync(path);
  if(entry.isFile()&&name==='READ-ME.txt'&&readFileSync(path,'utf8').startsWith('LYTGUIDE RECOVERY\n'))rmSync(path);
  if(entry.isFile()&&name==='recovery-info.json'){try{const value=JSON.parse(readFileSync(path,'utf8'));if(MANAGED_BACKUP_NAME.test(value.filename||'')&&/^[a-f0-9]{64}$/.test(value.sha256||''))rmSync(path);}catch{}}
  if(directory===retainedRoot&&entry.isDirectory()&&/^uninstall-recovery-[a-f0-9-]+$/.test(name))rmSync(path,{recursive:true});
 }
 syncDirectory(directory);if((STANDARD_BACKUP_DIRECTORIES.includes(directory)||directory===retainedRoot)&&!readdirSync(directory).length)rmdirSync(directory);
}
function removeProfiles(run){
 let users=[];try{users=run('getent',['passwd']).trim().split('\n').map(line=>line.split(':'));}catch{return;}
 for(const [name,,uid,,,home] of users){
  if(Number(uid)<1000||Number(uid)>=65534||!home?.startsWith('/home/')||!realDirectory(home))continue;
  for(const type of ['.config','.cache']){
   const parent=join(home,type);if(!realDirectory(parent))continue;
   const path=join(parent,'LytGuide');if(existsSync(path))rmSync(path,{recursive:true,force:true});
  }
 }
}
async function stopDesktopProcesses(){
 const targets=[];for(const name of readdirSync('/proc').filter(name=>/^\d+$/.test(name))){
  try{const executable=realpathSync('/proc/'+name+'/exe');if(executable.startsWith(INSTALL_ROOT+'/releases/')&&executable.endsWith('/desktop/lytguide-desktop')){process.kill(Number(name),'SIGTERM');targets.push(Number(name));}}catch{}
 }
 if(targets.length){await new Promise(resolve=>setTimeout(resolve,500));for(const pid of targets)try{const executable=realpathSync('/proc/'+pid+'/exe');if(executable.startsWith(INSTALL_ROOT+'/releases/')&&executable.endsWith('/desktop/lytguide-desktop'))process.kill(pid,'SIGKILL');}catch{}}
}
function cleanSystem(run){
 for(const service of SERVICES){const path='/etc/systemd/system/'+service;rmSync(path,{force:true});rmSync(path+'.d',{recursive:true,force:true});}
 try{run('systemctl',['daemon-reload']);run('systemctl',['reset-failed',...SERVICES]);}catch{}
 for(const name of ['lytguide-test','lytguide-test-web']){try{const entry=run('getent',['passwd',name]).trim().split(':');if(entry[0]===name&&Number(entry[2])<1000&&entry[5]===STATE_ROOT){run('userdel',[name]);try{run('groupdel',[name]);}catch{}}}catch{}}
 rmSync('/var/log/lytguide-offline-install.log',{force:true});
}
export async function uninstallWarehouse({run=defaultRun,confirm=askDeleteBackups,log=console.log,paths={install:INSTALL_ROOT,state:STATE_ROOT,config:CONFIG_ROOT,retained:RETAINED_BACKUP_ROOT},cleanupSystem=cleanSystem,backup=createRecoveryCopy,locate=findCardRecoveryDirectory,cleanProfiles=removeProfiles,stopDesktop=stopDesktopProcesses,purge=true}={}){
 const {install,state,config}=paths,retained=paths.retained||RETAINED_BACKUP_ROOT,managedDirectories=paths.backupDirectories||STANDARD_BACKUP_DIRECTORIES;for(const path of [install,state,config])ownedRoot(path);
 if(!existsSync(join(install,'.lytguide-test-installation')))throw new Error('This is not a managed LytGuide installation. Nothing was deleted.');
 if(existsSync(join(state,'restore-in-progress.json')))throw new Error('An interrupted restore must be recovered before uninstalling.');
 log('Uninstall LytGuide. A fresh warehouse recovery copy will be saved before removal.');
 const deleteBackups=await confirm();
 const configuration=existsSync(join(config,'config.json'))?JSON.parse(readFileSync(join(config,'config.json'),'utf8')):{};
 let fd,stopped=false,removed=false,deletingBackups=false;const wasActive=[];
 const lock=join(state,'.setup-lock');let saved=null;
 try{
  fd=acquireRecoveryLock(lock);
  // Refuse to interrupt firmware even when no warehouse work is running.
  if(existsSync(join(state,'data/inventory.db'))){const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(state,'data/inventory.db'),{readOnly:true});try{if(db.prepare("SELECT value FROM app_metadata WHERE key='firmware_busy'").get()?.value)throw new Error('Wait for the controller firmware operation to finish before uninstalling.');}finally{db.close();}}
  for(const service of SERVICES){try{if(run('systemctl',['is-active',service]).trim()==='active')wasActive.push(service);}catch{}}
  stopped=true;run('systemctl',['stop',...SERVICES]);await stopDesktop();
  let directory;try{directory=locate();}catch{directory=retained;}
  mkdirSync(directory,{recursive:true,mode:0o700});if(!realDirectory(directory))throw new Error('The retained-backup folder is not a normal directory.');
  if(existsSync(join(state,'data/inventory.db'))){
   // A non-FAT fallback still uses the checked, durable publisher; only the
   // automatic Finder-readable SD destination normally requires FAT.
   saved=await backup(run,{...configuration,recoveryDirectory:directory},{directoryVerified:true,retainAll:true,purpose:'uninstall'});
   if(!saved?.path||!existsSync(saved.path)||!lstatSync(saved.path).isFile()||lstatSync(saved.path).size<1)throw new Error('The latest backup could not be confirmed. Nothing was removed.');
   log('Latest warehouse backup saved: '+saved.path);
  }else log('No warehouse database exists on this installation. Existing recovery copies will be kept unless you selected Y.');
  // Preserve older local restore points too, outside the application folders.
  const recovery=join(state,'recovery');
  if(realDirectory(recovery)&&readdirSync(recovery).length){mkdirSync(retained,{recursive:true,mode:0o700});if(!realDirectory(retained))throw new Error('The recovery folder is not a normal directory.');const target=join(retained,'uninstall-recovery-'+randomUUID());try{renameSync(recovery,target);}catch(error){if(error.code!=='EXDEV')throw error;cpSync(recovery,target,{recursive:true,dereference:false,errorOnExist:true,force:false});}syncDirectory(retained);}
  if(purge)run('dpkg',['--purge','lytguide-test']);removed=true;
  cleanProfiles(run);
  for(const path of [install,state,config]){ownedRoot(path);rmSync(path,{recursive:true,force:true});}
  cleanupSystem(run);
  if(deleteBackups){deletingBackups=true;for(const path of [...new Set([...managedDirectories,retained,configuration.recoveryDirectory,directory].filter(Boolean))])removeManagedBackups(path,{retainedRoot:retained});log('LytGuide and its managed backups were deleted.');}
  else log('LytGuide was removed. Backups were kept'+(saved?' at '+saved.path:'.')+'\nReinstall LytGuide to restore a backup. You will need its recovery password.');
  return {removed:true,deleteBackups,backupPath:deleteBackups?null:saved?.path||null};
 }catch(error){
  if(stopped&&!removed)for(const service of wasActive)try{run('systemctl',['start',service]);}catch{}
  throw new Error(error.message+(removed?(deletingBackups?' Software was removed, but backup cleanup needs attention.':' The latest backup remains available if cleanup did not finish.'):' Uninstall stopped before removing warehouse data.'));
 }finally{if(fd!==undefined){closeSync(fd);rmSync(lock,{force:true});}}
}
