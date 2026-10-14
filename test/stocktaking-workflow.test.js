import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createStocktakingService} from '../src/modules/stocktaking/service.js';
import {locationQrValue} from '../src/modules/operations/location-contract.js';
import {migrateStocktaking} from '../src/modules/stocktaking/schema.js';
function fixture({deferStocktakeDisplays=false}={}){
 let instant=new Date();const clock=()=>instant;
 process.chdir(mkdtempSync(join(tmpdir(),'stocktake-shared-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true});db.exec('DELETE FROM inventory_balances');
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),p=db.prepare('SELECT * FROM products LIMIT 1').get(),cells=db.prepare('SELECT * FROM cells WHERE active=1 LIMIT 3').all(),writes=[];
 db.prepare('UPDATE products SET items_per_cell=20 WHERE id=?').run(p.id);
 const hardware={showCellQuantity:(cell,value,color)=>{writes.push({cell:cell.id,value,color});return{ok:true};},clearGuidance:(_,targets)=>{writes.push(...targets.map(c=>({cell:c.id,clear:true})));return{ok:true};},activateGuidance:(task,lines)=>{writes.push(...lines.map(l=>({cell:l.cell_id,value:l.planned_quantity,color:task.type==='pick'?'green':'red'})));return{ok:true};}};
 const work=createOperationsService({db,hardwareService:hardware,deferStocktakeDisplays,clock}),count=createStocktakingService({db,operationsService:work,clock});
 const cmd=(actor,action,input={})=>count.command(actor,action,{requestId:randomUUID(),...input}),wcmd=(actor,action,input)=>work.command(actor,action,{requestId:randomUUID(),...input});
 const stock=(cell,q,product=p)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0) ON CONFLICT(product_id,cell_id) DO UPDATE SET available_quantity=excluded.available_quantity').run(product.id,cell.id,q);
 const create=({autoStart=true,...extra}={})=>{const result=cmd(admin,'create',{mode:'selected',cellIds:cells.slice(0,2).map(c=>c.id),counterIds:[admin.id,op.id],...extra});if(autoStart)cmd((extra.counterIds?.[0]===op.id||extra.assigneeId===op.id)?op:admin,'start',{runId:result.runId});return result.runId;};
 const item=(runId,cell=cells[0],actor=admin)=>count.snapshot(actor).runs.find(r=>r.id===runId).items.find(i=>i.cell_id===cell.id);
 const begin=(runId,actor=op,cell=cells[0])=>{const r=count.snapshot(actor).runs.find(r=>r.id===runId);if(!r.started_at||r.paused_at)cmd(actor,'start',{runId});const row=item(runId,cell,actor);return cmd(actor,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:cell.logical_code});};
 const actual=(cell)=>db.prepare('SELECT available_quantity q FROM inventory_balances WHERE product_id=? AND cell_id=?').get(p.id,cell.id)?.q||0;
 return {db,admin,op,p,cells,writes,hardware,work,count,cmd,wcmd,stock,create,item,begin,actual,advance:ms=>{instant=new Date(instant.getTime()+ms);}};
}
test('warehouse and shelf scopes follow the hierarchy, and product counts preserve other products',()=>{
 const f=fixture();try{
  f.db.prepare("UPDATE cells SET warehouse_name='Second Warehouse',travel_instructions='Shelf 2' WHERE id=?").run(f.cells[1].id);
  const w=f.db.prepare("SELECT * FROM location_warehouses WHERE name='Second Warehouse'").get(),s=f.db.prepare("SELECT * FROM location_shelves WHERE name='Shelf 2' AND warehouse_id=?").get(w.id);
  const warehouse=f.create({mode:'warehouse',warehouseId:w.id,cellIds:[]});assert.deepEqual(f.count.snapshot(f.admin).runs.find(r=>r.id===warehouse).items.map(i=>i.cell_id),[f.cells[1].id]);
  const shelf=f.create({mode:'shelf',warehouseId:w.id,shelfId:s.id,cellIds:[]});assert.equal(f.item(shelf,f.cells[1]).cell_id,f.cells[1].id);
  const other=f.db.prepare('SELECT * FROM products WHERE id!=? LIMIT 1').get(f.p.id);f.stock(f.cells[1],6);f.stock(f.cells[1],4,other);
  const run=f.create({mode:'product',warehouseId:w.id,productId:f.p.id,cellIds:[]}),a=f.begin(run,f.op,f.cells[1]);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:5}]});assert.equal(f.actual(f.cells[1]),5);assert.equal(f.db.prepare('SELECT available_quantity q FROM inventory_balances WHERE product_id=? AND cell_id=?').get(other.id,f.cells[1].id).q,4);
 }finally{f.db.close();}
});
test('several counters share an area but acquire different cells atomically',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);f.stock(f.cells[1],7);const run=f.create();assert.ok(f.writes.filter(w=>w.color==='yellow').length>=2);
  const a=f.begin(run),b=f.begin(run,f.admin,f.cells[1]);assert.ok(a.attemptId&&b.attemptId);assert.ok(f.writes.some(w=>w.cell===f.cells[0].id&&w.color==='orange'&&w.value===6));
  assert.throws(()=>f.begin(run,f.admin,f.cells[0]),/Being counted by/);assert.equal(f.item(run,f.cells[0]).assignee_id,f.op.id);assert.equal(f.item(run,f.cells[1]).assignee_id,f.admin.id);
 }finally{f.db.close();}
});
test('a corrected count updates immediately, is audited once and stays blue while other locations remain',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create(),attempt=f.begin(run);const input={requestId:randomUUID(),attemptId:attempt.attemptId,lines:[{productId:f.p.id,actual:4}]};const result=f.count.command(f.op,'observe',input);assert.equal(result.status,'approved');assert.equal(f.actual(f.cells[0]),4);assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===run).status,'in_progress');
  assert.equal(f.writes.at(-1).color,'blue');assert.equal(f.writes.at(-1).value,4);const moves=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n;f.count.command(f.op,'observe',input);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,moves);
  const audit=f.db.prepare('SELECT * FROM stocktake_observations WHERE id=?').get(result.observationId);assert.equal(audit.counter_id,f.op.id);assert.equal(audit.reviewer_id,f.op.id);assert.equal(JSON.parse(audit.lines_json)[0].recorded,6);
  f.cmd(f.admin,'display',{runId:run,enabled:false});assert.ok(f.writes.at(-1).clear);assert.equal(f.count.snapshot(f.admin).runs.find(r=>r.id===run).status,'in_progress');
 }finally{f.db.close();}
});
test('pending and completed lights yield to Pick, while an orange cell retains counting ownership',()=>{
 const f=fixture();try{f.stock(f.cells[0],10);const run=f.create(),attempt=f.begin(run);const task=f.wcmd(f.admin,'create',{direction:'pick',productId:f.p.id,quantity:2,preferredCellId:f.cells[0].id});assert.equal(f.work.task(f.admin,task.taskId).lines[0].guidance.state,'waiting');
  const result=f.cmd(f.op,'observe',{attemptId:attempt.attemptId,lines:[{productId:f.p.id,actual:10}]});assert.equal(result.status,'matched');assert.equal(f.work.task(f.admin,task.taskId).lines[0].guidance.state,'sent');assert.equal(f.writes.at(-1).color,'green');
  const line=f.work.task(f.admin,task.taskId).lines[0];f.wcmd(f.admin,'cancel',{lineId:line.id,revision:line.revision});assert.equal(f.writes.at(-1).color,'blue');assert.equal(f.writes.at(-1).value,10);
 }finally{f.db.close();}
});
test('an active Pick keeps its light until finished, then a waiting count takes over',()=>{
 const f=fixture();try{f.stock(f.cells[0],10);const task=f.wcmd(f.op,'create',{direction:'pick',productId:f.p.id,quantity:2,preferredCellId:f.cells[0].id}),run=f.create({cellIds:[f.cells[0].id]});assert.equal(f.writes.at(-1).color,'green');assert.throws(()=>f.begin(run,f.admin),/Waiting for/);const line=f.work.task(f.op,task.taskId).lines[0];f.wcmd(f.op,'cancel',{lineId:line.id,revision:line.revision});f.begin(run,f.admin);assert.equal(f.writes.at(-1).color,'orange');
 }finally{f.db.close();}
});
test('a stale count leaves inventory untouched and can be paused and recounted',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create({cellIds:[f.cells[0].id]}),attempt=f.begin(run);f.stock(f.cells[0],7);assert.throws(()=>f.cmd(f.op,'observe',{attemptId:attempt.attemptId,lines:[{productId:f.p.id,actual:5}]}),/Pause Stock Take/);assert.equal(f.actual(f.cells[0]),7);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_observations').get().n,0);
  let row=f.item(run);f.cmd(f.op,'pause',{itemId:row.id,generation:row.generation});const fresh=f.begin(run);f.cmd(f.op,'observe',{attemptId:fresh.attemptId,lines:[{productId:f.p.id,actual:7}]});assert.equal(f.item(run).state,'counted');
 }finally{f.db.close();}
});
test('a count reducing stock flags infeasible reservations for high-priority review',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const offered=f.wcmd(f.admin,'create',{direction:'pick',productId:f.p.id,quantity:5,preferredCellId:f.cells[0].id,assigneeId:f.op.id}),run=f.create({cellIds:[f.cells[0].id]}),a=f.begin(run,f.admin);f.cmd(f.admin,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:3}]});const task=f.work.task(f.admin,offered.taskId);assert.equal(f.actual(f.cells[0]),3);assert.equal(task.work_priority,'high');assert.ok(f.work.snapshot(f.admin).pending.some(r=>r.task_id===task.id));
 }finally{f.db.close();}
});
test('scanning resolves only assigned cells; unknown and out-of-scope labels are rejected',()=>{
 const f=fixture();try{const run=f.create({cellIds:[f.cells[0].id]}),qr=locationQrValue(f.db,f.work.identity().site,f.cells[0]);assert.equal(f.count.resolve(f.op,run,qr).cellId,f.cells[0].id);assert.throws(()=>f.count.resolve(f.op,run,'unknown-sticker'),/not recognised/);assert.throws(()=>f.count.resolve(f.op,run,locationQrValue(f.db,f.work.identity().site,f.cells[1])),/outside/);
 }finally{f.db.close();}
});
test('shared shelf assignments exclude outsiders and survive a service restart',()=>{
 const f=fixture();try{const run=f.create({counterIds:[f.op.id]}),row=f.item(run,f.cells[0],f.op);assert.equal(f.count.snapshot(f.op).runs[0].pending,2);const restarted=createStocktakingService({db:f.db,operationsService:f.work});assert.ok(restarted.snapshot(f.op).runs.find(r=>r.id===run).items.some(i=>i.id===row.id));
  f.cmd(f.admin,'assignAreas',{runId:run,assignments:[{mode:'selected',cellIds:[f.cells[0].id],counterIds:[f.admin.id]}]});assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===run).items.some(i=>i.id===row.id),false);
 }finally{f.db.close();}
});
test('background display batches yield to newer work and an ended display cannot relight old colors',async()=>{
 const f=fixture({deferStocktakeDisplays:true});try{
  f.stock(f.cells[0],6);f.create();assert.equal(f.writes.length,0);
  const task=f.wcmd(f.admin,'create',{direction:'pick',productId:f.p.id,quantity:2,preferredCellId:f.cells[0].id});
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.ok(f.writes.some(w=>w.cell===f.cells[0].id&&w.color==='green'));
  assert.ok(!f.writes.some(w=>w.cell===f.cells[0].id&&w.color==='yellow'));
  const run=f.count.snapshot(f.admin).runs[0];f.cmd(f.admin,'display',{runId:run.id,enabled:false});
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(f.work.task(f.admin,task.taskId).lines[0].guidance.state,'sent');
  assert.ok(!f.writes.some(w=>w.cell===f.cells[0].id&&w.clear));
  assert.ok(f.writes.some(w=>w.cell===f.cells[1].id&&w.clear));
 }finally{f.work.dispose();f.db.close();}
});
test('ending a newer stocktake does not restore obsolete markers, and old End cannot clear the newer display',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],6);const first=f.create(),a=f.begin(first);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:6}]});
  const second=f.create(),n=f.writes.length;f.cmd(f.admin,'display',{runId:first,enabled:false});assert.equal(f.writes.length,n);assert.equal(f.writes.at(-1).color,'yellow');
  const b=f.begin(second);f.cmd(f.op,'observe',{attemptId:b.attemptId,lines:[{productId:f.p.id,actual:6}]});assert.equal(f.writes.at(-1).color,'blue');f.cmd(f.admin,'display',{runId:second,enabled:false});assert.ok(f.writes.at(-1).clear);
 }finally{f.db.close();}
});
test('historical zero balances need no count row, but positive products must still be counted',()=>{
 const f=fixture();try{const other=f.db.prepare('SELECT * FROM products WHERE id!=? LIMIT 1').get(f.p.id);f.stock(f.cells[0],6);f.stock(f.cells[0],0,other);const run=f.create({cellIds:[f.cells[0].id]}),a=f.begin(run);
  assert.throws(()=>f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[],emptyConfirmed:true}),/every recorded product with stock/);
  const result=f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:5}]});assert.equal(result.status,'approved');assert.equal(f.actual(f.cells[0]),5);assert.equal(f.db.prepare('SELECT available_quantity q FROM inventory_balances WHERE cell_id=? AND product_id=?').get(f.cells[0].id,other.id).q,0);
  assert.equal(JSON.parse(f.db.prepare('SELECT lines_json FROM stocktake_observations WHERE id=?').get(result.observationId).lines_json).length,1);
 }finally{f.db.close();}
});
test('zero-only locations require an empty check and a rediscovered product can be counted again',()=>{
 const f=fixture();try{f.stock(f.cells[0],0);let run=f.create({cellIds:[f.cells[0].id]}),a=f.begin(run);assert.throws(()=>f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[]}),/Explicitly confirm/);assert.equal(f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[],emptyConfirmed:true}).status,'matched');
  run=f.create({cellIds:[f.cells[0].id]});a=f.begin(run);assert.equal(f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:2}]}).status,'approved');assert.equal(f.actual(f.cells[0]),2);
 }finally{f.db.close();}
});
test('zero-product scope preserves other stock, and a newly positive hidden product invalidates an older count',()=>{
 const f=fixture();try{const other=f.db.prepare('SELECT * FROM products WHERE id!=? LIMIT 1').get(f.p.id);f.stock(f.cells[0],0);f.stock(f.cells[0],4,other);let run=f.create({mode:'product',productId:f.p.id,cellIds:[f.cells[0].id]}),a=f.begin(run);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[],emptyConfirmed:true});assert.equal(f.db.prepare('SELECT available_quantity q FROM inventory_balances WHERE cell_id=? AND product_id=?').get(f.cells[0].id,other.id).q,4);
  f.stock(f.cells[0],6);f.stock(f.cells[0],0,other);run=f.create({cellIds:[f.cells[0].id]});a=f.begin(run);f.stock(f.cells[0],3,other);assert.throws(()=>f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:6}]}),/Pause Stock Take/);assert.equal(f.actual(f.cells[0]),6);
 }finally{f.db.close();}
});
test('leaving releases only the counter cell; the last departure pauses without clearing active Pick lights',()=>{
 const f=fixture();try{f.stock(f.cells[0],8);f.stock(f.cells[1],6);const run=f.create(),one=randomUUID(),two=randomUUID();f.cmd(f.op,'join',{runId:run,sessionId:one});f.cmd(f.admin,'join',{runId:run,sessionId:two});
  for(const [actor,sessionId,cell]of [[f.op,one,f.cells[0]],[f.admin,two,f.cells[1]]]){const row=f.item(run,cell,actor);f.cmd(actor,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:cell.logical_code,sessionId});}
  assert.equal(f.cmd(f.op,'leave',{runId:run,sessionId:one}).paused,false);assert.equal(f.item(run,f.cells[0]).state,'pending');assert.equal(f.item(run,f.cells[1]).state,'counting');assert.ok(f.writes.some(w=>w.cell===f.cells[0].id&&w.clear));assert.equal(f.writes.filter(w=>w.cell===f.cells[1].id).at(-1).color,'orange');
  const task=f.wcmd(f.op,'create',{direction:'pick',productId:f.p.id,quantity:2,preferredCellId:f.cells[0].id});assert.equal(f.work.task(f.op,task.taskId).lines[0].guidance.state,'sent');
  assert.equal(f.cmd(f.admin,'leave',{runId:run,sessionId:two}).paused,true);const r=f.count.snapshot(f.admin).runs.find(r=>r.id===run);assert.ok(r.paused_at);assert.equal(r.display_enabled,0);assert.equal(f.writes.filter(w=>w.cell===f.cells[0].id).at(-1).color,'green');assert.equal(f.actual(f.cells[0]),8);
  f.cmd(f.op,'join',{runId:run,sessionId:randomUUID()});assert.equal(f.count.snapshot(f.admin).runs.find(r=>r.id===run).paused_at,null);
 }finally{f.db.close();}
});
test('old pages and delayed heartbeats cannot clear a new session or relight a left stocktake',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create(),old=randomUUID(),fresh=randomUUID();f.cmd(f.op,'join',{runId:run,sessionId:old});let row=f.item(run);f.cmd(f.op,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:f.cells[0].logical_code,sessionId:old});f.cmd(f.op,'join',{runId:run,sessionId:fresh});
  assert.throws(()=>f.cmd(f.admin,'leave',{runId:run,sessionId:old}),/another counter/);f.cmd(f.op,'leave',{runId:run,sessionId:old});assert.equal(f.item(run).state,'counting');assert.throws(()=>f.count.heartbeat(f.op,{runId:run,sessionId:old}),/Counting paused/);
  f.cmd(f.op,'leave',{runId:run,sessionId:fresh});assert.equal(f.item(run).state,'pending');assert.equal(f.count.snapshot(f.admin).runs.find(r=>r.id===run).display_enabled,0);assert.throws(()=>f.cmd(f.op,'join',{runId:run,sessionId:old}),/new counting session/);
 }finally{f.db.close();}
});
test('closed devices expire, keep saved counts and pause the last stocktake session',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create(),sessionId=randomUUID();f.cmd(f.op,'join',{runId:run,sessionId});const a=f.begin(run);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:5}]});
  f.advance(46000);f.count.tick();f.work.flushGuidance();const r=f.count.snapshot(f.admin).runs.find(r=>r.id===run);assert.equal(r.display_enabled,0);assert.ok(r.paused_at);assert.equal(f.actual(f.cells[0]),5);assert.equal(f.item(run).state,'counted');
  f.cmd(f.op,'join',{runId:run,sessionId:randomUUID()});assert.equal(f.count.snapshot(f.admin).runs.find(r=>r.id===run).completed,1);assert.equal(f.writes.filter(w=>w.cell===f.cells[0].id).at(-1).color,'blue');
 }finally{f.db.close();}
});
test('the final count ends all stocktake indicators while preserving its correction audit',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create({cellIds:[f.cells[0].id]}),sessionId=randomUUID();f.cmd(f.op,'join',{runId:run,sessionId});const row=f.item(run),a=f.cmd(f.op,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:f.cells[0].logical_code,sessionId});const result=f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:5}]});
  const r=f.count.snapshot(f.admin).runs.find(r=>r.id===run);assert.equal(r.status,'completed');assert.equal(r.display_enabled,0);assert.ok(f.writes.at(-1).clear);assert.equal(f.actual(f.cells[0]),5);assert.ok(f.db.prepare('SELECT 1 FROM stocktake_settlements WHERE observation_id=?').get(result.observationId));
 }finally{f.db.close();}
});
test('shared stocktakes appear once per assignee in My Work and disappear for everyone after the final count',()=>{
 const f=fixture();try{
  const addPerson=name=>{const id=Number(f.db.prepare('INSERT INTO users(name,username,password_hash,role,created_at) VALUES(?,?,?,?,?)').run(name,name,hashPassword('test-password'),'operator',new Date().toISOString()).lastInsertRowid);return f.db.prepare('SELECT * FROM users WHERE id=?').get(id);};
  const third=addPerson('third-counter'),outsider=addPerson('unassigned-counter');f.stock(f.cells[0],6);f.stock(f.cells[1],7);
  const run=f.create({autoStart:false,counterIds:[f.op.id,f.admin.id,third.id]}),mine=actor=>f.work.snapshot(actor,{view:'mine'}).tasks.filter(t=>t.work_kind==='stocktake');
  for(const actor of [f.op,f.admin,third]){assert.deepEqual(mine(actor).map(t=>t.stocktake_id),[run]);assert.equal(mine(actor)[0].action_label,'Start');}
  assert.equal(mine(outsider).length,0);
  const one=f.begin(run,f.op);f.cmd(f.op,'observe',{attemptId:one.attemptId,lines:[{productId:f.p.id,actual:6}]});
  assert.equal(mine(third)[0].recorded_quantity,1);assert.equal(mine(third)[0].remaining_quantity,1);
  const two=f.begin(run,f.admin,f.cells[1]);f.cmd(f.admin,'observe',{attemptId:two.attemptId,lines:[{productId:f.p.id,actual:7}]});
  for(const actor of [f.op,f.admin,third]){assert.equal(mine(actor).length,0);assert.equal(f.work.snapshot(actor,{view:'mine',workState:'all'}).tasks.some(t=>t.stocktake_id===run),false);}
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_attempts WHERE counter_id=?').get(third.id).n,0);
  assert.equal(f.count.snapshot(third).runs.find(r=>r.id===run).status,'completed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_observations').get().n,2);
 }finally{f.db.close();}
});
test('paused stocktake assignments offer Resume, preserve counted locations and restore the display on joining',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create({counterIds:[f.op.id]}),sessionId=randomUUID();f.cmd(f.op,'join',{runId:run,sessionId});const a=f.begin(run);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:6}]});
  f.cmd(f.op,'leave',{runId:run,sessionId});const before=f.count.snapshot(f.op).runs.find(r=>r.id===run);assert.ok(before.paused_at);assert.equal(before.display_enabled,0);
  const next=f.work.snapshot(f.op,{view:'mine'}).myWorkNextTask;assert.equal(next.stocktake_id,run);assert.equal(next.action_label,'Resume');assert.equal(next.work_status,'Paused');assert.equal(next.recorded_quantity,1);
  const writes=f.writes.length;f.work.snapshot(f.op,{view:'mine'});assert.equal(f.writes.length,writes,'viewing My Work must not resume LEDs');
  f.cmd(f.op,'join',{runId:run,sessionId:randomUUID()});const resumed=f.count.snapshot(f.op).runs.find(r=>r.id===run);assert.equal(resumed.paused_at,null);assert.equal(resumed.completed,1);assert.equal(resumed.display_enabled,1);
  assert.equal(f.writes.filter(w=>w.cell===f.cells[0].id).at(-1).color,'blue');assert.equal(f.work.snapshot(f.op,{view:'mine'}).tasks[0].work_status,'In progress');
 }finally{f.db.close();}
});
test('combined work filters and pagination retain stocktake scope without colliding with Pick task IDs',()=>{
 const f=fixture();try{f.stock(f.cells[0],8);const pick=f.wcmd(f.admin,'create',{direction:'pick',productId:f.p.id,quantity:1,assigneeId:f.op.id});const runs=Array.from({length:22},()=>f.create({counterIds:[f.op.id],cellIds:[f.cells[1].id]}));
  const page=query=>f.work.snapshot(f.op,{view:'mine',pageSize:20,...query}),first=page({sort:'task',order:'asc'}),second=page({sort:'task',order:'asc',page:2});
  assert.equal(first.taskPage.total,23);assert.equal(first.tasks.length,20);assert.equal(second.tasks.length,3);assert.equal(new Set([...first.tasks,...second.tasks].map(t=>t.id)).size,23);
  assert.ok(first.tasks.some(t=>t.id===pick.taskId&&t.type==='pick'));assert.ok(first.tasks.some(t=>t.id===-runs[0]&&t.work_kind==='stocktake'));
  assert.deepEqual(page({taskSearch:runs[0]+' stocktake',taskSearchExact:'1'}).tasks.map(t=>t.stocktake_id),[runs[0]]);
  assert.equal(page({productSearch:'Warehouse stock check',productSearchExact:'1'}).taskPage.total,22);assert.equal(page({reviewOnly:'1'}).taskPage.total,0);
  assert.equal(f.work.snapshot(f.op,{view:'history'}).tasks.some(t=>t.work_kind==='stocktake'),false,'Pick/Put history commands remain separate');
  f.cmd(f.admin,'assignAreas',{runId:runs[0],assignments:[{mode:'selected',cellIds:[f.cells[1].id],counterIds:[f.admin.id]}]});assert.equal(page({taskSearch:runs[0]+' stocktake',taskSearchExact:'1'}).taskPage.total,0);
  assert.throws(()=>f.cmd(f.op,'join',{runId:runs[0],sessionId:randomUUID()}),/another counter|No remaining/);
 }finally{f.db.close();}
});
test('unidentified goods keep their exception visible while known quantities update, and a fresh count completes coverage',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create({cellIds:[f.cells[0].id]}),a=f.begin(run);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:4}],unknown:['Unlabelled bag']});assert.equal(f.actual(f.cells[0]),4);assert.equal(f.item(run).state,'review');
  const condition=f.count.snapshot(f.admin).conditions[0];f.cmd(f.admin,'condition',{conditionId:condition.id,evidence:'Items identified in person',confirmed:true});const b=f.begin(run);f.cmd(f.op,'observe',{attemptId:b.attemptId,lines:[{productId:f.p.id,actual:4}]});assert.equal(f.count.snapshot(f.admin).runs.find(r=>r.id===run).status,'completed');
 }finally{f.db.close();}
});
test('a waiting count allows the already active Pick to record and finish before counting',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],6);const made=f.wcmd(f.op,'create',{direction:'pick',productId:f.p.id,quantity:2,preferredCellId:f.cells[0].id}),run=f.create({cellIds:[f.cells[0].id]}),row=f.item(run);
  assert.equal(f.cmd(f.admin,'locate',{itemId:row.id,generation:row.generation}).status,'busy');
  let line=f.work.task(f.op,made.taskId).lines[0];f.wcmd(f.op,'acquire',{lineId:line.id,revision:line.revision,method:'arrival',deviceId:'counter-test'});
  line=f.work.task(f.op,made.taskId).lines[0];f.wcmd(f.op,'report',{lineId:line.id,revision:line.revision,quantity:2,cellId:line.cell_id,unit:line.unit_of_measure,method:'manual',manualReason:'No camera',deviceId:'counter-test'});
  assert.equal(f.actual(f.cells[0]),4);assert.ok(f.begin(run,f.admin).attemptId);assert.equal(f.writes.at(-1).color,'orange');
 }finally{f.db.close();}
});
test('a failed background LED send remains pending and retries with the current quantity',async()=>{
 const f=fixture({deferStocktakeDisplays:true});try{
  f.stock(f.cells[0],6);const send=f.hardware.showCellQuantity;f.hardware.showCellQuantity=()=>({ok:false,error:'Controller offline'});
  f.create({cellIds:[f.cells[0].id]});await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(f.db.prepare('SELECT delivered FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).delivered,0);
  f.hardware.showCellQuantity=send;f.stock(f.cells[0],7);f.work.flushGuidance();await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(f.db.prepare('SELECT delivered FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).delivered,1);assert.equal(f.writes.at(-1).value,7);
 }finally{f.work.dispose();f.db.close();}
});
test('migration enables immediate future saves without posting a historical difference',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],6);const run=f.create({cellIds:[f.cells[0].id]});f.db.prepare('UPDATE stocktake_runs SET immediate_counts=0 WHERE id=?').run(run);
  const a=f.begin(run),old=f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:4}],reason:'Maybe an earlier pick'});assert.equal(old.status,'review');assert.equal(f.actual(f.cells[0]),6);
  const transactions=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n;migrateStocktaking(f.db);
  assert.equal(f.actual(f.cells[0]),6);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,transactions);assert.equal(f.db.prepare('SELECT status FROM stocktake_observations WHERE id=?').get(old.observationId).status,'review');assert.equal(f.db.prepare('SELECT immediate_counts FROM stocktake_runs WHERE id=?').get(run).immediate_counts,1);
 }finally{f.db.close();}
});

