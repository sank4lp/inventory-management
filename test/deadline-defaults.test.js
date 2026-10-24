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
import {readDeadlineDefaults,deadlineDefaultsPatch,stocktakeDefaultDueDate} from '../src/services/deadline-defaults.js';

function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'lyt-deadline-defaults-')));
 const db=createDatabase({hashPassword,allowDevAuthSeeds:true,allowDemoInventorySeed:true}),at=new Date('2026-10-31T20:00:00Z'),clock=()=>at;
 const work=createOperationsService({db,clock}),count=createStocktakingService({db,operationsService:work,clock});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),product=db.prepare('SELECT * FROM products LIMIT 1').get(),cell=db.prepare('SELECT * FROM cells WHERE active=1 LIMIT 1').get();
 db.exec('DELETE FROM inventory_balances');db.prepare('UPDATE products SET items_per_cell=100 WHERE id=?').run(product.id);db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,50,0)').run(product.id,cell.id);
 const command=(action,input={},actor=admin)=>work.command(actor,action,{requestId:randomUUID(),...input}),ccommand=(action,input={})=>count.command(admin,action,{requestId:randomUUID(),...input});
 const assign=(direction,extra={})=>work.task(admin,command('assign',{direction,productId:product.id,quantity:1,assigneeId:op.id,...extra}).taskId);
 const stocktake=(extra={})=>ccommand('create',{mode:'selected',cellIds:[cell.id],counterIds:[op.id],...extra}).runId;
 return {db,at,clock,work,count,admin,op,product,cell,command,ccommand,assign,stocktake};
}
const settings={enabled:true,minutes:120,inactivityMinutes:5,pickDueDuration:30,pickDueUnit:'minutes',putDueDuration:2,putDueUnit:'days',stocktakeDueEnabled:true,stocktakeDueDays:3};

test('saved defaults apply to new assignments, allow explicit deadlines, survive restart and leave existing tasks unchanged',()=>{
 const f=fixture();try{
  assert.deepEqual(readDeadlineDefaults(f.db),{pickMinutes:480,putMinutes:480,stocktakeDays:null});
  const oldPick=f.assign('pick'),oldPut=f.assign('put'),oldCount=f.stocktake();
  assert.equal(Date.parse(oldPick.due_at)-Date.parse(oldPick.assigned_at),8*3600000);assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE id=?').get(oldCount).due_date,null);
  f.command('timing',settings);
  assert.equal(f.work.task(f.admin,oldPick.id).due_at,oldPick.due_at);assert.equal(f.work.task(f.admin,oldPut.id).due_at,oldPut.due_at);assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE id=?').get(oldCount).due_date,null);
  const pick=f.assign('pick'),put=f.assign('put');assert.equal(Date.parse(pick.due_at)-Date.parse(pick.assigned_at),30*60000);assert.equal(Date.parse(put.due_at)-Date.parse(put.assigned_at),2*86400000);
  const overridden=f.assign('pick',{dueDuration:1,dueUnit:'hours'});assert.equal(Date.parse(overridden.due_at)-Date.parse(overridden.assigned_at),3600000);
  const viaCreate=f.command('create',{direction:'put',productId:f.product.id,quantity:1,assigneeId:f.op.id});const created=f.work.task(f.admin,viaCreate.taskId);assert.equal(Date.parse(created.due_at)-Date.parse(created.assigned_at),2*86400000);
  const explicit=f.command('create',{direction:'pick',productId:f.product.id,quantity:1,assigneeId:f.op.id,dueAt:'2026-11-09T10:00:00Z'});assert.equal(f.work.task(f.admin,explicit.taskId).due_at,'2026-11-09T10:00:00.000Z');
  const self=f.command('create',{direction:'pick',productId:f.product.id,quantity:1});const selfTask=f.work.task(f.admin,self.taskId);assert.equal(Date.parse(selfTask.due_at)-Date.parse(selfTask.assigned_at),120*60000,'self-start rule remains separate');
  const persisted=readDeadlineDefaults(f.db);f.db.close();
  const reopened=createDatabase({hashPassword,allowDevAuthSeeds:true,allowDemoInventorySeed:true});try{assert.deepEqual(readDeadlineDefaults(reopened),persisted);const next=createOperationsService({db:reopened,clock:f.clock});assert.deepEqual(next.snapshot(f.admin).timing.deadlineDefaults,persisted);assert.equal(next.task(f.admin,oldPick.id).due_at,oldPick.due_at);}finally{reopened.close();}
 }finally{try{f.db.close();}catch{}}
});

