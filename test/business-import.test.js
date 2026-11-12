import {historicalFactor} from '../src/modules/operations/corrections.js';
import {createProductPages} from '../src/server/pages/products.js';
import {getProductDetail,listProducts} from '../src/services/inventory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as XLSX from 'xlsx';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createStocktakingService} from '../src/modules/stocktaking/service.js';
import {createBusinessImportService} from '../src/modules/imports/service.js';
import {saveBusinessProduct,productStockTotal,finishCountCapacities} from '../src/modules/imports/catalog.js';
import {IMPORT_COLUMNS} from '../src/modules/imports/workbook.js';

const product=(changes={})=>({cos_sec:'01',part_no:'001234',nomen1:'Test item',stok_ser:0,au:'NOS',mpi_status:'CURRENT',cicp_id:'00012',review_dt:'2026-11-10',...changes});
function fixture(fn){
 const cwd=process.cwd(),root=realpathSync(mkdtempSync(join(tmpdir(),'business-import-')));let db,work;
 try{process.chdir(root);db=createDatabase({hashPassword,allowDemoInventorySeed:true});db.exec('DELETE FROM inventory_balances');
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get(),cells=db.prepare('SELECT * FROM cells WHERE active=1 LIMIT 3').all();
 work=createOperationsService({db});const count=createStocktakingService({db,operationsService:work});let backups=0;
 const service=createBusinessImportService({db,operationsService:work,stocktakingService:count,backupService:{createBackup(){backups++;}}});
 const upload=(kind,rows)=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([IMPORT_COLUMNS[kind].map(([key])=>key),...rows.map(r=>IMPORT_COLUMNS[kind].map(([key])=>r[key]??''))]),'Data');return service.upload(admin,{kind,fileName:'synthetic.xlsx',base64:XLSX.write(wb,{type:'buffer',bookType:'xlsx'}).toString('base64')});};
 const review=(d,input={})=>service.review(admin,{id:d.id,counterIds:[op.id],assigneeId:op.id,rows:d.rows.map(r=>({row:r.row,createConfirmed:true,mpiStatus:'CURRENT'})),...input});
 const apply=r=>service.apply(admin,{id:r.id,token:r.token,confirmed:true});
 const add=(changes={},capacity=10)=>saveBusinessProduct(db,product(changes),{confirmed:true,capacity});
 const stock=(p,q,c=cells[0])=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0) ON CONFLICT(product_id,cell_id) DO UPDATE SET available_quantity=excluded.available_quantity').run(p.id,c.id,q);
 const wcmd=(a,action,input)=>work.command(a,action,{requestId:randomUUID(),...input});const cmd=(action,input)=>count.command(op,action,{requestId:randomUUID(),...input});
 fn({db,admin,op,cells,work,count,service,upload,review,apply,add,stock,wcmd,cmd,backups:()=>backups});
 }finally{work?.dispose();db?.close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
}
const receipt=(changes={})=>({comp_no:'00012',rv_no:'R001',rv_dt:'2026-11-10',sub_depot:'D',cos_sec:'01',part_no:'001234',condition:'SER',nomen1:'Test item',qty_r:2,au:'NOS',cust_code:'C',cust:'Customer',created_by:'Clerk',inspected_by:'Inspector',...changes});
const issue=(changes={})=>({comp_no:'00012',gs_no:'I001',issu_dt:'2026-11-10',sub_depot:'D',cos_sec:'01',part_no:'001234',nomen1:'Test item',auth:'Authority',qty_iss:2,au:'NOS',cust_code:'C',cust:'Customer',sus_no:'S1',...changes});

