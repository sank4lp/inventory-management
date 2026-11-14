import test from 'node:test';
import assert from 'node:assert/strict';
import {taskColumnLayout,mobileColumnLabel} from '../public/client/mobile-layout.js';
const columns=keys=>keys.map(key=>({dataset:{column:key},querySelector:()=>null}));
test('phone task tables keep every column while exposing Task, Product, quantity and actions first',()=>{
 for(const available of [270,338,380,650]) {
  const original=['task','product','type','unit','requested','completed','remaining','priority','status','progress','state','action'];
  const result=taskColumnLayout(columns(original),available);
  assert.deepEqual(result.order.slice(0,4),['task','product','requested','action']);
  assert.deepEqual([...result.order].sort(),[...original].sort());
  assert.ok(result.widths.slice(0,4).reduce((sum,width)=>sum+width,0)<=available);
  assert.deepEqual(result.keys,original);
 }
});
test('selection and editable history assignments retain their columns and stable tracks',()=>{
 const input=columns(['task','product','type','assignedTo','unit','requested','completed','remaining','priority','status','progress','state','before','after','action']);
 input.unshift({dataset:{},querySelector:()=>({type:'checkbox'})});
 const result=taskColumnLayout(input,270);
 assert.deepEqual(result.order.slice(0,5),['selection','task','product','requested','action']);
 assert.equal(result.widths.slice(0,5).reduce((sum,width)=>sum+width,0),270);
 assert.ok(result.order.includes('assignedTo'));assert.ok(result.order.includes('before'));assert.ok(result.order.includes('after'));
});
test('phone field labels use the existing header rather than adding new information',()=>{
 assert.equal(mobileColumnLabel({textContent:' Product ↕ ',querySelector:()=>null}),'Product');
 assert.equal(mobileColumnLabel({textContent:'Assigned To Resize column',querySelector:()=>({textContent:'Assigned To ↓'})}),'Assigned To');
});
test('movement timelines keep task identity fixed and the product/change visible without losing timestamps or actors',()=>{
 const names=['Timestamp (IST)','Task ID','Product','Cell','Change','Assigned By','Assigned To','Changed By','Details before','Details after'];
 const result=taskColumnLayout(names.map(textContent=>({textContent,dataset:{},querySelector:()=>null})),270);
 assert.deepEqual(result.order.slice(0,3),['task','product','change']);
 assert.equal(result.order.length,names.length);
 assert.ok(result.order.includes('timestamp'));assert.ok(result.order.includes('assignedBy'));assert.ok(result.order.includes('changedBy'));
 assert.equal(result.keys.indexOf('task'),1);
});
