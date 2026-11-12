import test from 'node:test';
import assert from 'node:assert/strict';
import {paginateRows} from '../src/server/pagination.js';
import {historicalFactor} from '../src/modules/operations/corrections.js';

test('large pages stay bounded, retain filters and expose the last row',()=>{
 const rows=Array.from({length:10000},(_,id)=>({id}));
 const first=paginateRows(rows,new URL('http://local/reports/sections?section=S1&q=bolt'));
 assert.equal(first.rows.length,50);assert.equal(first.total,10000);assert.equal(first.pages,200);
 assert.match(first.controls,/section=S1&amp;q=bolt&amp;page=2/);
 const last=paginateRows(rows,new URL('http://local/cells?page=999999&pageSize=100'));
 assert.equal(last.page,100);assert.equal(last.rows.at(-1).id,9999);
 assert.equal(paginateRows(rows,new URL('http://local/cells?page=-3&pageSize=10000')).rows.length,50);
 assert.equal(paginateRows([],new URL('http://local/cells')).page,1);
 assert.equal(paginateRows(rows,new URL('http://local/reports/sections'),{complete:true}).rows.length,10000);
});

test('batched movement conversions preserve merge chains and reject missing history',()=>{
 const db={prepare(){throw Error('Unexpected per-movement database lookup');}};
 const context={products:new Map([[1,{id:1,unit_of_measure:'pieces',merged_into:2,merged_at:'2026-02-01'}],[2,{id:2,unit_of_measure:'cases'}]]),conversions:new Map([[1,[{created_at:'2026-01-10',from_unit:'boxes',to_unit:'pieces',factor:10}]],[2,[{created_at:'2026-03-01',from_unit:'pieces',to_unit:'cases',factor:0.5}]]])};
 assert.equal(historicalFactor(db,2,'boxes','2026-01-01',1,context),5);
 assert.throws(()=>historicalFactor(db,2,'unknown','2026-01-01',1,context),/history is incomplete/);
 assert.throws(()=>historicalFactor(db,99,'pieces','2026-01-01',null,context),/no longer exists/);
});

import {filterReportRows} from '../src/modules/reports/pages.js';
test('report search filters the complete export independently of page size',()=>{
 const rows=Array.from({length:120},(_,id)=>({name:`Product ${id}`,part_no:id===119?'LAST':'OTHER'}));
 assert.equal(filterReportRows(rows,new URL('http://local/reports/sections?page=2')).length,120);
 assert.deepEqual(filterReportRows(rows,new URL('http://local/reports/sections?q=last&page=2')), [rows[119]]);
 assert.equal(filterReportRows(rows,new URL('http://local/reports/sections?q=missing')).length,0);
});

import {locationTree} from '../public/client/location-tree.js';
test('location paging preserves total counts and full shed display scope',()=>{
 const layout={warehouses:[{id:1,name:'Shed'}],shelves:[{id:2,name:'Rack',warehouse_id:1}],cells:[{id:3,shelf_id:2},{id:4,shelf_id:2}]};
 const html=locationTree(layout,{3:'VISIBLE',4:'OFFPAGE'},{visibleCellIds:new Set([3]),displayCapabilities:['locations.quantity']});
 assert.match(html,/2 bins/);assert.match(html,/VISIBLE/);assert.doesNotMatch(html,/OFFPAGE/);assert.match(html,/data-warehouse-id="1"/);
 assert.equal(layout.cells.length,2);
});

import {navigationResponseUrl} from '../public/client/navigation.js';
test('partial page navigation preserves report anchors without attaching them to redirects',()=>{
 const target=new URL('http://local/reports?page=2#replenishment-watch');
 assert.equal(navigationResponseUrl('http://local/reports?page=2',target),target.href);
 assert.equal(navigationResponseUrl('http://local/login',target),'http://local/login');
});
