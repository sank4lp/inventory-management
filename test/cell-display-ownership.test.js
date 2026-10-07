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
import {createStocktakingService} from '../src/modules/stocktaking/service.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'lyt-cell-display-')));const db=createDatabase({hashPassword,allowDemoInventorySeed:true});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),product=db.prepare('SELECT * FROM products LIMIT 1').get();
 const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 8').all(),ctrl=db.prepare('SELECT * FROM controllers LIMIT 1').get();
 db.exec('DELETE FROM inventory_balances; UPDATE cells SET controller_id=NULL,hardware_channel=NULL');db.prepare("UPDATE controllers SET address='GUIDE',heartbeat_status='online',module_count=20 WHERE id=?").run(ctrl.id);cells.forEach((c,i)=>db.prepare('UPDATE cells SET controller_id=?,hardware_channel=? WHERE id=?').run(ctrl.id,i+1,c.id));
 db.prepare('UPDATE products SET items_per_cell=8 WHERE id=?').run(product.id);
 const writes=[],logger={info(){},warn(){},error(){},debug(){}},hardware=createHardwareService({db,logger,config:{hardwareAdapter:'rs485',rs485WriteLine:line=>writes.push(line.trim()),rs485GuidanceBurstRepeats:1,rs485GuidanceBurstDelayMs:0,rs485InterCommandDelayMs:0}}),work=createOperationsService({db,hardwareService:hardware,logger});
 const command=(actor,action,input={})=>work.command(actor,action,{requestId:randomUUID(),...input});
 const stock=(cell,q)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0) ON CONFLICT(product_id,cell_id) DO UPDATE SET available_quantity=excluded.available_quantity').run(product.id,cell.id,q);
 const create=(actor,direction='pick',quantity=1,extra={})=>command(actor,'create',{direction,quantity,productId:product.id,...extra});
 const arrive=(actor,l)=>command(actor,'acquire',{lineId:l.id,revision:l.revision,method:'arrival',deviceId:'device-'+actor.id});
 const end=()=>{hardware.dispose();db.close();};return {db,admin,op,product,cells,ctrl,writes,hardware,work,command,stock,create,arrive,end,logger};
}