test('opening a newly assigned stocktake keeps LEDs off until the counter starts',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],6);const run=f.create({autoStart:false});const row=f.item(run);
  assert.equal(f.writes.length,0);assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===run).started_at,null);
  f.work.snapshot(f.op,{view:'mine'});assert.equal(f.writes.length,0);
  assert.throws(()=>f.cmd(f.op,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:f.cells[0].logical_code}),/Start or resume/);
  f.cmd(f.op,'join',{runId:run,sessionId:randomUUID()});assert.ok(f.writes.some(w=>w.color==='yellow'));
 }finally{f.db.close();}
});
test('manager stop fences all sessions and stale counts; restart keeps progress and reassigns only unfinished cells',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],6);f.stock(f.cells[1],7);const run=f.create({autoStart:false});const first=randomUUID(),second=randomUUID();
  f.cmd(f.op,'join',{runId:run,sessionId:first});f.cmd(f.admin,'join',{runId:run,sessionId:second});
  let row=f.item(run);const a=f.cmd(f.op,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:f.cells[0].logical_code,sessionId:first});
  f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:5}]});
  row=f.item(run,f.cells[1]);const pending=f.cmd(f.admin,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:f.cells[1].logical_code,sessionId:second});
  const revision=f.count.snapshot(f.admin).runs.find(r=>r.id===run).revision;
  assert.throws(()=>f.cmd(f.op,'stop',{runId:run,revision,confirmed:true}),/not permitted/);
  assert.throws(()=>f.cmd(f.admin,'stop',{runId:run,revision,confirmed:false}),/Confirm/);
  const input={requestId:randomUUID(),runId:run,revision,confirmed:true};f.count.command(f.admin,'stop',input);assert.equal(f.count.command(f.admin,'stop',input).replayed,true);
  for(const actor of [f.op,f.admin])assert.ok(!f.work.snapshot(actor,{view:'mine'}).tasks.some(t=>t.stocktake_id===run));
  const stopped=f.count.snapshot(f.admin).runs.find(r=>r.id===run);assert.equal(stopped.status,'stopped');assert.equal(stopped.completed,1);assert.equal(stopped.display_enabled,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM stocktake_sessions WHERE run_id=? AND state='active'").get(run).n,0);
  assert.throws(()=>f.count.heartbeat(f.admin,{runId:run,sessionId:second}),/paused/);
  const late=f.cmd(f.admin,'observe',{attemptId:pending.attemptId,lines:[{productId:f.p.id,actual:3}]});assert.equal(late.status,'recheck');assert.equal(f.actual(f.cells[1]),7);assert.equal(f.count.snapshot(f.admin).runs.find(r=>r.id===run).status,'stopped');
  assert.throws(()=>f.cmd(f.op,'restart',{runId:run,revision:stopped.revision,dueDate:'2026-11-01',counterIds:[f.op.id]}),/not permitted/);
  assert.throws(()=>f.cmd(f.admin,'restart',{runId:run,revision:stopped.revision,dueDate:'',counterIds:[f.op.id]}),/valid date/);
  f.cmd(f.admin,'restart',{runId:run,revision:stopped.revision,dueDate:'2026-11-01',counterIds:[f.op.id]});
  const restarted=f.count.snapshot(f.op).runs.find(r=>r.id===run);assert.equal(restarted.completed,1);assert.ok(restarted.paused_at);assert.equal(restarted.display_enabled,0);assert.equal(restarted.due_date,'2026-11-01');assert.deepEqual(restarted.items.find(i=>i.cell_id===f.cells[1].id).counterIds,[f.op.id]);
  assert.ok(f.work.snapshot(f.op,{view:'mine'}).tasks.some(t=>t.stocktake_id===run));
  f.cmd(f.op,'join',{runId:run,sessionId:randomUUID()});assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===run).display_enabled,1);assert.equal(f.actual(f.cells[0]),5);
 }finally{f.db.close();}
});
test('summary covers the stocktake scope and warehouse totals while action ownership stays restricted',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],6);f.stock(f.cells[1],4);const run=f.create({autoStart:false});
  f.cmd(f.admin,'assignAreas',{runId:run,assignments:[{mode:'selected',cellIds:[f.cells[0].id],counterIds:[f.op.id]},{mode:'selected',cellIds:[f.cells[1].id],counterIds:[f.admin.id]}]});
  const snapshot=f.count.snapshot(f.op),r=snapshot.runs.find(r=>r.id===run);
  assert.equal(r.items.length,1);assert.equal(r.summary.cells.length,2);assert.equal(r.summary.products.find(p=>p.id===f.p.id).quantity,10);assert.equal(snapshot.warehouseSummary.inStock,1);
  assert.equal(snapshot.warehouseSummary.locations,f.db.prepare('SELECT COUNT(*) n FROM cells WHERE active=1').get().n);
  assert.equal(f.writes.length,0);
 }finally{f.db.close();}
});
test('explicit recount uses a fresh baseline without overwriting earlier completed counts',()=>{
 const f=fixture();try{
  f.stock(f.cells[0],6);const run=f.create({cellIds:[f.cells[0].id]}),a=f.begin(run);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:5}]});
  assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===run).status,'completed');f.stock(f.cells[0],8);
  let item=f.item(run);f.cmd(f.op,'recountCell',{itemId:item.id,generation:item.generation});
  const reopened=f.count.snapshot(f.op).runs.find(r=>r.id===run);assert.ok(reopened.paused_at);assert.equal(reopened.completed,0);
  f.cmd(f.op,'join',{runId:run,sessionId:randomUUID()});const next=f.begin(run);f.cmd(f.op,'observe',{attemptId:next.attemptId,lines:[{productId:f.p.id,actual:7}]});
  assert.equal(f.actual(f.cells[0]),7);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_observations WHERE item_id=?').get(item.id).n,2);assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===run).status,'completed');
 }finally{f.db.close();}
});
