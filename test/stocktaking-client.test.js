import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const source=readFileSync(new URL('../public/client/stocktaking.js',import.meta.url),'utf8').replace('export async function mount() {','').split("root.addEventListener('submit'")[0];
function storage(){const map=new Map();return{get length(){return map.size;},key:n=>[...map.keys()][n],getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)};}
function device(localStorage,fetch,{initial,search=''}={}){const snapshot=initial||{site:'test',dataset:'generation',user:{id:1},capabilities:{},runs:[],cells:[],products:[],counters:[]},root={querySelectorAll:()=>[]};const context=vm.createContext({document:{querySelector:q=>q==='#stocktaking-app'?root:q==='#stocktaking-boot'?{textContent:JSON.stringify(snapshot)}:null},location:{search,pathname:'/stocktaking'},history:{state:{},replaceState(){}},localStorage,crypto:{randomUUID},URLSearchParams,AbortSignal,window:{dispatchEvent(){}},Event:class{},fetch});vm.runInContext(source+'\nasync function ensurePresence(){};render=()=>{};globalThis.api={submit,sync,queue,prepareSelectedCount,openCountEditor};',context);return{context,api:context.api,snapshot};}
test('a stale second tab cannot erase a first tab’s unsent count or confirmed receipt',async()=>{const shared=storage(),offline=async()=>{throw new Error('offline');},a=device(shared,offline),b=device(shared,offline);await a.api.submit('observe',{attemptId:'a',lines:[{actual:2}]},'draft-a');await b.api.submit('observe',{attemptId:'b',lines:[{actual:3}]},'draft-b');assert.equal(a.api.queue().length,2);assert.equal(b.api.queue().length,2);const fresh=device(shared,offline);assert.equal(fresh.api.queue().length,2);assert.equal(JSON.stringify(fresh.api.queue().map(q=>q.input.attemptId).sort()),JSON.stringify(['a','b']));});
test('a submission arriving during a refresh is drained and acknowledged with its original receipt',async()=>{const shared=storage(),requests=[];let unblock;const gate=new Promise(r=>unblock=r);let snapshots=0,d;d=device(shared,async(url,options)=>{if(url.endsWith('/snapshot')){if(++snapshots===1)await gate;return{ok:true,json:async()=>d.snapshot};}const input=JSON.parse(options.body);requests.push(input);return{ok:true,json:async()=>({status:'review',message:'received'})};});const refreshing=d.api.sync();const submission=d.api.submit('observe',{attemptId:'during-refresh',lines:[{actual:4}]},'draft');unblock();await Promise.all([refreshing,submission]);assert.equal(requests.length,1);assert.equal(d.api.queue()[0].input.requestId,requests[0].requestId);assert.equal(d.api.queue()[0].result.status,'review');});

function countEditorFixture(){
 const row=(id,code)=>({id,cell_id:id,logical_code:code,description:{name:code},generation:1,assignee_id:1,state:'pending',guidance:{state:'idle'}});
 return {site:'test',dataset:'generation',user:{id:1},capabilities:{count:true},cells:[],products:[],counters:[],runs:[{id:1,status:'in_progress',items:[row(10,'A'),row(20,'B')],attempts:[]}]};
}
test('selecting a count location opens one fresh editor without posting any stock quantity',async()=>{
 const state=countEditorFixture(),calls=[];
 const d=device(storage(),async(url,options)=>{
  if(url.endsWith('/snapshot'))return {ok:true,json:async()=>state};
  const input=JSON.parse(options.body);calls.push({url,input});const item=state.runs[0].items.find(i=>i.id===input.itemId);
  item.state='counting';item.guidance={state:'sent',ownerId:1};state.runs[0].attempts.push({id:'attempt-10',item_id:item.id,generation:item.generation,baseline:{products:[{productId:1,recorded:7}]}});
  return {ok:true,json:async()=>({attemptId:'attempt-10'})};
 },{initial:state,search:'?run=1&cell=10'});
 vm.runInContext("presenceSession={id:'active-session',active:true};",d.context);
 const first=d.api.prepareSelectedCount(),second=d.api.prepareSelectedCount();await Promise.all([first,second]);await d.api.prepareSelectedCount();
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/stocktaking/begin');assert.equal(calls[0].input.sessionId,'active-session');assert.equal(calls[0].input.method,'manual');assert.equal(calls[0].input.location,'A');assert.equal(state.runs[0].attempts[0].baseline.products[0].recorded,7);assert.ok(!calls.some(c=>c.url.endsWith('/observe')));
});
test('scan selection releases only the counter previous cell before opening the scanned cell',async()=>{
 const state=countEditorFixture(),calls=[];state.runs[0].items[0].state='counting';state.runs[0].items[0].guidance={state:'sent',ownerId:1};
 const d=device(storage(),async(url,options)=>{
  if(url.endsWith('/snapshot'))return {ok:true,json:async()=>state};const input=JSON.parse(options.body);calls.push({url,input});
  if(url.endsWith('/pause')){state.runs[0].items[0].state='pending';state.runs[0].items[0].guidance={state:'idle'};state.runs[0].items[0].generation++;}
  return {ok:true,json:async()=>({status:'recorded'})};
 },{initial:state,search:'?run=1&cell=10'});
 vm.runInContext("presenceSession={id:'active-session',active:true};",d.context);
 await d.api.openCountEditor(20,{method:'qr',label:'qr-for-B'});
 assert.deepEqual(calls.map(c=>c.url),['/api/stocktaking/pause','/api/stocktaking/begin']);assert.equal(calls[0].input.itemId,10);assert.equal(calls[1].input.itemId,20);assert.equal(calls[1].input.label,'qr-for-B');assert.equal(calls[1].input.method,'qr');
});
test('a paused stocktake or a cell held by active work never opens automatically',async()=>{
 const state=countEditorFixture(),calls=[];const d=device(storage(),async url=>{calls.push(url);return {ok:true,json:async()=>state};},{initial:state,search:'?run=1&cell=10'});
 await d.api.prepareSelectedCount();assert.equal(calls.length,0);
 vm.runInContext("presenceSession={id:'active-session',active:true};snapshot.runs[0].items[0].guidance={state:'waiting',message:'Waiting for Pick #5'};",d.context);
 await d.api.prepareSelectedCount();assert.equal(calls.length,0);
});

