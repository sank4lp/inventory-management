import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createHardwareService} from '../src/services/hardware.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {startLedTest,ledTestTargets,renderLedTest,ledTestRoutes} from '../src/modules/hardware/led-test.js';
import {routeAllowed} from '../src/modules/access/routes-policy.js';
function fixture(t,adapter='rs485'){
 process.chdir(mkdtempSync(join(tmpdir(),'led-test-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true});
 db.exec("UPDATE controllers SET heartbeat_status='online',module_count=4");
 const writes=[],logger={info(){},warn(){},error(){},debug(){}};
 const hardwareService=createHardwareService({db,logger,config:{hardwareAdapter:adapter,rs485WriteLine:line=>writes.push(line.trim()),rs485WriteRepeats:1,rs485WriteRepeatDelayMs:0,rs485GuidanceBurstRepeats:1,rs485GuidanceBurstDelayMs:0,rs485InterCommandDelayMs:0}});
 const operationsService=createOperationsService({db,hardwareService,logger});
 let now=new Date();const displayCoordinator=createDisplayCoordinator({db,hardwareService,operationsService,clock:()=>now});
 t.after(()=>{hardwareService.dispose();db.close();});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const state={db,hardwareService,operationsService,displayCoordinator};
 const targets=()=>ledTestTargets(db);
 const form=(choices=targets().slice(0,2))=>({requestId:randomUUID(),mode:'text',text:'TEST 12',color:'#ff6600',brightness:'35',...Object.fromEntries(choices.map(t=>[t.key,'on']))});
 return {...state,state,admin,op,writes,targets,form,advance:()=>now=new Date(now.getTime()+121000)};
}
test('identical text, colour and test brightness reach every selected output across controllers; defaults remain maximum',t=>{
 const f=fixture(t),targets=f.targets(),chosen=[targets[0],targets.at(-1)],before=f.db.prepare('SELECT * FROM inventory_balances').all();
 const result=startLedTest(f.state,f.admin,f.form(chosen));
 assert.equal(result.targets.length,2);assert.ok(result.targets.every(t=>t.status==='sent'));
 assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.includes('"TEST 12" #ff6600 120 35')));
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);
 f.displayCoordinator.stop(f.admin,result.id);
 f.hardwareService.showCellQuantity(chosen[0].cell,8,'green');assert.match(f.writes.at(-1),/green 120 100$/);
});
test('unmapped LEDs work, zero brightness is honoured, and expiry clears only selected outputs',t=>{
 const f=fixture(t);f.db.exec('UPDATE cells SET controller_id=NULL,hardware_channel=NULL');
 const result=startLedTest(f.state,f.admin,{...f.form(),brightness:'0',mode:'integer',text:'-42'});
 assert.ok(result.targets.every(t=>t.cellId===null&&t.status==='sent'));
 assert.ok(f.writes.every(w=>w.includes('"-42" #ff6600 120 0')));
 f.advance();f.displayCoordinator.expire();assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(result.id).state,'stopped');
 assert.equal(new Set(f.writes.filter(w=>w.includes(' clear '))).size,2);
});
test('invalid input and unauthorized requests do not send commands or replace an existing display',t=>{
 const f=fixture(t),valid=f.form();startLedTest(f.state,f.admin,valid);const count=f.writes.length;
 for(const input of [{brightness:'101'},{brightness:'-1'},{brightness:'1.5'},{brightness:''},{text:'x'.repeat(56)},{text:'"bad"'},{text:'hi\nclear'},{mode:'integer',text:'2.5'},{color:'red clear'},{led_999_1:'on'}])assert.throws(()=>startLedTest(f.state,f.admin,{...f.form(),...input}));
 assert.throws(()=>startLedTest(f.state,f.admin,{mode:'text',text:'8',brightness:'50',color:'#00ff00'}),/Select/);
 assert.throws(()=>startLedTest(f.state,f.op,f.form()),/permitted/);
 assert.equal(f.writes.length,count);
 assert.equal(routeAllowed(f.op,'GET','/settings/led-test'),false);
 assert.equal(routeAllowed(f.admin,'POST','/settings/led-test/stop'),true);
});
test('retry does not replay; applying new settings stops the previous test and busy displays are skipped',t=>{
 const f=fixture(t),form=f.form();const first=startLedTest(f.state,f.admin,form),n=f.writes.length;
 assert.equal(startLedTest(f.state,f.admin,form).id,first.id);assert.equal(f.writes.length,n);
 const next=startLedTest(f.state,f.admin,{...form,requestId:randomUUID(),brightness:'70'});
 assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(first.id).state,'stopped');
 assert.ok(next.targets.every(t=>t.status==='sent'));
 f.displayCoordinator.stop(f.admin,next.id);
 const target=f.targets().find(t=>t.cell.id);
 f.displayCoordinator.start(f.admin,{kind:'locate',cellId:target.cell.id});
 const busy=startLedTest(f.state,f.admin,f.form([target]));assert.equal(busy.targets[0].status,'busy');
});
test('simulator records chosen brightness; page retains form errors and offers selections and stop',async t=>{
 const f=fixture(t,'simulator');const result=startLedTest(f.state,f.admin,f.form());
 const event=f.db.prepare("SELECT payload FROM device_events WHERE event_type='cell_quantity_displayed' ORDER BY id DESC LIMIT 1").get();assert.equal(JSON.parse(event.payload).brightnessPercent,35);
 const html=renderLedTest(f.state,f.admin);assert.match(html,/LED matrix test/);assert.match(html,/Stop test/);assert.match(html,/Select all LEDs/);
 const res={writeHead(code){this.code=code;},end(body){this.body=body;}};
 await ledTestRoutes({method:'POST',parsedForm:{...f.form(),brightness:'200'}},res,new URL('http://local/settings/led-test'),f.admin,f.state);
 assert.equal(res.code,422);assert.match(res.body,/Brightness must/);assert.match(res.body,/value="200"/);
 assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(result.id).state,'active');
});
test('Locate and Ping use existing patterns across selected mapped and unbound outputs, with stop and expiry',async t=>{
 const f=fixture(t,'simulator');f.db.exec('UPDATE cells SET controller_id=NULL,hardware_channel=NULL');
 const form={...f.form(),text:'',brightness:'',action:'locate'};
 const locate=startLedTest(f.state,f.admin,form);
 assert.ok(locate.targets.every(t=>t.status==='sent'));
 assert.equal(JSON.parse(f.db.prepare('SELECT scope_json FROM display_requests WHERE id=?').get(locate.id).scope_json).kind,'locate');
 assert.match(renderLedTest(f.state,f.admin),/>Locating<\/button>/);
 const locRow=f.db.prepare('SELECT * FROM display_requests WHERE id=?').get(locate.id);
 assert.equal(Date.parse(locRow.expires_at)-Date.parse(locRow.created_at),300000);
 const ping=startLedTest(f.state,f.admin,{...form,requestId:randomUUID(),action:'ping'});
 assert.ok(ping.targets.every(t=>t.status==='sent'));
 assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(locate.id).state,'stopped');
 const row=f.db.prepare('SELECT * FROM display_requests WHERE id=?').get(ping.id);
 assert.equal(Date.parse(row.expires_at)-Date.parse(row.created_at),5000);
 assert.match(renderLedTest(f.state,f.admin),/>Pinging<\/button>/);
 const res={writeHead(code){this.code=code;},end(){}};
 await ledTestRoutes({method:'POST',parsedForm:{displayId:ping.id}},res,new URL('http://local/settings/led-test/stop'),f.admin,f.state);
 assert.equal(res.code,302);
 assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(ping.id).state,'stopped');
 const again=startLedTest(f.state,f.admin,{...f.form(),action:'ping'});
 f.advance();f.displayCoordinator.expire();assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(again.id).state,'stopped');
});

