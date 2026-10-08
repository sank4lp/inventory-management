import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createLocationSetupService} from '../src/modules/locations/service.js';
import {createHardwareService} from '../src/services/hardware.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {locationHierarchy,migrateLocationHierarchy} from '../src/modules/locations/hierarchy.js';
import {locationBrowseRoutes} from '../src/modules/locations/browse.js';
import {locationTree} from '../public/client/location-tree.js';

function fixture(){
 process.chdir(mkdtempSync(join(tmpdir(),'location-hierarchy-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true}),work=createOperationsService({db});
 const hardware=createHardwareService({db,config:{hardwareAdapter:'simulator'},logger:{info(){},warn(){},error(){}}});
 const display=createDisplayCoordinator({db,hardwareService:hardware,operationsService:work});
 const setup=createLocationSetupService({db,operationsService:work,displayCoordinator:display});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const send=(action,input={},actor=admin)=>setup.command(actor,action,{requestId:randomUUID(),...input});
 const draft=()=>{const h=locationHierarchy(db);return {version:h.version,warehouses:h.warehouses.map(w=>({...w})),shelves:h.shelves.map(s=>({id:s.id,name:s.name,warehouseId:s.warehouse_id})),cells:h.cells.map(c=>({id:c.id,shelfId:c.shelf_id}))};};
 return {db,work,display,setup,admin,op,send,draft};
}
test('an existing database groups legacy cells, including blank and case-varied names, without changing cell identities',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE cells(id INTEGER PRIMARY KEY,display_name TEXT,logical_code TEXT,warehouse_name TEXT,travel_instructions TEXT,description_revision INTEGER DEFAULT 1,active INTEGER DEFAULT 1);
 INSERT INTO cells(id,logical_code,warehouse_name,travel_instructions) VALUES(1,'A',' West ',' Shelf 5 '),(2,'B','',''),(3,'C','west','shelf 5');`);
 migrateLocationHierarchy(db);
 const cells=db.prepare('SELECT * FROM cells ORDER BY id').all();
 assert.equal(cells[0].shelf_id,cells[2].shelf_id);assert.equal(cells[0].warehouse_name,'West');assert.equal(cells[0].travel_instructions,'Shelf 5');
 assert.equal(cells[2].warehouse_name,'West');assert.equal(cells[2].travel_instructions,'Shelf 5');
 assert.equal(cells[1].warehouse_name,'Default Warehouse');assert.equal(cells[1].travel_instructions,'Unassigned shed/shelf');
 assert.deepEqual(cells.map(c=>[c.id,c.logical_code,c.description_revision]),[[1,'A',1],[2,'B',1],[3,'C',1]]);
 const before=locationHierarchy(db);migrateLocationHierarchy(db);assert.deepEqual(locationHierarchy(db),before);db.close();
});
test('legacy and new locations persist names and default hierarchy; migration is repeatable',()=>{
 const f=fixture(),c=f.db.prepare('SELECT * FROM cells LIMIT 1').get();
 assert.equal(c.warehouse_name,'Default Warehouse');assert.equal(c.travel_instructions,'Unassigned shed/shelf');assert.ok(c.shelf_id);
 f.send('details',{cellId:c.id,descriptionRevision:c.description_revision,displayName:'Cell Alpha',warehouseName:'West',travelInstructions:'Shelf 5'});
 const saved=f.db.prepare('SELECT * FROM cells WHERE id=?').get(c.id);assert.equal(saved.display_name,'Cell Alpha');assert.equal(saved.warehouse_name,'West');assert.equal(saved.travel_instructions,'Shelf 5');
 const before=locationHierarchy(f.db);migrateLocationHierarchy(f.db);assert.deepEqual(locationHierarchy(f.db),before);
 const manual=f.send('manual',{displayName:'New cell',warehouseName:'West',travelInstructions:'Shelf 5'});assert.equal(f.db.prepare('SELECT shelf_id FROM cells WHERE id=?').get(manual.cellId).shelf_id,saved.shelf_id);f.db.close();
});
test('cell moves and whole-shelf moves update cached directions atomically without touching hardware, QR or inventory',()=>{
 const f=fixture(),before=f.db.prepare('SELECT id,logical_code,label_id,controller_id,hardware_channel,binding_revision FROM cells ORDER BY id').all(),balances=f.db.prepare('SELECT * FROM inventory_balances').all(),tx=f.db.prepare('SELECT * FROM transactions').all();
 let d=f.draft();d.warehouses.push({id:'new-east',name:'East'});d.shelves.push({id:'new-shelf',name:'Shelf 2',warehouseId:'new-east'});d.cells[0].shelfId='new-shelf';d.cells[1].shelfId='new-shelf';
 const input={...d,requestId:randomUUID()},r=f.setup.command(f.admin,'hierarchy',input);assert.equal(r.changed,2);assert.equal(f.setup.command(f.admin,'hierarchy',input).replayed,true);
 let cells=f.db.prepare('SELECT * FROM cells ORDER BY id LIMIT 2').all();assert.equal(cells[0].warehouse_name,'East');assert.equal(cells[1].travel_instructions,'Shelf 2');
 d=f.draft();const shelf=d.shelves.find(s=>s.name==='Shelf 2');shelf.warehouseId=d.warehouses.find(w=>w.name==='Default Warehouse').id;f.send('hierarchy',d);
 cells=f.db.prepare('SELECT * FROM cells ORDER BY id LIMIT 2').all();assert.ok(cells.every(c=>c.warehouse_name==='Default Warehouse'));assert.ok(cells.every(c=>c.description_revision===3));
 assert.deepEqual(f.db.prepare('SELECT id,logical_code,label_id,controller_id,hardware_channel,binding_revision FROM cells ORDER BY id').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),balances);assert.deepEqual(f.db.prepare('SELECT * FROM transactions').all(),tx);f.db.close();
});
test('stale layouts, duplicate names, missing cells and operator writes are rejected without partial changes',()=>{
 const f=fixture(),d=f.draft();assert.throws(()=>f.send('hierarchy',d,f.op),/permitted|admin/);
 const c=f.db.prepare('SELECT * FROM cells LIMIT 1').get();f.send('details',{cellId:c.id,descriptionRevision:c.description_revision,displayName:'Renamed'});
 const before=locationHierarchy(f.db);assert.throws(()=>f.send('hierarchy',d),/Locations changed/);assert.deepEqual(locationHierarchy(f.db),before);
 const missing=f.draft();missing.cells.pop();assert.throws(()=>f.send('hierarchy',missing),/every location/);
 const duplicate=f.draft();duplicate.warehouses.push({id:'new-copy',name:'default warehouse'});assert.throws(()=>f.send('hierarchy',duplicate),/different name/);
 const bad=f.draft();bad.shelves[0].warehouseId='new-no-such-warehouse';assert.throws(()=>f.send('hierarchy',bad),/Choose a warehouse/);assert.deepEqual(locationHierarchy(f.db),before);f.db.close();
});
test('location cards nest correctly, escape labels, show per-product stock and retain preferred-location shortcuts',()=>{
 const f=fixture();let html='';const response={writeHead(){},end(v){html=v;}};
 assert.equal(locationBrowseRoutes({method:'GET'},response,new URL('http://localhost/cells'),f.admin,{db:f.db,operationsService:f.work,displayCoordinator:f.display}),true);
 assert.match(html,/data-warehouse-zone/);assert.match(html,/data-shelf-zone/);assert.match(html,/Default Warehouse/);assert.match(html,/data-edit-layout/);
 for(const label of ['Product','SKU','On shelf','Reserved','Available to pick','Total capacity'])assert.ok(html.includes(label));
 assert.match(html,/class="ghost-button" href="\/pick\?cell_id=1"/);assert.match(html,/class="ghost-button" href="\/put\?cell_id=1"/);assert.match(html,/Stocktake at this location/);assert.match(html,/href="\/stocktaking\?cellId=1"/);
 locationBrowseRoutes({method:'GET'},response,new URL('http://localhost/cells?q=NOT-A-LOCATION'),f.op,{db:f.db,operationsService:f.work,displayCoordinator:f.display});assert.match(html,/No locations match/);assert.doesNotMatch(html,/data-edit-layout/);
 const tree=locationTree({warehouses:[{id:1,name:'<script>bad</script>'}],shelves:[{id:2,name:'Shelf "B"',warehouse_id:1}],cells:[{id:3,shelf_id:2,logical_code:'<bad>'}]},{3:'<article>Cell</article>'},{editing:true});assert.match(tree,/&lt;script&gt;/);assert.doesNotMatch(tree,/<script>/);assert.match(tree,/data-cell-shelf="3"/);assert.match(tree,/data-drag-kind="shelf"/);f.db.close();
});
