import test from 'node:test';
import assert from 'node:assert/strict';
import {importRowPresentation,resultTable,currentStock,stocktakeAssignmentNotice,voucherProductStatus,importActionLabel} from '../public/client/business-import.js';
const row=(status,message)=>({row:2,status,message,values:{cos_sec:'A',part_no:'123',nomen1:'Test item',mpi_status:'CURRENT'}});
test('stock, issue and received previews distinguish valid, invalid and intentionally excluded rows',()=>{
 for(const kind of ['products','issue','received']){
  const html=resultTable({kind,rows:[row('ready','Create task.'),row('blocked','Part Number (part_no) is required.'),row('existing','Task already created.'),row('excluded','Excluded from this import.'),row('excluded_uns','Unserviceable (UNS) — no Put task.')]});
  assert.match(html,/data-import-status="ready"/);assert.match(html,/Valid — ready to save/);
  assert.match(html,/data-import-status="blocked"/);assert.match(html,/Invalid — not saved/);
  assert.match(html,/Details \/ reason/);assert.match(html,/Part Number \(part_no\) is required/);
  assert.match(html,/Already imported/);assert.match(html,/Excluded — UNS/);assert.match(html,/>Skipped</);
 }
});
test('failure reasons and product labels are escaped and missing validation never appears valid',()=>{
 const r=row('blocked','Bad <script>alert(1)</script>');r.values.nomen1='<img onerror="bad">';
 const html=resultTable({rows:[r]});assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;script&gt;/);
 assert.equal(importRowPresentation({}).status,'blocked');assert.match(importRowPresentation({}).message,/could not be validated/);
 assert.match(importRowPresentation({status:'blocked',errors:['Missing section.','Invalid quantity.']}).message,/Missing section\. Invalid quantity\./);
 assert.match(resultTable({rows:[row('ready','Stock matches.')]},true),/>Saved</);
});

test('large stock and voucher result tables render bounded pages without dropping rows or reasons',()=>{
 const rows=Array.from({length:20000},(_,i)=>({...row(i%2?'blocked':'ready','Reason '+i),row:i+2}));
 for(const kind of ['products','issue','received']){
  const html=resultTable({kind,rows});
  assert.equal((html.match(/data-import-status=/g)||[]).length,50);
  assert.match(html,/Rows 1–50 of 20000/);assert.match(html,/Page 1 of 400/);
  const last=resultTable({kind,rows},true,399);
  assert.equal((last.match(/data-import-status=/g)||[]).length,50);
  assert.match(last,/Reason 19999/);assert.match(last,/Rows 19951–20000/);
  assert.ok(html.length<70000);
 }
});

test('review quantity follows the selected MPI row and distinguishes new products from zero stock',()=>{
 const row={values:{mpi_status:'NFP'},variants:[{id:1,mpi_status:'CURRENT',currentStock:0},{id:2,mpi_status:'OBT',currentStock:12}]};
 assert.equal(currentStock(row),'Choose MPI row');assert.equal(currentStock(row,{sourceProductId:1}),0);
 assert.equal(currentStock(row,{sourceProductId:2}),12);assert.equal(currentStock(row,{sourceProductId:'new'}),'New product (0)');
 assert.equal(currentStock({...row,values:{mpi_status:'OBT'}}),12);
});

test('missing stocktake assignment is distinct from invalid product data',()=>{
 const result={rows:[{...row('blocked','Select someone to perform the stocktake.'),issueCode:'STOCKTAKE_ASSIGNEE_REQUIRED',recorded:0,expected:5}]};
 const html=resultTable(result);
 assert.match(html,/data-import-status="assignment_required"/);
 assert.match(html,/Stocktake assignment required — not saved/);
 assert.doesNotMatch(html,/Invalid — not saved/);
 assert.match(html,/In system: 0 · In Excel: 5/);
 assert.match(stocktakeAssignmentNotice(result),/Stocktaking assigned to/);
 assert.match(stocktakeAssignmentNotice(result),/Products only — skip stocktaking/);
 assert.equal(stocktakeAssignmentNotice({rows:[row('blocked','Invalid quantity')]}),'');
});

test('a product saved without a task is clearly identified in review and results',()=>{
 const pending={...row('ready','Product added. No task created: Not enough recorded stock.'),issueCode:'PRODUCT_ONLY'};
 assert.match(resultTable({rows:[pending]}),/Product only — no task/);
 assert.match(resultTable({rows:[pending]},true),/Product saved — no task/);
});

test('voucher product status reserves a consistent slot and distinguishes missing products from missing MPI variants',()=>{
 const missing=voucherProductStatus({variants:[]},'CURRENT');
 assert.match(missing,/class="business-product-status"/);assert.match(missing,/Product not in catalogue/);assert.doesNotMatch(missing,/data-missing-product hidden/);
 const found=voucherProductStatus({variants:[{mpi_status:'CURRENT'}]},'CURRENT');
 assert.match(found,/class="business-product-status"/);assert.match(found,/data-missing-product hidden/);
 const other=voucherProductStatus({variants:[{mpi_status:'OBT'}],rememberedProduct:{id:1,name:'Combined'}},'CURRENT');
 assert.match(other,/Selected MPI status not in catalogue/);assert.match(other,/Uses <a href="\/products\/1">Combined/);
});

test('confirmation actions describe the valid products and voucher tasks being saved',()=>{
 const preview=rows=>({rows});
 const task={status:'ready',row:2,taskId:1,mpiStatus:'CURRENT',message:'Create task.'};
 const existing=[{row:2,variants:[{mpi_status:'CURRENT'}]}];
 const missing=[{row:2,variants:[]}];
 assert.equal(importActionLabel('products',preview([{status:'ready'}])),'Save valid products');
 assert.equal(importActionLabel('received',preview([task]),existing),'Create valid PUT tasks');
 assert.equal(importActionLabel('issue',preview([task]),existing),'Create valid PICK tasks');
 assert.equal(importActionLabel('received',preview([task]),missing),'Save products and create valid PUT tasks');
 assert.equal(importActionLabel('issue',preview([{...task,issueCode:'PRODUCT_ONLY',taskId:null}])), 'Save valid products');
 assert.equal(importActionLabel('issue',preview([task,{status:'ready',issueCode:'PRODUCT_ONLY'}]),existing),'Save products and create valid PICK tasks');
 assert.equal(importActionLabel('issue',preview([{...task,message:'Update task.'}]),existing),'Create or update valid PICK tasks');
 assert.equal(importActionLabel('issue',preview([{status:'blocked'}])),'Save import results');
});
