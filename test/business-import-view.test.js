import test from 'node:test';
import assert from 'node:assert/strict';
import {importRowPresentation,resultTable,currentStock} from '../public/client/business-import.js';
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
