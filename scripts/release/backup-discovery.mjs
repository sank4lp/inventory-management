import {createHash,randomUUID} from 'node:crypto';
import {constants,chmodSync,closeSync,copyFileSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,rmSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

export const RETAINED_BACKUP_ROOT='/var/backups/lytguide';
export const STANDARD_BACKUP_DIRECTORIES=['/boot/firmware/LYTGUIDE-RECOVERY','/boot/LYTGUIDE-RECOVERY',RETAINED_BACKUP_ROOT];
export const MANAGED_BACKUP_NAME=/^LytGuide-(?:Uninstall-)?\d{8}T\d{6}-[a-f0-9]{8}\.lytbackup$/;
const MAX_BACKUP_BYTES=2*1024**3;
export function realDirectory(path){
 if(typeof path!=='string'||resolve(path)!==path||path==='/'||/[\0\r\n]/.test(path))return false;
 try{return !lstatSync(path).isSymbolicLink()&&statSync(path).isDirectory()&&realpathSync(path)===path;}catch{return false;}
}
export function backupDirectories(extra){return [...new Set([...STANDARD_BACKUP_DIRECTORIES,...(extra?[extra]:[])])].filter(realDirectory);}
export function discoverBackups(directories=STANDARD_BACKUP_DIRECTORIES){
 const found=[];
 for(const directory of [...new Set(directories)].filter(realDirectory)){
  let entries;try{entries=readdirSync(directory,{withFileTypes:true});}catch{continue;}
  for(const entry of entries){
   if(!entry.isFile()||!entry.name.endsWith('.lytbackup'))continue;
   const path=join(directory,entry.name);let info;try{info=lstatSync(path);}catch{continue;}
   if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>MAX_BACKUP_BYTES)continue;
   const id=createHash('sha256').update(JSON.stringify([path,info.dev,info.ino,info.size,info.mtimeMs])).digest('hex');
   found.push({id,name:entry.name,directory,bytes:info.size,modifiedAt:new Date(info.mtimeMs).toISOString(),path});
  }
 }
 return found.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt)||a.name.localeCompare(b.name));
}
export function publicBackups(items){return items.map(({path,...item})=>item);}
export function stageDetectedBackup(id,directory,{directories=STANDARD_BACKUP_DIRECTORIES}={}){
 if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new Error('Choose one of the detected backups.');
 const item=discoverBackups(directories).find(row=>row.id===id);if(!item)throw new Error('This backup changed or is no longer available. Refresh the list or browse for another file.');
 mkdirSync(directory,{recursive:true,mode:0o700});if(!realDirectory(directory))throw new Error('The backup upload folder is not a normal directory.');
 const token=randomUUID(),path=join(directory,token+'.lytbackup');let source;
 try{
  source=openSync(item.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  // /proc/self/fd pins the opened source on Linux; replacing its name cannot
  // redirect privileged copying to an unrelated file.
  copyFileSync(process.platform==='linux'?'/proc/self/fd/'+source:item.path,path,constants.COPYFILE_EXCL);
  const still=discoverBackups(directories).find(row=>row.id===id);if(!still||lstatSync(path).size!==item.bytes)throw new Error('The backup changed while it was being selected. Refresh and try again.');
  chmodSync(path,0o600);const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  return {id:token,name:item.name,bytes:item.bytes,path};
 }catch(error){rmSync(path,{force:true});throw error;}finally{if(source!==undefined)closeSync(source);}
}
