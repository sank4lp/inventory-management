import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,closeSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {networkInterfaces} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {APP_SERVICE,WEB_SERVICE,STATE_ROOT,CONFIG_ROOT,validateTestConfig} from './pi-package.mjs';
import {RESTORE_MARKER,acquireRecoveryLock,atomicJson} from './card-recovery.mjs';
import {READINESS_PATH,readinessToken} from '../../src/modules/runtime/readiness.js';
import {healthDecision} from './always-on.mjs';
const statusPath=join(STATE_ROOT,'watchdog-status.json');
function system(args){return execFileSync('systemctl',args,{encoding:'utf8',timeout:65000,stdio:['ignore','pipe','pipe']});}
function service(name){const properties=Object.fromEntries(system(['show',name,'-p','ActiveState','-p','MainPID','-p','ActiveEnterTimestampMonotonic']).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));return {name,pid:Number(properties.MainPID)||0,activeState:properties.ActiveState,startedAt:Number(properties.ActiveEnterTimestampMonotonic)/1000||0};}
function maintenance(pid){
 const path=join(STATE_ROOT,'data/inventory.db');if(!existsSync(path))return 'Shed data is not ready';
 const db=new DatabaseSync(path,{readOnly:true});
 try{db.exec('PRAGMA busy_timeout=250');const busy=db.prepare("SELECT value FROM app_metadata WHERE key='firmware_busy'").get();const owner=db.prepare("SELECT value FROM app_metadata WHERE key='firmware_busy_owner'").get();if(busy&&owner){const value=JSON.parse(owner.value);if(value.id===busy.value&&value.pid===pid)return 'Controller firmware maintenance';}return null;}finally{db.close();}
}
export function readinessProbe(url,token,ca,{timeoutMs=5000}={}){return new Promise(resolve=>{
 let done=false,bytes=0,chunks=[];const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
 const request=(url.startsWith('https:')?httpsRequest:httpRequest)(url,{headers:{'x-lytguide-probe':token,Connection:'close'},...(ca?{ca}:{})},response=>{
  response.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096){request.destroy();finish(false);}else chunks.push(chunk);});response.on('end',()=>{try{const body=JSON.parse(Buffer.concat(chunks).toString());finish(response.statusCode===200&&body.ready===true&&body.service==='lytguide-runtime-v1');}catch{finish(false);}});response.on('error',()=>finish(false));
 });const timer=setTimeout(()=>{request.destroy();finish(false);},timeoutMs);request.on('error',()=>finish(false));request.end();
});}
export async function runWatchdog(){
 if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid()!==0)throw new Error('Run automatic recovery on the Raspberry Pi.');
 if(!existsSync(join(CONFIG_ROOT,'config.json')))return;
 if(existsSync(join(STATE_ROOT,'setup-pending'))||existsSync(RESTORE_MARKER))return;
 let fd;try{fd=acquireRecoveryLock();}catch{return;}
 try{
  const config=validateTestConfig(JSON.parse(readFileSync(join(CONFIG_ROOT,'config.json'),'utf8'))),app=service(APP_SERVICE);
  let blocked;try{blocked=maintenance(app.pid);}catch{blocked='Shed maintenance or data check requires attention';}
  const rows=[app];let web;if(config.address){web=service(WEB_SERVICE);rows.push(web);}
  if(!blocked&&app.activeState==='active')app.healthy=await readinessProbe(`http://127.0.0.1:${config.appPort}${READINESS_PATH}`,readinessToken(config.sessionSecret));
  if(web){
   if(blocked||!app.healthy)web.skip='Waiting for application readiness';
   else if(!Object.values(networkInterfaces()).flat().some(row=>row?.address===config.address))web.skip='Shed network address is not available';
   else if(!existsSync(join(STATE_ROOT,'caddy/pki/authorities/local/root.crt')))web.skip='Phone certificate needs attention';
   else if(web.activeState==='active')web.healthy=await readinessProbe(`https://${config.address}:${config.httpsPort}${READINESS_PATH}`,readinessToken(config.sessionSecret),readFileSync(join(STATE_ROOT,'caddy/pki/authorities/local/root.crt')));
  }
  const now=Number(readFileSync('/proc/uptime','utf8').split(' ')[0])*1000,bootId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();let previous;try{previous=JSON.parse(readFileSync(statusPath,'utf8'));}catch{}
  const {state,restart}=healthDecision(previous,{bootId,now,services:rows,blocked});
  for(const name of restart){
   if(existsSync(join(STATE_ROOT,'setup-pending'))||existsSync(RESTORE_MARKER)||maintenance(app.pid)){state.blocked='Maintenance started';break;}
   const latest=service(name),expected=rows.find(row=>row.name===name);if(latest.pid!==expected.pid||!['active','failed'].includes(latest.activeState))continue;
   const entry=state.services[name];entry.restarts.push(now);entry.failures=0;entry.lastRestartAt=new Date().toISOString();
   // Save the attempt before restarting so repeated failures remain bounded.
   atomicJson(statusPath,state,0o644);
   try{system(['restart',name]);entry.reason='Service restarted after repeated failed checks';console.log(name+': recovered after repeated readiness failures');}catch(error){entry.reason='Recovery failed; check service logs';console.error(name+': '+entry.reason);}
  }
  atomicJson(statusPath,state,0o644);
 }finally{closeSync(fd);rmSync(join(STATE_ROOT,'.setup-lock'));}
}
if(process.argv[1]?.endsWith('/watchdog.cjs')||process.argv[1]?.endsWith('/watchdog.mjs'))runWatchdog().catch(error=>{console.error(error.message);process.exitCode=1;});
