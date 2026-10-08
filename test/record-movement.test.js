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
 process.chdir(mkdtempSync(join(tmpdir(),'lightguide-record-')));const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),p=db.prepare('SELECT * FROM products LIMIT 1').get(),cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 3').all();
 db.exec('DELETE FROM inventory_balances');db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,10,0)').run(p.id,cells[0].id);
 const input=rows=>({requestId:randomUUID(),productId:p.id,unit:p.unit_of_measure,confirmed:true,rows}),record=(rows,actor=op,more={})=>work.command(actor,'recordMovement',{...input(rows),...more}),q=cell=>db.prepare('SELECT available_quantity q FROM inventory_balances WHERE product_id=? AND cell_id=?').get(p.id,cell.id)?.q||0;
 return {db,work,admin,op,p,cells,input,record,q};
}
test('completed transfer records all rows immediately with exact cell and warehouse snapshots, no review or lights, and retries once',()=>{
 const f=fixture();try{
 const rows=[{direction:'pick',cellId:f.cells[0].id,quantity:4},{direction:'put',cellId:f.cells[1].id,quantity:4}],input=f.input(rows),result=f.work.command(f.op,'recordMovement',input);
 assert.equal(result.status,'recorded');assert.equal(f.q(f.cells[0]),6);assert.equal(f.q(f.cells[1]),4);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_reports').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_guidance').get().n,0);
 const entries=f.db.prepare('SELECT * FROM transactions ORDER BY id').all();assert.deepEqual(entries.map(t=>[t.quantity_before,t.quantity_after,t.product_quantity_before,t.product_quantity_after]),[[10,6,10,6],[0,4,6,10]]);
 assert.equal(f.work.command(f.op,'recordMovement',input).replayed,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,2);
 assert.throws(()=>f.work.command(f.op,'recordMovement',{...input,rows:[{...rows[0],quantity:3}]}),/different details/);
 const history=f.work.activityHistory(f.op);assert.equal(history.entries.length,2);assert.equal(history.entries[0].inventoryMovement,true);assert.equal(history.entries[0].actor,f.op.name);
 }finally{f.db.close();}
});
test('an invalid row rolls back the whole batch and absent-product or aggregate overdraw picks are rejected',()=>{
 const f=fixture();try{
 for(const rows of [[{direction:'put',cellId:f.cells[1].id,quantity:2},{direction:'pick',cellId:f.cells[2].id,quantity:1}],[{direction:'pick',cellId:f.cells[0].id,quantity:6},{direction:'pick',cellId:f.cells[0].id,quantity:5}]])assert.throws(()=>f.record(rows),/recorded here; cannot record a pick/);
 assert.equal(f.q(f.cells[0]),10);assert.equal(f.q(f.cells[1]),0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_receipts').get().n,0);
 const rows=[{direction:'put',cellId:f.cells[2].id,quantity:1}];assert.throws(()=>f.record(rows,f.op,{confirmed:false}),/Confirm/);assert.throws(()=>f.record(rows,f.op,{unit:'wrong'}),/unit changed/);assert.throws(()=>f.record(rows,f.op,{dataset:'old'}),/dataset changed/);
 assert.throws(()=>f.record([{direction:'pick',cellId:f.cells[0].id,quantity:-1}]),/non-negative/);
 }finally{f.db.close();}
});
test('Put can record any active location, including mixed storage, while role and actor scope are enforced',()=>{
 const f=fixture();try{
 const other=f.db.prepare('SELECT * FROM products WHERE id!=? LIMIT 1').get(f.p.id);f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,2,0)').run(other.id,f.cells[1].id);
 f.record([{direction:'put',cellId:f.cells[1].id,quantity:3}]);assert.equal(f.q(f.cells[1]),3);assert.equal(f.db.prepare('SELECT available_quantity q FROM inventory_balances WHERE product_id=? AND cell_id=?').get(other.id,f.cells[1].id).q,2);
 const access=createAccessService({db:f.db}),role=access.saveRole(f.admin,{name:'View only',capabilities:['work.view']});access.assign(f.admin,{userId:f.op.id,roleId:role});
 assert.throws(()=>f.record([{direction:'put',cellId:f.cells[1].id,quantity:1}]),/not permitted/);assert.equal(f.q(f.cells[1]),3);
 assert.equal(f.work.activityHistory(f.admin).entries.length,1);assert.equal(f.work.activityHistory(f.op).entries.length,1);
 }finally{f.db.close();}
});
