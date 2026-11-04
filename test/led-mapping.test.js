import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {deleteCell} from '../src/services/inventory.js';
import {saveControllerProfile} from '../src/services/controller-profiles.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createLocationSetupService} from '../src/modules/locations/service.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {createHardwareService} from '../src/services/hardware.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'led-mapping-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:false});
 db.exec('DELETE FROM inventory_balances');
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
 const c=configureControllerModules(db,{controllerCode:'TEST',controllerAddress:'TEST',moduleCount:4,configuredBy:admin.id});
 const controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(c.id);
 const routing=Array.from({length:64},(_,i)=>[3,1,4,2][i]||0);
 saveControllerProfile(db,controller,{physicalCount:4,logicalCount:4,routing,revision:1});
 db.prepare("UPDATE controllers SET heartbeat_status='online' WHERE id=?").run(c.id);
 const work=createOperationsService({db});
 const hardware=createHardwareService({db,config:{hardwareAdapter:'simulator'},logger:{info(){},warn(){}}});
 const display=createDisplayCoordinator({db,hardwareService:hardware,operationsService:work});
 const service=createLocationSetupService({db,operationsService:work,displayCoordinator:display});
 const command=(action,input={})=>service.command(admin,action,{requestId:randomUUID(),...input});
 const map=()=>service.snapshot(admin).ledControllers.find(v=>v.id===c.id);
 const save=rows=>command('saveLedMappings',{controllerId:c.id,revision:map().revision,rows});
 const stock=(id,quantity,productId=1)=>db.prepare('INSERT OR REPLACE INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0)').run(productId,id,quantity);
 return {db,admin,c,work,display,service,command,map,save,stock};
}
test('physical positions use verified routing, save creates named cells atomically, retries do not duplicate',()=>{
 const f=fixture();assert.deepEqual(f.map().leds.map(l=>l.channel),[2,4,1,3]);
 const input={requestId:randomUUID(),controllerId:f.c.id,revision:f.map().revision,rows:[{physical:1,name:'Z1-R1-C21'},{physical:2,name:'Z1-R1-C22'}]};
 const r=f.service.command(f.admin,'saveLedMappings',input);assert.equal(r.cellIds.length,2);assert.equal(f.map().leds[0].name,'Z1-R1-C21');assert.equal(f.db.prepare('SELECT hardware_channel FROM cells WHERE id=?').get(r.cellIds[0]).hardware_channel,2);
 assert.equal(f.service.command(f.admin,'saveLedMappings',input).replayed,true);
 assert.throws(()=>f.save([{physical:3,name:'Another'},{physical:4,name:'Another'}]),/different location/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM cells WHERE display_name='Another'").get().n,0);
 assert.throws(()=>f.command('saveLedMappings',{controllerId:f.c.id,revision:input.revision,rows:[{physical:3,name:'New'}]}),/changed/);f.db.close();
});
test('same cell rename preserves inventory, QR and identity; different stocked cell cannot be displaced',()=>{
 const f=fixture();const r=f.save([{physical:1,name:'Original'}]),id=r.cellIds[0],before=f.db.prepare('SELECT label_id FROM cells WHERE id=?').get(id);f.stock(id,10);
 assert.throws(()=>f.save([{physical:1,name:'Another',resolution:'different'}]),/Move all/);
 f.save([{physical:1,name:'New name',resolution:'same',keepName:'entered'}]);assert.equal(f.map().leds[0].cellId,id);assert.equal(f.map().leds[0].name,'New name');assert.equal(f.db.prepare('SELECT available_quantity n FROM inventory_balances WHERE cell_id=?').get(id).n,10);assert.deepEqual(f.db.prepare('SELECT label_id FROM cells WHERE id=?').get(id),before);
 assert.throws(()=>f.save([{physical:1,name:'Third name'}]),/Confirm whether/);f.db.close();
});
test('same-location existing duplicate requires explicit merge and retains the stocked identity and archived history',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Original'}]).cellIds[0];f.stock(id,4);
 const other=f.command('manual',{displayName:'Alternate'}).cellId;
 assert.throws(()=>f.save([{physical:1,name:'Alternate',resolution:'same',keepName:'entered'}]),/Confirm combining/);
 f.save([{physical:1,name:'Alternate',resolution:'same',keepName:'entered',mergeConfirmed:true}]);assert.equal(f.map().leds[0].cellId,id);assert.equal(f.db.prepare('SELECT active FROM cells WHERE id=?').get(other).active,0);assert.equal(f.db.prepare('SELECT available_quantity n FROM inventory_balances WHERE cell_id=?').get(id).n,4);f.db.close();
});
test('empty replacement preserves previous cell as manual and requires no inventory movement',()=>{
 const f=fixture(),old=f.save([{physical:1,name:'Old'}]).cellIds[0],next=f.command('manual',{displayName:'Next'}).cellId;
 f.save([{physical:1,name:'Next',cellId:next,resolution:'different'}]);assert.equal(f.map().leds[0].cellId,next);assert.deepEqual({...f.db.prepare('SELECT active,controller_id,hardware_channel FROM cells WHERE id=?').get(old)},{active:1,controller_id:null,hardware_channel:null});f.db.close();
});
test('display sends actual physical number even for unassigned outputs and stop preserves mappings',()=>{
 const f=fixture();const before=f.map().revision,r=f.command('displayLedNumbers',{controllerId:f.c.id});assert.deepEqual(r.targets.map(t=>t.value),[1,2,3,4]);assert.ok(r.targets.every(t=>t.status==='sent'));assert.throws(()=>f.save([{physical:1,name:'Blocked'}]),/active utility/);f.display.stop(f.admin,r.id);assert.equal(f.map().revision,before);f.db.close();
});
test('move reservations are atomic and idempotent, protect puts until picks complete, and discard releases untouched work',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Stocked'}]).cellIds[0];f.stock(id,7);
 const before=f.db.prepare('SELECT * FROM inventory_balances').all(),plan=f.command('planLedMove',{cellId:id});assert.equal(plan.products[0].quantity,7);assert.equal(plan.products[0].shortfall,0);
 const input={cellId:id,requestId:randomUUID()},move=f.service.command(f.admin,'moveLedStock',input);assert.ok(move.picks.length&&move.puts.length);assert.equal(f.service.command(f.admin,'moveLedStock',input).replayed,true);
 const put=f.work.task(f.admin,move.puts[0]),line=put.lines[0];assert.equal(line.guidance.state,'blocked');
 assert.throws(()=>f.work.command(f.admin,'acquire',{requestId:randomUUID(),lineId:line.id,revision:line.revision,location:line.logical_code,deviceId:'test'}),/linked pick/);
 f.command('discardLedMove',{cellId:id,confirmed:true});assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reservations WHERE state='held'").get().n,0);assert.equal(f.service.snapshot(f.admin).ledMoves.length,0);
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all().map(r=>({...r,reserved_quantity:0})),before.map(r=>({...r,reserved_quantity:0})));assert.equal(f.map().leds[0].cellId,id);f.db.close();
});
test('no-space move rolls back all tasks, custom destinations and confirmed capacity use current limits',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Stocked'}]).cellIds[0];f.stock(id,30);const destination=f.command('manual',{displayName:'Destination'}).cellId;
 f.db.prepare('UPDATE cells SET active=0 WHERE id NOT IN (?,?)').run(id,destination);f.db.prepare('UPDATE products SET items_per_cell=5 WHERE id=1').run();const count=f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
 assert.throws(()=>f.command('moveLedStock',{cellId:id}),/entire quantity/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,count);
 assert.throws(()=>f.command('moveLedStock',{cellId:id,capacities:[{productId:1,itemsPerCell:40,previousCapacity:5,confirmed:false}]}),/Confirm/);assert.equal(f.db.prepare('SELECT items_per_cell n FROM products WHERE id=1').get().n,5);
 const move=f.command('moveLedStock',{cellId:id,capacities:[{productId:1,itemsPerCell:40,previousCapacity:5,confirmed:true}],products:[{productId:1,destinations:[{cellId:destination,quantity:30}]}]});assert.equal(move.puts.length,1);assert.equal(f.work.task(f.admin,move.puts[0]).lines[0].cell_id,destination);f.db.close();
});
test('started move discard preserves inventory and requests checks while keeping puts and mapping',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Stocked'}]).cellIds[0];f.stock(id,7);const move=f.command('moveLedStock',{cellId:id});const l=f.work.task(f.admin,move.picks[0]).lines[0];
 f.work.command(f.admin,'acquire',{requestId:randomUUID(),lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});
 const before=f.db.prepare('SELECT * FROM inventory_balances').all();const result=f.command('discardLedMove',{cellId:id,confirmed:true});assert.equal(result.status,'review');assert.ok(f.service.snapshot(f.admin).ledMoves.length);assert.ok(f.db.prepare("SELECT 1 FROM work_reports WHERE cell_id=? AND status='review'").get(id));assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);assert.equal(f.map().leds[0].cellId,id);assert.ok(!f.work.task(f.admin,move.puts[0]).completed_at);f.db.close();
});
test('completed picks unlock puts; mapping stays blocked until every put is physically recorded',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Stocked'}]).cellIds[0];f.stock(id,7);const move=f.command('moveLedStock',{cellId:id});
 const finish=taskId=>{for(const l of f.work.task(f.admin,taskId).lines){f.work.command(f.admin,'acquire',{requestId:randomUUID(),lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});const current=f.work.line(l.id);f.work.command(f.admin,'report',{requestId:randomUUID(),lineId:l.id,revision:current.revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity:l.planned_quantity,deviceId:'test'});}};
 finish(move.picks[0]);assert.equal(f.work.task(f.admin,move.picks[0]).outcome,'completed');assert.notEqual(f.work.task(f.admin,move.puts[0]).lines[0].guidance.state,'blocked');
 assert.throws(()=>f.save([{physical:1,name:'Replacement',resolution:'different'}]),/outstanding|linked/);
 for(const taskId of move.puts)finish(taskId);
 f.save([{physical:1,name:'Replacement',resolution:'different'}]);assert.equal(f.map().leds[0].name,'Replacement');assert.equal(f.db.prepare('SELECT SUM(available_quantity) q FROM inventory_balances WHERE product_id=1').get().q,7);f.db.close();
});
test('mapping and display respect authorization and refuse unknown or damaged routing',()=>{
 const f=fixture(),op=f.db.prepare("SELECT * FROM users WHERE role='operator'").get(),input={requestId:randomUUID(),controllerId:f.c.id,revision:f.map().revision,rows:[{physical:1,name:'Blocked'}]};
 assert.throws(()=>f.service.command(op,'saveLedMappings',input),/not permitted/);assert.throws(()=>f.service.command(op,'displayLedNumbers',{requestId:randomUUID(),controllerId:f.c.id}),/not permitted/);
 f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run('{}','controller_profile:'+f.c.id);assert.match(f.map().error,/checksum/);assert.equal(f.map().leds.length,0);assert.throws(()=>f.save([{physical:1,name:'No guessing'}]),/checksum/);
 f.db.prepare('DELETE FROM app_metadata WHERE key=?').run('controller_profile:'+f.c.id);assert.match(f.map().error,/verified controller backup/);f.db.close();
});
test('multi-product moves reserve separate compatible space; invalid custom plans roll back every product',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Stocked'}]).cellIds[0];f.stock(id,3,1);f.stock(id,4,2);
 const destination=f.command('manual',{displayName:'Only destination'}).cellId;
 f.db.prepare('UPDATE cells SET active=0 WHERE id NOT IN (?,?)').run(id,destination);f.db.prepare('UPDATE products SET items_per_cell=10 WHERE id IN (1,2)').run();
 const plan=f.command('planLedMove',{cellId:id});assert.ok(plan.products.some(p=>p.shortfall>0));
 const before=f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
 assert.throws(()=>f.command('moveLedStock',{cellId:id,products:[{productId:1,destinations:[{cellId:destination,quantity:3}]},{productId:2,destinations:[{cellId:destination,quantity:4}]}]}),/capacity/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_reservations WHERE state='held'").get().n,0);assert.equal(f.map().leds[0].cellId,id);f.db.close();
});
test('a fully accounted move can be discarded while retaining posted movements and freeing its setup record',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Stocked'}]).cellIds[0];f.stock(id,2);const move=f.command('moveLedStock',{cellId:id});
 for(const taskId of [...move.picks,...move.puts])for(const l of f.work.task(f.admin,taskId).lines){f.work.command(f.admin,'acquire',{requestId:randomUUID(),lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});f.work.command(f.admin,'report',{requestId:randomUUID(),lineId:l.id,revision:f.work.line(l.id).revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity:l.planned_quantity,deviceId:'test'});}
 const before=f.db.prepare('SELECT * FROM inventory_balances').all(),history=f.db.prepare('SELECT * FROM transactions').all();f.command('discardLedMove',{cellId:id,confirmed:true});assert.equal(f.service.snapshot(f.admin).ledMoves.length,0);assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM transactions').all(),history);assert.equal(f.map().leds[0].cellId,id);f.db.close();
});
test('generic setup discard cannot cancel put tasks while moved goods remain in transit',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Stocked'}]).cellIds[0];f.stock(id,2);const move=f.command('moveLedStock',{cellId:id});
 const l=f.work.task(f.admin,move.picks[0]).lines[0];f.work.command(f.admin,'acquire',{requestId:randomUUID(),lineId:l.id,revision:l.revision,location:l.logical_code,deviceId:'test'});
 let row=f.work.setupBlockers(f.admin,{}).tasks.find(t=>t.id===move.puts[0]);assert.equal(row.canDiscard,false);
 f.work.command(f.admin,'report',{requestId:randomUUID(),lineId:l.id,revision:f.work.line(l.id).revision,cellId:l.cell_id,unit:l.unit_of_measure,quantity:l.planned_quantity,deviceId:'test'});
 row=f.work.setupBlockers(f.admin,{}).tasks.find(t=>t.id===move.puts[0]);assert.equal(row.canDiscard,false);assert.match(row.reason,/put away/);
 assert.throws(()=>f.work.command(f.admin,'discardSetupTasks',{requestId:randomUUID(),confirmed:true,tasks:[{id:row.id,token:row.token}]}),/put away/);assert.ok(!f.work.task(f.admin,row.id).completed_at);f.db.close();
});

