import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the actual rendering functions without booting storage or a network poll.
const source = readFileSync(new URL('../public/client/work.js', import.meta.url), 'utf8').split('let syncing=false;')[0];
function view({online = true, role = 'operator', tasks = []} = {}) {
  const root = {innerHTML: '', querySelectorAll: () => []};
  const context = vm.createContext({
    document: {querySelector: selector => selector === '#work-app' ? root : null},
    crypto: {randomUUID: () => 'test-device'}, localStorage: {getItem: () => 'test-device'},
    URLSearchParams, location: {pathname: '/work', search: ''},
  });
  vm.runInContext(source, context);
  context.state = {site:'warehouse-a',user:{id:1,name:'Operator',role},generatedAt:'2026-09-25T10:00:00Z',products:[],cells:[],tasks};
  vm.runInContext(`snapshot=state;online=${online};`, context);
  return {root, context, run: code => vm.runInContext(code, context)};
}
const line = {id:1,revision:2,cell_id:3,logical_code:'A3',unit_of_measure:'pieces',planned_quantity:5,product_name:'Part',product_id:1,type:'pick',execution_state:'ready',created_by:1};

test('arrival, camera and summary remain separate; only explicit Finish declares the displayed actual', () => {
  const ui=view();ui.context.line=line;
  const ready=ui.run('lineCard(line)');assert.match(ready,/I'm at this location/);
  assert.doesNotMatch(ready,/Finish pick at this cell/);
  const working=ui.run("lineCard({...line,execution_state:'working'})");
  assert.match(working,/Resume camera/);assert.match(working,/Complete without scanning/);
  assert.doesNotMatch(working,/Finish pick at this cell/);
  ui.run("stages.set(stageKey(line),{method:'manual'})");
  const summary=ui.run("lineCard({...line,execution_state:'working'})");
  assert.match(summary,/Finish pick at this cell/);assert.match(summary,/Press Finish only after moving/);
  assert.match(summary,/Manual completion — no QR verification/);assert.match(summary,/name="quantity"[^>]+value="5"/);
  assert.match(summary,/min="0"/);assert.match(summary,/Change quantity/);
  assert.match(summary,/Record a difference/);assert.match(summary,/Nothing moved — cancel/);
});

test('offline reports stay accessible and queued/view-only safeguards survive simpler screens', () => {
  const ui = view({online:false}); ui.context.line = line;
  const offline = ui.run('lineCard(line)');
  assert.match(offline, /data-disclosure="manual-1" open/);
  assert.doesNotMatch(offline, /data-work-action="acquire"/);
  const readonly = ui.run('lineCard({...line,canAct:false})');
  assert.doesNotMatch(readonly, /<form/);
  ui.run("outbox=[{partition:key(),state:'local',input:{lineId:1}}]");
  assert.match(ui.run('lineCard(line)'), /Do not repeat the movement/);
  assert.match(ui.run('lineCard(line)'), /<button disabled>Update saved/);
});

test('active and review tasks precede completed history; optional location retains explicit preference', () => {
  const ui = view({tasks:[
    {id:1,status:'completed',summary:'Completed task',lines:[]},
    {id:2,status:'working',summary:'Active task',lines:[]},
    {id:3,status:'completed',attention:1,summary:'Needs checking',lines:[]},
  ]});
  const home = ui.run('home()');
  assert.ok(home.indexOf('Active task') < home.indexOf('Completed task'));
  assert.ok(home.indexOf('Needs checking') < home.indexOf('data-disclosure="completed-work"'));
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
  ui.root.querySelectorAll = selector => selector.startsWith('form') ? [] : reads++ === 0 ? before : after;
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

test('task rows expose one set of own start/decline actions beside the product and retain manager assignment',()=>{const ui=view({role:'admin'});ui.context.task={id:4,type:'pick',summary:'Pick Boots',outcome:'open',assignee_id:1,assignment_source:'assigned',assignment_state:'offered',assignment_generation:1,lines:[line]};const html=ui.run('taskRow(task)'),first=html.slice(0,html.indexOf('</th>'));assert.match(first,/Start task/);assert.match(first,/Decline task/);assert.equal((html.match(/data-work-action="start"/g)||[]).length,1);assert.equal((html.match(/data-work-action="decline"/g)||[]).length,1);assert.ok(html.indexOf('data-work-action="reassign"')>html.indexOf('class="task-row-actions"'));ui.context.task.assignee_id=2;assert.doesNotMatch(ui.run('taskRow(task)'),/data-work-action="start"|data-work-action="decline"/);});
test('completed task leads with its result without empty reassignment, while stopped remainder stays assignable',()=>{const ui=view({role:'admin'});ui.context.task={id:3,type:'pick',summary:'Boots',outcome:'completed',completed_at:'2026-09-28T10:00:00Z',due_at:'2026-09-29T10:00:00Z',recorded_quantity:1,remaining_quantity:0,assignee_id:1,assignment_state:'started',lines:[{...line,execution_state:'settled',actual_quantity:1}]};ui.run('snapshot.tasks=[task]');let html=ui.run('taskPage(3)');assert.match(html,/Back to My work/);assert.doesNotMatch(html,/data-disclosure="detail-reassign"/);assert.doesNotMatch(html.split('</section>')[0],/Due /);assert.match(html,/Original deadline:/);ui.context.task.outcome='stopped';ui.context.task.remaining_quantity=2;html=ui.run('taskPage(3)');assert.match(html,/Stopped — partly completed/);assert.match(html,/data-work-action="reassign"/);ui.context.task.attention=1;ui.context.task.outcome='needs_review';assert.doesNotMatch(ui.run('taskPage(3)'),/Back to My work|data-work-action="reassign"/);});
test('product filtering retains an explicit selection, never chooses the first result, and preserves recovery prefills/reference',()=>{const ui=view();ui.run("snapshot.products=[{id:1,name:'Boots',sku:'BOOT-1',unit_of_measure:'pairs'},{id:2,name:'Gloves',sku:'GLOVE-2',unit_of_measure:'pairs'}];snapshot.cells=[{id:3,logical_code:'A3'}]");assert.deepEqual(Array.from(ui.run("matchingProducts('GLOVE',1)"),p=>p.id),[1,2]);assert.equal(ui.run("matchingProducts('missing','').length"),0);let html=ui.run('manualPage()');assert.match(html,/name="productId" required><option value="">Choose a product/);assert.match(html,/name="cellId" required><option value="">Choose a location/);const reference=ui.run('provisionalReference()');assert.equal(reference,ui.run('provisionalReference()'));assert.match(html,/Earlier work or paper records \(optional\)/);assert.match(html,/name="occurredAt" type="datetime-local"/);assert.doesNotMatch(html,/name="occurredAt"[^>]+value=/);ui.run("location.search='?product_id=1&cell_id=3&quantity=2&return_to=%2Fcells%2F3&direction=put'");html=ui.run('manualPage()');assert.match(html,/value="1" selected>Boots/);assert.match(html,/value="3" selected>A3/);assert.match(html,/name="quantity"[^>]+value="2"/);assert.match(html,/value="put" selected/);assert.match(html,/href="\/cells\/3"/);assert.equal(new URLSearchParams(ui.run("recoveryHref('pick')").split('?')[1]).get('return_to'),'/cells/3');});
test('live row updates retain a draft in the new first-column actions as well as the manager editor',()=>{const ui=view();ui.context.task={id:1,type:'pick',summary:'Boots',outcome:'open',lines:[]};ui.run('snapshot.tasks=[task]');const active={},cells=Array.from({length:7},(_,i)=>({innerHTML:'old-'+i,contains:e=>i===0&&e===active,querySelector:()=>null}));const row={dataset:{taskRow:'1'},innerHTML:'old row',children:cells,contains:()=>true,querySelector:()=>null};const scroller={scrollLeft:12,scrollTop:4};ui.root.querySelectorAll=s=>s==='.work-table-wrap'?[scroller]:s==='[data-task-row]'?[row]:[];let noticeUpdated=false;ui.root.querySelector=s=>s==='#work-notice'?{set textContent(v){noticeUpdated=true;}}:null;ui.context.document.activeElement=active;ui.context.document.createElement=()=>({content:{firstElementChild:{innerHTML:'updated row',children:cells.map((_,i)=>({innerHTML:'new-'+i}))}}});let top;ui.context.window={scrollY:240,scrollTo:v=>{assert.equal(noticeUpdated,true);top=v.top;}};const live=readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8').split('function patchLiveRows(){')[1].split('async function backgroundRefresh')[0];ui.run('function patchLiveRows(){'+live);ui.run('patchLiveRows()');assert.equal(cells[0].innerHTML,'old-0');assert.equal(cells[2].innerHTML,'new-2');assert.equal(cells[6].innerHTML,'old-6');assert.equal(top,240);assert.equal(scroller.scrollLeft,12);});

test('prefilled drafts do not collide with plain drafts and distinct recovery drafts retain distinct stable references',()=>{const ui=view();ui.context.fixtureForm={dataset:{workAction:'manual'},elements:{}};let id=0;ui.context.crypto.randomUUID=()=>String(++id);ui.run("path='/record-movement';location.search=''");const plainKey=ui.run('draftKey(fixtureForm)'),plainRef=ui.run('provisionalReference()');ui.run("location.search='?product_id=1&quantity=2&return_to=%2Fcells%2F3'");const contextKey=ui.run('draftKey(fixtureForm)'),contextRef=ui.run('provisionalReference()');assert.notEqual(plainKey,contextKey);assert.notEqual(plainRef,contextRef);assert.equal(contextRef,ui.run('provisionalReference()'));ui.run("location.search='?return_to=%2Fcells%2F3&quantity=2&product_id=1'");assert.equal(contextKey,ui.run('draftKey(fixtureForm)'));ui.run("location.search=''");assert.equal(plainRef,ui.run('provisionalReference()'));ui.context.createForm={elements:{productId:{value:'2'},preferredCellId:{value:'7'},quantity:{value:'4'}}};const q=new URLSearchParams(ui.run("recoveryHref('put',createForm)").split('?')[1]);assert.equal(q.get('product_id'),'2');assert.equal(q.get('cell_id'),'7');assert.equal(q.get('quantity'),'4');assert.equal(q.get('direction'),'put');});
