import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {importPage,mergeImportChoices} from '../public/client/business-import.js';
import {parseForm} from '../src/server/http/request-body.js';
import * as XLSX from 'xlsx';
import {parseBusinessWorkbook,PRODUCT_COLUMNS} from '../src/modules/imports/workbook.js';

test('paging preserves every row, per-row edits, global choices and planned merges',()=>{
 const rows=Array.from({length:1367},(_,i)=>({row:i+2,createConfirmed:true,mpiStatus:'CURRENT'}));
 let choices={skipStocktake:true,merges:[{rows:[2,52],name:'Merged'}],rows};
 choices=mergeImportChoices(choices,{rows:[{row:2,itemsPerCell:'12',cellIds:[1,9],skip:true}]});
 choices=mergeImportChoices(choices,{rows:[{row:52,createConfirmed:false,mpiStatus:'OBT'}]});
 assert.equal(choices.rows.length,1367);assert.equal(choices.rows[0].itemsPerCell,'12');assert.deepEqual(choices.rows[0].cellIds,[1,9]);
 assert.equal(choices.rows[50].createConfirmed,false);assert.equal(choices.rows.at(-1).createConfirmed,true);
 assert.equal(choices.skipStocktake,true);assert.deepEqual(choices.merges,[{rows:[2,52],name:'Merged'}]);
 assert.equal(importPage(rows,999).rows.length,17);
 assert.equal(importPage(rows,-1).page,0);assert.equal(importPage(rows,0,100).rows.length,100);
 assert.deepEqual(Array.from({length:28},(_,i)=>importPage(rows,i).rows).flat(),rows);
});

test('review accepts choices for the supported 20,000 rows while ordinary requests retain their limit',async()=>{
 const body=JSON.stringify({id:'draft',rows:Array.from({length:20000},(_,i)=>({row:i+2,mpiStatus:'CURRENT',createConfirmed:true,skip:false,itemsPerCell:'',cellIds:[1,2]}))});
 assert.ok(Buffer.byteLength(body)>1024*1024);
 const request=url=>Object.assign(Readable.from([Buffer.from(body)]),{url,headers:{'content-type':'application/json'}});
 assert.equal((await parseForm(request('/api/business-import/review'))).rows.length,20000);
 await assert.rejects(parseForm(request('/unrelated')),/Request too large/);
});

test('20,000 duplicate rows produce bounded diagnostics, not a quadratic error payload',()=>{
 const headers=PRODUCT_COLUMNS.map(([key])=>key),values=['A','TEST','Synthetic test',1,'NOS','CURRENT','ID',null];
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,...Array.from({length:20000},()=>values)]),'Products');
 const parsed=parseBusinessWorkbook(XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true}),'products');
 assert.equal(parsed.rows.length,20000);assert.ok(parsed.rows.every(row=>row.errors.some(message=>message.includes('19990 more rows'))));
 assert.ok(parsed.rows.every(row=>row.errors.join('').length<500));
});