test('correcting a location to a free LED releases its old LED and preserves stock, QR and history',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Correct cell'}]).cellIds[0];f.stock(id,7);
 const before=f.db.prepare('SELECT label_id,label_revision,shelf_id FROM cells WHERE id=?').get(id),balances=f.db.prepare('SELECT * FROM inventory_balances').all();
 const revision=f.map().revision;
 f.save([{physical:2,name:'Correct cell',cellId:id}]);
 assert.equal(f.map().leds[0].cellId,null);assert.equal(f.map().leds[1].cellId,id);
 assert.deepEqual(f.db.prepare('SELECT label_id,label_revision,shelf_id FROM cells WHERE id=?').get(id),before);
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),balances);
 assert.throws(()=>f.command('saveLedMappings',{controllerId:f.c.id,revision,rows:[{physical:3,name:'Correct cell'}]}),/changed/);
 const next=f.save([{physical:1,name:'Other cell'}]).cellIds[0];assert.notEqual(id,next);
 assert.throws(()=>f.save([{physical:1,name:'Correct cell'}]),/Confirm whether/);
 assert.equal(f.map().leds[0].cellId,next);assert.equal(f.map().leds[1].cellId,id);f.db.close();
});

test('removing a binding keeps the logical cell, frees the LED and replays safely',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Remove wrong binding'}]).cellIds[0];f.stock(id,5);
 assert.throws(()=>f.save([{physical:1,cellId:id}]),/Enter a location name/);assert.equal(f.map().leds[0].cellId,id);
 const input={requestId:randomUUID(),controllerId:f.c.id,revision:f.map().revision,rows:[{physical:1,name:'',cellId:id}]};
 f.service.command(f.admin,'saveLedMappings',input);
 assert.equal(f.service.command(f.admin,'saveLedMappings',input).replayed,true);
 const c=f.db.prepare('SELECT * FROM cells WHERE id=?').get(id);assert.equal(c.active,1);assert.equal(c.controller_id,null);assert.equal(c.hardware_channel,null);
 assert.equal(f.db.prepare('SELECT available_quantity n FROM inventory_balances WHERE cell_id=?').get(id).n,5);
 assert.equal(f.map().leds[0].cellId,null);f.save([{physical:1,name:'New owner'}]);
 f.save([{physical:2,name:'Remove wrong binding',cellId:id}]);assert.equal(f.map().leds[1].cellId,id);f.db.close();
});

