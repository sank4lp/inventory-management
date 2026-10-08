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
import {createStocktakingService} from '../src/modules/stocktaking/service.js';
import {displayRoutes} from '../src/modules/stocktaking/display-routes.js';
import {locationBrowseRoutes} from '../src/modules/locations/browse.js';

function fixture(t){
 process.chdir(mkdtempSync(join(tmpdir(),'location-group-display-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const cells=db.prepare('SELECT * FROM cells ORDER BY id LIMIT 4').all(),controllers=db.prepare('SELECT * FROM controllers ORDER BY id LIMIT 2').all(),products=db.prepare('SELECT * FROM products ORDER BY id LIMIT 2').all();
 db.exec('DELETE FROM inventory_balances; UPDATE cells SET active=0,controller_id=NULL,hardware_channel=NULL; UPDATE controllers SET heartbeat_status=\'online\',module_count=27');
 cells.forEach((c,n)=>db.prepare('UPDATE cells SET active=1,controller_id=?,hardware_channel=?,display_name=?,warehouse_name=?,travel_instructions=? WHERE id=?').run(controllers[n===3?1:0].id,n===3?1:n+1,['Alpha bin','Beta bin','Gamma bin','Other warehouse bin'][n],n===3?'West':'East',n<2?'Shed 1':n===2?'Shed 2':'Shed 3',c.id));
 const writes=[],errors=[],logger={debug(){},info(){},warn(){},error(event,detail){errors.push({event,detail});}};
 const hardware=createHardwareService({db,logger,config:{hardwareAdapter:'rs485',rs485WriteLine:line=>writes.push(line.trim()),rs485WriteRepeats:1,rs485WriteRepeatDelayMs:0,rs485GuidanceBurstRepeats:1,rs485GuidanceBurstDelayMs:0,rs485InterCommandDelayMs:0}});
 const work=createOperationsService({db,hardwareService:hardware,logger}),display=createDisplayCoordinator({db,hardwareService:hardware,operationsService:work});
 t.after(()=>{hardware.dispose();db.close();});
 const east=db.prepare("SELECT id FROM location_warehouses WHERE name='East'").get().id,shed=db.prepare("SELECT id FROM location_shelves WHERE name='Shed 1'").get().id;
 const stock=(p,c,q)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0)').run(p.id,c.id,q);
 const api=form=>{const res={writeHead(code){this.code=code;},end(body){this.body=JSON.parse(body);}};displayRoutes({method:'POST',parsedForm:form},res,new URL('http://localhost/api/displays/start'),admin,{db,displayCoordinator:display});return res.body;};
 return {db,admin,op,cells,products,work,display,writes,errors,stock,api,east,shed};
}

test('shed cell-name display sends full mapped names only inside that shed and stops only its LEDs',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT * FROM inventory_balances').all();
 const result=f.api({displayKind:'cell_name',shelfId:String(f.shed),requestId:randomUUID()});
 assert.equal(result.displayId,result.id);
 assert.deepEqual(result.targets.map(r=>r.cellId),f.cells.slice(0,2).map(c=>c.id));
 assert.deepEqual(result.targets.map(r=>r.value),['Alpha bin','Beta bin']);
 assert.ok(result.targets.every(r=>r.status==='sent'),JSON.stringify({targets:result.targets,errors:f.errors}));
 assert.ok(f.writes.some(line=>line.includes('text 1 "Alpha bin" white 120 100')));
 assert.ok(f.writes.some(line=>line.includes('text 2 "Beta bin" white 120 100')));
 assert.equal(f.writes.length,2);
 const n=f.writes.length;f.display.stop(f.admin,result.id);
 assert.deepEqual([...new Set(f.writes.slice(n))].sort(),['to 1 clear 1','to 1 clear 2']);
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);
});

test('warehouse quantities include all its sheds, empty-cell zero and mixed quantities without touching another warehouse',t=>{
 const f=fixture(t);f.stock(f.products[0],f.cells[0],4);f.stock(f.products[1],f.cells[0],2);f.stock(f.products[0],f.cells[3],9);
 const balances=f.db.prepare('SELECT * FROM inventory_balances').all();
 const shown=f.api({displayKind:'quantity',warehouseId:String(f.east)});
 assert.deepEqual(shown.targets.map(r=>r.cellId),f.cells.slice(0,3).map(c=>c.id));
 assert.deepEqual(shown.targets[0].sequence.map(r=>r.value),[4,2]);assert.notEqual(shown.targets[0].sequence[0].color,shown.targets[0].sequence[1].color);
 assert.deepEqual(shown.targets.slice(1).map(r=>r.value),[0,0]);
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),balances);
});

