import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createAccessService} from '../src/modules/access/service.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'lightguide-history-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 db.prepare("INSERT INTO users(name,username,password_hash,role,status,created_at) VALUES('Next operator','next',?,'operator','active',?)").run(hashPassword('test'),new Date().toISOString());
 const other=db.prepare("SELECT * FROM users WHERE username='next'").get(),product=db.prepare('SELECT * FROM products LIMIT 1').get(),cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 3').all();
 db.exec('DELETE FROM inventory_balances');db.prepare('UPDATE products SET items_per_cell=3 WHERE id=?').run(product.id);
 for(const c of cells)db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,3,0)').run(product.id,c.id);
 const cmd=(actor,action,input={})=>work.command(actor,action,{requestId:randomUUID(),...input});
 const create=(quantity=5,extra={})=>cmd(admin,'create',{direction:'pick',productId:product.id,quantity,assigneeId:op.id,...extra}).taskId;
 function finish(actor,line){cmd(actor,'acquire',{lineId:line.id,revision:line.revision,deviceId:'history-test',method:'arrival'});const l=work.line(line.id);cmd(actor,'verify',{lineId:l.id,revision:l.revision,deviceId:'history-test',location:`lytguide:${work.identity().site}:${l.label_id}:${l.label_revision}`});return cmd(actor,'report',{lineId:l.id,revision:l.revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity:l.planned_quantity,deviceId:'history-test'});}
 return {db,work,admin,op,other,product,cells,cmd,create,finish};
}
test('task timeline joins creation, assignments, start/resume and every cell movement without write effects or duplicate retries',()=>{
 const f=fixture(),id=f.create();let t=f.work.task(f.op,id);
 f.cmd(f.op,'start',{taskId:id,generation:t.assignment_generation});t=f.work.task(f.op,id);
 const resume={requestId:randomUUID(),taskId:id,generation:t.assignment_generation,progressToken:t.progress_token,instructions:t.lines.map(l=>({lineId:l.id,revision:l.revision,bindingRevision:l.binding_revision}))};
 f.work.command(f.op,'resume',resume);f.work.command(f.op,'resume',resume);
 for(const l of t.lines)f.finish(f.op,l);
 const capture=()=>JSON.stringify(f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>[name,f.db.prepare('SELECT * FROM \"'+name+'\"').all()]));const before=capture(),data=f.work.taskHistory(f.op,{taskId:id}),steps=data.entries.map(e=>e.step);
 assert.deepEqual(capture(),before,'history is strictly read-only');
 for(const step of ['Task created','Assigned','Work started','Work resumed','Arrived at location','QR checked','Pick recorded','Location completed','Task completed'])assert.ok(steps.includes(step),step);
 assert.equal(steps.filter(s=>s==='Work resumed').length,1);
 const moves=data.entries.filter(e=>e.step==='Pick recorded');assert.equal(moves.length,2);assert.deepEqual(moves.map(e=>e.quantity),[-3,-2]);assert.equal(new Set(moves.map(e=>e.location)).size,2);assert.ok(moves.every(e=>e.actor===f.op.name&&e.unit===f.product.unit_of_measure));
 assert.equal(data.entries[0].step,'Task created');assert.equal(data.entries.at(-1).step,'Task completed');assert.ok(data.entries.every((e,i,a)=>!i||Date.parse(e.time)>=Date.parse(a[i-1].time)));
 assert.throws(()=>f.work.taskHistory(f.other,{taskId:id}),/another operator/);assert.throws(()=>f.work.taskHistory(f.admin,{taskId:99999}),/not found/);
 assert.equal(f.work.snapshot(f.op,{view:'history'}).taskPage.limit,50);assert.equal(f.work.snapshot(f.op,{view:'history',workState:'completed'}).tasks[0].id,id);f.db.close();
});
test('return, reassign, start, review and resolution remain visible to former assignees',()=>{
 const f=fixture(),id=f.create(2);let t=f.work.task(f.op,id);
 f.cmd(f.op,'decline',{taskId:id,generation:t.assignment_generation,reason:'Busy with another task'});t=f.work.task(f.admin,id);
 f.cmd(f.admin,'reassign',{taskId:id,generation:t.assignment_generation,assigneeId:f.other.id});t=f.work.task(f.other,id);
 f.cmd(f.other,'start',{taskId:id,generation:t.assignment_generation});const l=f.work.task(f.other,id).lines[0];f.cmd(f.other,'askReview',{lineId:l.id,reason:'Phone died after picking'});
 const report=f.work.snapshot(f.admin).pending.find(r=>r.line_id===l.id);f.cmd(f.admin,'resolve',{reportId:report.id,quantity:2,verification:'Spoke with operator'});
 const data=f.work.taskHistory(f.op,{taskId:id});for(const s of ['Work returned','Reassigned','Work started','Quantity check requested','Sent for review','Review resolved','Pick recorded'])assert.ok(data.entries.some(e=>e.step===s),s);
 assert.equal(data.entries.find(e=>e.step==='Reassigned').assignee,f.other.name);assert.match(data.entries.find(e=>e.step==='Work returned').details,/Busy with another task/);
 assert.equal(f.work.snapshot(f.op,{view:'history'}).tasks[0].id,id);assert.throws(()=>f.work.snapshot(f.op,{view:'history',scope:'team'}),/not permitted/);f.db.close();
});
test('bin history keeps recorded units and unknown performer, supports paging, and respects current role scope',()=>{
 const f=fixture(),insert=f.db.prepare('INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,performed_by,unit_of_measure,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<53;i++)insert.run(i%2?'put':'pick',f.product.id,f.cells[0].id,i%2?1:-1,f.admin.id,i===0?f.op.id:null,'original cases','History test','2026-10-01T10:00:00.000Z');
 f.db.prepare("UPDATE products SET unit_of_measure='new unit' WHERE id=?").run(f.product.id);
 const a=f.work.cellHistory(f.admin,{cellId:f.cells[0].id}),b=f.work.cellHistory(f.admin,{cellId:f.cells[0].id,page:2});assert.equal(a.entries.length,50);assert.equal(b.entries.length,3);assert.equal(new Set([...a.entries,...b.entries].map(e=>e.id)).size,53);assert.ok(a.entries.every(e=>e.unit==='original cases'&&e.performer===null));
 const own=f.work.cellHistory(f.op,{cellId:f.cells[0].id});assert.equal(own.scope,'own');assert.equal(own.page.total,1);assert.equal(f.work.cellHistory(f.other,{cellId:f.cells[0].id}).page.total,0);
 const access=createAccessService({db:f.db}),role=access.saveRole(f.admin,{name:'No locations',capabilities:['work.view']});access.assign(f.admin,{userId:f.op.id,roleId:role});assert.throws(()=>f.work.cellHistory(f.op,{cellId:f.cells[0].id}),/not permitted|session/);f.db.close();
});
test('timeline paginates every event, retains old review uncertainty, and escapes no information through task selection filters',()=>{
 const f=fixture(),id=f.create(1),t=f.work.task(f.op,id),l=t.lines[0],insert=f.db.prepare('INSERT INTO work_events(line_id,actor_id,event_type,payload,created_at) VALUES(?,?,?,?,?)');
 for(let i=0;i<105;i++)insert.run(l.id,f.op.id,'review_observation',JSON.stringify({quantity:1,note:'Observation '+i}),'2099-01-01T10:00:00.000Z');
 const a=f.work.taskHistory(f.op,{taskId:id}),b=f.work.taskHistory(f.op,{taskId:id,page:2});assert.equal(a.entries.length,100);assert.equal(new Set([...a.entries,...b.entries].map(e=>e.id)).size,a.page.total);assert.equal(b.entries.at(-1).details,'Observation 104');
 assert.equal(f.work.snapshot(f.admin,{view:'history',scope:'team',taskSearch:String(id),sort:'product',order:'asc',pageSize:20}).taskPage.limit,20);assert.equal(f.work.snapshot(f.other,{view:'history',taskSearch:String(id)}).taskPage.total,0);
 f.db.close();
});

for(const direction of ['pick','put'])test(`reopen ${direction} assigns only remaining work, preserves closure and movements, and records both links`,()=>{
 const f=fixture(),id=f.create(5,{direction});let t=f.work.task(f.op,id);
 f.cmd(f.op,'start',{taskId:id,generation:t.assignment_generation});t=f.work.task(f.op,id);f.finish(f.op,t.lines[0]);t=f.work.task(f.op,id);
 f.cmd(f.op,'closeTask',{taskId:id,generation:t.assignment_generation,progressToken:t.progress_token,closureToken:t.closure_token,currentStatus:'yes',workerStopped:true});t=f.work.task(f.admin,id);
 const balances=JSON.stringify(f.db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id').all().map(x=>[x.cell_id,x.available_quantity])),movements=f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,oldLines=JSON.stringify(t.lines),request={requestId:randomUUID(),taskId:id,generation:t.assignment_generation,progressToken:t.progress_token,closureToken:t.closure_token,productId:f.product.id,direction,quantity:t.remaining_quantity,assigneeId:f.op.id,dueDuration:30,dueUnit:'minutes'};
 const result=f.work.command(f.admin,'reopen',request),next=f.work.task(f.admin,result.taskId),after=f.work.task(f.admin,id);
 assert.notEqual(result.taskId,id);assert.equal(result.sourceTaskId,id);assert.equal(next.requested_quantity,2);assert.equal(next.recorded_quantity,0);assert.equal(next.remaining_quantity,2);assert.equal(next.assignee_id,f.op.id);assert.equal(next.assigned_by,f.admin.id);assert.equal(next.assignment_state,'offered');assert.equal(Date.parse(next.due_at)-Date.parse(next.assigned_at),30*60000);
 assert.equal(JSON.stringify(after.lines),oldLines);assert.equal(after.closed_actuals,true);assert.equal(after.recorded_quantity,3);assert.equal(after.completed_at,t.completed_at);assert.equal(after.reopened_task_id,next.id);assert.equal(next.reopened_from_task_id,id);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id').all().map(x=>[x.cell_id,x.available_quantity])),balances);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,movements);
 assert.equal(f.db.prepare("SELECT SUM(r.quantity) n FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.state='held'").get(next.id).n,2);
 assert.equal(f.work.command(f.admin,'reopen',request).taskId,next.id);assert.throws(()=>f.cmd(f.admin,'reopen',{...request,requestId:randomUUID()}),/Already reopened/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,2);
 assert.match(f.work.taskHistory(f.admin,{taskId:id}).entries.find(e=>e.step==='Remaining work reopened').details,new RegExp('New task: #'+next.id));assert.match(f.work.taskHistory(f.admin,{taskId:next.id}).entries.find(e=>e.step==='Reopened from earlier task').details,new RegExp('Original task: #'+id));
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_guidance WHERE json_extract(desired,'$.lineId') IN (SELECT id FROM task_lines WHERE task_id=?) AND json_extract(desired,'$.action') IN ('quantity','locate')").get(next.id).n,0,'assignment does not start the lights');f.db.close();
});
test('reopen rejects active tasks, invalid quantities, stale instructions, unavailable stock, wrong product and unauthorized users without creating work',()=>{
 const f=fixture(),id=f.create(2);let t=f.work.task(f.admin,id);
 const input=()=>({taskId:id,generation:t.assignment_generation,progressToken:t.progress_token,closureToken:t.closure_token,productId:f.product.id,direction:'pick',quantity:2,assigneeId:f.op.id,dueDuration:8,dueUnit:'hours'});
 assert.throws(()=>f.cmd(f.admin,'reopen',input()),/Finish or review/);
 f.cmd(f.op,'closeTask',{...input(),currentStatus:'yes',workerStopped:true});t=f.work.task(f.admin,id);
 for(const [extra,pattern] of [[{quantity:0},/quantity/i],[{quantity:99},/stock|available|quantity/i],[{progressToken:'old'},/changed/],[{closureToken:'old'},/changed/],[{productId:999},/product or action/],[{direction:'put'},/product or action/]])assert.throws(()=>f.cmd(f.admin,'reopen',{...input(),...extra}),pattern);
 assert.throws(()=>f.cmd(f.op,'reopen',input()),/not permitted/);
 f.db.prepare("UPDATE users SET status='inactive' WHERE id=?").run(f.op.id);assert.throws(()=>f.cmd(f.admin,'reopen',input()),/active|eligible/);f.db.prepare("UPDATE users SET status='active' WHERE id=?").run(f.op.id);
 f.db.prepare("UPDATE products SET unit_of_measure='packs' WHERE id=?").run(f.product.id);t=f.work.task(f.admin,id);assert.throws(()=>f.cmd(f.admin,'reopen',input()),/unit changed/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reservations WHERE state='held'").get().n,0);f.db.close();
});
test('completed task defaults remain zero; explicitly requested extra work gets a new record and can use another assignee',()=>{
 const f=fixture(),id=f.create(1);f.cmd(f.op,'start',{taskId:id,generation:1});f.finish(f.op,f.work.task(f.op,id).lines[0]);const t=f.work.task(f.admin,id);
 assert.equal(t.remaining_quantity,0);const input={taskId:id,generation:t.assignment_generation,progressToken:t.progress_token,closureToken:t.closure_token,productId:f.product.id,direction:'pick',quantity:0,assigneeId:f.other.id,dueDuration:3,dueUnit:'days'};
 assert.throws(()=>f.cmd(f.admin,'reopen',input),/quantity/i);const result=f.cmd(f.admin,'reopen',{...input,quantity:1}),next=f.work.task(f.admin,result.taskId);assert.equal(next.assignee_id,f.other.id);assert.equal(Date.parse(next.due_at)-Date.parse(next.assigned_at),3*86400000);assert.equal(f.work.task(f.admin,id).recorded_quantity,1);
 const sorted=f.work.snapshot(f.admin,{view:'history',scope:'team',sort:'assignedTo',order:'asc'});assert.equal(sorted.taskPage.sort,'assignedTo');assert.deepEqual(sorted.tasks.map(t=>t.assignee_name),sorted.tasks.map(t=>t.assignee_name).sort());f.db.close();
});


test('Task History lists every task step with exact movement snapshots, scoped filtering, paging and no invented legacy balances',()=>{
 const f=fixture();try{
 const id=f.create(5);f.cmd(f.op,'start',{taskId:id,generation:1});
 for(const l of f.work.task(f.op,id).lines)f.finish(f.op,l);
 const task=f.work.task(f.admin,id);assert.equal(task.quantity_before,9);assert.equal(task.quantity_after,4);assert.equal(task.quantity_before_unit,f.product.unit_of_measure);for(const sort of ['before','after'])assert.equal(f.work.snapshot(f.admin,{view:'history',sort,order:'asc'}).taskPage.sort,sort);
 const timeline=f.work.activityHistory(f.op,{taskId:String(id)}),moves=timeline.entries.filter(e=>e.inventoryMovement);
 assert.deepEqual(moves.map(e=>[e.before,e.after]),[[3,0],[3,1]]);assert.ok(moves.every(e=>e.assignedBy===f.admin.name&&e.assignedTo===f.op.name));
 const all=f.work.activityHistory(f.op);for(const step of ['Task created','Assigned','Work started','Pick recorded','Task completed'])assert.ok(all.entries.some(e=>e.step===step),step);
 assert.equal(f.work.activityHistory(f.other).entries.length,0);assert.throws(()=>f.work.activityHistory(f.other,{taskId:id}),/another operator/);assert.throws(()=>f.work.activityHistory(f.admin,{taskId:'abc'}),/valid Task ID/);
 const line=task.lines[0],insert=f.db.prepare('INSERT INTO work_events(line_id,actor_id,event_type,payload,created_at) VALUES(?,?,?,?,?)');
 for(let i=0;i<104;i++)insert.run(line.id,f.op.id,'review_observation',JSON.stringify({quantity:1,note:'Check '+i}),'2099-01-01T10:00:00.000Z');
 const a=f.work.activityHistory(f.op),b=f.work.activityHistory(f.op,{page:2});assert.equal(a.entries.length,100);assert.equal(new Set([...a.entries,...b.entries].map(e=>e.id)).size,a.page.total);
 f.db.prepare('INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,task_id,created_at,reason) VALUES(?,?,?,?,?,?,?,?)').run('pick',f.product.id,line.cell_id,-1,f.op.id,id,'2099-01-02T00:00:00.000Z','Legacy entry');
 const legacy=f.work.activityHistory(f.op).entries[0];assert.equal(legacy.inventoryMovement,true);assert.equal(legacy.before,null);assert.equal(legacy.after,null);
 }finally{f.db.close();}
});