test('a deleted location and its inactive placeholder do not block assigning that LED again',()=>{
 const f=fixture(),old=f.save([{physical:1,name:'Incorrect name'}]).cellIds[0];deleteCell(f.db,{cellId:old,deletedBy:f.admin.id});
 const id=f.save([{physical:2,name:'Actual name'}]).cellIds[0];
 f.save([{physical:1,name:'Actual name',cellId:id}]);
 assert.equal(f.map().leds[0].cellId,id);assert.equal(f.map().leds[1].cellId,null);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cells WHERE controller_id=? AND hardware_channel=?').get(f.c.id,f.map().leds[0].channel).n,1);f.db.close();
});

test('correcting across controllers retains the logical location and frees the old controller output',()=>{
 const f=fixture(),id=f.save([{physical:1,name:'Cross controller'}]).cellIds[0];
 const result=configureControllerModules(f.db,{controllerCode:'SECOND',controllerAddress:'SECOND',moduleCount:2,configuredBy:f.admin.id}),second=f.db.prepare('SELECT * FROM controllers WHERE id=?').get(result.id);
 saveControllerProfile(f.db,second,{physicalCount:2,logicalCount:2,routing:Array.from({length:64},(_,i)=>i<2?i+1:0),revision:1});
 const map=f.service.snapshot(f.admin).ledControllers.find(c=>c.id===second.id);
 f.command('saveLedMappings',{controllerId:second.id,revision:map.revision,rows:[{physical:2,name:'Cross controller',cellId:id}]});
 assert.equal(f.map().leds[0].cellId,null);assert.equal(f.db.prepare('SELECT controller_id FROM cells WHERE id=?').get(id).controller_id,second.id);f.db.close();
});

