import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as XLSX from 'xlsx';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules,createProduct} from '../src/services/inventory.js';
import {saveControllerProfile} from '../src/services/controller-profiles.js';
import {createBackupService} from '../src/services/backups.js';
import {warehouseExcelData,warehouseExcelBuffer,WAREHOUSE_EXCEL_FILE} from '../src/services/warehouse-excel.js';
import {routeAllowed} from '../src/modules/access/routes-policy.js';
import {effectiveUser} from '../src/modules/access/service.js';
import {spawnSync} from 'node:child_process';
import {writeWarehouseExcel} from '../src/services/warehouse-excel.js';
import {createWarehouseExcelService} from '../src/modules/excel/service.js';
import {parseWarehouseExcel} from '../src/modules/excel/workbook.js';
import {createLocationSetupService} from '../src/modules/locations/service.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createStocktakingService} from '../src/modules/stocktaking/service.js';

function fixture(fn){
  const cwd=process.cwd(),root=realpathSync(mkdtempSync(join(tmpdir(),'warehouse-excel-')));let db;
  try{
    process.chdir(root);db=createDatabase({hashPassword,allowDemoInventorySeed:false,allowWarehouseSeeds:false});
    const actor=db.prepare("SELECT * FROM users WHERE role='admin'").get();
    db.prepare("INSERT INTO zones(code,name) VALUES('TEST','Test')").run();
    const made=configureControllerModules(db,{controllerCode:'CTRL1',controllerAddress:'CTRL-EXCEL',moduleCount:4,configuredBy:actor.id});
    const controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(made.id);
    saveControllerProfile(db,controller,{physicalCount:4,logicalCount:4,routing:Array.from({length:64},(_,i)=>[3,1,4,2][i]||0),revision:1});
    const cell=db.prepare('SELECT * FROM cells WHERE controller_id=? AND hardware_channel=2').get(controller.id);
    db.prepare("UPDATE cells SET active=1,mapping_status='mapped',display_name='001',warehouse_name='Main',travel_instructions='Shelf A' WHERE id=?").run(cell.id);
    const product=createProduct(db,{sku:'000123',name:'=Literal product',brand:'Sample',unit_of_measure:'pieces',items_per_cell:10});
    const productId=Number(product.id);
    db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,8,3)').run(productId,cell.id);
    const backups=createBackupService({getDb:()=>db,reloadAppState(){},logger:{info(){},warn(){}}});
    const operations=createOperationsService({db}),locations=createLocationSetupService({db,operationsService:operations,displayCoordinator:{}}),counts=createStocktakingService({db,operationsService:operations});
    const excel=createWarehouseExcelService({db,locationSetupService:locations,stocktakingService:counts,backupService:backups});
    return fn({db,root,actor,controller,cell,productId,backups,operations,locations,counts,excel});
  }finally{db?.close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
}

test('Excel uses physical LED routing and physical stock, preserving text identifiers',()=>fixture(({db,cell})=>{
  const data=warehouseExcelData(db),mapped=data.mappingRows.find(row=>row[0]==='001');
  assert.deepEqual(mapped,['001','CTRL1',1,'Main','Shelf A']);
  const stock=data.stockRows.find(row=>row[0]==='000123');assert.equal(stock[3],8);
  const book=XLSX.read(warehouseExcelBuffer(data),{type:'buffer'});
  assert.deepEqual(book.SheetNames,['LED Mapping','Products & Stock']);
  assert.equal(book.Sheets['Products & Stock'].A2.v,'000123');
  assert.equal(book.Sheets['Products & Stock'].B2.v,'=Literal product');assert.equal(book.Sheets['Products & Stock'].B2.f,undefined);
  assert.equal(book.Sheets['Products & Stock'].D2.t,'n');
  assert.equal(db.prepare('SELECT available_quantity n FROM inventory_balances WHERE cell_id=?').get(cell.id).n,8);
}));

const stockRow=(cell,quantity,sku='000123',name='Literal product')=>[sku,name,cell,quantity,'pieces',10,'Sample','','',''];
const upload=(f,mappingRows=[],stockRows=[])=>f.excel.upload(f.actor,{fileName:'Warehouse.xlsx',base64:warehouseExcelBuffer({mappingRows,stockRows}).toString('base64')});
const newLocation=(f,key,physical)=>({key,create:true,confirmed:true,displayName:key,controllerId:f.controller.id,physical,warehouseName:'Main',travelInstructions:'Shelf A'});
const review=(f,draft,choices={})=>f.excel.review(f.actor,{id:draft.id,counterIds:[f.actor.id],...choices});
const apply=(f,reviewed)=>f.excel.apply(f.actor,{id:reviewed.id,token:reviewed.token,confirmed:true});