test('solid colour fills every selected matrix at chosen brightness without requiring content',t=>{
 const f=fixture(t),chosen=[f.targets()[0],f.targets().at(-1)];
 const result=startLedTest(f.state,f.admin,{...f.form(chosen),mode:'solid',text:'',brightness:'60',color:'#123abc'});
 assert.ok(result.targets.every(t=>t.status==='sent'));
 assert.equal(f.writes.length,2);
 assert.ok(f.writes.every(line=>/ fill \d+ #123abc 60$/.test(line)));
 const html=renderLedTest(f.state,f.admin);
 assert.match(html,/>Showing on selected LEDs<\/button>/);
 assert.match(html,/value="show"[^>]*formaction="\/settings\/led-test\/stop"/);
 assert.match(html,/data-led-content hidden/);
 f.displayCoordinator.stop(f.admin,result.id);
 startLedTest(f.state,f.admin,{...f.form(chosen),mode:'solid',text:'',brightness:'0'});
 assert.ok(f.writes.at(-1).endsWith('fill 4 #ff6600 0'));
 assert.throws(()=>startLedTest(f.state,f.admin,{...f.form(),mode:'solid',brightness:'101'}),/Brightness/);
 assert.throws(()=>startLedTest(f.state,f.admin,{...f.form(),mode:'solid',color:'invalid'}),/colour/);
});

test('JSON LED actions update state without redirects and validation preserves the active display',async t=>{
 const f=fixture(t,'simulator');
 const request=async(path,form,method='POST')=>{
   const res={writeHead(code,headers){this.code=code;this.headers=headers;},end(body){this.body=JSON.parse(body);}};
   await ledTestRoutes({method,headers:{accept:'application/json'},parsedForm:form},res,new URL('http://local'+path),f.admin,f.state);
   assert.equal(res.headers.Location,undefined);assert.match(res.headers['Content-Type'],/application\/json/);return res;
 };
 const start=await request('/settings/led-test',{...f.form(),mode:'solid',text:'',brightness:'40'});
 assert.equal(start.code,200);assert.match(start.body.html,/>Showing on selected LEDs<\/button>/);
 const event=JSON.parse(f.db.prepare("SELECT payload FROM device_events WHERE event_type='cell_quantity_displayed' ORDER BY id DESC LIMIT 1").get().payload);
 assert.equal(event.solidColour,true);assert.equal(event.brightnessPercent,40);
 const bad=await request('/settings/led-test',{...f.form(),brightness:'200'});
 assert.equal(bad.code,422);assert.match(bad.body.error,/Brightness/);assert.match(bad.body.html,/>Showing on selected LEDs<\/button>/);
 const row=f.db.prepare('SELECT id FROM display_requests ORDER BY rowid DESC LIMIT 1').get();
 const stop=await request('/settings/led-test/stop',{displayId:row.id});
 assert.equal(stop.code,200);assert.doesNotMatch(stop.body.html,/>Showing on selected LEDs<\/button>/);
 await request('/settings/led-test',{...f.form(),action:'ping'});f.advance();
 const expired=await request('/settings/led-test',{},'GET');
 assert.doesNotMatch(expired.body.html,/>Pinging<\/button>/);
});
