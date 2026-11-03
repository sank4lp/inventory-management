import test from 'node:test';
import {SetupDriver} from '../scripts/setup/driver.mjs';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request,createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {createRecoveryProfile,sealRecovery,openRecovery,readSealedHeader} from '../scripts/release/sealed-backup.mjs';
import {createSetupServer} from '../scripts/setup/server.mjs';
import {initialSetupState,advance,setupSteps,publicSetupState,validPassword,currentControllerReplies,locationSetupProgress,locationCompletion,restartedSetupState,commissioningSelection} from '../scripts/setup/model.mjs';

test('returning from Locations clears its setup displays before allowing another controller to be added',async()=>{
 const state={...initialSetupState(),mode:'new',step:'locations',done:['choose','system','network','account','phones','hardware'],revision:8};
 const events=[],driver={state,async pauseLocations(){events.push('clear');},save(next){events.push('save');this.state=next;},async status(){return this.state;}};
 await SetupDriver.prototype.action.call(driver,'back',{step:'hardware',revision:8});assert.deepEqual(events,['clear','save']);assert.equal(driver.state.step,'hardware');
 driver.state=state;driver.pauseLocations=async()=>{throw new Error('Controller disconnected');};events.length=0;
 await assert.rejects(()=>SetupDriver.prototype.action.call(driver,'back',{step:'hardware',revision:8}),/Controller disconnected/);assert.equal(driver.state.step,'locations');assert.deepEqual(events,[]);
});
import {prepareRecoveryAccess} from '../scripts/setup/authorize.mjs';
import {wifiKeyfile,splitNmcli} from '../scripts/setup/network.mjs';
import {setupProxyAllowed} from '../scripts/setup/security.mjs';
import {setupBlocked} from '../src/modules/setup/gate.js';
import {setupServiceUnit,setupPolkitPolicy} from '../scripts/setup/integration.mjs';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';