for(const direction of ['pick','put'])test(`${direction}: 60 across eight capacity-8 cells, 17 then 6 uses a fourth cell without overlapping lights`,()=>{
 const f=fixture();try{if(direction==='pick')f.cells.forEach((c,i)=>f.stock(c,i===7?4:8));
 const a=f.work.task(f.op,f.create(f.op,direction,17).taskId),b=f.work.task(f.admin,f.create(f.admin,direction,6).taskId);
 assert.deepEqual(a.lines.map(l=>l.planned_quantity),[8,8,1]);assert.equal(b.lines.length,1);assert.equal(b.lines[0].planned_quantity,6);assert.ok(!a.lines.some(l=>l.cell_id===b.lines[0].cell_id));assert.equal(b.lines[0].cell_id,f.cells[3].id);assert.ok(f.writes.some(s=>s.includes(`digit 4 "6" ${direction==='pick'?'green':'red'}`)));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cell_turns').get().n,0);
 }finally{f.end();}
});
for(const direction of ['pick','put'])test(`${direction}: one-cell fallback names owner, cannot steal by arrival/resume, hands off after cancel`,()=>{
 const f=fixture();try{f.db.prepare('UPDATE cells SET active=0 WHERE id!=?').run(f.cells[0].id);if(direction==='pick')f.stock(f.cells[0],8);
 const a=f.work.task(f.op,f.create(f.op,direction,2).taskId),b=f.work.task(f.admin,f.create(f.admin,direction,3).taskId),before=f.writes.length;
 assert.equal(b.lines[0].guidance.state,'waiting');assert.match(b.lines[0].guidance.message,new RegExp(f.op.name));assert.match(b.lines[0].guidance.message,new RegExp('Task #'+a.id));assert.equal(f.arrive(f.admin,b.lines[0]).status,'busy');assert.equal(f.writes.length,before);
 f.command(f.op,'cancel',{lineId:a.lines[0].id,revision:a.lines[0].revision});assert.equal(f.work.task(f.admin,b.id).lines[0].guidance.state,'sent');assert.match(f.writes.at(-1),/"3"/);assert.equal(f.arrive(f.admin,b.lines[0]).status,'ready');
 }finally{f.end();}
});
test('partial task proceeds at free cells while opposite-direction owner blocks only the shared cell',()=>{
 const f=fixture();try{f.db.prepare('UPDATE cells SET active=0 WHERE id NOT IN (?,?)').run(f.cells[0].id,f.cells[1].id);f.stock(f.cells[0],5);f.stock(f.cells[1],1);const a=f.work.task(f.op,f.create(f.op,'put',2,{preferredCellId:f.cells[0].id}).taskId),b=f.work.task(f.admin,f.create(f.admin,'pick',4).taskId);const free=b.lines.find(l=>l.cell_id===f.cells[1].id),blocked=b.lines.find(l=>l.cell_id===f.cells[0].id);assert.equal(free.planned_quantity,1);assert.equal(blocked.planned_quantity,3);assert.equal(free.guidance.state,'sent');assert.equal(blocked.guidance.state,'waiting');assert.equal(f.arrive(f.admin,blocked).status,'busy');assert.equal(f.arrive(f.admin,free).status,'ready');f.command(f.op,'stop',{taskId:a.id,generation:a.assignment_generation});assert.equal(f.work.task(f.admin,b.id).lines.find(l=>l.id===blocked.id).guidance.state,'sent');}finally{f.end();}
});
test('offered allocations are safely versioned at Start to prefer a free location',()=>{
 const f=fixture();try{f.stock(f.cells[0],8);f.stock(f.cells[1],8);let offered=f.work.task(f.op,f.create(f.admin,'pick',2,{assigneeId:f.op.id}).taskId);const old=offered.lines[0];f.create(f.admin,'pick',2);f.command(f.op,'start',{taskId:offered.id,generation:offered.assignment_generation});offered=f.work.task(f.op,offered.id);assert.equal(offered.lines.find(l=>l.id===old.id).execution_state,'superseded');assert.equal(offered.lines.find(l=>l.execution_state==='ready').cell_id,f.cells[1].id);assert.ok(f.db.prepare('SELECT 1 FROM work_instruction_history WHERE line_id=?').get(old.id));}finally{f.end();}
});
function countFixture(f){const count=createStocktakingService({db:f.db,operationsService:f.work});const cmd=(a,action,input)=>count.command(a,action,{requestId:randomUUID(),...input});const r=cmd(f.admin,'create',{mode:'selected',cellIds:[f.cells[0].id,f.cells[1].id],assigneeId:f.admin.id});const item=()=>count.snapshot(f.admin).runs.find(x=>x.id===r.runId).items[0];return {count,cmd,item,runId:r.runId,begin:()=>cmd(f.admin,'begin',{itemId:item().id,generation:item().generation,method:'manual',location:f.cells[0].logical_code})};}
for(const first of ['work','count'])test(`${first} first: stocktake and work are exclusive, queue handoff and stale cleanup protect newer owner`,()=>{
 const f=fixture();try{f.db.prepare('UPDATE cells SET active=0 WHERE id NOT IN (?,?)').run(f.cells[0].id,f.cells[1].id);f.stock(f.cells[0],8);const c=countFixture(f);let task;
 if(first==='work'){task=f.work.task(f.op,f.create(f.op,'pick',2).taskId);const n=f.writes.length;const waiting=c.cmd(f.admin,'locate',{itemId:c.item().id,generation:c.item().generation});assert.equal(waiting.status,'busy');assert.match(waiting.message,new RegExp('Task #'+task.id));assert.throws(()=>c.begin(),/Waiting for/);assert.equal(f.writes.length,n);f.command(f.op,'cancel',{lineId:task.lines[0].id,revision:task.lines[0].revision});assert.equal(c.count.snapshot(f.admin).runs[0].items[0].guidance.state,'sent');}
 const attempt=c.begin();assert.ok(f.writes.at(-1).includes('text 1 "LOC" yellow'));assert.equal(f.db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(f.cells[1].id),undefined);
 if(first==='count'){task=f.work.task(f.op,f.create(f.op,'pick',2).taskId);assert.equal(task.lines[0].guidance.state,'waiting');assert.equal(f.arrive(f.op,task.lines[0]).status,'busy');}
 const old=f.db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(f.cells[0].id),observed=c.cmd(f.admin,'observe',{attemptId:attempt.attemptId,lines:[{productId:f.product.id,actual:8}]});assert.ok(['matched','recheck'].includes(observed.status));
 if(first==='count'){assert.equal(f.work.task(f.op,task.id).lines[0].guidance.state,'sent');const n=f.writes.length,cell=f.work.line(task.lines[0].id);assert.equal(f.hardware.clearGuidance({id:null},[cell],{source:'work_coordinator',workCellId:cell.cell_id,workGeneration:old.generation,workBinding:JSON.parse(old.desired).binding}).ok,false);assert.equal(f.writes.length,n);}
 }finally{f.end();}
});
test('Show quantities skips operational cells and stale utility expiry never clears a newer task',()=>{
 const f=fixture();try{f.stock(f.cells[0],8);f.stock(f.cells[1],8);let time=new Date();const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work,clock:()=>time});const receipt=display.start(f.admin,{kind:'quantity',productId:f.product.id});const a=f.work.task(f.op,f.create(f.op,'pick',2).taskId);assert.equal(a.lines[0].guidance.state,'sent');const n=f.writes.length;time=new Date(Date.now()+121000);display.expire();assert.ok(f.writes.slice(n).every(s=>!s.includes('clear 1')));const later=display.start(f.admin,{kind:'quantity',productId:f.product.id});assert.equal(later.targets.find(t=>t.cellId===f.cells[0].id).status,'busy');assert.equal(later.targets.find(t=>t.cellId===f.cells[1].id).status,'sent');}finally{f.end();}
});
test('confirmed quantity override restores the same PICK guidance when stopped or expired',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],8);f.stock(f.cells[1],8);
  const task=f.work.task(f.op,f.create(f.op,'pick',2).taskId);
  const before=f.db.prepare('SELECT generation,desired FROM work_guidance WHERE cell_id=?').get(f.cells[0].id);
  let time=new Date();
  const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work,clock:()=>time});
  const preview=display.start(f.admin,{kind:'quantity',productId:f.product.id},{previewOnly:true,promptOnBusy:true});
  assert.equal(preview.state,'confirmation_required');
  assert.equal(preview.conflicts[0].taskId,task.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM display_requests').get().n,0);
  assert.throws(()=>display.start(f.admin,{kind:'quantity',productId:f.product.id,overrideWork:true}),/Confirm/);
  const showing=display.start(f.admin,{kind:'quantity',productId:f.product.id,overrideWork:true},{confirmOverride:true});
  assert.equal(showing.targets.find(t=>t.cellId===f.cells[0].id).status,'sent');
  assert.equal(f.work.task(f.op,task.id).lines[0].guidance.state,'manual');
  const sent=f.writes.length;
  f.work.flushGuidance({restore:true});
  assert.equal(f.writes.length,sent);
  const later=f.work.task(f.admin,f.create(f.admin,'pick',2).taskId);
  assert.equal(later.lines[0].cell_id,f.cells[1].id);
  assert.equal(later.lines[0].guidance.state,'manual');
  const beforeStop=f.writes.length;
  display.stop(f.admin,showing.id);
  assert.equal(f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation,before.generation);
  assert.equal(f.work.task(f.op,task.id).lines[0].guidance.state,'sent');
  assert.equal(f.work.task(f.admin,later.id).lines[0].guidance.state,'sent');
  assert.ok(f.writes.slice(beforeStop).some(line=>/digit 1 "2" green/.test(line)));
  const again=display.start(f.admin,{kind:'quantity',productId:f.product.id,overrideWork:true},{confirmOverride:true});
  time=new Date(time.getTime()+121000);display.expire();
  assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(again.id).state,'stopped');
  assert.ok(f.writes.slice(beforeStop).filter(line=>/digit 1 "2" green/.test(line)).length>=2);
 }finally{f.end();}
});
test('mixed-product quantity display alternates readable colors while a selected product remains distinct',()=>{
 const f=fixture();try{
  const other=f.db.prepare('SELECT * FROM products WHERE id!=? LIMIT 1').get(f.product.id);
  f.stock(f.cells[0],4);
  f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,7,0)').run(other.id,f.cells[0].id);
  let time=new Date();const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work,clock:()=>time});
  const mixed=display.start(f.admin,{kind:'quantity',cellId:f.cells[0].id});
  assert.deepEqual(mixed.targets[0].sequence.map(s=>s.color),['amber','cyan']);
  assert.deepEqual(mixed.targets[0].sequence.map(s=>s.value),[4,7]);
  time=new Date(time.getTime()+5000);display.expire();
  assert.match(f.writes.at(-1),/text 1 "7" cyan/);
  display.stop(f.admin,mixed.id);
  const selected=display.start(f.admin,{kind:'quantity',cellId:f.cells[0].id,productId:other.id});
  assert.equal(selected.targets[0].value,7);
  assert.equal(selected.targets[0].sequence,null);
  assert.equal(selected.targets[0].color,'yellow');
 }finally{f.end();}
});
test('total and available capacity use each product’s items-per-cell share in mixed locations',()=>{
 const f=fixture();try{
  const other=f.db.prepare('SELECT * FROM products WHERE id!=? LIMIT 1').get(f.product.id);
  f.db.prepare('UPDATE products SET items_per_cell=10 WHERE id=?').run(other.id);
  f.stock(f.cells[0],4);
  f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,2,0)').run(other.id,f.cells[0].id);
  f.db.prepare('UPDATE inventory_balances SET reserved_quantity=1 WHERE cell_id=? AND product_id=?').run(f.cells[0].id,f.product.id);
  const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work});
  const total=display.start(f.admin,{kind:'capacity_total',cellId:f.cells[0].id});
  assert.deepEqual(total.targets[0].sequence.map(s=>s.value),[8,10]);
  display.stop(f.admin,total.id);
  const free=display.start(f.admin,{kind:'capacity_available',cellId:f.cells[0].id});
  assert.deepEqual(free.targets[0].sequence.map(s=>s.value),[2,3]);
  display.stop(f.admin,free.id);
  const selected=display.start(f.admin,{kind:'capacity_available',cellId:f.cells[0].id,productId:f.product.id});
  assert.equal(selected.targets[0].value,2);
  assert.equal(selected.targets[0].sequence,null);
 }finally{f.end();}
});
test('capacity display uses the same confirmation and restores an overridden Pick light',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],8);
  const task=f.work.task(f.op,f.create(f.op,'pick',2).taskId);
  const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work});
  const scope={kind:'capacity_total',cellId:f.cells[0].id};
  assert.equal(display.start(f.admin,scope,{previewOnly:true}).state,'confirmation_required');
  const shown=display.start(f.admin,{...scope,overrideWork:true},{confirmOverride:true});
  assert.equal(shown.targets[0].value,8);
  const n=f.writes.length;display.stop(f.admin,shown.id);
  assert.ok(f.writes.slice(n).some(line=>/digit 1 "2" green/.test(line)));
  assert.equal(f.work.task(f.op,task.id).lines[0].guidance.state,'sent');
 }finally{f.end();}
});
test('quantity override cannot replace an active stocktake light',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],8);
  const count=countFixture(f);count.begin();
  const display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work});
  const before=f.writes.length;
  const preview=display.start(f.admin,{kind:'quantity',cellId:f.cells[0].id},{previewOnly:true,promptOnBusy:true});
  assert.equal(preview.state,'ready');
  const result=display.start(f.admin,{kind:'quantity',cellId:f.cells[0].id,overrideWork:true},{confirmOverride:true});
  assert.equal(result.targets[0].status,'busy');
  assert.equal(f.writes.length,before);
 }finally{f.end();}
});
test('active work retains its owner through inactivity; explicit review releases the light while preserving uncertainty',()=>{
 const f=fixture();try{f.stock(f.cells[0],8);const a=f.work.task(f.op,f.create(f.op,'pick',2).taskId);f.arrive(f.op,a.lines[0]);const b=f.work.task(f.admin,f.create(f.admin,'pick',2).taskId),old=f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation;f.work.flagInactivity({at:new Date(Date.now()+86400000)});assert.deepEqual(f.work.snapshot(f.admin).inactivityAlerts.map(a=>a.taskId),[a.id]);assert.equal(f.work.snapshot(f.op).inactivityAlerts[0].name,f.op.name);assert.equal(f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation,old);f.command(f.op,'askReview',{lineId:a.lines[0].id,reason:'Stopped, unsure quantity'});assert.equal(f.work.task(f.admin,b.id).lines[0].guidance.state,'sent');assert.equal(f.work.held(f.cells[0].id,f.product.id,'pick'),4);assert.equal(f.work.snapshot(f.admin).pending.length,1);assert.equal(f.work.snapshot(f.admin).inactivityAlerts.length,0);}finally{f.end();}
});