test('stocktake default uses warehouse calendar days; explicit dates, no-deadline choice and recurring schedule take precedence',()=>{
 const f=fixture();try{
  f.command('timing',settings);
  const run=f.stocktake();assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE id=?').get(run).due_date,'2026-11-04');
  assert.equal(f.count.snapshot(f.admin).defaultDueDate,'2026-11-04');
  assert.equal(stocktakeDefaultDueDate(f.db,f.at,'America/New_York'),'2026-11-03','uses the warehouse local calendar across DST');
  assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE id=?').get(f.stocktake({dueDate:''})).due_date,null);
  assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE id=?').get(f.stocktake({dueDate:'2026-11-20'})).due_date,'2026-11-20');
  f.ccommand('schedule',{revision:0,mode:'selected',cellIds:[f.cell.id],assigneeId:f.op.id,frequency:'weekly',nextDue:'2026-11-01',timezone:'Asia/Kolkata',enabled:true});f.count.tick();
  assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE occurrence IS NOT NULL').get().due_date,'2026-11-01');
  f.command('timing',{enabled:true,minutes:120,stocktakeDueEnabled:false});assert.equal(readDeadlineDefaults(f.db).stocktakeDays,null);assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE id=?').get(run).due_date,'2026-11-04');assert.equal(f.db.prepare('SELECT due_date FROM stocktake_runs WHERE id=?').get(f.stocktake()).due_date,null);
 }finally{f.db.close();}
});

test('defaults validate as one save, preserve omitted settings, and require stocktake management permission',()=>{
 const f=fixture();try{
  f.command('timing',settings);const before=readDeadlineDefaults(f.db),oldWarning=f.work.snapshot(f.admin).timing.minutes;
  for(const invalid of [{pickDueDuration:0,pickDueUnit:'minutes'},{putDueDuration:366,putDueUnit:'days'},{pickDueDuration:'',pickDueUnit:'hours'},{putDueDuration:1,putDueUnit:'years'},{stocktakeDueDays:1.5},{stocktakeDueDays:0},{stocktakeDueDays:366}]){
   assert.throws(()=>f.command('timing',{...settings,minutes:99,...invalid}),/default/);assert.deepEqual(readDeadlineDefaults(f.db),before);assert.equal(f.work.snapshot(f.admin).timing.minutes,oldWarning);
  }
  f.command('timing',{enabled:true,minutes:240});assert.deepEqual(readDeadlineDefaults(f.db),before,'older clients keep defaults they do not submit');
  const access=createAccessService({db:f.db}),role=access.saveRole(f.admin,{name:'Work timing manager',capabilities:['work.view','work.team','work.timing']}),manager=access.assign(f.admin,{userId:f.op.id,roleId:role});
  f.command('timing',{enabled:true,minutes:240,pickDueDuration:45,pickDueUnit:'minutes'},manager);assert.equal(readDeadlineDefaults(f.db).pickMinutes,45);
  assert.throws(()=>f.command('timing',{enabled:true,minutes:20,stocktakeDueEnabled:true,stocktakeDueDays:5},manager),/Stocktake manager/);assert.equal(f.work.snapshot(f.admin).timing.minutes,240);assert.equal(readDeadlineDefaults(f.db).stocktakeDays,3);
  assert.equal(f.work.snapshot(manager).capabilities.countManage,false);
  const events=f.db.prepare("SELECT payload FROM work_events WHERE event_type='work_timing_changed' ORDER BY id DESC LIMIT 1").get();assert.equal(JSON.parse(events.payload).deadlineDefaults.pickMinutes,45);
  assert.deepEqual(deadlineDefaultsPatch({}),{});
 }finally{f.db.close();}
});
