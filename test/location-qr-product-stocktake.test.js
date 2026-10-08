import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createHardwareService} from '../src/services/hardware.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {createLocationSetupService} from '../src/modules/locations/service.js';
import {createStocktakingService} from '../src/modules/stocktaking/service.js';
import {locationQrValue,resolveLocationLabel,validLocationLabel} from '../src/modules/operations/location-contract.js';
import {countBoundary} from '../src/modules/stocktaking/accounting.js';
import {locationBrowseRoutes} from '../src/modules/locations/browse.js';
function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'qr-product-count-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 const hardware=createHardwareService({db,config:{hardwareAdapter:'simulator'},logger:{info(){},warn(){},error(){}}});
 const display=createDisplayCoordinator({db,hardwareService:hardware,operationsService:work});
 const setup=createLocationSetupService({db,operationsService:work,displayCoordinator:display}),count=createStocktakingService({db,operationsService:work});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 3').all(),products=db.prepare('SELECT * FROM products ORDER BY id LIMIT 2').all();
 db.exec("UPDATE controllers SET module_count=27,heartbeat_status='online';DELETE FROM inventory_balances;");
 const sc=(action,input={},actor=admin)=>setup.command(actor,action,{requestId:randomUUID(),...input});
 const cc=(action,input={},actor=op)=>count.command(actor,action,{requestId:randomUUID(),...input});
 const current=id=>db.prepare('SELECT * FROM cells WHERE id=?').get(id);
 const stock=(p,c,q)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0)').run(p.id,c.id,q);
 const assign=(c,value)=>sc('assignQr',{cellId:c.id,labelId:c.label_id,labelRevision:c.label_revision,label:value,confirmed:true});
 const begin=runId=>{const i=count.snapshot(op).runs.find(r=>r.id===runId).items[0];return cc('begin',{itemId:i.id,generation:i.generation,method:'manual',location:current(i.cell_id).logical_code}).attemptId;};
 return {db,work,display,setup,count,admin,op,cells,products,sc,cc,current,stock,assign,begin};
}
test('customer QR is opaque, unique, replaceable, permission protected and preserves existing stock identity',()=>{
 const f=fixture(),[c,other]=f.cells;f.stock(f.products[0],c,6);
 const old=locationQrValue(f.db,f.work.identity().site,c),balances=f.db.prepare('SELECT * FROM inventory_balances').all();
 assert.equal(validLocationLabel(f.db,f.work.identity().site,c,old),true);
 assert.equal(f.setup.snapshot(f.admin).cells.find(x=>x.id===c.id).qrScannedAt,null);
 const qr='https://customer.example/labels/bin?code=custom-001';
 assert.throws(()=>f.sc('assignQr',{cellId:c.id,labelId:c.label_id,labelRevision:c.label_revision,label:qr,confirmed:true},f.op),/permitted|admin/);
 f.assign(c,qr);assert.equal(resolveLocationLabel(f.db,f.work.identity().site,qr).id,c.id);
 assert.equal(locationQrValue(f.db,f.work.identity().site,f.current(c.id)),qr);
 assert.equal(resolveLocationLabel(f.db,f.work.identity().site,old),null);
 assert.ok(f.setup.snapshot(f.admin).cells.find(x=>x.id===c.id).qrScannedAt);
 assert.throws(()=>f.assign(other,qr),/another location/);
 f.assign(f.current(c.id),'CUSTOM-SECOND-QR');assert.equal(resolveLocationLabel(f.db,f.work.identity().site,qr),null);
 assert.throws(()=>f.assign(other,qr),/replaced/);
 assert.throws(()=>f.assign(other,'bad\ncode'),/readable/);
 assert.throws(()=>f.assign(other,'lytguide:another-site:x:1'),/another warehouse/);
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),balances);
 f.db.close();
});
test('light-first wizard can pair an arbitrary sticker with a known output without changing stock',()=>{
 const f=fixture(),controller=f.db.prepare('SELECT * FROM controllers LIMIT 1').get();f.stock(f.products[0],f.cells[0],6);
 f.sc('start',{controllerId:controller.id});const s=f.setup.snapshot(f.admin).sessions[0];
 f.sc('light',{sessionId:s.id,generation:s.generation});const before=f.db.prepare('SELECT * FROM inventory_balances').all();
 const input={requestId:randomUUID(),sessionId:s.id,generation:s.generation,fieldSignature:f.setup.snapshot(f.admin).fieldSignature,label:'random-customer-sticker-17',displayName:'Shelf Five',warehouseName:'Main Warehouse',travelInstructions:'Shed 2, shelf 5',physicalConfirmed:true};
 const result=f.setup.command(f.admin,'bind',input);assert.equal(f.setup.command(f.admin,'bind',input).replayed,true);
 const c=f.current(result.cellId);assert.equal(c.hardware_channel,s.output);assert.equal(c.warehouse_name,'Main Warehouse');assert.ok(c.binding_verified_at);
 assert.equal(resolveLocationLabel(f.db,f.work.identity().site,input.label).id,c.id);assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);
 f.db.close();
});
test('LED module display sends the module number, not stock, and cannot overwrite count guidance',()=>{
 const f=fixture(),c=f.cells[0];f.stock(f.products[0],c,6);
 const shown=f.display.start(f.admin,{kind:'module_number',cellId:c.id});assert.equal(shown.targets[0].status,'sent');assert.equal(shown.targets[0].value,c.hardware_channel);
 f.display.stop(f.admin,shown.id);const run=f.cc('create',{mode:'product',productId:f.products[0].id}).runId;f.begin(run);
 const blocked=f.display.start(f.admin,{kind:'module_number',cellId:c.id});assert.equal(blocked.targets[0].status,'busy');
 assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(c.id).available_quantity,6);
 f.db.close();
});
test('scan lookup returns location products, separate warehouse totals and a product-specific count shortcut',()=>{
 const f=fixture(),[p,b]=f.products,[c,other]=f.cells;f.stock(p,c,6);f.stock(b,c,2);f.stock(p,other,4);f.assign(c,'CUSTOM-LOOKUP');
 const res={writeHead(code){this.code=code;},end(body){this.value=JSON.parse(body);}};
 assert.equal(locationBrowseRoutes({method:'GET'},res,new URL('http://localhost/api/locations/resolve?label=CUSTOM-LOOKUP'),f.op,{db:f.db,operationsService:f.work,displayCoordinator:f.display}),true);
 assert.equal(res.value.products.length,2);const a=res.value.products.find(v=>v.product_id===p.id);assert.equal(a.on_hand,6);assert.equal(a.warehouseStock,10);assert.equal(a.availableToPick,10);assert.equal(res.value.canStocktake,true);
 f.db.close();
});
test('product stocktake corrects only that product in mixed cells and does not create a boundary for another product',()=>{
 const f=fixture(),[p,b]=f.products,[c,other]=f.cells;f.stock(p,c,6);f.stock(b,c,2);f.stock(p,other,4);
 const run=f.cc('create',{mode:'product',productId:p.id}).runId;let state=f.count.snapshot(f.op).runs.find(r=>r.id===run);assert.equal(state.items.length,2);assert.equal(JSON.parse(state.scope_json).productId,p.id);
 const attempt=f.begin(run);assert.deepEqual(f.count.snapshot(f.op).runs.find(r=>r.id===run).attempts[0].baseline.products.map(v=>v.productId),[p.id]);
 assert.throws(()=>f.cc('observe',{attemptId:attempt,lines:[{productId:p.id,actual:5},{productId:b.id,actual:0}]}),/selected product/);
 const o=f.cc('observe',{attemptId:attempt,lines:[{productId:p.id,actual:5}]});assert.equal(o.status,'review');
 const approval={requestId:randomUUID(),observationId:o.observationId,revision:1,action:'approve',reason:'Unknown',evidence:'Shelf counted twice'};f.count.command(f.admin,'review',approval);assert.equal(f.count.command(f.admin,'review',approval).replayed,true);
 const balances=f.db.prepare('SELECT product_id,available_quantity FROM inventory_balances WHERE cell_id=? ORDER BY product_id').all(c.id);
 assert.equal(balances.find(v=>v.product_id===p.id).available_quantity,5);assert.equal(balances.find(v=>v.product_id===b.id).available_quantity,2);
 assert.ok(countBoundary(f.db,{cell_id:c.id,product_id:p.id}));assert.equal(countBoundary(f.db,{cell_id:c.id,product_id:b.id}),null);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,1);f.db.close();
});
test('unexpected product location begins at zero and a changed cell requires a recount rather than overwriting stock',()=>{
 const f=fixture(),[p,b]=f.products,[c]=f.cells;f.stock(b,c,2);
 const run=f.cc('create',{mode:'product',productId:p.id,cellIds:[c.id]}).runId,attempt=f.begin(run);
 const baseline=f.count.snapshot(f.op).runs.find(r=>r.id===run).attempts[0].baseline;assert.equal(baseline.products[0].recorded,0);
 // Another product moving makes this physical cell's counting boundary stale.
 f.db.prepare('UPDATE inventory_balances SET available_quantity=3 WHERE cell_id=? AND product_id=?').run(c.id,b.id);
 const o=f.cc('observe',{attemptId:attempt,lines:[{productId:p.id,actual:1}]});assert.equal(o.status,'recheck');
 assert.throws(()=>f.cc('review',{observationId:o.observationId,revision:1,action:'approve',reason:'Unknown',evidence:'Checked'},f.admin),/fresh count/);
 assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=? AND product_id=?').get(c.id,b.id).available_quantity,3);f.db.close();
});
test('customer QR works through operator arrival and verification without posting a movement',()=>{
 const f=fixture(),[p]=f.products,[c]=f.cells;f.stock(p,c,6);f.assign(c,'warehouse-customer-code-100');
 const cmd=(action,input)=>f.work.command(f.op,action,{requestId:randomUUID(),...input});
 const created=cmd('create',{direction:'pick',productId:p.id,quantity:2});let l=f.work.task(f.op,created.taskId).lines[0];
 assert.equal(cmd('acquire',{lineId:l.id,revision:l.revision,deviceId:'tablet-1',location:'warehouse-customer-code-100'}).status,'ready');l=f.work.line(l.id);
 assert.equal(cmd('verify',{lineId:l.id,revision:l.revision,deviceId:'tablet-1',location:'warehouse-customer-code-100'}).status,'verified');
 assert.throws(()=>cmd('verify',{lineId:l.id,revision:l.revision,deviceId:'tablet-1',location:'another-customer-code'}),/Wrong/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(c.id).available_quantity,6);
 f.db.close();
});
test('Manage Locations mapping checks the configured count and preserves stock and location identity',()=>{
 const f=fixture(),[c,source]=f.cells;f.stock(f.products[0],c,6);const label=c.label_id;
 const input={cellId:c.id,bindingRevision:c.binding_revision,sourceCellId:source.id,confirmed:true};
 f.db.prepare('UPDATE controllers SET module_count=1 WHERE id=?').run(source.controller_id);assert.throws(()=>f.sc('mapping',input),/output count/);
 f.db.prepare('UPDATE controllers SET module_count=27 WHERE id=?').run(source.controller_id);
 const receipt={...input,requestId:randomUUID()};f.setup.command(f.admin,'mapping',receipt);assert.equal(f.setup.command(f.admin,'mapping',receipt).replayed,true);const changed=f.current(c.id);assert.equal(changed.hardware_channel,source.hardware_channel);assert.equal(changed.label_id,label);
 assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(c.id).available_quantity,6);assert.equal(changed.binding_verified_at,null);
 assert.throws(()=>f.sc('mapping',input),/Mapping changed/);assert.throws(()=>f.sc('mapping',{...input,bindingRevision:changed.binding_revision},f.op),/permitted|admin/);
 f.db.close();
});
test('upgrade keeps scanned status only for labels with recorded physical setup evidence',async()=>{
 const f=fixture(),[verified,manual]=f.cells;const {migratePhaseTwo}=await import('../src/modules/stocktaking/phase-two-schema.js');
 const at='2026-10-01T09:30:00.000Z';f.db.prepare('INSERT INTO location_setup_events(actor_id,event_type,payload,created_at) VALUES(?,?,?,?)').run(f.admin.id,'output_physically_verified',JSON.stringify({cellId:verified.id,token:verified.label_id}),at);
 migratePhaseTwo(f.db);assert.equal(f.db.prepare('SELECT scanned_at FROM location_labels WHERE token=?').get(verified.label_id).scanned_at,at);
 assert.equal(f.db.prepare('SELECT scanned_at FROM location_labels WHERE token=?').get(manual.label_id).scanned_at,null);migratePhaseTwo(f.db);
 assert.equal(f.db.prepare('SELECT scanned_at FROM location_labels WHERE token=?').get(verified.label_id).scanned_at,at);f.db.close();
});
