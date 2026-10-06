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
test('display ownership queues arrivals without preemption, settlement promotes waiting guidance, old cleanup cannot erase the next owner',()=>{
 const f=fixture();f.stock(f.cells[0],10);const b=f.work.task(f.admin,f.create(f.admin,'pick',3).taskId).lines[0],a=f.work.task(f.op,f.create(f.op,'pick',2).taskId).lines[0];assert.equal(f.work.task(f.op,a.task_id).lines[0].guidance.state,'waiting');assert.equal(f.arrive(f.op,a).status,'busy');
 assert.equal(f.arrive(f.admin,b).status,'ready');assert.ok(f.writes.at(-1).includes('digit 1 "3" green'));assert.equal(f.arrive(f.op,a).status,'busy');
 const current=f.work.line(b.id);f.command(f.admin,'report',{lineId:b.id,revision:current.revision,quantity:1,cellId:b.cell_id,unit:b.unit_of_measure,deviceId:'device-'+f.admin.id});assert.ok(f.writes.at(-1).includes('digit 1 "2" green'));
 const generation=f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(a.cell_id).generation;const count=f.writes.length;f.command(f.admin,'stop',{taskId:b.task_id,generation:f.work.task(f.admin,b.task_id).assignment_generation});assert.equal(f.writes.length,count);assert.equal(f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(a.cell_id).generation,generation);
 f.command(f.op,'cancel',{lineId:a.id,revision:a.revision});assert.ok(f.writes.at(-1).includes('clear 1'));f.end();
});
test('uncertain exclusive turns suppress ready numbers; sibling cells and shared locator remain usable',()=>{
 const f=fixture();f.stock(f.cells[0],3);f.stock(f.cells[1],3);const t=f.work.task(f.op,f.create(f.op,'pick',5).taskId),a=t.lines[0],b=t.lines[1];f.arrive(f.op,a);f.command(f.op,'askReview',{lineId:a.id,reason:'Uncertain movement'});assert.equal(JSON.parse(f.db.prepare('SELECT desired FROM work_guidance WHERE cell_id=?').get(a.cell_id).desired).action,'clear');assert.equal(f.arrive(f.op,b).status,'ready');assert.equal(f.work.task(f.op,t.id).lines.find(l=>l.id===b.id).guidance.state,'sent');assert.ok(f.writes.some(s=>s.includes('digit 2 "2" green')));f.end();
 const g=fixture();g.stock(g.cells[0],10);g.command(g.admin,'mode',{cellId:g.cells[0].id,mode:'shared'});const x=g.work.task(g.op,g.create(g.op,'pick',2).taskId).lines[0],y=g.work.task(g.admin,g.create(g.admin,'pick',1).taskId).lines[0];assert.ok(g.writes.some(s=>s.includes('text 1 "LOC" yellow')));assert.equal(g.writes.some(s=>s.includes('digit ')),false);g.arrive(g.op,x);assert.equal(g.arrive(g.admin,y).status,'busy');g.command(g.op,'askReview',{lineId:x.id,reason:'Check actual'});assert.equal(g.work.task(g.admin,y.task_id).lines[0].guidance.state,'shared');assert.equal(g.arrive(g.admin,y).status,'ready');assert.equal(g.db.prepare('SELECT COUNT(*) n FROM cell_turns').get().n,1);g.end();
});
test('return and replan clear obsolete guidance, while untouched pre-arrival tasks do not become inactivity evidence',()=>{
 const f=fixture();let t=f.work.task(f.op,f.create(f.admin,'put',2,{assigneeId:f.op.id}).taskId);f.command(f.op,'start',{taskId:t.id,generation:t.assignment_generation});t=f.work.task(f.op,t.id);f.command(f.op,'decline',{taskId:t.id,generation:t.assignment_generation});assert.ok(f.writes.at(-1).includes('clear 1'));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_reports').get().n,0);
 t=f.work.task(f.op,f.create(f.op,'put',2).taskId);const old=t.lines[0];f.command(f.op,'replan',{lineId:old.id,revision:old.revision,cellId:f.cells[2].id,quantity:2});assert.ok(f.writes.some(s=>s.includes('digit 3 "2" red')));assert.equal(JSON.parse(f.db.prepare('SELECT desired FROM work_guidance WHERE cell_id=?').get(old.cell_id).desired).action,'clear');
 const writes=f.writes.length;f.work.flagInactivity({at:new Date(Date.now()+86400000)});assert.equal(f.writes.length,writes);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_reports').get().n,0);f.end();
});
test('utility, setup and old expiry cannot overwrite pre-arrival guidance; current generation and mapping protect hardware calls',()=>{
 const f=fixture();f.stock(f.cells[0],3);let time=new Date();const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work,clock:()=>time});const receipt=display.start(f.op,{kind:'quantity',cellId:f.cells[0].id,productId:f.product.id});f.create(f.op,'pick',2);const c=f.work.line(f.work.snapshot(f.op,{view:'mine'}).tasks[0].lines[0].id),count=f.writes.length;
 time=new Date(Date.now()+121000);display.expire();assert.equal(f.writes.length,count);assert.equal(display.start(f.admin,{kind:'locate',cellId:c.cell_id}).state,'busy');assert.equal(display.start(f.admin,{kind:'locate',setupTarget:{controller_id:f.ctrl.id,hardware_channel:4}}).state,'active');assert.equal(f.hardware.showCellQuantity(c,99).ok,false);assert.equal(f.hardware.clearGuidance({id:9},[c]).ok,false);
 const row=f.db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(c.cell_id),desired=JSON.parse(row.desired);assert.equal(f.hardware.clearGuidance({id:9},[c],{source:'work_coordinator',workCellId:c.cell_id,workGeneration:'old',workBinding:desired.binding}).ok,false);
 f.db.prepare('UPDATE cells SET binding_revision=binding_revision+1 WHERE id=?').run(c.cell_id);assert.equal(f.hardware.clearGuidance({id:9},[c],{source:'work_coordinator',workCellId:c.cell_id,workGeneration:row.generation,workBinding:desired.binding}).ok,false);assert.equal(f.writes.length,count);f.work.flushGuidance();assert.equal(f.writes.length,count);assert.match(f.work.task(f.op,c.task_id).lines[0].guidance.message,/mapping changed/);f.end();
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

