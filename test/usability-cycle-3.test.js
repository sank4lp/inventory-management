import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const countSource=readFileSync(new URL('../public/client/stocktaking.js',import.meta.url),'utf8').split("root.addEventListener('submit'")[0];
const setupSource=readFileSync(new URL('../public/client/location-setup.js',import.meta.url),'utf8').split("root.addEventListener('invalid'")[0];
const storage=()=>{const m=new Map();return {get length(){return m.size;},key:i=>[...m.keys()][i],getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)};};
class FormValues extends Map {constructor(f){super(f.elements.filter(e=>e.name&&(!['checkbox','radio'].includes(e.type)||e.checked)).map(e=>[e.name,e.value]));}getAll(n){return this.has(n)?[this.get(n)]:[];}}
function countView(search='?run=1&cell=10'){
 const state={site:'test',dataset:'test-generation',user:{id:1},capabilities:{count:true,manage:true,approve:true},runs:[],cells:[],products:[],counters:[],conditions:[]};
 const root={innerHTML:'',querySelectorAll:()=>[]},localStorage=storage();
 const c=vm.createContext({document:{querySelector:q=>q==='#stocktaking-app'?root:{textContent:JSON.stringify(state)}},location:{pathname:'/stocktaking',search},localStorage,URLSearchParams,URL,FormData:FormValues,crypto:{randomUUID}});
 vm.runInContext(countSource,c);return {c,root,localStorage,run:code=>vm.runInContext(code,c)};
}
const item={id:10,assignee_id:1,active:1,state:'pending',generation:1,description:{name:'A1',directions:'Aisle A shelf 1'},logical_code:'A1',counter_name:'Sam Patel',counter_username:'sam.one'};
const runFixture=()=>({id:1,title:'Shelf check',status:'pending',pending:1,reviews:0,items:[{...item}],attempts:[],observations:[],scopeChanges:[]});
test('selected count has scan-first identification with manual and skip fallbacks, without an extra start or duplicate count action',()=>{
 const v=countView();v.c.r=runFixture();const html=v.run('runView(r)');
 assert.match(html,/data-count-scan="10"/);assert.match(html,/<details><summary>Cannot scan/);assert.match(html,/Confirm exact location name or code/);
 assert.match(html,/Skip this location for now/);assert.match(html,/Return remaining work/);assert.match(html,/Results and differences/);
 assert.doesNotMatch(html,/data-count-action="start"|Count this location/);assert.ok(html.indexOf('data-count-scan')<html.indexOf('data-count-action="begin"'));
 v.c.r.items[0].active=0;assert.doesNotMatch(v.run('runView(r)'),/data-count-scan/);
});
test('count navigation reflects eligible ownership and review permissions instead of offering an administrator unassigned counting work',()=>{
 const v=countView('');v.c.r=runFixture();v.c.r.items[0].assignee_id=2;
 assert.equal(v.run('runAction(r)'),'Assign / review locations');assert.doesNotMatch(v.run('runView(r)'),/data-count-action="start"|Count this location|Return remaining work/);assert.match(v.run('runView(r)'),/Assign remaining locations/);
 v.c.r.reviews=1;assert.equal(v.run('runAction(r)'),'Review differences');v.c.r.reviews=0;v.c.r.items[0].assignee_id=1;
 assert.equal(v.run('runAction(r)'),'Choose a location to count');v.run('snapshot.capabilities.count=false');assert.equal(v.run('runAction(r)'),'Assign / review locations');
 v.c.r.status='completed';assert.equal(v.run('runAction(r)'),'View results');
});
test('zero-queue recovery is secondary, waiting and rejected counts remain distinct, and offline status promotes retry',()=>{
 const v=countView();let html=v.run('recoveryToolbar()');assert.doesNotMatch(html,/0 saved|Send saved counts/);assert.match(html,/<details[^>]*><summary>Saved count help<\/summary><button[^>]*data-retry>Refresh/);
 v.run("saved.queues[partition()]=[{id:'waiting',input:{},action:'observe'}]");assert.match(v.run('recoveryToolbar()'),/1 saved update\(s\) awaiting confirmation/);assert.match(v.run('recoveryToolbar()'),/Send saved counts/);
 v.run("saved.queues[partition()][0].error='Correct draft'");html=v.run('recoveryToolbar()');assert.match(html,/1 update\(s\) need correction/);assert.doesNotMatch(html,/awaiting confirmation|Send saved counts/);
 v.run("saved.queues[partition()]=[];online=false");assert.match(v.run('recoveryToolbar()'),/Retry connection/);
});
test('duplicate counter names are disambiguated in assignment selectors and recorded observation attribution',()=>{
 const v=countView();v.run("snapshot.counters=[{id:1,name:'Sam Patel',username:'sam.one'},{id:2,name:'Sam Patel',username:'sam.two'}]");v.c.r=runFixture();
 const html=v.run('management(r)');assert.match(html,/Sam Patel · sam.one/);assert.match(html,/Sam Patel · sam.two/);
 v.c.o={id:'o',item_id:10,lines:[],status:'matched',unknown:[],counter_name:'Sam Patel',counter_username:'sam.one',received_at:'2026-09-28',method:'manual'};assert.match(v.run('observationCard(r,o)'),/Counted by Sam Patel · sam.one/);
});
function countFormMock(){
 const fields=[{name:'attemptId',type:'hidden',value:'attempt'}];const rows=[];
 const add=(id,actual,conditionQuantity='0',extra=false)=>{const elements=[{name:'unit_'+id,type:'hidden',value:'pairs'},{name:'actual_'+id,value:actual},{name:'conditionQuantity_'+id,value:conditionQuantity},{name:'condition_'+id,value:conditionQuantity==='0'?'':'damaged'}];fields.push(...elements);const row={dataset:{countLine:String(id)},extra,closest:s=>s==='[data-extra-lines]'&&extra?{}:null,remove(){rows.splice(rows.indexOf(row),1);for(const el of elements)fields.splice(fields.indexOf(el),1);}};rows.push(row);return row;};
 const f={dataset:{key:'observe-attempt',countAction:'observe'},elements:fields,querySelectorAll:s=>s.includes('input[type=checkbox]')?[]:s==='[data-count-line]'?rows:rows.filter(r=>r.extra),querySelector:s=>s==='[data-extra-lines]'?{insertAdjacentHTML(_,html){const id=Number(html.match(/data-count-line="(\d+)"/)[1]);add(id,'','0',true);}}:s==='[data-scope-locations]'?null:rows.find(r=>s===`[data-count-line="${r.dataset.countLine}"]`)};
 fields.attemptId=fields[0];return{f,add,rows};
}
test('removing only unsaved extra rows persists removal and preserves baseline zero and affected totals through draft restore',()=>{
 const v=countView(),m=countFormMock();const baseline=m.add(1,'0'),affected=m.add(2,'5','2'),extra=m.add(3,'7','0',true),removed=m.add(4,'9','0',true);v.c.f=m.f;
 v.run('snapshot.products=[{id:3,name:"Extra"},{id:4,name:"Removed"}];saveDraft(f)');
 const button=row=>({closest:s=>s==='[data-count-line]'?row:m.f});v.c.button=button(baseline);assert.equal(v.run('removeExtra(button)'),false);
 v.c.button=button(removed);assert.equal(v.run('removeExtra(button)'),true);const saved=JSON.parse(v.localStorage.getItem('lightguide-stocktaking-v1')).drafts['test:1:observe-attempt'];
 assert.deepEqual(saved._extra,[3]);assert.equal(saved.actual_1,'0');assert.equal(saved.actual_2,'5');assert.equal(saved.conditionQuantity_2,'2');assert.equal(saved.condition_2,'damaged');assert.equal(saved.actual_4,undefined);
 const restored=countFormMock();restored.add(1,'');restored.add(2,'');v.root.querySelectorAll=s=>s==='form[data-count-action]'?[restored.f]:[];v.run('restoreCountDrafts()');
 assert.deepEqual(restored.rows.map(r=>Number(r.dataset.countLine)),[1,2,3]);assert.equal(restored.f.elements.find(e=>e.name==='actual_1').value,'0');assert.equal(restored.f.elements.find(e=>e.name==='conditionQuantity_2').value,'2');
 v.run("saved.queues[partition()]=[{id:'receipt',action:'observe',input:{attemptId:'attempt'},result:{observationId:'immutable'}}]");v.c.button=button(extra);assert.equal(v.run('removeExtra(button)'),false);assert.ok(m.rows.includes(extra));
 v.c.l={productId:1,name:'Baseline',unit:'pairs'};assert.doesNotMatch(v.run('lineInputs(l)'),/data-remove-product/);assert.match(v.run('lineInputs(l,true)'),/data-remove-product/);
});
function setupView({localStorage=storage(),fetch=async()=>({ok:false,json:async()=>({error:'Provide distinct choices.'})})}={}){
 const state={site:'test',dataset:'generation',user:{id:1},fields:[],cells:[],controllers:[],sessions:[],capabilities:['locations.fields','locations.bind','locations.manage','hardware.view']};
 const root={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
 const c=vm.createContext({document:{querySelector:q=>q==='#location-setup-app'?root:{textContent:JSON.stringify(state)}},location:{href:'http://localhost/location-setup?view=fields'},localStorage,URL,FormData:FormValues,AbortSignal,crypto:{randomUUID},fetch,stopCamera(){}});vm.runInContext(setupSource,c);return {c,root,localStorage,run:code=>vm.runInContext(code,c)};
}
function fieldFormMock(){const fields=Object.entries({fieldKey:'aisle',revision:'3',label:'Aisle',fieldType:'select',options:'North\nNorth',displayOrder:'7'}).map(([name,value])=>({name,value,type:['fieldKey','revision'].includes(name)?'hidden':'text'}));for(const name of ['required','enabled','useInDirections'])fields.push({name,type:'checkbox',checked:name!=='enabled',value:'on'});for(const el of fields)fields[el.name]=el;const choices={},example={};return {dataset:{action:'field'},elements:fields,querySelector:s=>s==='[data-field-choices]'?choices:s==='[data-field-example]'?example:null,choices,example};}
test('field choices are conditional and server validation errors retain raw unsaved fields, flags, identity and revision across reload',async()=>{
 const v=setupView(),f=fieldFormMock();v.c.f=f;v.root.querySelectorAll=s=>s==='form[data-action="field"]'?[f]:[];
 v.run('fieldControls(f);saveFieldDraft(f)');assert.equal(f.choices.hidden,false);f.elements.fieldType.value='number';v.run('fieldControls(f)');assert.equal(f.choices.hidden,true);assert.match(f.example.textContent,/shelf 3/);f.elements.fieldType.value='select';
 await v.run("send('field',values(f))");assert.match(v.run('message'),/distinct choices/);assert.equal(v.run('saved.pending'),undefined);
 const next=setupView({localStorage:v.localStorage}),fresh=fieldFormMock();fresh.elements.label.value='Server label';fresh.elements.revision.value='4';fresh.elements.options.value='';fresh.elements.required.checked=false;next.c.f=fresh;next.root.querySelectorAll=s=>s==='form[data-action="field"]'?[fresh]:[];next.run('restoreFieldDrafts()');
 assert.equal(fresh.elements.label.value,'Aisle');assert.equal(fresh.elements.revision.value,'3');assert.equal(fresh.elements.fieldKey.value,'aisle');assert.equal(fresh.elements.options.value,'North\nNorth');assert.equal(fresh.elements.required.checked,true);assert.equal(fresh.elements.enabled.checked,false);assert.equal(fresh.elements.useInDirections.checked,true);assert.equal(fresh.elements.displayOrder.value,'7');
 next.run("s.dataset='another-dataset'");fresh.elements.label.value='Other database';next.run('restoreFieldDrafts()');assert.equal(fresh.elements.label.value,'Other database');
 const html=v.run('fieldForm()');assert.match(html,/>Text<\/option>/);assert.match(html,/>Number<\/option>/);assert.match(html,/>Choice list<\/option>/);
});
test('setup excludes zero declared output controllers without inferring mappings, with an authorized Hardware path and valid resume control',()=>{
 const v=setupView();v.run("s.controllers=[{id:1,controller_code:'Existing',module_count:0,mapped_cells:27,heartbeat_status:'online'}]");let html=v.run('controllerSetup()');assert.match(html,/Light count not configured/);assert.match(html,/Existing location mappings do not confirm/);assert.match(html,/href="\/devices"/);assert.doesNotMatch(html,/data-action="start"/);
 v.run("s.capabilities=['locations.bind']");assert.doesNotMatch(v.run('controllerSetup()'),/href="\/devices"/);assert.match(v.run('controllerSetup()'),/Ask someone with Hardware access/);
 v.run("s.controllers.push({id:2,controller_code:'Ready',module_count:8})");html=v.run('controllerSetup()');assert.match(html,/<option value="1" disabled>/);assert.match(html,/Ready — 8 outputs/);assert.match(html,/Start \/ resume setup/);
 const button={},f={elements:{controllerId:{value:'1'}},querySelector:()=>button};v.root.querySelector=()=>f;v.run('setupStartControls()');assert.equal(button.disabled,true);f.elements.controllerId.value='2';v.run('setupStartControls()');assert.equal(button.disabled,false);
});

test('Stocktaking keeps its local progress without a duplicate global reminder while other pages retain assignment-aware reminders',async()=>{
 const code=readFileSync(new URL('../public/client/stocktake-status.js',import.meta.url),'utf8').split('update();setInterval')[0];
 const check=async pathname=>{const reminder={hidden:true,children:[],replaceChildren(){this.children=[];},append(v){this.children.push(v);}},badge={};const state={user:{id:1},site:'test',badge:1,capabilities:{count:true,manage:true},runs:[{id:1,actionable:true,reviews:0,items:[{...item,assignee_id:2}]}]};const c=vm.createContext({location:{pathname},document:{body:{dataset:{accountId:'1'}},querySelector:s=>s==='[data-stocktake-reminder]'?reminder:badge,createElement:()=>({})},fetch:async()=>({ok:true,json:async()=>state}),AbortSignal,localStorage:storage()});vm.runInContext(code,c);await vm.runInContext('update()',c);return{reminder,badge};};
 const local=await check('/stocktaking/results');assert.equal(local.reminder.hidden,true);assert.equal(local.reminder.children.length,0);assert.equal(local.badge.textContent,1);
 const work=await check('/work');assert.equal(work.reminder.hidden,false);assert.equal(work.reminder.children[0].textContent,'Stocktaking — assign / review locations');
});

test('explicit stale-field recovery loads the latest revision without silently rebasing or discarding other drafts or unconfirmed requests',async()=>{
 let fresh,reads=0;const v=setupView({fetch:async url=>{assert.match(url,/snapshot$/);reads++;return{ok:true,json:async()=>fresh};}}),f=fieldFormMock();v.c.f=f;
 v.run('saveFieldDraft(f);saved.fieldDrafts[fieldDraftKey("other") ]={label:"Other draft"}');fresh=JSON.parse(v.run('JSON.stringify(s)'));fresh.fields=[{field_key:'aisle',revision:4,label:'Updated by another admin',field_type:'select',options_json:'["North","South"]'}];
 assert.equal(v.run('saved.fieldDrafts[fieldDraftKey("aisle")].revision'),'3');await v.run('discardFieldDraft(f)');assert.equal(reads,1);assert.equal(v.run('saved.fieldDrafts[fieldDraftKey("aisle")]'),undefined);assert.equal(v.run('saved.fieldDrafts[fieldDraftKey("other")].label'),'Other draft');assert.match(v.run('fieldForm(s.fields[0])'),/name="revision" value="4"/);
 v.run('saveFieldDraft(f);saved.pending={action:"field",input:{fieldKey:"aisle",requestId:"receipt",revision:3}}');const pending=v.run('JSON.stringify(saved.pending)');await v.run('discardFieldDraft(f)');assert.equal(reads,1);assert.equal(v.run('JSON.stringify(saved.pending)'),pending);assert.equal(v.run('saved.fieldDrafts[fieldDraftKey("aisle")].revision'),'3');assert.match(v.run('message'),/awaiting confirmation/);
});
