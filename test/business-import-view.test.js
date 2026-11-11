import test from 'node:test';
import assert from 'node:assert/strict';
import {importRowPresentation,resultTable} from '../public/client/business-import.js';
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
