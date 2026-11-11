import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {parseBusinessWorkbook,importDate,IMPORT_COLUMNS} from '../src/modules/imports/workbook.js';

function file(kind,rows,{bookType='xlsx',headers=IMPORT_COLUMNS[kind].map(([key])=>key),edit}={}){
 const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([headers,...rows.map(row=>headers.map(key=>row[key]??''))]);
 edit?.(sheet);XLSX.utils.book_append_sheet(book,sheet,'Data');return XLSX.write(book,{type:'buffer',bookType,compression:true});
}
const product={cos_sec:'F1',part_no:'00017',nomen1:'Product',stok_ser:5,au:'NOS',mpi_status:'CURRENT',cicp_id:'0008',review_dt:'_'};
const issue={...product,comp_no:'0008',gs_no:'0001',issu_dt:'10/11/2026',qty_iss:2};
const received={...product,comp_no:'0008',rv_no:'0002',rv_dt:'10/11/2026',condition:'UNS',qty_r:2};

test('product import keeps identifiers, separates physical stock and accepts missing review date',()=>{
 const parsed=parseBusinessWorkbook(file('products',[product]),'products');
 assert.equal(parsed.rows[0].values.part_no,'00017');assert.equal(parsed.rows[0].values.cicp_id,'0008');
 assert.equal(parsed.rows[0].values.stok_ser,5);assert.equal(parsed.rows[0].values.review_dt,null);assert.deepEqual(parsed.rows[0].errors,[]);
});
test('native binary issue and received files are supported without retaining unrelated columns',()=>{
 for(const [kind,row] of [['issue',issue],['received',received]]){
  const parsed=parseBusinessWorkbook(file(kind,[{...row,unrelated:'do not retain'}],{bookType:'biff8',headers:[...IMPORT_COLUMNS[kind].map(([key])=>key),'unrelated']}),kind);
  assert.deepEqual(parsed.rows[0].errors,[]);assert.equal(parsed.rows[0].values.unrelated,undefined);
  assert.equal(parsed.rows[0].values[kind==='issue'?'issu_dt':'rv_dt'],'2026-11-10');
 }
});
test('one voucher with different products produces distinct stable line identities',()=>{
 const parsed=parseBusinessWorkbook(file('received',[received,{...received,part_no:'00018'}]),'received');
 assert.equal(parsed.rows[0].voucherNumber,parsed.rows[1].voucherNumber);
 assert.notEqual(parsed.rows[0].lineKey,parsed.rows[1].lineKey);
 const changed=parseBusinessWorkbook(file('received',[{...received,qty_r:3}]),'received').rows[0];
 assert.equal(changed.lineKey,parsed.rows[0].lineKey);assert.notEqual(changed.fingerprint,parsed.rows[0].fingerprint);
 assert.equal(parsed.rows[0].values.condition,'UNS');assert.equal(parsed.rows[0].values.mpi_status,undefined);
});
test('invalid quantities stay row errors so valid voucher rows can still be reviewed',()=>{
 const parsed=parseBusinessWorkbook(file('issue',[issue,{...issue,gs_no:'0003',qty_iss:-2}]),'issue');
 assert.deepEqual(parsed.rows[0].errors,[]);assert.match(parsed.rows[1].errors.join(' '),/Quantity Issued/);
 assert.equal(parsed.rows[1].values.qty_iss,null);
});
test('repeated voucher product lines and duplicate product-status rows are explicit conflicts',()=>{
 for(const [kind,row] of [['products',product],['issue',issue]]){
  const parsed=parseBusinessWorkbook(file(kind,[row,row]),kind);assert.ok(parsed.rows.every(r=>r.errors.some(e=>e.includes('repeated'))));
 }
 const parsed=parseBusinessWorkbook(file('products',[product,{...product,mpi_status:'OBT'}]),'products');assert.ok(parsed.rows.every(r=>!r.errors.length));
});
test('wide legacy voucher exports are allowed but formulas are not accepted as imported values',()=>{
 const headers=Array.from({length:170},(_,i)=>'unused_'+i).concat(IMPORT_COLUMNS.issue.map(([key])=>key));
 assert.deepEqual(parseBusinessWorkbook(file('issue',[issue],{headers}),'issue').rows[0].errors,[]);
 const formula=file('products',[product],{edit:s=>{s.D2={t:'n',v:5,f:'1+4'};}});
 assert.match(parseBusinessWorkbook(formula,'products').rows[0].errors.join(' '),/Replace the formula/);
});
test('date imports use calendar dates rather than a local timezone conversion',()=>{
 assert.equal(importDate(46336),'2026-11-10');assert.equal(importDate('10/11/2026'),'2026-11-10');
 assert.throws(()=>importDate('31/02/2026'),/valid date/);assert.equal(importDate(' _ '),null);
});
test('missing Sus Number in received format stays empty, and header-only files do not create imports',()=>{
 const headers=IMPORT_COLUMNS.received.map(([key])=>key).filter(key=>key!=='sus_no');
 assert.equal(parseBusinessWorkbook(file('received',[received],{headers}),'received').rows[0].values.sus_no,'');
 assert.throws(()=>parseBusinessWorkbook(file('products',[]),'products'),/headers only/);
});
