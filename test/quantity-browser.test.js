import test from 'node:test';
import {routeCapability} from '../src/modules/access/routes-policy.js';
import assert from 'node:assert/strict';
import {quantityRows,visibleQuantity,productLabel} from '../public/client/quantity-browser.js';
test('bin/product browsing keeps same part number with different MPI separate',()=>{
 const current={product_id:1,cos_sec:'A',part_no:'123',name:'Bolt',mpi_status:'CURRENT',on_hand:42},obsolete={...current,product_id:2,mpi_status:'OBT',on_hand:8};
 const rows=[{cell:{id:1},products:[current,obsolete]},{cell:{id:2},products:[current]}];
 assert.equal(quantityRows(rows,{mode:'bin',cellId:1}).length,2);
 assert.deepEqual(quantityRows(rows,{mode:'product',productId:2}).map(p=>p.on_hand),[8]);
 assert.equal(quantityRows(rows,{mode:'product',productId:''}).length,0);
 assert.match(productLabel(obsolete),/A · 123 · Bolt · OBT/);
});
test('Showing label follows server receipts only, including failed and nonnumeric deliveries',()=>{
 const target={status:'sent',numeric:true,productId:1,value:18,color:'white',sequenceIndex:1,sequence:[{productId:1},{productId:2}]};
 assert.deepEqual(visibleQuantity(target),{productId:2,value:18,color:'white'});
 assert.equal(visibleQuantity({...target,status:'unreachable'}),null);
 assert.equal(visibleQuantity({...target,sequenceDeliveryFailed:true}),null);
 assert.equal(visibleQuantity({...target,numeric:false,value:'LOC'}),null);
 assert.equal(visibleQuantity(null),null);
});

test('quantity browsing is registered with the quantity permission',()=>{assert.equal(routeCapability('GET','/api/displays/quantities'),'locations.quantity');});
