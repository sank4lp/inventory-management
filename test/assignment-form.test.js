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
import {routeAllowed} from '../src/modules/access/routes-policy.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'lightguide-assign-form-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db}),access=createAccessService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const person=(username,caps,status='active')=>{db.prepare("INSERT INTO users(name,username,password_hash,role,status,created_at) VALUES('Same Name',?,?,'operator',?,?)").run(username,hashPassword('test'),status,new Date().toISOString());const u=db.prepare('SELECT * FROM users WHERE username=?').get(username);if(caps){const role=access.saveRole(admin,{name:username,capabilities:caps});access.assign(admin,{userId:u.id,roleId:role});}return status==='active'?currentActor(db,u):u;};
 const command=(actor,action,input={})=>work.command(actor,action,{requestId:randomUUID(),...input});
 const assign=(actor,input={})=>command(actor,'assign',{direction:'pick',productId:1,quantity:.001,assigneeId:op.id,...input});
 return {db,work,access,admin,op,person,command,assign};
}
test('assignment duration is server-relative, defaults to eight hours, and does not alter legacy timing or prior tasks',()=>{
 const f=fixture();f.command(f.admin,'timing',{enabled:false,inactivityMinutes:7});
 const first=f.work.task(f.admin,f.assign(f.admin).taskId);assert.equal(Date.parse(first.due_at)-Date.parse(first.assigned_at),8*3600000);
 for(const [dueDuration,dueUnit,minutes] of [[1,'minutes',1],[1.5,'hours',90],[.5,'days',720],[365,'days',525600]]){const t=f.work.task(f.admin,f.assign(f.admin,{dueDuration,dueUnit}).taskId);assert.equal(Date.parse(t.due_at)-Date.parse(t.assigned_at),minutes*60000);const event=t.assignment_history[0];assert.equal(JSON.parse(event.payload).durationMinutes,minutes);}
 const own=f.command(f.op,'create',{direction:'pick',productId:1,quantity:.001});assert.equal(f.work.task(f.op,own.taskId).due_at,null);assert.equal(f.work.task(f.admin,first.id).due_at,first.due_at);assert.equal(f.work.snapshot(f.admin).timing.inactivityMinutes,7);f.db.close();
});
test('invalid assignment durations roll back task, reservation and receipt creation',()=>{
 const f=fixture(),before=f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
 for(const input of [{dueDuration:0,dueUnit:'hours'},{dueDuration:-1,dueUnit:'hours'},{dueDuration:.5,dueUnit:'minutes'},{dueDuration:366,dueUnit:'days'},{dueDuration:525601,dueUnit:'minutes'},{dueDuration:8761,dueUnit:'hours'},{dueDuration:'Infinity',dueUnit:'hours'},{dueDuration:'abc',dueUnit:'hours'},{dueDuration:'',dueUnit:'hours'},{dueDuration:null,dueUnit:'hours'},{dueDuration:true,dueUnit:'hours'},{dueDuration:[],dueUnit:'hours'},{dueDuration:8,dueUnit:'weeks'},{dueDuration:8},{dueUnit:'hours'}])assert.throws(()=>f.assign(f.admin,input),/due duration/);
 assert.throws(()=>f.assign(f.admin,{assigneeId:''}),/Choose a person/);assert.throws(()=>f.assign(f.admin,{dueAt:'2027-01-01'}),/due duration/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_reservations').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_receipts').get().n,0);f.db.close();
});
test('assignment retry returns the original result and deadline, and changed payload cannot create a second task',()=>{
 const f=fixture(),input={requestId:randomUUID(),direction:'pick',productId:1,quantity:1,assigneeId:f.op.id,dueDuration:8,dueUnit:'hours'};
 const first=f.work.command(f.admin,'assign',input),t=f.work.task(f.admin,first.taskId);
 f.command(f.admin,'timing',{enabled:true,minutes:3});const retry=f.work.command(f.admin,'assign',input);assert.equal(retry.replayed,true);assert.equal(retry.taskId,first.taskId);assert.equal(f.work.task(f.admin,first.taskId).due_at,t.due_at);assert.match(retry.message,/Task assigned to/);
 assert.throws(()=>f.work.command(f.admin,'assign',{...input,dueDuration:9}),/different details/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);assert.equal(f.work.task(f.admin,first.taskId).assignment_history.length,1);f.db.close();
});
test('assignment permission admits the form without team visibility and independently enforces actual direction and deadline override rights',()=>{
 const f=fixture(),picker=f.person('pick-assigner',['work.view','work.assign','work.pick']),putter=f.person('put-assigner',['work.view','work.assign','work.put']),viewer=f.person('team-viewer',['work.view','work.team']);
 assert.equal(routeAllowed(picker,'GET','/work/overview'),true);assert.equal(routeAllowed(viewer,'GET','/work/overview'),false);assert.throws(()=>f.work.snapshot(viewer,{view:'assign'}),/not permitted/);
 const snapshot=f.work.snapshot(picker,{view:'assign'});assert.equal(snapshot.capabilities.teamView,false);assert.equal(snapshot.capabilities.deadline,false);assert.equal(snapshot.tasks.length,0);assert.ok(snapshot.products.length);assert.ok(snapshot.operators.some(u=>u.id===f.admin.id&&u.eligible));assert.equal(snapshot.operators.some(u=>'open' in u||'inProgress' in u||'overdue' in u||'review' in u),false);
 const assigned=f.assign(picker);assert.equal(f.work.task(picker,assigned.taskId).assigned_by,picker.id);assert.throws(()=>f.assign(picker,{direction:'put'}),/not permitted/);assert.throws(()=>f.assign(putter),/not permitted/);assert.ok(f.assign(putter,{direction:'put'}).taskId);assert.throws(()=>f.assign(viewer),/not permitted/);assert.throws(()=>f.work.snapshot(picker,{view:'history',scope:'team'}),/not permitted/);
 const t=f.work.task(picker,assigned.taskId);f.command(picker,'reassign',{taskId:t.id,generation:t.assignment_generation,assigneeId:f.admin.id});assert.throws(()=>f.command(picker,'deadline',{taskId:t.id,generation:2,dueAt:'2027-01-01',reason:'Override'}),/not permitted/);assert.throws(()=>f.command(picker,'create',{direction:'pick',productId:1,quantity:.001,assigneeId:f.op.id,dueAt:'2027-01-01'}),/not permitted/);
 const other=f.assign(f.admin);assert.throws(()=>f.work.task(picker,other.taskId),/another operator/);assert.throws(()=>f.command(picker,'reassign',{taskId:other.taskId,generation:1,assigneeId:f.op.id}),/another operator/);f.db.close();
});
test('all account types are listed, eligible admins and custom roles can receive work, inactive and non-executors cannot',()=>{
 const f=fixture(),custom=f.person('custom-executor',['work.view','work.execute']),readonly=f.person('custom-reader',['work.view']),inactive=f.person('inactive',null,'inactive');
 const list=f.work.snapshot(f.admin,{view:'assign'}).operators;for(const u of [f.admin,f.op,custom,readonly,inactive])assert.ok(list.some(v=>v.id===u.id));assert.equal(list.find(u=>u.id===custom.id).eligible,true);assert.equal(list.find(u=>u.id===readonly.id).eligible,false);assert.equal(list.find(u=>u.id===inactive.id).eligible,false);
 for(const u of [f.admin,f.op,custom]){const t=f.work.task(f.admin,f.assign(f.admin,{assigneeId:u.id}).taskId);assert.equal(t.assignee_id,u.id);assert.equal(t.assignment_state,'offered');}
 for(const u of [readonly,inactive,{id:999999}])assert.throws(()=>f.assign(f.admin,{assigneeId:u.id}),/eligible to execute/);f.db.close();
});

