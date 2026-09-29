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
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'lyt-prearrival-')));const db=createDatabase({hashPassword,allowDemoInventorySeed:true});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),product=db.prepare('SELECT * FROM products LIMIT 1').get();
 const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 3').all(),ctrl=db.prepare('SELECT * FROM controllers LIMIT 1').get();
 db.exec('DELETE FROM inventory_balances; UPDATE cells SET controller_id=NULL,hardware_channel=NULL');db.prepare("UPDATE controllers SET address='GUIDE',heartbeat_status='online',module_count=20 WHERE id=?").run(ctrl.id);cells.forEach((c,i)=>db.prepare('UPDATE cells SET controller_id=?,hardware_channel=? WHERE id=?').run(ctrl.id,i+1,c.id));
 db.prepare('UPDATE products SET items_per_cell=3 WHERE id=?').run(product.id);
 const writes=[],logger={info(){},warn(){},error(){},debug(){}},hardware=createHardwareService({db,logger,config:{hardwareAdapter:'rs485',rs485WriteLine:line=>writes.push(line.trim()),rs485GuidanceBurstRepeats:1,rs485GuidanceBurstDelayMs:0,rs485InterCommandDelayMs:0}}),work=createOperationsService({db,hardwareService:hardware,logger});
 const command=(actor,action,input={})=>work.command(actor,action,{requestId:randomUUID(),...input});
 const stock=(cell,q)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0) ON CONFLICT(product_id,cell_id) DO UPDATE SET available_quantity=excluded.available_quantity').run(product.id,cell.id,q);
 const create=(actor,direction='pick',quantity=1,extra={})=>command(actor,'create',{direction,quantity,productId:product.id,...extra});
 const arrive=(actor,l)=>command(actor,'acquire',{lineId:l.id,revision:l.revision,method:'arrival',deviceId:'device-'+actor.id});
 const end=()=>{hardware.dispose();db.close();};return {db,admin,op,product,cells,ctrl,writes,hardware,work,command,stock,create,arrive,end,logger};
}
test('real RS485 digits guide every planned cell before arrival for self and accepted Pick/Put; offers alone stay dark',()=>{
 for(const direction of ['pick','put'])for(const assigned of [false,true]){
  const f=fixture();if(direction==='pick'){f.stock(f.cells[0],3);f.stock(f.cells[1],2);}const before=f.db.prepare('SELECT * FROM inventory_balances').all();
  const result=f.create(assigned?f.admin:f.op,direction,5,assigned?{assigneeId:f.op.id}:{});let task=f.work.task(f.op,result.taskId);
  if(assigned){assert.equal(f.writes.filter(x=>x.includes('digit ')).length,0);f.command(f.op,'start',{taskId:task.id,generation:task.assignment_generation});task=f.work.task(f.op,task.id);}
  const color=direction==='pick'?'green':'red';for(const [channel,qty] of [[1,3],[2,2]])assert.ok(f.writes.some(s=>s.includes(`digit ${channel} "${qty}" ${color} 120`)),JSON.stringify(f.writes));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cell_turns').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_reports').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_events WHERE event_type='location_ready'").get().n,0);
  for(const l of task.lines){assert.equal(l.execution_state,'ready');assert.equal(l.started_at,null);assert.equal(l.device_id,null);assert.equal(l.guidance.state,'sent');}
  assert.deepEqual(f.db.prepare('SELECT cell_id,available_quantity FROM inventory_balances').all().map(r=>({...r})),before.map(({cell_id,available_quantity})=>({cell_id,available_quantity})));f.end();
 }
});
test('display-only contention queues, arrival may preempt it, settlement promotes waiting guidance, old cleanup cannot erase the next owner',()=>{
 const f=fixture();f.stock(f.cells[0],10);const a=f.work.task(f.op,f.create(f.op,'pick',2).taskId).lines[0],b=f.work.task(f.admin,f.create(f.admin,'pick',3).taskId).lines[0];assert.equal(f.work.task(f.admin,b.task_id).lines[0].guidance.state,'waiting');
 assert.equal(f.arrive(f.admin,b).status,'ready');assert.ok(f.writes.at(-1).includes('digit 1 "3" green'));assert.equal(f.arrive(f.op,a).status,'busy');
 const current=f.work.line(b.id);f.command(f.admin,'report',{lineId:b.id,revision:current.revision,quantity:1,cellId:b.cell_id,unit:b.unit_of_measure,deviceId:'device-'+f.admin.id});assert.ok(f.writes.at(-1).includes('digit 1 "2" green'));
 const generation=f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(a.cell_id).generation;const count=f.writes.length;f.command(f.admin,'stop',{taskId:b.task_id,generation:f.work.task(f.admin,b.task_id).assignment_generation});assert.equal(f.writes.length,count);assert.equal(f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(a.cell_id).generation,generation);
 f.command(f.op,'cancel',{lineId:a.id,revision:a.revision});assert.ok(f.writes.at(-1).includes('clear 1'));f.end();
});
test('uncertain exclusive turns suppress ready numbers; sibling cells and shared locator remain usable',()=>{
 const f=fixture();f.stock(f.cells[0],3);f.stock(f.cells[1],3);const t=f.work.task(f.op,f.create(f.op,'pick',5).taskId),a=t.lines[0],b=t.lines[1];f.arrive(f.op,a);f.command(f.op,'askReview',{lineId:a.id,reason:'Uncertain movement'});assert.equal(JSON.parse(f.db.prepare('SELECT desired FROM work_guidance WHERE cell_id=?').get(a.cell_id).desired).action,'clear');assert.equal(f.arrive(f.op,b).status,'ready');assert.equal(f.work.task(f.op,t.id).lines.find(l=>l.id===b.id).guidance.state,'sent');assert.ok(f.writes.some(s=>s.includes('digit 2 "2" green')));f.end();
 const g=fixture();g.stock(g.cells[0],10);g.command(g.admin,'mode',{cellId:g.cells[0].id,mode:'shared'});const x=g.work.task(g.op,g.create(g.op,'pick',2).taskId).lines[0],y=g.work.task(g.admin,g.create(g.admin,'pick',1).taskId).lines[0];assert.ok(g.writes.some(s=>s.includes('text 1 "LOC" yellow')));assert.equal(g.writes.some(s=>s.includes('digit ')),false);g.arrive(g.op,x);g.arrive(g.admin,y);g.command(g.op,'askReview',{lineId:x.id,reason:'Check actual'});assert.equal(g.work.task(g.admin,y.task_id).lines[0].guidance.state,'shared');assert.equal(g.db.prepare('SELECT COUNT(*) n FROM cell_turns').get().n,0);g.end();
});
test('return and replan clear obsolete guidance, while untouched pre-arrival tasks do not become inactivity evidence',()=>{
 const f=fixture();let t=f.work.task(f.op,f.create(f.admin,'put',2,{assigneeId:f.op.id}).taskId);f.command(f.op,'start',{taskId:t.id,generation:t.assignment_generation});t=f.work.task(f.op,t.id);f.command(f.op,'decline',{taskId:t.id,generation:t.assignment_generation});assert.ok(f.writes.at(-1).includes('clear 1'));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_reports').get().n,0);
 t=f.work.task(f.op,f.create(f.op,'put',2).taskId);const old=t.lines[0];f.command(f.op,'replan',{lineId:old.id,revision:old.revision,cellId:f.cells[2].id,quantity:2});assert.ok(f.writes.some(s=>s.includes('digit 3 "2" red')));assert.equal(JSON.parse(f.db.prepare('SELECT desired FROM work_guidance WHERE cell_id=?').get(old.cell_id).desired).action,'clear');
 const writes=f.writes.length;f.work.flagInactivity({at:new Date(Date.now()+86400000)});assert.equal(f.writes.length,writes);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_reports').get().n,0);f.end();
});
test('utility, setup and old expiry cannot overwrite pre-arrival guidance; current generation and mapping protect hardware calls',()=>{
 const f=fixture();f.stock(f.cells[0],3);let time=new Date();const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work,clock:()=>time});const receipt=display.start(f.op,{kind:'quantity',cellId:f.cells[0].id,productId:f.product.id});f.create(f.op,'pick',2);const c=f.work.line(f.work.snapshot(f.op,{view:'mine'}).tasks[0].lines[0].id),count=f.writes.length;
 time=new Date(Date.now()+121000);display.expire();assert.equal(f.writes.length,count);assert.equal(display.start(f.admin,{kind:'locate',cellId:c.cell_id}).state,'busy');assert.equal(display.start(f.admin,{kind:'locate',setupTarget:{controller_id:f.ctrl.id,hardware_channel:4}}).state,'busy');assert.equal(f.hardware.showCellQuantity(c,99).ok,false);assert.equal(f.hardware.clearGuidance({id:9},[c]).ok,false);
 const row=f.db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(c.cell_id),desired=JSON.parse(row.desired);assert.equal(f.hardware.clearGuidance({id:9},[c],{source:'work_coordinator',workCellId:c.cell_id,workGeneration:'old',workBinding:desired.binding}).ok,false);
 f.db.prepare('UPDATE cells SET binding_revision=binding_revision+1 WHERE id=?').run(c.cell_id);assert.equal(f.hardware.clearGuidance({id:9},[c],{source:'work_coordinator',workCellId:c.cell_id,workGeneration:row.generation,workBinding:desired.binding}).ok,false);assert.equal(f.writes.length,count);f.work.flushGuidance();assert.ok(f.writes.length>count);f.end();
});
test('explicit restart restores started ready tasks, repeated maintenance instances do not replay delivered lights, failed sends retry',()=>{
 const f=fixture();f.stock(f.cells[0],3);f.create(f.op,'pick',2);let count=f.writes.length;
 for(let i=0;i<3;i++)createOperationsService({db:f.db,hardwareService:f.hardware}).flagInactivity();assert.equal(f.writes.length,count);
 const restarted=createOperationsService({db:f.db,hardwareService:f.hardware});restarted.flushGuidance({restore:true});assert.equal(f.writes.length,count+1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cell_turns').get().n,0);
 f.db.prepare('UPDATE work_guidance SET delivered=0').run();let failures=0;const offline=createOperationsService({db:f.db,hardwareService:{activateGuidance(){failures++;return {ok:false,degraded:true};}}});offline.flushGuidance();assert.equal(failures,1);assert.equal(f.db.prepare('SELECT delivered FROM work_guidance').get().delivered,0);restarted.flushGuidance();assert.equal(f.db.prepare('SELECT delivered FROM work_guidance').get().delivered,1);f.end();
});

test('verified over-plan actuals update or clear untouched sibling quantities without starting them',()=>{
 for(const actual of [4,5]){const f=fixture();f.stock(f.cells[0],3);f.stock(f.cells[1],2);const t=f.work.task(f.op,f.create(f.op,'pick',5).taskId),a=t.lines[0],b=t.lines[1];f.stock(f.cells[0],actual);f.arrive(f.op,a);const active=f.work.line(a.id);const r=f.command(f.op,'report',{lineId:a.id,revision:active.revision,cellId:a.cell_id,quantity:actual,unit:a.unit_of_measure,deviceId:'device-'+f.op.id});assert.equal(r.status,'recorded');const desired=JSON.parse(f.db.prepare('SELECT desired FROM work_guidance WHERE cell_id=?').get(b.cell_id).desired);assert.equal(f.work.line(b.id).started_at,null);assert.equal(f.work.line(b.id).planned_quantity,5-actual);if(actual===4){assert.equal(desired.quantity,1);assert.ok(f.writes.some(s=>s.includes('digit 2 "1" green')));}else{assert.equal(desired.action,'clear');assert.ok(f.writes.some(s=>s.includes('clear 2')));}f.end();}
});

test('an older adapter locator timer cannot clear newly started quantity guidance',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.stock(f.cells[0],3);const cell=f.db.prepare('SELECT c.*,ctrl.address controller_address FROM cells c JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?').get(f.cells[0].id);
 f.hardware.setCellLocate(cell,true);f.create(f.op,'pick',2);const after=f.writes.filter(s=>s.includes('clear 1')).length;t.mock.timers.tick(121000);assert.equal(f.writes.filter(s=>s.includes('clear 1')).length,after);assert.ok(f.writes.some(s=>s.includes('digit 1 "2" green')));f.end();
});