test('new sheds persist for LED and manual locations, reuse names and reject wrong-warehouse or invalid choices atomically',()=>{
 const f=fixture(),warehouse=f.service.snapshot(f.admin).hierarchy.warehouses[0];
 const id=f.save([{physical:1,name:'In new shed',warehouseId:warehouse.id,shelfId:'new',newShelfName:'Packing Shed'}]).cellIds[0];
 const group=f.service.snapshot(f.admin).hierarchy.shelves.find(s=>s.name==='Packing Shed');assert.ok(group);assert.equal(group.warehouse_id,warehouse.id);
 const next=f.command('manual',{displayName:'Next location',warehouseId:warehouse.id,shelfId:group.id}).cellId;
 const third=f.command('manual',{displayName:'Third location',warehouseId:warehouse.id,shelfId:'new',newShelfName:'packing shed'}).cellId;
 for(const cellId of [id,next,third])assert.equal(f.db.prepare('SELECT shelf_id FROM cells WHERE id=?').get(cellId).shelf_id,group.id);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM location_shelves WHERE name='Packing Shed' COLLATE NOCASE").get().n,1);
 const east=Number(f.db.prepare("INSERT INTO location_warehouses(name) VALUES('East')").run().lastInsertRowid),before=f.map().revision;
 assert.throws(()=>f.save([{physical:3,name:'Rejected',warehouseId:east,shelfId:group.id}]),/Choose a shed/);
 assert.equal(f.map().revision,before);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM cells WHERE display_name='Rejected'").get().n,0);
 for(const values of [{warehouseId:99999,shelfId:group.id},{warehouseId:warehouse.id,shelfId:''},{warehouseId:warehouse.id,shelfId:'new',newShelfName:'  '}])assert.throws(()=>f.command('manual',{displayName:'Invalid',...values}),/warehouse|shed/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM cells WHERE display_name='Invalid'").get().n,0);f.db.close();
});