const guideInput=(t,l=t.lines[0])=>({taskId:t.id,generation:t.assignment_generation,lineId:l.id,revision:l.revision,bindingRevision:l.binding_revision});
const physicalState=f=>({tasks:f.db.prepare('SELECT * FROM tasks').all(),lines:f.db.prepare('SELECT * FROM task_lines').all(),ledger:f.db.prepare('SELECT * FROM transactions').all(),reservations:f.db.prepare('SELECT * FROM work_reservations').all(),turns:f.db.prepare('SELECT * FROM cell_turns').all(),reports:f.db.prepare('SELECT * FROM work_reports').all()});
for(const direction of ['pick','put'])for(const assigned of [false,true])test(`${direction} ${assigned?'assigned':'self'}: explicit Refresh light resends an already-delivered selected quantity without arrival, stock changes or poll replay`,()=>{
 const f=fixture();if(direction==='pick'){f.stock(f.cells[0],3);f.stock(f.cells[1],2);}let t=f.work.task(f.op,f.create(assigned?f.admin:f.op,direction,5,assigned?{assigneeId:f.op.id}:{}).taskId);
 if(assigned){assert.throws(()=>f.command(f.op,'guide',guideInput(t)),/Start eligible/);assert.equal(f.writes.length,0);f.command(f.op,'start',{taskId:t.id,generation:t.assignment_generation});t=f.work.task(f.op,t.id);}
 const before=physicalState(f),count=f.writes.length,input={...guideInput(t),requestId:randomUUID()};assert.equal(f.db.prepare('SELECT delivered FROM work_guidance WHERE cell_id=?').get(t.lines[0].cell_id).delivered,1);
 f.work.command(f.op,'guide',input);assert.equal(f.writes.length,count+1);assert.match(f.writes.at(-1),new RegExp(`digit 1 "3" ${direction==='pick'?'green':'red'} 120`));assert.deepEqual(physicalState(f),before);
 assert.equal(f.work.command(f.op,'guide',input).replayed,true);assert.equal(f.writes.length,count+1);
 for(let i=0;i<3;i++){f.work.task(f.op,t.id);f.work.snapshot(f.op,{taskId:t.id});f.work.flushGuidance();}assert.equal(f.writes.length,count+1);
 f.command(f.op,'guide',guideInput(t,t.lines[1]));assert.equal(f.writes.length,count+2);assert.match(f.writes.at(-1),new RegExp(`digit 2 "2" ${direction==='pick'?'green':'red'} 120`));assert.deepEqual(physicalState(f),before);f.end();
});
test('explicit Refresh light is scoped even with other pending delivery; other-user views, stale instructions and closed work cannot relight',()=>{
 const f=fixture();f.stock(f.cells[0],3);f.stock(f.cells[1],3);const a=f.work.task(f.op,f.create(f.op,'pick',2).taskId),b=f.work.task(f.admin,f.create(f.admin,'pick',2,{preferredCellId:f.cells[1].id}).taskId);const count=f.writes.length;
 f.db.prepare('UPDATE work_guidance SET delivered=0 WHERE cell_id=?').run(b.lines[0].cell_id);f.command(f.op,'guide',guideInput(a));assert.equal(f.writes.length,count+1);assert.match(f.writes.at(-1),/digit 1/);assert.equal(f.db.prepare('SELECT delivered FROM work_guidance WHERE cell_id=?').get(b.lines[0].cell_id).delivered,0);
 const before=f.writes.length;for(const [actor,patch] of [[f.admin,{}],[f.op,{generation:99}],[f.op,{revision:99}],[f.op,{bindingRevision:99}],[f.op,{lineId:b.lines[0].id}]])assert.throws(()=>f.command(actor,'guide',{...guideInput(a),...patch}));assert.equal(f.writes.length,before);
 f.command(f.op,'stop',{taskId:a.id,generation:a.assignment_generation});const stopped=f.work.task(f.op,a.id),n=f.writes.length;assert.throws(()=>f.command(f.op,'guide',guideInput(stopped)),/Start eligible/);assert.equal(f.writes.length,n);f.end();
});
test('explicit Refresh light does not steal contention, blocked uncertainty stays dark, healthy siblings and shared locators retain their rules',()=>{
 const f=fixture();f.stock(f.cells[0],10);f.stock(f.cells[1],5);f.stock(f.cells[1],0);const b=f.work.task(f.admin,f.create(f.admin,'pick',1).taskId),a=f.work.task(f.op,f.create(f.op,'pick',5).taskId);f.arrive(f.admin,b.lines[0]);const before=physicalState(f),n=f.writes.length;
 const result=f.command(f.op,'guide',guideInput(a));assert.equal(result.guidanceCells.length,0);assert.equal(f.writes.length,n);assert.deepEqual(physicalState(f),before);
 f.command(f.admin,'askReview',{lineId:b.lines[0].id,reason:'Unknown physical work'});const n2=f.writes.length;f.command(f.op,'guide',guideInput(a));assert.equal(f.writes.length,n2+1);assert.equal(f.work.task(f.op,a.id).lines[0].guidance.state,'sent');f.end();
 const g=fixture();g.stock(g.cells[0],3);g.stock(g.cells[1],2);let t=g.work.task(g.op,g.create(g.op,'pick',5).taskId);g.command(g.op,'askReview',{lineId:t.lines[0].id,reason:'Uncertain'});t=g.work.task(g.op,t.id);assert.throws(()=>g.command(g.op,'guide',guideInput(t)),/quantity check/);const n3=g.writes.length;g.command(g.op,'guide',guideInput(t,t.lines[1]));assert.equal(g.writes.length,n3+1);assert.match(g.writes.at(-1),/digit 2 "2" green/);
 g.command(g.admin,'assignReview',{taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token,assigneeId:g.op.id});t=g.work.task(g.op,t.id);const n4=g.writes.length;assert.throws(()=>g.command(g.op,'guide',guideInput(t,t.lines[1])),/Quantity-check/);assert.equal(g.writes.length,n4);g.end();
 const h=fixture();h.command(h.admin,'mode',{cellId:h.cells[0].id,mode:'shared'});h.stock(h.cells[0],3);const shared=h.work.task(h.op,h.create(h.op,'pick',1).taskId),nh=h.writes.length;h.command(h.op,'guide',guideInput(shared));assert.ok(h.writes.length>nh);assert.ok(h.writes.slice(nh).every(s=>/text 1 "LOC" yellow/.test(s)));assert.equal(h.db.prepare('SELECT COUNT(*) n FROM cell_turns').get().n,0);h.end();
});

