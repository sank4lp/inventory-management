import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {operationsRoutes} from '../src/modules/operations/routes.js';
import {PageScope} from '../public/client/page-lifecycle.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'active-assignments-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 db.exec('DELETE FROM inventory_balances');const cell=db.prepare('SELECT id FROM cells WHERE active=1 LIMIT 1').get();db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(1,?,40,0)').run(cell.id);
 const cmd=(actor,action,input)=>work.command(actor,action,{requestId:randomUUID(),...input});
 const create=(direction='pick')=>cmd(admin,'assign',{direction,productId:1,quantity:5,assigneeId:op.id,duration:8,timeUnit:'hours'}).taskId;
 const get=id=>work.task(admin,id),edit=(id,quantity=6)=>{const t=get(id);return {taskId:id,quantity,assigneeId:admin.id,generation:t.assignment_generation,progressToken:t.progress_token};};
 const records=()=>({tasks:db.prepare('SELECT * FROM tasks').all(),lines:db.prepare('SELECT * FROM task_lines').all(),reservations:db.prepare('SELECT * FROM work_reservations').all(),events:db.prepare('SELECT * FROM task_assignment_events').all(),stock:db.prepare('SELECT * FROM inventory_balances').all(),ledger:db.prepare('SELECT * FROM transactions').all()});
 return {db,work,admin,op,cmd,create,get,edit,records};
}
for(const direction of ['pick','put'])test(`admin saves a batch of unstarted ${direction} assignments atomically, retains deadlines and records history`,()=>{
 const f=fixture();try{
 const first=f.create(direction),second=f.create(direction),due=f.get(first).due_at,beforeStock=f.records().stock;
 const input={requestId:randomUUID(),edits:[f.edit(first,6),f.edit(second,7)]};
 const result=f.work.command(f.admin,'updateActiveAssignments',input);assert.equal(result.status,'recorded');assert.equal(f.work.command(f.admin,'updateActiveAssignments',input).replayed,true);
 for(const [id,quantity] of [[first,6],[second,7]]){const t=f.get(id);assert.equal(t.requested_quantity,quantity);assert.equal(t.assignee_id,f.admin.id);assert.equal(t.assignment_state,'offered');assert.ok(t.assignment_history.some(e=>e.event_type==='reassigned'));}
 assert.equal(f.get(first).due_at,due);assert.deepEqual(f.records().stock.map(r=>r.available_quantity),beforeStock.map(r=>r.available_quantity));assert.equal(f.records().ledger.length,0);
 }finally{f.db.close();}
});
test('operators, started tasks, stale edits, invalid quantities and ineligible assignees cannot alter the batch',()=>{
 const f=fixture();try{
 const first=f.create(),second=f.create(),old=f.edit(second);
 for(const input of [{edits:[f.edit(first),{...f.edit(second),quantity:0}]},{edits:[f.edit(first),{...f.edit(second),quantity:1.5}]},{edits:[f.edit(first),{...f.edit(second),assigneeId:999999}]},{edits:[f.edit(first),{...f.edit(second),progressToken:'old'}]}]){const before=f.records();assert.throws(()=>f.cmd(f.admin,'updateActiveAssignments',input));assert.deepEqual(f.records(),before);}
 const before=f.records();assert.throws(()=>f.cmd(f.op,'updateActiveAssignments',{edits:[f.edit(first)]}));assert.deepEqual(f.records(),before);
 f.cmd(f.op,'start',{taskId:second,generation:old.generation,progressToken:old.progressToken});const started=f.records();assert.throws(()=>f.cmd(f.admin,'updateActiveAssignments',{edits:[f.edit(first),old]}),/no longer unstarted|assignment changed/);assert.deepEqual(f.records(),started);assert.throws(()=>f.cmd(f.admin,'updateActiveAssignments',{edits:[f.edit(second)]}),/no longer unstarted/);assert.deepEqual(f.records(),started);
 }finally{f.db.close();}
});
test('planning failure in a later row rolls back every earlier edit',()=>{
 const f=fixture();try{const first=f.create(),second=f.create(),before=f.records();assert.throws(()=>f.cmd(f.admin,'updateActiveAssignments',{edits:[f.edit(first,7),f.edit(second,1000000)]}));assert.deepEqual(f.records(),before);}finally{f.db.close();}
});
test('active view is always active-only and cannot widen scope through query parameters',()=>{
 const f=fixture();try{const id=f.create(),other=f.cmd(f.admin,'assign',{direction:'pick',productId:1,quantity:4,assigneeId:f.admin.id}).taskId,t=f.get(id);assert.ok(f.work.snapshot(f.admin,{view:'active',activeOnly:0,scope:'mine'}).tasks.some(t=>t.id===other));assert.ok(!f.work.snapshot(f.op,{view:'active',scope:'team',taskId:other}).tasks.some(t=>t.id===other));f.cmd(f.admin,'stop',{taskId:id,generation:t.assignment_generation,progressToken:t.progress_token,reason:'No movement'});assert.ok(!f.work.snapshot(f.admin,{view:'active',activeOnly:0,taskId:id}).tasks.some(t=>t.id===id));}finally{f.db.close();}
});
const source=readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8').replace('export async function mount() {','').split('let syncing=false;')[0];
function ui(role='admin'){
 const save={disabled:true,textContent:'Save'},feedback={textContent:''},root={querySelector:s=>s==='[data-save-active-assignments]'?save:s==='[data-active-save-feedback]'?feedback:null,querySelectorAll:()=>[]};
 const context=vm.createContext({document:{querySelector:s=>s==='#work-app'?root:null},crypto:{randomUUID:()=> 'test'},localStorage:{getItem:()=> 'test'},URLSearchParams,location:{pathname:'/work/active-assignments',search:''}});
 vm.runInContext(source,context);context.fixture={site:'a',dataset:'a',user:{id:1,role},operators:[{id:2,name:'Worker',role:'operator',eligible:true,status:'active'}],tasks:[{id:7,type:'pick',requested_quantity:5,remaining_quantity:5,recorded_quantity:0,assignee_id:2,assignee_name:'Worker',assignment_generation:1,progress_token:'original',assignment_state:'offered',outcome:'open',work_state:'not_started',lines:[{product_id:1,product_name:'Product A',unit_of_measure:'pieces'}]}]};vm.runInContext('snapshot=fixture;online=true',context);return {context,save,run:s=>vm.runInContext(s,context)};
}
test('active table omits snapshots, preselects the assignee and renders editors only for unstarted admin rows',()=>{
 const f=ui(),html=f.run('myTaskRow(snapshot.tasks[0])'),head=f.run('workTableHead()');assert.match(html,/value="2" selected/);assert.match(html,/data-active-quantity[^>]*value="5"/);assert.match(head,/Assigned To/);assert.doesNotMatch(head,/Details before|Details after/);assert.match(f.run('workTableFilters()'),/name="activeOnly"[^>]*checked disabled/);
 assert.doesNotMatch(ui('operator').run('myTaskRow(snapshot.tasks[0])'),/data-active-assignee|data-active-quantity/);
 assert.doesNotMatch(f.run("myTaskRow({...snapshot.tasks[0],work_state:'in_progress',assignment_state:'started'})"),/data-active-assignee|data-active-quantity/);
 assert.doesNotMatch(f.run("myTaskRow({...snapshot.tasks[0],work_state:'review',attention:1})"),/data-active-assignee|data-active-quantity/);
});
test('Save is disabled until a real field edit; reverting clears dirty state and live snapshots do not change its original token',()=>{
 const f=ui(),fields={'[data-active-assignee]':{value:'2'},'[data-active-quantity]':{value:'5'}},row={dataset:{taskRow:'7'},querySelector:s=>fields[s]},field={closest:()=>row};f.context.field=field;
 f.run('changeActiveAssignment(field)');assert.equal(f.save.disabled,true);
 fields['[data-active-quantity]'].value='6';f.run('changeActiveAssignment(field)');assert.equal(f.save.disabled,false);f.run("snapshot.tasks[0].progress_token='changed'");f.run('changeActiveAssignment(field)');assert.equal(f.run('activeAssignmentEdits.get(7).base.progressToken'),'original');
 fields['[data-active-quantity]'].value='5';f.run('changeActiveAssignment(field)');assert.equal(f.save.disabled,true);assert.equal(f.run('activeAssignmentEdits.size'),0);
});
test('cancelled navigation does not run cleanup or dispose the page, while confirmed departure runs it once',async()=>{
 const scope=new PageScope();let allow=false,cleanup=0;scope.guardLeave(async()=>allow);scope.beforeLeave(()=>cleanup++);if(await scope.canLeave())await scope.leave();assert.equal(cleanup,0);assert.equal(scope.active,true);allow=true;if(await scope.canLeave())await scope.leave();assert.equal(cleanup,1);scope.dispose();assert.equal(scope.guards.length,0);
});

test('active snapshot API does not append a closed task supplied in the URL',async()=>{
 const f=fixture();try{const id=f.create(),t=f.get(id);f.cmd(f.admin,'stop',{taskId:id,generation:t.assignment_generation,progressToken:t.progress_token,reason:'No movement'});let body;
 const response={writeHead(){},end(value){body=JSON.parse(value);}};
 await operationsRoutes({method:'GET'},response,new URL(`http://warehouse/api/work/snapshot?view=active&activeOnly=0&taskId=${id}`),f.admin,{db:f.db,operationsService:f.work});assert.ok(!body.tasks.some(t=>t.id===id));
 }finally{f.db.close();}
});

test('default task lists isolate operators and give admins all assignments, including work created by another operator',()=>{
 const f=fixture();try{
 f.db.prepare("INSERT INTO users(name,username,password_hash,role,status,created_at) VALUES('Second Worker','second-worker',?,'operator','active',?)").run(hashPassword('test'),new Date().toISOString());const other=f.db.prepare("SELECT * FROM users WHERE username='second-worker'").get();
 const own=f.create(),otherId=f.cmd(other,'create',{direction:'pick',productId:1,quantity:2}).taskId;
 for(const view of ['mine','active','history']){
  const adminIds=f.work.snapshot(f.admin,{view}).tasks.map(t=>t.id);assert.ok(adminIds.includes(own));assert.ok(adminIds.includes(otherId));
  const operatorIds=f.work.snapshot(f.op,{view}).tasks.map(t=>t.id);assert.ok(operatorIds.includes(own));assert.ok(!operatorIds.includes(otherId));
 }
 assert.ok(f.work.activityHistory(f.admin).entries.some(e=>e.taskId===otherId));assert.ok(!f.work.activityHistory(f.op).entries.some(e=>e.taskId===otherId));assert.throws(()=>f.work.task(f.op,otherId),/another operator/);
 const t=f.get(own),input={taskId:own,generation:t.assignment_generation,progressToken:t.progress_token,assigneeId:other.id};
 for(const action of ['assign','reassign','updateReviewTask','assignReview','updateReturned'])assert.throws(()=>f.cmd(f.op,action,{...input,direction:'pick',productId:1,quantity:2,remainingQuantity:2}),/not permitted/);
 f.cmd(f.admin,'updateReviewTask',{...input,remainingQuantity:5});assert.ok(!f.work.snapshot(f.op,{view:'active'}).tasks.some(t=>t.id===own));assert.ok(f.work.snapshot(f.op,{view:'history'}).tasks.some(t=>t.id===own));assert.ok(f.work.snapshot(other,{view:'active'}).tasks.some(t=>t.id===own));
 }finally{f.db.close();}
});
