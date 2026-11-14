import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as XLSX from 'xlsx';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {migrateLocationHierarchy,locationHierarchy} from '../src/modules/locations/hierarchy.js';
import {locationTree} from '../public/client/location-tree.js';
import {locationGroupFields} from '../public/client/location-groups.js';
import {warehouseExcelBuffer,MAPPING_COLUMNS,STOCK_COLUMNS} from '../src/services/warehouse-excel.js';
import {parseWarehouseExcel} from '../src/modules/excel/workbook.js';

test('old default group names migrate without changing location, QR, LED or stock identities',()=>{
 const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),'hierarchy-terms-'));let db;
 try{
  process.chdir(dir);db=createDatabase({hashPassword,allowDemoInventorySeed:true});
  db.exec(`DELETE FROM app_metadata WHERE key='location_terminology_v2';
   DROP TRIGGER location_hierarchy_details; DROP TRIGGER location_hierarchy_insert;
   UPDATE location_warehouses SET name='Default Warehouse' WHERE name='Default Shed';
   UPDATE location_shelves SET name='Unassigned shed/shelf' WHERE name='Unassigned rack';
   UPDATE cells SET warehouse_name='Default Warehouse',travel_instructions='Unassigned shed/shelf';`);
  const before=db.prepare('SELECT id,logical_code,label_id,shelf_id,controller_id,hardware_channel,binding_revision,description_revision FROM cells ORDER BY id').all();
  const balances=db.prepare('SELECT * FROM inventory_balances ORDER BY id').all();
  const groups=locationHierarchy(db);migrateLocationHierarchy(db);
  assert.equal(locationHierarchy(db).warehouses[0].name,'Default Shed');
  assert.equal(locationHierarchy(db).shelves[0].name,'Unassigned rack');
  assert.deepEqual(locationHierarchy(db).warehouses.map(w=>w.id),groups.warehouses.map(w=>w.id));
  assert.deepEqual(db.prepare('SELECT id,logical_code,label_id,shelf_id,controller_id,hardware_channel,binding_revision,description_revision FROM cells ORDER BY id').all(),before);
  assert.deepEqual(db.prepare('SELECT * FROM inventory_balances ORDER BY id').all(),balances);
  assert.ok(db.prepare('SELECT warehouse_name,travel_instructions FROM cells').all().every(c=>c.warehouse_name==='Default Shed'&&c.travel_instructions==='Unassigned rack'));
  const after=locationHierarchy(db);migrateLocationHierarchy(db);assert.deepEqual(locationHierarchy(db),after);
  // A name entered by a customer after migration remains their own name.
  db.prepare("UPDATE cells SET warehouse_name='Warehouse West',travel_instructions='Shelf 7' WHERE id=?").run(before[0].id);
  migrateLocationHierarchy(db);const custom=db.prepare('SELECT * FROM cells WHERE id=?').get(before[0].id);assert.equal(custom.warehouse_name,'Warehouse West');assert.equal(custom.travel_instructions,'Shelf 7');
 }finally{db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});}
});

test('new mapping workbooks use Bin/Shed/Rack while old headings remain accepted without ambiguity',()=>{
 const data={mappingRows:[['A','CTRL1',4,'North','R2']],stockRows:[['P1','Item','A',8,'NOS',10,'Brand','','','']]};
 const buffer=warehouseExcelBuffer(data),book=XLSX.read(buffer,{type:'buffer'});
 assert.deepEqual(MAPPING_COLUMNS,['Bin Name','Controller Name','Physical LED number','Shed','Rack']);
 assert.equal(STOCK_COLUMNS[2],'Bin Name');
 assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['LED Mapping'],{header:1})[0],MAPPING_COLUMNS);
 const current=parseWarehouseExcel(buffer);assert.equal(current.mappings[0].warehouse,'North');assert.equal(current.mappings[0].shelf,'R2');assert.equal(current.stock[0].location,'A');
 for(const [address,value]of Object.entries({A1:'Cell Name',D1:'Warehouse',E1:'Shed/Shelf'}))book.Sheets['LED Mapping'][address].v=value;
 book.Sheets['Products & Stock'].C1.v='Cell Name';
 const legacy=parseWarehouseExcel(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
 assert.deepEqual(legacy.mappings,current.mappings);assert.deepEqual(legacy.stock,current.stock);
 book.Sheets['LED Mapping'].F1={t:'s',v:'Bin Name'};book.Sheets['LED Mapping']['!ref']='A1:F2';
 assert.throws(()=>parseWarehouseExcel(XLSX.write(book,{type:'buffer',bookType:'xlsx'})),/each column header once/);
});

test('hierarchy headings and edit controls say Shed/Rack/Bin while stable display scopes remain unchanged',()=>{
 const data={warehouses:[{id:1,name:'North'}],shelves:[{id:2,name:'R2',warehouse_id:1}],cells:[{id:3,shelf_id:2,logical_code:'A'}]};
 const html=locationTree(data,{3:'<article>Bin A</article>'},{displayCapabilities:['locations.locate']});
 assert.match(html,/>Shed</);assert.match(html,/>Rack</);assert.match(html,/1 rack · 1 bin/);assert.match(html,/Show bin names/);
 assert.match(html,/data-warehouse-id="1"/);assert.match(html,/data-shelf-id="2"/);assert.match(html,/data-display-kind="cell_name"/);
 const editing=locationTree(data,{}, {editing:true});assert.match(editing,/Move to rack/);assert.match(editing,/Shed name/);assert.match(editing,/Rack name/);
 const form=locationGroupFields(data);assert.match(form,/>Shed<select/);assert.match(form,/>Rack<select/);assert.match(form,/Add new rack/);
});
