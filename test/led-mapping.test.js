import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
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
