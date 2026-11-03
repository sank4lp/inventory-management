import test from 'node:test';
import assert from 'node:assert/strict';
import {buttonLabels} from '../public/client/stable-buttons.js';

test('display toggles reserve inactive, active, loading and clearing labels before activation',()=>{
 const labels=buttonLabels('Show items per location',{showLabel:'Show items per location',activeLabel:'Showing items per location',ledLoadingLabel:'Showing'},{quantity:true});
 for(const label of ['Show items per location','Showing items per location','Showing','Clearing','Failed'])assert.ok(labels.includes(label));
 assert.equal(new Set(labels).size,labels.length);
});
test('Ping, Locate and ordinary changing actions include every planned label',()=>{
 assert.ok(buttonLabels('Ping',{}, {ping:true}).includes('Pinging'));
 assert.ok(buttonLabels('Locate',{}, {locate:true}).includes('Locating'));
 assert.ok(buttonLabels('Save Details').includes('Saving…'));
 assert.ok(buttonLabels('Assign Task').includes('Waiting for warehouse confirmation'));
 assert.ok(buttonLabels('Menu').includes('Close menu'));
 assert.ok(buttonLabels('Hide module').includes('Show module'));
 assert.ok(buttonLabels('Discard All (1)').includes('Discard All (100)'));
});
test('explicit future labels support additional controls without changing their text or accessible name',()=>{
 assert.deepEqual(buttonLabels('Retry',{stableLabels:'Retry|Retrying connection'}),['Retry','Retrying connection']);
 assert.deepEqual(buttonLabels('Static action'),['Static action']);
});
