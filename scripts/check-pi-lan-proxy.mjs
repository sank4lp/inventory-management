// Opt-in integration check. Requires an official Caddy binary, runs only on
// loopback with a disposable database/CA, and never installs browser/OS trust.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import https from 'node:https';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {renderLanConfig} from './lib/pi-lan.js';
import {adaptLanConfig} from './lib/pi-lan-caddy.js';

const caddy=process.env.CADDY_BIN;
if(!caddy)throw new Error('Set CADDY_BIN to an official Caddy executable for this opt-in check.');
const project=fileURLToPath(new URL('..',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'lightguide-lan-proxy-'));
const storage=join(dir,'certificates'),configPath=join(dir,'test.Caddyfile');
const processes=new Set();
async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;}
function launch(bin,args,env){const p=spawn(bin,args,{cwd:dir,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});p.logs='';processes.add(p);for(const stream of [p.stdout,p.stderr])stream.on('data',data=>{p.logs=(p.logs+data).slice(-8000);});return p;}
async function stop(p){if(p.exitCode!==null||p.signalCode!==null)return;const done=once(p,'exit');p.kill('SIGTERM');const timer=setTimeout(()=>p.kill('SIGKILL'),12000);try{await done;}finally{clearTimeout(timer);processes.delete(p);}}
async function until(fn){let error;for(let n=0;n<80;n++){try{return await fn();}catch(e){error=e;await delay(100);}}throw error;}
function request(port,path,{ca,method='GET',body,headers={}}={}){return new Promise((resolve,reject)=>{const r=https.request({host:'127.0.0.1',port,path,method,ca,rejectUnauthorized:true,headers,timeout:4000},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:text}));});r.on('error',reject);r.on('timeout',()=>r.destroy(new Error('HTTPS request timed out')));r.end(body);});}

try{
  const appPort=await freePort(),port=await freePort();
  // Validate the actual Pi configuration through the same file-based preflight
  // setup. Only the runtime fixture's listener/subnet is replaced with loopback.
  const piConfig=renderLanConfig({address:'192.168.1.140',cidr:'192.168.1.0/24',port,appPort,storage});
  const adapted=JSON.parse(adaptLanConfig(piConfig,{caddy,tempRoot:dir}));
  assert.deepEqual(Object.values(adapted.apps.http.servers).flatMap(s=>s.listen),[`192.168.1.140:${port}`]);
  assert.equal(adapted.admin.disabled,true);
  writeFileSync(configPath,piConfig.replaceAll('192.168.1.140','127.0.0.1').replaceAll('192.168.1.0/24','127.0.0.1/32'));
  mkdirSync(storage);symlinkSync(join(project,'public'),join(dir,'public'),'dir');
  const app=launch(process.execPath,[join(project,'src/server.js')],{PORT:String(appPort),NODE_ENV:'production',NO_SERVER_LISTEN:'0',HARDWARE_ADAPTER:'simulator',DEMO_INVENTORY_SEED:'0',SESSION_SECRET:randomBytes(32).toString('hex'),BOOTSTRAP_ADMIN_USERNAME:'admin',BOOTSTRAP_ADMIN_NAME:'LAN fixture',BOOTSTRAP_ADMIN_PASSWORD:'temporary-fixture-password'});
  let proxy=launch(caddy,['run','--config',configPath,'--adapter','caddyfile'],{XDG_DATA_HOME:dir,XDG_CONFIG_HOME:dir});
  const rootPath=join(storage,'pki/authorities/local/root.crt');
  const root=await until(()=>{assert.ok(existsSync(rootPath));return readFileSync(rootPath);});
  const certificate=execFileSync('openssl',['x509','-in',rootPath,'-outform','DER']);
  assert.equal(execFileSync('openssl',['x509','-inform','DER','-outform','PEM'],{input:certificate,encoding:'utf8'}).trim(),root.toString().trim());
  assert.equal((await until(async()=>{if(app.exitCode!==null)throw new Error(`App fixture exited: ${app.logs}`);const r=await request(port,'/login',{ca:root});assert.equal(r.status,200);return r;})).status,200);
  await assert.rejects(request(port,'/login'),/certificate|issuer|unable|self.signed/i);
  assert.equal((await request(port,'/work',{ca:root})).status,302);
  const body=new URLSearchParams({username:'admin',password:'temporary-fixture-password'}).toString();
  const headers={'Content-Type':'application/x-www-form-urlencoded','Origin':`https://127.0.0.1:${port}`};
  const login=await request(port,'/login',{ca:root,method:'POST',body,headers});
  assert.ok([302,303].includes(login.status));
  const cookie=login.headers['set-cookie'][0];
  assert.match(cookie,/; Secure/);
  assert.match(cookie,/HttpOnly/);
  const work=await request(port,'/work',{ca:root,headers:{Cookie:cookie}});
  assert.equal(work.status,200);assert.match(work.body,/My Work/);
  const invalid=await request(port,'/login',{ca:root,method:'POST',body,headers:{...headers,Origin:'https://different-origin.invalid'}});
  assert.equal(invalid.status,400);
  const sw=readFileSync(join(project,'public/sw.js'),'utf8');
  const assets=JSON.parse(sw.match(/const ASSETS=(\[[^\]]+\])/)[1].replaceAll("'",'"'));
  for(const path of [...assets,'/app.js','/manifest.webmanifest']){
    const asset=await request(port,path,{ca:root,headers:{Cookie:cookie}});
    assert.equal(asset.status,200,`Local resource ${path}`);
  }
  await stop(proxy);
  const workingConfig=readFileSync(configPath,'utf8');
  writeFileSync(configPath,workingConfig.replace('remote_ip 127.0.0.1/32 127.0.0.1','remote_ip 10.0.0.0/24'));
  proxy=launch(caddy,['run','--config',configPath,'--adapter','caddyfile'],{XDG_DATA_HOME:dir,XDG_CONFIG_HOME:dir});
  assert.equal((await until(async()=>{const r=await request(port,'/login',{ca:root,headers:{'X-Forwarded-For':'10.0.0.5'}});assert.equal(r.status,403);return r;})).status,403);
  await stop(proxy);writeFileSync(configPath,workingConfig);
  proxy=launch(caddy,['run','--config',configPath,'--adapter','caddyfile'],{XDG_DATA_HOME:dir,XDG_CONFIG_HOME:dir});
  assert.equal((await until(async()=>{const r=await request(port,'/work',{ca:root,headers:{Cookie:cookie}});assert.equal(r.status,200);return r;})).status,200);
  assert.deepEqual(readFileSync(rootPath),root);
  await stop(proxy);await stop(app);
  console.log(`PASS: Pi Caddyfile adaptation, certificate validation/export, unknown-root rejection, HTTPS login, Secure/HttpOnly session, protected page, origin guard, ${assets.length+2} local resources, subnet enforcement despite a spoofed forwarding header and restart with preserved certificate identity.\nDisposable database and loopback only; no Pi/phone/hardware acceptance claimed.`);
}catch(error){for(const p of processes)console.error(p.logs);throw error;}
finally{for(const p of processes)await stop(p);rmSync(dir,{recursive:true,force:true});}
