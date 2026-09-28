const root=document.querySelector('#work-app');
const boot=JSON.parse(document.querySelector('#work-boot')?.textContent||'null');
let snapshot=boot?.snapshot, path=boot?.path||location.pathname, outbox=[],notice='', db,online=Boolean(boot),cameraStream;
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
 const query=new URLSearchParams(location.search);const watched=[...root.querySelectorAll('[data-task-row]')].map(r=>r.dataset.taskRow).slice(0,100);if(watched.length)query.set('watch',watched.join(','));query.set('view',path==='/work/overview'?'team':path==='/work/history'?'history':path==='/work'?'mine':'accessible');if(/^\/tasks\/\d+$/.test(path))query.set('taskId',path.split('/')[2]);
 const r=await fetch('/api/work/snapshot?'+query,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(r.status===401?'Sign in to send your saved updates.':'Could not refresh warehouse work.');
 const fresh=await r.json();
 if(snapshot&&(fresh.user.id!==snapshot.user.id||fresh.site!==snapshot.site))throw new Error('The signed-in account or warehouse changed. Reopen My work; saved updates stay with their original account and warehouse.');
 snapshot={...fresh,ledger:snapshot?.ledger};online=true;await cacheSnapshot();
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
 const permission={create:body.includes('value="put"')?'put':'pick',acquire:'execute',verify:'execute',start:'execute',decline:'execute',reassign:'assign',deadline:'deadline',timing:'timing',askReview:'report',report:'execute',manual:'report',recommendation:'report',cancel:'stop',correct:'correct',replan:'execute',mode:'mode',reconcile:'reconcile',resolve:body.includes('name="dismissDuplicate"')?'link':'resolve',stop:'stop'}[action];
 if(permission&&!allowed(permission)&&!(action==='stop'&&allowed('teamStop')))return '';
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
const stageKey=l=>`${key()}:summary:${l.id}:${l.revision}:${l.current_generation}`;
const dueText=t=>t.clock_invalid?'Warehouse clock needs checking':t.overdue?`Overdue by ${t.overdue_minutes} min`:t.due_at?`Due ${new Date(t.due_at).toLocaleString([], {timeZone:snapshot.timing?.timezone})}`:'No deadline';
const outcome=t=>({open:t.assignment_state==='offered'?'Not started':'In progress',needs_assignment:'Needs assignment',needs_review:'Needs review',stopped:'Stopped — partly completed',cancelled:'Cancelled — nothing moved',completed:'Completed'})[t.outcome]||status(t.status);
function lineCard(l){
 const active=['ready','working'].includes(l.execution_state),working=l.execution_state==='working';
 const waiting=l.reports?.filter(r=>r.status==='review')||[];
 const saved=outbox.some(o=>o.partition===key()&&Number(o.input.lineId)===l.id&&['local','sending','error','rejected'].includes(o.state));
 const stage=stages.get(stageKey(l));
 const recovery=form('report',allocationFields(l)+hidden('manual','true')+qty('Actual quantity ('+l.unit_of_measure+')')+`<label>Actual location<select name="cellId">${options(snapshot.cells,'id',c=>c.description?.name||c.logical_code,l.cell_id)}</select></label>`+input('reason','What happened?','text','required')+'<button>Save physical movement for review</button>','data-draft-kind="difference"');
 let actions='';
 if(active&&l.canAct!==false){
  if(saved)actions='<button disabled>Update saved — waiting for warehouse confirmation</button>';
  else if(waiting.length||!online)actions=disclosure('manual-'+l.id,'Record what I moved',`<p>Enter only work already done. Do not repeat the movement.</p>${recovery}`,true);
  else {
   if(!working)actions=form('acquire',allocationFields(l)+hidden('method','arrival')+"<button>I'm at this location</button>");
   else if(!stage)actions=`<p class="work-callout">${l.controller_id?'Look for the lit cell. Guidance command sent.':'Manual location — check the cell name.'} ${l.guidance_mode==='shared'?'Follow your own quantity; this light is shared.':''}</p><button type="button" data-scan-line="${l.id}">Resume camera</button><button type="button" class="secondary" data-manual-summary="${l.id}">Complete without scanning</button>`;
   else actions=`<section class="cell-summary" aria-label="Cell summary"><h3>${esc(l.product_name)} · ${esc(l.logical_code)}</h3><p>${stage.method==='camera'?'QR checked':'Manual completion — no QR verification'}</p>${form('report',allocationFields(l)+hidden('method',stage.method)+hidden('location',stage.location||'')+`<label>Quantity ${l.type==='pick'?'picked':'put'} (${esc(l.unit_of_measure)})<input name="quantity" type="number" min="0" max="1000000000" step="0.000001" inputmode="decimal" required value="${esc(l.planned_quantity)}"></label><p class="work-help">Change quantity above if needed. Use 0 only when nothing moved.</p>`+(stage.method==='manual'?'<label>Reason<select name="manualReason" required><option value="No camera / camera unavailable">No camera / camera unavailable</option><option value="Label unreadable">Label unreadable</option><option value="Checked printed cell name">Checked printed cell name</option></select></label>':'')+`<p>Press Finish only after moving the items. This records only this cell and stops its unperformed remainder.</p><button>Finish ${esc(l.type)} at this cell</button>`)}<button type="button" class="secondary" data-scan-line="${l.id}">Scan again</button></section>`;
   actions+=disclosure('difference-'+l.id,'Record a difference',recovery+form('askReview',allocationFields(l)+input('reason','What is uncertain?')+'<button class="secondary">Ask supervisor to resolve</button>'));
   actions+=disclosure('cancel-'+l.id,'Cancel this location',form('cancel',allocationFields(l)+hidden('zeroConfirmed','true')+'<p>This declares zero movement. If anything moved, record that actual using Finish first. A partial actual closes this cell’s remaining plan.</p><label class="work-check"><input type="checkbox" required>Nothing moved at this location.</label><button class="secondary">Nothing moved — cancel</button>'));
   if(!working&&l.type==='put')actions+=disclosure('replan-'+l.id,'Use a different planned location',form('replan',hidden('lineId',l.id)+hidden('revision',l.revision)+`<label>Replacement location<select name="cellId">${options(snapshot.cells,'id',c=>c.logical_code,l.cell_id)}</select></label>`+qty('Replacement planned quantity')+'<label class="work-check"><input type="checkbox" required>Nothing moved under the original instructions.</label><button class="secondary">Save replacement plan</button>'));
  }
 } else if(l.execution_state==='settled'&&l.canAct!==false)actions=disclosure('correct-'+l.id,'Correct earlier quantity',form('correct',allocationFields(l)+qty('Correct actual quantity')+input('verification','Correction reason','text','required')+'<button>Save correction</button>'));
 const others=(snapshot.contents||[]).filter(c=>c.cell_id===l.cell_id&&c.product_id!==l.product_id);
 return `<article class="allocation" data-line="${l.id}"><div class="work-card-heading"><span class="work-eyebrow">${esc(l.type)}</span>${badge(status(l.execution_state),l.execution_state==='settled'?'good':'')}</div><h2 class="directions">${active?'Go to ':''}${esc(l.directions?.directions||l.logical_code)}</h2><p class="cell-code">${esc(l.logical_code)}</p><p class="work-product">${esc(l.product_name)} <span>${esc(l.sku)}</span></p><div class="work-quantity"><strong>${esc(l.execution_state==='settled'?l.actual_quantity:l.planned_quantity)}</strong><span>${esc(l.unit_of_measure)}<small>${l.execution_state==='settled'?'actual recorded':active?'planned at this cell':'closed plan — do not execute'}</small></span></div>${l.attribution?`<p class="work-help">Performed by ${esc(l.attribution.performer||'Unknown')} · Entered by ${esc(l.attribution.reporter)}${l.attribution.reviewer?' · Verified by '+esc(l.attribution.reviewer):''}</p>`:''}${waiting.map(r=>`<p class="work-callout warning">Needs review: ${esc(reviewInstruction(r))}</p>`).join('')}${saved?'<p class="work-callout">Saved on this phone. Do not repeat the movement.</p>':''}${l.canAct===false?'<p class="work-callout">View only. Start the assignment if it belongs to you; another operator’s work cannot be executed here.</p>':''}${actions}${others.length?disclosure('contents-'+l.id,'Other items here',others.map(c=>`<p>${esc(c.name)} · ${esc(c.available_quantity)} ${esc(c.unit_of_measure)}</p>`).join('')):''}</article>`;
}
function assignmentActions(t){
 if(!allowed('execute'))return '';
 if(t.assignee_id!==snapshot.user.id||t.assignment_source==='self'||t.completed_at)return '';
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation);
 return `${t.assignment_state==='offered'?form('start',fields+'<button>Start task</button>'):''}${disclosure('decline-'+t.id,t.assignment_state==='offered'?'Decline task':'Stop and hand back remaining work',form('decline',fields+'<p>Send this task back for reassignment. Record any actual movement first; uncertain active work will stay in review. The deadline stays unchanged.</p><label>Reason (optional)<select name="reason"><option value="">No reason supplied</option><option>Busy with other work</option><option>Unable to do this task</option></select></label>'+input('note','Optional note')+'<button class="secondary">Send back for reassignment</button>'))}`;
}
function workReturn(){const value=new URLSearchParams(location.search).get("return_to")||"";return /^\/(products|cells)([/?#]|$)/.test(value)?value:"";}
function taskPage(id){
 const t=snapshot.tasks.find(t=>t.id===Number(id));if(!t)return '<section class="work-empty">Reconnect to open your task.</section>';
 const live=t.lines.filter(l=>!['superseded'].includes(l.execution_state));
 const ready=live.filter(l=>['ready','working'].includes(l.execution_state));
 const selected=Number(new URLSearchParams(location.search).get('line'));
 const primary=ready.find(l=>l.id===selected)||ready.find(l=>l.execution_state==='working')||ready[0];
 const closed=!t.attention&&(['completed','stopped','cancelled'].includes(t.outcome)||Boolean(t.completed_at));
 const reassignment=reassignForm(t);
 const history=t.assignment_history?.length?t.assignment_history.map(e=>{const data=JSON.parse(e.payload);return `<li>${esc(new Date(e.created_at).toLocaleString())} · ${esc(e.event_type.replaceAll('_',' '))} · ${esc(e.actor_name)}${e.assignee_name?' → '+esc(e.assignee_name):''}<p>${esc([data.reason,data.note,data.dueAt?'Due '+new Date(data.dueAt).toLocaleString():'',data.remaining!=null?'Remaining requested '+data.remaining:''].filter(Boolean).join(' · '))}</p></li>`;}).join(''):'<li>Assignment history unavailable for this legacy task.</li>';
 return `<section class="work-intro"><a href="${esc(workReturn()||'/work')}">← ${workReturn()?'Back to stock':'My work'}</a><h2>${esc(taskName(t))}</h2><p><strong>${esc(outcome(t))}</strong>${closed?'':' · '+esc(dueText(t))}</p>${closed?'<p><a class="work-primary" href="/work">Back to My work</a></p>':''}<p>Recorded ${esc(t.recorded_quantity)} · Remaining requested ${esc(t.remaining_quantity)} ${esc(t.lines[0]?.unit_of_measure)}</p>${t.instruction_note?`<p>${esc(t.instruction_note)}</p>`:''}</section>${assignmentActions(t)}${primary?lineCard(primary):''}${ready.length>1?disclosure('other-locations','Other locations',ready.filter(l=>l!==primary).map(l=>`<a class="work-secondary" href="/tasks/${t.id}?line=${l.id}">${esc(l.directions?.name||l.logical_code)} · ${esc(l.planned_quantity)} ${esc(l.unit_of_measure)}</a>`).join(''),true):''}${live.some(l=>!['ready','working'].includes(l.execution_state))?disclosure('recorded-locations','Recorded / closed locations',live.filter(l=>!['ready','working'].includes(l.execution_state)).map(lineCard).join(''),!primary):''}${!t.completed_at&&(t.canAct||allowed('teamStop'))?disclosure('stop-task','Stop remaining work',form('stop',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+`<p>Stops untouched locations: ${esc(ready.filter(l=>l.execution_state==='ready').map(l=>l.logical_code).join(', ')||'none')}. A supervisor must check locations already started or awaiting a quantity check. Recorded movements stay in history.</p><label class="work-check"><input type="checkbox" required>I want to stop the remaining work.</label><button class="secondary">Stop remaining work</button>`)):''}${reassignment?disclosure('detail-reassign','Reassign remaining work',reassignment):''}${disclosure('task-history','Task details and assignment history',`<p>Original deadline: ${t.due_at?esc(new Date(t.due_at).toLocaleString([], {timeZone:snapshot.timing?.timezone})):'No deadline'}</p><p>Created by ${esc(t.created_by_name)} · Assigned to ${esc(t.assignee_name||'Needs assignment')} · Assigned by ${esc(t.assigned_by_name||'History unavailable')}</p><ol>${history}</ol>`)}${t.lines.some(l=>l.execution_state==='superseded')?disclosure('old-plans','Earlier plans — do not execute',t.lines.filter(l=>l.execution_state==='superseded').map(lineCard).join('')):''}`;
}
function pageLinks(info,key='page') {
 if(!info)return '';const q=new URLSearchParams(location.search),url=n=>{const v=new URLSearchParams(q);v.set(key,n);return path+'?'+v;};
 return `<nav class="work-pagination" aria-label="${key==='page'?'Task':'Review'} pages"><span>${info.total} matching · Page ${info.number} of ${info.pages} · Up to 100 rows</span>${info.number>1?`<a href="${esc(url(info.number-1))}">Previous page</a>`:''}${info.number<info.pages?`<a href="${esc(url(info.number+1))}">Next page / older records</a>`:''}</nav>`;
}
function operatorPicker(t){const eligible=(snapshot.operators||[]).filter(u=>u.eligible);return input('operatorSearch','Find eligible operator','search','data-operator-search autocomplete="off"')+`<label>Assign to<select name="assigneeId" required><option value="">Choose operator</option>${options(eligible,'id',u=>`${u.name} · ${u.username} · ${u.open||0} open`)}</select></label>`;}
function reassignForm(t){return !allowed('assign')||t.attention||(t.completed_at&&t.outcome!=='stopped')||['completed','cancelled'].includes(t.outcome)?'':form('reassign',hidden('taskId',t.id)+hidden('generation',t.assignment_generation)+operatorPicker(t)+input('reason','Assignment note (optional)')+'<button>Save</button>');}
function taskRow(t){
 const mine=t.assignee_id===snapshot.user.id,closed=['completed','stopped','cancelled'].includes(t.outcome)||t.completed_at;
 const untouched=(t.lines||[]).every(l=>['ready','cancelled','superseded'].includes(l.execution_state)&&!l.started_at&&!l.reports?.length);
 const saved=outbox.some(o=>o.partition===key()&&['local','sending','error','rejected'].includes(o.state)&&(Number(o.input.taskId)===t.id||(t.lines||[]).some(l=>l.id===Number(o.input.lineId))));
 const reasons=[...new Set((t.lines||[]).flatMap(l=>(l.reports||[]).filter(r=>['received','review'].includes(r.status)).map(r=>r.quantity_known===0?'Quantity not confirmed':r.reason)))];
 const label=t.attention?'Waiting for supervisor — '+(reasons[0]||'reported quantity needs checking'):outcome(t);
 const actualPeople=[...new Set((t.lines||[]).filter(l=>l.attribution).map(l=>l.attribution.performer||'Unknown'))];
 const reporters=[...new Set((t.lines||[]).filter(l=>l.attribution).map(l=>l.attribution.reporter||'Unknown'))];
 const fields=hidden('taskId',t.id)+hidden('generation',t.assignment_generation);
 const stop=mine&&!closed&&!saved&&allowed('stop')?(untouched&&t.assignment_source==='self'?form('stop',fields+'<button class="secondary">Cancel task</button>'):disclosure('row-stop-'+t.id,'Stop remaining work',form('stop',fields+'<p>Recorded quantities stay. Untouched work can stop; uncertain physical work stays in review.</p><button class="secondary">Stop remaining work</button>'))):'';
 const assignment=reassignForm(t);
 const reassignment=!assignment?'':t.outcome==='needs_assignment'?assignment:!closed?disclosure('row-reassign-'+t.id,'Reassign remaining work',assignment):'';
 const next=closed?'View result':saved?'Check saved update':t.attention?'View quantity check':t.outcome==='needs_assignment'&&allowed('assign')?'Assign task':mine&&t.assignment_state!=='offered'?'Continue task':'Open task';
 return `<tr data-task-row="${t.id}"><th scope="row"><a href="/tasks/${t.id}">${esc(taskName(t))}</a><small>${esc(t.type)} · ${esc(t.lines?.[0]?.sku||'')} · Task #${t.id}</small><div class="task-primary-actions">${mine&&!closed&&t.assignment_state==='offered'&&allowed('execute')?'':`<a class="work-secondary" href="/tasks/${t.id}">${next}</a>`}${assignmentActions(t)}${stop}${saved?'<p>Saved request awaiting confirmation.</p>':''}</div></th><td>${esc(t.remaining_quantity??t.requested_quantity??'—')} ${esc(t.lines?.[0]?.unit_of_measure)}<small>${esc(t.requested_quantity??'—')} requested</small></td><td>${badge(label,t.attention||t.overdue?'warning':t.outcome==='completed'?'good':'')}<small>${esc(dueText(t))}</small></td><td>${esc(t.recorded_quantity??0)} recorded<small>${(t.lines||[]).filter(l=>l.execution_state==='settled').length} locations recorded</small></td><td>Assigned to <strong>${esc(t.assignee_name||'Needs assignment')}${t.assignee_username?' · '+esc(t.assignee_username):''}</strong>${t.assignment_state==='returned'?`<small>Last assigned: ${esc(t.assignment_history?.filter(e=>e.event_type==='returned').at(-1)?.previous_name||'See history')}</small>`:''}<small>Performed by ${esc(actualPeople.join(', ')||'Not recorded')}</small><small>Entered by ${esc(reporters.join(', ')||'Not recorded')}</small></td><td>${t.assigned_at?esc(new Date(t.assigned_at).toLocaleString()):'Not assigned'}<small>Assigned by ${esc(t.assigned_by_name||'—')}</small></td><td class="task-row-actions"><a href="/tasks/${t.id}">Details</a>${reassignment}${!closed&&allowed('deadline')?disclosure('deadline-'+t.id,'Change deadline',form('deadline',fields+input('dueAt','New due time (blank disables deadline)','datetime-local')+input('reason','Reason','text','required')+'<button>Save deadline</button>')):''}</td></tr>`;
}
function taskCards(tasks){return `<div class="work-table-wrap" tabindex="0" role="region" aria-label="Task table; scroll horizontally for actions"><table class="work-task-table"><thead><tr><th scope="col">Task / product</th><th scope="col">Remaining</th><th scope="col">Status / due</th><th scope="col">Progress</th><th scope="col">People</th><th scope="col">Assigned</th><th scope="col">Actions</th></tr></thead><tbody data-task-table>${tasks.map(taskRow).join('')||'<tr><td colspan="7">No matching tasks.</td></tr>'}</tbody></table></div>`;}
function home(){
 const mine=snapshot.tasks.filter(t=>t.assignee_id===snapshot.user.id||t.assignee_id==null&&t.created_by===snapshot.user.id||t.created_by===undefined);
 const closed=t=>!t.attention&&(['completed','stopped','cancelled'].includes(t.outcome)||['completed','cancelled'].includes(t.status));
 const active=mine.filter(t=>!closed(t)&&!t.attention&&t.assignment_state!=='returned');
 const review=mine.filter(t=>t.attention&&t.assignment_state!=='returned');
 const history=mine.filter(t=>closed(t)||t.assignment_state==='returned');
 return `<section class="work-intro"><h2>What’s your next move?</h2><div class="work-actions">${allowed('pick')?'<a class="work-primary" href="/pick">Pick stock</a>':''}${allowed('put')?'<a class="work-secondary" href="/put">Put stock</a>':''}</div></section><h3>Continue working · ${snapshot.taskCounts?.active??active.length+review.length}</h3>${taskCards([...active,...review])}${pageLinks(snapshot.taskPage)}${history.length?disclosure('completed-work','Recent work and returned assignments',taskCards(history)):''}<p><a href="/work/history">Completed, cancelled and returned work / older history</a></p>${allowed('report')?'<p><a href="/record-movement">Record work already done</a></p>':''}`;
}
function matchingProducts(query,selected){const term=String(query||'').trim().toLowerCase();return (snapshot.products||[]).filter(p=>String(p.id)===String(selected)||!term||`${p.name} ${p.sku}`.toLowerCase().includes(term));}
function productPicker(selected=''){return input('productSearch','Find product by name or code','search','data-product-search autocomplete="off"')+`<label>Product<select name="productId" required><option value="">Choose a product</option>${options(snapshot.products,'id',p=>`${p.name} · ${p.sku} (${p.unit_of_measure})`,selected)}</select></label><p class="work-help" data-product-unit aria-live="polite"></p>`;}
function updateProductPicker(f){
 const select=f.elements.productId,search=f.elements.productSearch;if(!select||!search)return;
 const chosen=select.value,query=search.value,products=matchingProducts(query,chosen);
 select.innerHTML='<option value="">Choose a product</option>'+options(products,'id',p=>`${p.name} · ${p.sku} (${p.unit_of_measure})`,chosen);select.value=chosen;
 const product=snapshot.products.find(p=>String(p.id)===chosen),unit=f.elements.unit?.value?.trim()||product?.unit_of_measure;
 f.querySelector('[data-product-unit]').textContent=(product?`Selected: ${product.name}. Quantity unit: ${unit}. `:'Choose a product to see its quantity unit. ')+(query?`${products.filter(p=>`${p.name} ${p.sku}`.toLowerCase().includes(query.trim().toLowerCase())).length} matching products. Your selection stays until you change it.`:'');
}
function recoveryHref(direction,f=null){const params=new URLSearchParams(location.search),q=new URLSearchParams();for(const name of ['product_id','cell_id','quantity','return_to'])if(params.has(name))q.set(name,params.get(name));if(f)for(const [name,field] of [['product_id','productId'],['cell_id','preferredCellId'],['quantity','quantity']]){const value=f.elements[field]?.value;if(value)q.set(name,value);else q.delete(name);}q.set('direction',direction);return '/record-movement?'+q;}
function updateRecoveryLink(f){const link=root.querySelector('[data-recovery-link]');if(link&&f.dataset.workAction==='create')link.setAttribute('href',recoveryHref(f.elements.direction.value,f));}
function draftContext(f){if(!['create','manual'].includes(f.dataset.workAction))return '';const params=new URLSearchParams(location.search),context=new URLSearchParams();for(const name of ['product_id','cell_id','quantity','return_to','direction'])if(params.has(name))context.set(name,params.get(name));return context.size?':context:'+context:'';}
function createPage(direction){
 if(!online)return manualPage(direction);
 const params=new URLSearchParams(location.search);
 const pending=outbox.some(o=>o.partition===key()&&o.action==='create'&&['local','error','sending'].includes(o.state));
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
function teamPage(){
 if(!allowed('teamView'))return home();
 const q=new URLSearchParams(location.search),filter=q.get('state')||'open';
 const eligible=(snapshot.operators||[]).filter(u=>u.eligible);
 const userSelect=()=>operatorPicker({});
 const assign=form('create','<label>Action<select name="direction"><option value="pick">Pick</option><option value="put">Put</option></select></label>'+productPicker()+qty('Requested quantity')+userSelect()+`<p>${snapshot.timing?.enabled?`Expected completion ${esc(new Date(Date.parse(snapshot.generatedAt)+snapshot.timing.minutes*60000).toLocaleString([], {timeZone:snapshot.timing.timezone}))} (${esc(snapshot.timing.minutes)} minutes from assignment)`:'New assignments have no deadline.'}</p>`+disclosure('assignment-options','More options',input('dueAt','Due time override (your device timezone)','datetime-local')+input('note','Instructions / note'))+'<button>Assign task</button>');
 return `${allowed('assign')?disclosure('assign-task','Assign task',assign):''}<nav class="work-actions task-tabs" aria-label="Team task status"><a href="/work/overview">Active · ${snapshot.taskCounts?.active??0}</a><a href="/work/overview?state=needs_assignment">Needs assignment · ${snapshot.taskCounts?.needsAssignment??0}</a><a href="/work/overview?state=overdue">Overdue · ${snapshot.taskCounts?.overdue??0}</a><a href="/work/overview?state=closed">History</a></nav>${disclosure('team-filters','Filters · '+esc([filter.replaceAll('_',' '),snapshot.operators?.find(u=>String(u.id)===q.get('operator'))?.name,q.get('action')].filter(Boolean).join(' · ')),`<form method="get" class="team-filters"><label>Operator<select name="operator"><option value="">All operators</option>${options(snapshot.operators||[],'id',u=>u.name+' · '+u.username,q.get('operator'))}</select></label><label>State<select name="state">${['open','all','closed','needs_assignment','needs_review','overdue','completed','stopped','cancelled'].map(v=>`<option value="${v}" ${filter===v?'selected':''}>${esc(v.replaceAll('_',' '))}</option>`).join('')}</select></label><label>Action<select name="action"><option value="">Pick and Put</option>${['pick','put'].map(v=>`<option ${q.get('action')===v?'selected':''}>${v}</option>`).join('')}</select></label><button>Filter tasks</button></form>`)}${pageLinks(snapshot.taskPage)}${taskCards(snapshot.tasks)}${pageLinks(snapshot.taskPage)}${allowed('timing')?'<p><a href="/work/timing">Timing settings</a></p>':''}${disclosure('workloads','Workloads by person',`<p>Counts cover all active work, including other pages.</p>${(snapshot.operators||[]).map(u=>`<p><a href="/work/overview?operator=${u.id}">${esc(u.name)} · ${esc(u.username)}</a>: ${u.open||0} open · ${u.inProgress||0} in progress · ${u.overdue||0} overdue · ${u.review||0} review ${u.eligible?'':'· Ineligible for new work'}</p>`).join('')}`)}`;
}
function timingPage(){
 if(!allowed('timing'))return home();const t=snapshot.timing;
 return `<section class="work-intro"><a href="/work/overview">← Team work</a><h2>Work timing</h2><p>Warehouse timezone: ${esc(t.timezone)}. Deadlines use elapsed time, including nights.</p></section><section class="work-panel narrow">${form('timing',`<label>Unfinished assignment warning<select name="enabled"><option value="true" ${t.enabled?'selected':''}>Enabled for new tasks</option><option value="false" ${!t.enabled?'selected':''}>Disabled for new tasks</option></select></label>`+input('minutes','Highlight unfinished tasks after','number',`min="1" max="525600" required value="${t.minutes}"`)+hidden('timeUnit','minutes')+'<p>Duration in minutes. Example: 120 minutes = 2 hours. Saving changes new assignments only; existing deadlines stay unchanged. Overdue never cancels or releases stock.</p>'+input('inactivityMinutes','Inactive work review (minutes)','number',`min="1" max="1440" required value="${t.inactivityMinutes}"`)+'<p>Inactivity sends missing confirmations for review. It does not prove that nothing moved.</p><button>Save timing rules</button>')}</section>`;
}
function countSequence(c,r){const line=c?.lines?.find(l=>l.productId===r.product_id);if(!line)return 'Choose the count to compare its recorded and counted quantities with this movement.';return `A stock count changed ${c.logical_code} from ${line.recorded} to ${line.actual} ${line.unit}. You are now confirming a ${r.direction} of ${r.quantity_known===0?'an unknown quantity':r.quantity+' '+r.unit}. Were these the same items? Counted by ${c.counter_name||'Unknown'} at ${new Date(c.counted_at||c.received_at).toLocaleString()}. Matching quantities alone do not prove this.`;}
function countOptions(r){
 const candidate=r.countEvidence,action=r.direction==='put'?'put':'pick';
 return disclosure('count-check-'+r.id,r.countOverlap?'Was this movement already included in the stock count?':'More options: check an earlier stock count',`<p data-count-sequence>${esc(countSequence(candidate,r))}</p>${input('countSearch','Find count by date, person or name','search','data-count-search')}<button type="button" class="secondary" data-search-counts>Find relevant counts</button><p data-count-results role="status"></p><label>Compare this count<select name="countCorrectionId"><option value="">Choose a count</option>${candidate?options([candidate],'id',c=>c.title+' · '+c.logical_code+' · '+new Date(c.counted_at||c.received_at).toLocaleString()):''}</select></label><label class="work-check"><input type="radio" name="countChoice" value="included">Already included in this count — stock will not change again</label><label class="work-check"><input type="radio" name="countChoice" value="separate">This was a separate ${action} after the count</label><p>Choose only after checking the physical evidence. If unsure, use “I’m not sure — keep pending” below.</p>`,Boolean(r.countOverlap));
}
function pendingPage(){
 const q=new URLSearchParams(location.search),personFilter=(name,label)=>input(name+'Search','Find '+label.toLowerCase(),'search',`data-people-search="${name}" autocomplete="off"`)+`<label>${label}<select name="${name}"><option value="">Everyone</option><option value="unknown" ${q.get(name)==='unknown'?'selected':''}>Unknown / unassigned</option>${options(snapshot.performers||[],'id',p=>p.name+' · '+p.username+(p.status==='active'?'':' (inactive)'),q.get(name))}</select></label>`;
 let previousGroup;
 return `${discrepancyCards()}<section class="review-intro"><p>Check what physically moved before changing stock.</p><p>${snapshot.reviewPage?.total??snapshot.pending.length} matching cases out of ${snapshot.reviewTotal??snapshot.pending.length} overall.</p></section>${disclosure('review-filters','Filter people / grouping'+(q.get('assigned')||q.get('performed')||q.get('group')?' · active':''),`<form method="get" class="team-filters review-filters">${personFilter('assigned','Assigned to')}${personFilter('performed','Performed by')}<label>Group cases<select name="group"><option value="">No grouping</option><option value="assigned" ${q.get('group')==='assigned'?'selected':''}>Assigned to</option><option value="performed" ${q.get('group')==='performed'?'selected':''}>Performed by</option></select></label><button>Filter review cases</button></form>`)}${pageLinks(snapshot.reviewPage,'reviewPage')}${snapshot.pending.map(r=>{
 const fields=hidden('reportId',r.id)+hidden('caseRevision',r.case_revision);
 const matches=(snapshot.postedReports||[]).filter(p=>p.product_id===r.product_id&&p.cell_id===r.cell_id&&p.direction===r.direction);
 const quick=[...new Set([0,1,r.planned_quantity].filter(n=>n!=null&&n>=0))];
 const groupId=q.get('group')==='assigned'?r.assignee_id:r.performer_id,groupName=q.get('group')==='assigned'?(r.assignee_name||'Unassigned'):(r.operator_name||'Unknown'),group=q.get('group')&&groupId!==previousGroup?`<h3>${esc(groupName)} · ${snapshot.reviewGroups?.find(g=>g.person===groupId)?.total??''} cases</h3>`:'';previousGroup=groupId;
 const shortReason=r.quantity_known===0?'Quantity not confirmed':r.countOverlap?'Stock was counted before this entry arrived':'Entered quantity needs checking';
 return group+disclosure('case-'+r.id,`<span>${esc(r.product_name)} · ${esc(r.logical_code)} · ${esc(r.direction)} — ${esc(shortReason)}</span><span class="review-people">Assigned to <strong>${esc(r.assignee_name||'Unassigned')}${r.assignee_username?' · '+esc(r.assignee_username):''}</strong> · Performed by <strong>${esc(r.operator_name||'Unknown')}${r.performer_username?' · '+esc(r.performer_username):''}</strong> · Entered by <strong>${esc(r.reporter_name)}${r.reporter_username?' · '+esc(r.reporter_username):''}</strong></span><small>Next: verify actual quantity and save, or keep pending if it cannot be established.</small>`,`<p class="work-callout">${esc(reviewInstruction(r))}</p><p>Assigned to ${esc(r.assignee_name||'Unassigned')} · Performed by ${esc(r.operator_name||'Unknown')} · Entered by ${esc(r.reporter_name)}</p><p>Received ${esc(new Date(r.created_at).toLocaleString())} · ${Math.max(0,Math.floor((Date.parse(snapshot.generatedAt)-Date.parse(r.created_at))/60000))} min ago</p><p>Planned: ${esc(r.planned_quantity??'—')} ${esc(r.unit)} · Entered: <strong>${r.quantity_known===0?'unknown':esc(r.quantity)+' '+esc(r.unit)}</strong></p>${r.task_id?`<a href="/tasks/${r.task_id}">Open task</a>`:''}${form('resolve',fields+qty(`Verified actual quantity (${r.unit})`)+`<div class="quantity-shortcuts">${quick.map(n=>`<button type="button" class="secondary" data-quantity="${n}">${n}</button>`).join('')}</div>`+performerField(r.performer_id)+`<label>How was this verified?<select name="verification" required><option value="">Choose method</option><option>Spoke with operator</option><option>Checked movement slip</option><option>Observed movement</option><option>Other evidence (describe below)</option></select></label>`+input('verificationNote','Verification details / handover evidence')+countOptions(r)+accountingFields(r)+(r.line_id&&allowed('resolveStop')?'<label class="work-check"><input type="checkbox" name="stopRemaining">Resolve and stop remaining work. I confirmed the original worker has stopped. Other recorded cells remain unchanged.</label>':'')+'<button>Record verified quantity</button>')}${form('resolve',fields+hidden('keepOpen','true')+input('verification','Optional note')+'<button class="secondary">I’m not sure — keep pending</button>')}${disclosure('more-'+r.id,'More options',disclosure('link-'+r.id,`Has this ${r.direction==='put'?'put':'pick'} already been saved?`,`<p>Check the saved item, location, quantity, time and person. Use the matching entry only if it is the same physical work. Stock will not change again; any active allocation closes only when you explicitly confirm it.</p>`+form('resolve',fields+hidden('dismissDuplicate','true')+input('movementSearch','Search reference, person or date (YYYY-MM-DD)','search','data-movement-search')+'<button type="button" class="secondary" data-search-history>Search full movement history</button><p data-search-result role="status"></p>'+`<label>Matching saved entry<select name="duplicateOf" required><option value="">Choose a movement</option>${options(matches,'id',m=>`${m.product_name||r.product_name} · ${m.logical_code||r.logical_code} · ${m.quantity} ${m.unit} · ${new Date(m.created_at).toLocaleString()} · ${m.performer_name||'Unknown'}`)}</select></label><button type="button" class="secondary" data-view-saved>View saved entry</button><p data-saved-entry role="status"></p>`+(['ready','working'].includes(r.execution_state)?'<label class="work-check"><input type="checkbox" name="closeAllocation" required>This saved movement covers all work at this location. Close the remaining instructions.</label>':'')+input('verification','How did you verify this match?','text','required')+'<button class="secondary">Use this saved entry</button>')))}${disclosure('technical-'+r.id,'Entry details',`<p>Reference ${esc(r.origin_ref)}</p><p>${esc(r.reason)}<br>${esc(JSON.parse(r.payload||'{}').reason||'')}</p>`)}`,false,'work-panel review-case');
 }).join('')||'<p>No work needs review.</p>'}${pageLinks(snapshot.reviewPage,'reviewPage')}`;
}
function labelsPage(){const params=new URLSearchParams(location.search);const ids=params.has('cells')?params.get('cells').split(',').map(Number):null, cells=ids?snapshot.cells.filter(c=>ids.includes(c.id)):snapshot.cells;return `<section class="work-intro"><h2>Location labels</h2><p>${ids?'Selected':'All permitted'} locations · ${cells.length} labels. QR labels identify a location; they do not confirm quantity.</p><button type="button" data-print>Print these labels</button></section><div class="label-grid">${cells.map(c=>`<article class="print-label"><img src="/labels/${c.id}.svg" alt="QR code for ${esc(c.logical_code)}"><h2>${esc(c.display_name||c.logical_code)}</h2><p>${esc(c.logical_code)} · label revision ${c.label_revision}</p><a href="/cells/${c.id}">Location settings</a></article>`).join('')}</div>`;}

function ledger(){return `<section class="work-intro"><h2>Posted stock movements</h2><p>Signed quantities reflect the ledger, including corrections. Historical units remain visible.</p></section><div class="work-table-wrap"><table><thead><tr><th>When</th><th>Product / cell</th><th>Change</th><th>People / reference</th></tr></thead><tbody>${(snapshot.ledger||[]).map(r=>`<tr><td>${esc(new Date(r.created_at).toLocaleString())}</td><td>${esc(r.product_name)}<br>${esc(r.logical_code)}</td><td>${r.quantity_delta>0?'+':''}${esc(r.quantity_delta)} ${esc(r.unit_of_measure)}<br>${esc(r.type)}</td><td>${esc(r.performer_name||'Performer not attributed')}<br>Recorded by ${esc(r.reporter_name)}<br>${esc(r.origin_ref||r.reason)}</td></tr>`).join('')}</tbody></table></div>`;}
function savedAction(o){
 if(o.label)return o.label;const i=o.input||{},t=snapshot.tasks?.find(t=>t.id===Number(i.taskId)||t.lines?.some(l=>l.id===Number(i.lineId))),p=snapshot.products?.find(p=>p.id===Number(i.productId));
 const names={decline:'Return assigned task',stop:'Cancel / stop remaining task',cancel:'Cancel location work',reassign:'Assign task',deadline:'Change task deadline',start:'Start task',correct:'Correct earlier quantity',askReview:'Ask supervisor to check actual quantity',resolve:'Save supervisor check',timing:'Change work timing',mode:'Change location guidance'};
 if(names[o.action])return names[o.action]+(t?' · '+t.summary:'');
 const direction=i.direction||t?.type;if(direction==='pick'||direction==='put')return `${direction==='pick'?'Pick':'Put'} ${i.quantity??'quantity'} ${i.unit||p?.unit_of_measure||t?.lines?.[0]?.unit_of_measure||''}${p?' · '+p.name:''}`;
 return t?.summary||'Save warehouse update';
}
function queueEntry(o){
 const physical=['report','manual','correct','askReview'].includes(o.action),waiting=['local','sending','error'].includes(o.state);
 const label=o.state==='review'?(physical?'Quantity needs supervisor check':'Received — needs supervisor check'):o.state==='rejected'?'Entry could not be accepted':o.state==='not-applied'?'Change could not be saved':waiting?'Waiting for warehouse confirmation':status(o.state);
 const next=o.state==='review'?'Received by the warehouse. Ask a supervisor to check the actual quantity; do not repeat the movement.':waiting?'Saved on this device; the warehouse has not confirmed it yet. Reconnect and send saved updates. Do not repeat the movement.':o.state==='rejected'?'Keep this evidence and ask a supervisor to check it. Do not repeat the movement.':o.state==='not-applied'?'Check the reason, refresh the task, and retry the intended change only if still needed.':'Saved by the warehouse.';
 return `<article><strong>${esc(savedAction(o))} — ${esc(label)}</strong><p>${esc(next)}</p>${o.message&&!waiting?disclosure('update-detail-'+o.id,'Original details',`<p>${esc(o.message)}</p>`):''}${o.state==='not-applied'?`<button type="button" class="secondary" data-ack-request="${esc(o.id)}">Dismiss this failed request</button>`:''}</article>`;
}
function render(){
 const disclosures=new Map([...root.querySelectorAll('details[data-disclosure]')].map(d=>[d.dataset.disclosure,d.open]));
 dirty=false;
 if(!snapshot){root.innerHTML='<section class="work-empty"><h2>No saved work on this device</h2><p>Connect to the warehouse and sign in to save your allocations.</p><a href="/login">Sign in</a></section>';return;}

 const queued=outbox.filter(o=>o.partition===key()&&!['recorded','duplicate','reserved','ready','verified','busy','acknowledged'].includes(o.state));
 const body=path==='/work/overview'?teamPage():path==='/work/timing'?timingPage():path==='/work/history'?`<h2>Task history</h2><p><a href="/work/history">All personal history</a> · <a href="/work/history?state=closed">Completed and cancelled</a></p><p><a href="/movement-history">Stock movements</a> are separate records.</p>${pageLinks(snapshot.taskPage)}${taskCards(snapshot.tasks)}${pageLinks(snapshot.taskPage)}`:path==='/pick'?createPage('pick'):path==='/put'?createPage('put'):path==='/record-movement'?manualPage():path==='/pending-confirmations'?pendingPage():path==='/labels'?labelsPage():path==='/movement-history'?ledger():/^\/tasks\/\d+$/.test(path)?taskPage(path.split('/')[2]):home();
 root.innerHTML=`<nav class="work-views" aria-label="Work views"><a href="/work">My work</a>${allowed('teamView')?'<a href="/work/overview">Team work</a>':''}${allowed('review')?`<a href="/pending-confirmations">Needs review · ${snapshot.reviewTotal??snapshot.pending.length}</a>`:''}<a href="/work/history">History</a></nav><div class="work-toolbar"><div class="work-tools">${!online?'<a href="/work">My work</a><a href="/pick">Pick</a><a href="/put">Put</a>':''}${disclosure('work-tools','Work tools',`<div class="work-tools-links"><a href="/record-movement">Record completed movement</a><a href="/movement-history">Movement history</a><a href="/">Warehouse overview</a><a href="/recommended-actions">Space suggestions</a><a href="/stocktaking">Stocktaking</a><a href="/labels">Location labels</a>${allowed('review')?'<a href="/pending-confirmations">Needs review</a>':''}</div>`,false,'work-tools-details')}</div><div class="work-connection">${badge(online?'Connected to warehouse':'Offline · saved work',online?'good':'warning')}<small>Updated ${esc(new Date(snapshot.generatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</small></div></div><div id="work-notice" role="status" aria-live="polite">${notice?`<p class="work-callout">${esc(workText(notice))}</p>`:''}</div>${!online?'<p class="work-callout warning">Offline: saved work and physical entries stay on this device. No new reservation or location turn is granted. Follow the warehouse manual procedure; use paper if needed.</p>':''}${queued.length?`<section class="work-queue"><h3>Updates needing attention · ${queued.length}</h3>${queued.map(queueEntry).join('')}<button type="button" class="secondary" data-retry>Send saved updates / refresh</button></section>`:''}${body}<footer class="work-footer" id="device-help">${disclosure('device-recovery','Saved updates & device help','<p>Saved work stays on this device. Use your own device account. Send all updates before handing it over.</p><div class="work-tools-links"><button type="button" class="text-button" data-export>Download saved updates</button><button type="button" class="text-button" data-forget>Clear local data (only after updates are received)</button></div>')}</footer>`;
 for(const link of root.querySelectorAll('a[href]')){const href=(link.getAttribute?.('href')||'').split('?')[0];const cap={'/pick':'pick','/put':'put','/record-movement':'report','/work/overview':'teamView','/pending-confirmations':'review','/work/timing':'timing','/labels':'labels'}[href];if(cap&&!allowed(cap))link.remove();}
 restoreDrafts();
 for(const f of root.querySelectorAll('form[data-work-action]')){updateProductPicker(f);updateRecoveryLink(f);}
 if(typeof location!=='undefined'&&new URLSearchParams(location.search).has('device_help'))root.querySelector('[data-disclosure="device-recovery"]')?.setAttribute('open','');
 for(const d of root.querySelectorAll('details[data-disclosure]'))if(disclosures.has(d.dataset.disclosure))d.open=disclosures.get(d.dataset.disclosure);

}
function draftKey(f){return `${key()}:draft:${path}:${f.dataset.workAction}:${f.dataset.draftKind||'normal'}:${f.elements.lineId?.value||f.elements.reportId?.value||f.elements.taskId?.value||''}:${f.elements.revision?.value||f.elements.caseRevision?.value||f.elements.generation?.value||''}${draftContext(f)}`;}
function restoreDrafts(){for(const f of root.querySelectorAll('form[data-work-action]')){const values=drafts.get(draftKey(f));if(values)for(const el of f.elements)if(el.name in values&&el.type!=='hidden'){if(el.type==='radio')el.checked=el.value===values[el.name].value;else{el.value=values[el.name].value;if(el.type==='checkbox')el.checked=values[el.name].checked;}}}}
let syncing=false;
let syncDone=Promise.resolve();
async function sync(){
 if(!snapshot)return;if(syncing){await syncDone;return sync();}syncing=true;
 let finishSync;syncDone=new Promise(resolve=>{finishSync=resolve;});
 try{
  await refresh();
  outbox=await all('outbox');
  for(const o of outbox.filter(o=>o.partition===key()&&['local','sending','error'].includes(o.state))){
   // The frozen request is retried byte-for-byte under its original user/site identity.
   const r=await fetch('/api/work/'+o.action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(o.input)});
   const result=await r.json();
   if(!r.ok){o.state=r.status===400?(['report','manual','correct'].includes(o.action)?'rejected':'not-applied'):'error';o.message=result.error||'Not received. Keep this entry and contact your supervisor.';notice=o.message;}
   else{o.state=result.status;o.message=result.message;o.result=result;notice=result.message;}
   await store('outbox','readwrite',s=>s.put(o));
  }
  await refresh();outbox=await all('outbox');
 }catch(e){online=false;notice=e instanceof TypeError?'Connection unavailable. Updates remain saved on this device.':e.message||'Connection unavailable. Updates remain saved on this device.';}
 finally{syncing=false;finishSync();}
}
async function saveDraft(f){
 const values={};for(const el of f.elements)if(el.name&&el.type!=='hidden'&&el.type!=='submit'&&(el.type!=='radio'||el.checked))values[el.name]={value:el.value,checked:el.checked};
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
root.addEventListener('invalid',e=>{for(let p=e.target.parentElement;p&&p!==root;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;},true);
root.addEventListener('input',e=>{
 dirty=true;const f=e.target.closest('form');if(f)f.dataset.edited='true';if(f?.dataset.workAction)saveDraft(f).catch(()=>{notice='Draft not saved: device storage failed. Use the manual recording procedure.';document.querySelector('#work-notice').textContent=workText(notice);});
 if(f)updateRecoveryLink(f);
 if(f&&e.target.matches('[data-product-search]'))updateProductPicker(f);
 if(f&&e.target.name==='unit')updateProductPicker(f);
 const search=e.target.matches('[data-operator-search]')?'assigneeId':e.target.matches('[data-movement-search]')?'duplicateOf':e.target.matches('[data-count-search]')?'countCorrectionId':e.target.matches('[data-people-search]')?e.target.dataset.peopleSearch:null;
 if(search&&f?.elements[search])for(const option of f.elements[search].options)option.hidden=Boolean(option.value)&&!option.textContent.toLowerCase().includes(e.target.value.toLowerCase());
});
root.addEventListener('change',e=>{const changedForm=e.target.closest('form');if(changedForm)updateRecoveryLink(changedForm);if(e.target.name==='productId')updateProductPicker(e.target.closest('form'));if(e.target.name==='countCorrectionId'){const f=e.target.closest('form'),r=snapshot.pending.find(r=>r.id===f.elements.reportId?.value),candidate=(f._countCandidates||[r?.countEvidence]).find(c=>c&&String(c.id)===e.target.value);if(r)f.querySelector('[data-count-sequence]').textContent=countSequence(candidate,r);}dirty=true;const f=e.target.closest('form');if(f)f.dataset.edited='true';if(f?.dataset.workAction)saveDraft(f).catch(()=>{});});
let submitting=false;
root.addEventListener('submit',async e=>{
 const f=e.target.closest('form[data-work-action]');if(!f)return;e.preventDefault();if(submitting)return;submitting=true;
 const button=f.querySelector('button:not([type="button"])');button.disabled=true;
 const feedback=f.querySelector('.form-feedback'),action=f.dataset.workAction;
 try{
  await saveDraft(f);
  outbox=await all('outbox');
  const values=Object.fromEntries(new FormData(f));
  for(const n of ['manual','keepOpen','dismissDuplicate','closeAllocation','zeroConfirmed','afterCountVerified','stopRemaining','enabled'])if(n in values)values[n]=values[n]==='on'||values[n]==='true';
  if(action==='report'&&!online)values.manual=true;
  if(values.occurredAt)values.occurredAt=new Date(values.occurredAt).toISOString();
  if(values.dueAt)values.dueAt=new Date(values.dueAt).toISOString();
  if(values.countChoice==='included'&&!values.countCorrectionId)throw new Error('Choose the stock count that already includes these items.');
  if(values.countChoice==='separate'){values.afterCountVerified=true;delete values.countCorrectionId;}
  if(values.countCorrectionId&&values.countChoice!=='included')throw new Error('Confirm whether these items were already included or were a separate movement.');
  if(values.verificationNote){values.verification=`${values.verification}: ${values.verificationNote}`;}
  if(values.verification==='Other evidence (describe below)')throw new Error('Describe the verification evidence.');
  if(values.note&&action==='decline')values.reason=[values.reason,values.note].filter(Boolean).join(' — ');
  if(action==='manual'&&!values.unit?.trim())values.unit=snapshot.products.find(p=>p.id===Number(values.productId))?.unit_of_measure;
  if(action==='acquire'){
   if(!online)throw new Error('Reconnect to request a turn. You may still report physical work already done.');
   f._input||={...values,requestId:uid()};const result=await immediate(action,f._input);notice=result.message;
   await refresh();render();if(result.status==='ready')void scanQR(findLine(values.lineId));
  }else{
   if(!online&&!['report','manual','decline','cancel','stop','askReview'].includes(action))throw new Error('Reconnect before changing plans or resolving work.');
   if(['report','cancel'].includes(action)&&outbox.some(o=>o.partition===key()&&Number(o.input.lineId)===Number(values.lineId)&&['local','sending','error','rejected'].includes(o.state)))throw new Error('An entry for this location is already saved. Send saved updates and wait for confirmation before changing it.');
   if(['stop','decline'].includes(action)){const task=snapshot.tasks.find(t=>t.id===Number(values.taskId));if(outbox.some(o=>o.partition===key()&&['local','sending','error','rejected'].includes(o.state)&&['report','manual','correct'].includes(o.action)&&(task?.lines||[]).some(l=>l.id===Number(o.input.lineId))))throw new Error('Send saved updates and wait for confirmation before stopping or returning this task.');}
   const id=uid(),input={...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.user.id,deviceId};
   const message=action==='decline'?'Return request saved — awaiting warehouse confirmation':['cancel','stop'].includes(action)?'Stop request saved — awaiting warehouse confirmation. Stock stays assigned until the warehouse confirms.':'Saved on this phone — awaiting warehouse confirmation.';
   await store('outbox','readwrite',s=>s.put({id,partition:key(),action,input,label:savedAction({action,input}),state:'local',message,createdAt:new Date().toISOString()}));
   if(action==='manual')provisionalReference(true);
   await store('cache','readwrite',s=>s.delete(draftKey(f)));drafts.delete(draftKey(f));
   outbox=await all('outbox');notice=message;render();await sync();const received=outbox.find(o=>o.id===id);
   if((action==='create'||action==='start')&&received?.result?.taskId){location.href='/tasks/'+received.result.taskId+(workReturn()?'?return_to='+encodeURIComponent(workReturn()):'');return;}
   render();
  }
 }catch(error){feedback.textContent=workText(error.message);feedback.classList.add('error');button.disabled=false;notice=error.message;if(!f.isConnected)render();}
 finally{submitting=false;}
});
root.addEventListener('click',async e=>{
 try{
  const preview=e.target.closest('[data-view-saved]');if(preview){const f=preview.closest('form'),option=f.elements.duplicateOf.selectedOptions[0];f.querySelector('[data-saved-entry]').textContent=option?.value?option.textContent:'Choose a saved entry to inspect.';return;}
  const countSearch=e.target.closest('[data-search-counts]');if(countSearch){const f=countSearch.closest('form');countSearch.disabled=true;try{const response=await fetch('/api/work/countCandidates?'+new URLSearchParams({reportId:f.elements.reportId.value,q:f.elements.countSearch.value}),{cache:'no-store',signal:AbortSignal.timeout(15000)}),data=await response.json();if(!response.ok)throw new Error(data.error);f._countCandidates=data.counts;f.elements.countCorrectionId.innerHTML='<option value="">Choose a count</option>'+options(data.counts,'id',c=>`${c.title} · ${c.logical_code} · ${new Date(c.counted_at||c.received_at).toLocaleString()} · counted by ${c.counter_name} · ${c.lines.map(l=>l.name+': actual '+l.actual+' / difference '+l.difference+' '+l.unit).join('; ')} · reviewed by ${c.reviewer_name||'Unknown'}`);f.querySelector('[data-count-results]').textContent=`${data.counts.length} count corrections found. Select only after checking physical evidence.`;}catch(error){f.querySelector('[data-count-results]').textContent=error.message;}finally{countSearch.disabled=false;}return;}
  const search=e.target.closest('[data-search-history]');if(search){
   const f=search.closest('form');search.disabled=true;
   try{
    const r=await fetch('/api/work/movements?'+new URLSearchParams({reportId:f.elements.reportId.value,q:f.elements.movementSearch.value}),{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
    const result=await r.json();if(!r.ok)throw new Error(result.error||'Could not search movements.');
    f.elements.duplicateOf.innerHTML='<option value="">Choose a movement</option>'+options(result.movements,'id',m=>`${new Date(m.created_at).toLocaleString()} · ${m.quantity} ${m.unit} · ${m.performer_name||'Unknown'} · ${m.origin_ref}`);
    f.querySelector('[data-search-result]').textContent=result.movements.length===100?'Showing 100 matches. Refine the reference or date to find older movements.':`${result.movements.length} matching movements. Choose and verify the correct one.`;
   }catch(error){f.querySelector('[data-search-result]').textContent=error.message;}finally{search.disabled=false;}return;
  }
  const ack=e.target.closest('[data-ack-request]');if(ack){const entry=outbox.find(o=>o.id===ack.dataset.ackRequest&&o.partition===key());if(entry?.state==='not-applied'){entry.state='acknowledged';await store('outbox','readwrite',s=>s.put(entry));render();}return;}
  if(e.target.closest('[data-print]'))window.print();
  const q=e.target.closest('[data-quantity]');if(q){const field=q.closest('form').elements.quantity;field.value=q.dataset.quantity;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();}
  if(e.target.closest('[data-retry]')){await sync();render();}
  if(e.target.closest('[data-export]')){
   const reports=outbox.filter(o=>o.partition===key()),blob=new Blob([JSON.stringify({warehouse:snapshot.site,account:snapshot.user.username,reports},null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='warehouse-saved-updates.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);return;
  }
  if(e.target.closest('[data-forget]')){
   if(outbox.some(o=>['local','sending','error','rejected'].includes(o.state))){notice='Unreceived updates remain. Send or download them before clearing local data.';render();return;}
   // Clear only this account; another account's cache and evidence stay partitioned.
   for(const row of await all('cache'))if(row.id.startsWith(key()+':')||row.id===key())await store('cache','readwrite',s=>s.delete(row.id));
   for(const row of outbox.filter(o=>o.partition===key()))await store('outbox','readwrite',s=>s.delete(row.id));
   snapshot=null;outbox=[];render();return;
  }
  const manual=e.target.closest('[data-manual-summary]');if(manual)await showSummary(findLine(manual.dataset.manualSummary),'manual');
  const scan=e.target.closest('[data-scan-line]');if(scan)await scanQR(findLine(scan.dataset.scanLine));
  const link=e.target.closest('a');if(link&&!online&&link.getAttribute('href')?.startsWith('/')){const target=link.getAttribute('href');if(['/work','/pick','/put','/record-movement'].includes(target)||/^\/tasks\/\d+$/.test(target)){e.preventDefault();path=target;render();}}
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
window.addEventListener('offline',()=>{online=false;notice='Connection lost. Saved updates remain on this phone.';if(!dirty)render();else document.querySelector('#work-notice').textContent=workText(notice);});
const canRefresh=()=>!dirty&&!root.contains(document.activeElement)&&!cameraStream?.active&&!submitting;
let monitoring=false,pollDelay=5000;
function patchLiveRows(){
 const pageTop=window.scrollY,scrolls=[...root.querySelectorAll('.work-table-wrap')].map(el=>[el,el.scrollLeft,el.scrollTop]);
 const visible=new Map((snapshot.tasks||[]).map(t=>[String(t.id),t]));
 const observed=new Map([...(snapshot.tasks||[]),...(snapshot.watchedTasks||[])].map(t=>[String(t.id),t]));
 let changes=0;
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
  changes++;
 }
 const body=root.querySelector('[data-task-table]');if(body){const shown=new Set([...root.querySelectorAll('[data-task-row]')].map(r=>r.dataset.taskRow));for(const [id,task] of visible)if(!shown.has(id)&&shown.size<100){if(!shown.size)body.innerHTML='';body.insertAdjacentHTML('beforeend',taskRow(task));body.lastElementChild.classList.add('work-row-changed');shown.add(id);changes++;}}
 const connection=root.querySelector('.work-connection');if(connection)connection.innerHTML=badge(online?'Connected to warehouse':'Offline · saved work',online?'good':'warning')+`<small>Updated ${esc(new Date(snapshot.generatedAt).toLocaleTimeString())}</small>`;
 const reviewLink=root.querySelector('.work-views a[href="/pending-confirmations"]');if(reviewLink)reviewLink.textContent='Needs review · '+(snapshot.reviewTotal??0);
 const live=root.querySelector('#work-notice');if(live)live.textContent=online?`${changes?changes+' task rows updated. ':''}${snapshot.taskCounts?.active??0} active tasks · ${snapshot.reviewTotal??0} cases need review. Your open forms stay in place; server checks their saved versions.`:'Connection unavailable. Showing saved work; entered values stay on this device.';
 for(const [el,x,y] of scrolls){el.scrollLeft=x;el.scrollTop=y;}window.scrollTo({top:pageTop,behavior:'instant'});
}
async function backgroundRefresh(){
 if(monitoring||submitting||cameraStream?.active)return;monitoring=true;
 try{await sync();pollDelay=online?5000:Math.min(60000,pollDelay*2);if(canRefresh()){
  const positions=[...root.querySelectorAll('.work-table-wrap')].map(el=>[el.scrollLeft,el.scrollTop]);const top=window.scrollY;render();[...root.querySelectorAll('.work-table-wrap')].forEach((el,i)=>{if(positions[i]){el.scrollLeft=positions[i][0];el.scrollTop=positions[i][1];}});window.scrollTo({top,behavior:'instant'});
 }else patchLiveRows();}finally{monitoring=false;}
}
window.addEventListener('online',backgroundRefresh);
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
