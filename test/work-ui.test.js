import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {WORK_TABS} from '../src/modules/access/catalog.js';

// Exercise the actual rendering functions without booting storage or a network poll.
const source = readFileSync(new URL('../public/client/work.js', import.meta.url), 'utf8').replace('export async function mount() {','').split('let syncing=false;')[0];
function view({online = true, role = 'operator', tasks = [], active = false} = {}) {
  const root = {innerHTML: '', querySelectorAll: () => []};
  const context = vm.createContext({
    document: {querySelector: selector => selector === '#work-app' ? root : null},
    crypto: {randomUUID: () => 'test-device'}, localStorage: {getItem: () => 'test-device'},
    URLSearchParams, location: {pathname: '/work', search: ''},
  });
  vm.runInContext(source, context);
  context.state = {workTabs:WORK_TABS,site:'warehouse-a',user:{id:1,name:'Operator',role},generatedAt:'2026-09-25T10:00:00Z',products:[],cells:[],tasks:active&&!tasks.length?[{id:1,assignment_generation:1,assignee_id:1,assignment_state:'started',lines:[]}]:tasks};
  vm.runInContext(`snapshot=state;online=${online};${active?"activeWork={taskId:1,generation:1,identity:key(),dataset:snapshot.dataset};":""}`, context);
  return {root, context, run: code => vm.runInContext(code, context)};
}
const line = {id:1,task_id:1,current_generation:1,revision:2,cell_id:3,logical_code:'A3',unit_of_measure:'pieces',planned_quantity:5,product_name:'Part',product_id:1,type:'pick',execution_state:'ready',created_by:1};

test('leaving an active task sends a scoped keepalive pause; other pages do not',async()=>{
 const ui=view({active:true});let request;
 ui.context.fetch=(url,options)=>{request={url,options};return Promise.resolve({ok:true});};
 ui.run("path='/tasks/1';snapshot.dataset='dataset-a';activeWork.guidanceSession='page-one'");
 await ui.run('pauseActiveWork({keepalive:true})');
 assert.equal(request.url,'/api/work/pause');
 assert.equal(request.options.keepalive,true);
 assert.equal(JSON.parse(request.options.body).guidanceSession,'page-one');
 assert.equal(ui.run('activeWork'),null);
 request=null;ui.run("activeWork={taskId:1,generation:1,identity:key(),dataset:snapshot.dataset,guidanceSession:'page-two'};path='/work'");
 await ui.run('pauseActiveWork({keepalive:true})');
 assert.equal(request,null);
});

