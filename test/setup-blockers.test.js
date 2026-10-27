import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {guardSetupChange} from '../src/modules/operations/guards.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'setup-blockers-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:false}),work=createOperationsService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const cells=db.prepare('SELECT * FROM cells WHERE active=1 LIMIT 3').all(),product=db.prepare('SELECT * FROM products LIMIT 1').get();
 db.exec('DELETE FROM inventory_balances');db.prepare('UPDATE products SET items_per_cell=100 WHERE id=?').run(product.id);
 db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,20,0)').run(product.id,cells[0].id);
 const cmd=(action,input={},actor=admin)=>work.command(actor,action,{requestId:randomUUID(),...input});
 const create=(quantity=2,actor=admin)=>cmd('create',{direction:'pick',productId:product.id,quantity},actor);
 const details=()=>work.setupBlockers(admin,{});
 const discard=(tasks,extra={})=>cmd('discardSetupTasks',{scope:{},tasks:tasks.map(t=>({id:t.id,token:t.token})),confirmed:true,...extra});
 return {db,work,admin,op,cells,product,cmd,create,details,discard};
}
test('guard exposes a structured scoped conflict; list contains exact task details, not an inferred active-task list',()=>{
 const f=fixture(),t=f.create();
 assert.throws(()=>guardSetupChange(f.db,{cellId:f.cells[0].id}),e=>e.code==='OUTSTANDING_WORK'&&e.statusCode===409&&e.scope.cellId===f.cells[0].id);
 const data=f.details();assert.equal(data.remaining,1);assert.equal(data.tasks[0].id,t.taskId);assert.equal(data.tasks[0].lines[0].product,f.product.name);assert.equal(data.tasks[0].lines[0].location,f.cells[0].display_name||f.cells[0].logical_code);assert.equal(data.tasks[0].lines[0].planned_quantity,2);assert.ok(data.tasks[0].assignee);assert.equal(data.tasks[0].canDiscard,true);
 assert.equal(f.work.setupBlockers(f.admin,{cellId:f.cells[1].id}).remaining,0);assert.throws(()=>f.work.setupBlockers(f.admin,{cellId:'oops'}),/valid/);f.db.close();
});
test('discard selected tasks is atomic, replay-safe, preserves stock and history, and unblocks setup',()=>{
 const f=fixture();f.create();f.create();const tasks=f.details().tasks,before=f.db.prepare('SELECT available_quantity FROM inventory_balances').all();
 const input={requestId:randomUUID(),scope:{},tasks:tasks.map(t=>({id:t.id,token:t.token})),confirmed:true};
 const result=f.work.command(f.admin,'discardSetupTasks',input);assert.equal(result.remaining,0);assert.equal(result.status,'recorded');assert.equal(f.work.command(f.admin,'discardSetupTasks',input).replayed,true);assert.deepEqual(f.db.prepare('SELECT available_quantity FROM inventory_balances').all(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,2);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reservations WHERE state='held'").get().n,0);assert.doesNotThrow(()=>guardSetupChange(f.db));f.db.close();
});
test('stale task and partial batch rejection cannot cancel other selected work',()=>{
 const f=fixture();f.create();f.create();const tasks=f.details().tasks;f.db.prepare('UPDATE task_lines SET planned_quantity=planned_quantity+1,revision=revision+1 WHERE task_id=?').run(tasks[1].id);
 assert.throws(()=>f.discard(tasks),/changed/);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reservations WHERE state='held'").get().n,2);assert.throws(()=>f.discard([tasks[0]],{confirmed:false}),/Confirm/);f.db.close();
});
test('discard of started work retains pending evidence unless an authorized verifier confirms no additional movement',()=>{
 const f=fixture(),t=f.create(),l=f.work.task(f.admin,t.taskId).lines[0];f.cmd('acquire',{lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});
 const before=f.db.prepare('SELECT available_quantity FROM inventory_balances').all();const stopped=f.discard(f.details().tasks);assert.equal(stopped.remaining,1);assert.equal(stopped.status,'review');assert.ok(f.details().tasks[0].reports.length);assert.deepEqual(f.db.prepare('SELECT available_quantity FROM inventory_balances').all(),before);
 const closed=f.discard(f.details().tasks,{verifiedNoAdditionalMovement:true});assert.equal(closed.remaining,0);assert.deepEqual(f.db.prepare('SELECT available_quantity FROM inventory_balances').all(),before);assert.ok(f.db.prepare("SELECT 1 FROM work_reports WHERE status='resolved'").get());assert.doesNotThrow(()=>guardSetupChange(f.db));f.db.close();
});
test('verified discard retains recorded movements while closing only the pending remainder',()=>{
 const f=fixture(),t=f.create(4),l=f.work.task(f.admin,t.taskId).lines[0];f.cmd('acquire',{lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});f.cmd('report',{lineId:l.id,revision:f.work.line(l.id).revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity:2,deviceId:'test'});
 // A late conflicting entry creates a pending review without replacing the posted two.
 f.cmd('report',{lineId:l.id,revision:l.revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity:3,deviceId:'test'});
 const before=f.db.prepare('SELECT available_quantity FROM inventory_balances').all(),history=f.db.prepare('SELECT * FROM transactions').all();
 const result=f.discard(f.details().tasks,{verifiedNoAdditionalMovement:true});assert.equal(result.remaining,0);assert.deepEqual(f.db.prepare('SELECT available_quantity FROM inventory_balances').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM transactions').all(),history);f.db.close();
});
test('manual pending entries require explicit verification and keep original evidence after discard',()=>{
 const f=fixture();f.cmd('manual',{productId:f.product.id,cellId:f.cells[0].id,direction:'pick',quantity:2,unit:f.product.unit_of_measure,reason:'Test entry; no physical movement',performerId:'unknown'});
 const data=f.details(),entry=data.manual[0];assert.ok(entry);assert.equal(data.remaining,1);const before=f.db.prepare('SELECT available_quantity FROM inventory_balances').all();
 assert.throws(()=>f.discard([],{reports:[{id:entry.id,token:entry.token}]}),/verifier/);
 const result=f.discard([],{reports:[{id:entry.id,token:entry.token}],verifiedNoAdditionalMovement:true});assert.equal(result.remaining,0);assert.deepEqual(f.db.prepare('SELECT available_quantity FROM inventory_balances').all(),before);assert.equal(f.db.prepare('SELECT status FROM work_reports WHERE id=?').get(entry.id).status,'resolved');f.db.close();
});
test('location management alone cannot see or discard another operator’s tasks or verify pending movement',()=>{
 const f=fixture();f.create(2,f.op);f.create(1);const role='setup-only';
 f.db.prepare('INSERT INTO access_roles(id,name,capabilities_json) VALUES(?,?,?)').run(role,'Setup only',JSON.stringify(['locations.manage','locations.view']));
 f.db.prepare('UPDATE users SET role_id=? WHERE id=?').run(role,f.op.id);
 const visible=f.work.setupBlockers(f.op,{});assert.equal(visible.tasks[0]?.canDiscard,false);assert.equal(visible.hiddenCount,1);assert.equal(visible.tasks.length,1);assert.throws(()=>f.cmd('discardSetupTasks',{scope:{},tasks:visible.tasks.map(t=>({id:t.id,token:t.token})),confirmed:true},f.op),/permission|permitted|cannot/);f.db.close();
});
test('own-task stopping permission cannot be used to assert supervisor verification',()=>{
 const f=fixture(),t=f.create(2,f.op),l=f.work.task(f.op,t.taskId).lines[0];f.cmd('acquire',{lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'},f.op);
 const role='setup-stop-own';f.db.prepare('INSERT INTO access_roles(id,name,capabilities_json) VALUES(?,?,?)').run(role,'Setup and stop own',JSON.stringify(['locations.manage','locations.view','work.view','work.stop']));f.db.prepare('UPDATE users SET role_id=? WHERE id=?').run(role,f.op.id);
 const data=f.work.setupBlockers(f.op,{});assert.equal(data.tasks[0].canDiscard,true);assert.equal(data.tasks[0].canVerify,false);
 assert.throws(()=>f.cmd('discardSetupTasks',{scope:{},tasks:data.tasks.map(t=>({id:t.id,token:t.token})),confirmed:true,verifiedNoAdditionalMovement:true},f.op),/authorized verifier/);assert.equal(f.db.prepare('SELECT execution_state FROM task_lines WHERE id=?').get(l.id).execution_state,'working');f.db.close();
});
