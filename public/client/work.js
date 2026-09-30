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
let deviceId;
try { deviceId=localStorage.getItem('warehouse-device')||uid();localStorage.setItem('warehouse-device',deviceId); } catch {deviceId=uid();}
const key=()=>`${snapshot.site}:${snapshot.user.id}`;
const badge=(text,tone='')=>`<span class="work-badge ${tone}">${esc(text)}</span>`;
const input=(name,label,type='text',attrs='')=>`<label>${esc(label)}<input name="${name}" type="${type}" ${attrs}></label>`;
const qty=(label='Actual quantity')=>input('quantity',label,'number','min="0" max="1000000000" step="0.000001" inputmode="decimal" required placeholder="Enter actual, including 0"');
const options=(items,value,label,selected)=>items.map(i=>`<option value="${esc(i[value])}" ${String(i[value])===String(selected)?'selected':''}>${esc(label(i))}</option>`).join('');
const status=s=>({ready:'Ready to start',working:'In progress',settled:'Recorded',cancelled:'Cancelled',superseded:'Replanned',pending_review:'In progress',completed:'Completed',review:'Needs review',reserved:'Reserved',received:'Received',rejected:'Not received — check entry',recorded:'Recorded','not-applied':'Request not applied',local:'Saved on this device'})[s]||s;
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('lytguide-work',1);r.onupgradeneeded=()=>{for(const n of ['cache','outbox'])r.result.createObjectStore(n,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function store(name,mode,fn){return new Promise((resolve,reject)=>{if(!db){reject(new Error('Device storage is unavailable. Nothing was saved.'));return;}const tx=db.transaction(name,mode);let result;try{result=fn(tx.objectStore(name));}catch(e){reject(e);return;}tx.oncomplete=()=>resolve(result?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Device storage write failed.'));});}
const all=name=>store(name,'readonly',s=>s.getAll());
async function cacheSnapshot(){await store('cache','readwrite',s=>s.put({id:key(),snapshot}));await store('cache','readwrite',s=>s.put({id:'active',key:key()}));}
async function refresh(){
 const query=new URLSearchParams(location.search);const watched=[root.querySelector?.('[data-task-dialog][open]')?.dataset.taskId,...[...root.querySelectorAll('[data-returned-row]')].map(r=>r.dataset.returnedRow),...[...root.querySelectorAll('[data-task-row]')].map(r=>r.dataset.taskRow)].filter(Boolean).slice(0,100);if(watched.length)query.set('watch',watched.join(','));query.set('view',path==='/work/overview'?'assign':path==='/work/history'?'history':path==='/work'?'mine':'accessible');if(/^\/tasks\/\d+$/.test(path))query.set('taskId',path.split('/')[2]);
 const r=await fetch('/api/work/snapshot?'+query,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(r.status===401?'Sign in to send your saved updates.':'Could not refresh warehouse work.');
 const fresh=await r.json();
 if(snapshot&&(fresh.user.id!==snapshot.user.id||fresh.site!==snapshot.site))throw new Error('The signed-in account or warehouse changed. Reopen My work; saved updates stay with their original account and warehouse.');
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
 const permission={closeTask:'stop',sendTaskReview:'stop',assign:'assign',create:body.includes('value="put"')?'put':'pick',acquire:'execute',verify:'execute',start:'execute',resume:'execute',decline:'execute',handBack:'execute',assignReview:'assign',observeReview:'execute',resumeFollowup:'execute',acknowledgeReturn:'assign',updateReturned:'assign',reassign:'assign',deadline:'deadline',timing:'timing',askReview:'report',report:'execute',manual:'report',recommendation:'report',cancel:'stop',correct:'correct',replan:'execute',mode:'mode',reconcile:'reconcile',resolve:body.includes('name="dismissDuplicate"')?'link':'resolve',stop:'stop'}[action];
 if(permission&&!allowed(permission)&&!(['stop','closeTask','sendTaskReview'].includes(action)&&allowed('teamStop')))return '';
 return `<form data-work-action="${action}" ${attrs}>${body}<p class="form-feedback" role="status"></p></form>`;
}
function hidden(n,v){return `<input type="hidden" name="${n}" value="${esc(v)}">`;}
function allocationFields(l){return hidden('lineId',l.id)+hidden('revision',l.revision)+hidden('cellId',l.cell_id)+hidden('unit',l.unit_of_measure)+hidden('productId',l.product_id)+hidden('direction',l.type)+hidden('assignmentGeneration',l.current_generation);}
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
function workActive(t){return !!t&&!!activeWork&&activeWork.taskId===t.id&&activeWork.generation===t.assignment_generation&&activeWork.identity===key()&&activeWork.dataset===snapshot.dataset&&!t.review_followup&&!t.completed_at&&!t.stop_requested&&t.assignee_id===snapshot.user.id;}
function lineActive(l){const t=snapshot.tasks.find(t=>t.id===l.task_id);return workActive(t);}
function executionLines(t){return (t.lines||[]).filter(l=>['ready','working'].includes(l.execution_state)&&l.planned_quantity>0&&!(l.reports||[]).some(r=>['review','received'].includes(r.status)));}
function activationFields(t){return hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('instructions',JSON.stringify(executionLines(t).map(l=>({lineId:l.id,revision:l.revision,bindingRevision:l.directions?.bindingRevision??l.binding_revision}))));}
function activationForm(t,label=null,attrs=''){
 const action=t.assignment_state==='offered'||t.assignment_state==='legacy'?'start':'resume';
 return form(action,activationFields(t)+`<button ${online?'':'disabled'}>${esc(label|| (action==='start'?'Start task':'Resume task'))}</button>`,attrs);
}
function isActivation(action,input={}){return ['start','resume'].includes(action)||action==='create'&&!input.assigneeId;}
function currentActivation(o){return o.input.dataset===snapshot.dataset&&o.input.site===snapshot.site&&Number(o.input.actorId)===snapshot.user.id;}
function currentSavedUpdate(o){return o.partition===key()&&(!['activation-pending','activation-unknown'].includes(o.state)||currentActivation(o));}
function activationPending(t=null){return outbox.find(o=>currentSavedUpdate(o)&&['activation-pending','activation-unknown'].includes(o.state)&&(!t||Number(o.input.taskId)===t.id));}
async function enterActiveTask(result){
 const t=await fetchDialogTask(Number(result.taskId));
 if(t.assignment_generation!==Number(result.generation)||t.assignee_id!==snapshot.user.id||t.canAct===false||t.assignment_state!=='started'||t.review_followup||t.completed_at||t.stop_requested)throw new Error('The task changed after this request. Open its details before continuing.');
 snapshot.tasks=[t,...snapshot.tasks.filter(x=>x.id!==t.id)];
 activeWork={taskId:t.id,generation:t.assignment_generation,identity:key(),dataset:snapshot.dataset};resumeLightWarning='';
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
  const result=await response.json();if(!response.ok){const error=new Error(result.error||'Task action was not confirmed.');error.definite=[400,401,403,404,409,422].includes(response.status);throw error;}
  o.result=result;o.state=result.status;o.message=result.message;
  await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');notice=result.message;
  await enterActiveTask(result);
 }catch(error){
  if(!o.result){o.state=error.definite?'not-applied':'activation-unknown';o.message=error.definite?error.message:'Start / Resume not confirmed. Retry this saved request explicitly; background sync will not start it.';await store('outbox','readwrite',s=>s.put(o));outbox=await all('outbox');}
  throw error;
 }
}
async function beginActivation(action,values){
 if(!online)throw new Error('Reconnect before starting or resuming work.');
 if(activationPending())throw new Error('Check the saved Start / Resume request before starting another task.');
 const t=snapshot.tasks.find(t=>t.id===Number(values.taskId))||snapshot.myWorkNextTask;
 if(action!=='create'&&t&&taskHasSavedUpdate(t))throw new Error('Send saved physical updates before starting or resuming this task.');
 const id=uid(),input={...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId};
 const o={id,partition:key(),action,input,state:'activation-pending',message:'Waiting for task confirmation.',createdAt:new Date().toISOString()};
 await deliverActivation(o);
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
function checkTaskSummary(t){
 const unit=esc(t.lines[0]?.unit_of_measure),fields=[['Task',`<a href="/tasks/${t.id}">#${t.id} · ${t.type==='put'?'Put':'Pick'}</a>`],['Product name',taskProductLink(t)],['Assigned to',esc(t.assignee_name||'Unassigned')],['Assigned by',esc(t.assigned_by_name||'Not recorded')],['Assigned time',checkTime(t.assigned_at)],['Deadline',t.due_at?checkTime(t.due_at)+(t.overdue?' · Overdue':''):'No deadline'],['Quantity',`${esc(t.requested_quantity)} ${unit}`],['Completed',`${esc(t.recorded_quantity)} ${unit}`],['Remaining',`${esc(t.remaining_quantity)} ${unit}`],['Progress',esc(t.review_handover_verified?'Check verified':outcome(t))]];
 if(t.return_event){const e=t.return_event;fields.push(['Returned by',esc(e.previous_name||'Unknown')],['Returned time',checkTime(e.created_at)]);if(e.reason||e.note)fields.push(['Return reason',esc(e.reason||'Not recorded')],['Return note',esc(e.note||'—')]);}
 const rows=[];for(let i=0;i<fields.length;i+=2)rows.push(`<tr>${fields.slice(i,i+2).map(([name,value])=>`<th scope="row">${name}</th><td>${value}</td>`).join('')}</tr>`);
 return `<table class="check-summary-table"><caption>Times: Asia/Kolkata · IST</caption><colgroup><col class="check-summary-label"><col class="check-summary-value"><col class="check-summary-label"><col class="check-summary-value"></colgroup><tbody>${rows.join('')}</tbody></table>`;
}
function recordedMovements(t){
 if(t.recorded_movements)return t.recorded_movements;const rows=new Map();for(const l of t.lines||[]){if(l.execution_state==='superseded')continue;const r=rows.get(l.cell_id)||{cellId:l.cell_id,logical_code:l.logical_code,quantity:0};if(l.execution_state==='settled')r.quantity+=l.actual_quantity||0;rows.set(l.cell_id,r);}return [...rows.values()];
}
function actualRow(t,row,index){return `<tr class="task-actual-row" data-actual-row><td><select data-searchable name="actualCell${index}" aria-label="Actual location ${index+1}" required><option value="">Choose location</option>${options(snapshot.cells||[],'id',c=>c.description?.name||c.logical_code,row.cellId)}</select></td><td><input name="actualQuantity${index}" aria-label="Actual quantity ${index+1} (${esc(t.lines[0]?.unit_of_measure)})" type="number" min="0" max="1000000000" step="0.000001" inputmode="decimal" required value="${esc(row.quantity??'')}"></td><td class="actual-unit">${esc(t.lines[0]?.unit_of_measure)}</td><td><button type="button" class="secondary" data-remove-actual aria-label="Remove actual location ${index+1}">Remove</button></td></tr>`;}
function actualEditor(t,rows=recordedMovements(t)){return `<div data-actual-editor data-unit="${esc(t.lines[0]?.unit_of_measure)}"><p class="work-help">Enter final quantities for this task. Removing a location sets its quantity to 0.</p><table class="task-actual-table" aria-label="Final actual movements"><colgroup><col class="actual-location-col"><col class="actual-quantity-col"><col class="actual-unit-col"><col class="actual-remove-col"></colgroup><thead><tr><th scope="col">Actual location</th><th scope="col">Actual quantity</th><th scope="col">Unit</th><th scope="col">Remove</th></tr></thead><tbody data-actual-rows>${rows.map((r,i)=>actualRow(t,r,i)).join('')}</tbody></table><button type="button" class="secondary" data-add-actual>Add actual location</button></div>`;}
function closureForm(t){
 if(t.closure_review_id)return `<p class="work-callout">Task closure is awaiting review. Actual entries remain saved; stock is not confirmed.</p>${allowed('review')?`<a href="/pending-confirmations?reportId=${esc(t.closure_review_id)}">Open closure review</a>`:''}`;
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
 globalThis.WarehouseCombobox?.init(f);dirty=true;return f;
}
function closureReview(r){const t=r.closureTask;return disclosure('case-'+r.id,`Task #${t.id} closure · ${esc(r.product_name)} — verify final actual totals`,checkTaskSummary(t)+`<p>${esc(r.reason)}</p><p>These totals replace this task’s recorded movements. Original entries remain in task history.</p>`+form('resolve',hidden('reportId',r.id)+hidden('caseRevision',r.case_revision)+hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+hidden('closureToken',t.closure_token)+hidden('currentStatus','no')+actualEditor(t,r.closureActuals)+(r.closureCounts?.length?disclosure('closure-count-links-'+r.id,'Link differences already included in a stocktake',r.closureCounts.filter(c=>JSON.parse(c.lines_json).some(i=>i.productId===t.lines[0]?.product_id)).map(c=>`<label>${esc(c.logical_code)} · ${esc(c.title)}<input type="radio" name="countLink${c.cell_id}" value="${esc(c.id)}">This count already accounts for the final-total difference at this location</label>`).join('')):'')+'<label class="work-check"><input type="checkbox" name="workerStopped">I confirmed all workers have stopped and verified the actual totals.</label>'+disclosure('closure-count-'+r.id,'Stocktake overlap','<p>If a count already includes this correction, keep this pending until the original accounting is reconciled.</p><label class="work-check"><input type="checkbox" name="afterCountVerified">I verified these differences are separate from every overlapping stocktake correction.</label>')+'<button>Close task with verified totals</button>','data-closure-review data-draft-kind="closure-review"')+form('resolve',hidden('reportId',r.id)+hidden('caseRevision',r.case_revision)+hidden('keepOpen','true')+input('verification','Optional note')+'<button class="secondary">Keep pending</button>'),true,'work-panel review-case');}
function checkStopContent(t){
 return canStopTask(t)?`<section id="check-stop-${t.id}" data-check-stop-panel class="check-stop-panel" tabindex="-1" hidden><h3>Stop remaining work</h3>${closureForm(t)}</section>`:'';
}
function checkDialogContent(t){
 if(!canCheckTask(t))return '';
 if(t.closure_review_id)return `<section class="check-workspace"><header class="review-task-header"><h2 tabindex="-1" autofocus>Review task</h2></header>${checkTaskSummary(t)}${closureForm(t)}<h3>Submitted final totals</h3>${(t.closure_actuals||[]).map(r=>`<p>${esc(snapshot.cells?.find(c=>c.id===r.cellId)?.logical_code||r.cellId)} · ${esc(r.quantity)} ${esc(t.lines[0]?.unit_of_measure)}</p>`).join('')}</section>`;
 const pending=t.lines.filter(l=>(l.reports||[]).some(r=>['review','received'].includes(r.status))),stop=canStopTask(t)?`<button type="button" class="secondary" data-check-stop aria-expanded="false" aria-controls="check-stop-${t.id}">Stop remaining work</button>`:'';
 return `<section class="check-workspace"><header class="review-task-header"><h2 tabindex="-1" autofocus>Review task</h2>${allowed('assign')?taskAssigneeEditor(t,true):''}</header>${checkTaskSummary(t)}<h3 class="review-entry-heading">Align task with actual movement</h3>${pending.map(l=>form('observeReview',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('lineId',l.id)+hidden('progressToken',t.progress_token)+`<h4>${esc(l.logical_code)}</h4>`+input('quantity','Observed moved quantity (leave blank if unknown)','number','min="0" max="1000000000" step="0.000001"')+input('note','What did you check? Who moved it?','text','required maxlength="2000"')+`<div class="check-observation-actions"><button>Save observation for verifier</button>${stop}</div>`)).join('')}${!pending.length?stop:''}${checkStopContent(t)}${observationList(t.review_observations)}${t.review_followup&&t.review_handover_verified&&!pending.length&&t.remaining_quantity>0&&!t.stop_requested?form('resumeFollowup',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+'<button>Plan verified remaining work</button>'):''}</section>`;
}
function canCheckTask(t){return !!t&&t.assignee_id===snapshot.user.id&&allowed('execute')&&!t.completed_at&&(t.review_followup||t.attention||(t.lines||[]).some(l=>(l.reports||[]).some(r=>['review','received'].includes(r.status))));}
function checkButton(t){return canCheckTask(t)?`<button type="button" data-task-check="${t.id}" ${online&&!taskHasSavedUpdate(t)?'':'disabled'}>Start check</button>`:'';}
function taskProductLink(t){const id=t.lines?.[0]?.product_id;return allowed('productsView')&&id?`<a href="/products/${id}">${esc(taskName(t))}</a>`:esc(taskName(t));}
function followupPanel(t){return t.review_followup?`<p class="work-callout">Quantity check only. Do not repeat the movement.${t.assignee_id===snapshot.user.id?' Open Start check to save your observations.':''}</p>`:'';}
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
 return form(action,fields+`<div class="task-assignee-editor ${compact?'check-assignee-editor':''}"><div>${compact?'<label>New operator':'<p>Assigned to <strong>'+esc(t.assignee_name||'Unassigned')+'</strong></p>'}<select data-searchable name="assigneeId" aria-label="${compact?'New operator':'Assigned to'}" required><option value="">Choose person</option>${options(people,'id',u=>u.name+' · '+u.username,compact?'':t.assignee_id)}</select>${compact?'</label>':''}</div><button class="secondary ${compact?'check-save-assignee':''}" ${compact?'aria-label="Save new operator" title="Save new operator"':''} disabled>${compact?'<span aria-hidden="true">✓</span>':'Save'}</button></div>${!compact&&action==='assignReview'?'<p class="work-help">Assigns the quantity check, not physical work.</p>':''}`,'data-task-assignee data-draft-kind="'+(compact?'check-assignee':'task-assignee')+'"');
}
function taskPeople(t){
 return t.lines.map(l=>{const a=l.attribution,settled=l.execution_state==='settled'&&(a?.performer||a?.reporter),records=settled?[{performer_name:a.performer,reporter_name:a.reporter,quantity:l.actual_quantity,unit:l.unit_of_measure,quantity_known:1}]:(l.reports||[]);return records.map(r=>`<p class="work-help">${esc(l.logical_code)} · Performed by ${esc(r.performer_name||'Unknown / unverified')} · Entered by ${esc(r.reporter_name||'Unknown')}${r.quantity_known===0?' · Quantity unknown':r.quantity!=null?' · '+(settled?'Recorded ':'Entered ')+esc(r.quantity)+' '+esc(r.unit||l.unit_of_measure):''}</p>${r.reason||r.entered_reason?`<p class="work-help">${esc([...new Set([r.entered_reason,r.reason].filter(Boolean))].join(' · '))} · ${taskDate(r.created_at)}</p>`:''}`).join('');}).join('');
}
function taskContext(t){
 const e=t.return_event;
 return `<section class="task-context">${taskAssigneeEditor(t)}<p class="work-help">Assigned by ${esc(t.assigned_by_name||'Not recorded')} · ${taskDate(t.assigned_at)}</p>${e?`<p><strong>Returned by ${esc(e.previous_name||'Unknown')}</strong> · ${taskDate(e.created_at)}</p><p>${esc([e.reason,e.note].filter(Boolean).join(' · ')||'No reason recorded')}</p>`:''}${t.assignment_state==='returned'&&!t.assignee_id?'<p>Assign the remaining work before starting.</p>':''}${t.review_followup||t.attention?'<p class="work-callout warning">Check moved quantity first. Remaining quantity is provisional until verified.</p>':''}${taskPeople(t)}</section>`;
}
function taskHistoryContent(t){
 const history=(t.assignment_history||[]).map(e=>{const v=JSON.parse(e.payload);return `<li>${taskDate(e.created_at)} · ${esc(e.event_type.replaceAll('_',' '))} · ${esc(e.actor_name)}${e.assignee_name?' → '+esc(e.assignee_name):''}<p>${esc([v.reason,v.note,v.dueAt?'Due '+new Date(v.dueAt).toLocaleString():'',v.remaining!=null?'Remaining '+v.remaining:''].filter(Boolean).join(' · '))}</p></li>`;}).join('');
 return `<h2>Task details and history</h2><p>Task #${t.id} · ${esc(taskName(t))}</p><p>Created by ${esc(t.created_by_name||'Unknown')} · Due ${taskDate(t.due_at)}</p><p>Requested ${esc(t.requested_quantity)} · Completed ${esc(t.recorded_quantity)} · Remaining ${esc(t.remaining_quantity)} ${esc(t.lines[0]?.unit_of_measure)}</p>${taskPeople(t)}<ol>${history||'<li>No assignment history recorded.</li>'}</ol>`;
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
 return `<h2>Update task #${t.id}</h2><p>${esc(t.type==='put'?'Put':'Pick')} ${esc(taskName(t))}</p>${history}${blocked?`<p class="work-callout warning">Check moved quantity first</p><p>Assign responsibility for this check. Remaining quantity stays provisional until verified.</p>${form('assignReview',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('progressToken',t.progress_token)+`<p>Completed: ${esc(t.recorded_quantity)} · Remaining requested: ${esc(t.remaining_quantity)} ${esc(t.lines?.[0]?.unit_of_measure)}</p>`+operatorPicker(t)+input('reason','Assignment note (optional)','text','maxlength="2000"')+'<button>Assign quantity check</button>')}${allowed('review')?`<a href="${esc(reviewHref(t))}">Check moved quantity first</a>`:`<a href="/tasks/${t.id}">Open task for quantity review</a>`}`:form('updateReturned',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+hidden('returnEventId',t.return_event?.id)+hidden('progressToken',t.progress_token)+input('remainingQuantity','Remaining quantity ('+(t.lines?.[0]?.unit_of_measure||'')+')','number',`min="0.000001" max="1000000000" step="0.000001" required value="${esc(t.remaining_quantity)}"`)+operatorPicker(t)+`<p>Due: ${esc(due?due.toLocaleString():'No deadline')}</p>`+(allowed('deadline')?'<label class="work-check"><input type="checkbox" name="changeDue">Change due time</label>'+'<div data-due-edit hidden>'+input('dueAt','New due time','datetime-local',`disabled value="${localDue}"`)+'</div>':'')+input('reason','Assignment note (optional)','text','maxlength="2000"')+'<button>Save task</button>')}`;
}
function updateReturnedDue(f){if(!f?.elements.changeDue)return;f.elements.dueAt.disabled=!f.elements.changeDue.checked;const editor=f.querySelector('[data-due-edit]');if(editor)editor.hidden=!f.elements.changeDue.checked;}
async function fetchDialogTask(id){
 const r=await fetch('/api/work/snapshot?taskId='+id,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error('Unable to open this task. Refresh your permissions and try again.');
 const fresh=await r.json();
 if(fresh.user.id!==snapshot.user.id||fresh.site!==snapshot.site||fresh.dataset!==snapshot.dataset)throw new Error('The signed-in account, warehouse or dataset changed. Reopen My work before updating this task.');
 const t=fresh.tasks.find(t=>t.id===id);if(!t)throw new Error('This task is no longer available. Refresh My work.');
 snapshot={...snapshot,capabilities:fresh.capabilities||snapshot.capabilities,cells:fresh.cells||snapshot.cells,tasks:[t,...snapshot.tasks.filter(x=>x.id!==id)]};
 return t;
}
function openTaskDialog(t,mode,lineId=null){
 const d=root.querySelector('[data-task-dialog]');if(!d)return;
 const l=t.lines.find(l=>l.id===Number(lineId));
 if(mode==='check'&&!canCheckTask(t)||mode==='stop'&&!canStopTask(t)||mode==='recovery'&&(!l||l.canAct===false))return;
 d._opener=document.activeElement;d._identity={site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id};
 d.dataset.taskId=t.id;d.dataset.generation=t.assignment_generation;d.dataset.progressToken=t.progress_token;d.dataset.mode=mode;d.classList?.toggle('check-dialog',['check','stop'].includes(mode));d.dataset.closureToken=t.closure_token||'';d.dataset.lineId=l?.id||'';d.dataset.revision=l?.revision||'';
 const content=mode==='details'?taskHistoryContent(t):mode==='stop'?stopDialogContent(t):mode==='check'?checkDialogContent(t):mode==='recovery'?recoveryDialogContent(l):mode==='update'?returnedDialogContent(t):returnDialogContent(t);
 d.innerHTML=content+'<p data-task-dialog-warning class="work-callout warning" role="status" hidden></p><button type="button" class="secondary" data-task-dialog-close>'+ (mode==='stop'?'Back':'Close')+'</button>';
 d.setAttribute?.('aria-label',mode==='recovery'?'Record what I moved':mode==='check'?'Review task':mode==='details'?'Task details and history':mode==='stop'?'Stop remaining work':'Task action');
 for(const f of d.querySelectorAll('form')){f._workIdentity={...d._identity};f._draftPath=path;}
 restoreDrafts();const f=d.querySelector('form');updateReturnedDue(f);
 d.onclose=()=>{d._opener?.focus?.();};d.showModal();if(['check','stop'].includes(mode))d.querySelector('.review-task-header h2')?.focus?.();patchTaskDialog();
}
function patchTaskDialog(){
 const d=root.querySelector('[data-task-dialog]');if(!d?.open)return;
 const t=availableTask(d.dataset.taskId);
 const identityChanged=d._identity&&(d._identity.site!==snapshot.site||d._identity.dataset!==snapshot.dataset||d._identity.actorId!==snapshot.user.id);
 const changed=!t||String(t.assignment_generation)!==d.dataset.generation||t.progress_token!==d.dataset.progressToken||(d.dataset.mode==='stop'||d.querySelector('[data-task-closure]'))&&t.closure_token!==d.dataset.closureToken;
 const recovery=d.dataset.mode==='recovery';
 const stale=identityChanged||(!recovery&&(!online||changed||t&&taskHasSavedUpdate(t)))||(d.dataset.mode==='update'&&t&&(!allowed('assign')||t.assignment_state!=='returned'&&!returnBlocked(t)))||(d.dataset.mode==='check'&&t&&!canCheckTask(t))||(d.dataset.mode==='stop'&&t&&!canStopTask(t));
 const warning=d.querySelector('[data-task-dialog-warning]');warning.hidden=!(stale||recovery&&changed);warning.textContent=recovery&&!identityChanged?'These instructions changed. Your original draft stays attached to them; report only work already done.':'This task or account changed. Your draft is kept; close and check the latest task before saving.';
 for(const button of d.querySelectorAll('form button:not([type="button"])')){const f=button.closest?.('[data-task-assignee]');button.disabled=!!(stale||f&&assigneeFormStale(f,t)||button.hasAttribute?.('data-close-task')&&t?.assignee_id!==snapshot.user.id&&!(allowed('resolve')&&allowed('resolveStop')));}
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
   else if(!stage)actions=`<p class="work-callout" data-guidance-line="${l.id}" role="status">${guidanceMarkup(l)}</p><button type="button" class="secondary" data-refresh-guidance>Refresh light</button><button type="button" data-scan-line="${l.id}">Resume camera</button><button type="button" class="secondary" data-manual-summary="${l.id}">Complete without scanning</button>`;
   else actions=`<section class="cell-summary" aria-label="Cell summary"><h3>${esc(l.product_name)} · ${esc(l.logical_code)}</h3><p>${stage.method==='camera'?'QR checked':'Manual completion — no QR verification'}</p>${form('report',allocationFields(l)+hidden('method',stage.method)+hidden('location',stage.location||'')+`<label>Quantity ${l.type==='pick'?'picked':'put'} (${esc(l.unit_of_measure)})<input name="quantity" type="number" min="0" max="1000000000" step="0.000001" inputmode="decimal" required value="${esc(l.planned_quantity)}"></label><p class="work-help">Change quantity above if needed. Use 0 only when nothing moved.</p>`+(stage.method==='manual'?'<label>Reason<select name="manualReason" required><option value="No camera / camera unavailable">No camera / camera unavailable</option><option value="Label unreadable">Label unreadable</option><option value="Checked printed cell name">Checked printed cell name</option></select></label>':'')+`<p>Press Finish only after moving the items. This records only this cell and stops its unperformed remainder.</p><button>Finish ${esc(l.type)} at this cell</button>`)}<button type="button" class="secondary" data-scan-line="${l.id}">Scan again</button></section>`;
   actions+=disclosure('difference-'+l.id,'Record a difference',recovery+form('askReview',allocationFields(l)+input('reason','What is uncertain?')+'<button class="secondary">Ask supervisor to resolve</button>'));
   actions+=disclosure('cancel-'+l.id,'Cancel this location',form('cancel',allocationFields(l)+hidden('zeroConfirmed','true')+'<p>This declares zero movement. If anything moved, record that actual using Finish first. A partial actual closes this cell’s remaining plan.</p><label class="work-check"><input type="checkbox" required>Nothing moved at this location.</label><button class="secondary">Nothing moved — cancel</button>'));
   if(!working&&l.type==='put')actions+=disclosure('replan-'+l.id,'Use a different planned location',form('replan',hidden('lineId',l.id)+hidden('revision',l.revision)+`<label>Replacement location<select name="cellId">${options(snapshot.cells,'id',c=>c.logical_code,l.cell_id)}</select></label>`+qty('Replacement planned quantity')+'<label class="work-check"><input type="checkbox" required>Nothing moved under the original instructions.</label><button class="secondary">Save replacement plan</button>'));
  }
 } else if(l.execution_state==='settled'&&l.canAct!==false)actions=disclosure('correct-'+l.id,'Correct earlier quantity',form('correct',allocationFields(l)+qty('Correct actual quantity')+input('verification','Correction reason','text','required')+'<button>Save correction</button>'));
 const others=(snapshot.contents||[]).filter(c=>c.cell_id===l.cell_id&&c.product_id!==l.product_id);
 return `<article class="allocation" data-line="${l.id}" data-light-revision="${l.revision}" data-light-generation="${l.current_generation}" data-light-binding="${l.directions?.bindingRevision??l.binding_revision}"><div class="work-card-heading"><span class="work-eyebrow">${esc(l.type)}</span>${badge(l.guidance?.state==='waiting'?'Waiting for location':l.guidance?.state==='blocked'?'Needs attention':status(l.execution_state),l.execution_state==='settled'?'good':'')}</div><h2 class="directions">${esc(locationHeading(l))}</h2>${locationDetails(l)?`<p class="cell-code">${esc(locationDetails(l))}</p>`:''}<p class="work-product">${esc(l.product_name)} <span>${esc(l.sku)}</span></p><div class="work-quantity"><strong>${esc(l.execution_state==='settled'?l.actual_quantity:l.planned_quantity)}</strong><span>${esc(l.unit_of_measure)}<small>${l.execution_state==='settled'?'actual recorded':active?(l.review_followup?'originally planned':'planned at this cell'):'closed plan — do not execute'}</small></span></div>${l.attribution?`<p class="work-help">Performed by ${esc(l.attribution.performer||'Unknown')} · Entered by ${esc(l.attribution.reporter)}${l.attribution.reviewer?' · Verified by '+esc(l.attribution.reviewer):''}</p>`:''}${waiting.map(r=>`<p class="work-callout warning">Needs review: ${esc(reviewInstruction(r))}</p>`).join('')}${saved?'<p class="work-callout">Saved on this phone. Do not repeat the movement.</p>':''}${l.review_followup?'<p class="work-callout">Observation only. Save what you checked above; do not repeat the movement.</p>':l.canAct===false?'<p class="work-callout">View only. Start the assignment if it belongs to you; another operator’s work cannot be executed here.</p>':''}${actions}${others.length?disclosure('contents-'+l.id,'Other items here',others.map(c=>`<p>${esc(c.name)} · ${esc(c.available_quantity)} ${esc(c.unit_of_measure)}</p>`).join('')):''}</article>`;
}
function untouchedOffer(t){return t.assignment_source!=='self'&&t.assignment_state==='offered'&&!t.attention&&!(t.recorded_quantity>0)&&(t.lines||[]).every(l=>['ready','cancelled','superseded'].includes(l.execution_state)&&!l.started_at&&!l.reports?.length);}
function assignmentActions(t){
 if(canCheckTask(t))return checkButton(t);
 if(!allowed('execute')||t.assignee_id!==snapshot.user.id||t.completed_at||t.assignment_state==='returned')return '';
 const canEnter=!workActive(t)&&!t.review_followup&&!t.stop_requested&&executionLines(t).length&&!taskHasSavedUpdate(t);
 return canEnter?activationForm(t):'';
}
function workReturn(){const value=new URLSearchParams(location.search).get("return_to")||"";return /^\/(products|cells)([/?#]|$)/.test(value)?value:"";}
function taskPage(id){
 const t=snapshot.tasks.find(t=>t.id===Number(id));if(!t)return '<section class="work-empty">Reconnect to open your task.</section>';
 const live=t.lines.filter(l=>!['superseded'].includes(l.execution_state));
 const ready=live.filter(l=>['ready','working'].includes(l.execution_state));
 const selected=Number(new URLSearchParams(location.search).get('line'));
 const primary=ready.find(l=>l.id===selected)||ready.find(l=>l.execution_state==='working')||ready.find(l=>!['waiting','blocked'].includes(l.guidance?.state))||ready[0];
 const closed=!t.attention&&(['completed','stopped','cancelled'].includes(t.outcome)||Boolean(t.completed_at));
 return `<section class="task-work-screen"><section class="work-intro"><a href="${esc(workReturn()||'/work')}">← ${workReturn()?'Back to stock':'My work'}</a><p class="task-product-summary">${workActive(t)?'Active work':'Task details'} · ${esc(taskName(t))}</p><p><strong>${esc(t.review_followup?'Quantity check':outcome(t))}</strong>${closed?'':' · '+esc(dueText(t))}</p>${closed?'<p><a class="work-primary" href="/work">Back to My work</a></p>':''}<p>Requested ${esc(t.requested_quantity)} · Completed ${esc(t.recorded_quantity)} · Remaining ${esc(t.remaining_quantity)} ${esc(t.lines[0]?.unit_of_measure)}</p>${t.instruction_note?`<p>${esc(t.instruction_note)}</p>`:''}</section><div class="task-primary-action">${assignmentActions(t)}</div>${taskContext(t)}${followupPanel(t)}${!t.review_followup&&primary?lineCard(primary):''}${!t.review_followup&&ready.length>1?disclosure('other-locations','Other locations',ready.filter(l=>l!==primary).map(l=>`<a class="work-secondary" ${workActive(t)?'data-active-location="'+l.id+'"':''} href="/tasks/${t.id}?line=${l.id}">${esc(l.directions?.name||l.logical_code)} · ${esc(l.planned_quantity)} ${esc(l.unit_of_measure)}</a>`).join(''),true):''}${live.some(l=>!['ready','working'].includes(l.execution_state))?disclosure('recorded-locations','Recorded / closed locations',live.filter(l=>!['ready','working'].includes(l.execution_state)).map(lineCard).join(''),false):''}<footer class="task-bottom-actions">${canStopTask(t)?`<button type="button" class="secondary" data-task-stop="${t.id}">Stop remaining work</button>`:''}<button type="button" class="secondary" data-task-details="${t.id}">Task details and history</button></footer></section>`;
}

function pageLinks(info,key='page') {
 if(!info)return '';const q=new URLSearchParams(location.search),url=n=>{const v=new URLSearchParams(q);v.set(key,n);return path+'?'+v;};
 return `<nav class="work-pagination" aria-label="${key==='returnedPage'?'Returned work':key==='page'?'Task':'Review'} pages"><span>${info.total} matching · Page ${info.number} of ${info.pages} · Up to 100 rows</span>${info.number>1?`<a href="${esc(url(info.number-1))}">Previous page</a>`:''}${info.number<info.pages?`<a href="${esc(url(info.number+1))}">Next page / older records</a>`:''}</nav>`;
}
function operatorPicker(t){const eligible=(snapshot.operators||[]).filter(u=>u.eligible&&u.status!=='inactive');return `<label>Assign to<select data-searchable name="assigneeId" required><option value="">Choose operator</option>${options(eligible,'id',u=>`${u.name} · ${u.username}${u.open!=null?' · '+u.open+' open':''}`)}</select></label>`;}
function reassignForm(t){return t.closed_actuals||t.closure_review_id||!allowed('assign')||t.attention||(t.completed_at&&t.outcome!=='stopped')||['completed','cancelled'].includes(t.outcome)?'':form('reassign',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+operatorPicker(t)+input('reason','Assignment note (optional)')+'<button>Save</button>');}
function taskRow(t){
 const mine=t.assignee_id===snapshot.user.id,closed=['completed','stopped','cancelled'].includes(t.outcome)||t.completed_at;
 const untouched=(t.lines||[]).every(l=>['ready','cancelled','superseded'].includes(l.execution_state)&&!l.started_at&&!l.reports?.length);
 const saved=outbox.some(o=>currentSavedUpdate(o)&&['local','sending','error','rejected','activation-pending','activation-unknown'].includes(o.state)&&(Number(o.input.taskId)===t.id||(t.lines||[]).some(l=>l.id===Number(o.input.lineId))));
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
function myTasks(){return snapshot.tasks.filter(t=>t.assignee_id===snapshot.user.id&&!t.completed_at&&!['completed','stopped','cancelled'].includes(t.outcome)&&t.assignment_state!=='returned').sort((a,b)=>(Date.parse(b.assigned_at||b.started_at)||0)-(Date.parse(a.assigned_at||a.started_at)||0)||b.id-a.id);}
function taskHasSavedUpdate(t){return outbox.some(o=>currentSavedUpdate(o)&&['local','sending','error','rejected','activation-pending','activation-unknown'].includes(o.state)&&(Number(o.input.taskId)===t.id||(t.lines||[]).some(l=>l.id===Number(o.input.lineId))));}
function myTaskChoice(t){
 if(t.assignee_id!==snapshot.user.id||t.completed_at||['completed','stopped','cancelled'].includes(t.outcome)||taskHasSavedUpdate(t))return null;
 if(untouchedOffer(t)&&allowed('execute'))return {action:'decline',label:'Decline',explanation:'Return this unstarted assignment for reassignment. Its deadline stays unchanged.'};
 const untouched=!t.attention&&!(t.recorded_quantity>0)&&(t.lines||[]).every(l=>['ready','cancelled','superseded'].includes(l.execution_state)&&!l.started_at&&!l.reports?.length);
 if(allowed('stop')&&!untouchedOffer(t))return t.assignment_source==='self'&&untouched?{action:'stop',label:'Cancel task',explanation:'Cancel your untouched task. Confirm that nothing moved.'}:{action:'stop',label:'Stop remaining work',explanation:'Record any actual movement first. Recorded quantities remain; uncertain physical work stays in review.'};
 return null;
}
function myTaskActionable(t){return !!t&&online&&allowed('execute')&&t.canAct!==false&&t.assignee_id===snapshot.user.id&&!t.completed_at&&!['completed','stopped','cancelled'].includes(t.outcome)&&['offered','started','legacy'].includes(t.assignment_state)&&!t.attention&&!t.review_followup&&!taskHasSavedUpdate(t)&&!(t.lines||[]).some(l=>(l.reports||[]).some(r=>['review','received'].includes(r.status)));}
function myTaskRow(t){
 const saved=taskHasSavedUpdate(t),mine=t.assignee_id===snapshot.user.id,closed=!!t.completed_at||['completed','stopped','cancelled'].includes(t.outcome),review=t.attention||(t.lines||[]).some(l=>(l.reports||[]).some(r=>['review','received'].includes(r.status)));
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation),canStart=myTaskActionable(t),offered=t.assignment_state==='offered';
 const underway=(t.recorded_quantity>0)||(t.lines||[]).some(l=>l.execution_state==='working'||l.started_at);
 const action=canStart?activationForm(t,offered?'Start task':'Resume task','class="my-work-start"'):checkButton(t);
  const date=value=>value?esc(new Date(value).toLocaleString([], {timeZone:snapshot.timing?.timezone,dateStyle:'short',timeStyle:'short'})):'Not recorded';
 return `<tr data-task-row="${t.id}" data-generation="${t.assignment_generation}"><td><a href="/tasks/${t.id}">#${t.id} · ${t.type==='put'?'Put':'Pick'}</a></td><td>${taskProductLink(t)}</td><td>${esc(t.requested_quantity??'—')} ${esc(t.lines?.[0]?.unit_of_measure)}</td><td>${esc(t.recorded_quantity??'—')} / ${esc(t.requested_quantity??'—')} recorded${saved?' · Update pending':review?' · Needs review':closed?' · '+esc(outcome(t)):''}</td><td title="${esc(t.assigned_by_username||'')}">${esc(t.assigned_by_name||'Not recorded')}</td><td>${esc(t.assignee_name||'Unassigned')}</td><td>${date(t.assigned_at)}</td><td data-my-actions-cell><div class="my-work-actions">${action}</div></td><td${t.overdue?' class="my-work-overdue"':''}>${t.clock_invalid?'Check warehouse clock':t.due_at?date(t.due_at)+(t.overdue?' · Overdue':''):'No deadline'}</td></tr>`;
}
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
 return `<section class="work-intro my-work-next-area"><h2>What’s your next move?</h2><div data-my-next-content>${myNextContent()}</div><p data-my-next-warning class="work-callout warning" role="status" hidden></p></section><section class="my-work-list" aria-label="My tasks">${!online&&snapshot.taskPage?.view!=='mine'?'<p class="work-callout warning">This saved view may not include all your tasks. Reconnect to load current assignments.</p>':''}<div class="table-wrap my-work-table-wrap" tabindex="0" role="region" aria-label="My tasks; scroll horizontally for all columns"><table class="my-work-table"><thead><tr>${['Task','Product name','Quantity','Progress','Assigned by','Assigned to','Assigned time','Action','Deadline'].map(c=>`<th scope="col">${c}</th>`).join('')}</tr></thead><tbody data-my-work-table>${tasks.map(myTaskRow).join('')||'<tr><td colspan="9" class="empty-cell">No current tasks.</td></tr>'}</tbody></table></div><div data-my-work-pagination>${snapshot.taskPage?.view==='mine'&&snapshot.taskPage?.pages>1?pageLinks(snapshot.taskPage):''}</div></section>${returnedTable()}${allowed('pick')||allowed('put')?`<footer class="my-work-footer" aria-label="Create stock work"><div class="work-actions">${allowed('pick')?'<a class="work-primary" href="/pick">Pick stock</a>':''}${allowed('put')?'<a class="work-secondary" href="/put">Put stock</a>':''}</div></footer>`:''}`;
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
 return `[Recorded ${q(s.recorded)} · Pick reserved ${q(s.pickReserved)} · Available ${q(s.availableToPick)} · Incoming ${q(s.incomingReserved)}${direction==='put'?' · Put space '+q(s.putCapacity):''} ${unit}]`;
}
function stockDetailsHtml(s){
 const reservations=s.reservations.length?'<ul>'+s.reservations.map(r=>`<li><a href="/tasks/${Number(r.taskId)}">Task #${Number(r.taskId)}</a> · ${r.kind==='pick'?'Pick reserved':'Incoming put'} ${esc(r.quantity)} ${esc(r.unit)} · ${esc(r.location)}${s.detailScope==='team'?' · '+esc(r.assignee||'Unassigned'):''}${r.attention?' · Needs check':''}</li>`).join('')+'</ul>':'<p>No reservations visible in your scope.</p>';
 return `<details data-disclosure="product-stock-details"><summary>${esc(s.reservationCount)} location reservations · details</summary>${reservations}${s.moreReservations?'<p>First 100 reservations shown. See task history for more.</p>':''}${s.detailScope==='own'?'<p>Only your tasks shown. Totals include all reservations.</p>':''}${s.unavailableUnreserved?`<p>${esc(s.unavailableUnreserved)} ${esc(s.unit)} unreserved but unavailable: inactive locations or checks outstanding.</p>`:''}<details class="stock-definitions"><summary>What do these figures mean?</summary><p>All figures in ${esc(s.unit)}. Recorded stock includes pick reservations. Available means unreserved stock in usable locations without outstanding checks; a busy location may still require a turn. Incoming Put is not yet on hand. Put space is compatible free capacity after incoming reservations. The warehouse checks again when you submit.</p><p>Open a task to inspect, stop untouched work or reassign it where permitted. Started work needs quantity review before changes.</p></details></details>`;
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
 return `<section class="work-intro"><span class="work-eyebrow">New ${direction}</span><h2>${direction==='pick'?'What are you picking?':'What are you putting away?'}</h2><p>Choose a product and quantity. We’ll find the locations for you.</p><ol class="work-steps" aria-label="Work steps"><li aria-current="step">1 · Plan</li><li>2 · Go to location</li><li>3 · Confirm actual</li></ol></section><section class="work-panel narrow">${form('create',hidden('direction',direction)+hidden('returnTo',workReturn())+productPicker(params.get('product_id'))+input('quantity','Quantity to '+direction,'number',`min="0.000001" step="0.000001" inputmode="decimal" required value="${esc(params.get('quantity')||'')}"`)+disclosure('preferred-location','Choose a preferred location (optional)',`<label>Preferred location<select name="preferredCellId"><option value="">Choose automatically</option>${options(snapshot.cells,'id',c=>c.logical_code,params.get('cell_id'))}</select></label>`,Boolean(params.get('cell_id')))+`<p class="work-plan-help">This reserves stock for your task. You’ll confirm the actual at each location.</p><button ${pending?'disabled':''}>${pending?'Waiting for warehouse confirmation':'Find '+direction+' locations'}</button>`)}${disclosure('already-moved','Already moved the stock?',`<a data-recovery-link href="${esc(recoveryHref(direction))}">Record a completed movement for verification</a>`)}</section>`;
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
function manualPage(direction=null){
 const params=new URLSearchParams(location.search),movement=direction||params.get('direction')||'pick';
 return `<section class="work-intro">${workReturn()?`<a href="${esc(workReturn())}">← Back to stock</a>`:''}<h2>${direction?'Offline '+esc(direction)+' · record physical work':'Record work already done'}</h2><p>Enter what physically moved. A supervisor will check it; this does not start new work.</p>${!online?'<p>Saved on this device until the warehouse receives it. Follow the warehouse manual procedure; do not repeat a movement because its update is waiting.</p>':''}</section><section class="work-panel narrow">${form('manual',`<label>Movement<select name="direction"><option value="pick" ${movement==='pick'?'selected':''}>Picked / removed</option><option value="put" ${movement==='put'?'selected':''}>Put / returned</option><option value="count" ${movement==='count'?'selected':''}>Count observation</option></select></label>`+productPicker(params.get('product_id'))+`<label>Location<select name="cellId" required><option value="">Choose a location</option>${options(snapshot.cells,'id',c=>c.description?.name&&c.description.name!==c.logical_code?c.description.name+' · '+c.logical_code:c.logical_code,params.get('cell_id'))}</select></label>`+input('quantity','Actual quantity','number',`min="0" max="1000000000" step="0.000001" inputmode="decimal" required value="${esc(params.get('quantity')||'')}"`)+input('reason','What happened?','text','required')+performerField()+disclosure('movement-history-details','Earlier work or paper records (optional)',`<p>This entry has a saved reference. If the same movement is also on paper or another device, use its original reference here so it can be matched.</p>`+input('origin','Original reference','text',`required maxlength="180" value="${esc(provisionalReference())}"`)+input('unit','Original unit (blank uses selected product unit)','text','placeholder="For earlier work recorded in a different unit"')+input('occurredAt','When it happened (optional)','datetime-local')+'<p>Leave the time blank if unknown. No earlier time will be assumed.</p>')+`<p class="work-help">A count observation records what you saw; it does not replace the stock balance.</p><button>Save completed movement</button>`)}</section>`;
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
 const people=`<label>Assigned to<select data-searchable name="assigneeId" required><option value="">Choose person</option>${users.map(u=>`<option value="${u.id}" ${u.eligible?'':'disabled'}>${esc(u.name+' · '+u.username+(!u.eligible?(u.status!=='active'?' — Inactive':' — Cannot take tasks'):''))}</option>`).join('')}</select></label>`;
 return `<section class="work-panel assignment-panel">${form('assign',toggle+product+input('quantity','Quantity','number','min="0.000001" max="1000000000" step="0.000001" inputmode="decimal" required')+people+'<div class="assignment-duration">'+input('dueDuration','Due in','number','min="0.016666666666666666" max="8760" step="any" inputmode="decimal" required value="8"')+'<label>Unit<select name="dueUnit"><option value="minutes">Minutes</option><option value="hours" selected>Hours</option><option value="days">Days</option></select></label></div>'+ (unavailable?'<p class="work-callout warning">'+esc(unavailable)+'</p>':'')+`<button ${unavailable||assignmentPending()||!online?'disabled':''}>${assignmentPending()?'Waiting for warehouse confirmation':'Assign Task'}</button>`,'data-assignment-form')} </section>`;
}
function updateAssignmentForm(f){
 if(f.dataset.workAction!=='assign')return;
 const unit=f.elements.dueUnit.value;f.elements.dueDuration.min=String(1/({minutes:1,hours:60,days:1440})[unit]);f.elements.dueDuration.max=({minutes:525600,hours:8760,days:365})[unit];
 for(const radio of f.querySelectorAll('[name="direction"]'))radio.disabled=!allowed(radio.value);
 const button=f.querySelector('button:not([type="button"])');button.disabled=!online||assignmentPending()||!allowed('assign')||!allowed(f.elements.direction.value)||!snapshot.products?.length||!snapshot.operators?.some(u=>u.eligible);
 button.textContent=assignmentPending()?'Waiting for warehouse confirmation':'Assign Task';
}
function historyPage(){
 const team=allowed('teamView'),scope=new URLSearchParams(location.search).get('scope');
 const tabs=team?'<nav class="work-actions" aria-label="History scope"><a href="/work/history">My history</a><a href="/work/history?scope=team">Team history</a></nav>':'';
 if(team&&scope==='team')return tabs+teamHistory();
 return '<h2>Task history</h2>'+tabs+'<p><a href="/work/history">All personal history</a> · <a href="/work/history?state=closed">Completed and cancelled</a></p><p><a href="/movement-history">Stock movements</a> are separate records.</p>'+pageLinks(snapshot.taskPage)+taskCards(snapshot.tasks)+pageLinks(snapshot.taskPage);
}
function teamHistory(){
 if(!allowed('teamView'))return '';
 const q=new URLSearchParams(location.search),filter=q.get('state')||'all';
 return `<nav class="work-actions task-tabs" aria-label="Team task status"><a href="/work/history?scope=team&state=open">Active · ${snapshot.taskCounts?.active??0}</a><a href="/work/history?scope=team&state=needs_assignment">Needs assignment · ${snapshot.taskCounts?.needsAssignment??0}</a><a href="/work/history?scope=team&state=overdue">Overdue · ${snapshot.taskCounts?.overdue??0}</a><a href="/work/history?scope=team&state=closed">History</a></nav>${disclosure('team-filters','Filters · '+esc([taskFilterLabel(filter),snapshot.operators?.find(u=>String(u.id)===q.get('operator'))?.name,q.get('action')].filter(Boolean).join(' · ')),`<form method="get" class="team-filters"><input type="hidden" name="scope" value="team"><label>Operator<select name="operator"><option value="">All operators</option>${options(snapshot.operators||[],'id',u=>u.name+' · '+u.username,q.get('operator'))}</select></label><label>State<select name="state">${['open','all','closed','needs_assignment','needs_review','overdue','completed','stopped','cancelled'].map(v=>`<option value="${v}" ${filter===v?'selected':''}>${esc(taskFilterLabel(v))}</option>`).join('')}</select></label><label>Action<select name="action"><option value="">Pick and Put</option>${['pick','put'].map(v=>`<option ${q.get('action')===v?'selected':''}>${v}</option>`).join('')}</select></label><button>Filter tasks</button></form>`)}${pageLinks(snapshot.taskPage)}${taskCards(snapshot.tasks)}${pageLinks(snapshot.taskPage)}${allowed('timing')?'<p><a href="/work/timing">Timing settings</a></p>':''}${disclosure('workloads','Workloads by person',`<p>Counts cover all active work, including other pages.</p>${(snapshot.operators||[]).map(u=>`<p><a href="/work/history?scope=team&operator=${u.id}">${esc(u.name)} · ${esc(u.username)}</a>: ${u.open||0} open · ${u.inProgress||0} in progress · ${u.overdue||0} overdue · ${u.review||0} review ${u.eligible?'':'· Ineligible for new work'}</p>`).join('')}`)}`;
}
function timingPage(){
 if(!allowed('timing'))return home();const t=snapshot.timing,unit=t.minutes%60===0?'hours':'minutes';
 return `<section class="work-intro"><a href="/work/history?scope=team">← Team history</a><h2>Work timing</h2><p>Warehouse timezone: ${esc(t.timezone)}. Deadlines use elapsed time, including nights.</p></section><section class="work-panel narrow">${form('timing',`<label>Default deadline for self-started work<select name="enabled"><option value="true" ${t.enabled?'selected':''}>Enabled for new tasks</option><option value="false" ${!t.enabled?'selected':''}>Disabled for new tasks</option></select></label>`+input('minutes','Highlight unfinished tasks after','number',`min="0.000001" step="any" max="${unit==='hours'?8760:525600}" data-time-unit="${unit}" required value="${unit==='hours'?t.minutes/60:t.minutes}"`)+`<label>Time unit<select name="timeUnit"><option value="minutes" ${unit==='minutes'?'selected':''}>Minutes</option><option value="hours" ${unit==='hours'?'selected':''}>Hours</option></select></label>`+'<p>Applies to new self-started tasks and older assignment forms. Assign Work uses the duration chosen on its form. Existing deadlines stay unchanged; an overdue warning never cancels work or releases stock.</p>'+'<h3>Missing updates during work</h3>'+input('inactivityMinutes','Check started work after (minutes)','number',`min="1" max="1440" required value="${t.inactivityMinutes}"`)+'<p>If started work has no update for this long, a supervisor must check what moved. Untouched new assignments do not need a quantity review just because they are old.</p><button>Save timing rules</button>')}</section>`;
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
function updateTimingFields(f,convert=false){if(f.dataset.workAction!=='timing')return;const field=f.elements.minutes,unit=f.elements.timeUnit.value,previous=field.dataset.timeUnit||unit;if(convert&&field.value)field.value=String(Number(field.value)*(previous==='hours'?60:1)/(unit==='hours'?60:1));field.dataset.timeUnit=unit;field.max=unit==='hours'?'8760':'525600';}
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
 const names={closeTask:'Close task with actual totals',sendTaskReview:'Send task closure for review',handBack:'Hand back remaining work',acknowledgeReturn:'Acknowledge return',updateReturned:'Update returned task',assignReview:'Assign quantity check',observeReview:'Save quantity observation',resumeFollowup:'Plan verified remaining work',assign:'Assign task',decline:'Return assigned task',stop:'Cancel / stop remaining task',cancel:'Cancel location work',reassign:'Assign task',deadline:'Change task deadline',start:'Start task',correct:'Correct earlier quantity',askReview:'Ask supervisor to check actual quantity',resolve:'Save supervisor check',timing:'Change work timing',mode:'Change location guidance'};
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
const workLinkCapability=href=>({'/':'view','/work':'view','/work/history':'view','/movement-history':'view','/recommended-actions':'view','/pick':'pick','/put':'put','/record-movement':'report','/work/overview':'assign','/pending-confirmations':'review','/work/timing':'timing','/labels':'labels','/stocktaking':'countView','/cells':'locationsView'})[href]||(/^\/cells\/\d+$/.test(href)?'locationsView':null);
function workShortcuts(){return '<div class="work-tools-links">'+[['/record-movement','Record completed movement'],['/movement-history','Movement history'],['/','Warehouse overview'],['/recommended-actions','Space suggestions'],['/stocktaking','Stocktaking'],['/labels','Location labels'],['/pending-confirmations','Needs review']].filter(([href])=>allowed(workLinkCapability(href))).map(([href,label])=>`<a href="${href}">${label}</a>`).join('')+'</div>';}
function render(){
 const disclosures=new Map([...root.querySelectorAll('details[data-disclosure]')].map(d=>[d.dataset.disclosure,d.open]));
 dirty=false;
 if(!snapshot){root.innerHTML='<section class="work-empty"><h2>No saved work on this device</h2><p>Connect to the warehouse and sign in to save your allocations.</p><a href="/login">Sign in</a></section>';return;}

 root.classList?.toggle('my-work',path==='/work');
 const queued=outbox.filter(o=>o.partition===key()&&!['recorded','duplicate','reserved','ready','verified','busy','acknowledged'].includes(o.state));
 const unconfirmed=queued.filter(o=>o.state!=='review');
 const savedDetails=queued.length?`<div class="table-wrap"><table><thead><tr><th>Update / status</th><th>Next action</th></tr></thead><tbody>${queued.map(queueEntry).join('')}</tbody></table></div><button type="button" class="secondary" data-retry>Send saved updates / refresh</button>`:'';
 const deviceHelp=disclosure('device-recovery','Saved updates & device help',savedDetails+'<p>Saved work stays on this device. Send all updates before handing it over.</p><div class="work-tools-links"><button type="button" class="text-button" data-export>Download saved updates and drafts</button><button type="button" class="text-button" data-forget>Clear local data (only after updates are received)</button></div>');
 const utility=['/work','/work/overview'].includes(path)?disclosure('my-work-tools','Work tools',workShortcuts()+'<div id="device-help">'+deviceHelp+'</div><div class="work-connection">'+badge(online?'Connected to warehouse':'Offline · saved work',online?'good':'warning')+'</div>',false,'my-work-utility'):'';
 const body=path==='/work/overview'?assignmentPage():path==='/work/timing'?timingPage():path==='/work/history'?historyPage():path==='/pick'?createPage('pick'):path==='/put'?createPage('put'):path==='/record-movement'?manualPage():path==='/pending-confirmations'?pendingPage():path==='/labels'?labelsPage():path==='/movement-history'?ledger():/^\/tasks\/\d+$/.test(path)?taskPage(path.split('/')[2]):home();
 root.innerHTML=`<nav class="work-views" aria-label="Work views"><a href="/work">My work</a>${allowed('assign')?'<a href="/work/overview">Assign Work</a>':''}${allowed('review')?`<a href="/pending-confirmations">Needs review · ${snapshot.reviewTotal??snapshot.pending.length}</a>`:''}<a href="/work/history">History</a>${utility}</nav>${['/work','/work/overview'].includes(path)?'':`<div class="work-toolbar"><div class="work-tools">${!online?'<a href="/work">My work</a><a href="/pick">Pick</a><a href="/put">Put</a>':''}${disclosure('work-tools','Work tools',workShortcuts(),false,'work-tools-details')}</div><div class="work-connection">${badge(online?'Connected to warehouse':'Offline · saved work',online?'good':'warning')}<small>Updated ${esc(new Date(snapshot.generatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</small></div></div>`}<div id="work-notice" data-notice="${esc(notice)}" role="status" aria-live="polite">${notice?`<p class="work-callout">${esc(workText(notice))}</p>`:''}</div><p id="work-connection-warning" class="work-callout warning" role="status" ${connectionWarning?'':'hidden'}>${esc(connectionWarning)}</p>${!online?'<p class="work-callout warning">Offline: saved work and physical entries stay on this device. No new reservation or location turn is granted. Follow the warehouse manual procedure; use paper if needed.</p>':''}${unconfirmed.length?`<p class="work-callout warning" role="status">${unconfirmed.length} saved update${unconfirmed.length===1?'':'s'} ${unconfirmed.some(o=>['local','sending','error','rejected','activation-unknown','activation-pending'].includes(o.state))?'need warehouse confirmation':'need attention or review'}. <button type="button" class="text-button" data-show-saved>View status and retry</button></p>`:''}<div data-inactivity-alerts role="status">${inactivityAlertsMarkup()}</div>${body}<dialog class="my-work-action-dialog task-edit-dialog" data-task-dialog aria-label="Task action"></dialog>${path==='/work'?'<dialog class="my-work-action-dialog" data-my-work-dialog aria-label="Task actions"></dialog>':path==='/work/overview'?'':`<footer class="work-footer" id="device-help">${disclosure('device-recovery','Saved updates & device help',savedDetails+'<p>Saved work stays on this device. Use your own device account. Send all updates before handing it over.</p><div class="work-tools-links"><button type="button" class="text-button" data-export>Download saved updates and drafts</button><button type="button" class="text-button" data-forget>Clear local data (only after updates are received)</button></div>')}</footer>`}`;
 for(const link of root.querySelectorAll('a[href]')){const href=(link.getAttribute?.('href')||'').split('?')[0];const cap=workLinkCapability(href);if(cap&&!allowed(cap))link.remove();}
 for(const f of root.querySelectorAll('form[data-work-action]')){f._workIdentity={site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id};f._draftPath=path;}
 restoreDrafts();
 for(const f of root.querySelectorAll('form[data-work-action]')){updateProductPicker(f);updateRecoveryLink(f);updateTimingFields(f);updateAssignmentForm(f);}
 if(typeof location!=='undefined'&&new URLSearchParams(location.search).has('device_help'))for(const name of ['my-work-tools','device-recovery'])root.querySelector('[data-disclosure="'+name+'"]')?.setAttribute('open','');
 for(const box of root.querySelectorAll('[data-product-stock]'))box._stockOpen=disclosures.get('product-stock-details')||false;
 refreshProductStocks();patchTaskAssignees();
 for(const d of root.querySelectorAll('details[data-disclosure]'))if(disclosures.has(d.dataset.disclosure))d.open=disclosures.get(d.dataset.disclosure);
 for(const f of root.querySelectorAll('form[data-work-action]'))updateVerificationFields(f);
 patchGuidanceHints();

}
function draftKey(f){const identity=f._workIdentity||snapshot;const userId=identity.actorId??identity.user.id;return `${identity.site}:${userId}:${identity.dataset}:draft:${f._draftPath||path}:${f.dataset.workAction}:${f.dataset.draftKind||'normal'}:${f.elements.lineId?.value||f.elements.reportId?.value||f.elements.taskId?.value||''}:${f.elements.revision?.value||f.elements.caseRevision?.value||f.elements.generation?.value||''}:${f.elements.progressToken?.value||''}:${f.elements.assignmentGeneration?.value||''}${draftContext(f)}`;}
function restoreDrafts(){
 globalThis.WarehouseCombobox?.init(root);
 for(const f of root.querySelectorAll('form[data-work-action]')){const values=drafts.get(draftKey(f));if(values?._actuals&&f.querySelector('[data-actual-rows]')){const t=availableTask(f.elements.taskId?.value)||snapshot.pending?.find(r=>r.id===f.elements.reportId?.value)?.closureTask;if(t)f.querySelector('[data-actual-rows]').innerHTML=values._actuals.map((r,i)=>actualRow(t,r,i)).join('');}if(values)for(const el of f.elements)if(el.name in values&&el.type!=='hidden'&&!(values._actuals&&/^actual(Cell|Quantity)\d+$/.test(el.name))){
  const saved=values[el.name];if(saved.candidate&&el.dataset?.searchRemote==='counts')f._countCandidates=[...(f._countCandidates||[]).filter(c=>String(c.id)!==String(saved.candidate.id)),saved.candidate];if(el.dataset?.searchRemote&&saved.value&&saved.option&&!Array.from(el.options).some(o=>o.value===saved.value))el.add(new Option(saved.option,saved.value));
  if(el.type==='radio')el.checked=el.value===saved.value;else{el.value=saved.value;if(el.type==='checkbox')el.checked=saved.checked;}
 }if(f.elements.countCorrectionId?.value){const r=snapshot.pending?.find(r=>String(r.id)===String(f.elements.reportId?.value)),candidate=(f._countCandidates||[r?.countEvidence]).find(c=>c&&String(c.id)===f.elements.countCorrectionId.value);if(r)f.querySelector('[data-count-sequence]').textContent=countSequence(candidate,r);}}
 globalThis.WarehouseCombobox?.init(root);for(const f of root.querySelectorAll('[data-task-closure]'))updateClosureForm(f);
 globalThis.WarehouseCombobox?.restore(root);
}

function patchMyWorkRows(){
 const body=root.querySelector('[data-my-work-table]');if(!body)return;
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
 if(!body.querySelector('[data-task-row]'))body.innerHTML='<tr><td colspan="9" class="empty-cell">No current tasks.</td></tr>';
 patchMyNext();
 const pages=root.querySelector('[data-my-work-pagination]');if(pages)pages.innerHTML=snapshot.taskPage?.view==='mine'&&snapshot.taskPage.pages>1?pageLinks(snapshot.taskPage):'';
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
   if(!r.ok){o.state=r.status===400?(['report','manual','correct'].includes(o.action)?'rejected':'not-applied'):'error';o.message=result.error||'Not received. Keep this entry and contact your supervisor.';notice=o.message;}
   else{o.state=result.status;o.message=result.message;o.result=result;notice=result.message;}
   await store('outbox','readwrite',s=>s.put(o));
  }
  await refresh();outbox=await all('outbox');
 }catch(e){online=false;connectionWarning=e instanceof TypeError?'Connection unavailable. Updates remain saved on this device.':e.message||'Connection unavailable. Updates remain saved on this device.';}
 finally{syncing=false;finishSync();}
}
async function saveDraft(f){
 const values={};for(const el of f.elements)if(el.name&&el.type!=='hidden'&&el.type!=='submit'&&(el.type!=='radio'||el.checked))values[el.name]={value:el.value,checked:el.checked,...(el.dataset?.searchRemote&&el.value?{option:el.selectedOptions[0]?.textContent,...(el.dataset.searchRemote==='counts'?{candidate:(f._countCandidates||[snapshot.pending?.find(r=>String(r.id)===String(f.elements.reportId?.value))?.countEvidence]).find(c=>c&&String(c.id)===el.value)}:{})}:{})};
 if(f.dataset.workAction==='closeTask'||f.dataset.draftKind==='closure-review')values._actuals=closureActualValues(f);
 const id=draftKey(f);drafts.set(id,values);await store('cache','readwrite',s=>s.put({id,values}));
}
async function showSummary(l,method,locationValue='') {
 const id=stageKey(l),value={method,location:locationValue};
 await store('cache','readwrite',s=>s.put({id,stage:value}));stages.set(id,value);render();
}
function findLine(id){return snapshot.tasks.flatMap(t=>t.lines).find(l=>l.id===Number(id));}
async function immediate(action,values){
 const r=await fetch('/api/work/'+action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({...values,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId})});
 const result=await r.json();if(!r.ok)throw new Error(result.error);return result;
}
root.addEventListener('combobox:search',e=>{if(!e.target.matches('select[data-search-remote]'))return;e.preventDefault();searchCombo(e.target,e.detail.query,e.detail.signal).then(e.detail.resolve,error=>e.detail.reject(error.message));});
root.addEventListener('invalid',e=>{for(let p=e.target.parentElement;p&&p!==root;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;},true);
root.addEventListener('input',e=>{
 dirty=true;const f=e.target.closest('form');if(f)f.dataset.edited='true';if(f?.dataset.workAction)saveDraft(f).catch(()=>{notice='Draft not saved: device storage failed. Use the manual recording procedure.';document.querySelector('#work-notice').textContent=workText(notice);});
 if(f)updateRecoveryLink(f);
 if(f&&e.target.name==='verificationNote')updateVerificationFields(f);
 if(f&&e.target.name==='unit')updateProductPicker(f);

});
root.addEventListener('change',e=>{const changedForm=e.target.closest('form');if(changedForm){updateClosureForm(changedForm);if(e.target.name==='changeDue')updateReturnedDue(changedForm);updateRecoveryLink(changedForm);updateAssignmentForm(changedForm);if(e.target.name==='verification')updateVerificationFields(changedForm);if(e.target.name==='timeUnit')updateTimingFields(changedForm,true);}if(e.target.name==='productId'){updateProductPicker(e.target.closest('form'));refreshProductStocks(true,e.target.closest('form'));}else if(e.target.name==='direction')refreshProductStocks(true,e.target.closest('form'));if(e.target.name==='assigneeId')patchTaskAssignees();if(e.target.name==='countCorrectionId'){const f=e.target.closest('form'),r=snapshot.pending.find(r=>r.id===f.elements.reportId?.value),candidate=(f._countCandidates||[r?.countEvidence]).find(c=>c&&String(c.id)===e.target.value);if(r)f.querySelector('[data-count-sequence]').textContent=countSequence(candidate,r);}dirty=true;const f=e.target.closest('form');if(f)f.dataset.edited='true';if(f?.dataset.workAction)saveDraft(f).catch(()=>{});});
let submitting=false;
root.addEventListener('submit',async e=>{
 const f=e.target.closest('form[data-work-action]');if(!f)return;e.preventDefault();if(submitting)return;submitting=true;
 const button=f.querySelector('button:not([type="button"])');button.disabled=true;
 const feedback=f.querySelector('.form-feedback'),action=e.submitter?.hasAttribute('data-send-task-review')?'sendTaskReview':f.dataset.workAction;
 try{
  await saveDraft(f);
  requireSavedCheckObservation(f);
  if(f._workIdentity&&(f._workIdentity.site!==snapshot.site||f._workIdentity.dataset!==snapshot.dataset||f._workIdentity.actorId!==snapshot.user.id))throw new Error('This draft belongs to the original account and warehouse dataset. Reopen the task before saving.');
  outbox=await all('outbox');
  const values=Object.fromEntries(new FormData(f));
  const countLinks={};for(const name of Object.keys(values))if(/^countLink\d+$/.test(name)){countLinks[name.slice(9)]=values[name];delete values[name];}if(Object.keys(countLinks).length)values.countLinks=countLinks;
  if(f.dataset.workAction==='closeTask'||f.dataset.draftKind==='closure-review'){values.actuals=closureActualValues(f);for(const name of Object.keys(values))if(/^actual(Cell|Quantity)/.test(name))delete values[name];}
  for(const n of ['verifiedClosure','workerStopped','changeDue','manual','keepOpen','dismissDuplicate','closeAllocation','zeroConfirmed','afterCountVerified','stopRemaining','enabled'])if(n in values)values[n]=values[n]==='on'||values[n]==='true';
  if(action==='report'&&!online)values.manual=true;
  if(values.occurredAt)values.occurredAt=new Date(values.occurredAt).toISOString();
  if(values.dueAt)values.dueAt=new Date(values.dueAt).toISOString();
  if(values.countChoice==='included'&&!values.countCorrectionId)throw new Error('Choose the stock count that already includes these items.');
  if(values.countChoice==='separate'){values.afterCountVerified=true;delete values.countCorrectionId;}
  if(values.countCorrectionId&&values.countChoice!=='included')throw new Error('Confirm whether these items were already included or were a separate movement.');
  if('verificationNote' in values)values.verification=verifiedDescription(values);
  if(values.note&&action==='decline')values.reason=[values.reason,values.note].filter(Boolean).join(' — ');
  if(action==='manual'&&!values.unit?.trim())values.unit=snapshot.products.find(p=>p.id===Number(values.productId))?.unit_of_measure;
  if(['closeTask','sendTaskReview'].includes(action)||f.dataset.draftKind==='closure-review'){
   if(!online)throw new Error('Reconnect before confirming closure. Your actual totals remain saved as a draft.');
   if(!values.currentStatus)throw new Error('Choose Yes or No first.');
   const t=availableTask(values.taskId)||snapshot.pending?.find(r=>r.id===values.reportId)?.closureTask;if(!t||taskHasSavedUpdate(t)||outbox.some(o=>o.partition===key()&&['local','sending','error','rejected'].includes(o.state)&&o.action==='manual'))throw new Error('Send saved movement updates and wait for confirmation before closing this task.');
   const id=uid(),input={...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId};
   await store('outbox','readwrite',s=>s.put({id,partition:key(),action,input,label:savedAction({action,input}),state:'local',message:'Closure awaiting warehouse confirmation. Task is not closed yet.',createdAt:new Date().toISOString()}));
   outbox=await all('outbox');await sync();const received=outbox.find(o=>o.id===id);
   if(!received?.result)throw new Error(received?.message||'Closure not confirmed. Use saved update status to retry this same request; your draft is kept.');
   await store('cache','readwrite',s=>s.delete(draftKey(f)));drafts.delete(draftKey(f));notice=received.message;render();
  }else if(isActivation(action,values)){await beginActivation(action,values);await store('cache','readwrite',s=>s.delete(draftKey(f)));drafts.delete(draftKey(f));}
  else if(action==='acquire'){if(!lineActive(findLine(values.lineId)))throw new Error('Resume this task before arriving.');
   if(!online)throw new Error('Reconnect to request a turn. You may still report physical work already done.');
   f._input||={...values,requestId:uid()};const result=await immediate(action,f._input);notice=result.message;
   await refresh();render();if(result.status==='ready')void scanQR(findLine(values.lineId));
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
   outbox=await all('outbox');notice=message;render();await sync();const received=outbox.find(o=>o.id===id);
   render();
  }
 }catch(error){feedback.textContent=workText(error.message);feedback.classList.add('error');button.disabled=action==='assign'&&(assignmentPending()||!online);notice=error.message;if(!f.isConnected||isActivation(action))render();}
 finally{submitting=false;if(f.closest?.('[data-task-dialog]'))patchTaskDialog();}
});
root.addEventListener('click',async e=>{
 try{
  if(e.target.closest('[data-show-saved]')){for(const name of ['my-work-tools','device-recovery'])root.querySelector('[data-disclosure="'+name+'"]')?.setAttribute('open','');root.querySelector('[data-disclosure="device-recovery"]')?.scrollIntoView({block:'nearest'});return;}
  const edit=e.target.closest('[data-add-actual],[data-remove-actual]');if(edit){await saveDraft(editActualRows(edit));return;}
  const checkStop=e.target.closest('[data-check-stop]');if(checkStop){toggleCheckStop(checkStop);return;}
  const taskModal=e.target.closest('[data-task-details],[data-task-stop],[data-task-check],[data-record-moved]');if(taskModal){const lineId=taskModal.dataset.recordMoved;let t=snapshot.tasks.find(t=>lineId?t.lines.some(l=>l.id===Number(lineId)):t.id===Number(taskModal.dataset.taskDetails||taskModal.dataset.taskStop||taskModal.dataset.taskCheck));if(online&&(taskModal.dataset.taskStop||taskModal.dataset.taskCheck||!t))t=await fetchDialogTask(Number(taskModal.dataset.taskDetails||taskModal.dataset.taskStop||taskModal.dataset.taskCheck));if(t)openTaskDialog(t,lineId?'recovery':taskModal.dataset.taskDetails?'details':taskModal.dataset.taskStop?'stop':'check',lineId);return;}
  const stockRetry=e.target.closest('[data-stock-retry]');if(stockRetry){refreshProductStocks(true,stockRetry.closest('form'));return;}
  const nextLocation=e.target.closest('[data-active-location]');if(nextLocation){const t=snapshot.tasks.find(t=>t.id===Number(path.split('/')[2]));if(workActive(t)){e.preventDefault();window.history.pushState({},'',nextLocation.getAttribute('href'));render();return;}}
  if(e.target.closest('[data-refresh-guidance]')){await refreshActiveLight();return;}
  const retryActivation=e.target.closest('[data-retry-activation]');if(retryActivation){if(submitting)return;submitting=true;try{const o=outbox.find(o=>o.id===retryActivation.dataset.retryActivation&&o.partition===key());if(o)await deliverActivation(o);}finally{submitting=false;}return;}
  if(e.target.closest('[data-task-dialog-close]')){root.querySelector('[data-task-dialog]')?.close();return;}
  const taskAction=e.target.closest('[data-update-returned],[data-hand-back]');if(taskAction){const id=Number(taskAction.dataset.updateReturned||taskAction.dataset.handBack),found=[...(snapshot.returnedTasks||[]),...snapshot.tasks,...(snapshot.watchedTasks||[])].find(t=>t.id===id);let t=found;if(!t&&online){t=await fetchDialogTask(id);snapshot.watchedTasks=[...(snapshot.watchedTasks||[]),t];}if(!t)throw new Error('Reconnect to open the latest task.');if(t)openTaskDialog(t,taskAction.dataset.updateReturned?'update':'return');return;}
  const myMore=e.target.closest('[data-my-actions]');if(myMore){const t=[...snapshot.tasks,...(snapshot.watchedTasks||[])].find(t=>t.id===Number(myMore.dataset.myActions));if(t)myActionDialog(t);return;}
  if(e.target.closest('[data-my-close]')){root.querySelector('[data-my-work-dialog]')?.close();return;}
  const preview=e.target.closest('[data-view-saved]');if(preview){const f=preview.closest('form'),option=f.elements.duplicateOf.selectedOptions[0];f.querySelector('[data-saved-entry]').textContent=option?.value?option.textContent:'Choose a saved entry to inspect.';return;}
  const ack=e.target.closest('[data-ack-request]');if(ack){const entry=outbox.find(o=>o.id===ack.dataset.ackRequest&&o.partition===key());if(entry?.state==='not-applied'){entry.state='acknowledged';await store('outbox','readwrite',s=>s.put(entry));render();}return;}
  if(e.target.closest('[data-print]'))window.print();
  const q=e.target.closest('[data-quantity]');if(q){const field=q.closest('form').elements.quantity;field.value=q.dataset.quantity;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();}
  if(e.target.closest('[data-retry]')){await sync();render();}
  if(e.target.closest('[data-export]')){
   const reports=outbox.filter(o=>o.partition===key()),savedDrafts=(await all('cache')).filter(r=>r.values&&r.id.startsWith(key()+':')),blob=new Blob([JSON.stringify({warehouse:snapshot.site,account:snapshot.user.username,reports,drafts:savedDrafts},null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='warehouse-saved-updates.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);return;
  }
  if(e.target.closest('[data-forget]')){
   if(outbox.some(o=>['local','sending','error','rejected','activation-pending','activation-unknown'].includes(o.state))){notice='Unreceived updates remain. Send or download them before clearing local data.';render();return;}
   // Clear only this account; another account's cache and evidence stay partitioned.
   for(const row of await all('cache'))if(row.id.startsWith(key()+':')||row.id===key())await store('cache','readwrite',s=>s.delete(row.id));
   for(const row of outbox.filter(o=>o.partition===key()))await store('outbox','readwrite',s=>s.delete(row.id));
   snapshot=null;outbox=[];render();return;
  }
  const manual=e.target.closest('[data-manual-summary]');if(manual)await showSummary(findLine(manual.dataset.manualSummary),'manual');
  const scan=e.target.closest('[data-scan-line]');if(scan)await scanQR(findLine(scan.dataset.scanLine));
  const link=e.target.closest('a');if(link&&!online&&link.getAttribute('href')?.startsWith('/')){const target=link.getAttribute('href');if(['/work','/pick','/put','/record-movement'].includes(target)||/^\/tasks\/\d+$/.test(target)){e.preventDefault();path=target;activeWork=null;render();}}
 }catch(error){notice=error.message;render();}
});
let stopCamera=null;
async function scanQR(l){
 if(!l)return;stopCamera?.();
 if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){notice='Camera unavailable. Choose Complete without scanning to check the cell and Finish manually.';render();return;}
 const dialog=document.createElement('dialog');dialog.className='qr-dialog';dialog.innerHTML=`<h2>Scan this cell</h2><p>${esc(l.product_name)} · ${esc(l.type)} ${esc(l.planned_quantity)} ${esc(l.unit_of_measure)} · ${esc(l.logical_code)}</p><p>Scanning opens a summary. Only Finish records stock.</p><video autoplay playsinline muted></video><p role="status" class="scan-feedback"></p><button type="button" data-close-camera>Close camera</button><button type="button" class="secondary" data-camera-manual>Complete without scanning</button>`;
 document.body.append(dialog);dialog.showModal();let stopped=false,stream;
 const stop=()=>{stopped=true;stream?.getTracks().forEach(t=>t.stop());cameraStream=null;dialog.remove();stopCamera=null;};stopCamera=stop;
 dialog.querySelector('[data-close-camera]').onclick=stop;dialog.addEventListener('cancel',stop);
 dialog.querySelector('[data-camera-manual]').onclick=async()=>{stop();await showSummary(l,'manual');};
 try{
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(stopped){stream.getTracks().forEach(t=>t.stop());return;}cameraStream=stream;
  const video=dialog.querySelector('video');video.srcObject=stream;await video.play();const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let lastRejected='';
  async function frame(){
   if(stopped)return;
   if(video.readyState>=2){canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const p=ctx.getImageData(0,0,canvas.width,canvas.height),code=window.jsQR(p.data,p.width,p.height);
    if(code&&code.data!==lastRejected){try{const result=await immediate('verify',{requestId:uid(),lineId:l.id,revision:l.revision,assignmentGeneration:l.current_generation,location:code.data});if(stopped)return;notice=result.message;stop();await showSummary(l,'camera',code.data);return;}catch(error){lastRejected=code.data;if(!stopped)dialog.querySelector('.scan-feedback').textContent=error.message;}}
   }
   if(!stopped)requestAnimationFrame(frame);
  }requestAnimationFrame(frame);
 }catch(error){stop();notice='Camera unavailable. Choose Complete without scanning; no movement has been recorded.';render();}
}
window.addEventListener('pagehide',()=>stopCamera?.());
window.addEventListener('popstate',()=>{activeWork=null;location.reload();});
window.addEventListener('offline',()=>{online=false;productStockReads.clear();refreshProductStocks();patchGuidanceHints();patchTaskDialog();connectionWarning='Connection lost. Saved updates remain on this phone.';if(!dirty&&!root.querySelector('[data-my-work-dialog]')?.open&&!root.querySelector('[data-task-dialog]')?.open)render();else{if(path==='/work')patchLiveRows();const warning=document.querySelector('#work-connection-warning');if(warning){warning.textContent=connectionWarning;warning.hidden=false;}}});
const canRefresh=()=>!root.querySelector('[data-my-work-dialog]')?.open&&!root.querySelector('[data-task-dialog]')?.open&&!dirty&&!root.contains(document.activeElement)&&!cameraStream?.active&&!submitting;
let monitoring=false,pollDelay=5000;
function patchLiveRows(){
 refreshProductStocks();patchGuidanceHints();patchReturnedRows();patchTaskAssignees();
 const pageTop=window.scrollY,scrolls=[...root.querySelectorAll('.work-table-wrap,.my-work-table-wrap')].map(el=>[el,el.scrollLeft,el.scrollTop]);
 let anchorShift=0;
 if(path==='/work')anchorShift=patchMyWorkRows()||0;else {
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
 const reviewLink=root.querySelector('.work-views a[href="/pending-confirmations"]');if(reviewLink)reviewLink.textContent='Needs review · '+(snapshot.reviewTotal??0);
 const live=root.querySelector('#work-notice');if(live&&live.dataset.notice!==notice){live.innerHTML=notice?`<p class="work-callout">${esc(notice)}</p>`:'';live.dataset.notice=notice;}
 const warning=root.querySelector('#work-connection-warning');if(warning){warning.textContent=connectionWarning;warning.hidden=!connectionWarning;}
 const activeCount=root.querySelector('[data-work-active-count]');if(activeCount)activeCount.textContent='Continue working · '+(snapshot.taskCounts?.active??0);
 for(const [href,count] of [['/work/history?scope=team&state=open',snapshot.taskCounts?.active],['/work/history?scope=team&state=needs_assignment',snapshot.taskCounts?.needsAssignment],['/work/history?scope=team&state=overdue',snapshot.taskCounts?.overdue]]){const link=root.querySelector(`.task-tabs a[href="${href}"]`);if(link&&count!=null)link.textContent=link.textContent.split(' · ')[0]+' · '+count;}
 if(path==='/work/overview')for(const f of root.querySelectorAll('[data-assignment-form]'))updateAssignmentForm(f);
 for(const [el,x,y] of scrolls){el.scrollLeft=x;el.scrollTop=y;}window.scrollTo({top:pageTop+anchorShift,behavior:'instant'});
}
async function backgroundRefresh(){
 if(monitoring||submitting||cameraStream?.active)return;monitoring=true;
 try{const wasOffline=!online;await sync();if(wasOffline&&online)refreshProductStocks(true);pollDelay=online?5000:Math.min(60000,pollDelay*2);if(canRefresh()){
  const positions=[...root.querySelectorAll('.work-table-wrap,.my-work-table-wrap')].map(el=>[el.scrollLeft,el.scrollTop]);const top=window.scrollY;render();[...root.querySelectorAll('.work-table-wrap,.my-work-table-wrap')].forEach((el,i)=>{if(positions[i]){el.scrollLeft=positions[i][0];el.scrollTop=positions[i][1];}});window.scrollTo({top,behavior:'instant'});
 }else patchLiveRows();}finally{monitoring=false;}
}
window.addEventListener('online',backgroundRefresh);
window.addEventListener('pageshow',e=>{if(e.persisted){activeWork=null;void backgroundRefresh();}});
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='hidden')stopCamera?.();else await backgroundRefresh();});
try{
 db=await openDB();
 if(snapshot)await cacheSnapshot();else{const active=await store('cache','readonly',s=>s.get('active'));snapshot=(await store('cache','readonly',s=>s.get(active?.key||'')))?.snapshot;}
 for(const row of await all('cache')){if(row.stage)stages.set(row.id,row.stage);if(row.values)drafts.set(row.id,row.values);}
 outbox=await all('outbox');
 for(const o of outbox.filter(o=>o.state==='rejected'&&!['report','manual','correct'].includes(o.action))){o.state='not-applied';await store('outbox','readwrite',s=>s.put(o));}
}catch(error){notice='Device storage is unavailable. Updates are not saved locally; use the manual recording procedure.';}
render();
if(boot)await backgroundRefresh();
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});
async function pollWork(){if(document.visibilityState==='visible')await backgroundRefresh();setTimeout(pollWork,pollDelay);}setTimeout(pollWork,pollDelay);
