import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {healthDecision,WATCHDOG_POLICY,desktopAutostart,watchdogUnits,waitForDesktopApp} from '../scripts/release/always-on.mjs';
import {APP_SERVICE,WEB_SERVICE,serviceUnit} from '../scripts/release/pi-package.mjs';
import {runtimeReadiness,readinessToken,READINESS_PATH} from '../src/modules/runtime/readiness.js';
import {readinessProbe} from '../scripts/release/watchdog.mjs';
const app=(changes={})=>({name:APP_SERVICE,pid:100,activeState:'active',startedAt:0,healthy:false,...changes});
const tick=(state,now,services=[app()],blocked=null)=>healthDecision(state,{bootId:'boot-one',now,services,blocked});
test('recovery requires repeated failures, respects startup grace, healthy responses, stopped services and maintenance',()=>{
 let s=tick(null,1000);assert.deepEqual(s.restart,[]);assert.equal(s.state.services[APP_SERVICE].failures,0);
 s=tick(null,100000);assert.deepEqual(s.restart,[]);s=tick(s.state,130000);assert.deepEqual(s.restart,[]);s=tick(s.state,160000);assert.deepEqual(s.restart,[APP_SERVICE]);
 for(const [row,blocked] of [[app({healthy:true}),null],[app({activeState:'inactive'}),null],[app(),'Controller firmware maintenance'],[app({activeState:'activating'}),null]]){const r=tick(s.state,190000,[row],blocked);assert.deepEqual(r.restart,[]);assert.equal(r.state.services[APP_SERVICE].failures,0);}
});
test('recovery does not cascade to HTTPS when the app is unavailable, and rate limits attempts across process changes',()=>{
 let s={bootId:'boot-one',services:{[APP_SERVICE]:{pid:100,failures:3,restarts:[950000]}}};let r=tick(s,1000000);assert.deepEqual(r.restart,[]);assert.match(r.state.services[APP_SERVICE].reason,/cooldown/);
 s.services[APP_SERVICE].restarts=[200000,400000,700000];r=tick(s,1000000);assert.deepEqual(r.restart,[]);assert.match(r.state.services[APP_SERVICE].reason,/rate limit/);
 r=tick(s,1800000);assert.deepEqual(r.restart,[APP_SERVICE]);
 r=tick(s,1000000,[app({pid:101})]);assert.deepEqual(r.restart,[]);assert.equal(r.state.services[APP_SERVICE].failures,1);
 r=tick(s,1000000,[app(),{...app(),name:WEB_SERVICE,skip:'Waiting for application readiness'}]);assert.equal(r.state.services[WEB_SERVICE].failures,0);
});
test('recovery counters reset on a new boot instead of inheriting stale clocks and failures',()=>{
 const r=healthDecision({bootId:'old-boot',services:{[APP_SERVICE]:{pid:100,failures:50,restarts:[99999999]}}},{bootId:'new-boot',now:100000,services:[app()]});assert.deepEqual(r.restart,[]);assert.deepEqual(r.state.services[APP_SERVICE].restarts,[]);
});
test('desktop automatic opening waits for readiness, respects setup and uses the same app URL',async()=>{
 let time=0,attempts=0,opens=[];const options={readUrl:()=> 'http://localhost:3310/work',isPending:()=>false,probe:async()=>{if(++attempts<3)throw Error('Starting');},launch:async u=>opens.push(u),now:()=>time,sleep:async ms=>{time+=ms;}};
 assert.deepEqual(await waitForDesktopApp(options),{opened:true});assert.equal(attempts,3);assert.deepEqual(opens,['http://localhost:3310/work']);
 opens=[];assert.equal((await waitForDesktopApp({...options,isPending:()=>true})).opened,false);assert.deepEqual(opens,[]);
 assert.equal((await waitForDesktopApp({...options,readUrl:()=>null})).opened,false);
 await assert.rejects(()=>waitForDesktopApp({...options,readUrl:()=> 'http://external.example/work'}),/Invalid/);
 assert.equal((await waitForDesktopApp({...options,probe:async()=>{throw Error();},timeoutMs:1000})).opened,false);
});
test('runtime health probes validate a real response, database readiness and the private probe token',async()=>{
 const secret='a'.repeat(64);let ready=true,queries=0;
 const server=createServer((req,res)=>{runtimeReadiness(req,res,new URL(req.url,'http://localhost'),{enabled:true,secret,getDb:()=>({prepare(sql){queries++;assert.match(sql,/dataset_generation/);return {get(){if(!ready)throw Error('Database unavailable');return {value:'dataset'};}};}})});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+READINESS_PATH)).status,404);assert.equal(queries,0);assert.equal(await readinessProbe(base+READINESS_PATH,readinessToken(secret)),true);ready=false;assert.equal(await readinessProbe(base+READINESS_PATH,readinessToken(secret)),false);assert.equal(await readinessProbe(base+READINESS_PATH,'invalid'),false);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('runtime probe rejects a hung or unrelated HTTP service',async()=>{
 let hanging=true;const server=createServer((req,res)=>{if(!hanging){res.writeHead(200);res.end('A different server');}});server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
 try{assert.equal(await readinessProbe(url,'token',null,{timeoutMs:30}),false);hanging=false;assert.equal(await readinessProbe(url,'token'),false);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('boot definitions install desktop auto-opening and a bounded root recovery timer',()=>{
 assert.match(desktopAutostart(),/Exec=\/usr\/bin\/lytguide-test autostart/);assert.doesNotMatch(desktopAutostart(),/sudo|pkexec/);
 const units=watchdogUnits();assert.match(units.timer,/OnBootSec=90sec/);assert.match(units.timer,/OnUnitInactiveSec=30sec/);assert.match(units.service,/TimeoutStartSec=100/);assert.match(units.service,/ProtectSystem=strict/);
 assert.match(serviceUnit(),/Restart=always/);assert.match(serviceUnit(true),/Restart=always/);
});
