import test from 'node:test';
import assert from 'node:assert/strict';
import {NotificationStore} from '../public/client/notification-store.js';
import {page} from '../src/render.js';
import {readFileSync} from 'node:fs';
const memory=()=>{const map=new Map();return {getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value)};};
const options=(storage,scope=['warehouse-a','dataset-a',1])=>{let n=0;return {storage,scope,now:()=>1000+(++n),id:()=>`message-${n}`};};
test('notifications persist across screens and remain private to account, site and dataset',()=>{
 const storage=memory(),a=new NotificationStore(options(storage));
 a.add('Task saved');a.add('Light refreshed');assert.equal(a.unread,2);
 const next=new NotificationStore(options(storage));assert.equal(next.rows.length,2);assert.equal(next.rows[0].message,'Light refreshed');
 next.read();assert.equal(new NotificationStore(options(storage)).unread,0);
 for(const scope of [['warehouse-b','dataset-a',1],['warehouse-a','dataset-b',1],['warehouse-a','dataset-a',2]])assert.equal(new NotificationStore(options(storage,scope)).rows.length,0);
});
test('repeated polling is deduplicated, a changed or recurring warning is retained',()=>{
 const store=new NotificationStore(options(memory()));
 store.add('Hardware offline',{key:'health'});assert.equal(store.add('Hardware offline',{key:'health'}),null);
 store.add('Two controllers offline',{key:'health'});assert.equal(store.rows.length,2);
 store.clearKey('health');store.add('Two controllers offline',{key:'health'});assert.equal(store.rows.length,3);
});
test('all messages in a burst remain in the history; invalid links and storage failures are safe',()=>{
 const store=new NotificationStore(options({getItem:()=>{throw Error();},setItem:()=>{throw Error();}}));
 for(let n=0;n<30;n++)store.add(`Message ${n}`);
 assert.equal(store.rows.length,30);assert.equal(store.unread,30);
 for(const href of ['javascript:alert(1)','//other.example','/\\other.example','/\n/other.example'])assert.equal(store.add('Link',{href}).href,'');
 assert.equal(store.add('Stocktaking',{href:'/stocktaking?run=2'}).href,'/stocktaking?run=2');
});
test('global bell is in the shared page title header; flashes feed the center, not a page banner',()=>{
 for(const title of ['Work','Products','Locations','Reports','Settings','Profile','Stocktaking']){
  const html=page({title,user:{id:1,name:'Admin',role:'admin'},flash:{tone:'success',message:'Saved <safely>'},content:'<p>Page content</p>'});
  assert.match(html,/<header class="page-header">[\s\S]*?<h1>[\s\S]*?data-notifications-button[\s\S]*?<\/header>/);
  assert.match(html,/data-notification-scope=/);assert.match(html,/src="\/client\/notifications.js"/);
  assert.match(html,/data-notification-source data-notification-tone="success">Saved &lt;safely&gt;/);
  assert.doesNotMatch(html,/toast-stack/);
 }
 const sw=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
 assert.match(sw,/notification-store.js/);assert.match(sw,/client\/notifications.js/);
});

test('dismissal and Clear all survive reload and other tabs without resurrecting reminders; a new run can notify',()=>{
 const storage=memory(),a=new NotificationStore(options(storage));a.add('Stocktaking pending',{key:'stocktaking-run:10'});
 const b=new NotificationStore(options(storage));a.dismiss(a.rows[0].id);b.sync();assert.equal(b.rows.length,0);assert.equal(b.add('Stocktaking overdue',{key:'stocktaking-run:10'}),null);
 b.add('New count due',{key:'stocktaking-run:11'});b.add('Saved work');b.clear();a.sync();assert.equal(a.rows.length,0);assert.equal(a.add('New count due',{key:'stocktaking-run:11'}),null);
 a.add('Next month count',{key:'stocktaking-run:12'});assert.equal(a.rows.length,1);assert.equal(new NotificationStore(options(storage)).rows.length,1);
});
test('one stocktaking run updates in place and migration removes duplicate reminders from older page loads',()=>{
 const storage=memory(),store=new NotificationStore(options(storage));store.add('Stocktaking pending',{key:'stocktaking-run:3'});assert.equal(store.add('Stocktaking in progress',{key:'stocktaking-run:3'}),null);assert.equal(store.rows.length,1);assert.equal(store.rows[0].message,'Stocktaking in progress');
 storage.setItem(store.key,JSON.stringify([1,2,3].map(n=>({id:'old-'+n,key:'stocktaking-reminder',message:'Stocktaking pending',href:'/stocktaking?run=3',at:n}))));
 const migrated=new NotificationStore(options(storage));assert.equal(migrated.rows.length,1);assert.equal(migrated.add('Stocktaking pending',{key:'stocktaking-run:3'}),null);
});