test('working-task Refresh light keeps the original exclusive turn; failed delivery stays unconfirmed and GETs do not retry',()=>{
 const f=fixture();f.stock(f.cells[0],3);let t=f.work.task(f.op,f.create(f.op,'pick',2).taskId);f.arrive(f.op,t.lines[0]);t=f.work.task(f.op,t.id);const before=physicalState(f),n=f.writes.length;f.command(f.op,'guide',guideInput(t));assert.equal(f.writes.length,n+1);assert.deepEqual(physicalState(f),before);
 let failures=0;const offline=createOperationsService({db:f.db,hardwareService:{activateGuidance(){failures++;return {ok:false,degraded:true};}}});offline.command(f.op,'guide',{...guideInput(t),requestId:randomUUID()});assert.equal(failures,1);assert.equal(offline.task(f.op,t.id).lines[0].guidance.state,'manual');offline.snapshot(f.op,{taskId:t.id});assert.equal(failures,1);assert.deepEqual(physicalState(f),before);f.end();
});

const resumeInput=t=>({taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token,instructions:t.lines.filter(l=>['ready','working'].includes(l.execution_state)&&l.planned_quantity>0&&!l.reports.some(r=>['review','received'].includes(r.status))).map(l=>({lineId:l.id,revision:l.revision,bindingRevision:l.binding_revision}))});
test('leaving a task clears its lights without releasing stock; Resume relights it and ignores an older page',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],3);f.stock(f.cells[1],2);
  const t=f.work.task(f.op,f.create(f.op,'pick',5,{guidanceSession:'page-one'}).taskId);
  const reserved=f.db.prepare("SELECT COUNT(*) n FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.state='held'").get(t.id).n;
  assert.equal(reserved,2);
  f.command(f.op,'pause',{taskId:t.id,generation:t.assignment_generation,guidanceSession:'page-one'});
  assert.equal(f.db.prepare('SELECT guidance_paused FROM tasks WHERE id=?').get(t.id).guidance_paused,1);
  for(const channel of [1,2])assert.ok(f.writes.some(s=>s.includes(`clear ${channel}`)));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.state='held'").get(t.id).n,reserved);
  assert.equal(f.work.task(f.op,t.id).lines[0].guidance.state,'paused');
  assert.throws(()=>f.command(f.op,'guide',guideInput(t)),/Resume this task/);
  const resumed=f.command(f.op,'resume',{...resumeInput(t),guidanceSession:'page-two'});
  assert.equal(resumed.guidanceCells.length,2);
  for(const [channel,quantity] of [[1,3],[2,2]])assert.ok(f.writes.filter(s=>s.includes(`digit ${channel} "${quantity}" green`)).length>=2);
  const count=f.writes.length;
  f.command(f.op,'pause',{taskId:t.id,generation:t.assignment_generation,guidanceSession:'page-one'});
  assert.equal(f.writes.length,count);
  assert.equal(f.db.prepare('SELECT guidance_paused FROM tasks WHERE id=?').get(t.id).guidance_paused,0);
 }finally{f.end();}
});
test('pausing an arrived cell turns its display off but keeps its physical turn exclusive',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],10);
  const first=f.work.task(f.op,f.create(f.op,'pick',2,{guidanceSession:'page-one'}).taskId);
  f.arrive(f.op,first.lines[0]);
  const second=f.work.task(f.admin,f.create(f.admin,'pick',2).taskId);
  f.command(f.op,'pause',{taskId:first.id,generation:first.assignment_generation,guidanceSession:'page-one'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cell_turns WHERE cell_id=?').get(first.lines[0].cell_id).n,1);
  assert.match(f.writes.at(-1),/clear 1/);
  assert.equal(f.work.task(f.admin,second.id).lines[0].guidance.state,'waiting');
  assert.equal(f.arrive(f.admin,second.lines[0]).status,'busy');
  const latest=f.work.task(f.op,first.id);
  f.command(f.op,'resume',{...resumeInput(latest),guidanceSession:'page-two'});
  assert.match(f.writes.at(-1),/digit 1 "2" green/);
 }finally{f.end();}
});
for(const direction of ['pick','put'])for(const assigned of [false,true])test(`${direction} ${assigned?'assigned':'self'}: explicit Resume refreshes all eligible locations while inspection and receipt replay stay passive`,()=>{
 const f=fixture();try{if(direction==='pick'){f.stock(f.cells[0],3);f.stock(f.cells[1],2);}let t=f.work.task(f.op,f.create(assigned?f.admin:f.op,direction,5,assigned?{assigneeId:f.op.id}:{}).taskId);
 if(assigned){assert.throws(()=>f.command(f.op,'resume',resumeInput(t)));assert.equal(f.writes.length,0);f.command(f.op,'start',{taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token});t=f.work.task(f.op,t.id);}
 const before=physicalState(f),count=f.writes.length;for(let i=0;i<3;i++){f.work.task(f.op,t.id);f.work.snapshot(f.op,{taskId:t.id});}assert.equal(f.writes.length,count);
 const input={...resumeInput(t),requestId:randomUUID()},result=f.work.command(f.op,'resume',input);assert.equal(result.generation,t.assignment_generation);assert.equal(f.writes.length,count+2);for(const [ch,q] of [[1,3],[2,2]])assert.ok(f.writes.slice(count).some(s=>s.includes(`digit ${ch} "${q}" ${direction==='pick'?'green':'red'} 120`)));assert.deepEqual(physicalState(f),before);
 assert.equal(f.work.command(f.op,'resume',input).replayed,true);assert.equal(f.writes.length,count+2);assert.deepEqual(physicalState(f),before);
 const n=f.writes.length;for(const [actor,patch] of [[f.admin,{}],[f.op,{generation:99}],[f.op,{progressToken:'stale'}],[f.op,{instructions:[]}],[f.op,{instructions:input.instructions.map(x=>({...x,revision:99}))}],[f.op,{instructions:input.instructions.map(x=>({...x,bindingRevision:99}))}]])assert.throws(()=>f.command(actor,'resume',{...resumeInput(t),...patch}));assert.equal(f.writes.length,n);
 f.command(f.op,'stop',{taskId:t.id,generation:t.assignment_generation});t=f.work.task(f.op,t.id);const closed=f.writes.length;assert.throws(()=>f.command(f.op,'resume',resumeInput(t)));assert.equal(f.writes.length,closed);
 }finally{f.end();}
});
test('Resume excludes uncertain cells, rejects review follow-up, and cannot take another owner’s display',()=>{
 const f=fixture();try{f.stock(f.cells[0],3);f.stock(f.cells[1],3);let t=f.work.task(f.op,f.create(f.op,'pick',5).taskId);f.command(f.op,'askReview',{lineId:t.lines[0].id,reason:'Unknown actual'});t=f.work.task(f.op,t.id);const n=f.writes.length,before=physicalState(f);f.command(f.op,'resume',resumeInput(t));assert.equal(f.writes.length,n+1);assert.match(f.writes.at(-1),/digit 2 "2" green/);assert.deepEqual(physicalState(f),before);
 f.command(f.admin,'assignReview',{taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token,assigneeId:f.op.id});t=f.work.task(f.op,t.id);const n2=f.writes.length;assert.throws(()=>f.command(f.op,'resume',resumeInput(t)));assert.equal(f.writes.length,n2);
 }finally{f.end();}
 const g=fixture();try{g.stock(g.cells[0],10);const b=g.work.task(g.admin,g.create(g.admin,'pick',2).taskId),a=g.work.task(g.op,g.create(g.op,'pick',2).taskId);g.arrive(g.admin,b.lines[0]);const before=physicalState(g),n=g.writes.length;assert.equal(g.command(g.op,'resume',resumeInput(a)).guidanceCells.length,0);assert.equal(g.writes.length,n);assert.deepEqual(physicalState(g),before);}finally{g.end();}
});