test('opening a completed cell starts a fresh recount without changing its earlier quantity',async()=>{
 const state=countEditorFixture(),calls=[];state.runs[0].items[0].state='counted';state.runs[0].items[0].latest_observation='earlier-count';
 const d=device(storage(),async(url,options)=>{
  if(url.endsWith('/snapshot'))return {ok:true,json:async()=>state};const input=JSON.parse(options.body);calls.push({url,input});
  if(url.endsWith('/recountCell')){state.runs[0].items[0].state='recheck';state.runs[0].items[0].generation++;}
  return {ok:true,json:async()=>({status:'recorded'})};
 },{initial:state,search:'?run=1&cell=10'});
 vm.runInContext("presenceSession={id:'active-session',active:true};",d.context);await d.api.openCountEditor(10);
 assert.deepEqual(calls.map(c=>c.url),['/api/stocktaking/recountCell','/api/stocktaking/begin']);assert.equal(calls[1].input.generation,2);assert.equal(state.runs[0].items[0].latest_observation,'earlier-count');assert.ok(!calls.some(c=>c.url.endsWith('/observe')));
});

test('saving a count selects and opens the next unfinished cell inside the same active session',async()=>{
 const state=countEditorFixture(),calls=[],adopted=[],r=state.runs[0];r.paused_at=null;r.items[0].state='counting';r.items[0].guidance={state:'sent',ownerId:1};r.attempts=[{id:'count-A',item_id:10,generation:1,baseline:{products:[]}}];
 const d=device(storage(),async(url,options)=>{
  if(url.endsWith('/snapshot'))return {ok:true,json:async()=>state};const input=JSON.parse(options.body);calls.push({url,input});
  if(url.endsWith('/observe')){const item=r.items.find(i=>i.id===(input.attemptId==='count-A'?10:20));item.state='counted';item.guidance={state:'idle'};item.latest_observation='observed-'+item.id;r.attempts=r.attempts.filter(a=>a.item_id!==item.id);if(r.items.every(i=>i.state==='counted'))r.status='completed';return {ok:true,json:async()=>({status:'matched',observationId:item.latest_observation})};}
  if(url.endsWith('/begin')){r.items[1].state='counting';r.items[1].guidance={state:'sent',ownerId:1};r.attempts.push({id:'count-B',item_id:20,generation:1,baseline:{products:[]}});}
  return {ok:true,json:async()=>({status:'recorded'})};
 },{initial:state,search:'?run=1&cell=10'});
 d.context.WarehouseNavigation={go(){throw new Error('Cell saves must not navigate away');},adopt:href=>adopted.push(href)};
 vm.runInContext("presenceSession={id:'same-count-session',active:true};",d.context);
 await d.api.submit('observe',{attemptId:'count-A',lines:[],emptyConfirmed:true},'draft-A');
 assert.equal(vm.runInContext('selectedItem()',d.context),20);assert.deepEqual(adopted,['/stocktaking?run=1&cell=20']);assert.equal(vm.runInContext('presenceSession.id',d.context),'same-count-session');assert.equal(vm.runInContext('presenceSession.active',d.context),true);assert.equal(r.status,'in_progress');assert.equal(r.paused_at,null);
 await d.api.prepareSelectedCount();assert.equal(calls.find(c=>c.url.endsWith('/begin')).input.itemId,20);assert.equal(calls.find(c=>c.url.endsWith('/begin')).input.sessionId,'same-count-session');assert.ok(!calls.some(c=>/\/(join|leave)$/.test(c.url)));
 await d.api.submit('observe',{attemptId:'count-B',lines:[],emptyConfirmed:true},'draft-B');await d.api.prepareSelectedCount();assert.equal(r.status,'completed');assert.equal(adopted.length,1);assert.equal(calls.filter(c=>c.url.endsWith('/begin')).length,1);
});
test('next cell selection includes skipped and recheck cells and ignores already counted cells',()=>{
 const state=countEditorFixture();state.runs[0].items[0].state='counted';state.runs[0].items[1].state='skipped';const d=device(storage(),async()=>{}, {initial:state,search:'?run=1&cell=10'});
 assert.equal(vm.runInContext('nextUnfinishedCount(snapshot.runs[0],10).id',d.context),20);
 vm.runInContext("snapshot.runs[0].items[1].state='recheck'",d.context);assert.equal(vm.runInContext('nextUnfinishedCount(snapshot.runs[0],10).id',d.context),20);
});
