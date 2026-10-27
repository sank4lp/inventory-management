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
import {getRecommendedActions} from '../src/services/inventory.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'lightguide-plan-')));
 const db=createDatabase({hashPassword,allowDevAuthSeeds:true,allowDemoInventorySeed:true}),w=createOperationsService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get(),op=db.prepare("SELECT * FROM users WHERE role='operator' LIMIT 1").get();
 const [p,b]=db.prepare('SELECT * FROM products ORDER BY id LIMIT 2').all(),cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 4').all();
 db.exec('DELETE FROM inventory_balances');db.prepare('UPDATE products SET items_per_cell=100 WHERE id=?').run(p.id);
 const cmd=(a,action,input)=>w.command(a,action,{requestId:randomUUID(),...input});
 const stock=(pid,cid,q)=>db.prepare('INSERT OR REPLACE INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0)').run(pid,cid,q);
 const make=(n,extra={},actor=op)=>cmd(actor,'create',{direction:'pick',productId:p.id,quantity:n,...extra});
 const check=id=>{const t=w.task(op,id);for(const l of t.lines)cmd(op,'askReview',{lineId:l.id,reason:'Phone failed; actual unknown'});};
 const quantity=(cid)=>db.prepare('SELECT available_quantity n FROM inventory_balances WHERE product_id=? AND cell_id=?').get(p.id,cid)?.n||0;
 return {db,w,admin,op,p,b,cells,cmd,stock,make,check,quantity};
}
test('review-only claims yield to a new pick; active claims never do; priority tracks pressure',()=>{
 const {db,w,admin,op,p,cells,cmd,stock,make,check,quantity}=fixture();stock(p.id,cells[0].id,40);
 const one=make(10),two=make(10),three=make(11);
 assert.throws(()=>make(11),/active reservations/);
 check(one.taskId);assert.equal(w.task(admin,one.taskId).work_priority,'medium');
 check(two.taskId);check(three.taskId);
 const next=make(11,{},admin),t=w.task(admin,next.taskId),l=t.lines[0];
 for(const old of [one,two,three])assert.equal(w.task(admin,old.taskId).work_priority,'high');
 assert.equal(w.task(admin,next.taskId).work_priority,'low');
 const snap=w.snapshot(admin,{view:'mine',priority:'high'});assert.deepEqual(new Set(snap.tasks.map(t=>t.id)),new Set([one.taskId,two.taskId,three.taskId]));
 assert.equal(w.snapshot(admin,{view:'mine'}).tasks[0].work_priority,'high');
 assert.notEqual(t.lines[0].guidance.state,'blocked');
 const arrived=cmd(admin,'acquire',{lineId:l.id,revision:l.revision,deviceId:'test',location:l.logical_code});assert.equal(arrived.status,'ready');
 const current=w.line(l.id);assert.equal(cmd(admin,'report',{lineId:l.id,revision:current.revision,quantity:11,cellId:l.cell_id,unit:l.unit_of_measure,deviceId:'test'}).status,'recorded');assert.equal(quantity(cells[0].id),29);
 assert.equal(db.prepare("SELECT SUM(quantity) n FROM work_reservations WHERE state='held'").get().n,31);
 // A second executing claim still protects the remaining book stock.
 const active=make(29);assert.throws(()=>make(1),/active reservations/);assert.equal(w.task(op,active.taskId).work_priority,'low');db.close();
});
test('exactly half reserved stays low',()=>{
 const {db,w,admin,op,p,cells,cmd,stock,make}=fixture();stock(p.id,cells[0].id,10);stock(p.id,cells[1].id,10);
 const a=make(10),b=make(5);let l=w.task(op,a.taskId).lines[0];cmd(op,'askReview',{lineId:l.id,reason:'Verify'});
 assert.equal(w.task(admin,a.taskId).work_priority,'medium');
 db.prepare("UPDATE work_reservations SET state='released' WHERE line_id IN (SELECT id FROM task_lines WHERE task_id=?)").run(b.taskId);
 assert.equal(w.task(admin,a.taskId).work_priority,'low');
 db.close();
});
test('a reviewed line never releases the claim of an active sibling in the same task',()=>{
 const {db,w,op,p,cells,cmd,stock,make}=fixture();stock(p.id,cells[0].id,10);stock(p.id,cells[1].id,10);
 const task=make(15),[reviewed,active]=w.task(op,task.taskId).lines;assert.ok(active);
 cmd(op,'askReview',{lineId:reviewed.id,reason:'Check this location only'});
 assert.equal(w.productStock(op,{productId:p.id}).availableToPick,15);
 const next=make(15),lines=w.task(op,next.taskId).lines;
 assert.equal(lines.find(l=>l.cell_id===active.cell_id).planned_quantity,5);
 assert.throws(()=>make(1),/active reservations/);db.close();
});
test('above-book picks require fresh explicit cell counts; count and plan are atomic and replay safe',()=>{
 const {db,w,admin,op,p,cells,stock,make,quantity}=fixture();stock(p.id,cells[0].id,5);
 assert.throws(()=>make(8),e=>e.planning.code==='pick_count');assert.equal(quantity(cells[0].id),5);
 const data=w.planningOptions(op,{productId:p.id,direction:'pick'}),cell=data.cells.find(c=>c.id===cells[0].id);
 const input={requestId:randomUUID(),direction:'pick',productId:p.id,quantity:8,recovery:{mode:'count',confirmed:true,counts:[{cellId:cell.id,quantity:10,token:cell.token}]}};
 const result=w.command(op,'create',input);assert.equal(quantity(cell.id),10);assert.ok(result.urgentRunId);
 assert.equal(w.command(op,'create',input).replayed,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE origin_ref LIKE 'pick-count:%'").get().n,1);
 assert.equal(db.prepare('SELECT status FROM stocktake_runs WHERE id=?').get(result.urgentRunId).status,'pending');
 const counter=createStocktakingService({db,operationsService:w});assert.ok(counter.snapshot(admin).runs.some(r=>r.id===result.urgentRunId&&r.actionable));
 assert.throws(()=>w.command(op,'create',{...input,requestId:randomUUID(),quantity:12}),/changed/);
 const next=w.planningOptions(op,{productId:p.id,direction:'pick'}).cells.find(c=>c.id===cell.id),before=db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n;
 assert.throws(()=>make(20,{recovery:{mode:'count',confirmed:true,counts:[{cellId:cell.id,quantity:11,token:next.token}]}}),/Not enough/);
 assert.equal(quantity(cell.id),10);assert.equal(db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,before);db.close();
});
test('mixed put uses fractional space and includes pending puts; no automatic mixing',()=>{
 const {db,w,admin,op,p,b,cells,cmd,stock}=fixture();db.prepare('UPDATE products SET items_per_cell=2 WHERE id=?').run(p.id);db.prepare('UPDATE products SET items_per_cell=5 WHERE id=?').run(b.id);
 stock(b.id,cells[0].id,2);db.prepare('UPDATE cells SET active=0 WHERE id!=?').run(cells[0].id);
 const create=(n,recovery)=>cmd(op,'create',{direction:'put',productId:p.id,quantity:n,recovery});
 assert.throws(()=>create(1),e=>e.planning.code==='put_capacity');
 assert.equal(w.planningOptions(op,{direction:'put',productId:p.id}).cells[0].space,1.2);
 const t=create(1,{mode:'mixed',cellId:cells[0].id,confirmed:true});assert.throws(()=>create(1,{mode:'mixed',cellId:cells[0].id,confirmed:true}),/Not enough/);
 const l=w.task(op,t.taskId).lines[0];assert.notEqual(l.guidance.state,'blocked');cmd(op,'acquire',{lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});
 assert.equal(cmd(op,'report',{lineId:l.id,revision:w.line(l.id).revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity:1,deviceId:'test'}).status,'recorded');
 assert.equal(db.prepare('SELECT available_quantity n FROM inventory_balances WHERE cell_id=? AND product_id=?').get(l.cell_id,p.id).n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM work_discrepancies').get().n,0);
 assert.ok(getRecommendedActions(db).some(a=>a.type==='mixed_cell'&&a.cellId===l.cell_id));
 // A correction still uses shared fractional space, not raw quantities.
 assert.equal(cmd(op,'correct',{lineId:l.id,revision:w.line(l.id).revision,quantity:1.1,verification:'Confirmed a fractional unit'}).status,'recorded');
 assert.equal(cmd(op,'correct',{lineId:l.id,revision:w.line(l.id).revision,quantity:1.3,verification:'Would exceed shared space'}).status,'review');
 db.close();
});
test('mixed-cell capacity rejects a half-cell item when only forty percent remains',()=>{
 const {db,w,op,p,b,cells,cmd,stock}=fixture();db.prepare('UPDATE products SET items_per_cell=2 WHERE id=?').run(p.id);db.prepare('UPDATE products SET items_per_cell=5 WHERE id=?').run(b.id);stock(b.id,cells[0].id,3);db.prepare('UPDATE cells SET active=0 WHERE id!=?').run(cells[0].id);
 const input={direction:'put',productId:p.id,quantity:1,recovery:{mode:'mixed',cellId:cells[0].id,confirmed:true}};
 assert.equal(w.planningOptions(op,input).cells[0].space,0.8);assert.throws(()=>cmd(op,'create',input),/Not enough put capacity/);
 const result=cmd(op,'create',{...input,quantity:0.8}),l=w.task(op,result.taskId).lines[0];
 assert.throws(()=>cmd(op,'replan',{lineId:l.id,revision:l.revision,cellId:l.cell_id,quantity:0.800001}),/capacity/);
 assert.equal(cmd(op,'replan',{lineId:l.id,revision:l.revision,cellId:l.cell_id,quantity:0.8}).status,'recorded');db.close();
});
test('pre-pick counts reject concurrent work, unit changes and counts below protected claims',()=>{
 const {db,w,op,p,cells,cmd,stock,make,quantity}=fixture();stock(p.id,cells[0].id,5);const t=make(3),l=w.task(op,t.taskId).lines[0];
 const recovery=q=>({mode:'count',confirmed:true,counts:[{cellId:l.cell_id,quantity:q,token:w.planningOptions(op,{direction:'pick',productId:p.id}).cells.find(c=>c.id===l.cell_id).token}]});
 assert.throws(()=>make(8,{recovery:recovery(2)}),/cannot cover active picks/);
 const stale=recovery(12);cmd(op,'acquire',{lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});
 assert.throws(()=>make(8,{recovery:stale}),/someone is working/);assert.equal(quantity(l.cell_id),5);
 const oldUnit={...recovery(12),unit:'obsolete-unit'};assert.throws(()=>make(8,{recovery:oldUnit}),/unit changed/);db.close();
});
test('capacity recovery requires the capacity permission and commits only with a valid put',()=>{
 const {db,w,admin,op,p,cells,cmd,stock}=fixture();db.prepare('UPDATE products SET items_per_cell=2 WHERE id=?').run(p.id);stock(p.id,cells[0].id,2);db.prepare('UPDATE cells SET active=0 WHERE id!=?').run(cells[0].id);
 const input={direction:'put',productId:p.id,quantity:1,recovery:{mode:'capacity',confirmed:true,previousCapacity:2,itemsPerCell:3}};
 assert.throws(()=>cmd(op,'create',input),/permitted|permission|access/i);assert.equal(db.prepare('SELECT items_per_cell n FROM products WHERE id=?').get(p.id).n,2);
 assert.throws(()=>cmd(admin,'create',{...input,quantity:3}),/Not enough/);assert.equal(db.prepare('SELECT items_per_cell n FROM products WHERE id=?').get(p.id).n,2);
 assert.equal(cmd(admin,'create',input).status,'reserved');assert.equal(db.prepare('SELECT items_per_cell n FROM products WHERE id=?').get(p.id).n,3);db.close();
});

for(const direction of ['pick','put'])test(`${direction}: a new task takes over unstarted claims, marks the displaced task high-priority and retains its evidence`,()=>{
 const f=fixture();try{
  const c=f.cells[0];f.db.prepare('UPDATE cells SET active=0 WHERE id!=?').run(c.id);f.db.prepare('UPDATE products SET items_per_cell=10 WHERE id=?').run(f.p.id);
  f.stock(f.p.id,c.id,direction==='pick'?10:3);
  const old=f.cmd(f.admin,'assign',{direction,productId:f.p.id,quantity:direction==='pick'?8:5,assigneeId:f.op.id,dueDuration:8,dueUnit:'hours'});
  const request={requestId:randomUUID(),direction,productId:f.p.id,quantity:direction==='pick'?5:7};
  const next=f.w.command(f.admin,'create',request),displaced=f.w.task(f.admin,old.taskId),task=f.w.task(f.admin,next.taskId);
  assert.equal(displaced.attention,1);assert.equal(displaced.work_priority,'high');assert.equal(displaced.outcome,'needs_review');
  assert.equal(displaced.recorded_quantity,0);assert.equal(displaced.lines[0].planned_quantity,direction==='pick'?8:5);
  assert.match(displaced.lines[0].reports[0].reason,new RegExp('Task #'+next.taskId));
  assert.equal(displaced.lines[0].reports[0].quantity_known,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);
  assert.throws(()=>f.cmd(f.op,'start',{taskId:displaced.id,generation:displaced.assignment_generation}),/taken over/);
  assert.equal(f.w.snapshot(f.admin,{view:'mine',reviewOnly:'1'}).tasks[0].work_priority,'high');
  const rec=getRecommendedActions(f.db).find(r=>r.type==='task_reservation_conflict'&&r.taskId===old.taskId);
  assert.equal(rec.taskHref,'/tasks/'+old.taskId);assert.match(rec.actionSummary,new RegExp('Task #'+next.taskId));
  assert.equal(f.w.command(f.admin,'create',request).replayed,true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_events WHERE event_type='reservation_displaced'").get().n,1);
  assert.throws(()=>f.cmd(f.op,'create',{direction,productId:f.p.id,quantity:6}),/Not enough/);
  let l=task.lines[0];f.cmd(f.admin,'acquire',{lineId:l.id,revision:l.revision,method:'arrival',deviceId:'takeover'});l=f.w.line(l.id);
  assert.equal(f.cmd(f.admin,'report',{lineId:l.id,revision:l.revision,cellId:l.cell_id,quantity:task.requested_quantity,unit:l.unit_of_measure,deviceId:'takeover'}).status,'recorded');
  assert.equal(f.quantity(c.id),direction==='pick'?5:10);
  assert.equal(f.w.task(f.admin,old.taskId).work_priority,'high');
 }finally{f.db.close();}
});

test('a Put awaiting review yields space; active sibling work remains protected',()=>{
 const f=fixture();try{
  const [a,b]=f.cells;f.db.prepare('UPDATE cells SET active=0 WHERE id NOT IN (?,?)').run(a.id,b.id);f.db.prepare('UPDATE products SET items_per_cell=10 WHERE id=?').run(f.p.id);
  const old=f.cmd(f.op,'create',{direction:'put',productId:f.p.id,quantity:15}),lines=f.w.task(f.op,old.taskId).lines;
  f.cmd(f.op,'askReview',{lineId:lines[0].id,reason:'Phone died'});
  const next=f.cmd(f.admin,'create',{direction:'put',productId:f.p.id,quantity:15}),t=f.w.task(f.admin,next.taskId);
  assert.equal(t.lines.find(l=>l.cell_id===b.id).planned_quantity,5);
  assert.equal(f.w.task(f.admin,old.taskId).work_priority,'high');
  assert.throws(()=>f.cmd(f.admin,'create',{direction:'put',productId:f.p.id,quantity:1}),/Not enough/);
 }finally{f.db.close();}
});

test('a different product unstarted Put cannot reserve an otherwise empty location away from new work',()=>{
 const f=fixture();try{
  f.db.prepare('UPDATE cells SET active=0 WHERE id!=?').run(f.cells[0].id);
  const old=f.cmd(f.admin,'assign',{direction:'put',productId:f.b.id,quantity:1,assigneeId:f.op.id,dueDuration:8,dueUnit:'hours'});
  const next=f.cmd(f.op,'create',{direction:'put',productId:f.p.id,quantity:1});
  assert.equal(f.w.task(f.admin,old.taskId).work_priority,'high');
  assert.equal(f.w.task(f.op,next.taskId).attention,0);
 }finally{f.db.close();}
});

for(const direction of ['pick','put'])test(`${direction}: an unstarted task is safely replanned instead of sent to review when other locations still fit it`,()=>{
 const f=fixture();try{
  const [a,b]=f.cells;f.db.prepare('UPDATE cells SET active=0 WHERE id NOT IN (?,?)').run(a.id,b.id);f.db.prepare('UPDATE products SET items_per_cell=10 WHERE id=?').run(f.p.id);
  if(direction==='pick'){f.stock(f.p.id,a.id,10);f.stock(f.p.id,b.id,10);}
  const old=f.cmd(f.admin,'assign',{direction,productId:f.p.id,quantity:8,assigneeId:f.op.id,dueDuration:8,dueUnit:'hours'});
  const original=f.w.task(f.admin,old.taskId),oldLine=original.lines[0];
  const newer=f.cmd(f.admin,'create',{direction,productId:f.p.id,quantity:5});
  const replanned=f.w.task(f.admin,old.taskId);
  assert.equal(replanned.attention,0);assert.equal(replanned.assignee_id,f.op.id);assert.equal(replanned.due_at,original.due_at);assert.equal(replanned.requested_quantity,8);
  assert.equal(replanned.lines.find(l=>l.id===oldLine.id).execution_state,'superseded');
  assert.equal(replanned.lines.filter(l=>l.execution_state==='ready').reduce((n,l)=>n+l.planned_quantity,0),8);
  assert.ok(replanned.lines.some(l=>l.execution_state==='ready'&&l.cell_id===b.id));
  assert.ok(f.w.taskHistory(f.admin,{taskId:old.taskId}).entries.some(e=>e.step==='Locations replanned'));
  assert.equal(getRecommendedActions(f.db).some(r=>r.taskId===old.taskId),false);
  f.cmd(f.op,'start',{taskId:old.taskId,generation:replanned.assignment_generation});
  assert.equal(f.w.task(f.admin,newer.taskId).attention,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);
 }finally{f.db.close();}
});