for(const release of ['skip','decline','assign','close'])test(`count ${release} releases its cell; late evidence and old receipts cannot clear newer work`,()=>{
 const f=fixture();try{f.stock(f.cells[0],8);const c=countFixture(f),attempt=c.begin(),item=c.item(),task=f.work.task(f.op,f.create(f.op,'pick',2).taskId);
 const input=release==='skip'?{itemId:item.id,generation:item.generation,reason:'Stop counting'}:release==='decline'?{runId:c.runId}:release==='assign'?{items:[{itemId:item.id,generation:item.generation}],assigneeId:f.op.id}:{runId:c.runId,revision:1,reason:'Stop this run'};
 const request={...input,requestId:randomUUID()};c.cmd(f.admin,release,request);assert.equal(f.work.task(f.op,task.id).lines[0].guidance.state,'sent');const generation=f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation,n=f.writes.length;
 assert.equal(c.cmd(f.admin,release,request).replayed,true);const late=c.cmd(f.admin,'observe',{attemptId:attempt.attemptId,lines:[{productId:f.product.id,actual:8}]});assert.equal(late.status,'recheck');assert.equal(f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation,generation);assert.equal(f.writes.length,n);
 }finally{f.end();}
});
test('queued count precedes a newer task and stale mapping is never reported sent',()=>{
 const f=fixture();try{f.stock(f.cells[0],8);const a=f.work.task(f.op,f.create(f.op,'pick',2).taskId),c=countFixture(f);c.cmd(f.admin,'locate',{itemId:c.item().id,generation:c.item().generation});f.db.prepare("UPDATE stocktake_display_claims SET requested_at='2000-01-01T00:00:00Z'").run();const b=f.work.task(f.admin,f.create(f.admin,'pick',2).taskId);f.command(f.op,'cancel',{lineId:a.lines[0].id,revision:a.lines[0].revision});assert.equal(f.work.task(f.admin,b.id).lines[0].guidance.state,'waiting');assert.equal(c.item().guidance.state,'sent');f.db.prepare('UPDATE cells SET binding_revision=binding_revision+1 WHERE id=?').run(f.cells[0].id);assert.equal(c.item().guidance.state,'blocked');assert.match(c.item().guidance.message,/mapping changed/);}finally{f.end();}
});
test('utility preempts a failed obsolete clear with a new generation; pending cleanup cannot erase it',()=>{
 const f=fixture();try{f.stock(f.cells[0],8);const t=f.work.task(f.op,f.create(f.op,'pick',2).taskId);f.command(f.op,'cancel',{lineId:t.lines[0].id,revision:t.lines[0].revision});f.db.prepare('UPDATE work_guidance SET delivered=0').run();const old=f.db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(f.cells[0].id),display=createDisplayCoordinator({db:f.db,hardwareService:f.hardware,operationsService:f.work});const d=display.start(f.admin,{kind:'quantity',cellId:f.cells[0].id});assert.equal(d.targets[0].status,'sent');const n=f.writes.length;f.work.flushGuidance();assert.equal(f.writes.length,n);assert.notEqual(f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation,old.generation);}finally{f.end();}
});