test('LED-number display uses the module output within its controller, independently of stock or the global cell ID',t=>{
 const f=fixture(t);f.stock(f.products[0],f.cells[3],9);
 const west=f.db.prepare("SELECT id FROM location_warehouses WHERE name='West'").get().id;
 const shown=f.api({displayKind:'module_number',warehouseId:String(west)});
 assert.equal(shown.targets.length,1);assert.equal(shown.targets[0].cellId,f.cells[3].id);assert.equal(shown.targets[0].value,1);
 assert.ok(f.writes.at(-1).includes('text 1 "1" yellow 120 100'));
 assert.throws(()=>f.display.start(f.op,{kind:'module_number',shelfId:f.shed}),/not permitted/);
});

test('invalid or conflicting group selectors never fall back to displaying the whole site',t=>{
 const f=fixture(t);
 for(const form of [{shelfId:''},{shelfId:'0'},{warehouseId:'bad'},{shelfId:f.shed,warehouseId:f.east},{warehouseId:'999999'}])assert.throws(()=>f.api({displayKind:'quantity',...form}),/valid|not found/);
 assert.equal(f.writes.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM display_requests').get().n,0);
});

test('unsupported names are skipped with an explanation rather than shortened or replaced with LOC',t=>{
 const f=fixture(t);f.db.prepare('UPDATE cells SET display_name=? WHERE id=?').run('A'.repeat(56),f.cells[0].id);
 const shown=f.api({displayKind:'cell_name',shelfId:String(f.shed)});
 assert.equal(shown.targets.find(r=>r.cellId===f.cells[0].id).status,'unsupported');assert.match(shown.message,/1 cell\(s\) were skipped/);
 assert.equal(f.writes.length,1);assert.ok(f.writes[0].includes('Beta bin'));assert.ok(!f.writes[0].includes('LOC'));
 f.display.stop(f.admin,shown.id);f.db.prepare('UPDATE cells SET display_name=? WHERE id=?').run('Cell "quoted"',f.cells[1].id);
 const none=f.api({displayKind:'cell_name',shelfId:String(f.shed)});assert.ok(none.targets.every(r=>r.status==='unsupported'));assert.match(none.message,/55 English/);
});

for(const kind of ['cell_name','module_number'])test(`${kind}: group override requires confirmation and restores the unchanged active task`,t=>{
 const f=fixture(t);f.stock(f.products[0],f.cells[0],4);
 const command=(action,input)=>f.work.command(f.op,action,{requestId:randomUUID(),...input});
 const task=command('create',{direction:'pick',productId:f.products[0].id,quantity:1});
 const generation=f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation,n=f.writes.length;
 const scope={kind,shelfId:f.shed};
 const preview=f.display.start(f.admin,scope,{previewOnly:true});assert.equal(preview.state,'confirmation_required');assert.equal(preview.conflicts[0].taskId,task.taskId);assert.equal(f.writes.length,n);
 assert.throws(()=>f.display.start(f.admin,{...scope,overrideWork:true}),/Confirm/);
 const shown=f.display.start(f.admin,{...scope,overrideWork:true},{confirmOverride:true});assert.equal(shown.targets.find(r=>r.cellId===f.cells[0].id).status,'sent');
 f.display.stop(f.admin,shown.id);assert.equal(f.db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(f.cells[0].id).generation,generation);assert.ok(f.writes.at(-1).includes('digit 1 "1" green'));
});

test('group displays preserve active stocktake lights even when task override is confirmed',t=>{
 const f=fixture(t);f.stock(f.products[0],f.cells[0],4);
 const count=createStocktakingService({db:f.db,operationsService:f.work});
 const run=count.command(f.admin,'create',{requestId:randomUUID(),mode:'selected',cellIds:[f.cells[0].id],assigneeId:f.admin.id}),item=count.snapshot(f.admin).runs.find(r=>r.id===run.runId).items[0];
 count.command(f.admin,'begin',{requestId:randomUUID(),itemId:item.id,generation:item.generation,method:'manual',location:f.cells[0].logical_code});
 for(const kind of ['cell_name','module_number','quantity']){
  const shown=f.display.start(f.admin,{kind,shelfId:f.shed,overrideWork:true},{confirmOverride:true});
  assert.equal(shown.targets.find(r=>r.cellId===f.cells[0].id).status,'busy');f.display.stop(f.admin,shown.id);
 }
});

test('the rendered page has scoped group controls, with LED-number access following existing hardware permission',t=>{
 const f=fixture(t),render=actor=>{let html;const response={writeHead(){},end(body){html=body;}};locationBrowseRoutes({method:'GET'},response,new URL('http://localhost/cells'),actor,{db:f.db,operationsService:f.work,displayCoordinator:f.display});return html;};
 const admin=render(f.admin);assert.match(admin,/Show cell names/);assert.match(admin,/Show LED numbers/);assert.match(admin,/Show quantities/);assert.match(admin,new RegExp(`data-warehouse-id="${f.east}"`));assert.match(admin,new RegExp(`data-shelf-id="${f.shed}"`));
 const operator=render(f.op);assert.match(operator,/Show cell names/);assert.match(operator,/Show quantities/);assert.doesNotMatch(operator,/Show LED numbers/);
});