test('arrival, scan and manual confirmation remain separate; only explicit completion declares the displayed actual', () => {
  const ui=view({active:true});ui.context.line=line;ui.run("snapshot.cells=[{id:3,logical_code:'A3'},{id:4,logical_code:'B4'}];snapshot.tasks=[{id:1,type:'pick',requested_quantity:5,assignment_generation:1,assignment_state:'started',assignee_id:1,progress_token:'p',closure_token:'c',lines:[line]}]");
  const ready=ui.run('lineCard(line)');assert.match(ready,/I'm at this location/);
  assert.doesNotMatch(ready,/Complete Pick/);
  const working=ui.run("lineCard({...line,execution_state:'working'})");
  assert.match(working,/Scan QR/);assert.match(working,/Confirm without scanning/);
  assert.doesNotMatch(working,/Complete Pick/);
  ui.run("stages.set(stageKey(line),{method:'manual'})");
  const summary=ui.run("lineCard({...line,execution_state:'working'})");
  assert.match(summary,/Complete pick at this location/);assert.match(summary,/data-cell-confirmation/);
  assert.match(summary,/no QR scan/);assert.match(summary,/data-searchable name="cellId"/);
  assert.match(summary,/name="quantity"[^>]+value="5"/);assert.match(summary,/Complete Pick at this location/);
  assert.match(summary,/data-cell-difference/);assert.match(summary,/min="0"/);
  assert.match(summary,/data-open-cell-action="1"/);assert.match(summary,/data-cell-action-dialog/);
  assert.match(summary,/Need help/);assert.match(summary,/Send to supervisor/);
  assert.doesNotMatch(summary,/<summary>Record a difference|<summary>Cancel this location|<summary>Use a different planned location/);
});

test('cell actions stay compact while cancellation, Put replanning, uncertainty and next subtask remain reachable',()=>{
 const ui=view({active:true}),first={...line,type:'put'},second={...line,id:2,cell_id:4,logical_code:'B4',type:'put',planned_quantity:3};
 ui.context.first=first;ui.context.second=second;
 ui.run("snapshot.cells=[{id:3,logical_code:'A3'},{id:4,logical_code:'B4'}];snapshot.tasks=[{id:1,type:'put',assignment_generation:1,assignment_state:'started',assignee_id:1,lines:[first,second]}]");
 const html=ui.run('lineCard(first)');
 assert.match(html,/data-open-cell-action="1"[^>]*>Cancel this location/);
 assert.match(html,/data-next-subtask="2"[^>]*>Next subtask/);
 assert.match(html,/data-cell-action-panel="cancel"/);
 assert.match(html,/data-cell-action-panel="replan" hidden/);
 assert.match(html,/data-cell-action-panel="help" hidden/);
 assert.match(html,/data-work-action="cancel"/);assert.match(html,/data-work-action="replan"/);
 assert.match(html,/data-work-action="rejectCell"/);assert.match(html,/data-work-action="askReview"/);
 assert.match(html,/name="quantity"[^>]*value="5"/);
 assert.equal(ui.run('nextSubtaskId(snapshot.tasks[0],first.id)'),second.id);
 assert.equal(ui.run('nextSubtaskId(snapshot.tasks[0],second.id)'),first.id);
 ui.run("second.execution_state='settled'");
 assert.equal(ui.run('nextSubtaskId(snapshot.tasks[0],first.id)'),null);
});

test('QR and no-camera paths use the same editable product, location and quantity confirmation', () => {
 for(const type of ['pick','put'])for(const method of ['camera','manual']){
  const ui=view({active:true});ui.context.line={...line,type};ui.run("snapshot.cells=[{id:3,logical_code:'A3'},{id:4,logical_code:'B4'}];snapshot.tasks=[{id:1,requested_quantity:5,assignment_generation:1,assignment_state:'started',assignee_id:1,progress_token:'p',closure_token:'c',lines:[line]}]");
  ui.run(`stages.set(stageKey(line),{method:'${method}',location:'checked-label'})`);
  const html=ui.run("lineCard({...line,execution_state:'working'})");
  assert.match(html,/Confirm (Pick|Put) at this location/);
  assert.match(html,/Part/);assert.match(html,/data-searchable name="cellId"/);
  assert.match(html,/<option value="3" selected>A3<\/option>/);
  assert.match(html,/<option value="4"[^>]*>B4<\/option>/);
  assert.match(html,/name="quantity"[^>]*value="5"/);
  assert.match(html,/name="cellCompletion" value="true"/);
  assert.match(html,new RegExp(`Complete ${type==='pick'?'Pick':'Put'} at this location`));
  assert.match(html,/Back to task/);
 }
});

test('task finish offers unfinished cells first and requires explicit confirmation for supervisor review', () => {
 const ui=view({active:true}),first={...line,execution_state:'settled',actual_quantity:3},second={...line,id:2,cell_id:4,logical_code:'B4',planned_quantity:2,execution_state:'ready'};
 ui.context.task={id:1,requested_quantity:5,recorded_quantity:3,lines:[first,second],assignment_generation:1,progress_token:'p',closure_token:'c'};
 let html=ui.run('taskFinishDialog(task,[task.lines[1]])');assert.match(html,/B4 · pick 2 pieces/);assert.match(html,/name="unfinishedConfirmed" required/);assert.match(html,/data-work-action="sendTaskReview"/);
 ui.run('task.recorded_quantity=5');html=ui.run('taskFinishDialog(task,[])');assert.match(html,/data-work-action="closeTask"/);assert.doesNotMatch(html,/name="unfinishedConfirmed"/);
});

test('informational dialogs offer a close icon while decision dialogs keep explicit actions', () => {
 const ui=view({role:'admin'}),task={id:1,type:'put',assignee_id:1,assignment_generation:1,requested_quantity:5,recorded_quantity:3,remaining_quantity:2,attention:1,lines:[{...line,type:'put',execution_state:'settled',actual_quantity:3}]};
 ui.context.task=task;ui.run('snapshot.tasks=[task];snapshot.operators=[]');
 assert.match(ui.run('checkDialogContent(task)'),/data-dialog-dismiss aria-label="Close review"/);
 assert.match(ui.run('taskHistoryContent(task)'),/data-dialog-dismiss aria-label="Close task history"/);
 assert.match(ui.run("operationContent({stage:'connection'})"),/data-dialog-dismiss aria-label="Close connection status"/);
 assert.doesNotMatch(ui.run('reviewMovementContent(task)'),/data-dialog-dismiss/);
 assert.doesNotMatch(ui.run('discardContent(task)'),/data-dialog-dismiss/);
 assert.doesNotMatch(ui.run('taskFinishDialog(task,[])'),/data-dialog-dismiss/);
});

test('a completed Put task shows no Resume or Complete Task action', () => {
 const ui=view({active:true});
 const task={id:1,type:'put',summary:'Part',outcome:'completed',completed_at:'2026-10-07T10:00:00Z',requested_quantity:5,recorded_quantity:5,remaining_quantity:0,assignment_generation:1,assignment_state:'started',assignee_id:1,lines:[{...line,type:'put',execution_state:'settled',actual_quantity:5}]};
 ui.context.task=task;ui.run("snapshot.tasks=[task];path='/tasks/1'");
 const html=ui.run('taskPage(1)');
 assert.match(html,/Back to My work/);
 assert.doesNotMatch(html,/data-work-action="resume"|data-complete-task|data-task-finish-dialog/);
});

test('a supervisor can accept a short task total and assign the remainder from the same review', () => {
 const ui=view({role:'admin'});
 ui.context.task={id:9,type:'pick',requested_quantity:5,remaining_quantity:1,recorded_quantity:0,assignee_id:2,assignment_generation:2,progress_token:'p',closure_token:'c',closure_review_id:'case-9',closure_case_revision:1,closure_actuals:[{cellId:3,quantity:4}],lines:[{...line,task_id:9}]};
 ui.run("snapshot.cells=[{id:3,logical_code:'A3'}];snapshot.operators=[{id:2,name:'Operator',username:'worker',eligible:true,status:'active'}]");
 const html=ui.run('reviewMovementContent(task)');
 assert.match(html,/Accept movement and close task/);
 assert.match(html,/Accept movement and assign remaining/);
 assert.match(html,/data-assign-remaining/);
 assert.match(html,/data-searchable name="assigneeId"/);
 assert.match(html,/name="actualQuantity0"[^>]*value="4"/);
});

test('active pick and put show compact task info above selectable cells and one main card', () => {
 for (const type of ['pick','put']) {
  const ui=view({active:true});
  const task={id:1,type,summary:'Part',outcome:'open',assignment_generation:1,assignment_state:'started',assignee_id:1,assignee_name:'Operator',assigned_by_name:'Admin',assigned_at:'2026-10-06T08:00:00Z',requested_quantity:10,recorded_quantity:2,remaining_quantity:8,lines:[
   {...line,type,execution_state:'working',guidance:{state:'sent',message:'Light on'}},
   {...line,id:2,type,cell_id:4,logical_code:'B4',planned_quantity:3,execution_state:'ready',guidance:{state:'sent',message:'Light on'}},
   {...line,id:3,type,cell_id:5,logical_code:'C5',planned_quantity:2,execution_state:'settled',actual_quantity:2},
  ]};
  ui.context.task=task;ui.run("snapshot.tasks=[task];path='/tasks/1'");
  let html=ui.run('taskPage(1)');
  assert.match(html,/<nav class="task-location-list" data-task-cells/);
  assert.match(html,/<section class="task-context task-info"/);
  assert.match(html,/<dt>Status<\/dt><dd>In progress<\/dd>/);
  assert.match(html,/<dt>Assigned by<\/dt><dd>Admin<\/dd>/);
  assert.ok(html.indexOf('aria-label="Task info"')<html.indexOf('data-task-cells'));
  assert.ok(html.indexOf('data-task-cells')<html.indexOf('data-line="1"'));
  assert.ok(html.indexOf('<dt>Product name</dt>')<html.indexOf('<dt>Status</dt>'));
  assert.match(html,/Refresh light/);assert.match(html,/Scan QR/);
  assert.equal((html.match(/class="task-location-card(?: is-complete| )?"/g)||[]).length,3);
  assert.match(html,/class="task-location-card is-complete"[^>]*>\s*<strong>C5/);
  assert.match(html,new RegExp(`B4<\\/strong><span>${type==='put'?'Put':'Pick'} 3 pieces`));
  assert.doesNotMatch(html,/Other locations|Recorded \/ closed locations/);
  ui.run("location.search='?line=2'");html=ui.run('taskPage(1)');
  assert.match(html,/href="\/tasks\/1\?line=2" aria-current="true"/);
  assert.match(html,/data-line="2"/);
  assert.doesNotMatch(html,/data-line="1"/);
 }
});

test('work sends notices to the shared header once per message', () => {
 const ui=view();const sent=[];ui.context.WarehouseNotifications={notify:(message,options)=>sent.push({message,options})};
 ui.run("notice='Task saved';captureNotification();captureNotification()");assert.equal(sent.length,1);assert.equal(sent[0].message,'Task saved');
 ui.run("notice='Light ready';paintNotifications()");assert.equal(sent.length,2);
 assert.doesNotMatch(ui.run("sectionNavigation('')"),/Notifications|notification-panel/);
 ui.run("notice='';captureNotification();notice='Task saved';captureNotification()");assert.equal(sent.length,3);
 ui.run("announce('Task saved');announce('Task saved');paintNotifications()");assert.equal(sent.length,5);
 ui.run("connectionWarning='Connection lost';paintNotifications();paintNotifications()");assert.equal(sent.length,6);assert.equal(sent[5].options.tone,'warning');
});

test('offline reports stay accessible and queued/view-only safeguards survive simpler screens', () => {
  const ui = view({online:false}); ui.context.line = line;
  const offline = ui.run('lineCard(line)');
  assert.match(offline, /data-record-moved="1"/);
  assert.doesNotMatch(offline, /data-work-action="acquire"/);
  const readonly = ui.run('lineCard({...line,canAct:false})');
  assert.doesNotMatch(readonly, /<form/);
  ui.run("outbox=[{partition:key(),state:'local',input:{lineId:1}}]");
  assert.match(ui.run('lineCard(line)'), /Do not repeat the movement/);
  assert.match(ui.run('lineCard(line)'), /<button disabled>Update saved/);
});

test('My work shows only own current tasks; optional location retains explicit preference', () => {
  const ui = view({tasks:[
    {id:1,assignee_id:1,status:'completed',outcome:'completed',summary:'Completed task',lines:[]},
    {id:2,assignee_id:1,status:'working',summary:'Active task',lines:[]},
    {id:3,assignee_id:1,status:'pending_review',attention:1,summary:'Needs checking',lines:[]},
  ]});
  const home = ui.run('home()');
  assert.match(home,/Active task/);assert.match(home,/Needs checking/);assert.doesNotMatch(home,/Completed task|data-disclosure="completed-work"/);
  const plan = ui.run("createPage('pick')");
  assert.match(plan, /data-disclosure="preferred-location"[^>]*><summary>/);
  ui.run("location.search='?cell_id=3'");
  assert.match(ui.run("createPage('put')"), /data-disclosure="preferred-location" open/);
});

test('refresh restores both opened and explicitly closed disclosure state', () => {
  const ui = view();
  const before = [{dataset:{disclosure:'work-tools'},open:true},{dataset:{disclosure:'manual-1'},open:false}];
  const after = [{dataset:{disclosure:'work-tools'},open:false},{dataset:{disclosure:'manual-1'},open:true}];
  let reads = 0;
  ui.root.querySelectorAll = selector => selector==='details[data-disclosure]'?(reads++ === 0 ? before : after):[];
  ui.run('render()');
  assert.equal(after[0].open,true);
  assert.equal(after[1].open,false);
});

test('mobile menu Escape and breakpoint changes restore focus after CSS hides a link', () => {
  const handlers = new Map();
  const listen = target => (name, callback) => handlers.set(`${target}:${name}`,callback);
  const classes = new Set();
  const document = {body:{},activeElement:null,addEventListener:listen('document')};
  const media = {matches:false,addEventListener:listen('media')};
  const link = {closest:()=>null,focus:()=>{document.activeElement=link;}};
  const attrs = {'aria-expanded':'false'};
  const toggle = {hidden:true,textContent:'Menu',addEventListener:listen('toggle'),getAttribute:n=>attrs[n],setAttribute:(n,v)=>{attrs[n]=v;},focus:()=>{document.activeElement=toggle;}};
  const sidebar = {
    classList:{add:c=>classes.add(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},
    querySelector:s=>s==='.mobile-nav-toggle'?toggle:link,
    contains:e=>e===link||e===toggle,addEventListener:listen('sidebar'),
  };
  document.querySelector=()=>sidebar;
  vm.runInNewContext(readFileSync(new URL('../public/client/mobile-nav.js',import.meta.url),'utf8'),{document,window:{matchMedia:()=>media,addEventListener:listen('window')}});
  assert.equal(toggle.hidden,false);
  assert.ok(classes.has('nav-ready'));
  handlers.get('document:focusin')({target:link});
  document.activeElement=document.body; // Browser blurs a link as display:none takes effect.
  media.matches=true;handlers.get('media:change')();
  assert.equal(document.activeElement,toggle);
  handlers.get('toggle:click')();
  assert.equal(attrs['aria-expanded'],'true');
  let prevented=false;
  handlers.get('sidebar:keydown')({key:'Escape',preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(attrs['aria-expanded'],'false');
  assert.equal(document.activeElement,toggle);
  media.matches=false;handlers.get('media:change')();
  assert.equal(document.activeElement,link);
  assert.equal(classes.has('mobile-menu-open'),false);
});

test('saved updates describe the actual action and distinguish delivery from supervisor checking',()=>{
 const ui=view();ui.context.update={action:'report',input:{direction:'pick',quantity:4,unit:'cases'},state:'local',message:'Saved report'};
 let html=ui.run('queueEntry(update)');assert.match(html,/Pick 4 cases/);assert.match(html,/Saved on this device/);assert.doesNotMatch(html,/supervisor check|report/i);
 ui.context.update={...ui.context.update,state:'review'};html=ui.run('queueEntry(update)');assert.match(html,/Received by the warehouse/);assert.match(html,/do not repeat the movement/);assert.doesNotMatch(html,/receipt is not confirmed|Waiting for warehouse confirmation/);
 ui.context.update={action:'reassign',input:{},state:'not-applied',message:'Assignment changed'};html=ui.run('queueEntry(update)');assert.match(html,/Assign task/);assert.match(html,/Change could not be saved/);assert.doesNotMatch(html,/Quantity needs supervisor/);
});
test('count comparison uses actual evidence and leaves inclusion versus separate movement explicit',()=>{
 const ui=view();ui.context.entry={id:'case',product_id:1,direction:'pick',quantity:2,quantity_known:1,unit:'cases',countOverlap:true,countEvidence:{id:'count',logical_code:'A1',title:'Shelf count',counted_at:'2026-09-28T08:00:00Z',counter_name:'Alex',lines:[{productId:1,recorded:10,actual:8,unit:'cases'}]}};
 const html=ui.run('countOptions(entry)');assert.match(html,/from 10 to 8 cases/);assert.match(html,/pick of 2 cases/);assert.match(html,/Already included in this count/);assert.match(html,/separate pick/);assert.match(html,/Matching quantities alone do not prove this/);assert.doesNotMatch(html,/observation ID|overlaps a stocktake/);
});

test('review cases render all three people and human duplicate/count choices without internal-ID inputs',()=>{const ui=view({role:'admin'});ui.context.review={id:'opaque-case-id',case_revision:1,product_id:1,cell_id:1,product_name:'Bolts',logical_code:'A1',direction:'put',quantity:2,quantity_known:1,unit:'cases',reporter_name:'Alex',reporter_username:'entry-user',operator_name:'Sam',performer_username:'sam2',assignee_name:'Sam',assignee_username:'sam1',created_at:'2026-09-25T09:00:00Z',reason:'Verify original physical work',payload:'{}'};ui.run('snapshot.pending=[review];snapshot.discrepancies=[];snapshot.postedReports=[];snapshot.performers=[];');const html=ui.run('pendingPage()');assert.match(html,/Assigned to/);assert.match(html,/Performed by/);assert.match(html,/Entered by/);assert.match(html,/sam1/);assert.match(html,/sam2/);assert.match(html,/Has this put already been saved/);assert.match(html,/View saved entry/);assert.match(html,/Use this saved entry/);assert.doesNotMatch(html,/Reported by|Movement overlaps|Already recorded elsewhere|<input[^>]+name="countCorrectionId"/);});

test('routine review guidance is state-based and preserves user-authored report wording in original details',()=>{const ui=view({role:'admin'});ui.context.review={id:'case',case_revision:1,product_id:1,cell_id:1,product_name:'Boots',logical_code:'A1',direction:'pick',quantity:1,quantity_known:0,unit:'pairs',reporter_name:'Alex',created_at:'2026-09-25T09:00:00Z',reason:'Original report needs review',payload:JSON.stringify({reason:'The report says “report a shortage”.'})};ui.run('snapshot.pending=[review];snapshot.discrepancies=[];snapshot.postedReports=[];snapshot.performers=[];');const html=ui.run('pendingPage()');assert.match(html,/Ask the person who did the work how much moved/);assert.match(html,/The report says “report a shortage”/);assert.match(html,/Original report needs review/);assert.doesNotMatch(html,/The entry says/);});

test('task rows expose one set of own start/decline actions beside the product and retain manager assignment',()=>{const ui=view({role:'admin'});ui.context.task={id:4,type:'pick',summary:'Pick Boots',outcome:'open',assignee_id:1,assignment_source:'assigned',assignment_state:'offered',assignment_generation:1,lines:[line]};const html=ui.run('taskRow(task)'),first=html.slice(0,html.indexOf('</th>'));assert.match(first,/Start task/);assert.doesNotMatch(first,/Decline task/);assert.equal((html.match(/data-work-action="start"/g)||[]).length,1);assert.equal((html.match(/data-hand-back="4"/g)||[]).length,0);assert.ok(html.indexOf('data-work-action="reassign"')>html.indexOf('class="task-row-actions"'));ui.context.task.assignee_id=2;assert.doesNotMatch(ui.run('taskRow(task)'),/data-work-action="start"|data-work-action="decline"/);});
test('completed task leads with its result without empty reassignment, while stopped remainder stays assignable',()=>{const ui=view({role:'admin'});ui.context.task={id:3,type:'pick',summary:'Boots',outcome:'completed',completed_at:'2026-09-28T10:00:00Z',due_at:'2026-09-29T10:00:00Z',recorded_quantity:1,remaining_quantity:0,assignee_id:1,assignment_state:'started',lines:[{...line,execution_state:'settled',actual_quantity:1}]};ui.run('snapshot.tasks=[task]');let html=ui.run('taskPage(3)');assert.match(html,/Back to My work/);assert.doesNotMatch(html,/data-disclosure="detail-reassign"/);assert.doesNotMatch(html.split('</section>')[0],/Due /);assert.match(ui.run('taskHistoryContent(task)'),/Deadline/);ui.context.task.outcome='stopped';ui.context.task.remaining_quantity=2;html=ui.run('taskPage(3)');assert.match(html,/Stopped — partly completed/);assert.match(html,/data-work-action="reassign"/);ui.context.task.attention=1;ui.context.task.outcome='needs_review';assert.doesNotMatch(ui.run('taskPage(3)'),/Back to My work|data-work-action="reassign"/);});
test('product filtering retains an explicit selection, never chooses the first result, and preserves recovery prefills/reference',()=>{const ui=view();ui.run("snapshot.products=[{id:1,name:'Boots',sku:'BOOT-1',unit_of_measure:'pairs'},{id:2,name:'Gloves',sku:'GLOVE-2',unit_of_measure:'pairs'}];snapshot.cells=[{id:3,logical_code:'A3'}]");assert.doesNotMatch(ui.run('productPicker()'),/productSearch/);assert.match(ui.run('productPicker()'),/select data-searchable/);let html=ui.run('manualPage()');assert.match(html,/name="productId" required><option value="">Choose a product/);assert.match(html,/name="cellId" required><option value="">Choose a location/);const reference=ui.run('provisionalReference()');assert.equal(reference,ui.run('provisionalReference()'));assert.match(html,/Earlier work or paper records \(optional\)/);assert.match(html,/name="occurredAt" type="datetime-local"/);assert.doesNotMatch(html,/name="occurredAt"[^>]+value=/);ui.run("location.search='?product_id=1&cell_id=3&quantity=2&return_to=%2Fcells%2F3&direction=put'");html=ui.run('manualPage()');assert.match(html,/value="1" selected>Boots/);assert.match(html,/value="3" selected>A3/);assert.match(html,/name="quantity"[^>]+value="2"/);assert.match(html,/value="put" selected/);assert.match(html,/href="\/cells\/3"/);assert.equal(new URLSearchParams(ui.run("recoveryHref('pick')").split('?')[1]).get('return_to'),'/cells/3');});
test('live row updates retain a draft in the new first-column actions as well as the manager editor',()=>{const ui=view();ui.context.task={id:1,type:'pick',summary:'Boots',outcome:'open',lines:[]};ui.run("snapshot.tasks=[task];path='/work/overview'");const active={},cells=Array.from({length:7},(_,i)=>({innerHTML:'old-'+i,contains:e=>i===0&&e===active,querySelector:()=>null}));const row={dataset:{taskRow:'1'},innerHTML:'old row',children:cells,contains:()=>true,querySelector:()=>null};const scroller={scrollLeft:12,scrollTop:4};ui.root.querySelectorAll=s=>s==='.work-table-wrap,.my-work-table-wrap'?[scroller]:s==='[data-task-row]'?[row]:[];let noticeUpdated=false;const noticeNode={dataset:{notice:'Keep this evidence'},set innerHTML(v){noticeUpdated=true;}};ui.run("notice='Keep this evidence'");ui.root.querySelector=s=>s==='#work-notice'?noticeNode:null;ui.context.document.activeElement=active;ui.context.document.createElement=()=>({content:{firstElementChild:{innerHTML:'updated row',children:cells.map((_,i)=>({innerHTML:'new-'+i}))}}});let top;ui.context.window={scrollY:240,scrollTo:v=>{assert.equal(noticeUpdated,false);top=v.top;}};const live=readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8').replace('export async function mount() {','').split('function patchLiveRows(){')[1].split('async function backgroundRefresh')[0];ui.run('function patchLiveRows(){'+live);ui.run('patchLiveRows()');assert.equal(cells[0].innerHTML,'old-0');assert.equal(cells[2].innerHTML,'new-2');assert.equal(cells[6].innerHTML,'old-6');assert.equal(top,240);assert.equal(scroller.scrollLeft,12);});

test('prefilled drafts do not collide with plain drafts and distinct recovery drafts retain distinct stable references',()=>{const ui=view();ui.context.fixtureForm={dataset:{workAction:'manual'},elements:{}};let id=0;ui.context.crypto.randomUUID=()=>String(++id);ui.run("path='/record-movement';location.search=''");const plainKey=ui.run('draftKey(fixtureForm)'),plainRef=ui.run('provisionalReference()');ui.run("location.search='?product_id=1&quantity=2&return_to=%2Fcells%2F3'");const contextKey=ui.run('draftKey(fixtureForm)'),contextRef=ui.run('provisionalReference()');assert.notEqual(plainKey,contextKey);assert.notEqual(plainRef,contextRef);assert.equal(contextRef,ui.run('provisionalReference()'));ui.run("location.search='?return_to=%2Fcells%2F3&quantity=2&product_id=1'");assert.equal(contextKey,ui.run('draftKey(fixtureForm)'));ui.run("location.search=''");assert.equal(plainRef,ui.run('provisionalReference()'));ui.context.createForm={elements:{productId:{value:'2'},preferredCellId:{value:'7'},quantity:{value:'4'}}};const q=new URLSearchParams(ui.run("recoveryHref('put',createForm)").split('?')[1]);assert.equal(q.get('product_id'),'2');assert.equal(q.get('cell_id'),'7');assert.equal(q.get('quantity'),'4');assert.equal(q.get('direction'),'put');});

test('untouched offers keep Start primary while cancellation and handback are inside the stop dialog',()=>{const ui=view();ui.context.task={id:4,type:'pick',summary:'Boots',outcome:'open',assignee_id:1,assignment_source:'assigned',assignment_state:'offered',canAct:true,lines:[{...line,canAct:false}]};ui.run('snapshot.tasks=[task]');const html=ui.run('taskPage(4)');assert.match(html,/Start task/);assert.match(html,/data-task-stop="4"/);assert.doesNotMatch(html,/data-work-action="stop"|data-work-action="handBack"/);const dialog=ui.run('stopDialogContent(task)');assert.match(dialog,/Close task/);assert.match(dialog,/data-work-action="decline"/);assert.match(dialog,/value="yes" required>Yes/);ui.run("snapshot.user.role='admin';task.assignee_id=2;task.canAct=false");assert.match(ui.run('stopDialogContent(task)'),/data-work-action="closeTask"/);assert.doesNotMatch(ui.run('stopDialogContent(task)'),/data-work-action="handBack"/);});
test('count comparison and candidate dates never use arrival time as unknown counting time',()=>{const ui=view();ui.context.count={title:'Shelf count',logical_code:'A1',counted_at:null,received_at:'2026-09-28T10:00:00Z',counter_name:'Sam',lines:[{productId:1,recorded:10,actual:8,unit:'pairs'}]};ui.context.entry={product_id:1,direction:'pick',quantity:2,unit:'pairs'};for(const html of [ui.run('countSequence(count,entry)'),ui.run('countCandidateLabel(count)')]){assert.match(html,/Counting time unknown/);assert.match(html,/Received /);assert.doesNotMatch(html,/Sam at/);}ui.context.count.counted_at='2026-09-27T09:00:00Z';const known=ui.run('countTimes(count)');assert.match(known,/Counted /);assert.match(known,/Received /);assert.doesNotMatch(known,/Counting time unknown/);});
test('Other evidence opens and requires its description, ordinary notes remain optional and whitespace cannot pass',()=>{const ui=view(),summary={},details={open:false,querySelector:()=>summary},note={value:'',closest:()=>details,setCustomValidity(v){this.error=v;}},f={elements:{verification:{value:'Spoke with operator'},verificationNote:note}};ui.context.reviewForm=f;ui.run('updateVerificationFields(reviewForm)');assert.equal(note.required,false);assert.equal(details.open,false);f.elements.verification.value='Other evidence (describe below)';ui.run('updateVerificationFields(reviewForm)');assert.equal(note.required,true);assert.equal(details.open,true);assert.ok(note.error);assert.throws(()=>ui.run("verifiedDescription({verification:'Other evidence (describe below)',verificationNote:'   '})"),/Describe/);note.value='Signed movement slip';ui.run('updateVerificationFields(reviewForm)');assert.equal(note.error,'');assert.match(ui.run("verifiedDescription({verification:'Other evidence (describe below)',verificationNote:'Signed movement slip'})"),/Signed movement slip/);f.elements.verification.value='Observed movement';ui.run('updateVerificationFields(reviewForm)');assert.equal(note.required,false);assert.equal(note.value,'Signed movement slip');assert.equal(ui.run("verifiedDescription({verification:'Spoke with operator',verificationNote:''})"),'Spoke with operator');});
test('timing units convert the displayed value without changing duration and filters keep stable query values',()=>{const ui=view({role:'admin'}),f={dataset:{workAction:'timing'},elements:{minutes:{value:'2',dataset:{timeUnit:'hours'}},timeUnit:{value:'minutes'}}};ui.context.timingForm=f;ui.run('updateTimingFields(timingForm,true)');assert.equal(f.elements.minutes.value,'120');f.elements.timeUnit.value='hours';ui.run('updateTimingFields(timingForm,true)');assert.equal(f.elements.minutes.value,'2');ui.run('snapshot.timing={minutes:120,inactivityMinutes:5,timezone:"Asia/Kolkata",enabled:true}');assert.match(ui.run('timingPage()'),/value="hours" selected>Hours/);assert.equal(ui.run("taskFilterLabel('open')"),'Active');assert.equal(ui.run("taskFilterLabel('closed')"),'Finished');});

test('routine monitoring keeps the draft and sends connection warnings to the global bell',()=>{
 const ui=view(),sent=[],cleared=[];let writes=0;
 Object.defineProperty(ui.root,'innerHTML',{get:()=>'<input value="saved draft">',set:()=>writes++});
 ui.root.querySelector=()=>null;ui.context.window={scrollY:120,scrollTo(){}};
 ui.context.WarehouseNotifications={notify:(message,options)=>sent.push({message,options}),clearKey:key=>cleared.push(key)};
 ui.run("notice='Saved quantity needs checking';snapshot.tasks=[]");
 const live=readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8').replace('export async function mount() {','').split('function patchLiveRows(){')[1].split('async function backgroundRefresh')[0];ui.run('function patchLiveRows(){'+live);
 ui.run('patchLiveRows()');assert.equal(writes,0);assert.equal(sent.length,1);
 ui.run("online=false;connectionWarning='Connection lost. Saved updates remain on this phone.';patchLiveRows();patchLiveRows()");
 assert.equal(writes,0);assert.equal(sent.length,2);assert.match(sent[1].message,/Connection lost/);assert.equal(sent[1].options.key,'work-connection');
 ui.run("online=true;connectionWarning='';patchLiveRows()");assert.deepEqual(cleared,['work-connection']);assert.equal(writes,0);
});

test('restoring a review draft exposes required evidence even when its disclosure was previously collapsed',()=>{
 const ui=view(),summary={},details={dataset:{disclosure:'verification-note-entry'},open:false,querySelector:()=>summary};
 const note={name:'verificationNote',value:'',closest:()=>details,setCustomValidity(v){this.error=v;}};
 const method={name:'verification',value:''},elements=[note,method];Object.assign(elements,{verification:method,verificationNote:note});
 const form={dataset:{workAction:'resolve'},elements};ui.context.reviewForm=form;
 ui.root.querySelectorAll=s=>s==='details[data-disclosure]'?[details]:s==='form[data-work-action]'?[form]:[];ui.root.querySelector=()=>null;
 ui.run("drafts.set(draftKey(reviewForm),{verification:{value:'Other evidence (describe below)'},verificationNote:{value:''}});snapshot.pending=[];render()");
 assert.equal(method.value,'Other evidence (describe below)');assert.equal(details.open,true);assert.equal(note.required,true);assert.ok(note.error);
});

// The same renderer consumes live snapshots and cached snapshots during outages.
test('Work tools use snapshot capabilities online and offline, including older cached snapshots',()=>{
 for(const online of [true,false]){
  const ui=view({online,role:'custom'});
  ui.run("snapshot.capabilities={view:true};render()");
  assert.doesNotMatch(ui.root.innerHTML,/href="\/"/);assert.equal(ui.run("allowed(workLinkCapability('/recommended-actions'))"),true);
  if(!online)assert.match(ui.root.innerHTML,/href="\/recommended-actions"/);
  else assert.doesNotMatch(ui.root.innerHTML,/aria-label="Work views"/);
  assert.doesNotMatch(ui.root.innerHTML,/href="\/(?:stocktaking|cells|labels|work\/overview|pending-confirmations|work\/timing)"/);
  ui.run("snapshot.capabilities.countView=true;snapshot.capabilities.locationsView=true;render()");
  assert.doesNotMatch(ui.root.innerHTML,/href="\/stocktaking"/);assert.equal(ui.run("allowed(workLinkCapability('/cells/1'))"),true);
 }
});

test('unified table has exact columns, compact actions, global filter controls and independent next task',()=>{
 const ui=view({role:'admin'});ui.context.task={id:10,summary:'Boots',type:'pick',assignee_id:1,assignment_source:'assigned',assignment_state:'offered',assignment_generation:2,requested_quantity:5,recorded_quantity:0,remaining_quantity:5,outcome:'open',lines:[line]};
 ui.run("snapshot.tasks=[task];snapshot.taskPage={view:'mine',unified:true};snapshot.myWorkNextTask=task");
 const html=ui.run('home()');for(const label of ['Task','Product','Requested','Completed','Remaining','Status','Progress','State'])assert.ok(html.includes('>'+label+' '),label);assert.equal((html.match(/<table /g)||[]).length,1);assert.match(html,/See only review items/);assert.doesNotMatch(html,/name="(?:requested|completed|remaining|progress)(?:Min|Max)"/);assert.match(html,/data-add-filter/);assert.match(html,/data-remove-filter=/);assert.match(html,/data-task-check="10"/);assert.match(html,/>Start</);assert.match(html,/Pick stock/);assert.match(html,/Put stock/);assert.doesNotMatch(html,/data-returned-work-table/);
 ui.run("snapshot.tasks=[]");assert.match(ui.run('myNextContent()'),/data-next-id="10"/);ui.run("snapshot.taskPage.view='team'");assert.doesNotMatch(ui.run('myNextContent()'),/data-next-id/);
 ui.run("task.completed_at='2026-09-30';task.outcome='stopped';task.recorded_quantity=2;task.remaining_quantity=3");const row=ui.run('myTaskRow(task)');assert.match(row,/40%/);assert.match(row,/Task Completed/);assert.doesNotMatch(row,/data-work-action="start"|data-task-check/);
});

test('My work live patch inserts arrivals first, preserves focused row and horizontal state, and removes stale rows after release',()=>{
 const ui=view();const tasks=[1,2,3].map(id=>({id,assignee_id:1,assignment_generation:1,assignment_state:'started',assignment_source:'self',outcome:'open',requested_quantity:2,recorded_quantity:0,assigned_at:`2026-09-28T10:00:0${id}Z`,summary:'Part '+id,lines:[]}));
 let rows=[],active;
 const makeRow=html=>{const id=html.match(/data-task-row="(\d+)"/)[1],cells=[...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m=>({innerHTML:m[1],hasAttribute:name=>name==='data-my-actions-cell'&&m[0].includes('data-my-actions-cell'),contains:e=>false}));const row={dataset:{taskRow:id},innerHTML:html,children:cells,classList:{add(){}},contains:e=>e===row&&active===row,querySelector:()=>null,querySelectorAll:()=>[],getBoundingClientRect:()=>({top:rows.indexOf(row)*64}),remove(){rows=rows.filter(r=>r!==row);},replaceWith(next){rows[rows.indexOf(row)]=next;}};return row;};
 const body={querySelectorAll:()=>rows,querySelector:()=>rows[0],get firstElementChild(){return rows[0];},set innerHTML(v){rows=[];},insertBefore(row,before){rows.splice(rows.indexOf(before),0,row);},append(row){rows=rows.filter(r=>r!==row);rows.push(row);}};
 ui.context.document.createElement=()=>({content:{},set innerHTML(html){this.content.firstElementChild=makeRow(html);}});
 ui.root.querySelector=s=>s==='[data-my-work-table]'?body:null;
 ui.context.fixture=tasks;ui.run('snapshot.tasks=fixture.slice(0,2)');rows=[2,1].map(id=>{ui.context.task=tasks[id-1];return makeRow(ui.run('myTaskRow(task)'));});
 const protectedNode=rows[1];const protectedAction=protectedNode.children.find(c=>c.hasAttribute('data-my-actions-cell'));protectedAction.innerHTML='Focused action and draft';active=protectedNode;ui.context.document.activeElement=protectedNode;
 ui.run('snapshot.tasks=[fixture[2],fixture[1],fixture[0]]');assert.equal(ui.run('patchMyWorkRows()'),64);assert.deepEqual(rows.map(r=>r.dataset.taskRow),['3','2','1']);assert.equal(rows[2],protectedNode);assert.equal(rows[2].children[11],protectedAction);assert.equal(protectedAction.innerHTML,'Focused action and draft');assert.notEqual(rows[2].children[5].innerHTML,'Focused action and draft');
 ui.run('snapshot.tasks=[fixture[2]];snapshot.watchedTasks=[{...fixture[0],completed_at:"2026-09-28",outcome:"completed"}]');ui.run('patchMyWorkRows()');assert.deepEqual(rows.map(r=>r.dataset.taskRow),['3','1']);assert.equal(rows[1],protectedNode);
 active=null;ui.context.document.activeElement=null;ui.run('patchMyWorkRows()');assert.deepEqual(rows.map(r=>r.dataset.taskRow),['3']);
});

test('focused Start, next-task and action-dialog controls disable stale actions without replacing drafts or generation',()=>{
 const ui=view();const task={id:1,progress_token:'fresh',assignee_id:1,assignment_generation:4,assignment_state:'offered',assignment_source:'assigned',outcome:'open',canAct:true,lines:[{...line}],requested_quantity:5,recorded_quantity:0};
 ui.context.task=task;ui.run("snapshot.tasks=[task];snapshot.taskPage={view:'mine'};snapshot.myWorkNextTask=task");
 const start={disabled:false},feedback={textContent:''},form={elements:{progressToken:{value:'fresh'}},querySelectorAll:()=>[start],querySelector:()=>feedback};
 const row={dataset:{taskRow:'1',generation:'4'},children:[],contains:()=>true,querySelector:()=>null,querySelectorAll:()=>[form],getBoundingClientRect:()=>({top:10})};
 const body={querySelectorAll:()=>[row],querySelector:()=>row,get firstElementChild(){return row;}};
 const nextButton={disabled:false},nextWarning={},nextContent={contains:()=>true,querySelector:s=>s==='form'?form:({dataset:{nextId:'1',nextGeneration:'4'}}),querySelectorAll:()=>[nextButton]};
 const dialogButton={disabled:false},dialogWarning={},dialog={open:true,dataset:{taskId:'1',generation:'4',choice:'Decline'},querySelector:()=>dialogWarning,querySelectorAll:()=>[dialogButton]};
 ui.root.querySelector=s=>({'[data-my-work-table]':body,'[data-my-work-dialog]':dialog,'[data-my-next-content]':nextContent,'[data-my-next-warning]':nextWarning}[s]);
 ui.context.document.createElement=()=>({content:{firstElementChild:{children:[]}}});
 ui.run('patchMyWorkRows()');assert.equal(start.disabled,false);assert.equal(nextButton.disabled,false);assert.equal(dialogButton.disabled,false);
 for(const change of ["task.assignment_generation=5","task.assignee_id=2","task.attention=true","task.completed_at='2026-09-29'","task.canAct=false","task.lines[0].reports=[{status:'review'}]","online=false"]){
  ui.run("task.assignment_generation=4;task.assignee_id=1;task.attention=false;task.completed_at=null;task.canAct=true;task.lines[0].reports=[];online=true");ui.run(change);ui.run('patchMyWorkRows()');
  assert.equal(start.disabled,true,change);assert.equal(nextButton.disabled,true,change);assert.match(feedback.textContent,/View its details/);assert.equal(row.dataset.generation,'4');
  if(change.includes('generation')||change.includes('assignee')||change.includes('completed')||change.includes('online'))assert.equal(dialogButton.disabled,true,change);
 }
});

test('Assign Work is a single open form with eight-hour default, actual-direction permissions and all account choices',()=>{
 for(const direction of ['pick','put']){
  const ui=view({role:'custom'});ui.run(`snapshot.capabilities={view:true,assign:true,${direction}:true};snapshot.products=[{id:1,name:'Boots',sku:'B1',unit_of_measure:'pairs'}];snapshot.operators=[{id:1,name:'Admin',username:'admin',role_name:'Admin',assignedTaskCount:2,eligible:true,status:'active'},{id:2,name:'Custom',username:'custom',role_name:'Warehouse lead',assignedTaskCount:1,eligible:true,status:'active'},{id:3,name:'Reader',username:'reader',eligible:false,status:'active'},{id:4,name:'Inactive',username:'inactive',eligible:false,status:'inactive'}];path='/work/overview';render()`);
  const html=ui.root.innerHTML;assert.doesNotMatch(html,/aria-label="Work views"/);assert.match(html,/data-work-action="assign"/);assert.match(html,new RegExp('value="'+direction+'" checked'));assert.match(html,new RegExp('value="'+(direction==='pick'?'put':'pick')+'"  disabled'));assert.match(html,/name="dueDuration"[^>]+value="8"/);assert.match(html,/value="hours" selected/);assert.match(html,/value="days">Days/);assert.match(html,/value="3" disabled>Reader · reader · User · 0 assigned tasks — Cannot take tasks/);assert.match(html,/value="4" disabled>Inactive · inactive · User · 0 assigned tasks — Inactive/);assert.match(html,/>Assigned to<select/);assert.match(html,/Admin · admin · Admin · 2 assigned tasks/);assert.match(html,/Custom · custom · Warehouse lead · 1 assigned task</);assert.match(html,/>Assign Task</);
  assert.doesNotMatch(html,/data-task-table|Team task status|Workloads|productSearch|operatorSearch|name="dueAt"|name="note"|work-toolbar|work-footer/);
  ui.run("outbox=[{partition:key(),action:'assign',state:'error',input:{}}]");assert.match(ui.run('assignmentPage()'),/<button disabled>Waiting for warehouse confirmation/);
  ui.run('outbox=[];snapshot.products=[]');assert.match(ui.run('assignmentPage()'),/No active products available/);
  ui.run("snapshot.products=[{id:1}];snapshot.operators=[]");assert.match(ui.run('assignmentPage()'),/No users are eligible/);
 }
 const ui=view();ui.run('render()');assert.doesNotMatch(ui.root.innerHTML,/>Assign Work</);
 ui.run("snapshot.capabilities={timing:true};snapshot.timing={enabled:true,minutes:120,inactivityMinutes:15}");assert.match(ui.run('timingPage()'),/Assign Work uses the duration chosen on its form/);assert.match(ui.run('timingPage()'),/Missing updates during work/);
 ui.run("snapshot.capabilities={view:true,teamView:true};path='/work/history';location.search='?scope=team';render()");assert.match(ui.root.innerHTML,/Team history|Workloads by person/);assert.match(ui.root.innerHTML,/name="scope" value="team"/);assert.doesNotMatch(ui.root.innerHTML,/data-work-action="assign"/);
});

test('assignment controls match duration bounds and lock unknown outcomes without disabling the permitted direction',()=>{
 const ui=view();ui.run("snapshot.capabilities={assign:true,pick:true};snapshot.products=[{id:1}];snapshot.operators=[{eligible:true}]");
 const button={},radios=[{value:'pick'},{value:'put'}],f={dataset:{workAction:'assign'},elements:{dueUnit:{value:'hours'},dueDuration:{},direction:{value:'pick'}},querySelectorAll:()=>radios,querySelector:()=>button};ui.context.f=f;
 ui.run('updateAssignmentForm(f)');assert.equal(button.disabled,false);assert.equal(radios[0].disabled,false);assert.equal(radios[1].disabled,true);assert.equal(f.elements.dueDuration.max,8760);assert.equal(Number(f.elements.dueDuration.min)*60,1);
 for(const [unit,max,factor] of [['minutes',525600,1],['days',365,1440]]){f.elements.dueUnit.value=unit;ui.run('updateAssignmentForm(f)');assert.equal(f.elements.dueDuration.max,max);assert.equal(Number(f.elements.dueDuration.min)*factor,1);}
 ui.run("outbox=[{partition:key(),action:'assign',state:'sending'}];updateAssignmentForm(f)");assert.equal(button.disabled,true);assert.equal(button.textContent,'Waiting for warehouse confirmation');
 ui.run("outbox=[{partition:key(),action:'create',input:{assigneeId:2},state:'error'}];updateAssignmentForm(f)");assert.equal(button.disabled,true);
 ui.run("outbox=[];online=false;updateAssignmentForm(f)");assert.equal(button.disabled,true);
});

test('successful assignment uses durable plan delivery, stays on the form, and clears its draft only on acceptance',async()=>{
 const ui=view();ui.root.querySelector=()=>null;ui.context.calls=[];ui.context.saved=new Map();
 ui.context.fetch=async(url,init)=>{ui.context.calls.push(JSON.parse(init.body));return {ok:true,json:async()=>({status:'reserved',taskId:77,message:'Task assigned to Alex.'})};};
 ui.run("path='/work/overview';snapshot.dataset='d';store=async(name,mode,fn)=>fn({put:o=>saved.set(o.id,structuredClone(o)),delete:id=>saved.delete(id),getAll:()=>[...saved.values()]});refresh=async()=>{};render=()=>{};");
 ui.context.structuredClone=structuredClone;ui.context.AbortSignal=AbortSignal;
 await ui.run("submitPlan('assign',{direction:'pick',productId:1,quantity:2,assigneeId:2,dueDuration:8,dueUnit:'hours'},'draft')");
 assert.equal(ui.context.calls.length,1);assert.equal(ui.context.location.href,undefined);assert.equal(ui.run('notice'),'Task assigned to Alex.');assert.equal(ui.context.calls[0].dueDuration,8);
 ui.context.fetch=async()=>{throw new Error('Connection lost');};
 await assert.rejects(ui.run("submitPlan('assign',{direction:'pick',productId:1,quantity:2,assigneeId:2},'draft')"),/Connection lost/);
 const calls=ui.context.saved.size;await assert.rejects(ui.run("submitPlan('assign',{direction:'pick',productId:1,quantity:2,assigneeId:2},'draft')"),/waiting for confirmation/);assert.equal(ui.context.saved.size,calls);
});
test('pre-arrival light status refreshes while the operator keeps focus and a draft, without implying arrival or actual movement',()=>{
 const ui=view({active:true});ui.context.line={...line,guidance:{state:'sent',message:'Quantity guidance sent — check its label on arrival.'}};let html=ui.run('lineCard(line)');assert.match(html,/data-guidance-line="1"/);assert.match(html,/Quantity guidance sent/);assert.match(html,/I'm at this location/);assert.doesNotMatch(html,/Finish pick at this cell/);
 const hint={dataset:{guidanceLine:'1'},textContent:'old sent'},draft={value:'Keep my note'},focused=draft;ui.context.document.activeElement=focused;ui.root.querySelectorAll=s=>s==='[data-guidance-line]'?[hint]:[];
 ui.run("snapshot.tasks=[{id:1,lines:[{...line,guidance:{state:'waiting',message:'Light waiting — another operator is at this cell.'}}]}];patchGuidanceHints()");assert.match(hint.textContent,/Light waiting/);assert.equal(draft.value,'Keep my note');assert.equal(ui.context.document.activeElement,focused);
 ui.run('online=false;patchGuidanceHints()');assert.match(hint.textContent,/Offline/);ui.run("online=true;snapshot.tasks[0].lines[0].guidance={state:'shared',message:'Shared locator sent — use your own quantity.'};patchGuidanceHints()");assert.match(hint.textContent,/Shared locator/);
 ui.run("snapshot.tasks[0].lines[0].execution_state='settled';patchGuidanceHints()");assert.doesNotMatch(hint.textContent,/sent/);assert.equal(draft.value,'Keep my note');
});

test('returned work has per-task actions, retained completed cells, remaining defaults, and opt-in deadline changes',()=>{
 const ui=view({role:'admin'});ui.context.task={id:65,type:'pick',requested_quantity:5,recorded_quantity:2,remaining_quantity:3,assignment_state:'returned',assignment_generation:4,progress_token:'version-a',return_event:{id:8,previous_name:'Original operator',reason:'Busy',note:'Shift ended'},lines:[{...line,execution_state:'settled',actual_quantity:2,attribution:{performer:'Original operator'}}]};ui.run('snapshot.returnedTasks=[task];snapshot.returnedPage={total:1,number:1,pages:1};snapshot.operators=[{id:2,name:"Receiver",username:"receiver",eligible:true}];');
 const table=ui.run('returnedTable()');assert.match(table,/<table/);assert.match(table,/data-work-action="acknowledgeReturn"/);assert.match(table,/data-update-returned="65"/);assert.match(table,/Shift ended/);
 const dialog=ui.run('returnedDialogContent(task)');assert.match(dialog,/Completed movements/);assert.match(dialog,/Original operator/);assert.match(dialog,/name="remainingQuantity"[^>]+value="3"/);assert.match(dialog,/name="progressToken" value="version-a"/);assert.match(dialog,/name="dueAt"[^>]+disabled/);assert.doesNotMatch(dialog,/href="\/work\/overview/);
});
test('task return remains visible for self and needs-review work; location subtitle removes repeated code',()=>{
 const ui=view({active:true});ui.context.task={id:65,assignee_id:1,assignment_source:'self',assignment_state:'started',assignment_generation:2,attention:1,remaining_quantity:3,lines:[line]};assert.match(ui.run('assignmentActions(task)'),/Review/);assert.match(ui.run('stopDialogContent(task)'),/Hand back for reassignment/);assert.match(ui.run('returnDialogContent(task)'),/Send back for reassignment/);
 ui.context.line={...line,logical_code:'Z1-R1-C01',directions:{directions:'Z1-R1-C01, Shed A, Shelf 2'}};const html=ui.run('lineCard(line)');assert.match(html,/>Go to Z1-R1-C01<\/h2>/);assert.match(html,/<p class="cell-code">Shed A, Shelf 2<\/p>/);ui.context.line.directions.directions='Z1-R1-C01';assert.doesNotMatch(ui.run('lineCard(line)'),/class="cell-code"/);
});
test('review assignment offers responsibility transfer and recipient observation without movement instructions',()=>{
 const ui=view({role:'admin'});ui.context.task={id:65,type:'pick',assignee_id:1,attention:1,review_followup:1,recorded_quantity:0,remaining_quantity:3,lines:[{...line,review_followup:1,canAct:false,reports:[{id:'case',status:'review'}]}]};ui.run('snapshot.operators=[]');const dialog=ui.run('returnedDialogContent(task)');assert.match(dialog,/data-work-action="assignReview"/);assert.doesNotMatch(dialog,/name="remainingQuantity"/);assert.match(dialog,/reportId=case/);const panel=ui.run('checkDialogContent(task)');assert.match(panel,/data-review-align/);assert.doesNotMatch(panel,/data-work-action="observeReview"/);const cell=ui.run('lineCard(task.lines[0])');assert.match(cell,/>Check A3<\/h2>/);assert.match(cell,/originally planned/);assert.doesNotMatch(cell,/Start the assignment|data-work-action="acquire"|Finish pick/);
});
test('live returned dialog detects changed progress without replacing focused draft or version',()=>{
 const ui=view({role:'admin'}),warning={hidden:true,textContent:''},button={disabled:false},dialog={open:true,dataset:{taskId:'65',generation:'2',progressToken:'old',mode:'update'},querySelector:()=>warning,querySelectorAll:()=>[button]};
 ui.root.querySelector=selector=>selector==='[data-task-dialog]'?dialog:null;ui.run("snapshot.returnedTasks=[{id:65,assignment_generation:2,assignment_state:'returned',progress_token:'new',lines:[]}]");ui.run('patchTaskDialog()');assert.equal(button.disabled,true);assert.equal(warning.hidden,false);assert.match(warning.textContent,/draft is kept/);assert.equal(dialog.dataset.progressToken,'old');
});

test('older review task dialog lookup is bounded and refuses account or warehouse mixing',async()=>{
 const ui=view({role:'admin'});let called;ui.context.AbortSignal={timeout:ms=>({timeout:ms})};ui.context.fetch=async(url,options)=>{called={url,options};return {ok:true,json:async()=>({user:{id:1},site:'warehouse-a',tasks:[{id:101}]})};};assert.equal((await ui.run('fetchDialogTask(101)')).id,101);assert.match(called.url,/taskId=101/);assert.equal(called.options.signal.timeout,15000);
 for(const fresh of [{user:{id:2},site:'warehouse-a',tasks:[{id:101}]},{user:{id:1},site:'other',tasks:[{id:101}]},{user:{id:1},site:'warehouse-a',dataset:'changed',tasks:[{id:101}]}]){ui.context.fetch=async()=>({ok:true,json:async()=>fresh});await assert.rejects(ui.run('fetchDialogTask(101)'),/account, warehouse or dataset changed/);}
 ui.context.fetch=async()=>({ok:true,json:async()=>({user:{id:1},site:'warehouse-a',tasks:[]})});await assert.rejects(ui.run('fetchDialogTask(101)'),/no longer available/);assert.equal(ui.run('snapshot.watchedTasks[0].id'),101);assert.equal(ui.run('snapshot.tasks.length'),0);
});

test('blocked Go-to heading changes live without replacing a focused manual draft',()=>{
 const ui=view({active:true}),heading={textContent:'Go to A3'},button={disabled:false},draft={value:'Existing physical note'},card={dataset:{line:'1',lightRevision:'2',lightGeneration:'3',lightBinding:'4'},querySelector:()=>heading,querySelectorAll:()=>[button]};ui.context.document.activeElement=draft;ui.root.querySelectorAll=s=>s==='[data-line][data-light-revision]'?[card]:[];ui.context.current={...line,current_generation:3,binding_revision:4,canAct:true};ui.run('snapshot.tasks[0].lines=[current];patchGuidanceHints()');assert.equal(heading.textContent,'Go to A3');assert.equal(button.disabled,false);
 ui.run("current.reports=[{status:'review'}];patchGuidanceHints()");assert.equal(heading.textContent,'Check A3');assert.equal(button.disabled,true);assert.equal(draft.value,'Existing physical note');assert.equal(ui.context.document.activeElement,draft);
 ui.run('current.reports=[];current.canAct=false;patchGuidanceHints()');assert.equal(heading.textContent,'Location A3');ui.run('current.revision=9;patchGuidanceHints()');assert.equal(heading.textContent,'Location instructions changed');
});

test('passive task details offer Resume with collapsed recovery and no arrival or Refresh light controls',()=>{
 const task={id:1,type:'pick',assignment_generation:1,assignee_id:1,assignment_state:'started',progress_token:'fresh',lines:[line]},ui=view({tasks:[task]});
 ui.context.task=task;ui.run("path='/tasks/1'");const passive=ui.run('taskPage(1)');assert.match(passive,/Task details/);assert.match(passive,/data-work-action="resume"/);assert.match(passive,/Location A3/);assert.doesNotMatch(passive,/I'm at this location|data-refresh-light|Go to A3/);assert.match(passive,/data-record-moved="1"/);
 ui.run('activeWork={taskId:1,generation:1,identity:key(),dataset:snapshot.dataset}');const active=ui.run('taskPage(1)');assert.match(active,/data-task-cells/);assert.match(active,/Go to A3/);assert.match(active,/I'm at this location/);assert.doesNotMatch(active,/data-work-action="resume"/);
 ui.run("activeWork=null;task.assignment_state='offered'");const offered=ui.run('taskPage(1)');assert.match(offered,/data-work-action="start"/);assert.doesNotMatch(offered,/I'm at this location|data-refresh-light/);
});

test('task context carries return/check people and times, and assignment editor chooses the safe state-specific action',()=>{
 const ui=view({role:'admin'}),t={id:66,type:'pick',assignee_id:null,assignment_state:'returned',assignment_generation:3,progress_token:'now',requested_quantity:5,recorded_quantity:2,remaining_quantity:3,return_event:{id:9,previous_name:'Sam',created_at:'2026-09-29T10:00:00Z',reason:'Shift ended',note:'Two moved'},assigned_by_name:'Alex',assigned_at:'2026-09-28T10:00:00Z',lines:[{...line,execution_state:'superseded'},{...line,id:2,execution_state:'settled',attribution:{performer:'Sam',reporter:'Alex'}}]};ui.context.t=t;ui.run('snapshot.tasks=[t];snapshot.operators=[{id:1,name:"Alex",username:"alex",eligible:true},{id:2,name:"Sam",username:"sam",eligible:false}]');let html=ui.run('taskPage(66)');for(const text of ['Returned by Sam','Shift ended · Two moved','<dt>Assigned by</dt><dd>Alex','Performed by Sam','Entered by Alex','Assign the remaining work'])assert.ok(html.includes(text),text);assert.match(html,/data-work-action="updateReturned"/);assert.match(html,/name="remainingQuantity" value="3"/);assert.match(html,/select data-searchable name="assigneeId"/);assert.doesNotMatch(html,/<option value="2"|data-work-action="start"|data-work-action="resume"/);
 ui.run("t.lines[0].execution_state='working';t.lines[0].reports=[{status:'review',performer_name:'Sam',reporter_name:'Alex',reason:'Count uncertain'}];t.attention=1");assert.match(ui.run('taskAssigneeEditor(t)'),/data-work-action="assignReview"/);assert.doesNotMatch(ui.run('taskAssigneeEditor(t)'),/remainingQuantity/);ui.run("t.lines[0].reports=[];t.attention=0;t.assignment_state='started'");assert.doesNotMatch(ui.run('taskAssigneeEditor(t)'),/<form/);
});
test('own and team review entry never executes physical work; verified followup can explicitly plan remaining work',()=>{
 const ui=view({role:'admin'});ui.context.t={id:66,assignee_id:1,assignment_state:'started',assignment_generation:1,attention:1,remaining_quantity:3,lines:[{...line,reports:[{status:'review'}]}]};ui.run('snapshot.tasks=[t]');for(const transferred of [0,1]){ui.run(`t.review_followup=${transferred}`);assert.match(ui.run('taskPage(66)'),/data-task-check="66"/);assert.doesNotMatch(ui.run('taskPage(66)'),/data-work-action="observeReview"|data-work-action="resume"/);assert.match(ui.run('checkDialogContent(t)'),/data-review-align/);assert.doesNotMatch(ui.run('checkDialogContent(t)'),/data-work-action="acquire"|data-refresh-guidance/);}
 ui.run('t.attention=0;t.lines[0].reports=[];t.review_handover_verified=1');assert.equal(ui.run('myTaskActionable(t)'),false);assert.match(ui.run('checkDialogContent(t)'),/data-work-action="resumeFollowup"/);ui.run('t.assignee_id=2');assert.match(ui.run('taskPage(66)'),/data-task-check/);assert.doesNotMatch(ui.run('taskPage(66)'),/data-work-action="resume"|data-work-action="start"/);
});

test('My Work and returned tables link products separately from tasks and respect product rights',()=>{
 const ui=view({role:'admin'});ui.context.t={id:66,type:'pick',assignee_id:1,assignment_state:'started',review_followup:1,attention:1,lines:[line]};for(const fn of ['myTaskRow','returnedRow']){let html=ui.run(fn+'(t)');assert.match(html,/href="\/products\/1"/);assert.match(html,/href="\/tasks\/66"[^>]*>#66 · Pick/);assert.doesNotMatch(html,/View check/);}ui.run('snapshot.capabilities={view:true,execute:true,productsView:false}');assert.doesNotMatch(ui.run('myTaskRow(t)'),/href="\/products/);assert.match(ui.run('home()'),/colspan="12"/);
});
test('recovery is a dialog-only form and its instruction generation and dataset belong in the draft identity',()=>{
 const ui=view();ui.context.l=line;assert.doesNotMatch(ui.run('lineCard(l)'),/data-work-action="report"/);const content=ui.run('recoveryDialogContent(l)');assert.match(content,/Actual quantity \(pieces\)/);assert.match(content,/Actual location/);assert.match(content,/What happened/);assert.match(content,/name="assignmentGeneration" value="1"/);
 ui.context.f={dataset:{workAction:'report',draftKind:'difference'},elements:{lineId:{value:'1'},revision:{value:'2'},assignmentGeneration:{value:'1'}}};const original=ui.run('draftKey(f)');ui.run("snapshot.dataset='restored'");assert.notEqual(ui.run('draftKey(f)'),original);ui.run("snapshot.dataset=undefined;f.elements.assignmentGeneration.value='2'");assert.notEqual(ui.run('draftKey(f)'),original);ui.run("f._workIdentity={site:snapshot.site,dataset:'original',actorId:1};f._draftPath='/tasks/66'");const frozen=ui.run('draftKey(f)');ui.run("snapshot.user.id=2;snapshot.dataset='other'");assert.equal(ui.run('draftKey(f)'),frozen);
});

test('Review keeps IST metadata and separates physical totals from a permission-aware assignment step',()=>{
 const ui=view({role:'admin'});ui.context.task={id:66,type:'pick',assignee_id:1,assignee_name:'Alex',assigned_by_name:'Morgan',assigned_at:'2026-09-30T08:00:00Z',assignment_generation:3,progress_token:'p',outcome:'needs_review',review_followup:1,requested_quantity:5,recorded_quantity:2,remaining_quantity:3,due_at:'2026-10-01T10:00:00Z',lines:[{...line,reports:[{status:'review',quantity:2}]}]};
 ui.run("snapshot.timing={timezone:'UTC'};snapshot.operators=[{id:1,name:'Alex',username:'alex',eligible:true},{id:2,name:'Sam',username:'sam',eligible:true},{id:3,name:'Inactive',eligible:true,status:'inactive'}]");
 const html=ui.run('checkDialogContent(task)');for(const label of ['Task','Assigned to','Assigned by','Assigned time','Product name','Quantity','Completed','Remaining','Progress','Deadline'])assert.match(html,new RegExp('<th scope="row">'+label+'</th>'));assert.match(html,/Asia\/Kolkata · IST/);assert.match(ui.run('checkTime(task.assigned_at)'),/1:30.*IST/);assert.match(html,/data-task-dialog-close>← Back/);assert.match(html,/Align With Actual Physical Movement/);assert.match(html,/Update Assignment of the task/);assert.doesNotMatch(html,/New operator|data-work-action="observeReview"|data-actual-editor/);
 const assignment=ui.run('reviewAssignmentContent(task)');assert.match(assignment,/data-review-back>← Back/);assert.match(assignment,/data-work-action="updateReviewTask"/);assert.equal((assignment.match(/data-searchable name="assigneeId"/g)||[]).length,1);assert.match(assignment,/value="1" selected>Alex/);assert.match(assignment,/name="remainingQuantity"[^>]*value="3"/);assert.match(assignment,/Keep current deadline/);assert.match(assignment,/Set duration from now/);assert.match(assignment,/Save and Assign task/);assert.doesNotMatch(assignment,/>Inactive|name="dueAt"|name="changeDue"/);
 ui.run("snapshot.user.role='operator'");assert.match(ui.run('checkDialogContent(task)'),/data-review-assignment disabled/);assert.equal(ui.run('canCloseReview(task)'),false);
});

test('check assignment remains locked for blank/current selection and revoked/stale authority across watched task lookup',()=>{
 const ui=view({role:'admin'});ui.context.task={id:66,type:'pick',assignee_id:1,assignment_generation:3,progress_token:'p',review_followup:1,lines:[{reports:[{status:'review'}]}]};ui.run('snapshot.tasks=[];snapshot.watchedTasks=[task]');
 const assign={disabled:false,closest:()=>form},observe={disabled:false,closest:()=>null},warning={},stop={disabled:false};
 const dialog={open:true,dataset:{taskId:'66',generation:'3',progressToken:'p',mode:'check'},querySelector:()=>warning,querySelectorAll:s=>s.includes('form button')?[assign,observe]:s==='[data-check-stop]'?[stop]:[]};
 const form={dataset:{workAction:'assignReview'},elements:{taskId:{value:'66'},generation:{value:'3'},progressToken:{value:'p'},assigneeId:{value:''}},closest:()=>dialog,querySelectorAll:()=>[assign]};ui.root.querySelector=()=>dialog;ui.root.querySelectorAll=s=>s==='[data-task-assignee]'?[form]:[];
 ui.run('patchTaskDialog()');assert.equal(assign.disabled,true);assert.equal(observe.disabled,false);form.elements.assigneeId.value='1';ui.run('patchTaskDialog()');assert.equal(assign.disabled,true);form.elements.assigneeId.value='2';ui.run('patchTaskDialog()');assert.equal(assign.disabled,false);
 ui.run("snapshot.capabilities={execute:true,assign:false}");ui.run('patchTaskDialog()');assert.equal(assign.disabled,true);assert.equal(form.elements.assigneeId.disabled,true);
 ui.run("snapshot.capabilities={execute:true,assign:true};task.assignee_id=2;task.assignment_generation=4");ui.run('patchTaskDialog()');assert.equal(assign.disabled,true);assert.equal(observe.disabled,true);assert.equal(stop.disabled,true);assert.equal(warning.hidden,false);assert.equal(form.elements.generation.value,'3');
});

test('task changes cannot discard a typed check observation, including zero quantity',()=>{
 const ui=view(),observation={elements:{quantity:{value:'0'},note:{value:''}}};const dialog={dataset:{mode:'check'},querySelectorAll:()=>[observation]};ui.context.form={dataset:{workAction:'stop'},closest:()=>dialog};
 assert.throws(()=>ui.run('requireSavedCheckObservation(form)'),/Save your observation first/);ui.context.form.dataset.workAction='assignReview';assert.throws(()=>ui.run('requireSavedCheckObservation(form)'),/Save your observation first/);observation.elements.quantity.value='';observation.elements.note.value='Spoke to Sam';assert.throws(()=>ui.run('requireSavedCheckObservation(form)'),/Save your observation first/);observation.elements.note.value='';assert.doesNotThrow(()=>ui.run('requireSavedCheckObservation(form)'));ui.context.form.dataset.workAction='observeReview';observation.elements.note.value='Checked';assert.doesNotThrow(()=>ui.run('requireSavedCheckObservation(form)'));
});

test('movement step uses final totals and explicit verifier attestation, while terminal late evidence stays immutable',()=>{
 const ui=view({role:'admin'});ui.context.task={id:66,type:'pick',assignee_id:2,assignment_generation:3,progress_token:'p',closure_token:'c',review_followup:1,requested_quantity:5,recorded_quantity:2,remaining_quantity:3,lines:[{...line,actual_quantity:2,execution_state:'settled',reports:[{id:'late',status:'review'}]}]};ui.run('snapshot.cells=[{id:3,logical_code:"A3"}]');
 let html=ui.run('reviewMovementContent(task)');for(const label of ['Actual location','Actual quantity','Unit','Remove'])assert.match(html,new RegExp('>'+label+'</th>'));assert.match(html,/final total movement for this task/);assert.match(html,/name="workerStopped"/);assert.match(html,/Accept movement and close task/);assert.doesNotMatch(html,/How was this verified|name="verification"|checked/);
 ui.run("task.completed_at='2026-09-30';task.closed_actuals=true;task.outcome='stopped'");assert.equal(ui.run('canCheckTask(task)'),true);assert.equal(ui.run('canCloseReview(task)'),false);assert.equal(ui.run('myWorkState(task)'),'review');html=ui.run('reviewMovementContent(task)');assert.match(html,/Review late evidence/);assert.doesNotMatch(html,/data-work-action="closeTask"|data-work-action="resolve"/);assert.match(ui.run('checkDialogContent(task)'),/data-review-assignment disabled/);
});

test('Stop uses final per-location totals with no preselected answer or legacy bypass, while quantity stays beside its unit',()=>{
 const ui=view();ui.context.task={id:90,type:'pick',assignee_id:1,assignment_generation:2,progress_token:'p',closure_token:'c',requested_quantity:10,recorded_quantity:4,remaining_quantity:6,lines:[{...line,cell_id:3,execution_state:'settled',actual_quantity:4},{...line,id:8,cell_id:4,execution_state:'ready',planned_quantity:6,actual_quantity:0}]};ui.run("snapshot.tasks=[task];snapshot.cells=[{id:3,logical_code:'A3'},{id:4,logical_code:'A4'}]");
 const html=ui.run('stopDialogContent(task)');assert.match(html,/Are you sure you want to terminate this task with the current status shown above\?/);assert.match(html,/name="currentStatus" value="yes" required>Yes/);assert.match(html,/name="currentStatus" value="no" required>No/);assert.doesNotMatch(html,/<input[^>]*checked|Confirm stop|data-work-action="stop"/);assert.match(html,/data-close-task[^>]*>Close task/);assert.match(html,/data-send-task-review>Send for review/);assert.match(html,/actualQuantity0[^>]*value="4"><\/td><td class="actual-unit">pieces/);assert.match(html,/actualQuantity1[^>]*value="0"><\/td><td class="actual-unit">pieces/);assert.match(html,/data-add-actual/);assert.match(html,/data-remove-actual/);assert.match(html,/data-searchable name="actualCell0"/);assert.doesNotMatch(ui.run('taskRow(task)'),/data-work-action="stop"/);
});
test('review and failed planning never show the removed saved-update banner; unsent movement has connection recovery',()=>{
 const ui=view({role:'admin'});ui.context.entry={id:'receipt',partition:'warehouse-a:1',action:'sendTaskReview',input:{taskId:90},state:'review',message:'Sent for review'};ui.run('snapshot.pending=[];outbox=[entry];render()');let html=ui.root.innerHTML;assert.doesNotMatch(html,/Saved updates &|need attention or review|data-show-saved/);
 ui.run("entry.state='error';entry.message='Not confirmed';online=false;render()");html=ui.root.innerHTML;assert.match(html,/data-connection-status/);assert.doesNotMatch(html,/Saved updates &|need warehouse confirmation/);assert.match(html,/Offline: saved work/);
 const recovery=ui.run("operationContent({stage:'connection'})");assert.match(recovery,/Not confirmed/);assert.match(recovery,/data-retry/);assert.match(recovery,/data-operation-back/);
});
test('pending aggregate closure uses its case version and shared final totals rather than a new closure command',()=>{
 const ui=view({role:'admin'});ui.context.task={id:90,assignee_id:1,attention:1,closure_review_id:'case',closure_case_revision:4,closure_actuals:[{cellId:3,quantity:4}],lines:[{...line,reports:[{id:'case',status:'review',quantity:4}]}]};ui.run("snapshot.cells=[{id:3,logical_code:'A3'}]");const html=ui.run('reviewMovementContent(task)');assert.match(html,/data-work-action="resolve"/);assert.match(html,/name="caseRevision" value="4"/);assert.match(html,/name="actualQuantity0"[^>]*value="4"/);assert.doesNotMatch(html,/data-work-action="observeReview"|data-work-action="closeTask"/);
});

test('team closure and aggregate review share the actuals table and unchecked attestation without a verification question',()=>{
 const ui=view({role:'admin'});ui.context.task={id:90,type:'pick',assignee_id:2,assignment_generation:2,progress_token:'p',closure_token:'c',lines:[{...line,actual_quantity:4,execution_state:'settled'}]};ui.run("snapshot.cells=[{id:3,logical_code:'A3'}]");
 for(const html of [ui.run('closureForm(task)'),ui.run("closureReview({id:'case',case_revision:1,closureTask:task,closureActuals:[{cellId:3,quantity:4}]})")]){
  assert.match(html,/<table class="task-actual-table" aria-label="Final actual movements">/);
  assert.match(html,/<th scope="col">Actual location<\/th><th scope="col">Actual quantity<\/th><th scope="col">Unit<\/th><th scope="col">Remove<\/th>/);
  assert.match(html,/<tbody data-actual-rows><tr class="task-actual-row" data-actual-row>/);
  assert.equal((html.match(/data-searchable name="actualCell0"/g)||[]).length,1);
  assert.match(html,/<input type="checkbox" name="workerStopped">I confirmed all workers have stopped and verified the actual totals/);
  assert.doesNotMatch(html,/How were (all )?final totals verified|name="verification"[^>]*required|name="workerStopped"[^>]*(checked|required)/);
 }
});

test('restored actual rows are authoritative after removing the first row with older indexed draft fields',()=>{
 const ui=view();ui.context.task={id:90,lines:[line]};const rebuilt=[];
 const elements=[{name:'actualCell0',value:'4'},{name:'actualQuantity0',value:'7'},{name:'actualCell1',value:'5'},{name:'actualQuantity1',value:'9'}];elements.taskId={value:'90'};
 const body={set innerHTML(html){rebuilt.push(html);}},f={dataset:{workAction:'closeTask',draftKind:'task-closure'},elements,querySelector:()=>body};ui.context.form=f;ui.root.querySelectorAll=s=>s==='form[data-work-action]'?[f]:[];
 ui.run("snapshot.tasks=[task];snapshot.cells=[{id:4,logical_code:'B4'},{id:5,logical_code:'B5'}];drafts.set(draftKey(form),{_actuals:[{cellId:4,quantity:7},{cellId:5,quantity:9}],actualCell1:{value:'4'},actualQuantity1:{value:'7'},actualCell2:{value:'5'},actualQuantity2:{value:'9'}});restoreDrafts()");
 assert.equal(elements[2].value,'5');assert.equal(elements[3].value,'9');assert.match(rebuilt[0],/actualQuantity0[^>]*value="7"/);assert.match(rebuilt[0],/actualQuantity1[^>]*value="9"/);assert.equal((rebuilt[0].match(/<tr /g)||[]).length,2);
});

test('waiting guidance links only an explicitly permitted blocker, and the next free location is primary',()=>{
 const ui=view({active:true});ui.context.task={id:1,assignee_id:1,assignment_generation:1,assignment_state:'started',lines:[{...line,guidance:{state:'waiting',message:'Waiting for Sam · Task #41.',blocker:{kind:'task',taskId:41,name:'Sam'}}},{...line,id:2,cell_id:4,logical_code:'B4',guidance:{state:'sent',message:'Quantity guidance sent.'}}]};ui.run('snapshot.tasks=[task]');assert.doesNotMatch(ui.run('guidanceMarkup(task.lines[0])'),/<a/);ui.run("task.lines[0].guidance.blocker.href='/tasks/41'");assert.match(ui.run('guidanceMarkup(task.lines[0])'),/href="\/tasks\/41">Open task #41/);const html=ui.run('taskPage(1)');assert.match(html,/data-line="2"/);assert.doesNotMatch(html,/data-line="1"/);
});

test('inactivity alert asks for a check-in without declaring movement unknown or releasing a light',()=>{
 const ui=view({role:'admin'});ui.run("snapshot.inactivityAlerts=[{taskId:41,name:'Sam Patel'}]");const html=ui.run('inactivityAlertsMarkup()');assert.match(html,/No recent update from Sam Patel/);assert.match(html,/href="\/tasks\/41"/);assert.match(html,/remains reserved for active work/);assert.doesNotMatch(html,/quantity is unknown|light released/);
});

test('initial render and live refresh keep arrival and light refresh disabled while waiting or blocked',()=>{
 const ui=view({active:true}),refresh={disabled:false},arrival={disabled:false},card={dataset:{line:'1',lightRevision:'2',lightGeneration:'1',lightBinding:'1'},querySelector:()=>null,querySelectorAll:()=>[refresh,arrival]};ui.context.task={id:1,assignee_id:1,assignment_generation:1,lines:[{...line,binding_revision:1,canAct:true,guidance:{state:'waiting',message:'Waiting for Sam · Task #41.'}}]};ui.root.querySelectorAll=s=>s==='[data-line][data-light-revision]'?[card]:[];ui.run('snapshot.tasks=[task];render()');assert.match(ui.run('lineCard(task.lines[0])'),/Waiting for location/);assert.doesNotMatch(ui.run('lineCard(task.lines[0])'),/Ready to start/);assert.equal(refresh.disabled,true);assert.equal(arrival.disabled,true);
 ui.run("task.lines[0].guidance.state='sent';patchGuidanceHints()");assert.equal(refresh.disabled,false);assert.equal(arrival.disabled,false);ui.run("task.lines[0].guidance.state='blocked';render()");assert.equal(arrival.disabled,true);ui.run("task.lines[0].guidance.state='sent';online=false;patchGuidanceHints()");assert.equal(arrival.disabled,true);
});

test('deadline choice hides unused duration and switching units retains the entered number',()=>{
 const ui=view(),area={hidden:true},f={dataset:{workAction:'updateReviewTask'},elements:{deadlineChoice:{value:'keep'},duration:{value:'30',disabled:true,dataset:{}},timeUnit:{value:'minutes',disabled:true}},querySelector:()=>area};ui.context.f=f;
 ui.run('updateReturnedDue(f)');assert.equal(area.hidden,true);assert.equal(f.elements.duration.disabled,true);f.elements.deadlineChoice.value='duration';ui.run('updateReturnedDue(f);updateTimingFields(f,true)');assert.equal(area.hidden,false);assert.equal(f.elements.duration.disabled,false);assert.equal(f.elements.duration.value,'30');f.elements.deadlineChoice.value='none';ui.run('updateReturnedDue(f)');assert.equal(area.hidden,true);
});
test('unified rows retain server order and all permitted returned rows; sorting links preserve filters and reset the page',()=>{
 const ui=view({role:'admin'});ui.run("snapshot.tasks=[{id:4,assignee_id:null},{id:8,assignee_id:2},{id:2,assignee_id:1}];snapshot.taskPage={unified:true};location.search='?reviewOnly=1&productSearch=Bandage&remainingMin=2&sort=remaining&order=asc&page=2'");assert.equal(ui.run('myTasks().map(t=>t.id).join()'),'4,8,2');const header=ui.run("workColumn('remaining','Remaining')");assert.match(header,/aria-sort="ascending"/);assert.doesNotMatch(header,/remainingMin=2/);assert.match(header,/productSearch=Bandage/);assert.match(header,/order=desc/);assert.doesNotMatch(header,/page=2/);
});

test('History uses the work table, popup task links and role-scoped filters without execution controls or a Needs Review sub-tab',()=>{
 const ui=view({role:'admin'});ui.context.task={id:90,type:'pick',summary:'Boots',requested_quantity:5,recorded_quantity:2,remaining_quantity:3,assignee_id:1,assignment_state:'started',assignment_generation:1,outcome:'open',lines:[line]};
 ui.run("snapshot.tasks=[task];snapshot.taskPage={view:'history',number:1,pages:1,total:1,limit:50};path='/work/history';location.search='?scope=team';render()");
 assert.match(ui.root.innerHTML,/data-task-history="90"/);assert.match(ui.root.innerHTML,/class="my-work-table"/);assert.match(ui.root.innerHTML,/name="scope" value="team"/);assert.match(ui.root.innerHTML,/Items per page: 50/);
 assert.doesNotMatch(ui.root.innerHTML,/aria-label="Work views"|href="\/pending-confirmations"/);
 const row=ui.run('myTaskRow(task)');assert.doesNotMatch(row,/data-work-action|data-task-check|data-select-task/);
 assert.match(ui.run('taskHistoryContent(task)'),/data-task-dialog-close>← Back/);assert.doesNotMatch(ui.run('taskHistoryContent(task)'),/<form/);
 ui.context.timeline={entries:[{time:'2026-10-01T10:00:00Z',step:'Pick recorded',actor:'<script>',location:'A & B',quantity:-2,unit:'pairs',details:'<img onerror=alert(1)>'}],page:{number:1,pages:2,total:101}};
 const html=ui.run('timelineMarkup(timeline)');assert.match(html,/&lt;script&gt;/);assert.match(html,/A &amp; B/);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/IST/);assert.match(html,/data-history-page="2"/);
});

test('History shows assignee and a prefilled reopen form; hides recovery footer without changing My Work',()=>{
 const ui=view({role:'admin'});ui.context.task={id:90,type:'pick',summary:'Part',requested_quantity:5,recorded_quantity:2,remaining_quantity:3,assignee_id:2,previous_assignee_id:2,assignee_name:'Earlier worker',assignment_state:'stopped',assignment_generation:1,outcome:'stopped',completed_at:'2026-10-01T10:00:00Z',closed_actuals:true,lines:[{...line,execution_state:'settled'}]};
 ui.run("snapshot.tasks=[task];snapshot.operators=[{id:1,name:'Admin',username:'admin',eligible:true,status:'active'},{id:2,name:'Earlier worker',username:'worker',eligible:true,status:'active'}];path='/work/history';render()");
 assert.match(ui.root.innerHTML,/Assigned To/);assert.match(ui.root.innerHTML,/<td>Earlier worker<\/td>/);assert.match(ui.root.innerHTML,/data-task-reopen="90"/);assert.doesNotMatch(ui.root.innerHTML,/Saved updates &amp; device help|Saved updates & device help|data-disclosure="device-recovery"/);
 const popup=ui.run('reopenTaskContent(task)');assert.match(popup,/name="productId"[^>]*><option value="1" selected>Part/);assert.match(popup,/name="quantity"[^>]*value="3"/);assert.match(popup,/value="2" selected/);assert.match(popup,/name="assigneeId"/);assert.match(popup,/data-searchable/);assert.match(popup,/value="8"/);assert.match(popup,/Create a linked pick task/);assert.doesNotMatch(popup,/name="actualQuantity|name="actualCell/);
 ui.run('task.remaining_quantity=0');assert.match(ui.run('reopenTaskContent(task)'),/name="quantity"[^>]*value="0"/);assert.match(ui.run('reopenTaskContent(task)'),/Nothing remains/);
 ui.run('task.reopened_task_id=91');assert.doesNotMatch(ui.run('myTaskRow(task)'),/data-task-reopen/);assert.match(ui.run('myTaskRow(task)'),/Reopened as #91/);
 ui.run("path='/work'");assert.doesNotMatch(ui.run('workTableHead()'),/Assigned To/);assert.equal((ui.run('myTaskRow(task)').match(/<td[ >]/g)||[]).length,12);
 ui.run("path='/work/history';snapshot.user.role='operator';task.reopened_task_id=null");assert.doesNotMatch(ui.run('myTaskRow(task)'),/data-task-reopen/);
});

test('Work uses the sidebar without duplicate top tabs; offline shells keep a fallback',()=>{
 const ui=view({role:'admin'});ui.run('render()');
 assert.doesNotMatch(ui.root.innerHTML,/aria-label="Work views"|href="\/record-movement"[^>]*>Record Movement|href="\/recommended-actions"[^>]*>Recommended Actions/);
 ui.run('online=false;render()');assert.match(ui.root.innerHTML,/aria-label="Work views"/);assert.match(ui.root.innerHTML,/href="\/record-movement"[^>]*>Record Movement/);ui.run('online=true;render()');
 for(const href of ['/stocktaking','/labels','/work/timing','/movement-history','/work?reviewOnly=1'])assert.ok(!ui.run('workShortcuts()').includes(href));
 assert.doesNotMatch(ui.root.innerHTML,/data-disclosure="my-work-tools"/);
 ui.run("snapshot.capabilities={view:true,report:false};render()");assert.doesNotMatch(ui.root.innerHTML,/href="\/record-movement"/);
 ui.run("snapshot.capabilities={labels:true,locationsView:true};path='/labels';render()");assert.match(ui.root.innerHTML,/aria-label="Location views"/);assert.doesNotMatch(ui.root.innerHTML,/aria-label="Work views"/);
 ui.run("snapshot.capabilities={timing:true};snapshot.timing={minutes:480,inactivityMinutes:15};path='/work/timing';render()");assert.match(ui.root.innerHTML,/href="\/settings"/);assert.doesNotMatch(ui.root.innerHTML,/aria-label="Work views"/);
 ui.context.task={id:91,type:'put',requested_quantity:5,recorded_quantity:0,lines:[line],work_status:'Not started'};ui.run("path='/work'");
 const row=ui.run('myTaskRow(task)');assert.match(row,/badge badge-put">Put/);assert.match(row,/badge badge-not-started">Not started/);assert.match(ui.run('workTableHead()'),/>Type /);
});


test('Record Movement permits mixed rows with constrained Pick locations and all Put locations, and Task History retains snapshots',()=>{
 const ui=view({role:'admin'});ui.run("snapshot.products=[{id:1,name:'Boots',sku:'B1',unit_of_measure:'pairs'}];snapshot.cells=[{id:1,logical_code:'A'},{id:2,logical_code:'B'}];snapshot.contents=[{cell_id:1,product_id:1,available_quantity:3}]");
 const picks=ui.run("recordLocationOptions(1,'pick')"),puts=ui.run("recordLocationOptions(1,'put')");assert.match(picks,/>A</);assert.doesNotMatch(picks,/>B</);assert.match(puts,/>A</);assert.match(puts,/>B</);
 assert.match(ui.run("recordRow({direction:'put',cellId:2,quantity:3},1,1)"),/aria-label="Location, row 2"/);
 ui.run("path='/record-movement';render()");assert.match(ui.root.innerHTML,/data-add-record/);assert.match(ui.root.innerHTML,/data-record-movement/);assert.match(ui.root.innerHTML,/These items have already been moved/);assert.doesNotMatch(ui.root.innerHTML,/supervisor will check/);
 ui.context.entry={taskId:5,time:'2026-10-01T10:00:00Z',step:'Pick recorded',product:'Boots',quantity:-2,unit:'pairs',before:5,after:3,assignedBy:'Admin',assignedTo:'Worker',actor:'Worker',inventoryMovement:true};
 const html=ui.run('activityTable([entry])');assert.match(html,/Details before/);assert.match(html,/Details after/);assert.match(html,/>5 pairs</);assert.match(html,/>3 pairs</);assert.match(html,/taskId=5/);
 ui.context.entry.before=null;assert.match(ui.run('activityTable([entry])'),/Not recorded/);
});


test('My Work task links open the permission-scoped editor while History retains its history popup',()=>{
 const ui=view({role:'admin'});ui.context.t={id:91,type:'put',assignee_id:1,assignee_name:'Alex',assignment_generation:3,progress_token:'latest',assignment_state:'offered',requested_quantity:10,recorded_quantity:2,remaining_quantity:8,plan_cell_id:4,lines:[line]};
 ui.run("snapshot.cells=[{id:4,logical_code:'Shelf B'}];snapshot.operators=[{id:1,name:'Alex',status:'active',eligible:true}]");
 assert.match(ui.run('myTaskRow(t)'),/data-task-edit="91"/);assert.doesNotMatch(ui.run('myTaskRow(t)'),/data-task-history=/);
 const html=ui.run('taskEditorContent(t)');assert.match(html,/data-work-action="updateReviewTask"/);assert.match(html,/name="progressToken" value="latest"/);assert.match(html,/name="remainingQuantity"[^>]*value="8"/);assert.match(html,/name="assigneeId"[^>]*>[\s\S]*value="1" selected/);assert.match(html,/Preferred location<select data-searchable name="planCellId"/);assert.match(html,/value="4" selected>Shelf B/);assert.match(html,/name="deadlineChoice"/);assert.match(html,/data-task-history="91">Task history/);assert.doesNotMatch(html,/data-task-timeline|data-review-align|data-review-discard/);
 ui.run("path='/work/history'");assert.match(ui.run('myTaskRow(t)'),/data-task-history="91"/);assert.doesNotMatch(ui.run('myTaskRow(t)'),/data-task-edit=/);
 ui.run("snapshot.capabilities={view:true}");assert.doesNotMatch(ui.run('taskEditorContent(t)'),/data-work-action="updateReviewTask"/);assert.match(ui.run('taskEditorContent(t)'),/data-task-history="91"/);
 ui.run("snapshot.capabilities={view:true,assign:true};t.completed_at='2026-10-07T12:00:00Z'");assert.doesNotMatch(ui.run('taskEditorContent(t)'),/data-work-action="updateReviewTask"/);
 ui.run("t.completed_at=null;t.outcome='stopped'");assert.doesNotMatch(ui.run('taskEditorContent(t)'),/data-work-action="updateReviewTask"/);
});

test('Pick and Put quantity controls increment whole numbers without changing duration controls',()=>{
 const ui=view({role:'admin'});ui.context.state.products=[{id:1,name:'Boots',sku:'B',unit_of_measure:'pairs'}];ui.context.state.operators=[{id:1,name:'Admin',eligible:true,status:'active'}];
 const create=ui.run("createPage('put')"),assignment=ui.run('assignmentPage()');
 assert.match(create,/name="quantity"[^>]*step="1"/);assert.match(assignment,/name="quantity"[^>]*step="1"/);
 assert.match(assignment,/name="dueDuration"[^>]*step="any"/);
 const actual=ui.run('actualRow({lines:[{unit_of_measure:"pairs"}]},{cellId:3,quantity:2},0)');
 assert.match(actual,/name="actualQuantity0"[^>]*step="1"/);
 const history=ui.run('activityHistoryPage()');assert.match(history,/type="search" name="taskId"/);
});
