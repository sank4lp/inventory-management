import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createAccessService,currentActor} from '../src/modules/access/service.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'unified-work-')));const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 db.prepare('UPDATE inventory_balances SET available_quantity=1000 WHERE product_id=1').run();
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 db.prepare("INSERT INTO users(name,username,password_hash,role,status,created_at) VALUES('Second','second',?,'operator','active',?)").run(hashPassword('test'),new Date().toISOString());const second=db.prepare("SELECT * FROM users WHERE username='second'").get();
 const cmd=(user,action,input={})=>work.command(user,action,{requestId:randomUUID(),...input}),get=id=>work.task(admin,id),fields=t=>({taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token,closureToken:t.closure_token}),create=(user=op,more={})=>get(cmd(admin,'create',{direction:'pick',productId:1,quantity:.001,assigneeId:user.id,...more}).taskId),page=(user=admin,query={})=>work.snapshot(user,{view:'mine',...query});
 const physical=()=>({reports:db.prepare('SELECT * FROM work_reports ORDER BY id').all(),reservations:db.prepare('SELECT * FROM work_reservations ORDER BY line_id').all(),ledger:db.prepare('SELECT * FROM transactions ORDER BY id').all(),balances:db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id,product_id').all(),lines:db.prepare('SELECT * FROM task_lines ORDER BY id').all()});
 return {db,work,admin,op,second,cmd,get,fields,create,page,physical};
}
test('unified filters and numeric sorts apply before the 100-row boundary, deduplicate review scope and isolate operators',()=>{
 const f=fixture();try{
  const ids=[];for(let i=0;i<125;i++){const t=f.create();ids.push(t.id);f.db.prepare('UPDATE tasks SET requested_quantity=? WHERE id=?').run(i+1,t.id);}
  const a=f.page(f.op,{sort:'requested',order:'asc',pageSize:100}),b=f.page(f.op,{sort:'requested',order:'asc',page:2,pageSize:100});assert.equal(a.taskPage.total,125);assert.equal(a.tasks.length,100);assert.equal(b.tasks.length,25);assert.deepEqual([...a.tasks,...b.tasks].map(t=>t.requested_quantity),Array.from({length:125},(_,i)=>i+1));
  const defaultPage=f.page(f.op);assert.equal(defaultPage.taskPage.limit,50);assert.equal(defaultPage.tasks.length,50);assert.equal(defaultPage.taskPage.pages,3);
  assert.equal(f.page(f.op,{page:3}).tasks.length,25);
  const small=f.page(f.op,{pageSize:20,page:7});assert.equal(small.tasks.length,5);assert.equal(small.taskPage.limit,20);assert.equal(small.taskPage.pages,7);
  const clamped=f.page(f.op,{pageSize:50,page:99});assert.equal(clamped.taskPage.number,3);assert.equal(clamped.tasks.length,25);
  for(const pageSize of [0,21,-1,1000,'invalid'])assert.equal(f.page(f.op,{pageSize}).taskPage.limit,50);
  const range=f.page(f.op,{requestedMin:110,requestedMax:120,remainingMin:112,sort:'remaining',order:'desc'});assert.deepEqual(range.tasks.map(t=>t.requested_quantity),[120,119,118,117,116,115,114,113,112]);assert.equal(range.myWorkPriority.id,ids[0]);
  assert.equal(f.page(f.second,{workState:'all'}).taskPage.total,0);assert.equal(f.page(f.admin).taskPage.total,0);
  let t=f.get(ids[0]);f.cmd(f.op,'askReview',{lineId:t.lines[0].id,reason:'Uncertain movement'});t=f.get(ids[124]);f.cmd(f.op,'decline',f.fields(t));
  const reviewed=f.page(f.admin,{reviewOnly:1,sort:'task',order:'asc'});assert.equal(reviewed.taskPage.total,2);assert.deepEqual(reviewed.tasks.map(t=>t.work_state),['review','review']);assert.deepEqual(reviewed.tasks.map(t=>t.work_status),['Quantity check','Needs assignment']);assert.equal(new Set(reviewed.tasks.map(t=>t.id)).size,2);
  assert.equal(f.page(f.admin,{statusSearch:'assignment'}).tasks[0].id,ids[124]);assert.equal(f.page(f.op,{reviewOnly:true}).tasks.length,1);assert.equal(f.page(f.admin,{productSearch:'no match'}).taskPage.total,0);
  assert.throws(()=>f.page(f.op,{requestedMin:'not numeric'}),/non-negative/);assert.throws(()=>f.page(f.op,{progressMax:-1}),/non-negative/);
  for(const key of ['completed','progress','state','status','product','unit'])assert.equal(f.page(f.op,{sort:key,order:'asc',pageSize:100}).tasks.length,100);
  const access=createAccessService({db:f.db}),role=access.saveRole(f.admin,{name:'Scoped assigner',capabilities:['work.view','work.assign','work.pick']});access.assign(f.admin,{userId:f.second.id,roleId:role});const delegate=currentActor(f.db,f.second);assert.equal(f.page(delegate).taskPage.total,0);
  t=f.get(f.cmd(delegate,'create',{direction:'pick',productId:1,quantity:.001,assigneeId:f.op.id}).taskId);f.cmd(f.op,'decline',f.fields(t));assert.deepEqual(f.page(delegate).tasks.map(t=>t.id),[t.id]);
 }finally{f.db.close();}
});
test('clean assignment updates preserve or explicitly change deadlines and reject stale, closed, unauthorized and inactive targets',()=>{
 const f=fixture();try{let t=f.create(f.op,{quantity:2}),original=t.due_at,request={...f.fields(t),assigneeId:f.second.id,remainingQuantity:3,requestId:randomUUID()};
  assert.throws(()=>f.cmd(f.op,'updateReviewTask',request),/not permitted/);const result=f.cmd(f.admin,'updateReviewTask',request);assert.equal(result.message,'Task assignment updated.');assert.equal(f.cmd(f.admin,'updateReviewTask',request).replayed,true);t=f.get(t.id);assert.equal(t.due_at,original);assert.equal(t.requested_quantity,3);assert.equal(t.assignment_state,'offered');assert.equal(t.assignee_id,f.second.id);assert.throws(()=>f.cmd(f.admin,'updateReviewTask',{...request,requestId:randomUUID()}),/changed/);
  const now=Date.now();f.cmd(f.admin,'updateReviewTask',{...f.fields(t),assigneeId:f.second.id,remainingQuantity:4,changeDue:true,duration:30,timeUnit:'minutes'});t=f.get(t.id);assert.ok(Date.parse(t.due_at)-now>=1800000&&Date.parse(t.due_at)-now<1801000);
  f.cmd(f.admin,'updateReviewTask',{...f.fields(t),assigneeId:f.second.id,remainingQuantity:4,changeDue:true,noDeadline:true});t=f.get(t.id);assert.equal(t.due_at,null);
  f.cmd(f.admin,'updateReviewTask',{...f.fields(t),assigneeId:f.second.id,remainingQuantity:4,duration:8,timeUnit:'hours'});t=f.get(t.id);assert.equal(t.due_at,null);
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=?").run(f.op.id);assert.throws(()=>f.cmd(f.admin,'updateReviewTask',{...f.fields(t),assigneeId:f.op.id,remainingQuantity:1}),/active operator/);
  const access=createAccessService({db:f.db}),role=access.saveRole(f.admin,{name:'Assign without deadline',capabilities:['work.view','work.assign','work.team','work.execute']});access.assign(f.admin,{userId:f.second.id,roleId:role});assert.throws(()=>f.cmd(f.second,'updateReviewTask',{...f.fields(t),assigneeId:f.second.id,remainingQuantity:4,changeDue:true,noDeadline:true}),/not permitted/);
  f.cmd(f.admin,'closeTask',{...f.fields(t),currentStatus:'no',verifiedClosure:true,workerStopped:true,actuals:[{cellId:t.lines[0].cell_id,quantity:0}]});t=f.get(t.id);assert.throws(()=>f.cmd(f.admin,'updateReviewTask',{...f.fields(t),assigneeId:f.second.id,remainingQuantity:1}),/Closed tasks/);
 }finally{f.db.close();}
});
test('unresolved assignment records intent without changing physical evidence or holds, and verified followup uses that remainder',()=>{
 const f=fixture();try{let t=f.create(f.op,{quantity:2});f.cmd(f.op,'askReview',{lineId:t.lines[0].id,reason:'Check physical work'});t=f.get(t.id);const before=f.physical();
  const req={...f.fields(t),assigneeId:f.second.id,remainingQuantity:3,changeDue:true,duration:1,timeUnit:'days',requestId:randomUUID()};f.cmd(f.admin,'updateReviewTask',req);assert.equal(f.cmd(f.admin,'updateReviewTask',req).replayed,true);t=f.get(t.id);assert.deepEqual(f.physical(),before);assert.equal(t.review_followup,1);assert.equal(t.requested_quantity,2);assert.equal(t.remaining_quantity,3);assert.equal(t.review_remaining_quantity,3);assert.equal(f.page(f.second,{remainingMin:3,remainingMax:3}).tasks[0].id,t.id);assert.throws(()=>f.cmd(f.second,'start',f.fields(t)),/check|verified/i);
  const r=t.lines.flatMap(l=>l.reports).find(r=>r.status==='review');f.cmd(f.admin,'resolve',{reportId:r.id,quantity:2,verification:'Spoke with operator',workerStopped:true});t=f.get(t.id);assert.equal(t.completed_at,null);assert.equal(t.review_handover_verified,1);assert.equal(t.remaining_quantity,3);
  f.cmd(f.second,'resumeFollowup',f.fields(t));t=f.get(t.id);assert.equal(t.requested_quantity,5);assert.equal(t.review_remaining_quantity,null);assert.equal(t.assignment_state,'offered');assert.equal(t.remaining_quantity,3);assert.equal(t.recorded_quantity,2);assert.equal(t.lines.filter(l=>l.execution_state==='ready').reduce((n,l)=>n+l.planned_quantity,0),3);
 }finally{f.db.close();}
});
test('closed partial progress remains numeric and late evidence returns to review without making closure editable',()=>{
 const f=fixture();try{let t=f.create(f.op,{quantity:10});f.cmd(f.op,'closeTask',{...f.fields(t),currentStatus:'no',actuals:[{cellId:t.lines[0].cell_id,quantity:3}]});t=f.get(t.id);const closed=f.page(f.op,{workState:'completed',remainingMin:7,remainingMax:7,progressMin:30,progressMax:30}).tasks[0];assert.equal(closed.id,t.id);assert.equal(closed.remaining_quantity,7);assert.equal(closed.work_progress,30);assert.equal(closed.work_status,'stopped');assert.equal(f.page(f.op).tasks.length,0);
  f.cmd(f.op,'report',{lineId:t.lines[0].id,revision:t.lines[0].revision,assignmentGeneration:t.assignment_generation,cellId:t.lines[0].cell_id,unit:t.lines[0].unit_of_measure,quantity:1,manual:true,reason:'Late paper evidence'});
  const pending=f.page(f.admin,{reviewOnly:1}).tasks[0];assert.equal(pending.id,t.id);assert.equal(pending.work_state,'review');assert.equal(pending.closed_actuals,true);assert.throws(()=>f.cmd(f.admin,'updateReviewTask',{...f.fields(pending),assigneeId:f.second.id,remainingQuantity:1}),/Closed tasks/);
 }finally{f.db.close();}
});
test('State sorting follows displayed labels A–Z and Z–A across all four states with stable ties',()=>{
 const f=fixture();try{
  const ids={not_started:[],in_progress:[],completed:[],review:[]};
  for(let i=0;i<2;i++)for(const state of Object.keys(ids)){
   const t=f.create();ids[state].push(t.id);
   if(state==='in_progress')f.cmd(f.op,'start',f.fields(t));
   if(state==='completed')f.cmd(f.op,'stop',f.fields(t));
   if(state==='review')f.cmd(f.op,'askReview',{lineId:t.lines[0].id,reason:'Check actual movement'});
  }
  const labels={review:'Needs Review',completed:'Task Completed',in_progress:'Task In Progress',not_started:'Task Not Started'};
  const ascending=f.page(f.op,{workState:'all',sort:'state',order:'asc'}).tasks;
  assert.deepEqual(ascending.map(t=>labels[t.work_state]),['Needs Review','Needs Review','Task Completed','Task Completed','Task In Progress','Task In Progress','Task Not Started','Task Not Started']);
  assert.deepEqual(ascending.map(t=>t.id),[...ids.review,...ids.completed,...ids.in_progress,...ids.not_started]);
  const descending=f.page(f.op,{workState:'all',sort:'state',order:'desc'}).tasks;
  assert.deepEqual(descending.map(t=>t.id),ascending.map(t=>t.id).reverse());
  assert.deepEqual(descending.map(t=>labels[t.work_state]),ascending.map(t=>labels[t.work_state]).reverse());
 }finally{f.db.close();}
});

test('progress bands include each boundary once, include 100%, and preserve operator scope',()=>{
 const f=fixture();try{
  const values=[0,24.9,25,49.9,50,74.9,75,100,125],ids=values.map(progress=>{const t=f.create();f.db.prepare('UPDATE tasks SET requested_quantity=100 WHERE id=?').run(t.id);f.db.prepare("UPDATE task_lines SET execution_state='settled',actual_quantity=? WHERE id=?").run(progress,t.lines[0].id);return t.id;});
  for(const [range,indexes] of [['0-25',[0,1]],['25-50',[2,3]],['50-75',[4,5]],['75-100',[6,7]]]){
   const page=f.page(f.op,{progressRange:range,sort:'task',order:'asc'});assert.deepEqual(page.tasks.map(t=>t.id),indexes.map(i=>ids[i]));assert.equal(page.taskPage.total,2);assert.equal(f.page(f.second,{progressRange:range}).taskPage.total,0);
  }
  assert.equal(f.page(f.op).taskPage.total,9);assert.throws(()=>f.page(f.op,{progressRange:'0-100'}),/listed progress range/);
 }finally{f.db.close();}
});

test('dropdown task and product selections match exact values while old search links remain usable',()=>{
 const f=fixture();try{
  const tasks=Array.from({length:12},()=>f.create());
  f.db.prepare("UPDATE products SET name='Boot' WHERE id=1").run();
  f.db.prepare("UPDATE products SET name='Boots' WHERE id=2").run();
  f.db.prepare('UPDATE task_lines SET product_id=2 WHERE task_id=?').run(tasks[1].id);
  assert.deepEqual(f.page(f.op,{taskSearch:`${tasks[0].id} pick`,taskSearchExact:'1'}).tasks.map(t=>t.id),[tasks[0].id]);
  const exact=f.page(f.op,{productSearch:'Boot',productSearchExact:'1'});assert.equal(exact.taskPage.total,11);assert.ok(exact.tasks.every(t=>t.id!==tasks[1].id));
  assert.equal(f.page(f.op,{productSearch:'Boot'}).taskPage.total,12);
  assert.equal(f.page(f.op,{statusSearch:'started',statusSearchExact:'1'}).taskPage.total,0);
  assert.equal(f.page(f.op,{statusSearch:'Not started',statusSearchExact:'1'}).taskPage.total,12);
  assert.equal(f.page(f.second,{productSearch:'Boot',productSearchExact:'1',pageSize:100}).taskPage.total,0);
 }finally{f.db.close();}
});
