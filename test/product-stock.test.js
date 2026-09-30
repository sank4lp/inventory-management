import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {operationsRoutes} from '../src/modules/operations/routes.js';
import {createAccessService,currentActor} from '../src/modules/access/service.js';
import {routeAllowed} from '../src/modules/access/routes-policy.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'lyt-product-stock-')));const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db}),access=createAccessService({db});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),p=db.prepare('SELECT * FROM products LIMIT 1').get();
 const cells=db.prepare('SELECT * FROM cells ORDER BY id LIMIT 3').all();db.exec('DELETE FROM inventory_balances; UPDATE cells SET active=0');for(const c of cells)db.prepare('UPDATE cells SET active=1 WHERE id=?').run(c.id);db.prepare('UPDATE products SET items_per_cell=10 WHERE id=?').run(p.id);
 const stock=(c,q)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0)').run(p.id,c.id,q);
 const command=(actor,action,input={})=>work.command(actor,action,{requestId:randomUUID(),...input});const create=(actor,direction,quantity,c)=>command(actor,'create',{productId:p.id,direction,quantity,preferredCellId:c.id});
 const read=actor=>work.productStock(actor,{productId:p.id});return {db,work,access,admin,op,p,cells,stock,command,create,read};
}
test('fresh stock read separates recorded, held picks, incoming puts and compatible put space; no writes or guidance',async()=>{
 const f=fixture();try{const [a,b]=f.cells;f.stock(a,8);f.stock(b,4);f.create(f.op,'pick',3,a);f.create(f.admin,'pick',2,b);f.create(f.admin,'put',2,a);
 // A stale denormalized number must never drive this summary.
 f.db.prepare('UPDATE inventory_balances SET reserved_quantity=99').run();const changes=f.db.prepare('SELECT total_changes() n').get().n;
 let writes=0;const work=createOperationsService({db:f.db,hardwareService:{activateGuidance(){writes++;return {ok:true};}}});
 const value=work.productStock(f.admin,{productId:f.p.id});assert.equal(value.recorded,12);assert.equal(value.pickReserved,5);assert.equal(value.incomingReserved,2);assert.equal(value.availableToPick,7);assert.equal(value.putCapacity,16);assert.equal(value.unit,f.p.unit_of_measure);assert.equal(value.reservationCount,3);assert.equal(value.reservations.length,3);assert.equal(value.detailScope,'team');
 for(let i=0;i<3;i++)work.productStock(f.admin,{productId:f.p.id});assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(writes,0);
 const response={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=JSON.parse(body);}};await operationsRoutes({method:'GET'},response,new URL('http://test/api/work/productStock?productId='+f.p.id),f.op,{db:f.db,operationsService:work});assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.body.availableToPick,7);assert.equal(routeAllowed(currentActor(f.db,f.op),'GET','/api/work/productStock'),true);
 }finally{f.db.close();}
});
test('operator sees aggregate reservations but only own tasks; assignment capability alone does not grant team details',()=>{
 const f=fixture();try{f.stock(f.cells[0],10);const own=f.create(f.op,'pick',2,f.cells[0]),other=f.create(f.admin,'pick',3,f.cells[0]);const s=f.read(f.op);assert.equal(s.pickReserved,5);assert.equal(s.reservationCount,2);assert.deepEqual(s.reservations.map(r=>r.taskId),[own.taskId]);assert.equal(JSON.stringify(s).includes('"taskId":'+other.taskId),false);
 const role=f.access.saveRole(f.admin,{name:'Assignment only',capabilities:['work.view','work.assign','work.pick']});f.access.assign(f.admin,{userId:f.op.id,roleId:role});assert.equal(f.read(f.op).detailScope,'own');assert.equal(f.read(f.op).reservations.length,1);
 const view=f.access.saveRole(f.admin,{name:'Work reader',capabilities:['work.view']});f.access.assign(f.admin,{userId:f.op.id,roleId:view});assert.throws(()=>f.read(f.op),/planning is not available/);f.db.prepare("UPDATE users SET status='inactive' WHERE id=?").run(f.op.id);assert.throws(()=>f.read(f.op));assert.throws(()=>f.work.productStock(f.admin,{productId:999999}),/active product/);
 }finally{f.db.close();}
});
test('inactive stock stays unavailable; review-only reservations yield stock and reads follow settlement',()=>{
 const f=fixture();try{const [a,b,c]=f.cells;f.stock(a,8);f.stock(b,4);f.stock(c,3);let t=f.work.task(f.op,f.create(f.op,'pick',3,a).taskId);
 f.db.prepare('UPDATE cells SET active=0 WHERE id=?').run(c.id);f.command(f.op,'askReview',{lineId:t.lines[0].id,reason:'Unknown actual'});let s=f.read(f.admin);assert.equal(s.recorded,15);assert.equal(s.pickReserved,3);assert.equal(s.availableToPick,12);assert.equal(s.unavailableUnreserved,3);
 const next=f.work.task(f.admin,f.create(f.admin,'pick',2,b).taskId);f.command(f.admin,'stop',{taskId:next.id,generation:next.assignment_generation});s=f.read(f.admin);assert.equal(s.pickReserved,3);assert.equal(s.reservations.length,1);
 const l=f.work.task(f.admin,f.create(f.admin,'pick',2,b).taskId).lines[0];f.command(f.admin,'acquire',{lineId:l.id,revision:l.revision,method:'arrival',deviceId:'stock-test'});const fresh=f.work.line(l.id);f.command(f.admin,'report',{lineId:l.id,revision:fresh.revision,quantity:1,cellId:b.id,unit:f.p.unit_of_measure,deviceId:'stock-test'});s=f.read(f.admin);assert.equal(s.recorded,14);assert.equal(s.pickReserved,3);assert.equal(s.availableToPick,11);
 }finally{f.db.close();}
});
test('put reservations in another product occupy capacity without becoming this product’s stock or pick reservations',()=>{
 const f=fixture();try{const other=f.db.prepare('SELECT * FROM products WHERE id!=? LIMIT 1').get(f.p.id);f.command(f.admin,'create',{direction:'put',productId:other.id,quantity:1,preferredCellId:f.cells[0].id});const s=f.read(f.admin);assert.equal(s.recorded,0);assert.equal(s.pickReserved,0);assert.equal(s.incomingReserved,0);assert.equal(s.availableToPick,0);assert.equal(s.putCapacity,20);assert.equal(s.reservationCount,0);}finally{f.db.close();}
});

test('a busy turn preserves its active reservation but permits planning against other free stock',()=>{
 const f=fixture();try{const [a]=f.cells;f.stock(a,8);let t=f.work.task(f.op,f.create(f.op,'pick',3,a).taskId);const before=f.db.prepare('SELECT total_changes() n').get().n;assert.equal(f.work.task(f.admin,f.read(f.admin).reservations[0].taskId).id,t.id);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 f.command(f.admin,'stop',{taskId:t.id,generation:t.assignment_generation});assert.equal(f.read(f.admin).pickReserved,0);assert.equal(f.read(f.admin).availableToPick,8);
 t=f.work.task(f.op,f.create(f.op,'pick',3,a).taskId);const l=t.lines[0];f.command(f.op,'acquire',{lineId:l.id,revision:l.revision,method:'arrival',deviceId:'uncertain-device'});f.db.prepare('UPDATE cell_turns SET uncertain=1 WHERE cell_id=?').run(a.id);const s=f.read(f.admin);assert.equal(s.recorded,8);assert.equal(s.availableToPick,5);assert.equal(s.unavailableUnreserved,0);assert.equal(s.putCapacity,22);
 }finally{f.db.close();}
});
