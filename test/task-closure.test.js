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
 const f=fixture(direction);try{f.record();const a=f.cells[0].id,b=f.cells[2].id;if(direction==='pick')f.cmd(f.other,'create',{direction,productId:1,quantity:20,preferredCellId:b});else f.cmd(f.other,'create',{direction,productId:1,quantity:30,preferredCellId:b});const wanted=direction==='pick'?25:35,actuals=[{cellId:b,quantity:wanted}],otherClaims=f.db.prepare("SELECT r.* FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id!=? AND r.state='held'").all(f.t.id);
 assert.throws(()=>f.cmd(f.op,'closeTask',f.input({currentStatus:'no',actuals})),/reservation/);const sent=f.cmd(f.op,'sendTaskReview',f.input({currentStatus:'no',actuals})),r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId);f.cmd(f.admin,'resolve',{...f.fields(r.closureTask),reportId:r.id,caseRevision:r.case_revision,currentStatus:'no',actuals,workerStopped:true,verification:'Confirmed actual movement despite recorded shortage/capacity'});assert.equal(f.balance(b),direction==='pick'?-5:35);assert.ok(f.get(f.t.id).completed_at);assert.equal(f.held(),0);assert.deepEqual(f.db.prepare("SELECT r.* FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id!=? AND r.state='held'").all(f.t.id),otherClaims);assert.ok(f.db.prepare('SELECT * FROM work_discrepancies WHERE cell_id=?').get(b));
 }finally{f.db.close();}
});
test('team Stop requires verified closure authority or routes actuals to review; observation-only recipients cannot close others evidence',()=>{
 const f=fixture();try{f.record();assert.throws(()=>f.cmd(f.admin,'closeTask',{...f.input(),verifiedClosure:true}),/workers stopped/);const sent=f.cmd(f.admin,'sendTaskReview',f.input());assert.equal(sent.status,'review');const r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId);assert.equal(r.performer_id,null);
 }finally{f.db.close();}
 const g=fixture();try{const l=g.get(g.t.id).lines[0];g.cmd(g.op,'askReview',{lineId:l.id});g.cmd(g.admin,'assignReview',{...g.fields(g.get(g.t.id)),assigneeId:g.other.id});const t=g.get(g.t.id);assert.throws(()=>g.cmd(g.other,'closeTask',{...g.fields(t),currentStatus:'no',actuals:[{cellId:l.cell_id,quantity:3}]}),/supervisor/);assert.equal(g.cmd(g.other,'sendTaskReview',{...g.fields(t),currentStatus:'no',actuals:[{cellId:l.cell_id,quantity:3}]}).status,'review');}finally{g.db.close();}
});
test('stocktake overlap blocks operator delta; supervisor can link exactly the accounted difference without posting again',()=>{
 const f=fixture();try{f.record();const cell=f.cells[0],count=createStocktakingService({db:f.db,operationsService:f.work,clock:()=>new Date(Date.now()+10000)}),cc=(actor,action,input)=>count.command(actor,action,{requestId:randomUUID(),...input});const run=cc(f.op,'create',{mode:'selected',cellIds:[cell.id]}),item=count.snapshot(f.op).runs.find(r=>r.id===run.runId).items[0],attempt=cc(f.op,'begin',{itemId:item.id,generation:item.generation,method:'manual',location:cell.logical_code}),observation=cc(f.op,'observe',{attemptId:attempt.attemptId,lines:[{productId:1,actual:1}]});cc(f.admin,'review',{observationId:observation.observationId,revision:1,action:'approve',reason:'Unknown',evidence:'Count includes one fewer picked'});assert.equal(f.balance(cell.id),1);
 const actuals=[{cellId:cell.id,quantity:3}];assert.throws(()=>f.cmd(f.op,'closeTask',f.input({currentStatus:'no',actuals})),/stocktake/);const sent=f.cmd(f.op,'sendTaskReview',f.input({currentStatus:'no',actuals})),r=f.work.snapshot(f.admin).pending.find(r=>r.id===sent.reportId),input={...f.fields(r.closureTask),reportId:r.id,caseRevision:r.case_revision,currentStatus:'no',actuals,workerStopped:true,verification:'This one-unit difference is exactly accounted in the approved count'};assert.throws(()=>f.cmd(f.admin,'resolve',input),/stocktake/);const before=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n;f.cmd(f.admin,'resolve',{...input,countLinks:{[cell.id]:observation.observationId}});assert.equal(f.balance(cell.id),1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,before);assert.equal(f.get(f.t.id).recorded_quantity,3);assert.equal(f.held(),0);assert.equal(f.db.prepare('SELECT accounted_delta FROM stocktake_movement_links').get().accounted_delta,1);
 }finally{f.db.close();}
});
test('closure rejects changed units and controlled stock, while review preserves the proposed actuals',()=>{
 const f=fixture();try{f.record();f.db.prepare("UPDATE products SET unit_of_measure='new-unit' WHERE id=1").run();const actuals=[{cellId:f.cells[0].id,quantity:3}];assert.throws(()=>f.cmd(f.op,'closeTask',f.input({currentStatus:'no',actuals})),/units changed/);const r=f.cmd(f.op,'sendTaskReview',f.input({currentStatus:'no',actuals}));assert.equal(r.status,'review');assert.equal(f.get(f.t.id).completed_at,null);}finally{f.db.close();}
});
test('ordinary movement input cannot forge the internal aggregate closure marker',()=>{
 const f=fixture();try{const r=f.cmd(f.op,'manual',{productId:1,cellId:f.cells[2].id,direction:'pick',quantity:1,unit:f.get(f.t.id).lines[0].unit_of_measure,taskClosure:true,actuals:[{cellId:f.cells[0].id,quantity:0}],reason:'Manual evidence'});const row=f.db.prepare('SELECT payload FROM work_reports WHERE id=?').get(r.reportId);assert.equal(JSON.parse(row.payload).taskClosure,undefined);assert.equal(f.work.snapshot(f.admin).pending.find(x=>x.id===r.reportId).closureTask,undefined);}finally{f.db.close();}
});