test('controller health polling does not expire a reviewed Excel import',()=>fixture(f=>{
 const checked=review(f,upload(f,[],[stockRow('001',5)]));
 f.db.prepare("UPDATE controllers SET last_seen_at=?,heartbeat_status='online' WHERE id=?").run(new Date().toISOString(),f.controller.id);
 const result=apply(f,checked);
 assert.equal(result.stocktakes.length,1);
 assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE product_id=? AND cell_id=?').get(f.productId,f.cell.id).available_quantity,8);
}));

test('a controller configuration change still invalidates a reviewed import',()=>fixture(f=>{
 const checked=review(f,upload(f,[],[stockRow('001',5)]));
 f.db.prepare('UPDATE controllers SET controller_code=? WHERE id=?').run('Renamed',f.controller.id);
 assert.throws(()=>apply(f,checked),/changed after your review/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,0);
}));

test('imported counts create product-scoped work only for mismatches; inventory and reservations stay untouched',()=>fixture(f=>{
  const before=f.db.prepare('SELECT * FROM inventory_balances').all(),draft=upload(f,[],[stockRow('001',5)]);
  const checked=review(f,draft);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,0);
  assert.equal(checked.summary.stocktakes[0].recordedTotal,8);assert.equal(checked.summary.stocktakes[0].proposedTotal,5);
  const result=apply(f,checked),run=f.db.prepare('SELECT * FROM stocktake_runs WHERE id=?').get(result.stocktakes[0].runId);
  assert.deepEqual(JSON.parse(run.scope_json),{mode:'product',cellIds:[f.cell.id],warehouseId:null,shelfId:null,productId:f.productId});
  assert.equal(run.started_at,null);assert.equal(run.display_enabled,0);
  assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transactions').get().n,0);
  assert.equal(f.counts.snapshot(f.actor).runs.find(r=>r.id===run.id).items[0].assignee_id,f.actor.id);
  assert.equal(apply(f,checked).replayed,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,1);
}));

test('a repeat file reuses pending product/cell counts instead of making duplicate tasks',()=>fixture(f=>{
  apply(f,review(f,upload(f,[],[stockRow('001',5)])));
  const result=apply(f,review(f,upload(f,[],[stockRow('001',4)])));
  assert.equal(result.stocktakes[0].runId,null);assert.equal(result.stocktakes[0].existingRunIds.length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,1);
}));

test('each unfamiliar location is resolved once across both sheets; duplicate aliases cannot double-count a cell',()=>fixture(f=>{
  const draft=upload(f,[['A','CTRL1',1],['A','CTRL1',1]],[stockRow('A',4)]);
  assert.equal(draft.locations.length,1);assert.equal(draft.locations[0].existingId,null);
  assert.throws(()=>review(f,draft),/Confirm creating A/);
  const result=apply(f,review(f,draft,{locations:[{key:'a',existingId:f.cell.id}]}));
  assert.equal(result.newLocations.length,0);assert.equal(result.stocktakes[0].cells[0].cellId,f.cell.id);
  const duplicate=upload(f,[],[stockRow('A',3),stockRow('001',5)]);
  assert.throws(()=>review(f,duplicate,{locations:[{key:'a',existingId:f.cell.id}]}),/appears more than once/);
}));

