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
import {createAccessService} from '../src/modules/access/service.js';
function fixture(direction='pick'){
 process.chdir(mkdtempSync(join(tmpdir(),'task-closure-')));const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 db.prepare("INSERT INTO users(name,username,password_hash,role,status,created_at) VALUES('Other','other',?,'operator','active',?)").run(hashPassword('test'),new Date().toISOString());const other=db.prepare("SELECT * FROM users WHERE username='other'").get();
 const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 3').all();db.exec('DELETE FROM inventory_balances; UPDATE products SET items_per_cell=30 WHERE id=1;');
 for(const [i,c] of cells.entries())db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(1,?,?,0)').run(c.id,direction==='pick'?(i===0?4:20):(i===0?26:0));
 const cmd=(u,a,i={})=>work.command(u,a,{requestId:randomUUID(),...work.identity(),actorId:u.id,deviceId:'phone',...i}),get=id=>work.task(admin,id),fields=t=>({taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token,closureToken:t.closure_token});
 const t=get(cmd(op,'create',{direction,productId:1,quantity:10,preferredCellId:cells[0].id}).taskId);
 const record=(quantity=4)=>{let l=get(t.id).lines[0];cmd(op,'acquire',{lineId:l.id,revision:l.revision,method:'arrival'});l=get(t.id).lines[0];return cmd(op,'report',{lineId:l.id,revision:l.revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity,assignmentGeneration:l.current_generation});};
 const balance=id=>db.prepare('SELECT available_quantity FROM inventory_balances WHERE product_id=1 AND cell_id=?').get(id)?.available_quantity||0;
 const input=(more={})=>({...fields(get(t.id)),currentStatus:'yes',...more});
 const held=()=>db.prepare("SELECT SUM(r.quantity) q FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.state='held'").get(t.id).q||0;
 return {db,work,admin,op,other,cells,cmd,get,fields,t,record,balance,input,held};
}
function finalQuantityFixture(direction='pick'){
 process.chdir(mkdtempSync(join(tmpdir(),'task-final-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 2').all();
 db.exec('DELETE FROM inventory_balances; UPDATE products SET items_per_cell=20 WHERE id=1;');
 if(direction==='pick')for(const cell of cells)db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(1,?,5,0)').run(cell.id);
 const cmd=(actor,action,input={})=>work.command(actor,action,{requestId:randomUUID(),...work.identity(),actorId:actor.id,deviceId:'phone',...input});
 const taskId=cmd(op,'create',{direction,productId:1,quantity:5,preferredCellId:cells[0].id}).taskId;
 let line=work.task(op,taskId).lines[0];cmd(op,'acquire',{lineId:line.id,revision:line.revision,method:'arrival'});
 const task=()=>work.task(admin,taskId),fields=()=>({taskId,generation:task().assignment_generation,progressToken:task().progress_token,closureToken:task().closure_token});
 const balance=cell=>Number(db.prepare('SELECT available_quantity q FROM inventory_balances WHERE product_id=1 AND cell_id=?').get(cell.id)?.q||0);
 return {db,work,admin,op,cells,cmd,task,taskId,fields,balance};
}
for(const direction of ['pick','put'])test(`${direction}: each cell posts immediately, task stays open until Complete Task`,()=>{
 const f=fixture(direction);try{
  let task=f.get(f.t.id);const start=f.cells.map(c=>f.balance(c.id));
  for(const [index,original] of task.lines.filter(l=>l.execution_state==='ready').entries()){
   f.cmd(f.op,'acquire',{lineId:original.id,revision:original.revision,method:'arrival'});
   const line=f.get(f.t.id).lines.find(l=>l.id===original.id);
   const requestId=randomUUID(),input={requestId,lineId:line.id,revision:line.revision,assignmentGeneration:line.current_generation,cellId:line.cell_id,unit:line.unit_of_measure,quantity:line.planned_quantity,method:'manual',manualReason:'Cell label checked',cellCompletion:true};
   const result=f.cmd(f.op,'report',input);assert.equal(result.status,'recorded');assert.equal(f.cmd(f.op,'report',input).replayed,true);
   task=f.get(f.t.id);assert.equal(task.lines.find(l=>l.id===line.id).execution_state,'settled');assert.equal(task.explicit_close,1);assert.equal(task.outcome,'open');assert.equal(task.completed_at,null);
   assert.equal(f.balance(line.cell_id),start[index]+(direction==='pick'?-1:1)*line.planned_quantity);
  }
  assert.equal(task.recorded_quantity,10);assert.equal(task.remaining_quantity,0);
  const finished=f.cmd(f.op,'closeTask',{...f.input(),taskFinish:true,currentStatus:'yes',finalTaskCompletion:true});assert.equal(finished.closed,true);assert.equal(f.get(f.t.id).outcome,'completed');assert.equal(f.held(),0);
 }finally{f.db.close();}
});
test('changed actual location needs acknowledgement, then posts to that cell without automatic review',()=>{
 const f=fixture('pick');try{
  const first=f.get(f.t.id).lines.find(l=>l.execution_state==='ready');f.cmd(f.op,'acquire',{lineId:first.id,revision:first.revision,method:'arrival'});
  const l=f.get(f.t.id).lines.find(l=>l.id===first.id),actual=f.cells[2].id,before=f.balance(actual),input={lineId:l.id,revision:l.revision,assignmentGeneration:l.current_generation,cellId:actual,unit:l.unit_of_measure,quantity:l.planned_quantity,method:'manual',manualReason:'Checked actual cell label',cellCompletion:true};
  assert.throws(()=>f.cmd(f.op,'report',input),/Confirm the changed location/);assert.equal(f.balance(actual),before);
  const done=f.cmd(f.op,'report',{...input,differenceConfirmed:true});assert.equal(done.status,'recorded');assert.equal(f.balance(actual),before-l.planned_quantity);assert.equal(f.get(f.t.id).attention,0);
 }finally{f.db.close();}
});
test('a changed actual location that is inactive stays for supervisor verification',()=>{
 const f=fixture('pick');try{
  const first=f.get(f.t.id).lines.find(l=>l.execution_state==='ready');f.cmd(f.op,'acquire',{lineId:first.id,revision:first.revision,method:'arrival'});
  const l=f.get(f.t.id).lines.find(x=>x.id===first.id),target=f.cells[2].id,before=f.balance(target);
  f.db.prepare('UPDATE cells SET active=0 WHERE id=?').run(target);
  const result=f.cmd(f.op,'report',{lineId:l.id,revision:l.revision,assignmentGeneration:l.current_generation,cellId:target,unit:l.unit_of_measure,quantity:l.planned_quantity,method:'manual',manualReason:'Checked location',cellCompletion:true,differenceConfirmed:true});
  assert.equal(result.status,'review');assert.equal(f.balance(target),before);assert.equal(f.get(f.t.id).attention,1);
 }finally{f.db.close();}
});
test('rejecting one cell records a supervisor case, releases its claim and keeps sibling work available',()=>{
 const f=fixture('put');try{
  const before=f.get(f.t.id),l=before.lines.find(x=>x.execution_state==='ready');const heldBefore=f.held(),balance=f.balance(l.cell_id);
  const result=f.cmd(f.op,'rejectCell',{lineId:l.id,revision:l.revision,assignmentGeneration:l.current_generation,zeroConfirmed:true,reason:'Location is full'});
  assert.equal(result.status,'review');const task=f.get(f.t.id);assert.equal(task.attention,1);assert.equal(task.lines.find(x=>x.id===l.id).execution_state,'cancelled');assert.equal(f.balance(l.cell_id),balance);assert.equal(f.held(),heldBefore-l.planned_quantity);assert.ok(task.lines.some(x=>x.id!==l.id&&x.execution_state==='ready'));
  assert.ok(f.work.snapshot(f.admin).pending.some(r=>r.id===result.reportId));
 }finally{f.db.close();}
});
test('early Complete Task preserves each posted cell and routes only unfinished work for supervisor decision',()=>{
 const f=fixture('put');try{
  const first=f.get(f.t.id).lines.find(l=>l.execution_state==='ready');f.cmd(f.op,'acquire',{lineId:first.id,revision:first.revision,method:'arrival'});
  const l=f.get(f.t.id).lines.find(x=>x.id===first.id),before=f.balance(l.cell_id);
  f.cmd(f.op,'report',{lineId:l.id,revision:l.revision,assignmentGeneration:l.current_generation,cellId:l.cell_id,unit:l.unit_of_measure,quantity:l.planned_quantity,method:'manual',manualReason:'Cell checked',cellCompletion:true});
  assert.equal(f.balance(l.cell_id),before+l.planned_quantity);
  const request={...f.input(),currentStatus:'yes',taskFinish:true,finalTaskCompletion:true};
  assert.throws(()=>f.cmd(f.op,'closeTask',request),/remaining location/);
  assert.throws(()=>f.cmd(f.op,'sendTaskReview',request),/Confirm that the unfinished work/);
  const sent=f.cmd(f.op,'sendTaskReview',{...request,unfinishedConfirmed:true});assert.equal(sent.status,'review');
  assert.equal(f.balance(l.cell_id),before+l.planned_quantity);assert.equal(f.get(f.t.id).outcome,'needs_review');
  const pending=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId);assert.ok(pending?.closureTask);assert.equal(pending.closureActuals.find(r=>r.cellId===l.cell_id).quantity,l.planned_quantity);
 }finally{f.db.close();}
});
test('supervisor can verify a skipped cell as zero and reassign remaining put work to another location',()=>{
 const f=fixture('put');try{
  const original=f.get(f.t.id),skipped=original.lines.find(l=>l.execution_state==='ready');
  const result=f.cmd(f.op,'rejectCell',{lineId:skipped.id,revision:skipped.revision,assignmentGeneration:skipped.current_generation,zeroConfirmed:true,reason:'Location is full'});
  const pending=f.work.snapshot(f.admin).pending.find(r=>r.id===result.reportId);assert.ok(pending);
  const checked=f.cmd(f.admin,'resolve',{reportId:pending.id,caseRevision:pending.case_revision,quantity:0,verification:'Checked with operator; no items were put in this cell'});assert.equal(checked.status,'recorded');
  const t=f.get(f.t.id);assert.equal(t.attention,0);assert.equal(t.outcome,'open');
  const target=f.cells.find(c=>c.id!==skipped.cell_id);
  const reassigned=f.cmd(f.admin,'updateReviewTask',{taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token,assigneeId:f.other.id,remainingQuantity:10,planCellId:target.id});
  assert.equal(reassigned.status,'recorded');const next=f.get(t.id);assert.equal(next.assignee_id,f.other.id);assert.equal(next.plan_cell_id,target.id);
  assert.ok(next.lines.some(l=>l.execution_state==='ready'&&l.cell_id===target.id&&l.planned_quantity===10));
 }finally{f.db.close();}
});
for(const direction of ['pick','put'])test(`${direction}: location-only final totals close without review, while a short final total is highest-priority review`,()=>{
 for(const [split,expectedReview] of [
  [[3,2],false],[[5,0],false],[[2,2],true],[[4,0],true]
 ]){
  const f=finalQuantityFixture(direction);try{
   const rows=f.cells.flatMap((cell,index)=>split[index]?[{cellId:cell.id,quantity:split[index]}]:[]),actual=split[0]+split[1];
   const before=f.cells.map(f.balance),input={...f.fields(),currentStatus:'no',actuals:rows,finalTaskCompletion:true};
   if(expectedReview){
    assert.throws(()=>f.cmd(f.op,'closeTask',input),/supervisor review/);
    const sent=f.cmd(f.op,'sendTaskReview',input);assert.equal(sent.status,'review');
    assert.equal(f.task().work_priority,'high');assert.equal(f.task().outcome,'needs_review');
    assert.deepEqual(f.cells.map(f.balance),before,'unverified stock remains unchanged');
    const caseRow=f.work.snapshot(f.admin,{view:'mine'}).pending.find(r=>r.id===sent.reportId);
    assert.ok(caseRow?.closureTask);assert.deepEqual(caseRow.closureActuals.map(r=>r.quantity),rows.map(r=>r.quantity));
   }else{
    const saved=f.cmd(f.op,'closeTask',input);assert.equal(saved.closed,true);assert.equal(f.task().attention,0);
    assert.equal(f.task().recorded_quantity,5);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reports WHERE status IN ('review','received')").get().n,0);
    assert.deepEqual(f.cells.map(f.balance),before.map((n,i)=>n+(direction==='pick'?-1:1)*split[i]));
    assert.equal(f.db.prepare("SELECT COALESCE(SUM(quantity),0) n FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.state='held'").get(f.taskId).n,0);
   }
   assert.equal(actual,expectedReview?4:5);
  }finally{f.db.close();}
 }
});
test('supervisor may accept a short final movement or accept it and assign only the remaining quantity',()=>{
 for(const assign of [false,true]){
  const f=finalQuantityFixture();try{
   const rows=[{cellId:f.cells[0].id,quantity:4}],input={...f.fields(),currentStatus:'no',actuals:rows,finalTaskCompletion:true};
   const sent=f.cmd(f.op,'sendTaskReview',input),pending=f.work.snapshot(f.admin,{view:'mine'}).pending.find(r=>r.id===sent.reportId);
   const review={...f.fields(),reportId:pending.id,caseRevision:pending.case_revision,currentStatus:'no',actuals:rows,workerStopped:true,assigneeId:f.admin.id};
   const outcome=f.cmd(f.admin,assign?'resolveAndAssignRemaining':'resolve',review);
   assert.equal(outcome.closed,true);assert.equal(f.task().recorded_quantity,4);assert.equal(f.task().remaining_quantity,1);
   assert.equal(f.task().attention,0);assert.equal(f.balance(f.cells[0]),1);
   if(assign){const next=f.work.task(f.admin,outcome.newTaskId);assert.equal(next.requested_quantity,1);assert.equal(next.assignee_id,f.admin.id);assert.equal(next.assignment_state,'offered');assert.equal(f.task().reopened_task_id,outcome.newTaskId);}
   else assert.equal(outcome.newTaskId,undefined);
  }finally{f.db.close();}
 }
});
for(const direction of ['pick','put'])for(const mode of ['current','custom','zero','relocate','multiple'])test(`${direction} closes final ${mode} totals atomically with deltas, retained attribution and all reservations released`,()=>{
 const f=fixture(direction);try{const sign=direction==='pick'?-1:1,a=f.cells[0].id,b=f.cells[1].id,c=f.cells[2].id,initial=[f.balance(a),f.balance(b),f.balance(c)];f.record();assert.equal(f.get(f.t.id).recorded_quantity,4);assert.equal(f.held(),6);
 const rows=mode==='custom'?[{cellId:a,quantity:3}]:mode==='zero'?[{cellId:a,quantity:0}]:mode==='relocate'?[{cellId:c,quantity:4}]:mode==='multiple'?[{cellId:a,quantity:2},{cellId:b,quantity:1},{cellId:c,quantity:1}]:null;
 const before=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,request={...f.input(rows?{currentStatus:'no',actuals:rows}:{}),requestId:randomUUID()};const r=f.cmd(f.op,'closeTask',request);assert.equal(r.closed,true);assert.equal(f.held(),0);const t=f.get(f.t.id);assert.ok(t.completed_at);assert.equal(t.attention,0);assert.equal(t.closed_actuals,true);assert.equal(t.recorded_quantity,mode==='custom'?3:mode==='zero'?0:4);
 for(const [i,id] of [a,b,c].entries()){const actual=rows?rows.find(x=>x.cellId===id)?.quantity||0:id===a?4:0;assert.equal(f.balance(id),initial[i]+sign*actual);}
 assert.equal(t.lines.find(l=>l.cell_id===a&&l.execution_state==='settled').attribution.performer,f.op.name);
 const count=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n;if(!rows)assert.equal(count,before);assert.equal(f.cmd(f.op,'closeTask',request).replayed,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,count);
 assert.throws(()=>f.cmd(f.op,'closeTask',f.input()),/already closed/);assert.throws(()=>f.cmd(f.admin,'reassign',{...f.fields(t),assigneeId:f.other.id}),/cannot be reopened/);
 }finally{f.db.close();}
});
test('closure validates identities, exact versions, radio declaration, location uniqueness and permissions',()=>{
 const f=fixture();try{f.record();const stale=f.input(),before=f.balance(f.cells[0].id);assert.throws(()=>f.cmd(f.other,'closeTask',stale),/own|assigned/);assert.throws(()=>f.cmd(f.admin,'closeTask',stale),/assigned operator/);assert.throws(()=>f.cmd(f.op,'closeTask',{...stale,currentStatus:''}),/Choose Yes or No/);assert.throws(()=>f.cmd(f.op,'closeTask',{...stale,closureToken:''}),/changed/);assert.throws(()=>f.cmd(f.op,'closeTask',{...stale,site:'wrong'}),/warehouse/);assert.throws(()=>f.cmd(f.op,'closeTask',{...stale,dataset:'wrong'}),/dataset/);assert.throws(()=>f.cmd(f.op,'closeTask',{...stale,currentStatus:'no',actuals:[{cellId:f.cells[0].id,quantity:0},{cellId:f.cells[0].id,quantity:1}]}),/once/);
 const l=f.get(f.t.id).lines.find(l=>l.execution_state==='settled');f.cmd(f.op,'correct',{lineId:l.id,revision:l.revision,quantity:3,verification:'Slip corrected'});assert.throws(()=>f.cmd(f.op,'closeTask',stale),/changed/);assert.equal(f.balance(f.cells[0].id),before+1);
 const access=createAccessService({db:f.db}),role=access.saveRole(f.admin,{name:'No close',capabilities:['work.view','work.execute']});access.assign(f.admin,{userId:f.op.id,roleId:role});assert.throws(()=>f.cmd(f.op,'closeTask',f.input()),/not permitted/);
 }finally{f.db.close();}
});
test('unrelated task activity does not invalidate closure; current competing reservations do prevent unsafe deltas',()=>{
 const f=fixture();try{f.record();const input=f.input(),token=input.closureToken;f.cmd(f.other,'create',{direction:'pick',productId:1,quantity:20,preferredCellId:f.cells[2].id});assert.equal(f.get(f.t.id).closure_token,token);
 assert.throws(()=>f.cmd(f.op,'closeTask',{...input,currentStatus:'no',actuals:[{cellId:f.cells[2].id,quantity:4}]}),/reservation/);assert.equal(f.held(),6);assert.equal(f.cmd(f.op,'closeTask',input).closed,true);
 }finally{f.db.close();}
});
test('own unknown entry can become explicit final actuals; confirmation alone cannot assume unknown means zero',()=>{
 const f=fixture();try{const l=f.get(f.t.id).lines[0];f.cmd(f.op,'askReview',{lineId:l.id,reason:'Unsure earlier'});assert.throws(()=>f.cmd(f.op,'closeTask',f.input()),/unverified/);const r=f.cmd(f.op,'closeTask',f.input({currentStatus:'no',actuals:[{cellId:l.cell_id,quantity:3}]}));assert.equal(r.closed,true);assert.equal(f.get(f.t.id).recorded_quantity,3);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reports WHERE status='resolved'").get().n,1);
 }finally{f.db.close();}
});
test('review routing retains reservations/evidence and accepted aggregate review closes only after verification',()=>{
 const f=fixture();try{f.record();const original=f.get(f.t.id).lines[0],entry={...f.input({currentStatus:'no',actuals:[{cellId:original.cell_id,quantity:3}]}),requestId:randomUUID()},before=f.balance(original.cell_id),r=f.cmd(f.op,'sendTaskReview',entry);assert.equal(r.status,'review');assert.equal(f.cmd(f.op,'sendTaskReview',entry).replayed,true);assert.equal(f.balance(original.cell_id),before);assert.equal(f.held(),6);const inbox=f.work.snapshot(f.admin,{view:'mine'});assert.ok(inbox.returnedTasks.some(t=>t.id===f.t.id));const report=inbox.pending.find(entry=>entry.id===r.reportId&&entry.closureTask);assert.ok(report);assert.equal(report.closureActuals[0].quantity,3);assert.equal(f.get(f.t.id).completed_at,null);
 const resolve={...f.fields(report.closureTask),reportId:r.reportId,caseRevision:report.case_revision,currentStatus:'no',actuals:report.closureActuals,verification:'Checked movement slip and every location',workerStopped:true};assert.throws(()=>f.cmd(f.op,'resolve',resolve),/not permitted/);assert.throws(()=>f.cmd(f.admin,'resolve',{...resolve,workerStopped:false}),/worker/);assert.equal(f.cmd(f.admin,'resolve',resolve).closed,true);assert.equal(f.balance(original.cell_id),before+1);assert.equal(f.held(),0);assert.equal(f.get(f.t.id).lines[0].attribution.performer,f.op.name);
 }finally{f.db.close();}
});
test('late phone evidence after closure is retained without another stock posting and receipt replay stays closed',()=>{
 const f=fixture();try{f.record();const original=f.get(f.t.id).lines[0],request={...f.input(),requestId:randomUUID()};f.cmd(f.op,'closeTask',request);const before=f.balance(original.cell_id);const late=f.cmd(f.op,'report',{lineId:original.id,revision:original.revision,assignmentGeneration:original.current_generation,cellId:original.cell_id,unit:original.unit_of_measure,quantity:4});assert.equal(late.status,'review');assert.equal(f.balance(original.cell_id),before);assert.equal(f.get(f.t.id).attention,1);assert.equal(f.cmd(f.op,'closeTask',request).replayed,true);assert.equal(f.balance(original.cell_id),before);
 }finally{f.db.close();}
});
for(const direction of ['pick','put'])test(`${direction}: supervisor resolves stock/capacity conflict with discrepancy and preserves another task's claims`,()=>{
 const f=fixture(direction);try{f.record();const a=f.cells[0].id,b=f.cells[2].id;if(direction==='pick')f.cmd(f.other,'create',{direction,productId:1,quantity:20,preferredCellId:b});else f.cmd(f.other,'create',{direction,productId:1,quantity:30,preferredCellId:b});const wanted=direction==='pick'?15:25,actuals=[{cellId:b,quantity:wanted}],otherClaims=f.db.prepare("SELECT r.* FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id!=? AND r.state='held'").all(f.t.id);
 assert.throws(()=>f.cmd(f.op,'closeTask',f.input({currentStatus:'no',actuals})),/reservation/);const sent=f.cmd(f.op,'sendTaskReview',f.input({currentStatus:'no',actuals})),r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId);f.cmd(f.admin,'resolve',{...f.fields(r.closureTask),reportId:r.id,caseRevision:r.case_revision,currentStatus:'no',actuals,workerStopped:true,verification:'Confirmed actual movement despite recorded shortage/capacity'});assert.equal(f.balance(b),direction==='pick'?5:25);assert.ok(f.get(f.t.id).completed_at);assert.equal(f.held(),0);assert.deepEqual(f.db.prepare("SELECT r.* FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id!=? AND r.state='held'").all(f.t.id),otherClaims);assert.ok(f.db.prepare('SELECT * FROM work_discrepancies WHERE cell_id=?').get(b));
 }finally{f.db.close();}
});
test('team Stop requires verified closure authority or routes actuals to review; observation-only recipients cannot close others evidence',()=>{
 const f=fixture();try{f.record();assert.throws(()=>f.cmd(f.admin,'closeTask',{...f.input(),verifiedClosure:true}),/workers stopped/);const sent=f.cmd(f.admin,'sendTaskReview',f.input());assert.equal(sent.status,'review');const r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId);assert.equal(r.performer_id,null);
 }finally{f.db.close();}
 const g=fixture();try{const l=g.get(g.t.id).lines[0];g.cmd(g.op,'askReview',{lineId:l.id});g.cmd(g.admin,'assignReview',{...g.fields(g.get(g.t.id)),assigneeId:g.other.id});const t=g.get(g.t.id);assert.throws(()=>g.cmd(g.other,'closeTask',{...g.fields(t),currentStatus:'no',actuals:[{cellId:l.cell_id,quantity:3}]}),/supervisor/);assert.equal(g.cmd(g.other,'sendTaskReview',{...g.fields(t),currentStatus:'no',actuals:[{cellId:l.cell_id,quantity:3}]}).status,'review');}finally{g.db.close();}
});
test('stocktake overlap blocks operator delta; supervisor can link exactly the accounted difference without posting again',()=>{
 const f=fixture();try{f.record();const cell=f.cells[0],count=createStocktakingService({db:f.db,operationsService:f.work,clock:()=>new Date(Date.now()+10000)}),cc=(actor,action,input)=>count.command(actor,action,{requestId:randomUUID(),...input});const run=cc(f.op,'create',{mode:'selected',cellIds:[cell.id]}),item=count.snapshot(f.op).runs.find(r=>r.id===run.runId).items[0],attempt=cc(f.op,'begin',{itemId:item.id,generation:item.generation,method:'manual',location:cell.logical_code}),observation=cc(f.op,'observe',{attemptId:attempt.attemptId,lines:[{productId:1,actual:1}]});cc(f.admin,'review',{observationId:observation.observationId,revision:1,action:'approve',reason:'Unknown',evidence:'Count includes one fewer picked'});assert.equal(f.balance(cell.id),1);
 const actuals=[{cellId:cell.id,quantity:3}];assert.throws(()=>f.cmd(f.op,'closeTask',f.input({currentStatus:'no',actuals})),/stocktake|stock count/);const sent=f.cmd(f.op,'sendTaskReview',f.input({currentStatus:'no',actuals})),r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId),input={...f.fields(r.closureTask),reportId:r.id,caseRevision:r.case_revision,currentStatus:'no',actuals,workerStopped:true,verification:'This one-unit difference is exactly accounted in the approved count'};assert.throws(()=>f.cmd(f.admin,'resolve',input),/stocktake|stock count/);const before=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n;f.cmd(f.admin,'resolve',{...input,countLinks:{[cell.id]:observation.observationId}});assert.equal(f.balance(cell.id),1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,before);assert.equal(f.get(f.t.id).recorded_quantity,3);assert.equal(f.held(),0);assert.equal(f.db.prepare('SELECT accounted_delta FROM stocktake_movement_links').get().accounted_delta,1);
 }finally{f.db.close();}
});
test('closure rejects changed units and controlled stock, while review preserves the proposed actuals',()=>{
 const f=fixture();try{f.record();f.db.prepare("UPDATE products SET unit_of_measure='new-unit' WHERE id=1").run();const actuals=[{cellId:f.cells[0].id,quantity:3}];assert.throws(()=>f.cmd(f.op,'closeTask',f.input({currentStatus:'no',actuals})),/units changed/);const r=f.cmd(f.op,'sendTaskReview',f.input({currentStatus:'no',actuals}));assert.equal(r.status,'review');assert.equal(f.get(f.t.id).completed_at,null);}finally{f.db.close();}
});
test('ordinary movement input cannot forge the internal aggregate closure marker',()=>{
 const f=fixture();try{const r=f.cmd(f.op,'manual',{productId:1,cellId:f.cells[2].id,direction:'pick',quantity:1,unit:f.get(f.t.id).lines[0].unit_of_measure,taskClosure:true,actuals:[{cellId:f.cells[0].id,quantity:0}],reason:'Manual evidence'});const row=f.db.prepare('SELECT payload FROM work_reports WHERE id=?').get(r.reportId);assert.equal(JSON.parse(row.payload).taskClosure,undefined);assert.equal(f.work.snapshot(f.admin).pending.find(x=>x.id===r.reportId).closureTask,undefined);}finally{f.db.close();}
});