test('product preview is read-only; mismatches create scoped stocktakes without replacing physical stock',()=>fixture(f=>{
 const p=f.add();f.stock(p,5);const before=f.db.prepare('SELECT * FROM inventory_balances').all();
 const d=f.upload('products',[product({stok_ser:8,nomen1:'Renamed'})]),r=f.review(d);assert.equal(r.ready,1,JSON.stringify(r));assert.equal(f.db.prepare('SELECT name FROM products WHERE id=?').get(p.id).name,'Test item');
 const done=f.apply(r);assert.equal(done.ready,1);assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);assert.equal(f.db.prepare('SELECT name FROM products WHERE id=?').get(p.id).name,'Renamed');
 const run=f.db.prepare('SELECT * FROM stocktake_runs WHERE id=?').get(done.rows[0].stocktakeId);assert.deepEqual(JSON.parse(run.scope_json).cellIds,[f.cells[0].id]);assert.equal(run.started_at,null);assert.equal(f.apply(r).replayed,true);assert.equal(f.backups(),1);
}));
test('new product requires confirmation and can count selected cells or the whole warehouse',()=>fixture(f=>{
 const d=f.upload('products',[product({stok_ser:8})]);let r=f.review(d,{rows:[]});assert.equal(r.blocked,1);assert.match(r.rows[0].message,/Tick Create/);
 r=f.review(d,{rows:[{row:2,createConfirmed:true,cellIds:[f.cells[1].id]}]});assert.equal(r.ready,1,JSON.stringify(r));let done=f.apply(r);let p=f.db.prepare('SELECT * FROM products WHERE id=?').get(done.rows[0].productId);assert.equal(p.capacity_pending,1);assert.equal(productStockTotal(f.db,p.id),0);assert.deepEqual(JSON.parse(f.db.prepare('SELECT scope_json FROM stocktake_runs WHERE id=?').get(done.rows[0].stocktakeId).scope_json).cellIds,[f.cells[1].id]);
 done=f.apply(f.review(f.upload('products',[product({part_no:'OTHER',stok_ser:4})])));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_items WHERE run_id=?').get(done.rows[0].stocktakeId).n,f.db.prepare('SELECT COUNT(*) n FROM cells WHERE active=1').get().n);
}));
test('matching physical stock includes reservations and compares only the selected MPI row',()=>fixture(f=>{
 const a=f.add(),b=f.add({mpi_status:'OBT'});f.stock(a,10);f.stock(b,7);f.wcmd(f.admin,'assign',{direction:'pick',productId:a.id,quantity:3,assigneeId:f.op.id});
 const done=f.apply(f.review(f.upload('products',[product({stok_ser:10})])));assert.equal(done.rows[0].stocktakeId,null);assert.equal(productStockTotal(f.db,b.id),7);
}));
test('received Condition is separate; every UNS row is retained without creating products or Put tasks',()=>fixture(f=>{
 const d=f.upload('received',[receipt({condition:' uns ',part_no:'A'}),receipt({condition:'UNS',part_no:'B'})]);const done=f.apply(f.review(d));assert.equal(done.excluded,2);assert.equal(done.ready,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM products WHERE cos_sec IS NOT NULL').get().n,0);
 const voucher=f.service.detail(f.admin,done.rows[0].voucherId);assert.equal(voucher.rows.length,2);assert.ok(voucher.rows.every(r=>r.mpi_status==='CURRENT'&&r.task_id===null));assert.equal(f.apply(f.review(f.upload('received',[receipt({condition:'UNS',part_no:'A'})]))).excluded,1);
}));
test('eligible receipt always creates CURRENT Put even if only an OBT variant exists; condition is on voucher/task',()=>fixture(f=>{
 const obt=f.add({mpi_status:'OBT'});f.stock(obt,2);const d=f.upload('received',[receipt({condition:'NEW'})]);let r=f.review(d);assert.equal(r.blocked,1);assert.match(r.rows[0].message,/items per location/);
 r=f.review(d,{rows:[{row:2,createConfirmed:true,itemsPerCell:10,mpiStatus:'OBT'}]});assert.equal(r.ready,1,JSON.stringify(r));const done=f.apply(r),line=f.db.prepare('SELECT * FROM voucher_lines WHERE task_id=?').get(done.rows[0].taskId);assert.equal(line.mpi_status,'CURRENT');assert.equal(line.condition,'NEW');assert.notEqual(line.product_id,obt.id);assert.equal(productStockTotal(f.db,obt.id),2);assert.match(f.work.task(f.admin,line.task_id).instruction_note||'',/Condition: NEW/);
}));
test('issue MPI selection picks only that variant, and repeated files do not create duplicate tasks',()=>fixture(f=>{
 const a=f.add(),b=f.add({mpi_status:'OBT'});f.stock(a,5);f.stock(b,5);const rows=[issue()];const d=f.upload('issue',rows),r=f.review(d,{rows:[{row:2,mpiStatus:'OBT'}]});assert.equal(r.ready,1,JSON.stringify(r));const done=f.apply(r);assert.ok(f.work.task(f.admin,done.rows[0].taskId).lines.every(l=>l.product_id===b.id));assert.equal(f.apply(f.review(f.upload('issue',rows))).existing,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
}));
test('partial voucher import creates valid rows and retries only pending rows',()=>fixture(f=>{
 const p=f.add();f.stock(p,10);const rows=[issue(),issue({gs_no:'I002',part_no:'MISSING'})];let result=f.apply(f.review(f.upload('issue',rows)));assert.equal(result.ready,1,JSON.stringify(result));assert.equal(result.blocked,1);const p2=f.add({part_no:'MISSING'});f.stock(p2,5);result=f.apply(f.review(f.upload('issue',rows)));assert.equal(result.existing,1);assert.equal(result.ready,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,2);
}));
test('MPI reclassification preserves stock and sends open tasks to review, including started tasks',()=>fixture(f=>{
 const p=f.add();f.stock(p,5);const created=f.wcmd(f.op,'create',{direction:'pick',productId:p.id,quantity:2});const r=f.review(f.upload('products',[product({mpi_status:'OBT',stok_ser:5})]));assert.equal(r.ready,1,JSON.stringify(r));f.apply(r);assert.equal(productStockTotal(f.db,p.id),5);assert.equal(f.db.prepare('SELECT mpi_status FROM products WHERE id=?').get(p.id).mpi_status,'OBT');const t=f.work.task(f.admin,created.taskId);assert.equal(t.attention,1);assert.equal(t.outcome,'needs_review');
}));
test('multiple MPI variants require choosing the row to change or explicitly adding a new one',()=>fixture(f=>{
 const a=f.add(),b=f.add({mpi_status:'OBT'});f.stock(a,4);f.stock(b,3);const d=f.upload('products',[product({mpi_status:'NFP',stok_ser:3})]);let r=f.review(d);assert.equal(r.blocked,1);assert.match(r.rows[0].message,/Choose which/);r=f.review(d,{rows:[{row:2,sourceProductId:b.id}]});assert.equal(r.ready,1);f.apply(r);assert.equal(productStockTotal(f.db,b.id),3);assert.equal(f.db.prepare('SELECT mpi_status FROM products WHERE id=?').get(a.id).mpi_status,'CURRENT');
 const newD=f.upload('products',[product({mpi_status:'OBE'})]);f.apply(f.review(newD,{rows:[{row:2,sourceProductId:'new',createConfirmed:true}]}));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM products WHERE cos_sec=?').get('01').n,3);
}));
test('changed voucher requires confirmation, updates unstarted task, refuses a later started task or UNS reclassification',()=>fixture(f=>{
 const p=f.add();f.stock(p,10);let done=f.apply(f.review(f.upload('issue',[issue()])));const id=done.rows[0].taskId,d=f.upload('issue',[issue({qty_iss:3})]);let r=f.review(d);assert.equal(r.blocked,1);r=f.review(d,{rows:[{row:2,mpiStatus:'CURRENT',updateConfirmed:true}]});assert.equal(r.ready,1,JSON.stringify(r));f.apply(r);assert.equal(f.work.task(f.admin,id).requested_quantity,3);
 const t=f.work.task(f.op,id);f.wcmd(f.op,'start',{taskId:id,generation:t.assignment_generation});r=f.review(f.upload('issue',[issue({qty_iss:4})]),{rows:[{row:2,mpiStatus:'CURRENT',updateConfirmed:true}]});assert.equal(r.blocked,1);assert.match(r.rows[0].message,/already started/);
 done=f.apply(f.review(f.upload('received',[receipt()])));assert.equal(done.ready,1,JSON.stringify(done));r=f.review(f.upload('received',[receipt({condition:'UNS'})]));assert.equal(r.blocked,1);assert.match(r.rows[0].message,/already has a task/);
}));
test('stale previews and unauthorized users cannot import; a post-save LED failure cannot undo or duplicate work',()=>fixture(f=>{
 const p=f.add();f.stock(p,10);const d=f.upload('issue',[issue()]),r=f.review(d);f.stock(p,9);assert.throws(()=>f.apply(r),/changed after/);assert.throws(()=>f.service.review(f.op,{id:d.id}),/not permitted/);const fresh=f.review(d);f.work.flushGuidance=()=>{throw Error('Offline');};const done=f.apply(fresh);assert.equal(done.ready,1);assert.match(done.warning,/Saved/);assert.equal(f.apply(fresh).replayed,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
}));
test('pending capacity is inferred once from the maximum completed cell count, or from explicit stocktake input',()=>fixture(f=>{
 const done=f.apply(f.review(f.upload('products',[product({stok_ser:8})]),{rows:[{row:2,createConfirmed:true,cellIds:f.cells.slice(0,2).map(c=>c.id)}]}));const {productId,stocktakeId:runId}=done.rows[0];f.cmd('start',{runId});
 for(const [index,c] of f.cells.slice(0,2).entries()){const item=f.count.snapshot(f.op).runs.find(r=>r.id===runId).items.find(i=>i.cell_id===c.id);const begin=f.cmd('begin',{itemId:item.id,generation:item.generation,method:'manual',location:c.logical_code});f.cmd('observe',{attemptId:begin.attemptId,lines:[{productId,actual:index?5:3,unit:'NOS'}]});}
 let p=f.db.prepare('SELECT * FROM products WHERE id=?').get(productId);assert.equal(p.items_per_cell,5);assert.equal(p.capacity_pending,0);assert.equal(productStockTotal(f.db,productId),8);f.db.prepare('UPDATE products SET items_per_cell=12 WHERE id=?').run(productId);finishCountCapacities(f.db,runId);assert.equal(f.db.prepare('SELECT items_per_cell FROM products WHERE id=?').get(productId).items_per_cell,12);
}));

test('routine user activity and controller health polling do not invalidate a preview',()=>fixture(f=>{
 const p=f.add();f.stock(p,5);const preview=f.review(f.upload('products',[product({stok_ser:5})]));f.db.prepare('UPDATE users SET last_active_at=? WHERE id=?').run(new Date().toISOString(),f.admin.id);f.db.prepare("UPDATE controllers SET last_seen_at=?,heartbeat_status='online'").run(new Date().toISOString());assert.equal(f.apply(preview).ready,1);
}));

test('capacity entered during counting takes precedence and a different retry cannot silently change it',()=>fixture(f=>{
 const d=f.apply(f.review(f.upload('products',[product({stok_ser:4})]),{rows:[{row:2,createConfirmed:true,cellIds:[f.cells[0].id]}]}));const {productId,stocktakeId:runId}=d.rows[0];f.cmd('start',{runId});const item=f.count.snapshot(f.op).runs.find(r=>r.id===runId).items[0],attempt=f.cmd('begin',{itemId:item.id,generation:item.generation,method:'manual',location:f.cells[0].logical_code});const input={attemptId:attempt.attemptId,lines:[{productId,actual:4,unit:'NOS',itemsPerCell:12}]};f.cmd('observe',input);assert.equal(f.db.prepare('SELECT items_per_cell FROM products WHERE id=?').get(productId).items_per_cell,12);assert.throws(()=>f.cmd('observe',{...input,lines:[{...input.lines[0],itemsPerCell:20}]}),/different count/);assert.equal(f.db.prepare('SELECT items_per_cell FROM products WHERE id=?').get(productId).items_per_cell,12);
}));
test('new product screen and product settings respect Add versus Edit permissions and keep MPI changes audited',()=>fixture(f=>{
 const added=f.service.saveProduct(f.op,{...product(),itemsPerCell:10,confirmed:'1'});assert.ok(added.productId);assert.match(added.redirectUrl,/products/);assert.throws(()=>f.service.saveProduct(f.op,{...product(),productId:added.productId,itemsPerCell:10,confirmed:'1'}),/not permitted/);f.stock({id:added.productId},5);f.service.saveProduct(f.admin,{...product({mpi_status:'NFP'}),productId:added.productId,itemsPerCell:10,confirmed:'1'});assert.equal(productStockTotal(f.db,added.productId),5);assert.ok(f.db.prepare("SELECT 1 FROM business_import_events WHERE event_type='product_saved'").get());
}));
test('voucher data is scoped to the assigned operator while administrators see all vouchers',()=>fixture(f=>{
 const p=f.add();f.stock(p,10);const done=f.apply(f.review(f.upload('issue',[issue()]),{assigneeId:f.admin.id}));assert.equal(done.ready,1);assert.equal(f.service.list(f.op).length,0);assert.throws(()=>f.service.detail(f.op,done.rows[0].voucherId),/not assigned/);assert.equal(f.service.list(f.admin).length,1);
}));

test('an existing narrower count cannot hide newly selected locations',()=>fixture(f=>{
 const p=f.add();const first=f.apply(f.review(f.upload('products',[product({stok_ser:5})]),{rows:[{row:2,cellIds:[f.cells[0].id]}]}));const second=f.apply(f.review(f.upload('products',[product({stok_ser:5})]),{rows:[{row:2,cellIds:[f.cells[0].id,f.cells[1].id]}]}));assert.notEqual(first.rows[0].stocktakeId,second.rows[0].stocktakeId);assert.deepEqual(f.db.prepare('SELECT cell_id FROM stocktake_items WHERE run_id=?').all(second.rows[0].stocktakeId).map(i=>i.cell_id),[f.cells[0].id,f.cells[1].id]);assert.equal(productStockTotal(f.db,p.id),0);
}));
test('editing an eligible receipt condition retains CURRENT stock identity and updates the task instruction',()=>fixture(f=>{
 f.add();const saved=f.apply(f.review(f.upload('received',[receipt()]))),id=saved.rows[0].taskId;const changed=f.apply(f.review(f.upload('received',[receipt({condition:'OTHER'})]),{rows:[{row:2,updateConfirmed:true}]}));assert.equal(changed.ready,1,JSON.stringify(changed));assert.equal(changed.rows[0].taskId,id);assert.equal(f.work.task(f.admin,id).voucher.condition,'OTHER');assert.match(f.work.task(f.admin,id).instruction_note,/Condition: OTHER/);assert.equal(f.work.task(f.admin,id).voucher.mpi_status,'CURRENT');
}));

test('catalog and settings expose the business fields without merging MPI rows or changing columns on search',()=>fixture(f=>{
 const p=f.add(),b=f.add({mpi_status:'OBT'});const pages=createProductPages({db:f.db});const html=pages.renderProducts(f.admin,null,'',false,new URL('http://local/products'));for(const label of ['Section (cos_sec)','Part Number (part_no)','Nomenclature (nomen1)','Current Stock (stok_ser)','AU (au)','MPI Status (mpi_status)','CICP ID (cicp_id)','Review Date (review_dt)'])assert.ok(html.includes(label),label);assert.ok(html.includes('/products/'+p.id));assert.ok(html.includes('/products/'+b.id));const detail=pages.renderProductDetail(f.admin,null,getProductDetail(f.db,p.id));assert.match(detail,/name="mpi_status"/);assert.match(detail,/name="cos_sec"/);assert.doesNotMatch(detail,/name="brand"|name="category"/);assert.match(detail,/api\/business-import\/saveProduct/);
}));

test('products-only import preserves stock and existing counts, needs no counter and still validates product edits',()=>fixture(f=>{
 const p=f.add();f.stock(p,5);const count=f.apply(f.review(f.upload('products',[product({stok_ser:9})]))).rows[0].stocktakeId;
 const before=f.db.prepare('SELECT * FROM inventory_balances').all(),runs=f.db.prepare('SELECT * FROM stocktake_runs').all();
 const result=f.apply(f.review(f.upload('products',[product({stok_ser:12,nomen1:'Name only'}),product({part_no:'NEW',stok_ser:70})]),{skipStocktake:true,counterIds:[]}));
 assert.equal(result.ready,2,JSON.stringify(result));assert.ok(result.rows.every(r=>r.stocktakeSkipped&&r.stocktakeId===null));assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM stocktake_runs').all(),runs);assert.ok(count);assert.equal(productStockTotal(f.db,result.rows[1].productId),0);
 const reclass=f.apply(f.review(f.upload('products',[product({mpi_status:'OBT',stok_ser:5})]),{skipStocktake:true,counterIds:[]}));assert.equal(reclass.ready,1);
}));

test('existing merge combines balances and task references, preserves MPI and remembers all voucher identities',()=>fixture(f=>{
 const a=f.add(),b=f.add({part_no:'SECOND',nomen1:'Other name'}),obt=f.add({part_no:'SECOND',mpi_status:'OBT'});f.stock(a,10);f.stock(b,15);f.stock(obt,4,f.cells[1]);
 const first=f.apply(f.review(f.upload('issue',[issue({part_no:'SECOND',gs_no:'BEFORE'})]))).rows[0].taskId;
 const preview=f.service.mergeReview(f.admin,{mainProductId:a.id,productIds:[b.id],name:'Combined item'});assert.equal(productStockTotal(f.db,a.id),10);assert.equal(preview.merges[0].variants.find(v=>v.mpi==='CURRENT').quantity,25);
 const merged=f.apply(preview);assert.equal(merged.merges[0].mainProductId,a.id);assert.equal(productStockTotal(f.db,a.id),25);assert.equal(f.db.prepare('SELECT active FROM products WHERE id=?').get(b.id).active,0);assert.equal(f.work.task(f.admin,first).lines[0].product_id,a.id);assert.equal(f.db.prepare('SELECT reserved_quantity FROM inventory_balances WHERE product_id=? AND cell_id=?').get(a.id,f.cells[0].id).reserved_quantity,2);
 const again=f.apply(f.review(f.upload('issue',[issue({part_no:'SECOND',gs_no:'BEFORE'})])));assert.equal(again.existing,1);
 const put=f.apply(f.review(f.upload('received',[receipt({part_no:'SECOND'})])));assert.equal(put.rows[0].productId,a.id,JSON.stringify(put));assert.equal(f.work.task(f.admin,put.rows[0].taskId).voucher.mpi_status,'CURRENT');
 const obsolete=f.apply(f.review(f.upload('issue',[issue({part_no:'SECOND',gs_no:'OBSOLETE'})]),{rows:[{row:2,mpiStatus:'OBT'}]}));assert.equal(obsolete.ready,1);assert.notEqual(obsolete.rows[0].productId,a.id);
 assert.equal(f.db.prepare('SELECT name FROM products WHERE id=?').get(a.id).name,'Combined item');assert.equal(f.apply(preview).replayed,true);
}));

test('remembered identities sum stock once and keep the selected name on later imports',()=>fixture(f=>{
 const a=f.add(),b=f.add({part_no:'SECOND'});f.stock(a,10);f.stock(b,15);
 f.apply(f.service.mergeReview(f.admin,{mainProductId:a.id,productIds:[b.id],name:'Chosen name'}));
 const document=[product({stok_ser:10,nomen1:'Old A'}),product({part_no:'SECOND',stok_ser:15,nomen1:'Old B'})];
 let result=f.apply(f.review(f.upload('products',document)));assert.equal(result.ready,2,JSON.stringify(result));assert.ok(result.rows.every(r=>r.expected===25&&r.stocktakeId===null));assert.equal(f.db.prepare('SELECT name FROM products WHERE id=?').get(a.id).name,'Chosen name');
 assert.ok(f.upload('products',document).rows.every(r=>r.rememberedProduct.name==='Chosen name'));assert.ok(result.rows.every(r=>r.productName==='Chosen name'));
 document[1].stok_ser=20;result=f.apply(f.review(f.upload('products',document)));assert.equal(result.ready,2,JSON.stringify(result));assert.equal(result.rows[0].stocktakeId,result.rows[1].stocktakeId);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,1);assert.equal(productStockTotal(f.db,a.id),25);
}));

test('merge new Excel identities is previewed, confirmed and reused for subsequent received imports',()=>fixture(f=>{
 const d=f.upload('products',[product({stok_ser:10}),product({part_no:'ALIAS',stok_ser:15})]);const choices={rows:[{row:2,createConfirmed:true,itemsPerCell:30},{row:3,createConfirmed:true,itemsPerCell:30}],merges:[{rows:[2,3],mainRow:2,name:'One item'}]};
 let preview=f.review(d,choices);assert.equal(preview.ready,2,JSON.stringify(preview));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM product_import_aliases').get().n,0);
 const result=f.apply(preview);assert.equal(result.rows[0].expected,25);assert.equal(result.rows[0].productId,result.rows[1].productId);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM products WHERE active=1 AND cos_sec IS NOT NULL').get().n,1);
 const received=f.apply(f.review(f.upload('received',[receipt({part_no:'ALIAS'})])));assert.equal(received.ready,1,JSON.stringify(received));assert.equal(received.rows[0].productId,result.rows[0].productId);
}));

test('merge refuses incompatible units, unauthorized users, active work and stale previews without partial changes',()=>fixture(f=>{
 const a=f.add(),b=f.add({part_no:'B',au:'BOX'});f.stock(a,10);f.stock(b,4);
 const plan={mainProductId:a.id,productIds:[b.id],name:'Merged'};
 assert.throws(()=>f.service.mergeReview(f.admin,plan),/different units/);assert.equal(productStockTotal(f.db,a.id),10);assert.throws(()=>f.service.mergeReview(f.op,plan),/not permitted/);
 f.db.prepare("UPDATE products SET unit_of_measure='NOS' WHERE id=?").run(b.id);
 const preview=f.service.mergeReview(f.admin,plan);f.stock(b,5);assert.throws(()=>f.apply(preview),/changed after/);
 const created=f.wcmd(f.op,'create',{direction:'pick',productId:b.id,quantity:1});assert.throws(()=>f.service.mergeReview(f.admin,plan),/Pause the active/);assert.ok(created.taskId);assert.equal(productStockTotal(f.db,b.id),5);
}));

test('a later merge flattens import aliases and retains source provenance and historical units',()=>fixture(f=>{
 const a=f.add(),b=f.add({part_no:'B'}),c=f.add({part_no:'C'});f.stock(a,1);f.stock(b,2);f.stock(c,3);
 const tx=Number(f.db.prepare("INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,reason,created_at,unit_of_measure) VALUES('put',?,?,2,?,'Earlier movement','2026-11-01T00:00:00.000Z','NOS')").run(b.id,f.cells[0].id,f.admin.id).lastInsertRowid);
 f.apply(f.service.mergeReview(f.admin,{mainProductId:a.id,productIds:[b.id],name:'AB'}));f.apply(f.service.mergeReview(f.admin,{mainProductId:c.id,productIds:[a.id],name:'ABC'}));
 assert.deepEqual(listProducts(f.db,'01 / B').map(p=>p.id),[c.id]);assert.equal(listProducts(f.db,'unknown-alias').length,0);
 assert.equal(productStockTotal(f.db,c.id),6);const movement=f.db.prepare('SELECT * FROM transactions WHERE id=?').get(tx);assert.equal(movement.product_id,c.id);assert.equal(movement.merged_from_product_id,b.id);assert.equal(movement.quantity_delta,2);
 const upload=f.upload('products',[product({stok_ser:1}),product({part_no:'B',stok_ser:2}),product({part_no:'C',stok_ser:3})]),result=f.apply(f.review(upload));assert.ok(result.rows.every(r=>r.productId===c.id&&r.expected===6&&!r.stocktakeId));
 assert.throws(()=>f.service.saveProduct(f.admin,{...product({part_no:'RENAMED'}),productId:c.id,confirmed:true}),/remembered import identities/);
 assert.throws(()=>f.service.saveProduct(f.admin,{...product({part_no:'B',mpi_status:'NFP'}),confirmed:true}),/This identity belongs to ABC/);
}));

test('pending product counts follow merged identity and an active bin count blocks the merge',()=>fixture(f=>{
 const a=f.add(),b=f.add({part_no:'B'});f.stock(a,1);f.stock(b,2);
 const pending=f.apply(f.review(f.upload('products',[product({part_no:'B',stok_ser:3})]))).rows[0].stocktakeId;
 f.cmd('start',{runId:pending});const item=f.count.snapshot(f.op).runs.find(r=>r.id===pending).items[0];f.cmd('begin',{itemId:item.id,generation:item.generation,method:'manual',location:f.cells[0].logical_code});
 assert.throws(()=>f.service.mergeReview(f.admin,{mainProductId:a.id,productIds:[b.id],name:'Combined'}),/active bin count/);
 // Mimic the existing pause command's release; historical observations are not deleted.
 f.db.prepare("UPDATE stocktake_items SET state='pending' WHERE run_id=?").run(pending);
 f.apply(f.service.mergeReview(f.admin,{mainProductId:a.id,productIds:[b.id],name:'Combined'}));assert.deepEqual(JSON.parse(f.db.prepare('SELECT scope_json FROM stocktake_runs WHERE id=?').get(pending).scope_json).productsByCell[f.cells[0].id],[a.id]);assert.equal(f.db.prepare('SELECT state FROM stocktake_items WHERE id=?').get(item.id).state,'pending');
}));

test('new merged Excel products keep several MPI rows separate in the same import',()=>fixture(f=>{
 const d=f.upload('products',[product({stok_ser:10}),product({part_no:'ALIAS',mpi_status:'OBT',stok_ser:15})]);
 const result=f.apply(f.review(d,{skipStocktake:true,rows:[{row:2,createConfirmed:true},{row:3,createConfirmed:true}],merges:[{rows:[2,3],mainRow:2,name:'Two statuses'}]}));
 assert.equal(result.ready,2,JSON.stringify(result));assert.notEqual(result.rows[0].productId,result.rows[1].productId);assert.deepEqual(f.db.prepare('SELECT mpi_status FROM products WHERE active=1 AND cos_sec IS NOT NULL ORDER BY mpi_status').all().map(p=>p.mpi_status),['CURRENT','OBT']);
}));

test('corrections retain unit conversion history before and after a product merge',()=>fixture(f=>{
 const a=f.add(),b=f.add({part_no:'B',au:'nos'});const addConversion=(id,from,to,factor,at)=>f.db.prepare('INSERT INTO product_unit_conversions(product_id,from_unit,to_unit,factor,preview_token,before_json,after_json,created_by,created_at) VALUES(?,?,?,?,?,\'{}\',\'{}\',?,?)').run(id,from,to,factor,randomUUID(),f.admin.id,at);
 addConversion(b.id,'PACK','nos',2,'2026-01-01T00:00:00.000Z');
 f.apply(f.service.mergeReview(f.admin,{mainProductId:a.id,productIds:[b.id],name:'Combined'}));
 assert.equal(historicalFactor(f.db,a.id,'PACK','2025-12-01T00:00:00.000Z',b.id),2);
 addConversion(a.id,'NOS','BOX',0.5,'2099-01-01T00:00:00.000Z');f.db.prepare("UPDATE products SET unit_of_measure='BOX' WHERE id=?").run(a.id);
 assert.equal(historicalFactor(f.db,a.id,'PACK','2025-12-01T00:00:00.000Z',b.id),1);
}));

test('selected mismatches create one import run with exact products per bin and selected rows only',()=>fixture(f=>{
 const p=f.add(),q=f.add({part_no:'SECOND'}),third=f.add({part_no:'SKIP'});f.stock(p,2);f.stock(q,4,f.cells[1]);
 const d=f.upload('products',[product({stok_ser:5}),product({part_no:'SECOND',stok_ser:8}),product({part_no:'SKIP',nomen1:'Must not change',stok_ser:3})]);
 assert.equal(d.rows[0].variants[0].currentStock,2);
 const preview=f.review(d,{rows:[{row:2},{row:3},{row:4,skip:true}]});assert.equal(preview.ready,2);assert.equal(preview.excluded,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,0);
 const done=f.apply(preview),runId=done.rows[0].stocktakeId;assert.equal(runId,done.rows[1].stocktakeId);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stocktake_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT name FROM products WHERE id=?').get(third.id).name,'Test item');
 const items=f.db.prepare('SELECT * FROM stocktake_items WHERE run_id=? ORDER BY cell_id').all(runId);assert.deepEqual(items.map(i=>JSON.parse(i.required_products_json)),[[p.id],[q.id]]);
 f.cmd('start',{runId});const a=f.cmd('begin',{itemId:items[0].id,generation:items[0].generation,method:'manual',location:f.cells[0].logical_code});
 assert.deepEqual(f.count.snapshot(f.op).runs.find(r=>r.id===runId).attempts[0].baseline.products.map(p=>p.productId),[p.id]);
 assert.throws(()=>f.cmd('observe',{attemptId:a.attemptId,lines:[{productId:q.id,actual:2}]}),/selected product/);
}));

test('combined import counts all required products in a shared bin, excluding unrelated stock',()=>fixture(f=>{
 const p=f.add(),q=f.add({part_no:'SECOND'}),other=f.add({part_no:'OTHER'});f.stock(p,2);f.stock(q,3);f.stock(other,8);
 const done=f.apply(f.review(f.upload('products',[product({stok_ser:5}),product({part_no:'SECOND',stok_ser:6})]))),runId=done.rows[0].stocktakeId;
 f.cmd('start',{runId});const item=f.count.snapshot(f.op).runs.find(r=>r.id===runId).items[0];const a=f.cmd('begin',{itemId:item.id,generation:item.generation,method:'manual',location:f.cells[0].logical_code});
 assert.deepEqual(f.count.snapshot(f.op).runs.find(r=>r.id===runId).attempts[0].baseline.products.map(p=>p.productId),[p.id,q.id]);
 assert.throws(()=>f.cmd('observe',{attemptId:a.attemptId,lines:[{productId:p.id,actual:5}]}),/every recorded/);
 f.cmd('observe',{attemptId:a.attemptId,lines:[{productId:p.id,actual:5},{productId:q.id,actual:6}]});
 assert.equal(f.count.snapshot(f.op).runs.find(r=>r.id===runId).status,'completed');assert.equal(productStockTotal(f.db,other.id),8);
}));


test('large product imports stay selected, create one run, and keep catalog/status responses bounded',()=>fixture(f=>{
 const rows=Array.from({length:1000},(_,i)=>product({part_no:'SCALE-'+i,nomen1:'Scale product '+String(i).padStart(4,'0'),stok_ser:10}));
 const result=f.apply(f.review(f.upload('products',rows)));
 assert.equal(result.ready,1000);assert.equal(new Set(result.rows.map(r=>r.stocktakeId)).size,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inventory_balances').get().n,0);
 const runId=result.rows[0].stocktakeId;
 const full=f.count.snapshot(f.admin),status=f.count.status(f.admin);
 assert.equal(status.badge,full.badge);
 assert.deepEqual(status.runs.map(r=>[r.id,r.pending,r.reviews,r.actionable,r.total,r.completed]),full.runs.map(r=>[r.id,r.pending,r.reviews,r.actionable,r.total,r.completed]));
 assert.ok(JSON.stringify(status).length<2000);assert.equal(status.runs[0].scope_json,undefined);
 const home=f.count.snapshot(f.admin,{runId:null});assert.equal(home.runs[0].items.length,0);assert.equal(home.runs[0].total,full.runs[0].total);
 const selected=f.count.snapshot(f.admin,{runId});assert.equal(selected.runs[0].items.length,full.runs[0].items.length);
 const pages=createProductPages({db:f.db});
 const catalog=pages.renderProducts(f.admin,null,'Scale product',false,new URL('http://local/products?q=Scale+product'));
 assert.ok(catalog.includes('1–50 of 1000 products'));assert.ok(catalog.length<250000);assert.ok(catalog.includes('data-report-src='));
 assert.equal((catalog.match(/data-display-kind="quantity"/g)||[]).length,50);
 const last=pages.renderProducts(f.admin,null,'Scale product',false,new URL('http://local/products?q=Scale+product&page=999&pageSize=20'));
 assert.ok(last.includes('981–1000 of 1000 products'));assert.ok(last.includes('Scale product 0999'));
 const print=pages.renderProducts(f.admin,null,'',false,new URL('http://local/products?report=catalog-items'));
 assert.ok(print.includes('Scale product 0000'));assert.ok(print.includes('Scale product 0999'));
 const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM products WHERE active=1 AND UPPER(TRIM(cos_sec))=? AND UPPER(TRIM(part_no))=? ORDER BY mpi_status,id").all('01','SCALE-1');
 assert.ok(plan.some(r=>r.detail.includes('product_import_lookup')));
 // A second import resolves existing rows; it must never create duplicate products.
 const second=f.apply(f.review(f.upload('products',rows),{skipStocktake:true}));assert.equal(second.ready,1000);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM products WHERE part_no LIKE 'SCALE-%'").get().n,1000);
}));

test('lightweight stocktake status preserves permissions, pending counts and review reminders',()=>fixture(f=>{
 const saved=f.apply(f.review(f.upload('products',[product({stok_ser:2})]),{rows:[{row:2,createConfirmed:true,cellIds:[f.cells[0].id]}]}));
 const other=f.db.prepare("SELECT * FROM users WHERE id!=? AND role='operator'").get(f.op.id);
 const compare=()=>{for(const actor of [f.admin,f.op,other].filter(Boolean)){
  const full=f.count.snapshot(actor),small=f.count.status(actor);
  assert.equal(small.badge,full.badge);assert.deepEqual(small.runs.map(r=>[r.id,r.pending,r.reviews,r.actionable,r.overdue]),full.runs.map(r=>[r.id,r.pending,r.reviews,r.actionable,r.overdue]));
 }};
 compare();const id=saved.rows[0].stocktakeId;f.cmd('start',{runId:id});compare();
 const item=f.count.snapshot(f.op).runs.find(r=>r.id===id).items[0],begin=f.cmd('begin',{itemId:item.id,generation:item.generation,method:'manual',location:f.cells[0].logical_code});
 compare();f.cmd('observe',{attemptId:begin.attemptId,lines:[{productId:saved.rows[0].productId,actual:2,unit:'NOS'}]});compare();
 const observation=f.db.prepare('SELECT id FROM stocktake_observations LIMIT 1').get();
 f.db.prepare("UPDATE stocktake_observations SET status='review' WHERE id=?").run(observation.id);compare();
}));

test('compact stocktake pages retain counted-product scope in the active baseline',()=>fixture(f=>{
 const result=f.apply(f.review(f.upload('products',[product({stok_ser:8})]),{rows:[{row:2,createConfirmed:true,cellIds:[f.cells[0].id]}]}));
 const runId=result.rows[0].stocktakeId,productId=result.rows[0].productId;
 const compact=f.count.snapshot(f.op,{runId}).runs.find(r=>r.id===runId);
 assert.equal(JSON.parse(compact.scope_json).productsByCell,undefined);
 assert.equal(compact.items[0].required_products_json,undefined);
 assert.deepEqual(JSON.parse(f.count.snapshot(f.op).runs.find(r=>r.id===runId).items[0].required_products_json),[productId]);
 f.cmd('start',{runId});const item=compact.items[0];f.cmd('begin',{itemId:item.id,generation:item.generation,method:'manual',location:f.cells[0].logical_code});
 const active=f.count.snapshot(f.op,{runId}).runs.find(r=>r.id===runId);
 assert.deepEqual(active.attempts[0].baseline.productScopes,[productId]);
}));