test('new locations and products need explicit confirmation and all changes are staged before saving',()=>fixture(f=>{
  const draft=upload(f,[['A','CTRL1',2]],[stockRow('A',6,'NEW','New product')]);
  const products=[{key:'sku:NEW',confirmed:true,sku:'NEW',name:'New product',unit:'pieces',itemsPerCell:10,brand:'Sample'}];
  assert.throws(()=>review(f,draft,{locations:[{...newLocation(f,'a',2),confirmed:false}],products}),/Confirm creating/);
  assert.throws(()=>review(f,draft,{locations:[newLocation(f,'a',2)],products:[{...products[0],confirmed:false}]}),/Confirm the new product/);
  assert.equal(f.db.prepare("SELECT 1 FROM cells WHERE display_name='a'").get(),undefined);
  const checked=review(f,draft,{locations:[newLocation(f,'a',2)],products});
  assert.equal(f.db.prepare("SELECT 1 FROM products WHERE sku='NEW'").get(),undefined);
  const result=apply(f,checked);assert.equal(result.newLocations.length,1);assert.equal(result.newProducts.length,1);
  assert.equal(f.db.prepare('SELECT hardware_channel FROM cells WHERE id=?').get(result.newLocations[0].id).hardware_channel,4);
  assert.equal(f.db.prepare('SELECT COALESCE(SUM(available_quantity),0) n FROM inventory_balances WHERE product_id=?').get(result.newProducts[0].id).n,0);
  assert.equal(result.stocktakes[0].cells[0].recorded,0);assert.equal(result.stocktakes[0].cells[0].imported,6);
  // The imported quantity becomes inventory only after a counter verifies it.
  const runId=result.stocktakes[0].runId;
  const command=(action,input)=>f.counts.command(f.actor,action,{requestId:crypto.randomUUID(),...input});
  command('start',{runId});
  const item=f.counts.snapshot(f.actor).runs.find(r=>r.id===runId).items[0];
  const cell=f.db.prepare('SELECT * FROM cells WHERE id=?').get(item.cell_id);
  const attempt=command('begin',{itemId:item.id,generation:item.generation,method:'manual',location:cell.logical_code});
  command('observe',{attemptId:attempt.attemptId,lines:[{productId:result.newProducts[0].id,actual:6}]});
  assert.equal(f.db.prepare('SELECT available_quantity n FROM inventory_balances WHERE product_id=? AND cell_id=?').get(result.newProducts[0].id,cell.id).n,6);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_observations').get().n,1);
  assert.equal(f.db.prepare('SELECT available_quantity n FROM inventory_balances WHERE product_id=? AND cell_id=?').get(f.productId,f.cell.id).n,8);
}));

test('redistribution with the same total still counts only changed cells, and omitted cells remain untouched',()=>fixture(f=>{
  const cell2=f.locations.command(f.actor,'manual',{requestId:crypto.randomUUID(),displayName:'Second'}).cellId;
  const cell3=f.locations.command(f.actor,'manual',{requestId:crypto.randomUUID(),displayName:'Untouched'}).cellId;
  f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity) VALUES(?,?,9)').run(f.productId,cell3);
  const result=apply(f,review(f,upload(f,[],[stockRow('001',3),stockRow('Second',5)])));
  const change=result.stocktakes[0];assert.equal(change.recordedTotal,17);assert.equal(change.proposedTotal,17);
  assert.deepEqual(change.cells.map(c=>c.cellId),[f.cell.id,cell2]);
  assert.equal(f.db.prepare('SELECT available_quantity n FROM inventory_balances WHERE cell_id=?').get(cell3).n,9);
}));

test('occupied LEDs, missing counters, changed stock and unauthorized users cannot apply an import',()=>fixture(f=>{
  const draft=upload(f,[['New','CTRL1',1]],[stockRow('New',3)]);
  assert.throws(()=>review(f,draft,{locations:[newLocation(f,'new',1)]}),/belongs to 001/);
  assert.equal(f.db.prepare("SELECT 1 FROM cells WHERE display_name='new'").get(),undefined);
  const counts=upload(f,[],[stockRow('001',4)]);
  assert.throws(()=>review(f,counts,{counterIds:[]}),/Choose at least one counter/);
  const checked=review(f,counts);f.db.prepare('UPDATE inventory_balances SET available_quantity=7').run();
  assert.throws(()=>apply(f,checked),/changed after your review/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,0);
  const operator=f.db.prepare("SELECT * FROM users WHERE role='operator'").get();
  assert.throws(()=>f.excel.upload(operator,{base64:warehouseExcelBuffer({mappingRows:[],stockRows:[stockRow('001',4)]}).toString('base64')}),/not permitted/);
}));

test('matching counts need no stocktake; unknown controller names and unit changes are actionable errors',()=>fixture(f=>{
  const result=apply(f,review(f,upload(f,[],[stockRow('001',8)]),{counterIds:[]}));assert.equal(result.stocktakes.length,0);
  assert.throws(()=>review(f,upload(f,[['001','Wrong Controller',1]],[])),/exactly match/);
  const row=stockRow('001',5);row[4]='boxes';assert.throws(()=>review(f,upload(f,[],[row])),/use pieces/);
}));

test('Excel parser rejects formulas, invalid quantities and conflicting duplicate mappings',()=>fixture(f=>{
  const book=XLSX.read(warehouseExcelBuffer({mappingRows:[],stockRows:[stockRow('001',3)]}),{type:'buffer'});
  book.Sheets['Products & Stock'].D2={t:'n',v:3,f:'SUM(1,2)'};
  assert.throws(()=>parseWarehouseExcel(XLSX.write(book,{type:'buffer',bookType:'xlsx'})),/Replace formulas/);
  assert.throws(()=>upload(f,[],[stockRow('001',-1)]),/Actual Stock/);
  assert.throws(()=>upload(f,[['A','CTRL1',1],['A','CTRL1',2]],[]),/conflicting LED/);
}));