for(const route of ['team','review'])for(const legacy of ['', 'Checked signed slip'])test(`${route} checkbox-only attestation closes, rejects non-booleans and preserves optional legacy evidence: ${legacy||'no note'}`,()=>{
 const f=fixture();try{f.record();let action='closeTask',input=f.input({verifiedClosure:true});
 if(route==='review'){const sent=f.cmd(f.admin,'sendTaskReview',{...f.input(),workerStopped:false});const r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId);assert.equal(JSON.parse(f.db.prepare('SELECT payload FROM work_reports WHERE id=?').get(r.id).payload).verification,undefined);action='resolve';input={...f.fields(r.closureTask),reportId:r.id,caseRevision:r.case_revision,currentStatus:'no',actuals:r.closureActuals};}
 const before=f.balance(f.cells[0].id);for(const workerStopped of [undefined,false,'true',1]){assert.throws(()=>f.cmd(f.admin,action,{...input,workerStopped,verification:legacy}),/workers stopped/);assert.equal(f.balance(f.cells[0].id),before);assert.equal(f.held(),6);}
 const request={...input,workerStopped:true,verification:legacy,requestId:randomUUID()};assert.equal(f.cmd(f.admin,action,request).closed,true);assert.equal(f.held(),0);assert.equal(f.cmd(f.admin,action,request).replayed,true);
 const audit=JSON.parse(f.db.prepare("SELECT payload FROM work_events WHERE event_type='task_closed_actuals'").get().payload);assert.equal(audit.verification,'Checkbox attestation: all workers have stopped and the actual totals are verified.'+(legacy?' Additional verification: '+legacy:''));
 }finally{f.db.close();}
});
test('ordinary movement review still requires verification evidence',()=>{
 const f=fixture();try{const result=f.cmd(f.op,'manual',{productId:1,cellId:f.cells[2].id,direction:'pick',quantity:1,unit:f.get(f.t.id).lines[0].unit_of_measure,reason:'Manual evidence'});const r=f.work.snapshot(f.admin).pending.find(r=>r.id===result.reportId);assert.throws(()=>f.cmd(f.admin,'resolve',{reportId:r.id,caseRevision:r.case_revision,quantity:1,performerId:f.op.id,workerStopped:true}),/verif/i);}finally{f.db.close();}
});

