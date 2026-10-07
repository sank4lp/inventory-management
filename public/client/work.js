export async function mount() {
const pageScope=globalThis.WarehousePageLifecycle?.current;
const setTimeout=(...args)=>pageScope?pageScope.timeout(...args):globalThis.setTimeout(...args);
const setInterval=(...args)=>pageScope?pageScope.interval(...args):globalThis.setInterval(...args);
const requestAnimationFrame=(...args)=>pageScope?pageScope.frame(...args):globalThis.requestAnimationFrame(...args);
const fetch=(...args)=>pageScope?pageScope.fetch(...args):globalThis.fetch(...args);
const onPage=(target,...args)=>pageScope?pageScope.listen(target,...args):target.addEventListener?.(...args);
const root=document.querySelector('#work-app');
const boot=JSON.parse(document.querySelector('#work-boot')?.textContent||'null');
let snapshot=boot?.snapshot, path=boot?.path||location.pathname, outbox=[],notice='',connectionWarning='', db,online=Boolean(boot),cameraStream;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Preserve server details and user-authored text verbatim; routine copy is state-based.
const workText=v=>String(v??'');
const reviewInstruction=r=>r.quantity_known===0?'Ask the person who did the work how much moved. Save the verified quantity, or keep this pending.':r.countOverlap?'Compare this movement with the stock count below before changing stock.':'Check who moved these items and the actual quantity before saving.';
const taskName=t=>t.lines?.[0]?.product_name||t.summary;
const uid=()=>crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let dirty=false;
let lastTaskAutoScroll='';
let lastNotice='',lastConnectionWarning='';
function captureNotification(){
 globalThis.WarehouseNotifications?.setOfflineScope?.(snapshot);
 if(connectionWarning!==lastConnectionWarning){
  lastConnectionWarning=connectionWarning;
  if(connectionWarning){const item={message:connectionWarning,options:{key:'work-connection',tone:'warning',scope:[snapshot?.site,snapshot?.dataset,snapshot?.user?.id]}};if(globalThis.WarehouseNotifications)globalThis.WarehouseNotifications.notify(item.message,item.options);else(globalThis.warehouseNotificationQueue||=[]).push(item);}
  else globalThis.WarehouseNotifications?.clearKey?.('work-connection');
 }
 if(!notice){lastNotice='';return;}
 if(notice===lastNotice)return;
 lastNotice=notice;
 const item={message:workText(notice),options:{scope:[snapshot?.site,snapshot?.dataset,snapshot?.user?.id]}};
 if(globalThis.WarehouseNotifications)globalThis.WarehouseNotifications.notify(item.message,item.options);
 else (globalThis.warehouseNotificationQueue ||= []).push(item);
}
function paintNotifications(){captureNotification();}
function announce(message){lastNotice='';notice=message;captureNotification();}
let selectingTasks=false, selectedTasks=new Set(), bulkTasks=[], bulkErrors=new Map(), bulkBusy=false;
const modalSession=uid(), modalFrames=[];
let modalDepth=0, modalMoving=false;
let snapshotRead=0;
let deviceId;
try { deviceId=localStorage.getItem('warehouse-device')||uid();localStorage.setItem('warehouse-device',deviceId); } catch {deviceId=uid();}
const key=()=>`${snapshot.site}:${snapshot.user.id}`;
const tableBadge=text=>`<span class="badge badge-${esc(String(text).toLowerCase().replaceAll('_','-').replaceAll(' ','-'))}">${esc(text)}</span>`;
const badge=(text,tone='')=>`<span class="work-badge ${tone}">${esc(text)}</span>`;
const input=(name,label,type='text',attrs='')=>`<label>${esc(label)}<input name="${name}" type="${type}" ${attrs}></label>`;
const qty=(label='Actual quantity')=>input('quantity',label,'number','min="0" max="1000000000" step="1" inputmode="numeric" required placeholder="Enter actual, including 0"');
const options=(items,value,label,selected)=>items.map(i=>`<option value="${esc(i[value])}" ${String(i[value])===String(selected)?'selected':''}>${esc(label(i))}</option>`).join('');
const status=s=>({ready:'Ready to start',working:'In progress',settled:'Recorded',cancelled:'Cancelled',superseded:'Replanned',pending_review:'In progress',completed:'Completed',review:'Needs review',reserved:'Reserved',received:'Received',rejected:'Not received — check entry',recorded:'Recorded','not-applied':'Request not applied',local:'Saved on this device'})[s]||s;
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('lytguide-work',1);r.onupgradeneeded=()=>{for(const n of ['cache','outbox'])r.result.createObjectStore(n,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function store(name,mode,fn){return new Promise((resolve,reject)=>{if(!db){reject(new Error('Device storage is unavailable. Nothing was saved.'));return;}const tx=db.transaction(name,mode);let result;try{result=fn(tx.objectStore(name));}catch(e){reject(e);return;}tx.oncomplete=()=>resolve(result?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Device storage write failed.'));});}
const all=name=>store(name,'readonly',s=>s.getAll());
async function cacheSnapshot(){await store('cache','readwrite',s=>s.put({id:key(),snapshot}));await store('cache','readwrite',s=>s.put({id:'active',key:key()}));}
async function refresh(){
 const read=++snapshotRead,requestedPath=path,requestedSearch=location.search;
 const query=new URLSearchParams(location.search);if(path==='/work')clearRetiredWorkFilters(query);const watched=[root.querySelector?.('[data-task-dialog][open]')?.dataset.taskId,...[...root.querySelectorAll('[data-returned-row]')].map(r=>r.dataset.returnedRow),...[...root.querySelectorAll('[data-task-row]')].map(r=>r.dataset.taskRow)].filter(Boolean).slice(0,100);if(watched.length)query.set('watch',watched.join(','));query.set('view',path==='/work/overview'?'assign':path==='/work/history'?'history':path==='/work/task-history'?'activity':path==='/work'?'mine':'accessible');if(/^\/tasks\/\d+$/.test(path))query.set('taskId',path.split('/')[2]);
 const r=await fetch('/api/work/snapshot?'+query,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(r.status===401?'Sign in to send your saved updates.':'Could not refresh warehouse work.');
 const fresh=await r.json();
 if(snapshot&&(fresh.user.id!==snapshot.user.id||fresh.site!==snapshot.site))throw new Error('The signed-in account or warehouse changed. Reopen My work; saved updates stay with their original account and warehouse.');
 if(read!==snapshotRead||requestedPath!==path||requestedSearch!==location.search)return;
 snapshot={...fresh,ledger:snapshot?.ledger};online=true;connectionWarning='';await cacheSnapshot();
 for(const o of await all('outbox')){
  const received=snapshot.reports?.find(r=>r.id===o.result?.reportId);
  if(o.partition===key()&&o.state==='review'&&received&&['posted','resolved','duplicate','superseded'].includes(received.status)){
   o.state='recorded';o.message='Warehouse review completed. Do not repeat the movement.';await store('outbox','readwrite',s=>s.put(o));
  }
 }
 outbox=await all('outbox');
}
const allowed=key=>snapshot?.capabilities?Boolean(snapshot.capabilities[key]):(snapshot?.user?.role==='admin'||['view','execute','pick','put','stop','correct','report','labels'].includes(key));
function form(action,body,attrs=''){
 const permission={reopen:'assign',updateReviewTask:'assign',closeTask:'stop',sendTaskReview:'stop',assign:'assign',create:body.includes('value="put"')?'put':'pick',acquire:'execute',verify:'execute',start:'execute',resume:'execute',decline:'execute',handBack:'execute',assignReview:'assign',observeReview:'execute',resumeFollowup:'execute',acknowledgeReturn:'assign',updateReturned:'assign',reassign:'assign',deadline:'deadline',timing:'timing',askReview:'report',report:'execute',manual:'report',recordMovement:'report',recommendation:'report',cancel:'stop',rejectCell:'stop',correct:'correct',replan:'execute',mode:'mode',reconcile:'reconcile',resolve:body.includes('name="dismissDuplicate"')?'link':'resolve',stop:'stop'}[action];
 if(permission&&!allowed(permission)&&!(['stop','closeTask','sendTaskReview'].includes(action)&&allowed('teamStop')))return '';
 return `<form data-work-action="${action}" ${attrs}>${body}<p class="form-feedback" role="status"></p></form>`;
}
function hidden(n,v){return `<input type="hidden" name="${n}" value="${esc(v)}">`;}
function allocationFields(l,includeCell=true){return hidden('lineId',l.id)+hidden('revision',l.revision)+(includeCell?hidden('cellId',l.cell_id):'')+hidden('unit',l.unit_of_measure)+hidden('productId',l.product_id)+hidden('direction',l.type)+hidden('assignmentGeneration',l.current_generation);}
function performerField(selected='unknown') {
 if(!allowed('resolve'))return '';
 return `<label>Verified performer<select name="performerId"><option value="unknown" ${selected==null||selected==='unknown'?'selected':''}>Unknown / unverified</option>${options(snapshot.performers||[],'id',u=>`${u.name} · ${u.username}${u.status==='active'?'':' (inactive)'}`,selected)}</select></label><p class="work-help">Who physically moved the stock. The person who entered this and verifying supervisor remain recorded separately.</p>`;
}
function accountingFields(r){
 const a=r.accounting;if(!a||a.available&&a.unit===r.unit)return '';
 return `<p class="work-callout">Original entry: ${esc(r.quantity)} ${esc(r.unit)}. ${a.available?`Recorded history: multiply by ${esc(a.factor)}; this entry accounts for ${esc(a.quantity)} ${esc(a.unit)}. If you correct the original actual, verify the corresponding converted quantity.`:`No reliable conversion available: ${esc(workText(a.reason))} Establish the current-unit actual from physical evidence; do not guess a factor.`}</p>${hidden('accountingUnit',a.unit)}${qty('Verified accounting quantity ('+a.unit+')').replace('name="quantity"','name="accountingQuantity"')}${!a.available?input('conversionProvenance','Evidence for current-unit quantity','text','required placeholder="Physical count / pack size checked / dated receiving record"'):''}`;
}
function disclosure(id, title, body, open=false, className='work-options') {
 return `<details class="${className}" data-disclosure="${esc(id)}" ${open?'open':''}><summary>${title}</summary>${body}</details>`;
}
const stages=new Map(), drafts=new Map();
const stageKey=l=>`${key()}:${snapshot.dataset}:summary:${l.id}:${l.revision}:${l.current_generation}`;
const dueText=t=>t.clock_invalid?'Warehouse clock needs checking':t.overdue?`Overdue by ${t.overdue_minutes} min`:t.due_at?`Due ${new Date(t.due_at).toLocaleString([], {timeZone:snapshot.timing?.timezone})}`:'No deadline';
const outcome=t=>({open:t.assignment_state==='offered'?'Not started':'In progress',needs_assignment:'Needs assignment',needs_review:'Needs review',stopped:'Stopped — partly completed',cancelled:'Cancelled — nothing moved',completed:'Completed'})[t.outcome]||status(t.status);
// This execution context exists only after an explicit successful action in this document.
// It is neither persisted nor inferred from a URL, snapshot, reload, reconnect or history entry.
let activeWork=null, resumeLightWarning='';
const guidanceSession=uid();
function workActive(t){return !!t&&!!activeWork&&activeWork.taskId===t.id&&activeWork.generation===t.assignment_generation&&activeWork.identity===key()&&activeWork.dataset===snapshot.dataset&&!t.guidance_paused&&!t.review_followup&&!t.completed_at&&!t.stop_requested&&t.assignee_id===snapshot.user.id;}
function lineActive(l){const t=snapshot.tasks.find(t=>t.id===l.task_id);return workActive(t);}
function executionLines(t){return (t.lines||[]).filter(l=>['ready','working'].includes(l.execution_state)&&l.planned_quantity>0&&!(l.reports||[]).some(r=>['review','received'].includes(r.status)));}
function activationFields(t){return hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('instructions',JSON.stringify(executionLines(t).map(l=>({lineId:l.id,revision:l.revision,bindingRevision:l.directions?.bindingRevision??l.binding_revision}))));}
function activationForm(t,label=null,attrs=''){
 const action=t.assignment_state==='offered'||t.assignment_state==='legacy'?'start':'resume';
 return form(action,activationFields(t)+`<button ${online?'':'disabled'}>${esc(label|| (action==='start'?'Start task':'Resume task'))}</button>`,attrs);
}
function isActivation(action,input={}){return ['start','resume'].includes(action)||action==='create'&&!input.assigneeId;}
function currentActivation(o){return o.input.dataset===snapshot.dataset&&o.input.site===snapshot.site&&Number(o.input.actorId)===snapshot.user.id;}
function currentSavedUpdate(o){return o.partition===key()&&(!(o.planningRequest||o.reviewSave||['activation-pending','activation-unknown'].includes(o.state))||currentActivation(o));}
function activationPending(t=null){return outbox.find(o=>currentSavedUpdate(o)&&['activation-pending','activation-unknown'].includes(o.state)&&(!t||Number(o.input.taskId)===t.id));}
async function enterActiveTask(result){
 const t=await fetchDialogTask(Number(result.taskId));
 if(t.assignment_generation!==Number(result.generation)||t.assignee_id!==snapshot.user.id||t.canAct===false||t.assignment_state!=='started'||t.review_followup||t.completed_at||t.stop_requested)throw new Error('The task changed after this request. Open its details before continuing.');
 snapshot.tasks=[t,...snapshot.tasks.filter(x=>x.id!==t.id)];
 activeWork={taskId:t.id,generation:t.assignment_generation,identity:key(),dataset:snapshot.dataset,guidanceSession};resumeLightWarning='';
 lastTaskAutoScroll='';
 const returnTo=workReturn(),query=returnTo?'?return_to='+encodeURIComponent(returnTo):'';
 path='/tasks/'+t.id;window.history.pushState({},'',path+query);
 const title=`Task #${t.id} - ${t.type==='put'?'Put':'Pick'} ${taskName(t)}`;const heading=document.querySelector('h1');if(heading)heading.textContent=title;document.title=title+' · LytGuide IMS';render();
}
async function deliverActivation(o){
 if(!online)throw new Error('Reconnect, then explicitly retry this task action.');
 if(o.input.site!==snapshot.site||o.input.dataset!==snapshot.dataset||Number(o.input.actorId)!==snapshot.user.id)throw new Error('This saved request belongs to another account, warehouse or dataset. Its original details will not be changed.');
 o.state='activation-pending';await store('outbox','readwrite',s=>s.put(o));
 try{
  const response=await fetch('/api/work/'+o.action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(o.input)});
  const result=await response.json();if(!response.ok){const error=new Error(result.error||'Task action was not confirmed.');error.definite=[400,401,403,404,409,422].includes(response.status);error.planning=result.planning;throw error;}
  o.result=result;o.state=result.status;o.message=result.message;
  await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');announce(result.message);
  closeOperationDialogs();await enterActiveTask(result);
 }catch(error){
  if(!o.result){o.state=error.definite?'acknowledged':'activation-unknown';o.message=error.definite?error.message:'Start / Resume not confirmed. Retry this saved request explicitly; background sync will not start it.';await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');}
  throw error;
 }
}
async function beginActivation(action,values){
 if(!online)throw new Error('Reconnect before starting or resuming work.');
 if(activationPending())throw new Error('Check the saved Start / Resume request before starting another task.');
 const t=snapshot.tasks.find(t=>t.id===Number(values.taskId))||snapshot.myWorkNextTask;
 if(action!=='create'&&t&&taskHasSavedUpdate(t))throw new Error('Send saved physical updates before starting or resuming this task.');
 const id=uid(),input={...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId,guidanceSession};
 const o={id,partition:key(),action,input,state:'activation-pending',message:'Waiting for task confirmation.',createdAt:new Date().toISOString()};
 await deliverActivation(o);
}
async function pauseActiveWork({keepalive=false}={}){
 const current=activeWork;
 if(!current||!snapshot||!/^\/tasks\/\d+$/.test(path))return true;
 const input={taskId:current.taskId,generation:current.generation,guidanceSession:current.guidanceSession,
  requestId:uid(),site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id};
 const request=fetch('/api/work/pause',{method:'POST',credentials:'same-origin',keepalive,
  headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input),
  ...(!keepalive?{signal:AbortSignal.timeout(5000)}:{})});
 if(keepalive){activeWork=null;void request.catch(()=>{});return true;}
 const response=await request;
 if(!response.ok)throw new Error('Could not pause the task lights. Stay on this task and try again.');
 activeWork=null;
 return true;
}
async function refreshActiveLight(){
 if(!online)throw new Error('Reconnect before refreshing a light.');
 const t=snapshot.tasks.find(t=>t.id===Number(path.split('/')[2]));if(!workActive(t))throw new Error('Resume this task before refreshing its light.');
 const card=root.querySelector('[data-line][data-light-revision]'),l=t.lines.find(l=>String(l.id)===card?.dataset.line);
 if(!l||!executionLines(t).some(x=>x.id===l.id)||String(l.revision)!==card.dataset.lightRevision||String(t.assignment_generation)!==card.dataset.lightGeneration||String(l.binding_revision)!==card.dataset.lightBinding)throw new Error('Instructions changed. Open task details before continuing.');
 try{await immediate('guide',{taskId:t.id,generation:t.assignment_generation,lineId:l.id,revision:l.revision,bindingRevision:l.binding_revision,requestId:uid()});await refresh();resumeLightWarning='';}
 catch(error){resumeLightWarning='Light refresh not confirmed. Follow the screen and explicitly retry when connected.';throw error;}
 finally{patchGuidanceHints();}
}
function locationHeading(l){
 const active=['ready','working'].includes(l.execution_state),check=l.review_followup||(l.reports||[]).some(r=>['review','received'].includes(r.status));
 return (active&&check?'Check ':active&&lineActive(l)&&l.canAct!==false&&!['waiting','blocked'].includes(l.guidance?.state)?'Go to ':active?'Location ':'')+l.logical_code;
}
function guidanceMarkup(l){return esc(guidanceText(l))+(online&&l?.guidance?.blocker?.href?` <a href="${esc(l.guidance.blocker.href)}">Open ${l.guidance.blocker.kind==='task'?'task':'stocktake'} #${esc(l.guidance.blocker.taskId??l.guidance.blocker.runId)}</a>`:'');}
function guidanceText(l){
 if(!online)return 'Offline — light status may have changed. Follow your saved cell instructions.';
 if(resumeLightWarning)return resumeLightWarning;
 if(l&&(l.review_followup||(l.reports||[]).some(r=>['review','received'].includes(r.status))))return 'Check what moved before continuing. Do not repeat the movement.';
 if(!l||!['ready','working'].includes(l.execution_state))return 'This location’s work changed. Check the latest task before continuing.';
 return l.guidance?.message||'Follow the cell name and quantity on your screen.';
}
function inactivityAlertsMarkup(){return (snapshot.inactivityAlerts||[]).map(a=>`<p class="work-callout warning">No recent update from ${esc(a.name)} · <a href="/tasks/${esc(a.taskId)}">Task #${esc(a.taskId)}</a>. Check in with the operator. Their location remains reserved for active work until it is finished or explicitly stopped.</p>`).join('');}
function patchGuidanceHints(){
 const inactivity=root.querySelector?.('[data-inactivity-alerts]');if(inactivity)inactivity.innerHTML=inactivityAlertsMarkup();
 for(const f of root.querySelectorAll('form[data-work-action="start"],form[data-work-action="resume"]')){const t=[...snapshot.tasks,...(snapshot.watchedTasks||[]),snapshot.myWorkNextTask].find(t=>t&&String(t.id)===f.elements.taskId?.value);const stale=!online||!t||t.assignee_id!==snapshot.user.id||t.completed_at||t.stop_requested||t.review_followup||String(t.assignment_generation)!==f.elements.generation?.value||t.progress_token!==f.elements.progressToken?.value||taskHasSavedUpdate(t);for(const b of f.querySelectorAll('button'))b.disabled=!!stale;}
 for(const card of root.querySelectorAll('[data-line][data-light-revision]')){
  const l=[...snapshot.tasks,...(snapshot.watchedTasks||[])].flatMap(t=>t.lines||[]).find(l=>String(l.id)===card.dataset.line);
  const stale=!l||String(l.revision)!==card.dataset.lightRevision||String(l.current_generation)!==card.dataset.lightGeneration||String(l.binding_revision)!==card.dataset.lightBinding;
  const heading=card.querySelector('.directions');if(heading)heading.textContent=stale?'Location instructions changed':locationHeading(l);
  const blocked=stale||['waiting','blocked'].includes(l?.guidance?.state)||!lineActive(l)||l.canAct===false||l.review_followup||!['ready','working'].includes(l.execution_state)||(l.reports||[]).some(r=>['review','received'].includes(r.status));
  for(const button of card.querySelectorAll('[data-refresh-guidance],form[data-work-action="acquire"] button'))button.disabled=!online||blocked;
 }
 for(const hint of root.querySelectorAll('[data-guidance-line]')){
  const l=[...snapshot.tasks,...(snapshot.watchedTasks||[])].flatMap(t=>t.lines||[]).find(l=>String(l.id)===hint.dataset.guidanceLine);
  hint.textContent=guidanceText(l);if(online&&l?.guidance?.blocker?.href){const link=document.createElement('a');link.href=l.guidance.blocker.href;link.textContent=`Open ${l.guidance.blocker.kind==='task'?'task':'stocktake'} #${l.guidance.blocker.taskId??l.guidance.blocker.runId}`;hint.append(' ',link);}
 }
}
function locationDetails(l){
 const d=l.directions||{},code=l.logical_code;
 const parts=String(d.directions||'').split(',').map(v=>v.trim()).filter(v=>v&&v!==code);
 return [...new Set(parts)].join(', ');
}
const returnBlocked=t=>t.attention||(t.lines||[]).some(l=>l.execution_state==='working'||(l.reports||[]).some(r=>['review','received'].includes(r.status)));
function reviewHref(t){const r=(t.lines||[]).flatMap(l=>l.reports||[]).find(r=>['review','received'].includes(r.status));return r?'/pending-confirmations?reportId='+encodeURIComponent(r.id):'/tasks/'+t.id;}
function observationList(items){return (items||[]).map(o=>{const v=JSON.parse(o.payload);return `<p>${esc(o.logical_code)} · ${esc(o.observer_name)} observed ${v.quantity==null?'quantity unknown':esc(v.quantity)}: ${esc(v.note)}</p>`;}).join('');}
function checkTime(value){return value?esc(new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}))+' IST':'Not recorded';}
function checkTaskSummary(t,showWorkState=false){
 const unit=esc(t.lines[0]?.unit_of_measure),fields=[...(showWorkState?[['Work',workActive(t)?'Active work':'Task details'],['Status',esc(t.review_followup?'Quantity check':t.guidance_paused?'Paused':outcome(t))]]:[]),['Task',`<a href="/tasks/${t.id}">#${t.id} · ${t.type==='put'?'Put':'Pick'}</a>`],['Product name',taskProductLink(t)],['Assigned to',esc(t.assignee_name||'Unassigned')],['Assigned by',esc(t.assigned_by_name||'Not recorded')],['Assigned time',checkTime(t.assigned_at)],['Deadline',t.due_at?checkTime(t.due_at)+(t.overdue?' · Overdue':''):'No deadline'],['Quantity',`${esc(t.requested_quantity)} ${unit}`],['Completed',`${esc(t.recorded_quantity)} ${unit}`],['Remaining',`${esc(t.remaining_quantity)} ${unit}`],['Progress',esc(t.review_handover_verified?'Check verified':outcome(t))]];
 if(t.return_event){const e=t.return_event;fields.push(['Returned by',esc(e.previous_name||'Unknown')],['Returned time',checkTime(e.created_at)]);if(e.reason||e.note)fields.push(['Return reason',esc(e.reason||'Not recorded')],['Return note',esc(e.note||'—')]);}
 const rows=[];for(let i=0;i<fields.length;i+=2)rows.push(`<tr>${fields.slice(i,i+2).map(([name,value])=>`<th scope="row">${name}</th><td>${value}</td>`).join('')}</tr>`);
 return `<table class="check-summary-table"><caption>Times: Asia/Kolkata · IST</caption><colgroup><col class="check-summary-label"><col class="check-summary-value"><col class="check-summary-label"><col class="check-summary-value"></colgroup><tbody>${rows.join('')}</tbody></table>`;
}
function recordedMovements(t){
 if(t.recorded_movements)return t.recorded_movements;const rows=new Map();for(const l of t.lines||[]){if(l.execution_state==='superseded')continue;const r=rows.get(l.cell_id)||{cellId:l.cell_id,logical_code:l.logical_code,quantity:0};if(l.execution_state==='settled')r.quantity+=l.actual_quantity||0;rows.set(l.cell_id,r);}return [...rows.values()];
}
function actualRow(t,row,index){return `<tr class="task-actual-row" data-actual-row><td><select data-searchable name="actualCell${index}" aria-label="Actual location ${index+1}" required><option value="">Choose location</option>${options(snapshot.cells||[],'id',c=>c.description?.name||c.logical_code,row.cellId)}</select></td><td><input name="actualQuantity${index}" aria-label="Actual quantity ${index+1} (${esc(t.lines[0]?.unit_of_measure)})" type="number" min="0" max="1000000000" step="1" inputmode="numeric" required value="${esc(row.quantity??'')}"></td><td class="actual-unit">${esc(t.lines[0]?.unit_of_measure)}</td><td><button type="button" class="secondary" data-remove-actual aria-label="Remove actual location ${index+1}">Remove</button></td></tr>`;}
function actualEditor(t,rows=recordedMovements(t)){return `<div data-actual-editor data-unit="${esc(t.lines[0]?.unit_of_measure)}"><p class="work-help">Enter final total movement for this task, not remaining work or stock on hand. Removing a location sets its total to 0.</p><table class="task-actual-table" aria-label="Final actual movements"><colgroup><col class="actual-location-col"><col class="actual-quantity-col"><col class="actual-unit-col"><col class="actual-remove-col"></colgroup><thead><tr><th scope="col">Actual location</th><th scope="col">Actual quantity</th><th scope="col">Unit</th><th scope="col">Remove</th></tr></thead><tbody data-actual-rows>${rows.map((r,i)=>actualRow(t,r,i)).join('')}</tbody></table><button type="button" class="secondary" data-add-actual>Add actual location</button></div>`;}
function closureForm(t){
 if(t.closure_review_id)return `<p class="work-callout">${t.explicit_close?'Unfinished work is awaiting supervisor review. Completed cells remain recorded.':'Task closure is awaiting review. Actual entries remain saved; stock is not confirmed.'}</p>${allowed('review')?`<a href="/pending-confirmations?reportId=${esc(t.closure_review_id)}">Open closure review</a>`:''}`;
 const team=t.assignee_id!==snapshot.user.id,verify=team&&allowed('resolve')&&allowed('resolveStop');
 if(team&&!allowed('teamStop')||!team&&!allowed('stop'))return '';
 const verification=verify?hidden('verifiedClosure','true')+'<label class="work-check"><input type="checkbox" name="workerStopped">I confirmed all workers have stopped and verified the actual totals.</label>':'';
 const rows=recordedMovements(t),unit=t.lines[0]?.unit_of_measure;
 return form('closeTask',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('closureToken',t.closure_token)+`<h3>Recorded movement per location</h3><table class="closure-movements"><thead><tr><th>Location</th><th>Recorded</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.logical_code||snapshot.cells?.find(c=>c.id===r.cellId)?.logical_code)}</td><td>${esc(r.quantity)} ${esc(unit)}</td></tr>`).join('')}</tbody></table>${t.attention?'<p class="work-callout warning">Unverified movement is still pending. Recorded totals do not include those entries. Enter verified actuals or Send for review.</p>':''}<fieldset class="closure-choice"><legend>Are you sure you want to terminate this task with the current status shown above?</legend><label><input type="radio" name="currentStatus" value="yes" required>Yes</label><label><input type="radio" name="currentStatus" value="no" required>No</label></fieldset><div data-custom-actuals hidden>${actualEditor(t)}</div>${verification}<footer class="closure-actions"><button type="submit" data-close-task ${team&&!verify?'disabled':''}>Close task</button><button type="submit" class="secondary" data-send-task-review>Send for review</button></footer>`,'data-task-closure data-draft-kind="task-closure"');
}
function updateClosureForm(f){if(!f?.hasAttribute?.('data-task-closure'))return;const custom=f.querySelector('[data-custom-actuals]'),show=f.elements.currentStatus?.value==='no';if(custom){custom.hidden=!show;for(const el of custom.querySelectorAll('input,select,button'))el.disabled=!show;}globalThis.WarehouseCombobox?.restore(f);}
function closureActualValues(f){return [...f.querySelectorAll('[data-actual-row]')].map(row=>({cellId:row.querySelector('select').value,quantity:row.querySelector('input[type="number"]').value}));}
function editActualRows(button){
 const f=button.closest('form'),t=availableTask(f.elements.taskId?.value)||snapshot.pending?.find(r=>r.id===f.elements.reportId?.value)?.closureTask,rows=f.querySelector('[data-actual-rows]');
 if(button.hasAttribute('data-remove-actual'))button.closest('[data-actual-row]').remove();else{const index=Math.max(-1,...[...rows.querySelectorAll('select')].map(el=>Number(el.name.replace('actualCell',''))))+1;rows.insertAdjacentHTML('beforeend',actualRow(t,{cellId:'',quantity:''},index));}
 globalThis.WarehouseCombobox?.init(f);updateCellConfirmation(f);dirty=true;return f;
}
function closureReview(r){const t=r.closureTask;return disclosure('case-'+r.id,`Task #${t.id} closure · ${esc(r.product_name)} — verify final actual totals`,checkTaskSummary(t)+`<p>${esc(r.reason)}</p><p>These totals replace this task’s recorded movements. Original entries remain in task history.</p>`+form('resolve',hidden('reportId',r.id)+hidden('caseRevision',r.case_revision)+hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('closureToken',t.closure_token)+hidden('currentStatus','no')+actualEditor(t,r.closureActuals)+(r.closureCounts?.length?disclosure('closure-count-links-'+r.id,'Link differences already included in a stocktake',r.closureCounts.filter(c=>JSON.parse(c.lines_json).some(i=>i.productId===t.lines[0]?.product_id)).map(c=>`<label>${esc(c.logical_code)} · ${esc(c.title)}<input type="radio" name="countLink${c.cell_id}" value="${esc(c.id)}">This count already accounts for the final-total difference at this location</label>`).join('')):'')+'<label class="work-check"><input type="checkbox" name="workerStopped">I confirmed all workers have stopped and verified the actual totals.</label>'+disclosure('closure-count-'+r.id,'Stocktake overlap','<p>If a count already includes this correction, keep this pending until the original accounting is reconciled.</p><label class="work-check"><input type="checkbox" name="afterCountVerified">I verified these differences are separate from every overlapping stocktake correction.</label>')+'<button>Close task with verified totals</button>','data-closure-review data-draft-kind="closure-review"')+form('resolve',hidden('reportId',r.id)+hidden('caseRevision',r.case_revision)+hidden('keepOpen','true')+input('verification','Optional note')+'<button class="secondary">Keep pending</button>'),true,'work-panel review-case');}
function checkStopContent(t){
 return canStopTask(t)?`<section id="check-stop-${t.id}" data-check-stop-panel class="check-stop-panel" tabindex="-1" hidden><h3>Stop remaining work</h3>${closureForm(t)}</section>`:'';
}
function dismissDialog(label){return `<button type="button" class="dialog-dismiss" data-dialog-dismiss aria-label="Close ${esc(label)}" title="Close"><span aria-hidden="true">×</span></button>`;}
function reviewHeader(t,step='check'){return `<header class="review-task-header"><button type="button" class="secondary" ${step==='check'?'data-task-dialog-close':'data-review-back'}>← Back</button><h2 tabindex="-1" autofocus>Review task</h2>${step==='check'?dismissDialog('review'):''}</header>${checkTaskSummary(t)}`;}
function reviewChoices(t,mode='check'){return `<div class="review-choices"><button type="button" data-review-align aria-pressed="${mode==='check-align'}">Align With Actual Physical Movement</button><button type="button" data-review-assignment ${allowed('assign')&&!t.closure_review_id&&!t.closed_actuals&&!t.completed_at?'':'disabled'} aria-pressed="${mode==='check-assignment'}">Update Assignment of the task</button></div>`;}
function reviewDiscard(t){return `<footer class="review-discard-footer"><button type="button" class="danger" data-review-discard ${canCloseReview(t)?'':'disabled'}>Discard</button></footer>`;}
function checkDialogContent(t){
 if(!canCheckTask(t))return '';
 return `<section class="check-workspace">${reviewHeader(t)}${reviewChoices(t)}${t.review_followup&&t.review_handover_verified&&!t.completed_at&&!t.closed_actuals&&!pendingTaskEvidence(t)&&t.assignee_id===snapshot.user.id&&allowed('execute')?form('resumeFollowup',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+'<button>Plan verified remaining work</button>'):''}${t.review_followup||t.attention?'<p class="work-help">Check final movement before restarting work. Existing evidence and stock holds remain until reconciled.</p>':''}${reviewDiscard(t)}</section>`;
}
function discardContent(t){
 const supervisor=reviewVerifier(t),fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('closureToken',t.closure_token)+hidden('currentStatus','yes')+(t.closure_review_id?hidden('reportId',t.closure_review_id)+hidden('caseRevision',t.closure_case_revision):supervisor?hidden('verifiedClosure','true'):'');
 return `<section class="check-workspace">${reviewHeader(t,'discard')}${reviewChoices(t)}<h3>Discard task</h3><p>Keep ${esc(t.recorded_quantity||0)} ${esc(t.lines?.[0]?.unit_of_measure)} recorded. Close remaining work and release reserved stock.</p>${pendingTaskEvidence(t)?'<p class="work-callout warning">There is unverified movement. Review it before confirming these recorded totals as final.</p>':''}${form(t.closure_review_id?'resolve':'closeTask',fields+'<label class="work-check"><input type="checkbox" name="workerStopped" required>I confirm work has stopped and the recorded totals above are final.</label><button class="danger" data-close-task>Discard</button>','data-discard-task data-draft-kind="discard-task"')}</section>`;
}
function reviewVerifier(t){return allowed('resolve')&&allowed('resolveStop')&&(t.assignee_id===snapshot.user.id||allowed('teamStop')||!!t.closure_review_id);}
function canCloseReview(t){return !!t&&!t.closed_actuals&&!t.completed_at&&(reviewVerifier(t)||!t.closure_review_id&&t.assignee_id===snapshot.user.id&&allowed('stop')&&!t.review_followup);}
function reviewMovementContent(t){
 if(t.closed_actuals||t.completed_at)return `<section class="check-workspace">${reviewHeader(t,'align')}${reviewChoices(t,'check-align')}<p>This task is finalized. Late evidence must be reconciled separately; its original closure cannot be reopened.</p>${allowed('review')?`<a class="work-primary" href="${esc(reviewHref(t))}">Review late evidence</a>`:'<p>Ask an authorized verifier to reconcile the retained evidence.</p>'}</section>`;
 const supervisor=reviewVerifier(t),canClose=canCloseReview(t);
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('closureToken',t.closure_token)+hidden('currentStatus','no')+hidden('alignPhysical','true');
 const people=(snapshot.operators||[]).filter(u=>u.eligible&&u.status!=='inactive');
 const assignRemaining=t.closure_review_id&&allowed('assign')?`<label>Assign remaining to<select data-searchable name="assigneeId"><option value="">Choose operator</option>${options(people,'id',assigneeLabel,t.assignee_id)}</select></label><button data-assign-remaining ${canClose?'':'disabled'}>Accept movement and assign remaining</button>`:'';
 const body=fields+(t.closure_review_id?hidden('reportId',t.closure_review_id)+hidden('caseRevision',t.closure_case_revision):supervisor?hidden('verifiedClosure','true'):'')+actualEditor(t,t.closure_actuals||recordedMovements(t))+(supervisor?'<label class="work-check"><input type="checkbox" name="workerStopped">I confirmed all workers have stopped and verified the actual totals.</label>':'')+(!canClose?'<p class="work-callout">An authorized verifier must reconcile this physical evidence before the task can close.</p>':'')+`<button data-close-task ${canClose?'':'disabled'}>Accept movement and close task</button>`+assignRemaining;
 return `<section class="check-workspace">${reviewHeader(t,'align')}${reviewChoices(t,'check-align')}${form(t.closure_review_id?'resolve':'closeTask',body,'data-review-movement data-draft-kind="'+(t.closure_review_id?'closure-review':'task-closure')+'"')}${allowed('review')?'<p><a href="'+esc(reviewHref(t))+'">Open original evidence and other reconciliation options</a></p>':''}${reviewDiscard(t)}</section>`;
}
// Keep the task editor and review assignment editor on the same validated command.
function taskAssignmentForm(t,locationLabel='Location for remaining work'){
 const people=(snapshot.operators||[]).filter(u=>u.eligible&&u.status!=='inactive');
 return form('updateReviewTask',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+`<label>Assigned to<select data-searchable name="assigneeId" required>${options(people,'id',assigneeLabel,t.assignee_id)}</select></label>`+input('remainingQuantity','Remaining quantity','number',`min="1" max="1000000000" step="1" required value="${esc(t.remaining_quantity)}"`)+`<label>${esc(locationLabel)}<select data-searchable name="planCellId"><option value="">Choose automatically</option>${options(snapshot.cells||[],'id',c=>c.description?.name||c.logical_code,t.plan_cell_id)}</select></label><p class="work-help">A chosen location must fit all remaining items. Stock or space is checked before assignment.</p><p>Deadline: ${t.due_at?checkTime(t.due_at):'No deadline'}</p>`+(allowed('deadline')?'<label>Deadline<select name="deadlineChoice"><option value="keep">Keep current deadline</option><option value="duration">Set duration from now</option><option value="none">No deadline</option></select></label><div data-review-duration hidden><label>Duration<input type="number" name="duration" min="0.0007" step="any" value="8" disabled></label><label>Unit<select name="timeUnit" disabled><option value="minutes">Minutes</option><option value="hours" selected>Hours</option><option value="days">Days</option></select></label></div>':'')+(t.attention||t.review_followup?'<p class="work-callout">Changing responsibility or intended remaining work keeps this task in Needs Review. It does not restart physical work.</p>':'')+'<button>Save and Assign task</button>','data-review-assignment-form data-draft-kind="review-assignment"');
}
function reviewAssignmentContent(t){
 return `<section class="check-workspace">${reviewHeader(t,'assignment')}${reviewChoices(t,'check-assignment')}${taskAssignmentForm(t)}${reviewDiscard(t)}</section>`;
}
function canEditTask(t){return allowed('assign')&&!t.closure_review_id&&!t.closed_actuals&&!t.completed_at&&!['completed','stopped','cancelled'].includes(t.outcome);}
function taskEditorContent(t){
 return `<section class="check-workspace"><header class="review-task-header"><button type="button" class="secondary" data-review-back>← Back</button><h2 tabindex="-1" autofocus>Task #${t.id} · ${esc(t.type==='put'?'Put':'Pick')} ${esc(taskName(t))}</h2>${dismissDialog('task editor')}</header>${checkTaskSummary(t)}<div class="task-editor-actions"><button type="button" class="secondary" data-task-history="${t.id}">Task history</button></div>${canEditTask(t)?taskAssignmentForm(t,'Preferred location'):''}</section>`;
}
function pendingTaskEvidence(t){return !!t&&(t.attention||(t.lines||[]).some(l=>(l.reports||[]).some(r=>['review','received'].includes(r.status))));}
function canCheckTask(t){return !!t&&(!t.completed_at||pendingTaskEvidence(t))&&((t.assignee_id===snapshot.user.id&&(allowed('execute')||allowed('stop')))||allowed('review')||allowed('assign'));}
function checkButton(t){return canCheckTask(t)?`<button type="button" class="secondary" data-task-check="${t.id}" ${online&&!taskHasSavedUpdate(t)?'':'disabled'}>Review</button>`:'';}
function taskProductLink(t){const id=t.lines?.[0]?.product_id;return allowed('productsView')&&id?`<a href="/products/${id}">${esc(taskName(t))}</a>`:esc(taskName(t));}
function followupPanel(t){return t.review_followup?`<p class="work-callout">Quantity check only. Do not repeat the movement.${t.assignee_id===snapshot.user.id?' Open Review to reconcile the actual movement.':''}</p>`:'';}
function taskDate(value){return value?esc(new Date(value).toLocaleString([], {timeZone:snapshot.timing?.timezone})):'Not recorded';}
function assignmentEditAction(t){
 if(t.closed_actuals||t.closure_review_id||!allowed('assign')||t.completed_at&&t.outcome!=='stopped'||['completed','cancelled'].includes(t.outcome))return null;
 const pending=t.lines.some(l=>(l.reports||[]).some(r=>['review','received'].includes(r.status)));
 if(pending)return 'assignReview';
 if(t.lines.some(l=>l.execution_state==='working')||t.review_followup&&!t.review_handover_verified)return null;
 return t.assignment_state==='returned'?'updateReturned':'reassign';
}
function taskAssigneeEditor(t,compact=false){
 const action=assignmentEditAction(t);if(!action)return compact?'':`<p>Assigned to: <strong>${esc(t.assignee_name||'Unassigned')}</strong></p>${allowed('assign')&&returnBlocked(t)?'<p class="work-help">Check active movement before changing the assignment.</p>':''}`;
 const fields=hidden('assignmentEditor','task')+hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+(action==='updateReturned'?hidden('returnEventId',t.return_event?.id)+hidden('remainingQuantity',t.remaining_quantity):'');
 const people=(snapshot.operators||[]).filter(u=>u.eligible&&u.status!=='inactive'&&(!compact||u.id!==t.assignee_id));
 return form(action,fields+`<div class="task-assignee-editor ${compact?'check-assignee-editor':''}"><div>${compact?'<label>New operator':'<p>Assigned to <strong>'+esc(t.assignee_name||'Unassigned')+'</strong></p>'}<select data-searchable name="assigneeId" aria-label="${compact?'New operator':'Assigned to'}" required><option value="">Choose person</option>${options(people,'id',assigneeLabel,compact?'':t.assignee_id)}</select>${compact?'</label>':''}</div><button class="secondary ${compact?'check-save-assignee':''}" ${compact?'aria-label="Save new operator" title="Save new operator"':''} disabled>${compact?'<span aria-hidden="true">✓</span>':'Save'}</button></div>${!compact&&action==='assignReview'?'<p class="work-help">Assigns the quantity check, not physical work.</p>':''}`,'data-task-assignee data-draft-kind="'+(compact?'check-assignee':'task-assignee')+'"');
}
function taskPeople(t){
 return t.lines.map(l=>{const a=l.attribution,settled=l.execution_state==='settled'&&(a?.performer||a?.reporter),records=settled?[{performer_name:a.performer,reporter_name:a.reporter,quantity:l.actual_quantity,unit:l.unit_of_measure,quantity_known:1}]:(l.reports||[]);return records.map(r=>`<p class="work-help">${esc(l.logical_code)} · Performed by ${esc(r.performer_name||'Unknown / unverified')} · Entered by ${esc(r.reporter_name||'Unknown')}${r.quantity_known===0?' · Quantity unknown':r.quantity!=null?' · '+(settled?'Recorded ':'Entered ')+esc(r.quantity)+' '+esc(r.unit||l.unit_of_measure):''}</p>${r.reason||r.entered_reason?`<p class="work-help">${esc([...new Set([r.entered_reason,r.reason].filter(Boolean))].join(' · '))} · ${taskDate(r.created_at)}</p>`:''}`).join('');}).join('');
}
function taskContext(t){
 const e=t.return_event;
 const field=(label,value)=>`<div class="task-info-field"><dt>${label}</dt><dd>${value}</dd></div>`;
 const assignment=assignmentEditAction(t)?disclosure('task-assignee-'+t.id,'Change',taskAssigneeEditor(t,true),false,'task-assignee-change'):'';
 const first=[field('Product name',taskProductLink(t)),field('Task',`#${esc(t.id)} · ${esc(t.type==='put'?'Put':'Pick')}`),field('Assigned to',`${esc(t.assignee_name||'Unassigned')}${assignment}`),field('Assigned by',esc(t.assigned_by_name||'Not recorded')),field('Assigned time',taskDate(t.assigned_at))].join('');
 const rest=[field('Status',esc(outcome(t))),field('Requested',`${esc(t.requested_quantity)} ${esc(t.lines[0]?.unit_of_measure)}`),field('Completed',`${esc(t.recorded_quantity??0)} ${esc(t.lines[0]?.unit_of_measure)}`),field('Remaining',`${esc(t.remaining_quantity??0)} ${esc(t.lines[0]?.unit_of_measure)}`),field('Deadline',t.due_at?taskDate(t.due_at):'No deadline')].join('');
 const extra=e?`<p><strong>Returned by ${esc(e.previous_name||'Unknown')}</strong> · ${taskDate(e.created_at)}</p><p>${esc([e.reason,e.note].filter(Boolean).join(' · ')||'No reason recorded')}</p>`:'';
 return `<section class="task-context task-info" aria-label="Task info"><h3>Task info</h3><dl class="task-info-grid">${first}${rest}</dl>${t.assignment_state==='returned'&&!t.assignee_id?'<p>Assign the remaining work before starting.</p>':''}${t.review_followup||t.attention?'<p class="work-callout warning">Check moved quantity first. Remaining quantity is provisional until verified.</p>':''}${extra}${taskPeople(t)?disclosure('task-people-'+t.id,'Movement details',taskPeople(t)):''}</section>`;
}
function canReopenTask(t){return !!t&&allowed('assign')&&allowed(t.type)&&!!t.completed_at&&!t.reopened_task_id&&!pendingTaskEvidence(t)&&!t.closure_review_id&&(t.lines||[]).length>0&&(t.lines||[]).every(l=>!['ready','working'].includes(l.execution_state));}
function reopenButton(t){
 if(!allowed('assign'))return '';
 if(t.reopened_task_id)return `<a href="/tasks/${t.reopened_task_id}">Reopened as #${t.reopened_task_id}</a>`;
 return canReopenTask(t)?`<button type="button" class="secondary" data-task-reopen="${t.id}" ${online&&!taskHasSavedUpdate(t)?'':'disabled'}>Reopen task</button>`:'';
}
function reopenTaskContent(t){
 const first=t.lines[0],previous=t.previous_assignee_id??t.assignee_id,people=snapshot.operators||[];
 const person=people.find(u=>u.id===previous),eligible=person?.eligible&&person.status==='active';
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('closureToken',t.closure_token)+hidden('direction',t.type);
 return `<h2>Reopen task #${t.id}</h2><p class="work-help">Create a linked ${t.type==='put'?'put':'pick'} task. Earlier movements stay in this task’s history.</p>${form('reopen',fields+`<label>Product<select name="productId" required><option value="${first.product_id}" selected>${esc(first.product_name)}</option></select></label>`+input('quantity','Remaining quantity ('+first.unit_of_measure+')','number',`min="1" max="1000000000" step="1" inputmode="numeric" required value="${esc(t.remaining_quantity??0)}"`)+(t.remaining_quantity>0?'':'<p class="work-help">Nothing remains. Enter a quantity only if more work is needed.</p>')+`<label>Assigned to<select data-searchable name="assigneeId" required><option value="" ${previous==null?'selected':''}>Choose person</option>${previous!=null&&!person?`<option value="${previous}" selected disabled>Previous assignee unavailable</option>`:''}${people.map(u=>`<option value="${u.id}" ${u.id===previous?'selected':''} ${u.eligible&&u.status==='active'?'':'disabled'}>${esc(assigneeLabel(u)+(!u.eligible||u.status!=='active'?' — Unavailable':''))}</option>`).join('')}</select></label>`+(!eligible&&previous!=null?'<p class="work-help">Choose an active person who can take tasks.</p>':'')+'<div class="reopen-duration">'+input('dueDuration','Due in','number','min="0.016666666666666666" max="8760" step="any" required value="8"')+'<label>Unit<select name="dueUnit"><option value="minutes">Minutes</option><option value="hours" selected>Hours</option><option value="days">Days</option></select></label></div><button>Reopen and assign</button>','data-reopen-form')}`;
}
function taskHistoryContent(t){
 return `<header class="review-task-header"><button type="button" class="secondary" data-task-dialog-close>← Back</button><h2 tabindex="-1" autofocus>Task history</h2>${dismissDialog('task history')}</header>${checkTaskSummary(t)}<section data-task-timeline aria-live="polite"><p>Loading task history…</p></section>`;
}
let historyRead=0;
const historyTime=value=>value?esc(new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'medium'}))+' IST':'Not recorded';
function stockSnapshot(value,unit){return value==null?'Not recorded':esc(value)+' '+esc(unit||'');}
function activityRows(entries){return entries.map(e=>`<tr><td>${historyTime(e.time)}</td><td>${e.taskId?`<a href="/work/task-history?taskId=${e.taskId}">#${e.taskId}</a>`:'—'}</td><td>${esc(e.product||'—')}</td><td>${esc(e.location||'—')}</td><td>${esc(e.step)}${e.quantity==null?'':`<small>${e.quantity>0?'+':''}${esc(e.quantity)} ${esc(e.unit||'')}</small>`}${e.details?`<small>${esc(e.details)}</small>`:''}</td><td>${esc(e.assignedBy||'Not recorded')}</td><td>${esc(e.assignedTo||'Not recorded')}</td><td>${esc(e.actor||'Not recorded')}</td><td>${e.inventoryMovement?stockSnapshot(e.before,e.unit):'—'}</td><td>${e.inventoryMovement?stockSnapshot(e.after,e.unit):'—'}</td></tr>`).join('')||'<tr><td colspan="10">No matching history.</td></tr>';}
function activityTable(entries){return `<div class="table-wrap task-timeline-wrap" tabindex="0" role="region" aria-label="Task timeline"><table class="my-work-table task-timeline"><thead><tr>${['Timestamp (IST)','Task ID','Product','Cell','Change','Assigned By','Assigned To','Changed By','Details before','Details after'].map(v=>'<th scope="col">'+v+'</th>').join('')}</tr></thead><tbody>${activityRows(entries)}</tbody></table></div>`;}
function timelineMarkup(data){return activityTable(data.entries)+`<div class="history-pagination"><button type="button" class="secondary" data-history-page="${data.page.number-1}" ${data.page.number<=1?'disabled':''}>Previous</button><span>Page ${data.page.number} of ${data.page.pages} · ${data.page.total} events</span><button type="button" class="secondary" data-history-page="${data.page.number+1}" ${data.page.number>=data.page.pages?'disabled':''}>Next</button></div>`;}
function activityHistoryPage(){const q=new URLSearchParams(location.search),data=snapshot.activity||{entries:[],page:{number:1,pages:1,total:0}};return `<section class="my-work-list"><form method="get" action="/work/task-history" class="history-task-filter"><label>Task ID<input type="search" name="taskId" inputmode="numeric" value="${esc(q.get('taskId')||'')}" placeholder="All tasks"></label><button>Apply</button><a href="/work/task-history">Clear</a></form>${activityTable(data.entries)}${pageLinks(data.page)}</section>`;}

async function loadTaskHistory(taskId,page=1){
 const request=++historyRead,identity=key()+':'+snapshot.dataset,d=root.querySelector('[data-task-dialog]'),target=d?.querySelector('[data-task-timeline]');if(!target)return;
 target.setAttribute('aria-busy','true');
 try{
  const r=await fetch('/api/work/taskHistory?'+new URLSearchParams({taskId,page}),{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)}),data=await r.json();if(!r.ok)throw new Error(data.error||'History could not be loaded. Try again.');
  if(request!==historyRead||identity!==key()+':'+snapshot.dataset||!d.open||d.dataset.mode!=='details'||String(taskId)!==d.dataset.taskId)return;
  if(data.actorId!==snapshot.user.id||data.site!==snapshot.site||data.dataset!==snapshot.dataset)throw new Error('Account or warehouse changed. Reopen history.');
  target.innerHTML=timelineMarkup(data);const summary=d.querySelector('.check-summary-table');if(summary)summary.outerHTML=checkTaskSummary(data.task);
 }catch(error){if(request===historyRead&&target.isConnected)target.innerHTML='<p class="work-callout warning">'+esc(error.message)+'</p><button type="button" class="secondary" data-history-page="'+page+'">Retry</button>';}
 finally{if(request===historyRead)target.removeAttribute('aria-busy');}
}
function canStopTask(t){return !t.completed_at&&((t.assignee_id===snapshot.user.id&&(allowed('execute')||allowed('stop')))||(t.assignee_id!==snapshot.user.id&&allowed('teamStop')));}
function stopDialogContent(t){
 const mine=t.assignee_id===snapshot.user.id,handback=mine&&allowed('execute')?(untouchedOffer(t)?form('decline',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+input('reason','Reason (optional)')+input('note','Optional note')+'<button>Decline task</button>'):returnDialogContent(t).replace('<h2>Stop and hand back remaining work</h2>','')):'';
 return `<section class="check-workspace"><header class="review-task-header"><h2 tabindex="-1" autofocus>Stop remaining work</h2></header>${checkTaskSummary(t)}${closureForm(t)}${handback?disclosure('stop-handback-'+t.id,untouchedOffer(t)?'Decline task':'Hand back for reassignment',handback):''}</section>`;
}
function movementRecoveryForm(l){return form('report',allocationFields(l)+hidden('manual','true')+qty('Actual quantity ('+l.unit_of_measure+')')+`<label>Actual location<select name="cellId">${options(snapshot.cells,'id',c=>c.description?.name||c.logical_code,l.cell_id)}</select></label>`+input('reason','What happened?','text','required')+'<button>Save physical movement for review</button>','data-draft-kind="difference"');}
function recoveryDialogContent(l){return `<h2>Record what I moved</h2><p>${esc(l.product_name)} · ${esc(l.logical_code)}</p><p>Enter only work already done under these instructions. Do not repeat the movement.</p>${movementRecoveryForm(l)}`;}
function returnedRow(t){
 const e=t.return_event||{},blocked=returnBlocked(t),fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('returnEventId',e.id);
 const actions=allowed('assign')?`${t.assignment_state!=='returned'?'':e.acknowledgement?'<span>Seen by '+esc(e.acknowledgement.actor_name)+'</span>':form('acknowledgeReturn',fields+'<button class="secondary">Acknowledge</button>')}<button type="button" class="secondary" data-update-returned="${t.id}">Update task</button>`:'';
 return `<tr data-returned-row="${t.id}"><td><a href="/tasks/${t.id}">#${t.id} · ${t.type==='put'?'Put':'Pick'}</a></td><td>${taskProductLink(t)}</td><td>${esc(e.previous_name||t.assignee_name||'Unassigned')}</td><td>${esc(e.created_at?new Date(e.created_at).toLocaleString():'—')}</td><td class="return-note">${esc([e.reason,e.note].filter(Boolean).join(' · ')||'—')}</td><td>${esc(t.requested_quantity)} ${esc(t.lines?.[0]?.unit_of_measure)}</td><td>${esc(t.recorded_quantity)}</td><td>${esc(t.remaining_quantity)}</td><td>${blocked?(t.review_followup&&t.assignee_name?'Check assigned to '+esc(t.assignee_name):'Check moved quantity first'):'Needs assignment'}</td><td class="return-actions">${checkButton(t)}${actions}</td></tr>`;
}
function returnedTable(){
 if(!allowed('assign')&&!allowed('teamView'))return '';
 return `<section class="returned-work"><h2>Returned work / quantity checks · <span data-returned-count>${snapshot.returnedPage?.total??0}</span></h2><div class="table-wrap work-table-wrap" tabindex="0" role="region" aria-label="Returned work; scroll horizontally for all columns"><table class="returned-work-table"><thead><tr>${['Task','Product','Operator','Returned','Reason / note','Requested','Completed','Remaining','Status','Actions'].map(v=>'<th scope="col">'+v+'</th>').join('')}</tr></thead><tbody data-returned-table>${(snapshot.returnedTasks||[]).map(returnedRow).join('')||'<tr><td colspan="10">No returned work.</td></tr>'}</tbody></table></div><div data-returned-pages>${pageLinks(snapshot.returnedPage,'returnedPage')}</div></section>`;
}
function returnDialogContent(t){return `<h2>Stop and hand back remaining work</h2><p>${esc(taskName(t))} · ${esc(t.remaining_quantity)} ${esc(t.lines?.[0]?.unit_of_measure)} remaining</p><p>Recorded movements stay saved. Any uncertain movement must be checked before reassignment.</p>${form('handBack',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+'<label>Reason<select name="reason" required><option value="">Choose reason</option><option>Busy with other work</option><option>Unable to finish</option><option>Location or stock issue</option><option>Other</option></select></label>'+input('note','Optional note','text','maxlength="2000"')+'<button>Send back for reassignment</button>')}`;}
function returnedDialogContent(t){
 const completed=(t.lines||[]).filter(l=>l.execution_state==='settled');
 const history=`<h3>Completed movements</h3>${completed.length?'<div class="table-wrap"><table><thead><tr><th>Cell</th><th>Quantity</th><th>By</th></tr></thead><tbody>'+completed.map(l=>`<tr><td>${esc(l.logical_code)}</td><td>${esc(l.actual_quantity)} ${esc(l.unit_of_measure)}</td><td>${esc(l.attribution?.performer||'Unknown')}</td></tr>`).join('')+'</tbody></table></div>':'<p>No completed movements.</p>'}`;
 const due=t.due_at?new Date(t.due_at):null,localDue=due?new Date(due.getTime()-due.getTimezoneOffset()*60000).toISOString().slice(0,16):'';
 const blocked=returnBlocked(t);
 return `<h2>Update task #${t.id}</h2><p>${esc(t.type==='put'?'Put':'Pick')} ${esc(taskName(t))}</p>${history}${blocked?`<p class="work-callout warning">Check moved quantity first</p><p>Assign responsibility for this check. Remaining quantity stays provisional until verified.</p>${form('assignReview',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+`<p>Completed: ${esc(t.recorded_quantity)} · Remaining requested: ${esc(t.remaining_quantity)} ${esc(t.lines?.[0]?.unit_of_measure)}</p>`+operatorPicker(t)+input('reason','Assignment note (optional)','text','maxlength="2000"')+'<button>Assign quantity check</button>')}${allowed('review')?`<a href="${esc(reviewHref(t))}">Check moved quantity first</a>`:`<a href="/tasks/${t.id}">Open task for quantity review</a>`}`:form('updateReturned',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('returnEventId',t.return_event?.id)+hidden('progressToken',t.progress_token)+input('remainingQuantity','Remaining quantity ('+(t.lines?.[0]?.unit_of_measure||'')+')','number',`min="1" max="1000000000" step="1" required value="${esc(t.remaining_quantity)}"`)+operatorPicker(t)+`<p>Due: ${esc(due?due.toLocaleString():'No deadline')}</p>`+(allowed('deadline')?'<label class="work-check"><input type="checkbox" name="changeDue">Change due time</label>'+'<div data-due-edit hidden>'+input('dueAt','New due time','datetime-local',`disabled value="${localDue}"`)+'</div>':'')+input('reason','Assignment note (optional)','text','maxlength="2000"')+'<button>Save task</button>')}`;
}
function updateReturnedDue(f){if(f?.dataset.workAction==='updateReviewTask'){const editing=f.elements.deadlineChoice?.value==='duration',area=f.querySelector('[data-review-duration]');if(area)area.hidden=!editing;for(const name of ['duration','timeUnit'])if(f.elements[name])f.elements[name].disabled=!editing;return;}if(!f?.elements.changeDue)return;f.elements.dueAt.disabled=!f.elements.changeDue.checked;const editor=f.querySelector('[data-due-edit]');if(editor)editor.hidden=!f.elements.changeDue.checked;}
async function fetchDialogTask(id){
 const r=await fetch('/api/work/snapshot?taskId='+id,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error('Unable to open this task. Refresh your permissions and try again.');
 const fresh=await r.json();
 if(fresh.user.id!==snapshot.user.id||fresh.site!==snapshot.site||fresh.dataset!==snapshot.dataset)throw new Error('The signed-in account, warehouse or dataset changed. Reopen My work before updating this task.');
 const t=fresh.tasks.find(t=>t.id===id);if(!t)throw new Error('This task is no longer available. Refresh My work.');
 snapshot={...snapshot,capabilities:fresh.capabilities||snapshot.capabilities,cells:fresh.cells||snapshot.cells,operators:fresh.operators||snapshot.operators,tasks:snapshot.tasks.map(x=>x.id===id?t:x),watchedTasks:[t,...(snapshot.watchedTasks||[]).filter(x=>x.id!==id)]};
 return t;
}
// Modal history contains only navigation. Every mutation still requires an explicit submit.
function rememberModal(frame,navigation='push'){
 if(typeof window==='undefined'||!window.history)return;
 if(modalDepth===0){modalFrames.length=0;window.history.replaceState({...window.history.state,workModal:{session:modalSession,depth:0}},'');}
 if(navigation==='replace'&&modalDepth){modalFrames[modalDepth-1]=frame;window.history.replaceState({...window.history.state,workModal:{session:modalSession,depth:modalDepth}},'');}
 else{modalFrames.splice(modalDepth);modalFrames.push(frame);modalDepth++;window.history.pushState({...window.history.state,workModal:{session:modalSession,depth:modalDepth}},'');}
}
async function saveModalDrafts(){rememberOperationForm();const d=root.querySelector('[data-task-dialog]');for(const f of d?.querySelectorAll('form[data-work-action]')||[])await saveDraft(f);}
function modalError(error){const d=root.querySelector('[data-task-dialog]'),warning=d?.querySelector('[data-task-dialog-warning]');if(warning){warning.hidden=false;warning.textContent=error.message;}notice=error.message;}
async function modalBack(){if(bulkBusy||submitting)return;try{await saveModalDrafts();if(modalDepth&&typeof window!=='undefined')window.history.back();else{root.querySelector('[data-task-dialog]')?.close();root.querySelector('[data-operation-dialog]')?.close();}}catch(error){modalError(error);}}
async function handleModalPop(event){
 if(modalMoving){modalMoving=false;return;}
 const state=event.state?.workModal,target=state?.session===modalSession?state.depth:null;
 if(target===null){if(globalThis.WarehouseNavigation){if(location.pathname===path&&/^\/tasks\/\d+$/.test(path))render();return;}try{await pauseActiveWork();location.reload();}catch(error){notice=error.message;window.history.pushState({},'',path);render();}return;}
 if(bulkBusy||submitting){modalMoving=true;window.history.go(modalDepth-target);return;}
 try{await saveModalDrafts();}catch(error){modalMoving=true;window.history.go(modalDepth-target);modalError(error);return;}
 modalDepth=target;const frame=modalFrames[target-1],d=root.querySelector('[data-task-dialog]');
 if(!frame){root.querySelector('[data-operation-dialog]')?.close();d?.close();dirty=false;patchMyWorkRows();patchSelection();return;}
 // Never restore a popup from another account or dataset.
 if(frame.identity&&frame.identity!==key()+':'+snapshot.dataset){d?.close();root.querySelector('[data-operation-dialog]')?.close();return;}
 root.querySelector('[data-operation-dialog]')?.close();
 if(frame.mode==='operation'){openOperationDialog(frame,'restore');return;}
 if(frame.mode==='bulk-discard'){openBulkDialog('restore');return;}
 const mode=frame.mode.startsWith('check')&&!canCheckTask(frame.task)?'details':frame.mode;
 openTaskDialog(frame.task,mode,frame.lineId,'restore');
}
async function afterReviewSave(taskId,action){
 if(!modalDepth){render();if(action==='updateReviewTask')openTaskDialog(await fetchDialogTask(taskId),'check');return;}
 const fresh=await fetchDialogTask(taskId);
 for(const frame of modalFrames)if(frame.task?.id===taskId)frame.task=fresh;
 bulkTasks=bulkTasks.map(t=>t.id===taskId?fresh:t);bulkErrors.delete(taskId);
 let target=Math.max(0,modalDepth-1);
 if(action!=='updateReviewTask'&&(fresh.completed_at||fresh.closed_actuals)){
  selectedTasks.delete(taskId);bulkTasks=bulkTasks.filter(t=>t.id!==taskId);
  target=modalFrames.slice(0,modalDepth).findLastIndex(f=>f.mode==='bulk-discard')+1;
 }
 dirty=false;patchMyWorkRows();patchSelection();
 // Receipt is durable; remove the submitted form so Back cannot save it again.
 const d=root.querySelector('[data-task-dialog]');for(const f of d?.querySelectorAll('form[data-work-action]')||[])f.remove();
 if(modalDepth>target)window.history.go(target-modalDepth);else{d?.close();render();}
}
function canBulkDiscard(t){return !!t&&online&&allowed('teamStop')&&reviewVerifier(t)&&canCloseReview(t)&&!taskHasSavedUpdate(t);}
function changeTaskSelection(input){
 if(input.hasAttribute('data-select-all'))for(const t of myTasks().filter(canBulkDiscard)){if(input.checked)selectedTasks.add(t.id);else selectedTasks.delete(t.id);}
 else{const id=Number(input.dataset.selectTask);if(input.checked&&canBulkDiscard(availableTask(id)))selectedTasks.add(id);else selectedTasks.delete(id);}
 patchSelection();
}
function patchSelection(rebuild=false){
 if(rebuild){const head=root.querySelector('.my-work-table thead tr');if(head)head.innerHTML=workTableHead();const body=root.querySelector('[data-my-work-table]');if(body)body.innerHTML=myTasks().map(myTaskRow).join('')||'<tr><td colspan="15">No matching tasks.</td></tr>';}
 for(const box of root.querySelectorAll('[data-select-task]'))box.checked=selectedTasks.has(Number(box.dataset.selectTask));
 const eligible=myTasks().filter(canBulkDiscard),all=root.querySelector('[data-select-all]');if(all){const n=eligible.filter(t=>selectedTasks.has(t.id)).length;all.checked=eligible.length>0&&n===eligible.length;all.indeterminate=n>0&&n<eligible.length;all.disabled=!eligible.length;}
 const toggle=root.querySelector('[data-toggle-selection]');if(toggle){toggle.textContent=selectingTasks?'Done':'Select';toggle.setAttribute('aria-pressed',String(selectingTasks));}
 const button=root.querySelector('[data-bulk-discard]');if(button){button.hidden=!selectedTasks.size;button.textContent=`Discard All (${selectedTasks.size})`;}
}
function bulkTaskStale(t){const current=availableTask(t.id);return !current||current.assignment_generation!==t.assignment_generation||current.progress_token!==t.progress_token||current.closure_token!==t.closure_token||current.closure_case_revision!==t.closure_case_revision||!canBulkDiscard(current);}
async function startBulkDiscard(){
 if(!selectedTasks.size||!online)return;bulkErrors.clear();const list=[];
 for(const id of selectedTasks){try{const t=await fetchDialogTask(id);list.push(t);if(!canBulkDiscard(t))bulkErrors.set(id,'This task cannot be discarded. Review or remove it.');}catch(error){throw new Error(`Task #${id}: ${error.message}`);}}
 bulkTasks=list;openBulkDialog();
}
function bulkRows(){return bulkTasks.map(t=>`<tr data-bulk-row="${t.id}" class="${t.recorded_quantity>0?'has-movement':''}"><td>${taskProductLink(t)}<span class="bulk-recorded">${esc(t.recorded_quantity||0)} ${esc(t.lines?.[0]?.unit_of_measure)} moved</span></td><td>#${t.id} · ${t.type==='put'?'Put':'Pick'}</td><td>${esc(t.assignee_name||'Unassigned')}</td><td><div class="bulk-row-actions"><button type="button" class="secondary" data-bulk-remove="${t.id}">Remove</button><button type="button" data-bulk-update="${t.id}" ${allowed('assign')&&!t.completed_at?'':'disabled'}>Update Task</button><button type="button" data-bulk-review="${t.id}">Review</button></div><span data-bulk-row-error role="status">${esc(bulkErrors.get(t.id)||'')}</span></td></tr>`).join('');}
function openBulkDialog(navigation='push'){
 const d=root.querySelector('[data-task-dialog]');if(!d)return;
 if(navigation!=='restore')rememberModal({mode:'bulk-discard',identity:key()+':'+snapshot.dataset},navigation);
 d._identity={site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id};d.dataset.mode='bulk-discard';delete d.dataset.taskId;d.classList.add('check-dialog','bulk-dialog');
 d.innerHTML=`<section class="check-workspace"><header class="review-task-header"><button type="button" class="secondary" data-review-back>← Back</button><h2 tabindex="-1">Discard selected tasks</h2></header><div class="table-wrap bulk-table-wrap"><table class="bulk-discard-table"><thead><tr><th>Partially moved products</th><th>Task</th><th>Assigned to</th><th>Action</th></tr></thead><tbody>${bulkRows()||'<tr><td colspan="4">No tasks selected.</td></tr>'}</tbody></table></div><form data-bulk-discard-form><div ${bulkTasks.length?'':'hidden'}><label class="work-check"><input type="checkbox" name="confirmed" required>I confirm work has stopped and the shown totals are final for every selected task.</label><button class="danger" data-confirm-bulk ${bulkTasks.length?'':'disabled'}>Discard All (${bulkTasks.length})</button></div><p class="form-feedback" role="status"></p></form><p data-task-dialog-warning class="work-callout warning" role="status" hidden></p></section>`;
 d.oncancel=e=>{e.preventDefault();void modalBack();};if(!d.open)d.showModal();d.querySelector('h2').focus();patchBulkDialog();
}
function patchBulkDialog(){
 const d=root.querySelector('[data-task-dialog]');if(d?.dataset.mode!=='bulk-discard')return;
 const identity=d._identity,wrong=identity&&(identity.site!==snapshot.site||identity.dataset!==snapshot.dataset||identity.actorId!==snapshot.user.id);
 for(const t of bulkTasks){const row=d.querySelector(`[data-bulk-row="${t.id}"]`);if(!row)continue;const error=row.querySelector('[data-bulk-row-error]');error.textContent=bulkErrors.get(t.id)||(wrong?'Account changed. Reopen My Work.':bulkTaskStale(t)?'Task changed. Review or remove it before discarding.':'');}
 const save=d.querySelector('[data-confirm-bulk]');if(save)save.disabled=bulkBusy||!online||wrong||!bulkTasks.length||bulkTasks.some(t=>bulkTaskStale(t)||bulkErrors.has(t.id));
}
function discardRequest(t){
 const input={taskId:t.id,generation:t.assignment_generation,progressToken:t.progress_token,closureToken:t.closure_token,currentStatus:'yes',workerStopped:true};
 if(t.closure_review_id)return {action:'resolve',input:{...input,reportId:t.closure_review_id,caseRevision:t.closure_case_revision}};
 return {action:'closeTask',input:{...input,verifiedClosure:true}};
}
async function submitBulkDiscard(f){
 if(bulkBusy||submitting||!f.elements.confirmed.checked)return;bulkBusy=true;const feedback=f.querySelector('.form-feedback');let closed=0;
 try{
  const d=f.closest('[data-task-dialog]'),identity=d._identity;
  if(!online||identity.site!==snapshot.site||identity.dataset!==snapshot.dataset||identity.actorId!==snapshot.user.id)throw new Error('Reconnect with the same account before discarding.');
  if(outbox.some(o=>currentSavedUpdate(o)&&['local','sending','error','rejected'].includes(o.state)&&o.action==='manual'))throw new Error('Confirm saved movements before discarding.');
  const tasks=[...bulkTasks];
  if(tasks.some(bulkTaskStale))throw new Error('Some tasks changed. Review or remove them first.');
  // Each confirmed task has its own durable receipt; a retry cannot close it twice.
  for(const t of tasks){
   if(identity.site!==snapshot.site||identity.dataset!==snapshot.dataset||identity.actorId!==snapshot.user.id)throw new Error('The account or warehouse changed. Remaining tasks were not submitted.');
   if(bulkTaskStale(t)){bulkErrors.set(t.id,'Task changed. Review it again.');continue;}
   const {action,input:values}=discardRequest(t),id=uid(),input={...values,requestId:id,site:identity.site,dataset:identity.dataset,actorId:identity.actorId,deviceId};
   await store('outbox','readwrite',s=>s.put({id,partition:key(),action,input,state:'local',message:'Discard awaiting warehouse confirmation.',createdAt:new Date().toISOString()}));
   outbox=await all('outbox');await sync();const received=outbox.find(o=>o.id===id);
   if(received?.result?.closed){closed++;selectedTasks.delete(t.id);bulkTasks=bulkTasks.filter(x=>x.id!==t.id);bulkErrors.delete(t.id);}
   else{bulkErrors.set(t.id,received?.message||'Not confirmed. Retry the saved request from Work tools.');if(!online)break;}
   feedback.textContent=`${closed} task${closed===1?'':'s'} discarded.`;
  }
  notice=`${closed} task${closed===1?'':'s'} discarded.${bulkTasks.length?' Remaining tasks need attention.':''}`;
 }catch(error){notice=error.message;}
 finally{bulkBusy=false;openBulkDialog('replace');const output=root.querySelector('[data-bulk-discard-form] .form-feedback');if(output)output.textContent=notice;patchMyWorkRows();patchSelection();}
}

function openTaskDialog(t,mode,lineId=null,navigation='push'){
 const d=root.querySelector('[data-task-dialog]');if(!d)return;
 const l=t.lines.find(l=>l.id===Number(lineId));
 if(['check','check-align','check-assignment','check-discard'].includes(mode)&&!canCheckTask(t)||mode==='stop'&&!canStopTask(t)||mode==='recovery'&&(!l||l.canAct===false)||mode==='reopen'&&!canReopenTask(t))return;
 if(navigation!=='restore')rememberModal({task:t,mode,lineId,identity:key()+':'+snapshot.dataset},navigation);
 if(!d.open){d._opener=document.activeElement;d._identity={site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id};}d._task=t;
 d.dataset.taskId=t.id;d.dataset.generation=t.assignment_generation;d.dataset.progressToken=t.progress_token;d.dataset.mode=mode;d.classList?.remove?.('bulk-dialog');d.classList?.toggle('history-dialog',mode==='details');d.classList?.toggle('check-dialog',['edit','check','check-align','check-assignment','check-discard','stop'].includes(mode));d.dataset.closureToken=t.closure_token||'';d.dataset.lineId=l?.id||'';d.dataset.revision=l?.revision||'';
 let content=mode==='edit'?taskEditorContent(t):mode==='reopen'?reopenTaskContent(t):mode==='details'?taskHistoryContent(t):mode==='stop'?stopDialogContent(t):mode==='check'?checkDialogContent(t):mode==='check-align'?reviewMovementContent(t):mode==='check-assignment'?reviewAssignmentContent(t):mode==='check-discard'?discardContent(t):mode==='recovery'?recoveryDialogContent(l):mode==='update'?returnedDialogContent(t):returnDialogContent(t);
 if(!['edit','check','check-align','check-assignment','check-discard'].includes(mode)){if(mode==='stop')content=content.replace('<header class="review-task-header">','<header class="review-task-header"><button type="button" class="secondary" data-review-back>← Back</button>');else content=content.replace(/<h2>(.*?)<\/h2>/,'<header class="review-task-header"><button type="button" class="secondary" data-review-back>← Back</button><h2>$1</h2></header>');}
 if(['reopen','recovery','update'].includes(mode))content=content.replace('</header>',dismissDialog(mode==='reopen'?'reopen task':mode==='recovery'?'movement entry':'task editor')+'</header>');
 d.innerHTML=content+'<p data-task-dialog-warning class="work-callout warning" role="status" hidden></p><button type="button" class="secondary" data-task-dialog-close>'+ (mode==='stop'?'Back':'Close')+'</button>';
 if(['edit','details','check','check-align','check-assignment','check-discard'].includes(mode))d.querySelector('[data-task-dialog-close]:last-child')?.remove();
 d.setAttribute?.('aria-label',mode==='edit'?'Task editor':mode==='reopen'?'Reopen task':mode==='recovery'?'Record what I moved':['check','check-align','check-assignment','check-discard'].includes(mode)?'Review task':mode==='details'?'Task details and history':mode==='stop'?'Stop remaining work':'Task action');
 for(const f of d.querySelectorAll('form')){f._workIdentity={...d._identity};f._draftPath=path;}
 restoreDrafts();const f=d.querySelector('form');if(mode==='check-discard'&&f?.elements.workerStopped)f.elements.workerStopped.checked=false;updateReturnedDue(f);if(f?.dataset.workAction==='updateReviewTask'&&f.elements.timeUnit)f.elements.duration.dataset.timeUnit=f.elements.timeUnit.value;
 d.oncancel=e=>{e.preventDefault();void modalBack();};d.onclose=()=>{d._opener?.focus?.();};if(!d.open)d.showModal();if(['edit','check','check-align','check-assignment','check-discard','stop'].includes(mode))d.querySelector('.review-task-header h2')?.focus?.();patchTaskDialog();if(mode==='details')void loadTaskHistory(t.id);
}
function patchTaskDialog(){
 const d=root.querySelector('[data-task-dialog]');if(!d?.open)return;
 if(d.dataset.mode==='bulk-discard'){patchBulkDialog();return;}
 if(d.dataset.mode==='details')return;
 const t=availableTask(d.dataset.taskId);
 const identityChanged=d._identity&&(d._identity.site!==snapshot.site||d._identity.dataset!==snapshot.dataset||d._identity.actorId!==snapshot.user.id);
 if(!identityChanged&&d.dataset.mode==='reopen'&&t?.reopened_task_id){const f=d.querySelector('[data-reopen-form]');if(f)f.outerHTML=`<p role="status">Reopened as <a href="/tasks/${t.reopened_task_id}">Task #${t.reopened_task_id}</a>.</p>`;return;}
 const changed=!t||String(t.assignment_generation)!==d.dataset.generation||t.progress_token!==d.dataset.progressToken||(['stop','check-align','check-discard'].includes(d.dataset.mode)||d.querySelector('[data-task-closure]'))&&t.closure_token!==d.dataset.closureToken;
 const pendingSave=pendingPhysicalSave(d.dataset.taskId);
 if(pendingSave&&!identityChanged){
  const warning=d.querySelector('[data-task-dialog-warning]');warning.hidden=false;warning.innerHTML=physicalSaveStatus(pendingSave);
  d._physicalLocked||=new Map();
  for(const el of d.querySelectorAll('form input,form select,form button,[data-review-align],[data-review-assignment],[data-review-discard]')){if(!d._physicalLocked.has(el))d._physicalLocked.set(el,el.disabled);el.disabled=true;}
  return;
 }
 if(d._physicalLocked){for(const [el,disabled] of d._physicalLocked)el.disabled=disabled;d._physicalLocked=null;}
 const recovery=d.dataset.mode==='recovery';
 const stale=identityChanged||(!recovery&&(!online||changed||t&&taskHasSavedUpdate(t)))||(d.dataset.mode==='reopen'&&t&&!canReopenTask(t))||(d.dataset.mode==='edit'&&d.querySelector('[data-review-assignment-form]')&&(!t||!canEditTask(t)))||(d.dataset.mode==='check-assignment'&&!allowed('assign'))||(d.dataset.mode==='update'&&t&&(!allowed('assign')||t.assignment_state!=='returned'&&!returnBlocked(t)))||(['check','check-align','check-assignment','check-discard'].includes(d.dataset.mode)&&t&&!canCheckTask(t))||(d.dataset.mode==='stop'&&t&&!canStopTask(t));
 const warning=d.querySelector('[data-task-dialog-warning]');warning.hidden=!(stale||recovery&&changed);warning.textContent=recovery&&!identityChanged?'These instructions changed. Your original draft stays attached to them; report only work already done.':'This task or account changed. Your draft is kept; close and check the latest task before saving.';
 for(const button of d.querySelectorAll('form button:not([type="button"])')){const f=button.closest?.('[data-task-assignee]');button.disabled=!!(stale||f&&assigneeFormStale(f,t)||button.hasAttribute?.('data-close-task')&&(['check-align','check-discard'].includes(d.dataset.mode)?!canCloseReview(t):t?.assignee_id!==snapshot.user.id&&!(allowed('resolve')&&allowed('resolveStop'))));}
 for(const button of d.querySelectorAll('[data-review-align],[data-review-assignment],[data-review-discard]'))button.disabled=!!(stale||button.hasAttribute?.('data-review-assignment')&&(!allowed('assign')||t?.closed_actuals||t?.completed_at)||button.hasAttribute?.('data-review-discard')&&!canCloseReview(t));
 for(const button of d.querySelectorAll('[data-check-stop]'))button.disabled=!!stale;
 patchTaskAssignees();
}
function toggleCheckStop(button){
 const d=button.closest('[data-task-dialog]'),panel=d.querySelector('[data-check-stop-panel]');if(!panel||button.disabled)return;
 panel.hidden=!panel.hidden;for(const b of d.querySelectorAll('[data-check-stop]'))b.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden){panel.focus();panel.scrollIntoView({block:'nearest'});}
}
function requireSavedCheckObservation(f){
 if(!['assignReview','reassign','updateReturned','stop','closeTask','sendTaskReview','handBack','decline'].includes(f.dataset.workAction))return;
 const d=f.closest?.('[data-task-dialog]');if(d?.dataset.mode!=='check')return;
 if([...d.querySelectorAll('form[data-work-action="observeReview"]')].some(form=>form.elements.quantity?.value?.trim()||form.elements.note?.value?.trim()))throw new Error('Save your observation first, or clear it before changing this task.');
}
function availableTask(id){return [...snapshot.tasks,...(snapshot.returnedTasks||[]),...(snapshot.watchedTasks||[])].find(t=>String(t.id)===String(id));}
function assigneeFormStale(f,t,selection=true){
 const identity=f._workIdentity,dialog=f.closest?.('[data-task-dialog]');
 return !online||!t||identity&&(identity.site!==snapshot.site||identity.dataset!==snapshot.dataset||identity.actorId!==snapshot.user.id)||assignmentEditAction(t)!==f.dataset.workAction||String(t.assignment_generation)!==f.elements.generation.value||t.progress_token!==f.elements.progressToken.value||taskHasSavedUpdate(t)||dialog?.dataset.mode==='check'&&!canCheckTask(t)||selection&&(!f.elements.assigneeId.value||Number(f.elements.assigneeId.value)===t.assignee_id);
}
function patchTaskAssignees(){
 for(const f of root.querySelectorAll('[data-task-assignee]')){const t=availableTask(f.elements.taskId.value);for(const b of f.querySelectorAll('button:not([type="button"])'))b.disabled=!!assigneeFormStale(f,t);f.elements.assigneeId.disabled=!!assigneeFormStale(f,t,false);}
}
function patchReturnedRows(){
 patchTaskDialog();const body=root.querySelector('[data-returned-table]');if(!body)return;
 const active=document.activeElement,desired=snapshot.returnedTasks||[],wanted=new Set(desired.map(t=>String(t.id)));
 for(const row of body.querySelectorAll('[data-returned-row]'))if(!wanted.has(row.dataset.returnedRow)&&!row.contains(active))row.remove();
 if(!body.querySelector('[data-returned-row]'))body.innerHTML='';
 for(const t of desired){const row=body.querySelector('[data-returned-row="'+t.id+'"]');if(row?.contains(active))continue;if(row)row.outerHTML=returnedRow(t);else body.insertAdjacentHTML('beforeend',returnedRow(t));}
 if(!body.children.length)body.innerHTML='<tr><td colspan="10">No returned work.</td></tr>';
 const count=root.querySelector('[data-returned-count]');if(count)count.textContent=snapshot.returnedPage?.total??0;
 const pages=root.querySelector('[data-returned-pages]');if(pages&&!pages.contains(active))pages.innerHTML=pageLinks(snapshot.returnedPage,'returnedPage');
}
function cellConfirmation(l,stage){
 const t=availableTask(l.task_id),kind=l.type==='put'?'Put':'Pick';
 if(!t)return '';
 const fields=allocationFields(l,false)+hidden('method',stage.method)+hidden('location',stage.location||'')+hidden('manualReason',stage.reason||'Operator confirmed this cell without scanning')+hidden('cellCompletion','true')+`<div class="cell-confirmation-fields"><label>Actual location<select data-searchable name="cellId" required>${options(snapshot.cells||[],'id',c=>c.description?.name||c.logical_code,l.cell_id)}</select></label><label>Actual quantity<span class="work-quantity-input"><input name="quantity" type="number" min="0" max="1000000000" step="1" inputmode="numeric" required value="${esc(l.planned_quantity)}"><span>${esc(l.unit_of_measure)}</span></span></label></div><label class="work-check" data-cell-difference hidden><input type="checkbox" name="differenceConfirmed">I checked the changed location or quantity.</label><button>Complete ${kind} at this location</button>`;
 return `<dialog class="task-edit-dialog cell-confirmation-dialog" data-cell-confirmation aria-label="Confirm ${kind.toLowerCase()} at this location"><h2 tabindex="-1">Confirm ${kind} at this location</h2><p class="cell-confirmation-product"><strong>${esc(l.product_name)}</strong> · ${esc(l.logical_code)}</p><p>${esc(l.planned_quantity)} ${esc(l.unit_of_measure)} planned here. ${stage.method==='camera'?'QR checked.':'Check the cell label: no QR scan was made.'}</p>${form('report',fields,'data-cell-confirmation-form data-draft-kind="cell-confirmation" data-planned-cell="'+l.cell_id+'" data-planned-quantity="'+esc(l.planned_quantity)+'"')}<button type="button" class="secondary" data-close-cell-confirmation>Back to task</button></dialog>`;
}
function updateCellConfirmation(f){
 if(!f?.hasAttribute?.('data-cell-confirmation-form'))return;
 const box=f.querySelector('[data-cell-difference]');if(!box)return;
 const changed=Number(f.elements.cellId.value)!==Number(f.dataset.plannedCell)||Number(f.elements.quantity.value)!==Number(f.dataset.plannedQuantity);
 box.hidden=!changed;box.querySelector('input').required=changed;if(!changed)box.querySelector('input').checked=false;
}
function openCellConfirmation(){const dialog=root.querySelector('[data-cell-confirmation]');if(dialog&&!dialog.open){dialog.showModal();dialog.querySelector('h2')?.focus();}}
function nextSubtaskId(t,currentId){
 const lines=(t?.lines||[]).filter(l=>['ready','working'].includes(l.execution_state)&&!(l.reports||[]).some(r=>['review','received'].includes(r.status)));
 if(lines.length<2)return null;
 const index=lines.findIndex(l=>l.id===currentId);
 return lines[(index+1)%lines.length]?.id||null;
}
function cellActionDialog(l){
 const cancelForm=form('cancel',allocationFields(l)+hidden('zeroConfirmed','true')+
  '<label class="work-check"><input type="checkbox" required>Nothing moved at this location.</label><button>Cancel this location</button>');
 const replan=l.type==='put'&&l.execution_state==='ready'?form('replan',hidden('lineId',l.id)+hidden('revision',l.revision)+
  `<label>New location<select data-searchable name="cellId" required><option value="">Choose a location</option>${options((snapshot.cells||[]).filter(c=>c.id!==l.cell_id),'id',c=>c.description?.name||c.logical_code)}</select></label>`+
  `<label>Planned quantity<span class="work-quantity-input"><input name="quantity" type="number" min="1" max="1000000000" step="1" inputmode="numeric" required value="${esc(l.planned_quantity)}"><span>${esc(l.unit_of_measure)}</span></span></label>`+
  '<label class="work-check"><input type="checkbox" required>Nothing moved at the original location.</label><button>Save new location</button>'):'';
 const rejectForm=form('rejectCell',allocationFields(l)+hidden('zeroConfirmed','true')+
  `<label>Why can't you finish here?<select name="reason" required><option value="">Choose a reason</option><option>Location is full</option><option>Different product is here</option><option>Insufficient quantity</option><option>Location cannot be reached</option><option>Other</option></select></label>`+
  input('note','Details (required for Other)')+
  '<label class="work-check"><input type="checkbox" required>Nothing moved at this location.</label><button>Send to supervisor</button>');
 const uncertainForm=form('askReview',allocationFields(l)+input('reason','What is uncertain?','text','required')+'<button>Ask supervisor to check</button>');
 return `<dialog class="task-edit-dialog cell-action-dialog" data-cell-action-dialog aria-label="Cell options"><header class="review-task-header"><h2 tabindex="-1">${esc(l.logical_code)} · ${esc(l.type==='put'?'Put':'Pick')} ${esc(l.planned_quantity)} ${esc(l.unit_of_measure)}</h2><button type="button" class="dialog-dismiss" data-close-cell-action aria-label="Close cell options" title="Close"><span aria-hidden="true">×</span></button></header>
  <div class="cell-action-choices" aria-label="Choose a cell action"><button type="button" class="secondary" data-cell-action-choice="cancel" aria-pressed="true">Cancel</button>${replan?'<button type="button" class="secondary" data-cell-action-choice="replan" aria-pressed="false">Change location</button>':''}<button type="button" class="secondary" data-cell-action-choice="help" aria-pressed="false">Need help</button></div>
  <section data-cell-action-panel="cancel"><p>Use this only if nothing moved at this cell.</p>${cancelForm}</section>
  ${replan?`<section data-cell-action-panel="replan" hidden><p>Change the plan before moving any stock. The light will follow the new location.</p>${replan}</section>`:''}
  <section data-cell-action-panel="help" hidden><h3>Cannot finish this cell?</h3>${rejectForm}<h3>Not sure what moved?</h3>${uncertainForm}<button type="button" class="secondary" data-record-moved="${l.id}">Record a known quantity instead</button></section>
  <button type="button" class="secondary" data-close-cell-action>Back to task</button></dialog>`;
}
function lineCard(l){
 const active=['ready','working'].includes(l.execution_state),working=l.execution_state==='working',executing=lineActive(l);
 const waiting=l.reports?.filter(r=>['review','received'].includes(r.status))||[];
 const saved=outbox.some(o=>o.partition===key()&&Number(o.input.lineId)===l.id&&['local','sending','error','rejected'].includes(o.state));
 const stage=stages.get(stageKey(l));
 const recovery=`<button type="button" class="secondary" data-record-moved="${l.id}">Record what I moved</button>`;
 let actions='';
 if(active&&l.canAct!==false){
  if(saved)actions='<button disabled>Update saved — waiting for warehouse confirmation</button>';
  else if(waiting.length||!online||!executing)actions=recovery;
  else {
   if(!working)actions=`<p class="work-callout" data-guidance-line="${l.id}" role="status">${guidanceMarkup(l)}</p><button type="button" class="secondary" data-refresh-guidance>Refresh light</button>`+form('acquire',allocationFields(l)+hidden('method','arrival')+"<button>I'm at this location</button>");
   else if(!stage)actions=`<p class="work-callout" data-guidance-line="${l.id}" role="status">${guidanceMarkup(l)}</p><button type="button" data-scan-line="${l.id}">Scan QR</button><button type="button" class="secondary" data-manual-summary="${l.id}">Confirm without scanning</button>${disclosure('cell-help-'+l.id,'Help',`<button type="button" class="secondary" data-refresh-guidance>Refresh light</button>`)}`;
   else actions=`<p class="work-callout" role="status">${stage.method==='camera'?'QR checked':'Location confirmed without scanning'}. Check what you moved at this cell.</p><button type="button" data-open-cell-confirmation>Complete ${esc(l.type)} at this location</button>${disclosure('cell-help-'+l.id,'Help',`<button type="button" class="secondary" data-refresh-guidance>Refresh light</button><button type="button" class="secondary" data-scan-line="${l.id}">Scan QR again</button>`)}${cellConfirmation(l,stage)}`;
   const next=nextSubtaskId(availableTask(l.task_id),l.id);
   actions+=`<div class="task-cell-next-actions"><button type="button" class="secondary" data-open-cell-action="${l.id}">Cancel this location</button>${next?`<button type="button" class="secondary" data-next-subtask="${next}">Next subtask</button>`:''}</div>${cellActionDialog(l)}`;
  }
 } else if(l.execution_state==='settled'&&l.canAct!==false)actions=disclosure('correct-'+l.id,'Correct earlier quantity',form('correct',allocationFields(l)+qty('Correct actual quantity')+input('verification','Correction reason','text','required')+'<button>Save correction</button>'));
 if(!active&&workActive(availableTask(l.task_id))){const next=nextSubtaskId(availableTask(l.task_id),l.id);if(next)actions+=`<div class="task-cell-next-actions"><button type="button" class="secondary" data-next-subtask="${next}">Next subtask</button></div>`;}
 const others=(snapshot.contents||[]).filter(c=>c.cell_id===l.cell_id&&c.product_id!==l.product_id);
 const here=(snapshot.contents||[]).find(c=>c.cell_id===l.cell_id&&c.product_id===l.product_id);
 return `<article class="allocation" data-line="${l.id}" data-light-revision="${l.revision}" data-light-generation="${l.current_generation}" data-light-binding="${l.directions?.bindingRevision??l.binding_revision}"><div class="work-card-heading"><span class="work-eyebrow">${esc(l.type)}</span>${badge(l.guidance?.state==='waiting'?'Waiting for location':l.guidance?.state==='blocked'?'Needs attention':status(l.execution_state),l.execution_state==='settled'?'good':'')}</div><h2 class="directions">${esc(locationHeading(l))}</h2>${locationDetails(l)?`<p class="cell-code">${esc(locationDetails(l))}</p>`:''}<p class="work-product">${taskProductLink({lines:[l],summary:l.product_name})} <span>${esc(l.sku)}</span></p><p class="work-help">Current stock here: ${here?esc(here.available_quantity):'0'} ${esc(l.unit_of_measure)}</p><div class="work-quantity"><strong>${esc(l.execution_state==='settled'?l.actual_quantity:l.planned_quantity)}</strong><span>${esc(l.unit_of_measure)}<small>${l.execution_state==='settled'?'actual recorded':active?(l.review_followup?'originally planned':'planned at this cell'):'closed plan — do not execute'}</small></span></div>${active&&executing?`<div class="task-cell-tools"><button type="button" class="secondary" data-refresh-guidance>Ping light</button><button type="button" class="secondary locate-button" data-locate-cell data-cell-id="${l.cell_id}" aria-pressed="false">Locate</button></div>`:''}${l.attribution?`<p class="work-help">Performed by ${esc(l.attribution.performer||'Unknown')} · Entered by ${esc(l.attribution.reporter)}${l.attribution.reviewer?' · Verified by '+esc(l.attribution.reviewer):''}</p>`:''}${waiting.map(r=>`<p class="work-callout warning">Needs review: ${esc(reviewInstruction(r))}</p>`).join('')}${saved?'<p class="work-callout">Saved on this phone. Do not repeat the movement.</p>':''}${l.review_followup?'<p class="work-callout">Observation only. Save what you checked above; do not repeat the movement.</p>':l.canAct===false?'<p class="work-callout">View only. Start the assignment if it belongs to you; another operator’s work cannot be executed here.</p>':''}${actions}${others.length?disclosure('contents-'+l.id,'Other items here',others.map(c=>`<p>${esc(c.name)} · ${esc(c.available_quantity)} ${esc(c.unit_of_measure)}</p>`).join('')):''}</article>`;
}
function untouchedOffer(t){return t.assignment_source!=='self'&&t.assignment_state==='offered'&&!t.attention&&!(t.recorded_quantity>0)&&(t.lines||[]).every(l=>['ready','cancelled','superseded'].includes(l.execution_state)&&!l.started_at&&!l.reports?.length);}
function assignmentActions(t){
 if(!workActive(t)&&myTaskActionable(t)&&executionLines(t).length)return activationForm(t)+checkButton(t);
 return checkButton(t);
}
function workReturn(){const value=new URLSearchParams(location.search).get("return_to")||"";return /^\/(products|cells)([/?#]|$)/.test(value)?value:"";}
function taskFinishDialog(t,ready){
 const short=ready.length>0||Number(t.recorded_quantity)!==Number(t.requested_quantity)||t.attention;
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('closureToken',t.closure_token)+hidden('currentStatus','yes')+hidden('finalTaskCompletion','true')+hidden('taskFinish','true')+hidden('verification','Operator confirmed the final task state after cell-by-cell recording')+(short?'<label class="work-check"><input type="checkbox" name="unfinishedConfirmed" required>I understand the unfinished work will go to supervisor review.</label>':'')+'<button>Complete Task</button>';
 return `<dialog class="task-edit-dialog task-finish-dialog" data-task-finish-dialog aria-label="Complete task"><h2 tabindex="-1">Complete Task #${t.id}</h2><p>${esc(t.recorded_quantity)} of ${esc(t.requested_quantity)} ${esc(t.lines[0]?.unit_of_measure)} recorded.</p>${ready.length?`<p>Locations still to do:</p><div class="task-unfinished-list">${ready.map(l=>`<button type="button" class="secondary" data-go-unfinished="${l.id}">${esc(l.logical_code)} · ${esc(l.type)} ${esc(l.planned_quantity)} ${esc(l.unit_of_measure)}</button>`).join('')}</div>`:''}${short?'<p class="work-callout warning">Closing now sends the unfinished work to a supervisor. Recorded cells stay recorded.</p>':''}${form(short?'sendTaskReview':'closeTask',fields,'data-task-finish data-draft-kind="task-finish"')}<button type="button" class="secondary" data-close-task-finish>Back to task</button></dialog>`;
}
function taskPage(id){
 const t=snapshot.tasks.find(t=>t.id===Number(id));if(!t)return '<section class="work-empty">Reconnect to open your task.</section>';
 const live=t.lines.filter(l=>!['superseded'].includes(l.execution_state));
 const ready=live.filter(l=>['ready','working'].includes(l.execution_state));
 const selected=Number(new URLSearchParams(location.search).get('line'));
 const primary=live.find(l=>l.id===selected)||ready.find(l=>l.execution_state==='working')||ready.find(l=>!['waiting','blocked'].includes(l.guidance?.state))||ready[0]||live[0];
 const closed=!t.attention&&(['completed','stopped','cancelled'].includes(t.outcome)||Boolean(t.completed_at));
 const locations=!t.review_followup&&live.length?`<nav class="task-location-list" data-task-cells aria-label="Task locations">${live.map(l=>`<a class="task-location-card ${l.execution_state==='settled'?'is-complete':''}" ${workActive(t)?'data-active-location="'+l.id+'"':''} href="/tasks/${t.id}?line=${l.id}" ${l===primary?'aria-current="true"':''}><strong>${esc(l.logical_code)}</strong><span>${esc(l.type==='put'?'Put':'Pick')} ${esc(l.execution_state==='settled'?l.actual_quantity:l.planned_quantity)} ${esc(l.unit_of_measure)}</span>${!['ready','working'].includes(l.execution_state)?`<small>${esc(status(l.execution_state))}</small>`:l.guidance?.state==='waiting'?'<small>Waiting for light</small>':''}</a>`).join('')}</nav>`:'';
 const finish=workActive(t)&&!t.review_followup&&!t.closure_review_id&&allowed('stop');
 return `<section class="task-work-screen"><header class="task-work-intro"><a href="${esc(workReturn()||'/work')}">← ${workReturn()?'Back to stock':'My work'}</a><div class="task-title-row"><h2>Task #${t.id} · ${esc(taskName(t))}</h2><div class="task-title-actions">${assignmentActions(t)}</div></div></header>${taskContext(t)}${followupPanel(t)}${locations}${!t.review_followup&&primary?lineCard(primary):''}${closed?'<p><a class="work-primary" href="/work">Back to My work</a></p>':''}${t.instruction_note?`<p class="work-help">${esc(t.instruction_note)}</p>`:''}<footer class="task-bottom-actions">${finish?`<button type="button" data-complete-task>Complete Task</button>${taskFinishDialog(t,ready)}`:''}${canStopTask(t)?`<button type="button" class="secondary" data-task-stop="${t.id}">Stop remaining work</button>`:''}<button type="button" class="secondary" data-task-details="${t.id}">Task details and history</button></footer></section>`;
}

function pageLinks(info,key='page') {
 if(!info)return '';const q=new URLSearchParams(location.search),url=n=>{const v=new URLSearchParams(q);v.set(key,n);return path+'?'+v;};
 return `<nav class="work-pagination" aria-label="${key==='returnedPage'?'Returned work':key==='page'?'Task':'Review'} pages"><span>${info.total} matching · Page ${info.number} of ${info.pages} · Up to ${info.limit||100} rows</span>${info.number>1?`<a href="${esc(url(info.number-1))}">Previous page</a>`:''}${info.number<info.pages?`<a href="${esc(url(info.number+1))}">Next page / older records</a>`:''}</nav>`;
}
function assigneeLabel(u){const role=u.role_name||(u.role==='admin'?'Admin':u.role==='operator'?'Operator':u.role)||'User',count=u.assignedTaskCount??u.open??0;return `${u.name} · ${u.username} · ${role} · ${count} assigned ${count===1?'task':'tasks'}`;}
function operatorPicker(t){const eligible=(snapshot.operators||[]).filter(u=>u.eligible&&u.status!=='inactive');return `<label>Assign to<select data-searchable name="assigneeId" required><option value="">Choose operator</option>${options(eligible,'id',assigneeLabel)}</select></label>`;}
function reassignForm(t){return t.closed_actuals||t.closure_review_id||!allowed('assign')||t.attention||(t.completed_at&&t.outcome!=='stopped')||['completed','cancelled'].includes(t.outcome)?'':form('reassign',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+operatorPicker(t)+input('reason','Assignment note (optional)')+'<button>Save</button>');}
function taskRow(t){
 const mine=t.assignee_id===snapshot.user.id,closed=['completed','stopped','cancelled'].includes(t.outcome)||t.completed_at;
 const untouched=(t.lines||[]).every(l=>['ready','cancelled','superseded'].includes(l.execution_state)&&!l.started_at&&!l.reports?.length);
 const saved=outbox.some(o=>currentSavedUpdate(o)&&['local','sending','error','rejected','activation-pending','activation-unknown','review-saving','review-unknown'].includes(o.state)&&(Number(o.input.taskId)===t.id||(t.lines||[]).some(l=>l.id===Number(o.input.lineId))));
 const reasons=[...new Set((t.lines||[]).flatMap(l=>(l.reports||[]).filter(r=>['received','review'].includes(r.status)).map(r=>r.quantity_known===0?'Quantity not confirmed':r.reason)))];
 const label=t.attention?'Waiting for supervisor — '+(reasons[0]||'reported quantity needs checking'):outcome(t);
 const actualPeople=[...new Set((t.lines||[]).filter(l=>l.attribution).map(l=>l.attribution.performer||'Unknown'))];
 const reporters=[...new Set((t.lines||[]).filter(l=>l.attribution).map(l=>l.attribution.reporter||'Unknown'))];
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation);
 const stop=mine&&!closed&&!saved&&!untouchedOffer(t)&&allowed('stop')?`<button type="button" class="secondary" data-task-stop="${t.id}">Stop remaining work</button>`:'';
 const assignment=reassignForm(t);
 const reassignment=!assignment?'':t.outcome==='needs_assignment'?assignment:!closed?disclosure('row-reassign-'+t.id,'Reassign remaining work',assignment):'';
 const next=closed?'View result':saved?'Check saved update':t.attention?'View quantity check':t.outcome==='needs_assignment'&&allowed('assign')?'Assign task':'Task details';
 return `<tr data-task-row="${t.id}"><th scope="row"><a href="/tasks/${t.id}">${esc(taskName(t))}</a><small>${esc(t.type)} · ${esc(t.lines?.[0]?.sku||'')} · Task #${t.id}</small><div class="task-primary-actions">${mine&&!closed&&t.assignment_state==='offered'&&allowed('execute')?'':`<a class="work-secondary" href="/tasks/${t.id}">${next}</a>`}${assignmentActions(t)}${stop}${saved?'<p>Saved request awaiting confirmation.</p>':''}</div></th><td>${esc(t.remaining_quantity??t.requested_quantity??'—')} ${esc(t.lines?.[0]?.unit_of_measure)}<small>${esc(t.requested_quantity??'—')} requested</small></td><td>${badge(label,t.attention||t.overdue?'warning':t.outcome==='completed'?'good':'')}<small>${esc(dueText(t))}</small></td><td>${esc(t.recorded_quantity??0)} recorded<small>${(t.lines||[]).filter(l=>l.execution_state==='settled').length} locations recorded</small></td><td>Assigned to <strong>${esc(t.assignee_name||'Needs assignment')}${t.assignee_username?' · '+esc(t.assignee_username):''}</strong>${t.assignment_state==='returned'?`<small>Last assigned: ${esc(t.assignment_history?.filter(e=>e.event_type==='returned').at(-1)?.previous_name||'See history')}</small>`:''}<small>Performed by ${esc(actualPeople.join(', ')||'Not recorded')}</small><small>Entered by ${esc(reporters.join(', ')||'Not recorded')}</small></td><td>${t.assigned_at?esc(new Date(t.assigned_at).toLocaleString()):'Not assigned'}<small>Assigned by ${esc(t.assigned_by_name||'—')}</small></td><td class="task-row-actions"><a href="/tasks/${t.id}">Details</a>${reassignment}${!closed&&allowed('deadline')?disclosure('deadline-'+t.id,'Change deadline',form('deadline',fields+input('dueAt','New due time (blank disables deadline)','datetime-local')+input('reason','Reason','text','required')+'<button>Save deadline</button>')):''}</td></tr>`;
}
function taskCards(tasks){return `<div class="work-table-wrap" tabindex="0" role="region" aria-label="Task table; scroll horizontally for actions"><table class="work-task-table"><thead><tr><th scope="col">Task / product</th><th scope="col">Remaining</th><th scope="col">Status / due</th><th scope="col">Progress</th><th scope="col">People</th><th scope="col">Assigned</th><th scope="col">Actions</th></tr></thead><tbody data-task-table>${tasks.map(taskRow).join('')||'<tr><td colspan="7">No matching tasks.</td></tr>'}</tbody></table></div>`;}
function myTasks(){if(path==='/work/history')return snapshot.tasks;if(snapshot.taskPage?.unified)return snapshot.tasks;return snapshot.tasks.filter(t=>t.assignee_id===snapshot.user.id&&!t.completed_at&&!['completed','stopped','cancelled'].includes(t.outcome)&&t.assignment_state!=='returned').sort((a,b)=>(Date.parse(b.assigned_at||b.started_at)||0)-(Date.parse(a.assigned_at||a.started_at)||0)||b.id-a.id);}
function taskHasSavedUpdate(t){return outbox.some(o=>currentSavedUpdate(o)&&['local','sending','error','rejected','activation-pending','activation-unknown','review-saving','review-unknown'].includes(o.state)&&(Number(o.input.taskId)===t.id||(t.lines||[]).some(l=>l.id===Number(o.input.lineId))));}
function myTaskChoice(t){
 if(t.assignee_id!==snapshot.user.id||t.completed_at||['completed','stopped','cancelled'].includes(t.outcome)||taskHasSavedUpdate(t))return null;
 if(untouchedOffer(t)&&allowed('execute'))return {action:'decline',label:'Decline',explanation:'Return this unstarted assignment for reassignment. Its deadline stays unchanged.'};
 const untouched=!t.attention&&!(t.recorded_quantity>0)&&(t.lines||[]).every(l=>['ready','cancelled','superseded'].includes(l.execution_state)&&!l.started_at&&!l.reports?.length);
 if(allowed('stop')&&!untouchedOffer(t))return t.assignment_source==='self'&&untouched?{action:'stop',label:'Cancel task',explanation:'Cancel your untouched task. Confirm that nothing moved.'}:{action:'stop',label:'Stop remaining work',explanation:'Record any actual movement first. Recorded quantities remain; uncertain physical work stays in review.'};
 return null;
}
function myTaskActionable(t){return !!t&&online&&allowed('execute')&&t.canAct!==false&&t.assignee_id===snapshot.user.id&&!t.completed_at&&!['completed','stopped','cancelled'].includes(t.outcome)&&['offered','started','legacy'].includes(t.assignment_state)&&!t.attention&&!t.review_followup&&!taskHasSavedUpdate(t)&&!(t.lines||[]).some(l=>(l.reports||[]).some(r=>['review','received'].includes(r.status)));}
const workStates={review:'Needs Review',not_started:'Task Not Started',in_progress:'Task In Progress',completed:'Task Completed'};
function myWorkState(t){if(t.work_state)return t.work_state;if(pendingTaskEvidence(t))return 'review';if(t.completed_at||['completed','stopped','cancelled'].includes(t.outcome))return 'completed';if(t.review_followup||t.assignment_state==='returned')return 'review';return ['offered','legacy'].includes(t.assignment_state)?'not_started':'in_progress';}
function myWorkStatus(t){return t.work_status||(myWorkState(t)==='completed'?status(t.outcome):myWorkState(t)==='review'?(t.attention||t.review_followup?'Quantity check':'Needs assignment'):t.guidance_paused?'Paused':(t.lines||[]).some(l=>l.guidance?.state==='waiting')?'Waiting for location':t.overdue?'Overdue':myWorkState(t)==='not_started'?'Not started':'In progress');}
function myTaskRow(t){
 const history=path==='/work/history';
 const state=myWorkState(t),priority=t.work_priority||'low',progress=t.work_progress??(t.requested_quantity>0?Math.round((t.recorded_quantity||0)*1000/t.requested_quantity)/10:0),canStart=myTaskActionable(t);
 const action=canStart?activationForm(t,t.assignment_state==='offered'?'Start':'Resume','class="my-work-start"'):'';
 return `<tr data-task-row="${t.id}" data-priority="${esc(t.work_priority||'low')}" data-generation="${t.assignment_generation}">${selectingTasks?`<td class="task-select-cell"><input type="checkbox" data-select-task="${t.id}" aria-label="Select task ${t.id}" ${selectedTasks.has(t.id)?'checked':''} ${canBulkDiscard(t)?'':'disabled'}></td>`:''}<td><a href="/tasks/${t.id}"${history?' data-task-history="'+t.id+'"':' data-task-edit="'+t.id+'"'}>#${t.id} · ${t.type==='put'?'Put':'Pick'}</a></td><td>${taskProductLink(t)}</td><td>${tableBadge(t.type==='put'?'Put':'Pick')}</td>${history?`<td>${esc(t.assignee_name||'Unassigned')}</td>`:''}<td>${esc(t.lines?.[0]?.unit_of_measure)}</td><td>${esc(t.requested_quantity??'—')}</td><td>${esc(t.recorded_quantity??0)}</td><td>${esc(t.remaining_quantity??'—')}</td><td>${badge(priority[0].toUpperCase()+priority.slice(1),priority==='high'?'warning':'')}</td><td>${tableBadge(myWorkStatus(t))}${taskHasSavedUpdate(t)?' · Update pending':''}</td><td>${esc(progress)}%</td><td>${esc(workStates[state])}</td>${history?`<td>${stockSnapshot(t.quantity_before,t.quantity_before_unit||t.lines?.[0]?.unit_of_measure)}</td><td>${stockSnapshot(t.quantity_after,t.quantity_after_unit||t.lines?.[0]?.unit_of_measure)}</td>`:''}<td data-my-actions-cell><div class="my-work-actions">${history?`<a class="work-secondary" href="/work/task-history?taskId=${t.id}">Task history</a>`+reopenButton(t):action+checkButton(t)}</div></td></tr>`;
}
const workFilterColumns=[
 {key:'task',label:'Task',names:['taskSearch']},{key:'product',label:'Product',names:['productSearch']},
 {key:'status',label:'Status',names:['statusSearch']},{key:'progress',label:'Progress',names:['progressRange']},
 {key:'priority',label:'Priority',names:['priority']},{key:'state',label:'State',names:['workState']}
];
const workFilterNames=workFilterColumns.flatMap(c=>c.names);
const retiredWorkFilters=['unitSearch',...['requested','completed','remaining','progress'].flatMap(k=>[k+'Min',k+'Max'])];
function clearRetiredWorkFilters(q){for(const k of retiredWorkFilters)q.delete(k);return q;}
let selectedFilterColumns;
function tableFilterOptions(key){
 const values=new Map();
 for(const t of myTasks()){
  const value=key==='task'?`${t.id} ${t.type}`:key==='product'?taskName(t):key==='status'?myWorkStatus(t):key==='priority'?(t.work_priority||'low'):myWorkState(t);
  const label=key==='task'?`#${t.id} · ${t.type==='put'?'Put':'Pick'}`:key==='state'?workStates[value]:value;
  if(value&&label)values.set(String(value),String(label));
 }
 return [...values].map(([value,label])=>({value,label}));
}
function workFilterOptions(c,value='',exact=false){
 const choices=c.key==='priority'?['low','medium','high'].map(value=>({value,label:value[0].toUpperCase()+value.slice(1)})):c.key==='progress'?['below-0','0-25','25-50','50-75','75-100','above-100'].map(value=>({value,label:value==='below-0'?'<0%':value==='above-100'?'>100%':value.replace('-', '–')+'%'})):tableFilterOptions(c.key);
 const defaults=c.key==='state'?[{value:'current',label:'Current tasks'},{value:'all',label:'All states'}]:[{value:'',label:'All'}];
 const list=[...defaults,...choices];
 // Retain an applied or unsaved choice even if live updates remove its last row.
 if(value&&!list.some(o=>o.value===value)){const label=c.key==='state'?(workStates[value]||value):c.key==='task'&&/^\d+ (pick|put)$/.test(value)?`#${value.split(' ')[0]} · ${value.endsWith('put')?'Put':'Pick'}`:value;list.push({value,label,exact});}
 return list.map(o=>`<option value="${esc(o.value)}" ${o.value===value?'selected':''} ${o.exact===false?'':'data-exact="1"'}>${esc(o.label)}</option>`).join('');
}
function workFilterChip(c,q){
 const label=esc(c.label),active=selectedFilterColumns.has(c.key),name=c.names[0],value=q.get(name)||(c.key==='state'?workDefaultState():'');
 const control=`<select name="${name}" aria-label="${label}" data-table-filter="${c.key}">${workFilterOptions(c,value,q.get(name+'Exact')==='1')}</select>`;
 return `<div class="work-filter-chip" data-filter-column="${c.key}" ${active?'':'hidden'}><span class="work-filter-label">${label}</span>${control}<button type="button" class="filter-remove" data-remove-filter="${c.key}" aria-label="Remove ${label.toLowerCase()} filter" title="Remove ${label.toLowerCase()} filter">×</button></div>`;
}
function patchWorkFilterOptions(){
 const f=root.querySelector('.my-work-filters');if(!f)return;
 for(const c of workFilterColumns){
  const select=f.elements[c.names[0]];if(!select||select===document.activeElement)continue;
  const html=workFilterOptions(c,select.value,select.selectedOptions?.[0]?.dataset.exact==='1');
  if(select.innerHTML!==html)select.innerHTML=html;
 }
}
function workPageSize(value){return [20,50,100].includes(Number(value))?Number(value):50;}
const workTablePath=()=>path==='/work/history'?'/work/history':'/work';
const workDefaultState=()=>path==='/work/history'?'all':'current';
function workTableFilters(){
 const q=new URLSearchParams(location.search);
 if(!selectedFilterColumns)selectedFilterColumns=new Set(workFilterColumns.filter(c=>c.names.some(k=>q.has(k)&&q.get(k)!==''&&(k!=='workState'||q.get(k)!==workDefaultState()))).map(c=>c.key));
 const columns=[...selectedFilterColumns].map(k=>workFilterColumns.find(c=>c.key===k)).concat(workFilterColumns.filter(c=>!selectedFilterColumns.has(c.key)));
 const canSelect=path!=='/work/history'&&allowed('resolve')&&allowed('resolveStop')&&allowed('teamStop');
 return `<form method="get" action="${workTablePath()}" class="my-work-filters" aria-label="Filter tasks">${path==='/work/history'&&q.get('scope')==='team'?hidden('scope','team'):''}<div class="work-filter-toolbar"><select class="work-filter-picker" data-add-filter aria-label="Add filter"><option value="">Filters</option>${workFilterColumns.map(c=>`<option value="${c.key}" ${selectedFilterColumns.has(c.key)?'disabled':''}>${esc(c.label)}</option>`).join('')}</select><button data-apply-work-filters disabled>Apply</button>${canSelect?`<button type="button" class="secondary" data-toggle-selection aria-pressed="${selectingTasks}">${selectingTasks?'Done':'Select'}</button>`:''}<select class="work-page-size" name="pageSize" aria-label="Items per page">${[20,50,100].map(n=>`<option value="${n}" ${n===workPageSize(q.get('pageSize'))?'selected':''}>Items per page: ${n}</option>`).join('')}</select><label class="work-check"><input type="checkbox" name="reviewOnly" value="1" ${['1','true'].includes(q.get('reviewOnly'))?'checked':''}>See only review items</label>${path==='/work/history'?`<label class="work-check"><input type="checkbox" name="activeOnly" value="1" ${['1','true'].includes(q.get('activeOnly'))?'checked':''}>See only active assignments</label>`:''}</div><div class="work-filter-fields" data-filter-fields ${selectedFilterColumns.size?'':'hidden'}>${columns.map(c=>workFilterChip(c,q)).join('')}</div>${canSelect?`<button type="button" class="danger" data-bulk-discard ${selectedTasks.size?'':'hidden'}>Discard All (${selectedTasks.size})</button>`:''}<span data-filter-feedback role="status"></span></form>`;
}
function changeFilterColumn(f,key,add){
 const column=workFilterColumns.find(c=>c.key===key);if(!column)return;
 const chip=f.querySelector(`[data-filter-column="${key}"]`),picker=f.querySelector('[data-add-filter]');
 if(add){selectedFilterColumns.add(key);chip.hidden=false;f.querySelector('[data-filter-fields]').append(chip);f.querySelector('[data-filter-fields]').hidden=false;chip.querySelector('select').focus();}
 else{selectedFilterColumns.delete(key);for(const name of column.names)f.elements[name].value=name==='workState'?workDefaultState():'';chip.hidden=true;picker.focus();}
 f.querySelector('[data-filter-fields]').hidden=!selectedFilterColumns.size;picker.querySelector(`option[value="${key}"]`).disabled=add;picker.value='';updateFilterApply(f);dirty=workFiltersChanged(f);
}
function workFiltersChanged(f){const q=new URLSearchParams(location.search);return workFilterNames.some(k=>(f.elements[k]?.value||'')!==(q.get(k)||(k==='workState'?workDefaultState():'')));}
function updateFilterApply(f){const b=f?.querySelector('[data-apply-work-filters]');if(b)b.disabled=!workFiltersChanged(f);}
async function applyWorkFilters(f,immediate=false){
 const before=location.search,q=clearRetiredWorkFilters(new URLSearchParams(before));q.delete('page');
 if(!immediate)for(const k of workFilterNames){const v=f.elements[k]?.value||'';if(v)q.set(k,v);else q.delete(k);if(['taskSearch','productSearch','statusSearch'].includes(k)){if(v&&f.elements[k]?.selectedOptions?.[0]?.dataset.exact==='1')q.set(k+'Exact','1');else q.delete(k+'Exact');}}
 if(immediate==='pageSize')q.set('pageSize',String(workPageSize(f.elements.pageSize.value)));
 if(f.elements.reviewOnly.checked)q.set('reviewOnly','1');else q.delete('reviewOnly');
 if(f.elements.activeOnly){if(f.elements.activeOnly.checked)q.set('activeOnly','1');else q.delete('activeOnly');}
 window.history.replaceState(window.history.state,'',workTablePath()+(q.size?'?'+q:''));
 try{await refresh();if(location.search!==(q.size?'?'+q:''))return;const head=root.querySelector('.my-work-table thead tr');if(head)head.innerHTML=workTableHead();patchMyWorkRows();patchSelection();dirty=workFiltersChanged(f);updateFilterApply(f);f.querySelector('[data-filter-feedback]').textContent='';}
 catch(error){if(location.search!==(q.size?'?'+q:''))return;window.history.replaceState(window.history.state,'',workTablePath()+before);f.elements.reviewOnly.checked=['1','true'].includes(new URLSearchParams(before).get('reviewOnly'));if(f.elements.activeOnly)f.elements.activeOnly.checked=['1','true'].includes(new URLSearchParams(before).get('activeOnly'));if(f.elements.pageSize)f.elements.pageSize.value=String(workPageSize(new URLSearchParams(before).get('pageSize')));f.querySelector('[data-filter-feedback]').textContent=error.message;updateFilterApply(f);}
}
function workTableHead(){return `${selectingTasks?'<th scope="col" class="task-select-cell"><input type="checkbox" data-select-all aria-label="Select all eligible tasks on this page"></th>':''}${[['task','Task'],['product','Product'],['type','Type'],...(path==='/work/history'?[['assignedTo','Assigned To']]:[]),['unit','Unit'],['requested','Requested'],['completed','Completed'],['remaining','Remaining'],['priority','Priority'],['status','Status'],['progress','Progress'],['state','State'],...(path==='/work/history'?[['before','Details before'],['after','Details after']]:[])].map(([k,v])=>workColumn(k,v)).join('')}<th scope="col">Action</th>`;}

function workColumn(key,label){const q=clearRetiredWorkFilters(new URLSearchParams(location.search)),sort=q.get('sort')||(path==='/work/history'?'task':'priority'),order=q.get('order')||'desc',active=sort===key;q.set('sort',key);q.set('order',active&&order==='asc'?'desc':'asc');q.delete('page');return `<th scope="col" aria-sort="${active?(order==='asc'?'ascending':'descending'):'none'}"><a href="${workTablePath()}?${esc(q.toString())}" title="Sort ${label.toLowerCase()} ${active&&order==='asc'?'descending':'ascending'}">${label} ${active?(order==='asc'?'↑':'↓'):'↕'}</a></th>`;}
function myNextContent(){
 const t=snapshot.taskPage?.view==='mine'?snapshot.myWorkNextTask:null;
 if(!t||t.assignee_id!==snapshot.user.id)return `<p>${!online?'Reconnect to load your next task.':allowed('pick')||allowed('put')?'No task is ready to start. Choose Pick stock or Put stock below.':'No task is ready to start.'}</p>`;
 const saved=taskHasSavedUpdate(t),ready=myTaskActionable(t);
 const started=(t.recorded_quantity>0)||(t.lines||[]).some(l=>l.execution_state==='working'||l.started_at);
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation);
 const action=ready?activationForm(t,null,'class="my-work-start" data-draft-kind="my-next"'):canCheckTask(t)?checkButton(t):`<a class="work-secondary" href="/tasks/${t.id}">${saved?'Check saved update':!online?'View saved task':'View task'}</a>`;
 return `<div class="my-work-next-task" data-next-id="${t.id}" data-next-generation="${t.assignment_generation}"><div><a class="my-work-next-product" href="/tasks/${t.id}">${esc(taskName(t))}</a><p>${esc(t.type==='put'?'Put':'Pick')} · ${esc(t.remaining_quantity??t.requested_quantity??'—')} ${esc(t.lines?.[0]?.unit_of_measure)} remaining · ${esc(t.recorded_quantity??'—')} recorded</p></div>${action}</div>`;
}
function home(){
 const tasks=myTasks();
 return `<section class="work-intro my-work-next-area"><h2>What’s your next move?</h2><div data-my-next-content>${myNextContent()}</div><p data-my-next-warning class="work-callout warning" role="status" hidden></p></section><section class="my-work-list" aria-label="My tasks">${!online&&snapshot.taskPage?.view!=='mine'?'<p class="work-callout warning">This saved view may not include all your tasks. Reconnect to load current assignments.</p>':''}${workTableFilters()}<div class="table-wrap my-work-table-wrap" tabindex="0" role="region" aria-label="My tasks; scroll horizontally for all columns"><table class="my-work-table"><thead><tr>${workTableHead()}</tr></thead><tbody data-my-work-table>${tasks.map(myTaskRow).join('')||`<tr><td colspan="${selectingTasks?13:12}" class="empty-cell">No matching tasks.</td></tr>`}</tbody></table></div><p class="work-help">Remaining is unmet task quantity. Completed or stopped tasks have no executable work.</p><div data-my-work-pagination>${snapshot.taskPage?.view==='mine'&&snapshot.taskPage?.pages>1?pageLinks(snapshot.taskPage):''}</div></section>${allowed('pick')||allowed('put')?`<footer class="my-work-footer" aria-label="Create stock work"><div class="work-actions">${allowed('pick')?'<a class="work-primary" href="/pick">Pick stock</a>':''}${allowed('put')?'<a class="work-secondary" href="/put">Put stock</a>':''}</div></footer>`:''}`;
}
function patchMyNext(){
 const content=root.querySelector('[data-my-next-content]');if(!content)return;
 const warning=root.querySelector('[data-my-next-warning]');
 if(content.contains(document.activeElement)){
  const shown=content.querySelector('[data-next-id]'),t=snapshot.myWorkNextTask;
  const stale=!myTaskActionable(t)||String(t.id)!==shown?.dataset.nextId||String(t.assignment_generation)!==shown?.dataset.nextGeneration||t.progress_token!==content.querySelector('form')?.elements.progressToken?.value;
  warning.hidden=!stale;warning.textContent=stale?'This task changed or has an unconfirmed update. Check its details before continuing.':'';
  for(const button of content.querySelectorAll('form button'))button.disabled=stale;
 }else{content.innerHTML=myNextContent();warning.hidden=true;}
}
function myActionDialog(t){
 const choice=myTaskChoice(t);if(!choice)return;
 const d=root.querySelector('[data-my-work-dialog]');if(!d)return;
 d.dataset.taskId=t.id;d.dataset.generation=t.assignment_generation;d.dataset.choice=choice.label;
 d.innerHTML=`<h2>${esc(choice.label)} · ${esc(taskName(t))}</h2><p>${esc(choice.explanation)}</p><p data-my-action-warning role="status" hidden></p>${form(choice.action,hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+(choice.action==='decline'?'<label>Reason (optional)<select name="reason"><option value="">No reason supplied</option><option>Busy with other work</option><option>Unable to do this task</option></select></label>'+input('note','Optional note'):'<label class="work-check"><input type="checkbox" required>'+ (choice.label==='Cancel task'?'Nothing moved under this task.':'I want to stop the remaining work.')+'</label>')+`<button>${esc(choice.label)}</button>`)}<button type="button" class="secondary" data-my-close>Keep task</button>`;
 restoreDrafts();d.showModal();
}

function productPicker(selected='',searchable=true){return `<div class="work-product-field"><label>Product<select data-searchable name="productId" required><option value="">Choose a product</option>${options(snapshot.products,'id',p=>`${p.name} · ${p.sku} (${p.unit_of_measure})`,selected)}</select></label><div class="product-stock" data-product-stock hidden><div data-stock-status role="status" aria-live="polite"></div><div data-stock-details></div></div></div>${searchable?'<p class="work-help" data-product-unit aria-live="polite"></p>':''}`;}
// In-memory advisory reads only. Never persisted as a current stock figure or used to authorize a plan.
const productStockReads=new Map();
const stockRights=()=>['view','pick','put','assign','teamView'].map(p=>Number(allowed(p))).join('');
const stockReadKey=productId=>`${key()}:${snapshot.dataset}:${stockRights()}:${productId}`;
function stockSummaryHtml(s,direction){
 const q=n=>esc(Number(n).toLocaleString(undefined,{maximumFractionDigits:6})),unit=esc(s.unit);
 return `<dl class="product-stock-main">${[['Current Stock',s.recorded],['Space for More',s.putCapacity],['Total Capacity',s.totalCapacity]].map(([label,value])=>`<div><dt${label==='Space for More'?' title="Available after active work and location checks"':''}>${label}</dt><dd>${q(value)} <span>${unit}</span></dd></div>`).join('')}</dl><div class="product-stock-reserved">Reserved for Pick: <strong>${q(s.pickReserved)} ${unit}</strong> · Reserved for Put: <strong>${q(s.incomingReserved)} ${unit}</strong></div>`;
}
function stockDetailsHtml(s){
 const reservations=s.reservations.length?'<ul>'+s.reservations.map(r=>`<li><a href="/tasks/${Number(r.taskId)}">Task #${Number(r.taskId)}</a> · ${r.kind==='pick'?'Pick reserved':'Incoming put'} ${esc(r.quantity)} ${esc(r.unit)} · ${esc(r.location)}${s.detailScope==='team'?' · '+esc(r.assignee||'Unassigned'):''}${r.attention?' · Needs check':''}</li>`).join('')+'</ul>':'<p>No reservations visible in your scope.</p>';
 return `<details data-disclosure="product-stock-details"><summary>${esc(s.reservationCount)} location reservations · details</summary><p>Available to Pick: ${esc(s.availableToPick)} ${esc(s.unit)} · Physical Free Space: ${esc(s.spaceForMore)} ${esc(s.unit)}</p>${reservations}${s.moreReservations?'<p>First 100 reservations shown. See task history for more.</p>':''}${s.detailScope==='own'?'<p>Only your tasks shown. Totals include all reservations.</p>':''}${s.unavailableUnreserved?`<p>${esc(s.unavailableUnreserved)} ${esc(s.unit)} unreserved but unavailable: inactive locations or checks outstanding.</p>`:''}</details>`;
}
function paintProductStock(f){
 const box=f.querySelector('[data-product-stock]');if(!box)return;
 const id=f.elements.productId?.value,eligible=['create','assign'].includes(f.dataset.workAction)&&allowed('view')&&['pick','put','assign'].some(allowed);box.hidden=!id||!eligible;if(box.hidden){box.querySelector('[data-stock-status]').textContent='';box.querySelector('[data-stock-details]').innerHTML='';box._stockPaint=null;return;}
 const state=productStockReads.get(stockReadKey(id)),status=box.querySelector('[data-stock-status]'),details=box.querySelector('[data-stock-details]');
 const signature=`${stockReadKey(id)}:${online}:${state?.version}:${state?.status}:${f.elements.direction?.value}`;if(box._stockPaint===signature)return;box._stockPaint=signature;
 box._stockOpen=details.querySelector('details')?.open??box._stockOpen??false;
 const loading=online&&state?.status==='loading';status.setAttribute('aria-busy',String(loading));
 if(!online){status.textContent='[Offline · reconnect for current stock]';details.innerHTML='';return;}
 if(loading){status.innerHTML='<span class="stock-spinner" aria-hidden="true"></span> [Loading current stock…]';details.innerHTML='';return;}
 if(!state||state.status==='error'){status.innerHTML='[Stock unavailable] <button type="button" class="text-button" data-stock-retry>Retry stock check</button>';details.innerHTML='';return;}
 status.innerHTML=stockSummaryHtml(state.data,f.elements.direction?.value)+` <small>Checked ${esc(new Date(state.data.generatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}))}</small>`;
 details.innerHTML=stockDetailsHtml(state.data);details.querySelector('details').open=box._stockOpen;
}
async function loadProductStock(productId,force=false){
 const requestKey=stockReadKey(productId),previous=productStockReads.get(requestKey);
 if(!force&&previous?.status==='loading')return previous.promise;
 if(!force&&previous&&Date.now()-previous.at<30000)return;
 const identity={site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id};
 const state={status:'loading',version:(previous?.version||0)+1,at:Date.now()};productStockReads.set(requestKey,state);
 state.promise=(async()=>{
  try{
   const response=await fetch('/api/work/productStock?productId='+encodeURIComponent(productId),{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('Stock check failed');const data=await response.json();
   if(data.detailScope==='team'&&!allowed('teamView'))throw new Error('Stock permissions changed');
   if(data.site!==identity.site||data.dataset!==identity.dataset||data.actorId!==identity.actorId||String(data.productId)!==String(productId))throw new Error('Stock identity changed');
   state.data=data;state.status='ready';
  }catch{state.status='error';}finally{state.at=Date.now();if(productStockReads.get(requestKey)!==state)return;for(const f of root.querySelectorAll('form[data-work-action]'))paintProductStock(f);}
 })();return state.promise;
}
function refreshProductStocks(force=false,onlyForm=null){
 for(const f of onlyForm?[onlyForm]:root.querySelectorAll('form[data-work-action]')){
  if(!['create','assign'].includes(f.dataset.workAction)||!f.querySelector('[data-product-stock]'))continue;
  if(!allowed('view')||!['pick','put','assign'].some(allowed)){paintProductStock(f);continue;}
  const id=f.elements.productId?.value;if(online&&id)void loadProductStock(id,force);paintProductStock(f);
 }
}
function updateProductPicker(f){
 const chosen=f.elements.productId?.value;if(chosen==null)return;
 const product=snapshot.products.find(p=>String(p.id)===chosen),unit=f.elements.unit?.value?.trim()||product?.unit_of_measure;
 const help=f.querySelector('[data-product-unit]');if(help)help.textContent=product?`Selected: ${product.name}. Quantity unit: ${unit}.`:'Choose a product to see its quantity unit.';
}
function recoveryHref(direction,f=null){const params=new URLSearchParams(location.search),q=new URLSearchParams();for(const name of ['product_id','cell_id','quantity','return_to'])if(params.has(name))q.set(name,params.get(name));if(f)for(const [name,field] of [['product_id','productId'],['cell_id','preferredCellId'],['quantity','quantity']]){const value=f.elements[field]?.value;if(value)q.set(name,value);else q.delete(name);}q.set('direction',direction);return '/record-movement?'+q;}
function updateRecoveryLink(f){const link=root.querySelector('[data-recovery-link]');if(link&&f.dataset.workAction==='create')link.setAttribute('href',recoveryHref(f.elements.direction.value,f));}
function draftContext(f){if(!['create','manual'].includes(f.dataset.workAction))return '';const params=new URLSearchParams(location.search),context=new URLSearchParams();for(const name of ['product_id','cell_id','quantity','return_to','direction'])if(params.has(name))context.set(name,params.get(name));return context.size?':context:'+context:'';}
function createPage(direction){
 if(!online)return manualPage(direction);
 const params=new URLSearchParams(location.search);
 const pending=outbox.some(o=>currentSavedUpdate(o)&&o.action==='create'&&['local','error','sending','activation-pending','activation-unknown'].includes(o.state));
 return `<section class="work-intro"><span class="work-eyebrow">New ${direction}</span><h2>${direction==='pick'?'What are you picking?':'What are you putting away?'}</h2><p>Choose a product and quantity. We’ll find the locations for you.</p><ol class="work-steps" aria-label="Work steps"><li aria-current="step">1 · Plan</li><li>2 · Go to location</li><li>3 · Confirm actual</li></ol></section><section class="work-panel narrow">${form('create',hidden('direction',direction)+hidden('returnTo',workReturn())+productPicker(params.get('product_id'))+input('quantity','Quantity to '+direction,'number',`min="1" step="1" inputmode="numeric" required value="${esc(params.get('quantity')||'')}"`)+disclosure('preferred-location','Choose a preferred location (optional)',`<label>Preferred location<select name="preferredCellId"><option value="">Choose automatically</option>${options(snapshot.cells,'id',c=>c.logical_code,params.get('cell_id'))}</select></label>`,Boolean(params.get('cell_id')))+`<p class="work-plan-help">This reserves stock for your task. You’ll confirm the actual at each location.</p><button ${pending?'disabled':''}>${pending?'Waiting for warehouse confirmation':'Find '+direction+' locations'}</button>`)}${disclosure('already-moved','Already moved the stock?',`<a data-recovery-link href="${esc(recoveryHref(direction))}">Record a completed movement for verification</a>`)}</section>`;
}
const provisionalReferences=new Map();
function provisionalReference(clear=false){
 const id='warehouse-provisional:'+key()+(path==='/record-movement'?'':':'+path)+draftContext({dataset:{workAction:'manual'}});
 try{
  if(clear){sessionStorage.removeItem(id);provisionalReferences.delete(id);return;}
  const ref=sessionStorage.getItem(id)||'movement-'+uid();sessionStorage.setItem(id,ref);return ref;
 }catch{
  if(clear){provisionalReferences.delete(id);return;}
  if(!provisionalReferences.has(id))provisionalReferences.set(id,'movement-'+uid());
  return provisionalReferences.get(id);
 }
}
function recordRows(f){return [...f.querySelectorAll('[data-record-row]')].map(row=>({direction:row.querySelector('[data-record-direction]').value,cellId:Number(row.querySelector('[data-record-cell]').value),quantity:row.querySelector('[data-record-quantity]').value}));}
function recordLocationOptions(productId,direction,selected=''){
 const cells=(snapshot.cells||[]).filter(c=>direction==='put'||(snapshot.contents||[]).some(b=>b.cell_id===c.id&&b.product_id===Number(productId)&&b.available_quantity>0));
 const list=options(cells,'id',c=>c.description?.name||c.logical_code,selected);
 return `<option value="">Choose location</option>${selected&&!cells.some(c=>String(c.id)===String(selected))?`<option value="${esc(selected)}" selected disabled>Choose an available location</option>`:''}${list}`;
}
function recordRow(row={},index=0,productId=''){
 const direction=row.direction||(allowed('pick')?'pick':'put'),unit=snapshot.products.find(p=>p.id===Number(productId))?.unit_of_measure||'—';
 return `<tr data-record-row><td><select name="recordDirection${index}" aria-label="Type, row ${index+1}" data-record-direction>${['pick','put'].filter(d=>allowed(d)).map(d=>`<option value="${d}" ${direction===d?'selected':''}>${d==='pick'?'Pick':'Put'}</option>`).join('')}</select></td><td><select data-searchable name="recordCell${index}" aria-label="Location, row ${index+1}" data-record-cell required>${recordLocationOptions(productId,direction,row.cellId)}</select></td><td><input type="number" name="recordQuantity${index}" aria-label="Actual quantity, row ${index+1}" data-record-quantity min="1" max="1000000000" step="1" inputmode="numeric" value="${esc(row.quantity??'')}" required></td><td class="actual-unit" data-record-unit>${esc(unit)}</td><td><button type="button" class="secondary" data-remove-record>Remove</button></td></tr>`;
}
function updateRecordLocations(f){if(f?.dataset.workAction!=='recordMovement')return;const product=f.elements.productId.value,unit=snapshot.products.find(p=>p.id===Number(product))?.unit_of_measure||'—';for(const row of f.querySelectorAll('[data-record-row]')){const select=row.querySelector('[data-record-cell]');select.innerHTML=recordLocationOptions(product,row.querySelector('[data-record-direction]').value,select.value);row.querySelector('[data-record-unit]').textContent=unit;}globalThis.WarehouseCombobox?.init(f);globalThis.WarehouseCombobox?.restore(f);}
function recordMovementPage(){const q=new URLSearchParams(location.search),product=q.get('product_id')||'',direction=q.get('direction')||undefined;return `<section class="work-panel">${form('recordMovement',productPicker(product)+`<div class="table-wrap"><table class="my-work-table task-actual-table"><thead><tr><th>Type</th><th>Location</th><th>Actual quantity</th><th>Unit</th><th>Action</th></tr></thead><tbody data-record-rows>${recordRow({direction,cellId:q.get('cell_id'),quantity:q.get('quantity')},0,product)}</tbody></table></div><button type="button" class="secondary" data-add-record>Add movement</button>`+input('note','Note (optional)')+'<label class="work-check"><input type="checkbox" name="confirmed" required>These items have already been moved.</label><button>Save Movement</button>','data-record-movement')}</section>`;}
async function saveRecordedMovement(f,values){
 if(!online)throw new Error('Reconnect before saving. Your entries stay here.');
 if(pendingPhysicalSave())throw new Error('An earlier save is not confirmed. Retry that save before recording more movement.');
 const id=uid(),input={productId:values.productId,unit:snapshot.products.find(p=>p.id===Number(values.productId))?.unit_of_measure,rows:recordRows(f),confirmed:values.confirmed==='on',note:values.note,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId};
 const o={id,partition:key(),reviewSave:true,action:'recordMovement',input,draftId:draftKey(f),state:'review-saving',createdAt:new Date().toISOString()};
 await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');await deliverPhysicalReview(o);
}
function manualPage(direction=null){
 const params=new URLSearchParams(location.search),movement=direction||params.get('direction')||'pick';
 return `<section class="work-intro">${workReturn()?`<a href="${esc(workReturn())}">← Back to stock</a>`:''}<h2>${direction?'Offline '+esc(direction)+' · record physical work':'Record Movement'}</h2><p>Enter what physically moved. A supervisor will check it; this does not start new work.</p>${!online?'<p>Saved on this device until the warehouse receives it. Follow the warehouse manual procedure; do not repeat a movement because its update is waiting.</p>':''}</section><section class="work-panel narrow">${form('manual',`<label>Movement<select name="direction"><option value="pick" ${movement==='pick'?'selected':''}>Picked / removed</option><option value="put" ${movement==='put'?'selected':''}>Put / returned</option><option value="count" ${movement==='count'?'selected':''}>Count observation</option></select></label>`+productPicker(params.get('product_id'))+`<label>Location<select name="cellId" required><option value="">Choose a location</option>${options(snapshot.cells,'id',c=>c.description?.name&&c.description.name!==c.logical_code?c.description.name+' · '+c.logical_code:c.logical_code,params.get('cell_id'))}</select></label>`+input('quantity','Actual quantity','number',`min="0" max="1000000000" step="1" inputmode="numeric" required value="${esc(params.get('quantity')||'')}"`)+input('reason','What happened?','text','required')+performerField()+disclosure('movement-history-details','Earlier work or paper records (optional)',`<p>This entry has a saved reference. If the same movement is also on paper or another device, use its original reference here so it can be matched.</p>`+input('origin','Original reference','text',`required maxlength="180" value="${esc(provisionalReference())}"`)+input('unit','Original unit (blank uses selected product unit)','text','placeholder="For earlier work recorded in a different unit"')+input('occurredAt','When it happened (optional)','datetime-local')+'<p>Leave the time blank if unknown. No earlier time will be assumed.</p>')+`<p class="work-help">A count observation records what you saw; it does not replace the stock balance.</p><button>Save completed movement</button>`)}</section>`;
}
function discrepancyCards(){return !allowed('review')?'':snapshot.discrepancies.map(d=>`<article class="work-panel"><h3>${esc(d.logical_code)} · ${esc(d.product_name)}</h3><p class="work-callout warning">${esc(d.reason)}</p><p>Finish outstanding work, reconcile verified corrections in Stocktaking, then clear the discrepancy only when the ledger matches the checked quantity.</p>${form('reconcile',hidden('cellId',d.cell_id)+hidden('productId',d.product_id)+qty('Verified current quantity')+input('verification','Verification evidence','text','required')+'<button>Clear verified discrepancy</button>')}</article>`).join('');}
const taskFilterLabel=v=>({open:'Active',closed:'Finished',all:'All tasks',needs_assignment:'Needs assignment',needs_review:'Needs review',overdue:'Overdue',completed:'Completed',stopped:'Stopped',cancelled:'Cancelled'})[v]||v;
function assignmentPending(){return outbox.some(o=>o.partition===key()&&(o.action==='assign'||o.action==='create'&&o.input?.assigneeId)&&['local','sending','error'].includes(o.state));}
function assignmentPage(){
 if(!allowed('assign'))return '<p>Assign Work is not available for your role.</p>';
 const users=snapshot.operators||[],products=snapshot.products||[],direction=allowed('pick')?'pick':'put';
 const unavailable=!allowed('pick')&&!allowed('put')?'Your role cannot create Pick or Put work.':!products.length?'No active products available.':!users.some(u=>u.eligible)?'No users are eligible to execute work.':'';
 const toggle='<fieldset class="assignment-direction"><legend>Action</legend>'+['pick','put'].map(d=>`<label><input type="radio" name="direction" value="${d}" ${d===direction?'checked':''} ${allowed(d)?'':'disabled'}><span>${d==='pick'?'Pick':'Put'}</span></label>`).join('')+'</fieldset>';
 const product=productPicker('',false);
 const people=`<label>Assigned to<select data-searchable name="assigneeId" required><option value="">Choose person</option>${users.map(u=>`<option value="${u.id}" ${u.eligible?'':'disabled'}>${esc(assigneeLabel(u)+(!u.eligible?(u.status!=='active'?' — Inactive':' — Cannot take tasks'):''))}</option>`).join('')}</select></label>`;
 return `<section class="work-panel assignment-panel">${form('assign',toggle+product+input('quantity','Quantity','number','min="1" max="1000000000" step="1" inputmode="numeric" required')+people+'<div class="assignment-duration">'+input('dueDuration','Due in','number','min="0.016666666666666666" max="8760" step="any" inputmode="decimal" required value="8"')+'<label>Unit<select name="dueUnit"><option value="minutes">Minutes</option><option value="hours" selected>Hours</option><option value="days">Days</option></select></label></div>'+ (unavailable?'<p class="work-callout warning">'+esc(unavailable)+'</p>':'')+`<button ${unavailable||assignmentPending()||!online?'disabled':''}>${assignmentPending()?'Waiting for warehouse confirmation':'Assign Task'}</button>`,'data-assignment-form')} </section>`;
}
function updateAssignmentForm(f){
 if(f.dataset.workAction==='reopen'){const factor={minutes:1,hours:60,days:1440}[f.elements.dueUnit.value];f.elements.dueDuration.min=String(1/factor);f.elements.dueDuration.max=String(525600/factor);return;}
 if(f.dataset.workAction!=='assign')return;
 const unit=f.elements.dueUnit.value;f.elements.dueDuration.min=String(1/({minutes:1,hours:60,days:1440})[unit]);f.elements.dueDuration.max=({minutes:525600,hours:8760,days:365})[unit];
 for(const radio of f.querySelectorAll('[name="direction"]'))radio.disabled=!allowed(radio.value);
 const button=f.querySelector('button:not([type="button"])');button.disabled=!online||assignmentPending()||!allowed('assign')||!allowed(f.elements.direction.value)||!snapshot.products?.length||!snapshot.operators?.some(u=>u.eligible);
 button.textContent=assignmentPending()?'Waiting for warehouse confirmation':'Assign Task';
}
function historyPage(){
 const team=allowed('teamView'),scope=new URLSearchParams(location.search).get('scope');
 const tabs=team?`<nav class="work-actions" aria-label="History scope"><a href="/work/history" ${scope!=='team'?'aria-current="page"':''}>My history</a><a href="/work/history?scope=team" ${scope==='team'?'aria-current="page"':''}>Team history</a></nav>`:'';
 return tabs+`<section class="my-work-list" aria-label="Task history">${workTableFilters()}<div class="table-wrap my-work-table-wrap" tabindex="0" role="region" aria-label="Task history; scroll horizontally for all columns"><table class="my-work-table"><thead><tr>${workTableHead()}</tr></thead><tbody data-my-work-table>${snapshot.tasks.map(myTaskRow).join('')||'<tr><td colspan="15">No matching tasks.</td></tr>'}</tbody></table></div><div data-my-work-pagination>${pageLinks(snapshot.taskPage)}</div></section>`;
}
function teamHistory(){
 if(!allowed('teamView'))return '';
 const q=new URLSearchParams(location.search),filter=q.get('state')||'all';
 return `<nav class="work-actions task-tabs" aria-label="Team task status"><a href="/work/history?scope=team&state=open">Active · ${snapshot.taskCounts?.active??0}</a><a href="/work/history?scope=team&state=needs_assignment">Needs assignment · ${snapshot.taskCounts?.needsAssignment??0}</a><a href="/work/history?scope=team&state=overdue">Overdue · ${snapshot.taskCounts?.overdue??0}</a><a href="/work/history?scope=team&state=closed">History</a></nav>${disclosure('team-filters','Filters · '+esc([taskFilterLabel(filter),snapshot.operators?.find(u=>String(u.id)===q.get('operator'))?.name,q.get('action')].filter(Boolean).join(' · ')),`<form method="get" class="team-filters"><input type="hidden" name="scope" value="team"><label>Operator<select name="operator"><option value="">All operators</option>${options(snapshot.operators||[],'id',u=>u.name+' · '+u.username,q.get('operator'))}</select></label><label>State<select name="state">${['open','all','closed','needs_assignment','needs_review','overdue','completed','stopped','cancelled'].map(v=>`<option value="${v}" ${filter===v?'selected':''}>${esc(taskFilterLabel(v))}</option>`).join('')}</select></label><label>Action<select name="action"><option value="">Pick and Put</option>${['pick','put'].map(v=>`<option ${q.get('action')===v?'selected':''}>${v}</option>`).join('')}</select></label><button>Filter tasks</button></form>`)}${pageLinks(snapshot.taskPage)}${taskCards(snapshot.tasks)}${pageLinks(snapshot.taskPage)}${allowed('timing')?'<p><a href="/work/timing">Timing settings</a></p>':''}${disclosure('workloads','Workloads by person',`<p>Counts cover all active work, including other pages.</p>${(snapshot.operators||[]).map(u=>`<p><a href="/work/history?scope=team&operator=${u.id}">${esc(u.name)} · ${esc(u.username)}</a>: ${u.open||0} open · ${u.inProgress||0} in progress · ${u.overdue||0} overdue · ${u.review||0} review ${u.eligible?'':'· Ineligible for new work'}</p>`).join('')}`)}`;
}
function timingPage(){
 if(!allowed('timing'))return home();const t=snapshot.timing,unit=t.minutes%60===0?'hours':'minutes';
 return `<section class="work-intro"><h2>Timing settings</h2><p>Warehouse timezone: ${esc(t.timezone)}. Deadlines use elapsed time, including nights.</p></section><section class="work-panel narrow">${form('timing',`<label>Default deadline for self-started work<select name="enabled"><option value="true" ${t.enabled?'selected':''}>Enabled for new tasks</option><option value="false" ${!t.enabled?'selected':''}>Disabled for new tasks</option></select></label>`+input('minutes','Highlight unfinished tasks after','number',`min="0.000001" step="any" max="${unit==='hours'?8760:525600}" data-time-unit="${unit}" required value="${unit==='hours'?t.minutes/60:t.minutes}"`)+`<label>Time unit<select name="timeUnit"><option value="minutes" ${unit==='minutes'?'selected':''}>Minutes</option><option value="hours" ${unit==='hours'?'selected':''}>Hours</option></select></label>`+'<p>Applies to new self-started tasks and older assignment forms. Assign Work uses the duration chosen on its form. Existing deadlines stay unchanged; an overdue warning never cancels work or releases stock.</p>'+'<h3>Missing updates during work</h3>'+input('inactivityMinutes','Check started work after (minutes)','number',`min="1" max="1440" required value="${t.inactivityMinutes}"`)+'<p>If started work has no update for this long, a supervisor must check what moved. Untouched new assignments do not need a quantity review just because they are old.</p><button>Save timing rules</button>')}</section>`;
}
function countTimes(c){return `${c.counted_at?'Counted '+new Date(c.counted_at).toLocaleString():'Counting time unknown'} · ${c.received_at?'Received '+new Date(c.received_at).toLocaleString():'Received time unknown'}`;}
function countCandidateLabel(c){return `${c.title} · ${c.logical_code} · ${countTimes(c)} · Counted by ${c.counter_name||'Unknown'}`;}
function countSequence(c,r){const line=c?.lines?.find(l=>l.productId===r.product_id);if(!line)return 'Choose the count to compare its recorded and counted quantities with this movement.';return `A stock count changed ${c.logical_code} from ${line.recorded} to ${line.actual} ${line.unit}. You are now confirming a ${r.direction} of ${r.quantity_known===0?'an unknown quantity':r.quantity+' '+r.unit}. Were these the same items? Counted by ${c.counter_name||'Unknown'}. ${countTimes(c)}. Matching quantities alone do not prove this.`;}
function countOptions(r){
 const candidate=r.countEvidence,action=r.direction==='put'?'put':'pick';
 return disclosure('count-check-'+r.id,r.countOverlap?'Was this movement already included in the stock count?':'More options: check an earlier stock count',`<p data-count-sequence>${esc(countSequence(candidate,r))}</p><label>Compare this count<select data-searchable data-search-remote="counts" name="countCorrectionId"><option value="">Choose a count</option>${candidate?options([candidate],'id',countCandidateLabel):''}</select></label><label class="work-check"><input type="radio" name="countChoice" value="included">Already included in this count — stock will not change again</label><label class="work-check"><input type="radio" name="countChoice" value="separate">This was a separate ${action} after the count</label><p>Choose only after checking the physical evidence. If unsure, use “I’m not sure — keep pending” below.</p>`,Boolean(r.countOverlap));
}
function updateVerificationFields(f){const note=f.elements.verificationNote;if(!note)return;const other=f.elements.verification.value==='Other evidence (describe below)',details=note.closest('details');note.required=other;note.setCustomValidity(other&&!note.value.trim()?'Describe the verification evidence.':'');if(other)details.open=true;details.querySelector('summary').textContent=other?'Describe the evidence (required)':'Verification note (optional)';}
function verifiedDescription(values){const detail=String(values.verificationNote||'').trim();if(values.verification==='Other evidence (describe below)'&&!detail)throw new Error('Describe the verification evidence.');return detail?`${values.verification}: ${detail}`:values.verification;}
function updateTimingFields(f,convert=false){if(f.dataset.workAction==='updateReviewTask')return;if(f.dataset.workAction!=='timing')return;const field=f.elements.minutes,unit=f.elements.timeUnit.value,previous=field.dataset.timeUnit||unit;if(convert&&field.value)field.value=String(Number(field.value)*(previous==='hours'?60:1)/(unit==='hours'?60:1));field.dataset.timeUnit=unit;field.max=unit==='hours'?'8760':'525600';}
function pendingPage(){
 const q=new URLSearchParams(location.search),personFilter=(name,label)=>`<label>${label}<select data-searchable name="${name}"><option value="">Everyone</option><option value="unknown" ${q.get(name)==='unknown'?'selected':''}>Unknown / unassigned</option>${options(snapshot.performers||[],'id',p=>p.name+' · '+p.username+(p.status==='active'?'':' (inactive)'),q.get(name))}</select></label>`;
 let previousGroup;
 return `${discrepancyCards()}<section class="review-intro"><p>Check what physically moved before changing stock.</p><p>${snapshot.reviewPage?.total??snapshot.pending.length} matching cases out of ${snapshot.reviewTotal??snapshot.pending.length} overall.</p></section>${disclosure('review-filters','Filter people / grouping'+(q.get('assigned')||q.get('performed')||q.get('group')?' · active':''),`<form method="get" class="team-filters review-filters">${personFilter('assigned','Assigned to')}${personFilter('performed','Performed by')}<label>Group cases<select name="group"><option value="">No grouping</option><option value="assigned" ${q.get('group')==='assigned'?'selected':''}>Assigned to</option><option value="performed" ${q.get('group')==='performed'?'selected':''}>Performed by</option></select></label><button>Filter review cases</button></form>`)}${pageLinks(snapshot.reviewPage,'reviewPage')}${snapshot.pending.map(r=>{
 if(r.closureTask)return closureReview(r);
 const fields=hidden('reportId',r.id)+hidden('caseRevision',r.case_revision);
 const handover=r.reviewFollowup?'<label class="work-check"><input type="checkbox" name="workerStopped" required>I confirmed the original worker has stopped.</label>':'';
 const matches=(snapshot.postedReports||[]).filter(p=>p.product_id===r.product_id&&p.cell_id===r.cell_id&&p.direction===r.direction);
 const quick=[...new Set([0,1,r.planned_quantity].filter(n=>n!=null&&n>=0))];
 const groupId=q.get('group')==='assigned'?r.assignee_id:r.performer_id,groupName=q.get('group')==='assigned'?(r.assignee_name||'Unassigned'):(r.operator_name||'Unknown'),group=q.get('group')&&groupId!==previousGroup?`<h3>${esc(groupName)} · ${snapshot.reviewGroups?.find(g=>g.person===groupId)?.total??''} cases</h3>`:'';previousGroup=groupId;
 const shortReason=r.quantity_known===0?'Quantity not confirmed':r.countOverlap?'Stock was counted before this entry arrived':'Entered quantity needs checking';
 return group+disclosure('case-'+r.id,`<span>${esc(r.product_name)} · ${esc(r.logical_code)} · ${esc(r.direction)} — ${esc(shortReason)}</span><span class="review-people">Assigned to <strong>${esc(r.assignee_name||'Unassigned')}${r.assignee_username?' · '+esc(r.assignee_username):''}</strong> · Performed by <strong>${esc(r.operator_name||'Unknown')}${r.performer_username?' · '+esc(r.performer_username):''}</strong> · Entered by <strong>${esc(r.reporter_name)}${r.reporter_username?' · '+esc(r.reporter_username):''}</strong></span><small>Next: verify actual quantity and save, or keep pending if it cannot be established.</small>`,`<p class="work-callout">${esc(reviewInstruction(r))}</p><p>Assigned to ${esc(r.assignee_name||'Unassigned')} · Performed by ${esc(r.operator_name||'Unknown')} · Entered by ${esc(r.reporter_name)}</p><p>Received ${esc(new Date(r.created_at).toLocaleString())} · ${Math.max(0,Math.floor((Date.parse(snapshot.generatedAt)-Date.parse(r.created_at))/60000))} min ago</p><p>Planned: ${esc(r.planned_quantity??'—')} ${esc(r.unit)} · Entered: <strong>${r.quantity_known===0?'unknown':esc(r.quantity)+' '+esc(r.unit)}</strong></p>${r.task_id?`<a href="/tasks/${r.task_id}">Open task</a>`:''}${r.task_id&&allowed('assign')?`<button type="button" class="secondary" data-update-returned="${r.task_id}">Assign / update task</button>`:''}${observationList(r.observations)}${form('resolve',fields+handover+qty(`Verified actual quantity (${r.unit})`)+`<div class="quantity-shortcuts">${quick.map(n=>`<button type="button" class="secondary" data-quantity="${n}">${n}</button>`).join('')}</div>`+performerField(r.performer_id)+`<label>How was this verified?<select name="verification" required><option value="">Choose method</option><option>Spoke with operator</option><option>Checked movement slip</option><option>Observed movement</option><option>Other evidence (describe below)</option></select></label>`+disclosure('verification-note-'+r.id,'Verification note (optional)',input('verificationNote','Verification details / handover evidence'))+countOptions(r)+accountingFields(r)+(r.line_id&&allowed('resolveStop')?'<label class="work-check"><input type="checkbox" name="stopRemaining">Resolve and stop remaining work. I confirmed the original worker has stopped. Other recorded cells remain unchanged.</label>':'')+'<button>Record verified quantity</button>')}${form('resolve',fields+hidden('keepOpen','true')+input('verification','Optional note')+'<button class="secondary">I’m not sure — keep pending</button>')}${disclosure('more-'+r.id,'More options',disclosure('link-'+r.id,`Has this ${r.direction==='put'?'put':'pick'} already been saved?`,`<p>Check the saved item, location, quantity, time and person. Use the matching entry only if it is the same physical work. Stock will not change again; any active allocation closes only when you explicitly confirm it.</p>`+form('resolve',fields+handover+hidden('dismissDuplicate','true')+`<label>Matching saved entry<select data-searchable data-search-remote="movements" name="duplicateOf" required><option value="">Choose a movement</option>${options(matches,'id',m=>`${m.product_name||r.product_name} · ${m.logical_code||r.logical_code} · ${m.quantity} ${m.unit} · ${new Date(m.created_at).toLocaleString()} · ${m.performer_name||'Unknown'}`)}</select></label><button type="button" class="secondary" data-view-saved>View saved entry</button><p data-saved-entry role="status"></p>`+(['ready','working'].includes(r.execution_state)?'<label class="work-check"><input type="checkbox" name="closeAllocation" required>This saved movement covers all work at this location. Close the remaining instructions.</label>':'')+input('verification','How did you verify this match?','text','required')+'<button class="secondary">Use this saved entry</button>')))}${disclosure('technical-'+r.id,'Entry details',`<p>Reference ${esc(r.origin_ref)}</p><p>${esc(r.reason)}<br>${esc(JSON.parse(r.payload||'{}').reason||'')}</p>`)}`,q.get('reportId')===String(r.id),'work-panel review-case');
 }).join('')||'<p>No work needs review.</p>'}${pageLinks(snapshot.reviewPage,'reviewPage')}`;
}
function labelsPage(){const params=new URLSearchParams(location.search);const ids=params.has('cells')?params.get('cells').split(',').map(Number):null, cells=ids?snapshot.cells.filter(c=>ids.includes(c.id)):snapshot.cells;return `<section class="work-intro"><h2>Location labels</h2><p>${ids?'Selected':'All permitted'} locations · ${cells.length} labels. QR labels identify a location; they do not confirm quantity.</p><button type="button" data-print>Print these labels</button></section><div class="label-grid">${cells.map(c=>`<article class="print-label"><img src="/labels/${c.id}.svg" alt="QR code for ${esc(c.logical_code)}"><h2>${esc(c.display_name||c.logical_code)}</h2><p>${esc(c.logical_code)} · label revision ${c.label_revision}</p><a href="/cells/${c.id}">Location settings</a></article>`).join('')}</div>`;}

function ledger(){return `<section class="work-intro"><h2>Posted stock movements</h2><p>Signed quantities reflect the ledger, including corrections. Historical units remain visible.</p></section><div class="work-table-wrap"><table><thead><tr><th>When</th><th>Product / cell</th><th>Change</th><th>People / reference</th></tr></thead><tbody>${(snapshot.ledger||[]).map(r=>`<tr><td>${esc(new Date(r.created_at).toLocaleString())}</td><td>${esc(r.product_name)}<br>${esc(r.logical_code)}</td><td>${r.quantity_delta>0?'+':''}${esc(r.quantity_delta)} ${esc(r.unit_of_measure)}<br>${esc(r.type)}</td><td>${esc(r.performer_name||'Performer not attributed')}<br>Recorded by ${esc(r.reporter_name)}<br>${esc(r.origin_ref||r.reason)}</td></tr>`).join('')}</tbody></table></div>`;}
function savedAction(o){
 if(o.label)return o.label;const i=o.input||{},t=snapshot.tasks?.find(t=>t.id===Number(i.taskId)||t.lines?.some(l=>l.id===Number(i.lineId))),p=snapshot.products?.find(p=>p.id===Number(i.productId));
 const names={reopen:'Reopen task',updateReviewTask:'Update task assignment',closeTask:'Close task with actual totals',sendTaskReview:'Send task closure for review',handBack:'Hand back remaining work',acknowledgeReturn:'Acknowledge return',updateReturned:'Update returned task',assignReview:'Assign quantity check',observeReview:'Save quantity observation',resumeFollowup:'Plan verified remaining work',assign:'Assign task',decline:'Return assigned task',stop:'Cancel / stop remaining task',cancel:'Cancel location work',reassign:'Assign task',deadline:'Change task deadline',start:'Start task',correct:'Correct earlier quantity',askReview:'Ask supervisor to check actual quantity',resolve:'Save supervisor check',timing:'Change work timing',mode:'Change location guidance'};
 if(names[o.action])return names[o.action]+(t?' · '+t.summary:'');
 const direction=i.direction||t?.type;if(direction==='pick'||direction==='put')return `${direction==='pick'?'Pick':'Put'} ${i.quantity??'quantity'} ${i.unit||p?.unit_of_measure||t?.lines?.[0]?.unit_of_measure||''}${p?' · '+p.name:''}`;
 return t?.summary||'Save warehouse update';
}
function queueEntry(o){
 if(['activation-pending','activation-unknown'].includes(o.state))return `<tr><td>Start / Resume awaiting confirmation</td><td><p>${esc(o.message)}</p>${currentActivation(o)?`<button type="button" class="secondary" data-retry-activation="${esc(o.id)}">Retry saved Start / Resume</button>`:'<p>Preserved from another warehouse dataset. Cannot retry in this dataset.</p>'}</td></tr>`;
 const physical=['report','manual','correct','askReview'].includes(o.action),waiting=['local','sending','error'].includes(o.state);
 const label=o.state==='review'?(physical?'Quantity needs supervisor check':'Received — needs supervisor check'):o.state==='rejected'?'Entry could not be accepted':o.state==='not-applied'?'Change could not be saved':waiting?'Waiting for warehouse confirmation':status(o.state);
 const next=o.state==='review'?'Received by the warehouse. Ask a supervisor to check the actual quantity; do not repeat the movement.':waiting?'Saved on this device; the warehouse has not confirmed it yet. Reconnect and send saved updates. Do not repeat the movement.':o.state==='rejected'?'Keep this evidence and ask a supervisor to check it. Do not repeat the movement.':o.state==='not-applied'?'Check the reason, refresh the task, and retry the intended change only if still needed.':'Saved by the warehouse.';
 return `<tr><td><strong>${esc(savedAction(o))} — ${esc(label)}</strong></td><td><p>${esc(next)}</p>${o.message&&(!waiting||o.state==='error')?disclosure('update-detail-'+o.id,'Original details',`<p>${esc(o.message)}</p>`):''}${o.state==='not-applied'?`<button type="button" class="secondary" data-ack-request="${esc(o.id)}">Dismiss this failed request</button>`:''}</td></tr>`;
}
const workLinkCapability=href=>href==='/work?reviewOnly=1'?'review':({'/':'view','/work':'view','/work/history':'view','/work/task-history':'view','/movement-history':'view','/recommended-actions':'view','/pick':'pick','/put':'put','/record-movement':'report','/work/overview':'assign','/pending-confirmations':'review','/work/timing':'timing','/labels':'labels','/stocktaking':'countView','/cells':'locationsView'})[href]||(/^\/cells\/\d+$/.test(href)?'locationsView':null);
// Planning failures are dialogs, not queued physical movements. Unknown results
// retain a durable, frozen request and can only be retried with the same ID.
function planError(result,response){const e=new Error(result.error||'Could not confirm this request.');e.definite=[400,401,403,404,409,422].includes(response.status);e.planning=result.planning;return e;}
function planPending(){return outbox.find(o=>['create','assign','reopen','start','resume'].includes(o.action)&&currentSavedUpdate(o)&&['plan-sending','plan-unknown','activation-pending','activation-unknown','local','sending','error'].includes(o.state));}
async function deliverPlan(o){
 if(!online)throw new Error('Reconnect to the warehouse, then retry this request.');
 if(o.input.site!==snapshot.site||o.input.dataset!==snapshot.dataset||Number(o.input.actorId)!==snapshot.user.id)throw new Error('Sign in to the original account and warehouse before retrying.');
 o.state='plan-sending';await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');
 try{
  const response=await fetch('/api/work/'+o.action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(o.input)});
  const result=await response.json();if(!response.ok)throw planError(result,response);
  o.result=result;o.state=result.status;o.message=result.message;await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');
 }catch(error){o.state=error.definite?'acknowledged':'plan-unknown';o.message=error.definite?error.message:'Request not confirmed. Retry this request; do not create it again.';await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');error.request=o;throw error;}
 // A received success is never downgraded to an unknown request if refresh fails.
 return o.result;
}
function closeOperationDialogs(){
 if(modalDepth){modalMoving=true;window.history.go(-modalDepth);modalDepth=0;modalFrames.length=0;}
 root.querySelector?.('[data-operation-dialog]')?.close();root.querySelector?.('[data-task-dialog]')?.close();dirty=false;
}
async function finishPlan(o){
 if(o.draftId){await store('cache','readwrite',s=>s.delete(o.draftId));drafts.delete(o.draftId);}
 const result=o.result;announce(result.message+(result.urgentRunId?' Urgent stocktake added.':''));
 closeOperationDialogs();
 if(o.action==='create'&&!o.input.assigneeId){await enterActiveTask(result);return;}
 await refresh();render();
}
async function submitPlan(action,values,draftId){
 if(planPending()){const error=new Error('A task request is still waiting for confirmation. Retry it before creating another.');error.request=planPending();throw error;}
 if(!online)throw new Error('Connect to the warehouse before creating a task.');
 const id=uid(),o={id,partition:key(),action,planningRequest:true,draftId,input:{...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId},createdAt:new Date().toISOString()};
 await deliverPlan(o);try{await finishPlan(o);}catch{notice=`Task #${o.result.taskId} saved. Reconnect and open it from My work.`;render();}
}
function recoveryCountRow(c,i,selected=false){return `<tr data-count-row><td><select name="countCell${i}" aria-label="Actual location" required data-searchable><option value="">Choose cell</option>${options(c,'id',v=>v.name+(v.code!==v.name?' · '+v.code:''),selected)}</select></td><td><input name="countQuantity${i}" aria-label="Actual stock in this cell" type="number" min="0" max="1000000000" step="1" inputmode="numeric" required></td><td data-count-unit></td><td><button type="button" class="secondary" data-remove-count aria-label="Remove location">×</button></td></tr>`;}
function operationContent(frame){
 const {stage='error',message='',request,planning,data}=frame,unit=esc(data?.unit),back='<button type="button" class="secondary" data-operation-back>← Back</button>';
 const header=(title,dismissible=false)=>`<header class="review-task-header">${back}<h2>${title}</h2>${dismissible?dismissDialog(title.toLowerCase()):''}</header>`;
 if(stage==='connection')return header('Connection status',true)+`<div class="table-wrap"><table><thead><tr><th>Request</th><th>Next step</th></tr></thead><tbody>${outbox.filter(o=>currentSavedUpdate(o)&&!['acknowledged','recorded','reserved','ready','duplicate','review','verified','busy'].includes(o.state)).map(o=>o.planningRequest?`<tr><td>${esc(o.message)}</td><td><button type="button" data-retry-plan="${esc(o.id)}">Retry request</button></td></tr>`:queueEntry(o)).join('')}</tbody></table></div><button type="button" class="secondary" data-retry>Retry connection</button>`;
 if(stage==='error')return header(planning?.direction==='put'?'Choose where to put':planning?.direction==='pick'?'Check pick quantity':'Task not confirmed',true)+`<p role="alert">${esc(message)}</p>`+(request&&['plan-unknown','plan-sending','activation-unknown','activation-pending','local','sending','error'].includes(request.state)?`<button type="button" data-retry-plan="${esc(request.id)}">Retry request</button>`:planning?.code==='pick_count'?'<button type="button" data-plan-choice="count">Enter actual cell quantities</button>':planning?.code==='put_capacity'?'<div class="planning-choices"><button type="button" data-plan-choice="capacity">Edit items per cell</button><button type="button" data-plan-choice="location">Choose a location</button><button type="button" data-plan-choice="mixed">Store with another product</button></div>':'')+(!planning&&outbox.some(o=>currentSavedUpdate(o)&&['plan-unknown','activation-unknown','error','rejected','local','sending'].includes(o.state))?'<button type="button" class="secondary" data-connection-status>Check connection</button>':'');
 let content='';
 if(stage==='count'){
  const initial=data.cells.filter(c=>c.recorded>0&&!c.blocked);content=`<p>Count stock still in the cells before picking. An urgent stocktake will follow.</p><div class="table-wrap"><table><thead><tr><th>Actual location</th><th>Actual stock</th><th>Unit</th><th>Action</th></tr></thead><tbody data-count-rows>${(initial.length?initial:[null]).map((c,i)=>recoveryCountRow(data.cells.filter(c=>!c.blocked),i,c?.id)).join('')}</tbody></table></div><button type="button" class="secondary" data-add-count>Add location</button><label class="work-check"><input name="confirmed" type="checkbox" required>I counted these quantities before picking.</label>`;
 }else if(stage==='capacity')content=data.canEditCapacity?`<p>Current capacity: ${esc(data.itemsPerCell)} ${unit} per cell.</p><label>Items per cell<input name="itemsPerCell" type="number" min="${Math.floor(data.itemsPerCell)+1}" max="1000000000" step="1" required></label><label class="work-check"><input name="confirmed" type="checkbox" required>I checked that this quantity fits.</label>`:'<p>An admin with capacity access can change items per cell. Choose a location or ask them to update the product.</p>';
 else{
  const cells=data.cells.filter(c=>!c.blocked&&c.space>0&&(stage==='mixed'?c.mixed:!c.mixed));
  content=cells.length?`<label>Location<select name="cellId" required data-searchable><option value="">Choose location</option>${options(cells,'id',c=>`${c.name} · space for ${c.space} ${data.unit}${stage==='mixed'?' · '+c.contents.map(x=>x.quantity+' '+x.name).join(', '):''}`)}</select></label>`:'<p>No suitable cells have enough free space. Choose a larger capacity or another location.</p>';
  if(stage==='mixed'&&cells.length)content+='<label class="work-check"><input name="confirmed" type="checkbox" required>These products can be stored together.</label><p class="work-help">Space includes pending puts. Mixed storage appears in Space suggestions after the put.</p>';
 }
 return header(stage==='count'?'Confirm actual stock':stage==='capacity'?'Edit items per cell':stage==='mixed'?'Store with another product':'Choose a location')+`<p><strong>${esc(data.name)}</strong> · ${esc(request.input.quantity)} ${unit}</p><form data-plan-recovery>${content}${stage==='capacity'&&!data.canEditCapacity?'':`<button type="submit">${stage==='count'?'Confirm stock and create pick':'Save and create put'}</button>`}<p class="form-feedback" role="alert"></p></form>`;
}
function openOperationDialog(frame,navigation='push'){
 const d=root.querySelector('[data-operation-dialog]');if(!d)return;
 frame={...frame,mode:'operation',identity:frame.identity||key()+':'+snapshot.dataset};
 if(navigation!=='restore')rememberModal(frame,navigation);
 d._frame=frame;d.oncancel=e=>{e.preventDefault();void modalBack();};d.innerHTML=operationContent(frame);d.setAttribute('aria-label',frame.stage==='connection'?'Connection status':'Task options');
 if(frame.rows&&d.querySelector('[data-count-rows]')){d.querySelector('[data-count-rows]').innerHTML=frame.rows.map((r,i)=>recoveryCountRow(frame.data.cells.filter(c=>!c.blocked),i,r.cellId)).join('');for(const [i,r] of frame.rows.entries())d.querySelector(`[name="countQuantity${i}"]`).value=r.quantity;}
 for(const label of d.querySelectorAll('[data-count-unit]'))label.textContent=frame.data?.unit||'';
 if(frame.values)for(const el of d.querySelectorAll('input,select'))if(el.name in frame.values){if(el.type==='checkbox')el.checked=frame.values[el.name]==='on';else el.value=frame.values[el.name];}
 globalThis.WarehouseCombobox?.init(d);if(!d.open)d.showModal();
}
function rememberOperationForm(){const d=root.querySelector('[data-operation-dialog]'),f=d?.querySelector('[data-plan-recovery]');if(f&&d._frame){d._frame.values=Object.fromEntries(new FormData(f));if(d._frame.stage==='count')d._frame.rows=[...f.querySelectorAll('[data-count-row]')].map(r=>({cellId:r.querySelector('select').value,quantity:r.querySelector('input[type="number"]').value}));}}
async function planningFailure(error,action,values,draftId){
 notice='';const request=error.request||{action,input:values,draftId};openOperationDialog({message:error.message,planning:['create','assign','reopen'].includes(action)?error.planning:null,request});
}
async function choosePlanRecovery(stage){
 const d=root.querySelector('[data-operation-dialog]'),frame=d._frame;if(frame.identity!==key()+':'+snapshot.dataset)throw new Error('Account changed. Reopen the task.');
 const r=await fetch('/api/work/planningOptions?'+new URLSearchParams({productId:frame.request.input.productId,direction:frame.request.input.direction}),{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
 const data=await r.json();if(!r.ok)throw new Error(data.error||'Reconnect and try again.');
 if(data.site!==snapshot.site||data.dataset!==snapshot.dataset||data.actorId!==snapshot.user.id||d._frame!==frame)throw new Error('Account or warehouse changed. Open these options again.');
 openOperationDialog({...frame,stage,data,values:null,rows:null});
}
async function submitPlanRecovery(f){
 const d=f.closest('[data-operation-dialog]'),frame=d._frame;if(frame.identity!==key()+':'+snapshot.dataset)throw new Error('Account changed. Reopen this task.');
 const values=Object.fromEntries(new FormData(f)),recovery={mode:frame.stage,unit:frame.data.unit,confirmed:values.confirmed==='on'};
 if(frame.stage==='count')recovery.counts=[...f.querySelectorAll('[data-count-row]')].map(row=>{const id=Number(row.querySelector('select').value);return {cellId:id,quantity:row.querySelector('input[type="number"]').value,token:frame.data.cells.find(c=>c.id===id)?.token};});
 else if(frame.stage==='capacity'){recovery.itemsPerCell=values.itemsPerCell;recovery.previousCapacity=frame.data.itemsPerCell;}
 else recovery.cellId=values.cellId;
 const input={...frame.request.input,recovery};delete input.requestId;
 try{await submitPlan(frame.request.action,input,frame.request.draftId);}catch(error){if(error.request?.state==='plan-unknown'){await planningFailure(error,frame.request.action,input,frame.request.draftId);return;}throw error;}
}

function workShortcuts(){return outbox.some(o=>currentSavedUpdate(o)&&['local','sending','error','rejected','plan-unknown','activation-unknown'].includes(o.state))?'<button type="button" class="text-button" data-connection-status>Check connection</button>':'';}
function workViewsMarkup(){
 const tabs=snapshot.workTabs||[{href:'/work',label:'My Work',capability:'view'}];
 const selected=tabs.find(t=>t.href===path)?.href||(/^\/tasks\/\d+$/.test(path)||['/pick','/put'].includes(path)?'/work':null);
 return tabs.filter(tab=>allowed(tab.capability)).map(({href,label})=>`<a href="${esc(href)}" ${selected===href?'aria-current="page"':''}>${esc(label)}</a>`).join('');
}
function sectionNavigation(utility){
 if(path==='/labels')return `<nav class="work-views" aria-label="Location views">${allowed('locationsView')?'<a href="/cells">Locations</a>':''}<a href="/labels" aria-current="page">Location Labels</a></nav>`;
 if(path==='/work/timing')return '<nav class="work-views" aria-label="Settings"><a href="/settings">← Settings</a></nav>';
 // Cached offline shells have no sidebar; retain their only navigation.
 const fallback=!online&&!document.querySelector('.dashboard-sidebar')?`<nav class="work-views" aria-label="Work views">${workViewsMarkup()}</nav>`:'';
 return fallback+(utility?`<div class="work-tools">${utility}</div>`:'');
}
function render(){if(pageScope?.active===false)return;
 globalThis.WarehouseNavigation?.adopt(location.href);
 const disclosures=new Map([...root.querySelectorAll('details[data-disclosure]')].map(d=>[d.dataset.disclosure,d.open]));
 dirty=false;
 if(!snapshot){root.innerHTML='<section class="work-empty"><h2>No saved work on this device</h2><p>Connect to the warehouse and sign in to save your allocations.</p><a href="/login">Sign in</a></section>';return;}

 captureNotification();
 root.classList?.toggle('my-work',path==='/work');
 const utility=['/work','/work/overview'].includes(path)?workShortcuts():'';
 const body=path==='/work/overview'?assignmentPage():path==='/work/timing'?timingPage():path==='/work/history'?historyPage():path==='/pick'?createPage('pick'):path==='/put'?createPage('put'):path==='/record-movement'?recordMovementPage():path==='/work/task-history'?activityHistoryPage():path==='/pending-confirmations'?pendingPage():path==='/labels'?labelsPage():path==='/movement-history'?ledger():/^\/tasks\/\d+$/.test(path)?taskPage(path.split('/')[2]):home();
 root.innerHTML=`${sectionNavigation(utility)}${['/work','/work/overview'].includes(path)?'':`<div class="work-toolbar"><div class="work-tools">${!online?'<a href="/work">My work</a><a href="/pick">Pick</a><a href="/put">Put</a>':''}${workShortcuts()}</div><div class="work-connection">${badge(online?'Connected to warehouse':'Offline · saved work',online?'good':'warning')}<small>Updated ${esc(new Date(snapshot.generatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</small></div></div>`}${!online?'<p class="work-callout warning">Offline: saved work and physical entries stay on this device. No new reservation or location turn is granted. Follow the warehouse manual procedure; use paper if needed.</p>':''}<div data-physical-save-status>${physicalSaveStatus()}</div><div data-inactivity-alerts role="status">${inactivityAlertsMarkup()}</div>${body}<dialog class="my-work-action-dialog task-edit-dialog planning-dialog" data-operation-dialog></dialog><dialog class="my-work-action-dialog task-edit-dialog" data-task-dialog aria-label="Task action"></dialog>${path==='/work'?'<dialog class="my-work-action-dialog" data-my-work-dialog aria-label="Task actions"></dialog>':''}`;
 for(const link of root.querySelectorAll('a[href]')){const href=(link.getAttribute?.('href')||'').split('?')[0];const cap=workLinkCapability(href);if(cap&&!allowed(cap))link.remove();}
 for(const f of root.querySelectorAll('form[data-work-action]')){f._workIdentity={site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id};f._draftPath=path;}
 restoreDrafts();
 for(const f of root.querySelectorAll('form[data-work-action]')){updateRecordLocations(f);updateProductPicker(f);updateRecoveryLink(f);updateTimingFields(f);updateAssignmentForm(f);updateCellConfirmation(f);}
 if(typeof location!=='undefined'&&new URLSearchParams(location.search).has('device_help'))openOperationDialog({stage:'connection'});
 for(const box of root.querySelectorAll('[data-product-stock]'))box._stockOpen=disclosures.get('product-stock-details')||false;
 refreshProductStocks();patchTaskAssignees();
 for(const d of root.querySelectorAll('details[data-disclosure]'))if(disclosures.has(d.dataset.disclosure))d.open=disclosures.get(d.dataset.disclosure);
 for(const f of root.querySelectorAll('form[data-work-action]'))updateVerificationFields(f);
 patchGuidanceHints();
 const cellStrip=root.querySelector?.('[data-task-cells]'),selectedCell=cellStrip?.querySelector?.('[aria-current="true"]');
 if(cellStrip&&selectedCell&&cellStrip.scrollWidth>cellStrip.clientWidth)cellStrip.scrollLeft=Math.max(0,selectedCell.offsetLeft-cellStrip.offsetLeft-12);
 const task=/^\/tasks\/\d+$/.test(path)?snapshot.tasks.find(t=>t.id===Number(path.split('/')[2])):null;
 const scrollKey=task&&task.assignment_state==='started'&&task.assignee_id===snapshot.user.id&&!task.completed_at?`${key()}:${snapshot.dataset}:${task.id}:${task.assignment_generation}`:'';
 if(scrollKey&&scrollKey!==lastTaskAutoScroll){lastTaskAutoScroll=scrollKey;root.querySelector('[data-task-cells]')?.scrollIntoView?.({block:'start',behavior:'smooth'});}
 if(!task)lastTaskAutoScroll='';

}
function draftKey(f){const identity=f._workIdentity||snapshot;const userId=identity.actorId??identity.user.id;return `${identity.site}:${userId}:${identity.dataset}:draft:${f._draftPath||path}:${f.dataset.workAction}:${f.dataset.draftKind||'normal'}:${f.elements.lineId?.value||f.elements.reportId?.value||f.elements.taskId?.value||''}:${f.elements.revision?.value||f.elements.caseRevision?.value||f.elements.generation?.value||''}:${f.elements.progressToken?.value||''}:${f.elements.assignmentGeneration?.value||''}${draftContext(f)}`;}
function restoreDrafts(){
 globalThis.WarehouseCombobox?.init(root);
 for(const f of root.querySelectorAll('form[data-work-action]')){const values=drafts.get(draftKey(f));if(values?._recordRows&&f.querySelector('[data-record-rows]'))f.querySelector('[data-record-rows]').innerHTML=values._recordRows.map((r,i)=>recordRow(r,i,values.productId?.value)).join('');if(values?._actuals&&f.querySelector('[data-actual-rows]')){const t=availableTask(f.elements.taskId?.value)||snapshot.pending?.find(r=>r.id===f.elements.reportId?.value)?.closureTask;if(t)f.querySelector('[data-actual-rows]').innerHTML=values._actuals.map((r,i)=>actualRow(t,r,i)).join('');}if(values)for(const el of f.elements)if(el.name in values&&el.type!=='hidden'&&!(values._actuals&&/^actual(Cell|Quantity)\d+$/.test(el.name))){
  const saved=values[el.name];if(saved.candidate&&el.dataset?.searchRemote==='counts')f._countCandidates=[...(f._countCandidates||[]).filter(c=>String(c.id)!==String(saved.candidate.id)),saved.candidate];if(el.dataset?.searchRemote&&saved.value&&saved.option&&!Array.from(el.options).some(o=>o.value===saved.value))el.add(new Option(saved.option,saved.value));
  if(el.type==='radio')el.checked=el.value===saved.value;else{el.value=saved.value;if(el.type==='checkbox')el.checked=saved.checked;}
 }if(f.elements.countCorrectionId?.value){const r=snapshot.pending?.find(r=>String(r.id)===String(f.elements.reportId?.value)),candidate=(f._countCandidates||[r?.countEvidence]).find(c=>c&&String(c.id)===f.elements.countCorrectionId.value);if(r)f.querySelector('[data-count-sequence]').textContent=countSequence(candidate,r);}}
 globalThis.WarehouseCombobox?.init(root);for(const f of root.querySelectorAll('[data-task-closure]'))updateClosureForm(f);
 globalThis.WarehouseCombobox?.restore(root);
}

function patchMyWorkRows(){
 const body=root.querySelector('[data-my-work-table]');if(!body)return;patchWorkFilterOptions();
 const dialog=root.querySelector('[data-my-work-dialog]'),active=document.activeElement;
 const rows=[...body.querySelectorAll('[data-task-row]')],observed=new Map([...(snapshot.watchedTasks||[]),...snapshot.tasks].map(t=>[String(t.id),t]));
 const protectedRow=row=>row.contains(active)||row.querySelector('form[data-edited]')||dialog?.open&&String(dialog.dataset.taskId)===row.dataset.taskRow;
 const anchor=rows.find(protectedRow),anchorTop=anchor?.getBoundingClientRect().top;
 const desired=myTasks(),wanted=new Set(desired.map(t=>String(t.id))),existing=new Map(rows.map(row=>[row.dataset.taskRow,row]));
 for(const row of rows){
  const fresh=observed.get(row.dataset.taskRow),keep=protectedRow(row);
  if(!wanted.has(row.dataset.taskRow)&&!keep){row.remove();existing.delete(row.dataset.taskRow);continue;}
  if(keep){
   const stale=!wanted.has(row.dataset.taskRow)||!myTaskActionable(fresh)||String(fresh?.assignment_generation)!==row.dataset.generation;
   for(const form of row.querySelectorAll('form[data-work-action="start"],form[data-work-action="resume"]')){
    for(const button of form.querySelectorAll('button'))button.disabled=stale||fresh?.progress_token!==form.elements.progressToken?.value;
    const feedback=form.querySelector('.form-feedback');if(feedback)feedback.textContent=stale?'Task unavailable. View its details.':'';
   }
  }
  if(!fresh)continue;
  const template=document.createElement('template');template.innerHTML=myTaskRow(fresh);const next=template.content.firstElementChild;
  if(keep){for(let i=0;i<row.children.length;i++)if(!row.children[i].hasAttribute?.('data-my-actions-cell')&&!row.children[i].contains(active))row.children[i].innerHTML=next.children[i].innerHTML;}
  else if(row.innerHTML!==next.innerHTML){row.replaceWith(next);existing.set(row.dataset.taskRow,next);next.classList.add('work-row-changed');}
 }
 if(!existing.size)body.innerHTML='';
 if(anchor){
  // Insert arrivals above the existing rows without moving an edited row's DOM node.
  // Reordering/removal of that row waits until focus and the action dialog are released.
  let before=body.firstElementChild;
  for(const task of desired)if(!existing.has(String(task.id))){const template=document.createElement('template');template.innerHTML=myTaskRow(task);const row=template.content.firstElementChild;body.insertBefore(row,before);existing.set(String(task.id),row);}
 }else{
  for(const task of desired){let row=existing.get(String(task.id));if(!row){const template=document.createElement('template');template.innerHTML=myTaskRow(task);row=template.content.firstElementChild;}body.append(row);}
 }
 if(!body.querySelector('[data-task-row]'))body.innerHTML=`<tr><td colspan="${path==='/work/history'?15:selectingTasks?13:12}" class="empty-cell">No matching tasks.</td></tr>`;
 patchMyNext();
 const pages=root.querySelector('[data-my-work-pagination]');if(pages)pages.innerHTML=['mine','history'].includes(snapshot.taskPage?.view)&&snapshot.taskPage.pages>1?pageLinks(snapshot.taskPage):'';
 if(dialog?.open){const t=observed.get(String(dialog.dataset.taskId)),choice=t&&myTaskChoice(t),stale=!online||!t||!wanted.has(String(t.id))||String(t.assignment_generation)!==dialog.dataset.generation||choice?.label!==dialog.dataset.choice;
  const warning=dialog.querySelector('[data-my-action-warning]');warning.hidden=!stale;warning.textContent=stale?'This task changed. Keep your note, close these actions and check the latest task before continuing.':'';
  for(const button of dialog.querySelectorAll('form button:not([type="button"])'))button.disabled=stale;
 }
 return anchor?anchor.getBoundingClientRect().top-anchorTop:0;
}
function lookupIdentity(){return JSON.stringify([snapshot.site,snapshot.dataset,snapshot.user.id,snapshot.capabilities||snapshot.user.role]);}
async function searchCombo(select,query,signal){
 const f=select.closest('form'),identity=lookupIdentity(),reportId=f.elements.reportId.value,revision=f.elements.caseRevision?.value;
 if(!online)throw new Error('Reconnect to search the full history.');
 const kind=select.dataset.searchRemote,endpoint=kind==='counts'?'countCandidates':'movements';
 const response=await fetch('/api/work/'+endpoint+'?'+new URLSearchParams({reportId,q:query}),{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'Search failed. Type or reopen to retry.');
 if(signal.aborted||!select.isConnected||identity!==lookupIdentity()||data.actorId!==snapshot.user.id||data.site!==snapshot.site||data.dataset!==snapshot.dataset||f.elements.reportId.value!==reportId||f.elements.caseRevision?.value!==revision||!snapshot.pending.some(r=>String(r.id)===String(reportId)&&(revision==null||String(r.case_revision)===String(revision))))throw new Error('Account, warehouse or review changed. Reopen the review before searching.');
 if(kind==='counts'){f._countCandidates=data.counts;return {options:data.counts.map(c=>({value:c.id,label:`${countCandidateLabel(c)} · ${c.lines.map(l=>l.name+': actual '+l.actual+' / difference '+l.difference+' '+l.unit).join('; ')} · reviewed by ${c.reviewer_name||'Unknown'}`})),message:data.counts.length?`${data.counts.length} counts found. Check physical evidence before choosing.`:'No matching counts. Try another date, person or name.'};}
 return {options:data.movements.map(m=>({value:m.id,label:`${new Date(m.created_at).toLocaleString()} · ${m.quantity} ${m.unit} · ${m.performer_name||'Unknown'} · ${m.origin_ref}`})),message:data.movements.length===100?'Showing 100 matches. Refine the reference or date to find older movements.':data.movements.length?`${data.movements.length} matching movements. Choose and verify the correct one.`:'No matching movements. Try another reference, person or date.'};
}
// Review saves are online, final commands. Only an explicit retry resends an
// uncertain result, using its exact durable request identity and original data.
function pendingPhysicalSave(taskId=null){return outbox.find(o=>o.reviewSave&&currentSavedUpdate(o)&&['review-saving','review-unknown'].includes(o.state)&&(taskId==null||Number(o.input.taskId)===Number(taskId)));}
function physicalSaveStatus(entry=null){return (entry?[entry]:outbox.filter(o=>o.reviewSave&&currentSavedUpdate(o)&&['review-saving','review-unknown'].includes(o.state))).map(o=>`<p class="work-callout warning" role="status">${o.action==='recordMovement'?'Movement':`Task #${esc(o.input.taskId)}`}: save not confirmed. Reconnect and retry this save; do not enter the movement again. <button type="button" data-retry-physical-save="${esc(o.id)}">Retry save</button></p>`).join('');}
function patchPhysicalSaveStatus(){const target=root.querySelector?.('[data-physical-save-status]');if(target)target.innerHTML=physicalSaveStatus();}
async function savePhysicalReview(f,action,values){
 if(!online)throw new Error('Reconnect to the warehouse and press Save again. Your quantities stay here.');
 const t=availableTask(values.taskId);
 if(!t||taskHasSavedUpdate(t)||outbox.some(o=>currentSavedUpdate(o)&&['local','sending','error','rejected'].includes(o.state)&&o.action==='manual'))throw new Error('An earlier movement has not reached the warehouse yet. Send that saved movement first, then save these final quantities.');
 const id=uid(),o={id,partition:key(),reviewSave:true,action,input:{...values,alignPhysical:true,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId},draftId:draftKey(f),state:'review-saving',createdAt:new Date().toISOString()};
 await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');
 if(root.querySelector?.('[data-task-dialog]')?.open)patchTaskDialog();
 await deliverPhysicalReview(o);
}
async function deliverPhysicalReview(o){
 if(!currentSavedUpdate(o)||!currentActivation(o))throw new Error('Sign in to the original account and warehouse to retry this save.');
 let response,result;
 try{
  response=await fetch('/api/work/'+o.action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(o.input)});
  result=await response.json();
 }catch{ /* A lost response does not prove the transaction failed. */ }
 const rejected=response&&[400,401,403,404,409,422].includes(response.status)&&result?.error;
 if(rejected){o.state='not-applied';o.message=result.error;}
 else if(response?.ok&&result?.status==='recorded'&&(result.closed===true||o.action==='recordMovement')){o.state='recorded';o.result=result;o.message=o.action==='recordMovement'?'Movement saved. Stock updated.':'Movement saved. Task closed.';}
 else if(o.action==='sendTaskReview'&&response?.ok&&result?.status==='review'){o.state='review';o.result=result;o.message=result.message;}
 else{o.state='review-unknown';o.message='Save not confirmed. Reconnect and use Retry save here. Do not enter the movement again.';}
 await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');patchPhysicalSaveStatus();
 if(!['recorded','review'].includes(o.state))throw new Error(o.message);
 await store('cache','readwrite',s=>s.delete(o.draftId));drafts.delete(o.draftId);announce(o.message);
 paintNotifications();
 if(o.action==='recordMovement'){try{await refresh();}catch{online=false;}dirty=false;render();return;}
 try{await refresh();await afterReviewSave(Number(o.input.taskId),o.action);}
 catch{
  // The durable warehouse receipt is authoritative even if refreshing fails.
  // Never ask the user to resubmit a successful movement as a new command.
  notice=o.state==='review'?'Final quantities saved for supervisor review. Reconnect to refresh the task list.':'Movement saved and task closed. Reconnect to refresh the task list.';
  for(const name of ['tasks','returnedTasks','watchedTasks'])if(snapshot[name])snapshot[name]=snapshot[name].filter(t=>t.id!==Number(o.input.taskId));
  const d=root.querySelector?.('[data-task-dialog]');d?.close();dirty=false;render();
 }
}
let syncing=false;
let syncDone=Promise.resolve();
async function sync(){
 if(!snapshot)return;if(syncing){await syncDone;return sync();}syncing=true;
 let finishSync;syncDone=new Promise(resolve=>{finishSync=resolve;});
 try{
  await refresh();
  outbox=await all('outbox');
  for(const o of outbox.filter(o=>o.partition===key()&&['local','sending','error'].includes(o.state))){
   if(isActivation(o.action,o.input)){o.state='activation-unknown';o.message='This saved Start / Resume needs an explicit retry.';await store('outbox','readwrite',s=>s.put(o));continue;}
   // The frozen request is retried byte-for-byte under its original user/site identity.
   const r=await fetch('/api/work/'+o.action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(o.input)});
   const result=await r.json();
   if(!r.ok){o.state=r.status===400?(['report','manual','correct'].includes(o.action)?'rejected':'not-applied'):'error';o.message=result.error||'Not received. Keep this entry and contact your supervisor.';announce(o.message);}
   else{o.state=result.status;o.message=result.message;o.result=result;announce(result.message);}
   await store('outbox','readwrite',s=>s.put(o));
  }
  await refresh();outbox=await all('outbox');
 }catch(e){online=false;connectionWarning=e instanceof TypeError?'Connection unavailable. Updates remain saved on this device.':e.message||'Connection unavailable. Updates remain saved on this device.';}
 finally{syncing=false;finishSync();}
}
async function saveDraft(f){
 const values={};for(const el of f.elements)if(el.name&&el.type!=='hidden'&&el.type!=='submit'&&(el.type!=='radio'||el.checked))values[el.name]={value:el.value,checked:el.checked,...(el.dataset?.searchRemote&&el.value?{option:el.selectedOptions[0]?.textContent,...(el.dataset.searchRemote==='counts'?{candidate:(f._countCandidates||[snapshot.pending?.find(r=>String(r.id)===String(f.elements.reportId?.value))?.countEvidence]).find(c=>c&&String(c.id)===el.value)}:{})}:{})};
 if(f.dataset.workAction==='closeTask'||f.dataset.draftKind==='closure-review')values._actuals=closureActualValues(f);
 if(f.dataset.workAction==='recordMovement')values._recordRows=recordRows(f);
 const id=draftKey(f);drafts.set(id,values);await store('cache','readwrite',s=>s.put({id,values}));
}
async function showSummary(l,method,locationValue='',reason='Operator confirmed location without QR') {
 const id=stageKey(l),value={method,location:locationValue,reason:method==='manual'?reason:''};
 await store('cache','readwrite',s=>s.put({id,stage:value}));stages.set(id,value);render();openCellConfirmation();
}
function findLine(id){return snapshot.tasks.flatMap(t=>t.lines).find(l=>l.id===Number(id));}
function advanceTaskLocation(taskId,finishedLineId){
 if(path!==`/tasks/${taskId}`)return;
 const t=snapshot.tasks.find(t=>t.id===Number(taskId)),next=t?.lines.find(l=>l.id!==Number(finishedLineId)&&['ready','working'].includes(l.execution_state)&&!(l.reports||[]).some(r=>['review','received'].includes(r.status)));
 if(!next)return;
 const query=new URLSearchParams(location.search);query.set('line',String(next.id));window.history.replaceState({},'',`${path}?${query}`);
}
async function immediate(action,values){
 const r=await fetch('/api/work/'+action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({...values,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId})});
 const result=await r.json();if(!r.ok)throw new Error(result.error);return result;
}
root.addEventListener('combobox:search',e=>{if(!e.target.matches('select[data-search-remote]'))return;e.preventDefault();searchCombo(e.target,e.detail.query,e.detail.signal).then(e.detail.resolve,error=>e.detail.reject(error.message));});
root.addEventListener('invalid',e=>{for(let p=e.target.parentElement;p&&p!==root;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;},true);
root.addEventListener('input',e=>{
 const filter=e.target.closest('.my-work-filters');if(filter){updateFilterApply(filter);dirty=workFiltersChanged(filter);return;}
  dirty=true;const f=e.target.closest('form');if(f)f.dataset.edited='true';if(f?.dataset.workAction)saveDraft(f).catch(()=>{notice='Draft not saved: device storage failed. Use the manual recording procedure.';paintNotifications();});
 if(f)updateRecoveryLink(f);
 if(f)updateCellConfirmation(f);
 if(f&&e.target.name==='verificationNote')updateVerificationFields(f);
 if(f&&e.target.name==='unit')updateProductPicker(f);

});
root.addEventListener('change',e=>{if(e.target.matches('[data-select-task],[data-select-all]')){changeTaskSelection(e.target);return;}const filter=e.target.closest('.my-work-filters');if(filter){if(e.target.matches('[data-add-filter]')){changeFilterColumn(filter,e.target.value,true);return;}if(['reviewOnly','activeOnly'].includes(e.target.name))void applyWorkFilters(filter,true);else if(e.target.name==='pageSize')void applyWorkFilters(filter,'pageSize');else updateFilterApply(filter);dirty=workFiltersChanged(filter);return;}const changedForm=e.target.closest('form');if(changedForm){updateRecordLocations(changedForm);updateClosureForm(changedForm);updateCellConfirmation(changedForm);if(['changeDue','deadlineChoice'].includes(e.target.name))updateReturnedDue(changedForm);updateRecoveryLink(changedForm);updateAssignmentForm(changedForm);if(e.target.name==='verification')updateVerificationFields(changedForm);if(e.target.name==='timeUnit')updateTimingFields(changedForm,true);}if(e.target.name==='productId'){updateProductPicker(e.target.closest('form'));refreshProductStocks(true,e.target.closest('form'));}else if(e.target.name==='direction')refreshProductStocks(true,e.target.closest('form'));if(e.target.name==='assigneeId')patchTaskAssignees();if(e.target.name==='countCorrectionId'){const f=e.target.closest('form'),r=snapshot.pending.find(r=>r.id===f.elements.reportId?.value),candidate=(f._countCandidates||[r?.countEvidence]).find(c=>c&&String(c.id)===e.target.value);if(r)f.querySelector('[data-count-sequence]').textContent=countSequence(candidate,r);}dirty=true;const f=e.target.closest('form');if(f)f.dataset.edited='true';if(f?.dataset.workAction)saveDraft(f).catch(()=>{});});
let submitting=false;
root.addEventListener('submit',async e=>{
 const recovery=e.target.closest('[data-plan-recovery]');if(recovery?.matches?.('[data-plan-recovery]')){e.preventDefault();if(submitting)return;submitting=true;const b=recovery.querySelector('button[type="submit"]');b.disabled=true;try{await submitPlanRecovery(recovery);}catch(error){recovery.querySelector('.form-feedback').textContent=error.message;}finally{submitting=false;b.disabled=false;}return;}
 const filters=e.target.closest('.my-work-filters');if(filters?.matches?.('.my-work-filters')){e.preventDefault();if(workFiltersChanged(filters))await applyWorkFilters(filters);return;}
 const bulk=e.target.closest('[data-bulk-discard-form]');if(bulk?.hasAttribute?.('data-bulk-discard-form')){e.preventDefault();await submitBulkDiscard(bulk);return;}
 const f=e.target.closest('form[data-work-action]');if(!f)return;e.preventDefault();if(submitting)return;submitting=true;
 const button=f.querySelector('button:not([type="button"])');button.disabled=true;
 const feedback=f.querySelector('.form-feedback');let action=e.submitter?.hasAttribute('data-send-task-review')?'sendTaskReview':e.submitter?.hasAttribute('data-assign-remaining')?'resolveAndAssignRemaining':f.dataset.workAction;
 try{
  await saveDraft(f);
  requireSavedCheckObservation(f);
  if(f._workIdentity&&(f._workIdentity.site!==snapshot.site||f._workIdentity.dataset!==snapshot.dataset||f._workIdentity.actorId!==snapshot.user.id))throw new Error('This draft belongs to the original account and warehouse dataset. Reopen the task before saving.');
  outbox=await all('outbox');
  const values=Object.fromEntries(new FormData(f));
  if(action==='updateReviewTask'){values.changeDue=values.deadlineChoice==='duration'||values.deadlineChoice==='none';values.noDeadline=values.deadlineChoice==='none';delete values.deadlineChoice;}
  const countLinks={};for(const name of Object.keys(values))if(/^countLink\d+$/.test(name)){countLinks[name.slice(9)]=values[name];delete values[name];}if(Object.keys(countLinks).length)values.countLinks=countLinks;
  if(f.dataset.workAction==='closeTask'||f.dataset.draftKind==='closure-review'){values.actuals=closureActualValues(f);for(const name of Object.keys(values))if(/^actual(Cell|Quantity)/.test(name))delete values[name];}
  for(const n of ['alignPhysical','noDeadline','verifiedClosure','workerStopped','changeDue','manual','keepOpen','dismissDuplicate','closeAllocation','zeroConfirmed','afterCountVerified','stopRemaining','enabled','cellCompletion','differenceConfirmed','taskFinish','unfinishedConfirmed'])if(n in values)values[n]=values[n]===true||values[n]==='on'||values[n]==='true';
  if(action==='report'&&!online)values.manual=true;
  if(values.occurredAt)values.occurredAt=new Date(values.occurredAt).toISOString();
  if(values.dueAt)values.dueAt=new Date(values.dueAt).toISOString();
  if(values.countChoice==='included'&&!values.countCorrectionId)throw new Error('Choose the stock count that already includes these items.');
  if(values.countChoice==='separate'){values.afterCountVerified=true;delete values.countCorrectionId;}
  if(values.countCorrectionId&&values.countChoice!=='included')throw new Error('Confirm whether these items were already included or were a separate movement.');
  if('verificationNote' in values)values.verification=verifiedDescription(values);
  if(values.note&&action==='decline')values.reason=[values.reason,values.note].filter(Boolean).join(' — ');
  if(action==='manual'&&!values.unit?.trim())values.unit=snapshot.products.find(p=>p.id===Number(values.productId))?.unit_of_measure;
  if(action==='recordMovement'){await saveRecordedMovement(f,values);}
  else if(['create','assign','reopen'].includes(action)){await submitPlan(action,values,draftKey(f));}
  else if(f.dataset.reviewMovement!==undefined){
   await savePhysicalReview(f,action,values);
  }else if(['closeTask','sendTaskReview','updateReviewTask'].includes(action)||f.dataset.draftKind==='closure-review'||f.dataset.draftKind==='discard-task'){
   if(!online)throw new Error('Reconnect before saving this task. Your entries remain saved as a draft.');
   if(action!=='updateReviewTask'&&!values.currentStatus)throw new Error('Choose Yes or No first.');
   const t=availableTask(values.taskId)||snapshot.pending?.find(r=>r.id===values.reportId)?.closureTask;if(!t||taskHasSavedUpdate(t)||outbox.some(o=>o.partition===key()&&['local','sending','error','rejected'].includes(o.state)&&o.action==='manual'))throw new Error('Send saved movement updates and wait for confirmation before closing this task.');
   const id=uid(),input={...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId};
   await store('outbox','readwrite',s=>s.put({id,partition:key(),action,input,label:savedAction({action,input}),state:'local',message:action==='updateReviewTask'?'Assignment awaiting warehouse confirmation.':'Closure awaiting warehouse confirmation. Task is not closed yet.',createdAt:new Date().toISOString()}));
   outbox=await all('outbox');await sync();const received=outbox.find(o=>o.id===id);
   if(!received?.result)throw new Error(received?.message||'Change not confirmed. Use saved update status to retry this same request; your draft is kept.');
   await store('cache','readwrite',s=>s.delete(draftKey(f)));drafts.delete(draftKey(f));announce(received.message);await afterReviewSave(Number(values.taskId),action);
  }else if(isActivation(action,values)){await beginActivation(action,values);await store('cache','readwrite',s=>s.delete(draftKey(f)));drafts.delete(draftKey(f));}
  else if(action==='acquire'){if(!lineActive(findLine(values.lineId)))throw new Error('Resume this task before arriving.');
   if(!online)throw new Error('Reconnect to request a turn. You may still report physical work already done.');
   f._input||={...values,requestId:uid()};const result=await immediate(action,f._input);announce(result.message);
   await refresh();render();if(result.status==='ready')void scanQR(findLine(values.lineId)).catch(error=>{notice=error.message;render();});
  }else{
   if(!online&&!['report','manual','decline','handBack','cancel','stop','askReview'].includes(action))throw new Error('Reconnect before changing plans or resolving work.');
   if(action==='assign'&&assignmentPending())throw new Error('Wait for confirmation of the saved assignment before assigning again.');
   if(['report','cancel'].includes(action)&&outbox.some(o=>o.partition===key()&&Number(o.input.lineId)===Number(values.lineId)&&['local','sending','error','rejected'].includes(o.state)))throw new Error('An entry for this location is already saved. Send saved updates and wait for confirmation before changing it.');
   if(['stop','decline','handBack','updateReturned','assignReview','resumeFollowup'].includes(action)){const task=[...snapshot.tasks,...(snapshot.returnedTasks||[])].find(t=>t.id===Number(values.taskId));if(outbox.some(o=>o.partition===key()&&['local','sending','error','rejected'].includes(o.state)&&['report','manual','correct'].includes(o.action)&&(task?.lines||[]).some(l=>l.id===Number(o.input.lineId))))throw new Error('Send saved updates and wait for confirmation before stopping or returning this task.');}
   const id=uid(),input={...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId};
   const message=['decline','handBack'].includes(action)?'Return request saved — awaiting warehouse confirmation':['cancel','stop'].includes(action)?'Stop request saved — awaiting warehouse confirmation. Stock stays assigned until the warehouse confirms.':'Saved on this phone — awaiting warehouse confirmation.';
   await store('outbox','readwrite',s=>s.put({id,partition:key(),action,input,label:savedAction({action,input}),state:'local',message,createdAt:new Date().toISOString()}));
   if(action==='manual')provisionalReference(true);
   await store('cache','readwrite',s=>s.delete(draftKey(f)));drafts.delete(draftKey(f));
   outbox=await all('outbox');announce(message);render();await sync();const received=outbox.find(o=>o.id===id);
   if((action==='report'&&values.cellCompletion&&received?.state==='recorded')||(action==='rejectCell'&&received?.state==='review'))advanceTaskLocation(Number(received.result?.taskId||findLine(values.lineId)?.task_id),values.lineId);
   render();if(received&&!['recorded','review','reserved','ready','verified','duplicate','busy'].includes(received.state))openOperationDialog({message:received.message,stage:'error'});
  }
 }catch(error){if(['create','assign','reopen','start','resume','acquire'].includes(action)){button.disabled=false;await planningFailure(error,action,Object.fromEntries(new FormData(f)),draftKey(f));}else{feedback.textContent=workText(error.message);feedback.classList.add('error');feedback.setAttribute?.('tabindex','-1');feedback.focus?.();feedback.scrollIntoView?.({block:'nearest'});button.disabled=action==='assign'&&(assignmentPending()||!online);if(f.dataset.reviewMovement===undefined&&action!=='reopen')notice=error.message;if(!f.isConnected||isActivation(action))render();}}
 finally{submitting=false;if(f.closest?.('[data-task-dialog]'))patchTaskDialog();}
});
root.addEventListener('click',async e=>{
 try{
  if(e.target.closest('[data-dialog-dismiss]')){await modalBack();return;}
  if(e.target.closest('[data-operation-back]')){await modalBack();return;}
  const pc=e.target.closest('[data-plan-choice]');if(pc){pc.disabled=true;try{await choosePlanRecovery(pc.dataset.planChoice);}catch(error){const d=pc.closest('[data-operation-dialog]');let p=d.querySelector('.form-feedback');if(!p){p=document.createElement('p');p.className='form-feedback';p.setAttribute('role','alert');d.append(p);}p.textContent=error.message;}finally{pc.disabled=false;}return;}
  const pr=e.target.closest('[data-retry-plan]');if(pr){if(submitting)return;submitting=true;try{const o=outbox.find(o=>o.id===pr.dataset.retryPlan);if(o){if(['start','resume'].includes(o.action)){await deliverActivation(o);root.querySelector('[data-operation-dialog]')?.close();}else{await deliverPlan(o);await finishPlan(o);}}}catch(error){await planningFailure(error,error.request?.action,error.request?.input);}finally{submitting=false;}return;}
  const cr=e.target.closest('[data-remove-count],[data-add-count]');if(cr){const d=cr.closest('[data-operation-dialog]');if(cr.hasAttribute('data-remove-count'))cr.closest('tr').remove();else{const rows=d.querySelector('[data-count-rows]');rows.insertAdjacentHTML('beforeend',recoveryCountRow(d._frame.data.cells.filter(c=>!c.blocked),Date.now()));for(const el of rows.querySelectorAll('[data-count-unit]'))el.textContent=d._frame.data.unit;globalThis.WarehouseCombobox?.init(rows);}return;}
  if(e.target.closest('[data-review-back],[data-task-dialog-close]')){await modalBack();return;}
  const retrySave=e.target.closest('[data-retry-physical-save]');if(retrySave){if(submitting)return;submitting=true;let failure;try{const o=outbox.find(o=>o.id===retrySave.dataset.retryPhysicalSave&&currentSavedUpdate(o));if(o)await deliverPhysicalReview(o);}catch(error){failure=error;}finally{submitting=false;patchTaskDialog();}if(failure&&!outbox.some(o=>o.id===retrySave.dataset.retryPhysicalSave&&['review-saving','review-unknown'].includes(o.state)))throw failure;return;}
  const choice=e.target.closest('[data-review-align],[data-review-assignment],[data-review-discard]');if(choice){if(choice.disabled)return;const d=choice.closest('[data-task-dialog]');await saveModalDrafts();const mode=choice.hasAttribute('data-review-align')?'check-align':choice.hasAttribute('data-review-assignment')?'check-assignment':'check-discard';openTaskDialog(d._task,mode,null,d.dataset.mode==='check'?'push':'replace');return;}
  if(e.target.closest('[data-toggle-selection]')){selectingTasks=!selectingTasks;if(!selectingTasks)selectedTasks.clear();patchSelection(true);return;}
  const filterRemove=e.target.closest('[data-remove-filter]');if(filterRemove){changeFilterColumn(filterRemove.closest('form'),filterRemove.dataset.removeFilter,false);return;}
  if(e.target.closest('[data-bulk-discard]')){await startBulkDiscard();return;}
  const bulkAction=e.target.closest('[data-bulk-remove],[data-bulk-review],[data-bulk-update]');if(bulkAction){if(bulkBusy)return;const id=Number(bulkAction.dataset.bulkRemove||bulkAction.dataset.bulkReview||bulkAction.dataset.bulkUpdate);if(bulkAction.hasAttribute('data-bulk-remove')){selectedTasks.delete(id);bulkTasks=bulkTasks.filter(t=>t.id!==id);openBulkDialog('replace');patchSelection();return;}const t=await fetchDialogTask(id);bulkTasks=bulkTasks.map(x=>x.id===id?t:x);bulkErrors.delete(id);openTaskDialog(t,bulkAction.hasAttribute('data-bulk-review')?'check':'check-assignment');return;}
  if(e.target.closest('[data-show-saved],[data-connection-status]')){openOperationDialog({stage:'connection'});return;}
  const recordEdit=e.target.closest('[data-add-record],[data-remove-record]');if(recordEdit){const f=recordEdit.closest('form'),rows=f.querySelector('[data-record-rows]');if(recordEdit.hasAttribute('data-remove-record'))recordEdit.closest('[data-record-row]').remove();else{const index=Math.max(-1,...[...rows.querySelectorAll('[data-record-direction]')].map(el=>Number(el.name.replace('recordDirection',''))))+1;rows.insertAdjacentHTML('beforeend',recordRow({},index,f.elements.productId.value));}globalThis.WarehouseCombobox?.init(f);dirty=true;await saveDraft(f);return;}
  const edit=e.target.closest('[data-add-actual],[data-remove-actual]');if(edit){await saveDraft(editActualRows(edit));return;}
  const checkStop=e.target.closest('[data-check-stop]');if(checkStop){toggleCheckStop(checkStop);return;}
  const timelinePage=e.target.closest('[data-history-page]');if(timelinePage){await loadTaskHistory(timelinePage.closest('[data-task-dialog]').dataset.taskId,Number(timelinePage.dataset.historyPage));return;}
  const reopen=e.target.closest('[data-task-reopen]');if(reopen){openTaskDialog(await fetchDialogTask(Number(reopen.dataset.taskReopen)),'reopen');return;}
  const editorLink=e.target.closest('[data-task-edit]');if(editorLink){e.preventDefault();const id=Number(editorLink.dataset.taskEdit),t=online?await fetchDialogTask(id):availableTask(id);if(!t)throw new Error('Reconnect to open this task.');openTaskDialog(t,'edit');return;}
  const historyLink=e.target.closest('[data-task-history]');if(historyLink){e.preventDefault();if(root.querySelector('[data-task-dialog]')?.open)await saveModalDrafts();openTaskDialog(await fetchDialogTask(Number(historyLink.dataset.taskHistory)),'details');return;}
  const taskModal=e.target.closest('[data-task-details],[data-task-stop],[data-task-check],[data-record-moved]');if(taskModal){taskModal.closest?.('[data-cell-action-dialog]')?.close();const lineId=taskModal.dataset.recordMoved;let t=snapshot.tasks.find(t=>lineId?t.lines.some(l=>l.id===Number(lineId)):t.id===Number(taskModal.dataset.taskDetails||taskModal.dataset.taskStop||taskModal.dataset.taskCheck));if(online&&(taskModal.dataset.taskStop||taskModal.dataset.taskCheck||!t))t=await fetchDialogTask(Number(taskModal.dataset.taskDetails||taskModal.dataset.taskStop||taskModal.dataset.taskCheck));if(t)openTaskDialog(t,lineId?'recovery':taskModal.dataset.taskDetails?'details':taskModal.dataset.taskStop?'stop':'check',lineId);return;}
  const cellOpen=e.target.closest('[data-open-cell-action]');if(cellOpen){const d=root.querySelector('[data-cell-action-dialog]');d?.showModal();d?.querySelector('h2')?.focus();return;}
  const cellChoice=e.target.closest('[data-cell-action-choice]');if(cellChoice){const d=cellChoice.closest('[data-cell-action-dialog]'),mode=cellChoice.dataset.cellActionChoice;for(const panel of d.querySelectorAll('[data-cell-action-panel]'))panel.hidden=panel.dataset.cellActionPanel!==mode;for(const button of d.querySelectorAll('[data-cell-action-choice]'))button.setAttribute('aria-pressed',String(button===cellChoice));return;}
  if(e.target.closest('[data-close-cell-action]')){e.target.closest('[data-cell-action-dialog]')?.close();return;}
  const nextSubtask=e.target.closest('[data-next-subtask]');if(nextSubtask){stopCamera?.();window.history.pushState({},'',`/tasks/${Number(path.split('/')[2])}?line=${nextSubtask.dataset.nextSubtask}`);render();return;}
  const stockRetry=e.target.closest('[data-stock-retry]');if(stockRetry){refreshProductStocks(true,stockRetry.closest('form'));return;}
  const nextLocation=e.target.closest('[data-active-location]');if(nextLocation){const t=snapshot.tasks.find(t=>t.id===Number(path.split('/')[2]));if(workActive(t)){e.preventDefault();stopCamera?.();window.history.pushState({},'',nextLocation.getAttribute('href'));render();return;}}
  if(e.target.closest('[data-complete-task]')){const d=root.querySelector('[data-task-finish-dialog]');d?.showModal();d?.querySelector('h2')?.focus();return;}
  if(e.target.closest('[data-close-task-finish]')){root.querySelector('[data-task-finish-dialog]')?.close();return;}
  const unfinished=e.target.closest('[data-go-unfinished]');if(unfinished){root.querySelector('[data-task-finish-dialog]')?.close();const t=snapshot.tasks.find(t=>t.id===Number(path.split('/')[2]));if(t){window.history.pushState({},'',`/tasks/${t.id}?line=${unfinished.dataset.goUnfinished}`);render();}return;}
  if(e.target.closest('[data-close-cell-confirmation]')){e.target.closest('[data-cell-confirmation]')?.close();return;}
  if(e.target.closest('[data-open-cell-confirmation]')){openCellConfirmation();return;}
  if(e.target.closest('[data-refresh-guidance]')){await refreshActiveLight();return;}
  const retryActivation=e.target.closest('[data-retry-activation]');if(retryActivation){if(submitting)return;submitting=true;try{const o=outbox.find(o=>o.id===retryActivation.dataset.retryActivation&&o.partition===key());if(o)await deliverActivation(o);}finally{submitting=false;}return;}
  const taskAction=e.target.closest('[data-update-returned],[data-hand-back]');if(taskAction){const id=Number(taskAction.dataset.updateReturned||taskAction.dataset.handBack),found=[...(snapshot.returnedTasks||[]),...snapshot.tasks,...(snapshot.watchedTasks||[])].find(t=>t.id===id);let t=found;if(!t&&online){t=await fetchDialogTask(id);snapshot.watchedTasks=[...(snapshot.watchedTasks||[]),t];}if(!t)throw new Error('Reconnect to open the latest task.');if(t)openTaskDialog(t,taskAction.dataset.updateReturned?'update':'return');return;}
  const myMore=e.target.closest('[data-my-actions]');if(myMore){const t=[...snapshot.tasks,...(snapshot.watchedTasks||[])].find(t=>t.id===Number(myMore.dataset.myActions));if(t)myActionDialog(t);return;}
  if(e.target.closest('[data-my-close]')){root.querySelector('[data-my-work-dialog]')?.close();return;}
  const preview=e.target.closest('[data-view-saved]');if(preview){const f=preview.closest('form'),option=f.elements.duplicateOf.selectedOptions[0];f.querySelector('[data-saved-entry]').textContent=option?.value?option.textContent:'Choose a saved entry to inspect.';return;}
  const ack=e.target.closest('[data-ack-request]');if(ack){const entry=outbox.find(o=>o.id===ack.dataset.ackRequest&&o.partition===key());if(entry?.state==='not-applied'){entry.state='acknowledged';await store('outbox','readwrite',s=>s.put(entry));render();}return;}
  if(e.target.closest('[data-print]'))window.print();
  const q=e.target.closest('[data-quantity]');if(q){const field=q.closest('form').elements.quantity;field.value=q.dataset.quantity;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();}
  if(e.target.closest('[data-retry]')){const d=root.querySelector('[data-operation-dialog]'),frame=d?.open?d._frame:null;await sync();render();if(frame)openOperationDialog(frame,'restore');return;}
  if(e.target.closest('[data-export]')){
   const reports=outbox.filter(o=>o.partition===key()),savedDrafts=(await all('cache')).filter(r=>r.values&&r.id.startsWith(key()+':')),blob=new Blob([JSON.stringify({warehouse:snapshot.site,account:snapshot.user.username,reports,drafts:savedDrafts},null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='warehouse-saved-updates.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);return;
  }
  if(e.target.closest('[data-forget]')){
   if(outbox.some(o=>['local','sending','error','rejected','plan-sending','plan-unknown','activation-pending','activation-unknown','review-saving','review-unknown'].includes(o.state))){notice='Unreceived updates remain. Send or download them before clearing local data.';render();return;}
   // Clear only this account; another account's cache and evidence stay partitioned.
   for(const row of await all('cache'))if(row.id.startsWith(key()+':')||row.id===key())await store('cache','readwrite',s=>s.delete(row.id));
   for(const row of outbox.filter(o=>o.partition===key()))await store('outbox','readwrite',s=>s.delete(row.id));
   snapshot=null;outbox=[];render();return;
  }
  const manual=e.target.closest('[data-manual-summary]');if(manual){stopCamera?.();await showSummary(findLine(manual.dataset.manualSummary),'manual');return;}
  const scan=e.target.closest('[data-scan-line]');if(scan)await scanQR(findLine(scan.dataset.scanLine));
  const link=e.target.closest('a');if(link&&!online&&link.getAttribute('href')?.startsWith('/')){const target=link.getAttribute('href');if(['/work','/pick','/put','/record-movement'].includes(target)||/^\/tasks\/\d+$/.test(target)){e.preventDefault();if(activeWork)throw new Error('Reconnect before leaving this task so its lights can be paused.');path=target;render();}}
 }catch(error){notice=error.message;const d=e.target.closest('[data-task-dialog]'),warning=d?.querySelector('[data-task-dialog-warning]');if(warning){warning.hidden=false;warning.textContent=error.message;}else render();}
});
let stopCamera=null;
async function scanQR(l){
 if(!l)return;stopCamera?.();
 let stopped=false,stream,dialog;
 const stop=()=>{stopped=true;stream?.getTracks().forEach(t=>t.stop());cameraStream=null;dialog?.remove();if(stopCamera===stop)stopCamera=null;};stopCamera=stop;
 if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){stop();await showSummary(l,'manual','','No camera / camera unavailable');return;}
 try{
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(stopped){stream.getTracks().forEach(t=>t.stop());return;}cameraStream=stream;
  dialog=document.createElement('dialog');dialog.className='qr-dialog';dialog.innerHTML=`<header class="qr-dialog-header"><h2>Scan this cell</h2><button type="button" class="dialog-dismiss" data-close-camera aria-label="Skip scan and enter actual movement" title="Skip scan"><span aria-hidden="true">×</span></button></header><p>${esc(l.product_name)} · ${esc(l.type)} ${esc(l.planned_quantity)} ${esc(l.unit_of_measure)} · ${esc(l.logical_code)}</p><p>Scanning checks the cell. Complete ${esc(l.type)} only after confirming the actual location and quantity.</p><video autoplay playsinline muted></video><p role="status" class="scan-feedback"></p><button type="button" class="secondary" data-camera-manual>Confirm without scanning</button>`;
  document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-close-camera]').onclick=async()=>{stop();await showSummary(l,'manual');};dialog.addEventListener('cancel',e=>{e.preventDefault();stop();void showSummary(l,'manual');});
  dialog.querySelector('[data-camera-manual]').onclick=async()=>{stop();await showSummary(l,'manual');};
  const video=dialog.querySelector('video');video.srcObject=stream;await video.play();const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let lastRejected='';
  if(stopped)return;
  async function frame(){
   if(stopped)return;
   if(video.readyState>=2){canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const p=ctx.getImageData(0,0,canvas.width,canvas.height),code=window.jsQR(p.data,p.width,p.height);
    if(code&&code.data!==lastRejected){try{const result=await immediate('verify',{requestId:uid(),lineId:l.id,revision:l.revision,assignmentGeneration:l.current_generation,location:code.data});if(stopped)return;announce(result.message);stop();await showSummary(l,'camera',code.data);return;}catch(error){lastRejected=code.data;if(!stopped)dialog.querySelector('.scan-feedback').textContent=error.message;}}
   }
   if(!stopped)requestAnimationFrame(frame);
  }requestAnimationFrame(frame);
 }catch(error){if(stopped)return;stop();await showSummary(l,'manual','','No camera / camera unavailable');}
}
onPage(document,'click',async e=>{
 const link=e.target.closest?.('a[href]');
 if(globalThis.WarehouseNavigation)return;
 if(!link||!activeWork||!/^\/tasks\/\d+$/.test(path)||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||link.target==='_blank'||link.hasAttribute('download'))return;
 const destination=new URL(link.href,location.href);
 if(destination.pathname===path)return;
 e.preventDefault();
 try{await pauseActiveWork();location.assign(destination.href);}
 catch(error){notice=error.message;render();}
},true);
onPage(window,'pagehide',()=>{stopCamera?.();void pauseActiveWork({keepalive:true});});
onPage(window,'popstate',handleModalPop);
onPage(window,'offline',()=>{online=false;productStockReads.clear();refreshProductStocks();patchGuidanceHints();patchTaskDialog();connectionWarning='Connection lost. Saved updates remain on this phone.';if(!dirty&&!root.querySelector('[data-operation-dialog]')?.open&&!root.querySelector('[data-my-work-dialog]')?.open&&!root.querySelector('[data-task-dialog]')?.open)render();else{if(path==='/work')patchLiveRows();}paintNotifications();});
const canRefresh=()=>!bulkBusy&&!root.querySelector('[data-operation-dialog]')?.open&&!root.querySelector('[data-my-work-dialog]')?.open&&!root.querySelector('[data-task-dialog]')?.open&&!root.querySelector('[data-cell-confirmation]')?.open&&!dirty&&!root.contains(document.activeElement)&&!stopCamera&&!submitting;
let monitoring=false,pollDelay=5000;
function patchLiveRows(){
 refreshProductStocks();patchGuidanceHints();patchReturnedRows();patchTaskAssignees();
 const pageTop=window.scrollY,scrolls=[...root.querySelectorAll('.work-table-wrap,.my-work-table-wrap')].map(el=>[el,el.scrollLeft,el.scrollTop]);
 let anchorShift=0;
 if(['/work','/work/history'].includes(path))anchorShift=patchMyWorkRows()||0;else {
 const visible=new Map((snapshot.tasks||[]).map(t=>[String(t.id),t]));
 const observed=new Map([...(snapshot.tasks||[]),...(snapshot.watchedTasks||[])].map(t=>[String(t.id),t]));
 for(const row of root.querySelectorAll('[data-task-row]')){
  const task=observed.get(row.dataset.taskRow);if(!task)continue;
  const template=document.createElement('template');template.innerHTML=taskRow(task);const next=template.content.firstElementChild;
  if(row.innerHTML===next.innerHTML)continue;
  if(row.contains(document.activeElement)||row.querySelector('form[data-edited]')){
    // Update the facts while retaining the exact form, generation, draft and focus being edited.
    const cells=[...row.children],fresh=[...next.children];for(let i=0;i<cells.length-1;i++)if(!cells[i].contains(document.activeElement)&&!cells[i].querySelector('form[data-edited]')&&cells[i].innerHTML!==fresh[i].innerHTML)cells[i].innerHTML=fresh[i].innerHTML;
  }else{
    const disclosures=new Map([...row.querySelectorAll('details[data-disclosure]')].map(d=>[d.dataset.disclosure,d.open]));
    row.replaceWith(next);for(const d of next.querySelectorAll('details[data-disclosure]'))if(disclosures.has(d.dataset.disclosure))d.open=disclosures.get(d.dataset.disclosure);next.classList.add('work-row-changed');
  }
 }
 const body=root.querySelector('[data-task-table]');if(body){const shown=new Set([...root.querySelectorAll('[data-task-row]')].map(r=>r.dataset.taskRow));for(const [id,task] of visible)if(!shown.has(id)&&shown.size<100){if(!shown.size)body.innerHTML='';body.insertAdjacentHTML('beforeend',taskRow(task));body.lastElementChild.classList.add('work-row-changed');shown.add(id);}}
 }
 const connection=root.querySelector('.work-connection');if(connection)connection.innerHTML=badge(online?'Connected to warehouse':'Offline · saved work',online?'good':'warning')+`<small>Updated ${esc(new Date(snapshot.generatedAt).toLocaleTimeString())}</small>`;
 // Review work is handled from My work.
 paintNotifications();
 const activeCount=root.querySelector('[data-work-active-count]');if(activeCount)activeCount.textContent='Continue working · '+(snapshot.taskCounts?.active??0);
 for(const [href,count] of [['/work/history?scope=team&state=open',snapshot.taskCounts?.active],['/work/history?scope=team&state=needs_assignment',snapshot.taskCounts?.needsAssignment],['/work/history?scope=team&state=overdue',snapshot.taskCounts?.overdue]]){const link=root.querySelector(`.task-tabs a[href="${href}"]`);if(link&&count!=null)link.textContent=link.textContent.split(' · ')[0]+' · '+count;}
 if(path==='/work/overview')for(const f of root.querySelectorAll('[data-assignment-form]'))updateAssignmentForm(f);
 for(const [el,x,y] of scrolls){el.scrollLeft=x;el.scrollTop=y;}window.scrollTo({top:pageTop+anchorShift,behavior:'instant'});
}
async function backgroundRefresh(){
 if(pageScope?.active===false)return;
 if(monitoring||submitting||bulkBusy||cameraStream?.active)return;monitoring=true;
 try{const wasOffline=!online;await sync();if(pageScope?.active===false)return;if(wasOffline&&online)refreshProductStocks(true);pollDelay=online?5000:Math.min(60000,pollDelay*2);if(canRefresh()){
  const positions=[...root.querySelectorAll('.work-table-wrap,.my-work-table-wrap')].map(el=>[el.scrollLeft,el.scrollTop]);const top=window.scrollY;render();[...root.querySelectorAll('.work-table-wrap,.my-work-table-wrap')].forEach((el,i)=>{if(positions[i]){el.scrollLeft=positions[i][0];el.scrollTop=positions[i][1];}});window.scrollTo({top,behavior:'instant'});
 }else patchLiveRows();}finally{monitoring=false;}
}
onPage(window,'online',backgroundRefresh);
onPage(window,'pageshow',e=>{if(e.persisted){activeWork=null;void backgroundRefresh();}});
onPage(document,'visibilitychange',async()=>{if(document.visibilityState==='hidden')stopCamera?.();else await backgroundRefresh();});
pageScope?.beforeLeave(async()=>{if(submitting||bulkBusy)throw new Error('Wait for this task update to finish before leaving.');await saveModalDrafts();for(const form of root.querySelectorAll('form[data-work-action]'))if(form.dataset.edited)await saveDraft(form);await pauseActiveWork();stopCamera?.();});
if(pageScope)pageScope.ownsPop=event=>location.pathname===path&&Boolean(event.state?.workModal||/^\/tasks\/\d+$/.test(path));
pageScope?.own(()=>db?.close());
try{
 db=await openDB();
 if(pageScope?.active===false){db.close();return;}
 if(snapshot)await cacheSnapshot();else{const active=await store('cache','readonly',s=>s.get('active'));snapshot=(await store('cache','readonly',s=>s.get(active?.key||'')))?.snapshot;}
 for(const row of await all('cache')){if(row.stage)stages.set(row.id,row.stage);if(row.values)drafts.set(row.id,row.values);}
 outbox=await all('outbox');
 for(const o of outbox.filter(o=>o.state==='rejected'&&!['report','manual','correct'].includes(o.action))){o.state='not-applied';await store('outbox','readwrite',s=>s.put(o));}
}catch(error){notice='Device storage is unavailable. Updates are not saved locally; use the manual recording procedure.';}
render();
if(boot)await backgroundRefresh();
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});
async function pollWork(){if(document.visibilityState==='visible')await backgroundRefresh();setTimeout(pollWork,pollDelay);}setTimeout(pollWork,pollDelay);



}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)await mount();