const password='warehouse-recovery-secret-123';
let profile;
test('automatic recovery encryption uses only its public recipient; restoration needs the password and authenticates every payload byte',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lytguide-sealed-'));try{
    profile=createRecoveryProfile(password);const source=join(dir,'raw'),sealed=join(dir,'backup'),opened=join(dir,'opened');
    const bytes=Buffer.concat([Buffer.from('PRIVATE WAREHOUSE ROOT KEY\n'),randomBytes(100000)]);writeFileSync(source,bytes);
    await sealRecovery(source,sealed,profile);
    assert.equal(readFileSync(sealed).includes(Buffer.from('PRIVATE WAREHOUSE ROOT KEY')),false);assert.equal(JSON.stringify(profile).includes(password),false);
    await assert.rejects(()=>openRecovery(sealed,opened,'wrong-password'),/incorrect|damaged/);assert.equal(existsSync(opened),false);
    const recovered=await openRecovery(sealed,opened,password);assert.equal(recovered.keyId,profile.keyId);assert.deepEqual(readFileSync(opened),bytes);
    rmSync(opened);const damaged=readFileSync(sealed),offset=readSealedHeader(sealed).offset;damaged[offset+10]^=1;writeFileSync(sealed,damaged);
    await assert.rejects(()=>openRecovery(sealed,opened,password),/could not be unlocked/);assert.equal(existsSync(opened),false);
    await assert.rejects(()=>sealRecovery(source,sealed,profile),/already exists/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('legacy unprotected files remain detectable, without fabricating a protected identity',async()=>{const dir=mkdtempSync(join(tmpdir(),'lytguide-legacy-'));try{const source=join(dir,'raw');writeFileSync(source,'legacy tar bytes');assert.equal(readSealedHeader(source),null);assert.equal(await openRecovery(source,join(dir,'out'),''),null);}finally{rmSync(dir,{recursive:true,force:true});}});
test('new and replacement setup have distinct ordered steps and no secret file paths in public state',()=>{
  assert.ok(setupSteps('new').some(([key])=>key==='account'));assert.ok(!setupSteps('replace').some(([key])=>key==='account'));
  assert.ok(!setupSteps('replace').some(([key])=>key==='locations'));assert.ok(setupSteps('new').findIndex(([key])=>key==='phones')<setupSteps('new').findIndex(([key])=>key==='locations'));
  const state={...initialSetupState(),mode:'new',step:'system'};assert.equal(advance(state,'system').step,'network');assert.throws(()=>advance(state,'account'),/changed/);
  const publicState=publicSetupState({...state,uploadedBackup:{id:'id',name:'backup',bytes:123,path:'/private/key'}});assert.equal(JSON.stringify(publicState).includes('/private'),false);
  assert.throws(()=>validPassword('short'),/12/);
});
test('replacement reset choices keep hardware independent from data level and require locations when mappings are cleared',()=>{
  for(const resetMode of ['clear-work','fresh'])for(const keepHardware of [true,false]){
    const state={mode:'replace',step:'hardware',done:[],resetMode,keepHardware};
    assert.equal(setupSteps('replace',state).some(([key])=>key==='locations'),!keepHardware);
    assert.equal(advance(state,'hardware').step,keepHardware?'finish':'locations');
  }
});
test('Wi-Fi secrets stay in a protected keyfile, and malformed interfaces/passwords cannot inject settings',()=>{
  const file=wifiKeyfile({ssid:'Warehouse: floor 1',password:'no-shell-$()password',device:'wlan0',uuid:'abc'});
  assert.match(file,/ssid=Warehouse:.*floor/);assert.match(file,/psk=no-shell/);assert.match(file,/method=auto/);
  assert.deepEqual(splitNmcli('Warehouse\\: floor:90:WPA2'),['Warehouse: floor','90','WPA2']);
  assert.throws(()=>wifiKeyfile({ssid:'x',password:'pass\n[ipv4]',device:'wlan0'}));
  assert.throws(()=>wifiKeyfile({ssid:'x',password:'correct-password',device:'wlan0\naddress=evil'}));
});
test('commissioning access cannot perform stock operations or restore arbitrary pages',()=>{
  assert.equal(setupProxyAllowed('POST','/api/work/create'),false);assert.equal(setupProxyAllowed('POST','/backups/restore'),false);
  assert.equal(setupProxyAllowed('GET','/client/../../secret.js'),false);assert.equal(setupProxyAllowed('GET','/theme.css'),true);
  assert.equal(setupProxyAllowed('POST','/api/location-setup/bind'),true);assert.equal(setupProxyAllowed('POST','/api/firmware/flash'),true);
  assert.equal(setupBlocked('POST','/api/work/report',{pending:true}),true);assert.equal(setupBlocked('POST','/api/location-setup/bind',{pending:true}),false);assert.equal(setupBlocked('GET','/login',{pending:true}),false);assert.equal(setupBlocked('POST','/api/work/report',{pending:false}),false);
});
test('a blank new warehouse contains its administrator but no sample controllers, cells, products, stock or operator',()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-blank-')),cwd=process.cwd();let db;
  try{process.chdir(root);db=createDatabase({hashPassword,bootstrapAdmin:{name:'Owner',username:'owner',password},allowDevAuthSeeds:false,allowDemoInventorySeed:false,allowWarehouseSeeds:false,allowCatalogSeeds:false});for(const table of ['controllers','cells','products','inventory_balances','tasks'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,1);db.close();db=null;db=createDatabase({hashPassword,allowDevAuthSeeds:false,allowDemoInventorySeed:false,allowWarehouseSeeds:false,allowCatalogSeeds:false});assert.equal(db.prepare('SELECT COUNT(*) n FROM cells').get().n,0);}finally{db?.close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
});
test('desktop authorisation is restricted to the local administrator action and root setup has no LAN listener',()=>{
  const unit=setupServiceUnit(),policy=setupPolkitPolicy();assert.match(policy,/<allow_any>no/);assert.match(policy,/<allow_inactive>no/);assert.match(policy,/auth_admin_keep/);assert.match(policy,/\/usr\/lib\/lytguide-test\/setup-authorize/);assert.match(unit,/ProtectSystem=strict/);assert.match(unit,/RuntimeDirectoryMode=0700/);
});
test('first setup prepares its recovery folder before the protected service, keeps prior backups and reports unavailable storage',()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-first-boot-')),directory=join(root,'LYTGUIDE-RECOVERY');
  try{
    assert.equal(existsSync(directory),false);
    assert.deepEqual(prepareRecoveryAccess(()=>directory),{directory,created:true});
    writeFileSync(join(directory,'prior-backup'),'keep');
    assert.deepEqual(prepareRecoveryAccess(()=>directory),{directory,created:false});
    assert.equal(readFileSync(join(directory,'prior-backup'),'utf8'),'keep');
    assert.deepEqual(prepareRecoveryAccess(()=>{throw new Error('Boot volume missing');}),{created:false,error:'Boot volume missing'});
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('hardware readiness requires fresh valid replies from every controller, rather than an old online label',()=>{
  const now=Date.now(),row={heartbeat_status:'online',last_seen_at:new Date(now).toISOString()};
  assert.equal(currentControllerReplies([row],now,now),true);
  for(const bad of [null,'not-a-date',new Date(now-60000).toISOString(),new Date(now+60000).toISOString()])assert.equal(currentControllerReplies([{...row,last_seen_at:bad}],now,now),false);
  assert.equal(currentControllerReplies([row,{...row,heartbeat_status:'offline'}],now,now),false);
  assert.equal(currentControllerReplies([],now,now),false);
});
test('setup HTTP requires one-use authorisation, strict Host/Origin and serialised jobs without leaking passwords',async()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-http-')),token=randomBytes(32).toString('hex'),digest=createHash('sha256').update(token).digest('hex');let redeemed=false,state=initialSetupState();
  const driver={async status(){return {state:publicSetupState(state)};},async refresh(){return this.status();},async action(action,input){await new Promise(r=>setTimeout(r,50));if(action==='fail')throw new Error('Check the recovery password.');state={...state,step:'system',revision:state.revision+1};},async upload(){throw new Error('Not at backup step.');},appPort(){return 9;},appCookie(){return 'never-used';}};
  const server=createSetupServer({driver,redeem(hash){if(hash!==digest||redeemed)return null;redeemed=true;return {uid:1000,expiresAt:Date.now()+120000};},assets:new URL('../scripts/setup/ui',import.meta.url).pathname,uploadDirectory:root,port:0});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const call=(path,options={})=>fetch(base+path,{...options,headers:{Connection:'close',...options.headers}});
  try{
    assert.equal((await call('/setup-api/status')).status,401);
    assert.equal((await call('/setup-api/unlock',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:JSON.stringify({token})})).status,403);
    const unlock=await call('/setup-api/unlock',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token})});assert.equal(unlock.status,200);const cookie=unlock.headers.get('set-cookie').split(';')[0];assert.match(unlock.headers.get('set-cookie'),/HttpOnly.*SameSite=Strict/);
    assert.equal((await call('/setup-api/unlock',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({token})})).status,400);
    assert.equal(await new Promise((resolve,reject)=>{const req=request(base+'/setup-api/status',{headers:{Cookie:cookie,Host:'evil.example',Connection:'close'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();}),403);
    assert.equal((await call('/backups/restore',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{}'})).status,404);
    const first=await call('/setup-api/action',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({action:'choose',recoveryPassword:password})});assert.equal(first.status,202);
    assert.equal((await call('/setup-api/action',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{"action":"choose"}'})).status,409);
    let status;for(let i=0;i<20;i++){status=await (await call('/setup-api/status',{headers:{Cookie:cookie}})).json();assert.equal(JSON.stringify(status).includes(password),false);if(!status.job.running)break;await new Promise(r=>setTimeout(r,15));}assert.equal(status.state.step,'system');
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
});

test('controller proxy preserves native form origins and still rejects missing, null and foreign origins',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'lytguide-controller-origin-')),token=randomBytes(32).toString('hex');let forwarded=0;
 const upstream=createServer(async(req,res)=>{
  if(req.method==='POST'){
   assert.equal(req.headers.cookie,'synthetic-warehouse-cookie');assert.equal(req.headers.origin,'http://127.0.0.1:'+upstream.address().port);
   for await(const chunk of req){}forwarded++;res.writeHead(302,{Location:'/devices?checked=1','Referrer-Policy':'no-referrer'});res.end();return;
  }
  res.writeHead(200,{'Content-Type':'text/html','Referrer-Policy':'no-referrer'});res.end('<!doctype html><head></head><form method="post" action="/devices/controller-test"><button>Check</button></form>');
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const driver={appPort:()=>upstream.address().port,appCookie:()=> 'synthetic-warehouse-cookie'};
 const server=createSetupServer({driver,redeem:()=>({uid:1000,expiresAt:Date.now()+120000}),assets:new URL('../scripts/setup/ui',import.meta.url).pathname,uploadDirectory:folder,port:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  const unlocked=await fetch(base+'/setup-api/unlock',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({token})});assert.equal(unlocked.status,200);const cookie=unlocked.headers.get('set-cookie').split(';')[0];
  const root=await fetch(base+'/',{headers:{Connection:'close'}});assert.equal(root.headers.get('referrer-policy'),'same-origin');await root.text();
  const page=await fetch(base+'/devices',{headers:{Cookie:cookie,Connection:'close'}});assert.equal(page.status,200);assert.equal(page.headers.get('referrer-policy'),'same-origin');assert.match(await page.text(),/form method="post"/);
  for(const origin of [undefined,'null','https://untrusted.example','http://localhost:'+server.address().port]){
   const result=await fetch(base+'/devices/controller-test',{method:'POST',redirect:'manual',headers:{Cookie:cookie,...(origin===undefined?{}:{Origin:origin}),'Content-Type':'application/x-www-form-urlencoded',Connection:'close'},body:'controller_id=1'});
   assert.equal(result.status,403,origin);assert.match(await result.text(),/Open this action/);
  }
  assert.equal(forwarded,0);
  const valid=await fetch(base+'/devices/controller-test',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded',Connection:'close'},body:'controller_id=1'});
  assert.equal(valid.status,302);assert.equal(valid.headers.get('location'),'/devices?checked=1');assert.equal(valid.headers.get('referrer-policy'),'same-origin');assert.equal(forwarded,1);await valid.text();
 }finally{for(const s of [server,upstream]){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}rmSync(folder,{recursive:true,force:true});}
});

test('fresh Setup launch cannot interrupt an in-flight step or invalidate its window until the job finishes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-relaunch-')),grants=new Map();let restarts=0,releaseJob,state=initialSetupState();
  const driver={restart(){restarts++;state={...initialSetupState(),revision:state.revision+1};},async status(){return {state};},async refresh(){return this.status();},async action(){await new Promise(resolve=>{releaseJob=resolve;});state={...state,step:'system',revision:state.revision+1};}};
  const server=createSetupServer({driver,redeem:hash=>grants.get(hash),assets:new URL('../scripts/setup/ui',import.meta.url).pathname,uploadDirectory:root,port:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const call=(path,value,cookie)=>fetch(base+path,{method:value?'POST':'GET',headers:{Connection:'close',Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(value?{body:JSON.stringify(value)}:{})});
  function token(restart=false){const token=randomBytes(32).toString('hex');grants.set(createHash('sha256').update(token).digest('hex'),{uid:1000,expiresAt:Date.now()+120000,restart});return token;}
  try{
    const first=await call('/setup-api/unlock',{token:token()}),cookie=first.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/setup-api/action',{action:'system',revision:1},cookie)).status,202);
    const blocked=await call('/setup-api/unlock',{token:token(true)});assert.equal(blocked.status,409);assert.equal(restarts,0);assert.equal((await call('/setup-api/status',null,cookie)).status,200);
    releaseJob();await new Promise(resolve=>setTimeout(resolve,10));
    const next=await call('/setup-api/unlock',{token:token(true)});assert.equal(next.status,200);assert.equal(restarts,1);assert.equal(state.step,'choose');assert.equal((await call('/setup-api/status',null,cookie)).status,401);
  }finally{releaseJob?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
});

test('location setup can finish with deferred QR labels, explicitly defer unfinished lights, and retain a resume checkpoint',()=>{
 const controllers=[{id:1,module_count:2}],cells=[1,2].map(hardware_channel=>({id:hardware_channel,controller_id:1,hardware_channel,binding_verified_at:'2026-10-31T10:00:00Z',qr_verified:0}));
 const counts={controllers,cells,...locationSetupProgress(controllers,cells)};
 assert.equal(counts.mapped,2);assert.equal(counts.qrPending,2);assert.equal(counts.outputsRemaining,0);assert.equal(locationCompletion(counts).locationsDeferred,false);
 const partial={controllers,cells:cells.slice(0,1),...locationSetupProgress(controllers,cells.slice(0,1))};assert.throws(()=>locationCompletion(partial),/remaining locations/);
 assert.equal(locationCompletion(partial,{deferLocations:true}).locationsDeferred,true);
 const empty={controllers,cells:[],...locationSetupProgress(controllers,[])};assert.equal(locationCompletion(empty,{deferLocations:true}).locationCount,0);assert.throws(()=>locationCompletion(empty),/remaining/);assert.throws(()=>locationCompletion(empty,{deferLocations:'true'}),/Choose/);
 const checkpoint=restartedSetupState({...initialSetupState(),step:'locations',done:['choose','system','network','account','phones','hardware']});assert.equal(checkpoint.step,'choose');assert.equal(checkpoint.locationSetupReady,true);assert.equal(restartedSetupState(checkpoint).locationSetupReady,true);
 assert.equal(restartedSetupState({...initialSetupState(),step:'phones',done:['account']}).locationSetupReady,undefined);
});
test('location progress counts hardware and QR separately and excludes missing or invalid output mappings',()=>{
 const controllers=[{id:1,module_count:2}];const cells=[{controller_id:1,hardware_channel:1,binding_verified_at:'saved',qr_verified:0},{controller_id:1,hardware_channel:3,binding_verified_at:'saved',qr_verified:1},{controller_id:2,hardware_channel:1,binding_verified_at:'saved',qr_verified:0},{controller_id:1,hardware_channel:2,binding_verified_at:null,qr_verified:0}];
 assert.deepEqual(locationSetupProgress(controllers,cells),{mapped:1,qrAssigned:1,qrPending:3,outputsRemaining:1});
});


test('commissioning one, several or all controllers requires an explicit deferred choice and rejects stale selections',()=>{
 const controllers=[1,2,3].map(id=>({id,controller_code:'CTRL'+id}));
 assert.deepEqual(commissioningSelection(controllers),controllers);
 for(const ids of [[1],[1,3]]){
  assert.throws(()=>commissioningSelection(controllers,ids),/Confirm.*later/);
  assert.deepEqual(commissioningSelection(controllers,ids,true).map(row=>row.id),ids);
 }
 assert.deepEqual(commissioningSelection(controllers,[1,2,3]),controllers);
 for(const ids of [[],[1,1],[99],['1'],'all'])assert.throws(()=>commissioningSelection(controllers,ids,true));
});