for(const direction of ['pick','put'])test(`${direction}: impossible physical alignment stays open, preserves all stock and holds, then a corrected retry closes once`,()=>{
 const f=fixture(direction);try{
  f.record();const cell=f.cells[0],before=f.balance(cell.id),held=f.held(),tx=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  const input=f.input({verifiedClosure:true,workerStopped:true,alignPhysical:true,currentStatus:'no',actuals:[{cellId:cell.id,quantity:5}],requestId:randomUUID()});
  assert.throws(()=>f.cmd(f.admin,'closeTask',input),direction==='pick'?/actual pick 5.*stock available.*Check the location/:/exceeds the location capacity.*Check the location/);
  assert.equal(f.balance(cell.id),before);assert.equal(f.held(),held);assert.equal(f.get(f.t.id).completed_at,null);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,tx);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_receipts WHERE request_id=?').get(input.requestId).n,0);
  input.actuals[0].quantity=3;input.requestId=randomUUID();const r=f.cmd(f.admin,'closeTask',input);assert.equal(r.status,'recorded');assert.equal(r.closed,true);assert.equal(f.get(f.t.id).recorded_quantity,3);assert.equal(f.held(),0);assert.equal(f.balance(cell.id),before+(direction==='pick'?1:-1));
  assert.equal(f.cmd(f.admin,'closeTask',input).replayed,true);assert.equal(f.balance(cell.id),before+(direction==='pick'?1:-1));assert.equal(f.work.snapshot(f.admin,{view:'mine',workState:'current'}).tasks.some(t=>t.id===f.t.id),false);
 }finally{f.db.close();}
});
test('physical alignment can override competing reservations while leaving their claims and current task audit intact',()=>{
 const f=fixture();try{
  f.record();const cell=f.cells[2],other=f.cmd(f.other,'create',{direction:'pick',productId:1,quantity:20,preferredCellId:cell.id});
  const claims=f.db.prepare("SELECT r.* FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.state='held'").all(other.taskId);
  const result=f.cmd(f.admin,'closeTask',f.input({verifiedClosure:true,workerStopped:true,alignPhysical:true,currentStatus:'no',actuals:[{cellId:cell.id,quantity:5}]}));
  assert.equal(result.closed,true);assert.equal(result.status,'recorded');assert.equal(f.balance(cell.id),15);assert.equal(f.held(),0);assert.equal(f.get(f.t.id).attention,0);
  assert.deepEqual(f.db.prepare("SELECT r.* FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.state='held'").all(other.taskId),claims);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received')").get(f.t.id).n,0);
 }finally{f.db.close();}
});
test('one impossible location rolls back an entire multi-location physical review, including pending review resolution',()=>{
 const f=fixture();try{
  f.record();const sent=f.cmd(f.admin,'sendTaskReview',f.input()),r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId),before=f.cells.map(c=>f.balance(c.id));
  const input={...f.fields(r.closureTask),reportId:r.id,caseRevision:r.case_revision,workerStopped:true,alignPhysical:true,currentStatus:'no',actuals:[{cellId:f.cells[1].id,quantity:1},{cellId:f.cells[2].id,quantity:21}]};
  assert.throws(()=>f.cmd(f.admin,'resolve',input),/exceeds the stock available/);assert.deepEqual(f.cells.map(c=>f.balance(c.id)),before);assert.equal(f.get(f.t.id).completed_at,null);assert.equal(f.db.prepare('SELECT status FROM work_reports WHERE id=?').get(r.id).status,'review');
  input.actuals[1].quantity=2;const saved=f.cmd(f.admin,'resolve',input);assert.equal(saved.closed,true);assert.equal(f.get(f.t.id).attention,0);assert.equal(f.db.prepare('SELECT status FROM work_reports WHERE id=?').get(r.id).status,'resolved');
 }finally{f.db.close();}
});