test('Excel parser checks actual compressed content instead of trusting its declared size',()=>{
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Cell Name','Controller Name','Physical LED number'],['A','CTRL1',1]]),'LED Mapping');
  const file=XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true});
  assert.equal(parseWarehouseExcel(file).mappings.length,1);
  const malformed=Buffer.from(file),entry=malformed.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  assert.ok(entry>=0);malformed.writeUInt32LE(1,entry+24);
  assert.throws(()=>parseWarehouseExcel(malformed),/large or damaged|incorrect entry sizes/);
});

test('every backup kind atomically refreshes one workbook without adding workbook files to backup rotation',()=>fixture(({db,root,backups,cell})=>{
  let quantity=8;
  for(const kind of ['manual','auto','critical']){
    db.prepare('UPDATE inventory_balances SET available_quantity=? WHERE cell_id=?').run(quantity,cell.id);
    const backup=backups.createBackup({kind,source:'excel-test'});assert.equal(backup.excel.lastError,null);
    const book=XLSX.read(backups.readExcel(),{type:'buffer'});assert.equal(book.Sheets['Products & Stock'].D2.v,quantity);
    assert.equal(backups.getExcelStatus().path,join(root,'data/backups',WAREHOUSE_EXCEL_FILE));quantity++;
  }
  assert.equal(readdirSync(join(root,'data/backups')).filter(name=>name.endsWith('.xlsx')).length,1);
  assert.equal(backups.listBackups().length,3);
}));

test('unknown physical routing leaves the last good workbook intact and still creates a recoverable backup',()=>fixture(({db,root,backups,controller})=>{
  backups.createBackup();const bytes=backups.readExcel();
  db.prepare('DELETE FROM app_metadata WHERE key=?').run('controller_profile:'+controller.id);
  const backup=backups.createBackup();assert.match(backup.excel.lastError,/verified controller/);
  assert.equal(backups.listBackups().length,2);assert.deepEqual(backups.readExcel(),bytes);
  assert.match(JSON.parse(readFileSync(join(root,'data/backups/warehouse-excel-status.json'),'utf8')).lastError,/verified controller/);
}));

test('zero stock and catalog-only products remain exportable, download respects permissions',()=>fixture(({db,productId,actor})=>{
  db.prepare('UPDATE inventory_balances SET available_quantity=0 WHERE product_id=?').run(productId);
  createProduct(db,{sku:'EMPTY',name:'Empty product',brand:'Sample',unit_of_measure:'pieces',items_per_cell:8});
  const data=warehouseExcelData(db);assert.equal(data.stockRows.find(row=>row[0]==='000123')[3],0);
  assert.deepEqual(data.stockRows.find(row=>row[0]==='EMPTY').slice(2,4),['','']);
  assert.equal(routeAllowed(effectiveUser(db,actor),'GET','/backups/warehouse.xlsx'),true);
  const operator=db.prepare("SELECT * FROM users WHERE role='operator'").get();
  assert.equal(routeAllowed(effectiveUser(db,operator),'GET','/backups/warehouse.xlsx'),false);
}));

test('installed recovery exports the same frozen stock as its portable archive, without altering the archive format',()=>fixture(({db,root,cell})=>{
  const snapshot=join(root,'excel-snapshot.sqlite'),archive=join(root,'snapshot.lytbackup');
  const script=new URL('../scripts/release/portable-backup.py',import.meta.url).pathname;
  const run=input=>{
    const result=spawnSync('python3',[script],{input:JSON.stringify(input),encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  const manifest=run({action:'create',data:join(root,'data'),destination:archive,version:'test',excelSnapshot:snapshot});
  assert.equal(manifest.excelSnapshotError,undefined);
  db.prepare('UPDATE inventory_balances SET available_quantity=2 WHERE cell_id=?').run(cell.id);
  const destination=join(root,'warehouse.xlsx');writeWarehouseExcel(snapshot,destination);
  const book=XLSX.read(readFileSync(destination),{type:'buffer'});assert.equal(book.Sheets['Products & Stock'].D2.v,8);
  const extracted=run({action:'extract',source:archive,destination:join(root,'restored')});
  assert.equal(extracted.formatVersion,1);
  assert.ok(!manifest.files.some(file=>file.path.endsWith('.xlsx')));
}));
