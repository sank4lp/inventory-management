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
 process.chdir(mkdtempSync(join(tmpdir(),'stocktake-shared-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true});db.exec('DELETE FROM inventory_balances');
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),p=db.prepare('SELECT * FROM products LIMIT 1').get(),cells=db.prepare('SELECT * FROM cells WHERE active=1 LIMIT 3').all(),writes=[];
 db.prepare('UPDATE products SET items_per_cell=20 WHERE id=?').run(p.id);
 const hardware={showCellQuantity:(cell,value,color)=>{writes.push({cell:cell.id,value,color});return{ok:true};},clearGuidance:(_,targets)=>{writes.push(...targets.map(c=>({cell:c.id,clear:true})));return{ok:true};},activateGuidance:(task,lines)=>{writes.push(...lines.map(l=>({cell:l.cell_id,value:l.planned_quantity,color:task.type==='pick'?'green':'red'})));return{ok:true};}};
 const work=createOperationsService({db,hardwareService:hardware,deferStocktakeDisplays}),count=createStocktakingService({db,operationsService:work});
 const cmd=(actor,action,input={})=>count.command(actor,action,{requestId:randomUUID(),...input}),wcmd=(actor,action,input)=>work.command(actor,action,{requestId:randomUUID(),...input});
 const stock=(cell,q,product=p)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0) ON CONFLICT(product_id,cell_id) DO UPDATE SET available_quantity=excluded.available_quantity').run(product.id,cell.id,q);
 const create=(extra={})=>cmd(admin,'create',{mode:'selected',cellIds:cells.slice(0,2).map(c=>c.id),counterIds:[admin.id,op.id],...extra}).runId;
 const item=(runId,cell=cells[0],actor=admin)=>count.snapshot(actor).runs.find(r=>r.id===runId).items.find(i=>i.cell_id===cell.id);
 const begin=(runId,actor=op,cell=cells[0])=>{const row=item(runId,cell,actor);return cmd(actor,'begin',{itemId:row.id,generation:row.generation,method:'manual',location:cell.logical_code});};
 const actual=(cell)=>db.prepare('SELECT available_quantity q FROM inventory_balances WHERE product_id=? AND cell_id=?').get(p.id,cell.id)?.q||0;
 return {db,admin,op,p,cells,writes,hardware,work,count,cmd,wcmd,stock,create,item,begin,actual};
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
test('a corrected count updates immediately, is audited once, stays blue, and ends explicitly',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create({cellIds:[f.cells[0].id]}),attempt=f.begin(run);const input={requestId:randomUUID(),attemptId:attempt.attemptId,lines:[{productId:f.p.id,actual:4}]};const result=f.count.command(f.op,'observe',input);assert.equal(result.status,'approved');assert.equal(f.actual(f.cells[0]),4);assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===run).status,'completed');
  assert.equal(f.writes.at(-1).color,'blue');assert.equal(f.writes.at(-1).value,4);const moves=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n;f.count.command(f.op,'observe',input);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,moves);
  const audit=f.db.prepare('SELECT * FROM stocktake_observations WHERE id=?').get(result.observationId);assert.equal(audit.counter_id,f.op.id);assert.equal(audit.reviewer_id,f.op.id);assert.equal(JSON.parse(audit.lines_json)[0].recorded,6);
  f.cmd(f.admin,'display',{runId:run,enabled:false});assert.ok(f.writes.at(-1).clear);assert.equal(f.count.snapshot(f.admin).runs.find(r=>r.id===run).status,'completed');
 }finally{f.db.close();}
});
test('pending and completed lights yield to Pick, while an orange cell retains counting ownership',()=>{
 const f=fixture();try{f.stock(f.cells[0],10);const run=f.create({cellIds:[f.cells[0].id]}),attempt=f.begin(run);const task=f.wcmd(f.admin,'create',{direction:'pick',productId:f.p.id,quantity:2,preferredCellId:f.cells[0].id});assert.equal(f.work.task(f.admin,task.taskId).lines[0].guidance.state,'waiting');
  const result=f.cmd(f.op,'observe',{attemptId:attempt.attemptId,lines:[{productId:f.p.id,actual:10}]});assert.equal(result.status,'matched');assert.equal(f.work.task(f.admin,task.taskId).lines[0].guidance.state,'sent');assert.equal(f.writes.at(-1).color,'green');
  const line=f.work.task(f.admin,task.taskId).lines[0];f.wcmd(f.admin,'cancel',{lineId:line.id,revision:line.revision});assert.equal(f.writes.at(-1).color,'blue');assert.equal(f.writes.at(-1).value,10);
 }finally{f.db.close();}
});
test('an active Pick keeps its light until finished, then a waiting count takes over',()=>{
 const f=fixture();try{f.stock(f.cells[0],10);const task=f.wcmd(f.op,'create',{direction:'pick',productId:f.p.id,quantity:2,preferredCellId:f.cells[0].id}),run=f.create({cellIds:[f.cells[0].id]});assert.equal(f.writes.at(-1).color,'green');assert.throws(()=>f.begin(run,f.admin),/Waiting for/);const line=f.work.task(f.op,task.taskId).lines[0];f.wcmd(f.op,'cancel',{lineId:line.id,revision:line.revision});f.begin(run,f.admin);assert.equal(f.writes.at(-1).color,'orange');
 }finally{f.db.close();}
});
test('a stale count leaves inventory untouched and can be paused and recounted',()=>{
 const f=fixture();try{f.stock(f.cells[0],6);const run=f.create({cellIds:[f.cells[0].id]}),attempt=f.begin(run);f.stock(f.cells[0],7);assert.throws(()=>f.cmd(f.op,'observe',{attemptId:attempt.attemptId,lines:[{productId:f.p.id,actual:5}]}),/Pause this location/);assert.equal(f.actual(f.cells[0]),7);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_observations').get().n,0);
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
  f.stock(f.cells[0],6);const first=f.create({cellIds:[f.cells[0].id]}),a=f.begin(first);f.cmd(f.op,'observe',{attemptId:a.attemptId,lines:[{productId:f.p.id,actual:6}]});
  const second=f.create({cellIds:[f.cells[0].id]}),n=f.writes.length;f.cmd(f.admin,'display',{runId:first,enabled:false});assert.equal(f.writes.length,n);assert.equal(f.writes.at(-1).color,'yellow');
  const b=f.begin(second);f.cmd(f.op,'observe',{attemptId:b.attemptId,lines:[{productId:f.p.id,actual:6}]});assert.equal(f.writes.at(-1).color,'blue');f.cmd(f.admin,'display',{runId:second,enabled:false});assert.ok(f.writes.at(-1).clear);
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
