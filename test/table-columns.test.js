import test from 'node:test';
import assert from 'node:assert/strict';
import {fitColumnWidths,changedColumnWidths,validColumnPreferences} from '../public/client/table-columns.js';

test('columns fill the available width, giving longer fields more room',()=>{
 const columns=[{minimum:64,weight:1},{minimum:140,weight:2},{minimum:64,weight:1}];
 const widths=fitColumnWidths(columns,1000);
 assert.equal(widths.reduce((a,b)=>a+b,0),1000);
 assert.ok(widths[1]>widths[0]);
 // Narrow views shrink proportionally; extremely narrow views scroll within
 // the table instead of collapsing columns below the resize minimum.
 assert.equal(fitColumnWidths(columns,200).reduce((a,b)=>a+b,0),200);
 assert.deepEqual(fitColumnWidths(columns,100),[48,48,48]);
 assert.deepEqual(fitColumnWidths([{minimum:190,floor:140},{minimum:104,floor:90}],100),[140,90]);
});
test('resizing one column leaves adjacent columns unchanged and bounds its width',()=>{
 const original=[100,200,100];
 assert.deepEqual(changedColumnWidths(original,1,300),[100,500,100]);
 assert.deepEqual(changedColumnWidths(original,1,-500),[100,48,100]);
 assert.deepEqual(changedColumnWidths(original,1,5000),[100,2000,100]);
 assert.deepEqual(original,[100,200,100]);
});
test('stored widths follow column identities and ignore invalid or incomplete preferences',()=>{
 const keys=['task','assignedTo'];
 assert.deepEqual(validColumnPreferences({assignedTo:300,task:80},keys),[80,300]);
 for(const value of [null,{}, {task:80}, {task:0,assignedTo:300},{task:Infinity,assignedTo:300},{task:'80',assignedTo:300}])assert.equal(validColumnPreferences(value,keys),null);
});