test('assignment dropdown counts all unfinished tasks, follows reassignment and excludes closed tasks without granting team access',()=>{
 const f=fixture(),delegate=f.person('assign-only',['work.view','work.assign','work.pick']),lead=f.person('shift-lead',['work.view','work.execute','work.pick']);
 const row=id=>f.work.snapshot(delegate,{view:'assign'}).operators.find(u=>u.id===id);
 assert.equal(row(f.op.id).assignedTaskCount,0);assert.equal(row(lead.id).role_name,'shift-lead');assert.equal(row(f.admin.id).role_name,'Admin');
 const first=f.assign(f.admin).taskId,second=f.assign(f.admin).taskId;
 assert.equal(row(f.op.id).assignedTaskCount,2);
 const task=f.work.task(f.admin,first);f.command(f.admin,'reassign',{taskId:first,generation:task.assignment_generation,assigneeId:lead.id});
 assert.equal(row(f.op.id).assignedTaskCount,1);assert.equal(row(lead.id).assignedTaskCount,1);
 const remaining=f.work.task(f.op,second);f.command(f.op,'stop',{taskId:second,generation:remaining.assignment_generation});
 assert.equal(row(f.op.id).assignedTaskCount,0);
 const view=f.work.snapshot(delegate,{view:'assign'});assert.equal(view.tasks.length,0);assert.equal(view.capabilities.teamView,false);assert.equal('inProgress' in row(lead.id),false);f.db.close();
});
