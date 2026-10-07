import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8').replace('export async function mount() {','');
function client(){
 const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
 const context=vm.createContext({document:{querySelector:s=>s==='#work-app'?root:null},crypto:{randomUUID:(()=>{let n=0;return()=>`request-${++n}`;})()},localStorage:{getItem:()=> 'device'},URLSearchParams,location:{pathname:'/work',search:''},AbortSignal,Date,Map});
 vm.runInContext(source.slice(0,source.indexOf("root.addEventListener('invalid'")),context);
 const run=s=>vm.runInContext(s,context);
 run("let submitting=false;snapshot={site:'test',dataset:'data',user:{id:1,role:'admin'},tasks:[],products:[],cells:[],reports:[]};online=true;");
 return {context,root,run};
}
const task=(id,extra={})=>({id,type:'pick',assignment_generation:1,progress_token:'p'+id,closure_token:'c'+id,assignee_id:1,assignee_name:'Alex',requested_quantity:10,recorded_quantity:2,remaining_quantity:8,lines:[{id:id*10,unit_of_measure:'cases',product_id:1,product_name:'Packing cases',cell_id:id,logical_code:'A'+id,execution_state:'settled',actual_quantity:2}],...extra});
function filterClient(){
 const c=client(),elements=Object.fromEntries(['taskSearch','productSearch','statusSearch','progressRange','workState'].map(k=>[k,{value:k==='workState'?'current':''}]));elements.reviewOnly={checked:false};
 const apply={},feedback={},details={open:true},form={elements,querySelector:s=>s==='[data-apply-work-filters]'?apply:s==='details'?details:feedback};
 c.context.f=form;c.context.window={history:{state:null,replaceState(state,title,url){c.context.location.search=url.includes('?')?'?'+url.split('?')[1]:'';}}};
 c.run('refresh=async()=>{};patchMyWorkRows=()=>{};patchSelection=()=>{};');return {...c,elements,apply,feedback};
}
test('Apply compares drafts to active filters; review-only never applies a product draft',async()=>{
 const c=filterClient();assert.equal(c.run('workFiltersChanged(f)'),false);c.elements.productSearch.value='Gloves';c.run('updateFilterApply(f)');assert.equal(c.apply.disabled,false);
 c.elements.reviewOnly.checked=true;await c.run('applyWorkFilters(f,true)');assert.equal(c.context.location.search,'?reviewOnly=1');assert.equal(c.elements.productSearch.value,'Gloves');assert.equal(c.apply.disabled,false);
 await c.run('applyWorkFilters(f)');assert.match(c.context.location.search,/productSearch=Gloves/);assert.match(c.context.location.search,/reviewOnly=1/);assert.equal(c.apply.disabled,true);
 c.elements.productSearch.value='';c.run('updateFilterApply(f)');assert.equal(c.apply.disabled,false);
});
test('a failed immediate filter preserves the applied query and the other draft',async()=>{
 const c=filterClient();c.context.location.search='?productSearch=Gloves';c.elements.productSearch.value='Boots';c.elements.reviewOnly.checked=true;c.run("refresh=async()=>{throw new Error('Offline');}");await c.run('applyWorkFilters(f,true)');assert.equal(c.context.location.search,'?productSearch=Gloves');assert.equal(c.elements.reviewOnly.checked,false);assert.equal(c.elements.productSearch.value,'Boots');assert.equal(c.feedback.textContent,'Offline');
});
test('selection is permission scoped and each row has separate Unit and Action cells',()=>{
 const c=client();c.context.t=task(1);c.run('snapshot.tasks=[t]');assert.equal(c.run('canBulkDiscard(t)'),true);assert.match(c.run('myTaskRow(t)'),/<td>cases<\/td>/);assert.match(c.run('myTaskRow(t)'),/<td data-my-actions-cell><div/);assert.doesNotMatch(c.run('myTaskRow(t)'),/data-select-task/);
 c.run('selectingTasks=true;selectedTasks.add(1)');assert.match(c.run('myTaskRow(t)'),/data-select-task="1"[^>]*checked/);
 c.run("snapshot.user.role='operator'");assert.equal(c.run('canBulkDiscard(t)'),false);assert.doesNotMatch(c.run('workTableFilters()'),/data-toggle-selection/);
});
test('Review choices and bottom Discard stay visible in both steps; discard uses recorded totals',()=>{
 const c=client();c.context.t=task(1);c.run('snapshot.cells=[{id:1,logical_code:"A1"}];snapshot.operators=[]');
 for(const render of ['checkDialogContent','reviewMovementContent','reviewAssignmentContent']){const html=c.run(`${render}(t)`);assert.match(html,/data-review-align/);assert.match(html,/data-review-assignment/);assert.match(html,/<footer class="review-discard-footer">/);assert.ok(html.indexOf('data-review-discard')>html.indexOf('data-review-assignment'));}
 const html=c.run('discardContent(t)');assert.match(html,/name="currentStatus" value="yes"/);assert.match(html,/name="workerStopped" required/);assert.doesNotMatch(html,/data-actual-editor/);
 const payload=c.run('discardRequest(t)');assert.equal(payload.input.currentStatus,'yes');assert.equal(payload.input.progressToken,'p1');assert.equal(payload.input.workerStopped,true);
 c.run("t.closure_review_id='case';t.closure_case_revision=4");const review=c.run('discardRequest(t)');assert.equal(review.action,'resolve');assert.equal(review.input.caseRevision,4);
});
test('bulk list highlights recorded movements, exposes all actions, and flags changed versions',()=>{
 const c=client();c.context.a=task(1);c.context.b=task(2,{recorded_quantity:0});c.run('snapshot.tasks=[a,b];bulkTasks=[a,b]');const html=c.run('bulkRows()');assert.match(html,/data-bulk-row="1" class="has-movement"/);assert.match(html,/data-bulk-row="2" class=""/);for(const action of ['remove','review','update'])assert.match(html,new RegExp('data-bulk-'+action+'="1"'));
 assert.equal(c.run('bulkTaskStale(a)'),false);c.run("snapshot.tasks=[{...a,progress_token:'new'},b]");assert.equal(c.run('bulkTaskStale(a)'),true);
});
function bulkClient(){
 const c=client(),records=new Map(),sent=[];c.context.records=records;c.context.sent=sent;c.context.a=task(1);c.context.b=task(2);const feedback={textContent:''},f={elements:{confirmed:{checked:true}},querySelector:()=>feedback,closest:()=>({_identity:{site:'test',dataset:'data',actorId:1}})};c.context.f=f;
 c.run(`snapshot.tasks=[a,b];bulkTasks=[a,b];selectedTasks=new Set([1,2]);store=async(name,mode,fn)=>fn({put:o=>records.set(o.id,o),getAll:()=>[...records.values()]});refresh=async()=>{online=true;};openBulkDialog=()=>{};patchMyWorkRows=()=>{};patchSelection=()=>{};`);
 c.context.fetch=async(url,options)=>{sent.push({url,input:JSON.parse(options.body)});return {ok:true,json:async()=>({status:'recorded',closed:true})};};return {...c,records,sent};
}
test('bulk closes each confirmed task once with frozen tokens and preserves partial totals',async()=>{
 const c=bulkClient();await c.run('submitBulkDiscard(f)');assert.equal(c.sent.length,2);assert.deepEqual(c.sent.map(r=>r.input.taskId),[1,2]);assert.deepEqual(c.sent.map(r=>r.input.progressToken),['p1','p2']);assert.ok(c.sent.every(r=>r.input.currentStatus==='yes'&&!('actuals' in r.input)));assert.equal(c.run('selectedTasks.size'),0);assert.equal(c.run('bulkTasks.length'),0);await c.run('submitBulkDiscard(f)');assert.equal(c.sent.length,2);
});
test('changed task during bulk execution is left for review while accepted items stay complete',async()=>{
 const c=bulkClient();c.context.fetch=async(url,options)=>{c.sent.push(JSON.parse(options.body));c.run("snapshot.tasks=[a,{...b,progress_token:'changed'}]");return {ok:true,json:async()=>({status:'recorded',closed:true})};};await c.run('submitBulkDiscard(f)');assert.equal(c.sent.length,1);assert.equal(c.run('selectedTasks.has(1)'),false);assert.equal(c.run('selectedTasks.has(2)'),true);assert.match(c.run('bulkErrors.get(2)'),/changed/);
});
test('lost bulk receipt stays durable and remaining tasks are not sent; retry is identical',async()=>{
 const c=bulkClient();c.context.fetch=async(url,options)=>{c.sent.push(options.body);throw new TypeError('Connection lost');};await c.run('submitBulkDiscard(f)');assert.equal(c.sent.length,1);assert.equal(c.run('selectedTasks.size'),2);assert.equal(c.records.size,1);assert.equal([...c.records.values()][0].state,'local');
 c.context.fetch=async(url,options)=>{c.sent.push(options.body);return {ok:true,json:async()=>({status:'recorded',closed:true})};};await c.run('sync()');assert.equal(c.sent[0],c.sent[1]);
});
test('bulk rejects changed identity, missing confirmation, stale versions and missing permissions before submitting',async()=>{
 for(const change of ["f.elements.confirmed.checked=false","snapshot.dataset='different'","snapshot.tasks=[{...a,assignment_generation:2},b]","snapshot.capabilities={view:true}"]){const c=bulkClient();c.run(change);await c.run('submitBulkDiscard(f)');assert.equal(c.sent.length,0,change);}
});
test('popup history treats switching choices as one step and Back restores the parent without commands',async()=>{
 const c=client(),events=[],opened=[];c.context.window={history:{state:null,replaceState(s){this.state=s;events.push(['replace',s]);},pushState(s){this.state=s;events.push(['push',s]);},go(n){events.push(['go',n]);}}};c.context.a=task(1);c.context.opened=opened;c.run("saveModalDrafts=async()=>{};openTaskDialog=(t,mode)=>opened.push([t.id,mode]);");
 c.run("rememberModal({mode:'bulk-discard'});rememberModal({task:a,mode:'check'});rememberModal({task:a,mode:'check-align'});rememberModal({task:a,mode:'check-assignment'},'replace');");assert.equal(c.run('modalDepth'),3);assert.equal(events.filter(e=>e[0]==='push').length,3);
 await c.run('handleModalPop({state:{workModal:{session:modalSession,depth:2}}})');assert.deepEqual(JSON.parse(JSON.stringify(opened)),[[1,'check']]);assert.equal(c.run('modalDepth'),2);
});
test('history reopens a closed task read-only and refuses a bulk frame from another account',async()=>{
 const c=client(),opened=[];c.context.opened=opened;c.context.a=task(1,{completed_at:'2026-09-30T12:00:00Z',closed_actuals:true});c.run("saveModalDrafts=async()=>{};openTaskDialog=(t,mode)=>opened.push(mode);openBulkDialog=()=>opened.push('bulk');modalFrames.push({task:a,mode:'check-align'});modalDepth=1;");
 await c.run('handleModalPop({state:{workModal:{session:modalSession,depth:1}}})');assert.deepEqual(opened,['details']);
 c.run("modalFrames[0]={mode:'bulk-discard',identity:'another-account'};");await c.run('handleModalPop({state:{workModal:{session:modalSession,depth:1}}})');assert.deepEqual(opened,['details']);
});

test('column dropdowns use displayed tasks, deduplicate values and preserve a disappeared choice',()=>{
 const c=client();c.context.a=task(1);c.context.b=task(2,{type:'put'});c.run('snapshot.tasks=[a,b];snapshot.taskPage={unified:true};snapshot.products=[{name:"Unrelated product"}]');
 const product=c.run('tableFilterOptions("product")');assert.equal(product.length,1);assert.equal(product[0].label,'Packing cases');
 const html=c.run('workTableFilters()');assert.match(html,/input type="search" name="taskSearch"/);assert.match(html,/select name="productSearch"/);assert.match(html,/select name="statusSearch"/);assert.doesNotMatch(html,/select name="taskSearch"|Unrelated product/);
assert.match(html,/value="50" selected>Items per page: 50/);
 c.run('snapshot.tasks=[]');assert.match(c.run('workFilterOptions(workFilterColumns[1],"Packing cases",true)'),/value="Packing cases" selected data-exact="1"/);
});
test('page size changes immediately, reset pagination and preserve unapplied filter drafts',async()=>{
 const c=filterClient();c.context.location.search='?page=3&productSearch=Boots';c.elements.productSearch.value='Gloves';c.elements.pageSize={value:'20'};
 await c.run('applyWorkFilters(f,"pageSize")');const q=new URLSearchParams(c.context.location.search);assert.equal(q.get('pageSize'),'20');assert.equal(q.has('page'),false);assert.equal(q.get('productSearch'),'Boots');assert.equal(c.elements.productSearch.value,'Gloves');assert.equal(c.apply.disabled,false);
 c.run("refresh=async()=>{throw new Error('Offline');}");c.elements.pageSize.value='100';await c.run('applyWorkFilters(f,"pageSize")');assert.equal(new URLSearchParams(c.context.location.search).get('pageSize'),'20');assert.equal(c.elements.pageSize.value,'20');assert.equal(c.elements.productSearch.value,'Gloves');
});
test('Apply marks dropdown values as exact and keeps page size when sorting',async()=>{
 const c=filterClient();c.elements.productSearch.value='Boot';c.elements.productSearch.selectedOptions=[{dataset:{exact:'1'}}];c.context.location.search='?pageSize=20';
 await c.run('applyWorkFilters(f)');const q=new URLSearchParams(c.context.location.search);assert.equal(q.get('productSearchExact'),'1');assert.equal(q.get('pageSize'),'20');assert.match(c.run('workColumn("product","Product")'),/pageSize=20/);
 c.elements.productSearch.value='';await c.run('applyWorkFilters(f)');assert.equal(new URLSearchParams(c.context.location.search).has('productSearchExact'),false);
});

test('physical alignment has one final save action and no Send for review or overlap disclosure',()=>{
 const c=client();c.context.t=task(1);c.run('snapshot.cells=[{id:1,logical_code:"A1"}]');const html=c.run('reviewMovementContent(t)');assert.match(html,/data-review-movement/);assert.match(html,/Accept movement and close task/);assert.doesNotMatch(html,/data-send-task-review|Send for review|Stocktake overlap/);
});

test('History active-only checkbox is immediate and preserves unapplied filters, with rollback on failure',async()=>{
 const c=filterClient();c.run("path='/work/history';f.elements.workState.value='all';");c.elements.activeOnly={checked:true};c.elements.productSearch.value='Gloves';
 await c.run('applyWorkFilters(f,true)');assert.equal(c.context.location.search,'?activeOnly=1');assert.equal(c.elements.productSearch.value,'Gloves');assert.equal(c.apply.disabled,false);
 c.elements.reviewOnly.checked=true;await c.run('applyWorkFilters(f,true)');assert.match(c.context.location.search,/activeOnly=1/);assert.match(c.context.location.search,/reviewOnly=1/);
 c.elements.activeOnly.checked=false;c.run("refresh=async()=>{throw new Error('Offline');}");await c.run('applyWorkFilters(f,true)');assert.equal(c.elements.activeOnly.checked,true);assert.match(c.context.location.search,/activeOnly=1/);assert.equal(c.elements.productSearch.value,'Gloves');
 assert.match(c.run('workTableFilters()'),/See only active assignments/);assert.match(c.run('workColumn("task","Task")'),/activeOnly=1/);
 c.run("path='/work'");assert.doesNotMatch(c.run('workTableFilters()'),/See only active assignments/);
 const options=c.run("workFilterOptions(workFilterColumns.find(c=>c.key==='progress'))");assert.match(options,/value="below-0"[^>]*>&lt;0%/);assert.match(options,/value="above-100"[^>]*>&gt;100%/);
});


test('My Work opens the fresh task editor and its history button saves the draft before opening read-only history',async()=>{
 const c=client(),events=[];c.context.a=task(1);c.context.events=events;let click;c.context.capture=(name,fn)=>{if(name==='click')click=fn;};
 c.run("root.addEventListener=capture;fetchDialogTask=async id=>{events.push('fetch:'+id);return a;};openTaskDialog=(t,mode)=>events.push('open:'+mode);saveModalDrafts=async()=>events.push('save draft');immediate=async()=>{throw new Error('Viewing a popup cannot mutate work');};");
 c.run(source.slice(source.indexOf("root.addEventListener('click'"),source.indexOf('let stopCamera=null;')));
 await click({preventDefault(){events.push('prevent navigation');},target:{closest:s=>s==='[data-task-edit]'?{dataset:{taskEdit:'1'}}:null}});
 assert.deepEqual(events,['prevent navigation','fetch:1','open:edit']);events.length=0;c.root.querySelector=s=>s==='[data-task-dialog]'?{open:true}:null;
 await click({preventDefault(){},target:{closest:s=>s==='[data-task-history]'?{dataset:{taskHistory:'1'}}:null}});
 assert.deepEqual(events,['save draft','fetch:1','open:details']);
});
test('Back from task history restores the task editor rather than opening another page',async()=>{
 const c=client(),opened=[];c.context.a=task(1);c.context.opened=opened;c.context.window={history:{state:null,replaceState(s){this.state=s;},pushState(s){this.state=s;}}};
 c.run("rememberModal({task:a,mode:'edit',identity:key()+':'+snapshot.dataset});rememberModal({task:a,mode:'details',identity:key()+':'+snapshot.dataset});saveModalDrafts=async()=>{};openTaskDialog=(t,mode,line,navigation)=>opened.push({id:t.id,mode,navigation});");
 await c.run('handleModalPop({state:{workModal:{session:modalSession,depth:1}}})');assert.deepEqual(JSON.parse(JSON.stringify(opened)),[{id:1,mode:'edit',navigation:'restore'}]);
});
