const dialogs=new WeakMap();
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Used by setup screens when a guarded API rejects a change. Draft inputs stay in place.
export async function showSetupWorkResponse(response,{scope,error:providedError}={}) {
  if(response.ok||!response.clone)return false;
  let error=providedError;try{if(!error)error=await response.clone().json();}catch{return false;}
  if(error.code!=='OUTSTANDING_WORK')return false;
  const owner=scope||document;
  let dialog=dialogs.get(owner);if(!dialog){dialog=createSetupWorkDialog({scope});dialogs.set(owner,dialog);}
  await dialog.open(error.scope||{});return true;
}
export function createSetupWorkDialog({scope}={}) {
  const e=escape;
  const d=document.createElement('dialog');d.className='task-edit-dialog setup-work-dialog';d.dataset.setupWorkDialog='';(document.querySelector('.ui-template')||document.body).append(d);
  let snapshot=null,filter={},busy=false,pending=null,message='';
  let receiptKey=null;
  const fetch=(...args)=>scope?scope.fetch(...args):globalThis.fetch(...args);
  const listen=(target,...args)=>scope?scope.listen(target,...args):target.addEventListener(...args);
  function close(){if(busy)return;d.close();}
  scope?.own(()=>d.remove());
  listen(d,'click',event=>{if(event.target.closest('[data-ui-dialog-back]')){event.preventDefault();event.stopPropagation();close();}},true);
  listen(d,'cancel',event=>{event.preventDefault();close();});
  scope?.guardLeave(()=>!busy);
  async function load(){
    const r=await fetch('/api/work/setupBlockers?'+new URLSearchParams(filter),{signal:AbortSignal.timeout(15000)});const result=await r.json();if(!r.ok||result.error)throw Error(result.error||'Could not load blocking tasks.');snapshot=result;receiptKey=`setup-work-discard:${location.origin}:${result.site}:${result.dataset}:${result.actorId}`;try{pending=JSON.parse(sessionStorage.getItem(receiptKey)||'null');}catch{pending=null;}
  }
  function draw(){
    const tasks=snapshot?.tasks||[],manual=snapshot?.manual||[];
    d.innerHTML=`<header class="review-task-header"><h2>Work blocking this change</h2><button type="button" class="dialog-dismiss" data-blockers-close aria-label="Close blocking work">×</button></header><p>Review the tasks below. Discard cancels remaining untouched work and releases its reservations. Started work or pending movement entries require a quantity check. Recorded inventory and task history are kept.</p><p role="status" aria-live="polite" data-blockers-status>${e(message)}</p>${snapshot?`<div class="setup-blockers-table" data-mobile-table="scroll"><table class="my-work-table"><thead><tr><th>Select</th><th>Task</th><th>Action</th><th>Product</th><th>Location</th><th>Planned</th><th>Recorded</th><th>Assigned to</th><th>Status</th><th></th></tr></thead><tbody>${tasks.flatMap(t=>(t.lines.length?t.lines:[{}]).map((l,index)=>`<tr>${index===0?`<td rowspan="${Math.max(1,t.lines.length)}"><input type="checkbox" data-blocker-task="${t.id}" aria-label="Select task ${t.id}" ${t.canDiscard&&!pending?'':'disabled'}></td><td rowspan="${Math.max(1,t.lines.length)}"><a href="/tasks/${t.id}">#${t.id}</a></td>`:''}<td>${e(t.type==='pick'?'Pick':t.type==='put'?'Put':t.type)}</td><td>${e(l.product)}<small>${e(l.sku)}</small></td><td>${e(l.location)}</td><td>${e(l.planned_quantity)} ${e(l.unit_of_measure)}</td><td>${e(l.actual_quantity)} ${e(l.unit_of_measure)}</td>${index===0?`<td rowspan="${Math.max(1,t.lines.length)}">${e(t.assignee)}</td><td rowspan="${Math.max(1,t.lines.length)}">${e(t.status)}${t.reports.length?`<details><summary>${t.reports.length} pending ${t.reports.length===1?'entry':'entries'}</summary>${t.reports.map(r=>`<p>${r.quantity_known?e(r.quantity)+' '+e(r.unit):'Unknown quantity'} · ${e(r.reason)}</p>`).join('')}</details>`:''}${t.reason?`<small>${e(t.reason)}</small>`:''}</td><td rowspan="${Math.max(1,t.lines.length)}">${t.canDiscard?`<button type="button" class="danger-button" data-discard-blocker="${t.id}" ${pending?'disabled':''}>Discard</button>`:t.moveProtected?'<a href="/work">Continue move</a>':'<a href="/pending-confirmations">Review</a>'}</td>`:''}</tr>`)).join('')}${manual.map(r=>`<tr><td><input type="checkbox" data-blocker-report="${e(r.id)}" aria-label="Select manual entry ${e(r.id)}" ${r.canDiscard&&!pending?'':'disabled'}></td><td>Manual entry<small>${e(r.id.slice(0,8))}</small></td><td>${e(r.direction)}</td><td>${e(r.product)}</td><td>${e(r.location)}</td><td>—</td><td>Not recorded</td><td>—</td><td>Needs quantity check<small>Reported: ${r.quantity_known?e(r.quantity)+' '+e(r.unit):'Unknown'}</small><details><summary>Details</summary><p>${e(r.reason)}</p></details></td><td>${r.canDiscard?`<button type="button" class="danger-button" data-discard-report="${e(r.id)}" ${pending?'disabled':''}>Discard entry</button>`:'<a href="/pending-confirmations">Review</a>'}</td></tr>`).join('')}${!tasks.length&&!manual.length?'<tr><td colspan="10">No visible blocking tasks.</td></tr>':''}</tbody></table></div>${snapshot.hiddenCount?`<p>${snapshot.hiddenCount} other blocking ${snapshot.hiddenCount===1?'item belongs':'items belong'} to other operators. Ask an authorized supervisor to review them.</p>`:''}`:'<p>Loading blocking tasks…</p>'}<div data-blockers-confirm hidden><p class="work-callout">Discarding a task stops its remaining work at every location listed above. Work already performed is retained. Active or uncertain quantities will stay in Needs review.</p><label><input type="checkbox" data-confirm-blocker-discard>I understand and want to discard these tasks.</label><label data-verify-none-label hidden><input type="checkbox" data-verify-none>I verified all workers stopped and no additional products moved beyond the recorded task quantities. No movement occurred for selected manual entries.</label><button type="button" class="danger-button" data-confirm-discard disabled>Confirm discard</button><button type="button" class="secondary" data-cancel-blocker-discard>Back</button></div><div class="setup-blockers-actions"><button type="button" class="secondary" data-blockers-select-all ${(tasks.some(t=>t.canDiscard)||manual.some(r=>r.canDiscard))&&!pending?'':'disabled'}>Select all available tasks</button><button type="button" class="danger-button" data-discard-selected ${pending?'disabled':''}>Discard selected tasks</button>${pending?'<button type="button" data-retry-blocker-discard>Retry unconfirmed discard</button>':''}<button type="button" class="secondary" data-blockers-refresh>Refresh</button><button type="button" data-blockers-close>${snapshot?.remaining===0?'Close and save again':'Keep work and go back'}</button></div><p role="alert" data-blockers-error></p>`;
  }
  function confirm(ids,reportIds=[]){
    const selected=snapshot.tasks.filter(t=>ids.includes(t.id)&&t.canDiscard),reports=snapshot.manual.filter(r=>reportIds.includes(r.id)&&r.canDiscard);
    if(pending)throw Error('Retry the unconfirmed discard before selecting another task.');
    if(!selected.length&&!reports.length)throw Error('Select at least one task or entry to discard.');
    d.selectedTasks=selected.map(t=>({id:t.id,token:t.token}));d.selectedReports=reports.map(r=>({id:r.id,token:r.token}));
    for(const input of d.querySelectorAll('[data-blocker-task]'))input.checked=ids.includes(Number(input.dataset.blockerTask));
    for(const input of d.querySelectorAll('[data-blocker-report]'))input.checked=reportIds.includes(input.dataset.blockerReport);
    d.querySelector('[data-blockers-confirm]').hidden=false;d.querySelector('[data-confirm-blocker-discard]').checked=false;d.querySelector('[data-confirm-discard]').disabled=true;
    const verify=d.querySelector('[data-verify-none]');verify.checked=false;
    d.querySelector('[data-verify-none-label]').hidden=!reports.length&&!selected.some(t=>t.needsCheck&&t.canVerify);
    verify.disabled=selected.some(t=>t.needsCheck&&!t.canVerify);
  }
  async function discard(){
    if(busy)return;busy=true;
    for(const control of d.querySelectorAll('button,input'))control.disabled=true;
    try{
      const command=pending||{scope:filter,tasks:d.selectedTasks,reports:d.selectedReports,verifiedNoAdditionalMovement:d.querySelector('[data-verify-none]').checked,confirmed:true,requestId:crypto.randomUUID(),site:snapshot.site,dataset:snapshot.dataset,actorId:snapshot.actorId};
      pending=command;sessionStorage.setItem(receiptKey,JSON.stringify(command));
      const r=await fetch('/api/work/discardSetupTasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(15000)}),result=await r.json();
      if(r.ok||r.status<500){pending=null;sessionStorage.removeItem(receiptKey);}
      if(!r.ok||result.error)throw Error(result.error||'Could not discard these tasks.');
      message=result.message;await load();draw();
    }catch(error){message=error.message;draw();}finally{busy=false;}
  }
  listen(d,'change',event=>{if(event.target.matches('[data-confirm-blocker-discard],[data-verify-none]'))d.querySelector('[data-confirm-discard]').disabled=!d.querySelector('[data-confirm-blocker-discard]').checked||!!d.selectedReports?.length&&!d.querySelector('[data-verify-none]').checked;});
  listen(d,'click',async event=>{
    const b=event.target.closest('button');if(!b||busy)return;
    try{
      if(b.hasAttribute('data-blockers-close'))close();
      if(b.hasAttribute('data-blockers-refresh')){await load();message='Latest blocking work loaded.';draw();}
      if(b.hasAttribute('data-blockers-select-all'))for(const input of d.querySelectorAll('[data-blocker-task]:not(:disabled),[data-blocker-report]:not(:disabled)'))input.checked=true;
      if(b.dataset.discardBlocker)confirm([Number(b.dataset.discardBlocker)]);
      if(b.dataset.discardReport)confirm([],[b.dataset.discardReport]);
      if(b.hasAttribute('data-discard-selected'))confirm([...d.querySelectorAll('[data-blocker-task]:checked')].map(i=>Number(i.dataset.blockerTask)),[...d.querySelectorAll('[data-blocker-report]:checked')].map(i=>i.dataset.blockerReport));
      if(b.hasAttribute('data-cancel-blocker-discard'))d.querySelector('[data-blockers-confirm]').hidden=true;
      if((b.hasAttribute('data-confirm-discard')&&d.querySelector('[data-confirm-blocker-discard]').checked)||b.hasAttribute('data-retry-blocker-discard'))await discard();
    }catch(error){d.querySelector('[data-blockers-error]').textContent=error.message;}
  });
  return {async open(selectedScope={}){
    if(d.open)return;
    filter=selectedScope;message='';snapshot=null;
    pending=null;draw();d.showModal();try{await load();draw();}catch(error){message=error.message;draw();}
  }};
}
