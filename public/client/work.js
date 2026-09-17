const root=document.querySelector('#work-app');
const boot=JSON.parse(document.querySelector('#work-boot')?.textContent||'null');
let snapshot=boot?.snapshot, path=boot?.path||'/work', outbox=[],notice='', db,online=Boolean(boot),cameraStream;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let dirty=false;
let deviceId;
try { deviceId=localStorage.getItem('warehouse-device')||uid();localStorage.setItem('warehouse-device',deviceId); } catch {deviceId=uid();}
const key=()=>`${snapshot.site}:${snapshot.user.id}`;
const badge=(text,tone='')=>`<span class="work-badge ${tone}">${esc(text)}</span>`;
const input=(name,label,type='text',attrs='')=>`<label>${esc(label)}<input name="${name}" type="${type}" ${attrs}></label>`;
const qty=(label='Actual quantity')=>input('quantity',label,'number','min="0" max="1000000000" step="0.000001" inputmode="decimal" required placeholder="Enter actual, including 0"');
const options=(items,value,label,selected)=>items.map(i=>`<option value="${esc(i[value])}" ${String(i[value])===String(selected)?'selected':''}>${esc(label(i))}</option>`).join('');
const status=s=>({ready:'Ready to start',working:'In progress',settled:'Recorded',cancelled:'Cancelled',superseded:'Replanned',pending_review:'In progress',completed:'Completed',review:'Needs review',reserved:'Reserved',received:'Received',rejected:'Not received — check report',recorded:'Recorded',local:'Saved on this device'})[s]||s;
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('lytguide-work',1);r.onupgradeneeded=()=>{for(const n of ['cache','outbox'])r.result.createObjectStore(n,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function store(name,mode,fn){return new Promise((resolve,reject)=>{if(!db){reject(new Error('Device storage is unavailable. Nothing was saved.'));return;}const tx=db.transaction(name,mode);let result;try{result=fn(tx.objectStore(name));}catch(e){reject(e);return;}tx.oncomplete=()=>resolve(result?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Device storage write failed.'));});}
const all=name=>store(name,'readonly',s=>s.getAll());
async function cacheSnapshot(){await store('cache','readwrite',s=>s.put({id:key(),snapshot}));await store('cache','readwrite',s=>s.put({id:'active',key:key()}));}
async function refresh(){
 const r=await fetch('/api/work/snapshot'+(/^\/tasks\/\d+$/.test(path)?'?taskId='+path.split('/')[2]:''),{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(r.status===401?'Sign in to send your saved reports.':'Could not refresh warehouse work.');
 const fresh=await r.json();
 if(snapshot&&(fresh.user.id!==snapshot.user.id||fresh.site!==snapshot.site))throw new Error('The signed-in account changed. Reopen My work; saved reports stay with their original account.');
 snapshot={...fresh,ledger:snapshot?.ledger};online=true;await cacheSnapshot();
}
function form(action,body,attrs=''){return `<form data-work-action="${action}" ${attrs}>${body}<p class="form-feedback" role="status"></p></form>`;}
function hidden(n,v){return `<input type="hidden" name="${n}" value="${esc(v)}">`;}
function allocationFields(l){return hidden('lineId',l.id)+hidden('revision',l.revision)+hidden('cellId',l.cell_id)+hidden('unit',l.unit_of_measure)+hidden('productId',l.product_id)+hidden('direction',l.type);}
function lineCard(l){
 const active=['ready','working'].includes(l.execution_state), waiting=l.reports?.filter(r=>r.status==='review')||[];
 const saved=outbox.some(o=>o.partition===key()&&Number(o.input.lineId)===l.id&&['local','sending','error'].includes(o.state));
 let actions='';
 if(active&&l.canAct!==false){
  if(online&&!waiting.length) actions+=form('acquire',allocationFields(l)+`<div class="work-arrival">${input('location','Verify location','text','required autocomplete="off" placeholder="Scan QR or type cell code"')}<button type="button" class="secondary" data-scan>Scan QR</button></div><button class="secondary">${l.execution_state==='working'?'Resume this location':'I’m at this location'}</button>`);
  actions+=form('report',allocationFields(l)+qty()+input('reason','Note (optional)')+`<label class="work-check"><input type="checkbox" name="manual" ${!online||l.execution_state!=='working'?'checked':''}>Work performed manually / connection interrupted</label><p class="work-help">Enter what you actually ${l.type==='pick'?'picked':'put'}, even if it differs from the plan. Zero closes this allocation with no movement.</p><button ${saved?'disabled':''}>${saved?'Report saved — awaiting receipt':'Confirm actual quantity'}</button>`);
  if(l.execution_state==='ready'&&online&&!waiting.length)actions+=form('cancel',allocationFields(l)+'<label class="work-check"><input type="checkbox" required>I have not moved any stock for this allocation.</label><button class="text-button">Cancel this unstarted allocation</button>');
  if(l.type==='put'&&l.execution_state==='ready'&&online&&!waiting.length) actions+=`<details><summary>Change this unstarted put plan</summary>${form('replan',hidden('lineId',l.id)+hidden('revision',l.revision)+`<label>Replacement location<select name="cellId">${options(snapshot.cells,'id',c=>c.logical_code,l.cell_id)}</select></label>`+qty('Replacement planned quantity')+'<label class="work-check"><input type="checkbox" required>No stock has been moved for the original allocation.</label><button class="secondary">Save replacement plan</button>')}</details>`;
 }else if(l.execution_state==='settled'&&l.canAct!==false)actions+=`<details><summary>Correct this earlier record</summary><p>Use this only to correct the earlier actual. A new return or pick is a separate movement.</p>${form('correct',allocationFields(l)+qty('Correct actual quantity')+input('verification','Correction reason','text','required')+'<button>Save correction</button>')}</details>`;
 return `<article class="allocation"><div class="work-card-heading"><div><span class="work-eyebrow">${esc(l.type)} · ${esc(l.guidance_mode==='shared'?'Shared location':'Exclusive turn')}</span><h2 class="cell-code">${esc(l.logical_code)}</h2></div>${badge(status(l.execution_state),l.execution_state==='settled'?'good':'')}</div><div class="work-quantity"><strong>${esc(l.execution_state==='settled'?l.actual_quantity:l.planned_quantity)}</strong><span>${esc(l.unit_of_measure)}<small>${l.execution_state==='settled'?'actual recorded':l.execution_state==='superseded'?'earlier plan — do not execute':l.execution_state==='cancelled'?'cancelled plan — do not execute':'planned · phone is authoritative'}</small></span></div><p class="work-product">${esc(l.product_name)} <span>${esc(l.sku)}</span></p>${l.guidance_mode==='shared'?'<p class="work-callout">The neutral light only locates this cell. Follow your own action and quantity on this screen.</p>':''}${waiting.map(r=>`<p class="work-callout warning">Needs review: ${esc(r.reason)}</p>`).join('')}${saved?'<p class="work-callout">Your report is saved on this device. Do not repeat the movement.</p>':''}${l.canAct===false?'<p class="work-callout">View only. This allocation belongs to another operator.</p>':''}${actions}</article>`;
}
function createPage(direction){const params=new URLSearchParams(location.search);return `<section class="work-intro"><span class="work-eyebrow">Plan your work</span><h2>${direction==='pick'?'Pick stock with confidence':'Make room for incoming stock'}</h2><p>Reserve quantities now. Verify each location when you arrive to begin its turn.</p></section><section class="work-panel narrow">${form('create',hidden('direction',direction)+`<label>Product<select name="productId" required><option value="">Choose a product</option>${options(snapshot.products,'id',p=>`${p.name} · ${p.sku} (${p.unit_of_measure})`,params.get('product_id'))}</select></label>`+input('quantity','Quantity to '+direction,'number',`min="0.000001" step="0.000001" inputmode="decimal" required value="${esc(params.get('quantity')||'')}"`)+`<label>Preferred location (optional)<select name="preferredCellId"><option value="">Choose automatically</option>${options(snapshot.cells,'id',c=>c.logical_code,params.get('cell_id'))}</select></label><button ${outbox.some(o=>o.partition===key()&&o.action==='create'&&['local','error','sending'].includes(o.state))?'disabled':''}>Reserve ${direction} task</button>`)}<a href="/record-movement">Already moved stock? Record completed movement</a></section>`;}
function manualPage(){return `<section class="work-intro"><span class="work-eyebrow">Capture physical work</span><h2>Record what already happened</h2><p>Keep the original movement reference across phone, paper, and shared terminal. A supervisor verifies the report; submitting it does not activate lights.</p></section><section class="work-panel narrow">${form('manual',`<label>Movement<select name="direction"><option value="pick">Picked / removed</option><option value="put">Put / returned</option><option value="count">Count observation</option></select></label><label>Product<select name="productId" required>${options(snapshot.products,'id',p=>`${p.name} · ${p.unit_of_measure}`)}</select></label><label>Location<select name="cellId" required>${options(snapshot.cells,'id',c=>c.logical_code)}</select></label>`+qty()+input('origin','Original reference (e.g. movement slip number)','text','required maxlength="180"')+input('occurredAt','When it happened (optional)','datetime-local')+input('reason','What happened / uncertainty','text','required')+`<p class="work-help">Use a count as an observation during ongoing work. It will not replace the stock balance. For somebody else’s movement, name the person in the note; the supervisor can verify attribution.</p><button>Save completed movement report</button>`)}</section>`;}
function discrepancyCards(){return snapshot.user.role!=='admin'?'':snapshot.discrepancies.map(d=>`<article class="work-panel"><h3>${esc(d.logical_code)} · ${esc(d.product_name)}</h3><p class="work-callout warning">${esc(d.reason)}</p><p>Finish outstanding work, reconcile verified corrections in Admin, then clear the discrepancy only when the ledger matches the checked quantity.</p>${form('reconcile',hidden('cellId',d.cell_id)+hidden('productId',d.product_id)+qty('Verified current quantity')+input('verification','Verification evidence','text','required')+'<button>Clear verified discrepancy</button>')}</article>`).join('');}
function pendingPage(){return `${discrepancyCards()}<section class="work-intro"><span class="work-eyebrow">Supervisor inbox</span><h2>${snapshot.pending.length} pending confirmation${snapshot.pending.length===1?'':'s'}</h2><p>Verify the physical work before entering an actual. Planned quantities are context, never a suggested answer.</p></section><div class="work-grid">${snapshot.pending.map(r=>{let unknown=r.quantity_known===0;return `<article class="allocation"><div class="work-card-heading"><h2>${esc(r.logical_code)}</h2>${badge(r.direction,'warning')}</div><h3>${esc(r.product_name)}</h3><p>Performed by ${esc(r.operator_name||'not yet attributed')} · reported by ${esc(r.reporter_name)}</p><p>${r.planned_quantity!=null?'Planned '+esc(r.planned_quantity)+' '+esc(r.unit)+' · ':''}Reported actual: <strong>${unknown?'unknown':esc(r.quantity)+' '+esc(r.unit)}</strong></p><p class="work-callout warning">${esc(r.reason)}</p><p class="work-reference">Reference ${esc(r.origin_ref)}<br>Report ${esc(r.id)}</p>${r.task_id?`<a href="/tasks/${r.task_id}">View allocation</a>`:''}${form('resolve',hidden('reportId',r.id)+qty('Verified actual quantity')+`<div class="quantity-shortcuts" aria-label="Set verified actual quantity">${[0,1,2,3,4,5].map(n=>`<button type="button" class="secondary" data-quantity="${n}">${n}</button>`).join('')}</div>`+input('verification','How did you verify?','text','required placeholder="Spoke to operator / physical check / slip reference"')+'<button>Record verified actual</button>')}${form('resolve',hidden('reportId',r.id)+hidden('keepOpen','true')+input('verification','Unable to verify — note (optional)')+'<button class="secondary">Keep pending without guessing</button>')}<details><summary>Already accounted for elsewhere?</summary>${form('resolve',hidden('reportId',r.id)+hidden('dismissDuplicate','true')+input('duplicateOf','Existing posted report ID','text','required')+input('verification','Verification reason','text','required')+'<button class="secondary">Link existing movement</button>')}</details></article>`;}).join('')||'<section class="work-empty"><h3>Everything is accounted for</h3><p>Reports needing verification will appear here.</p></section>'}</div>`;}
function taskPage(id){const t=snapshot.tasks.find(t=>t.id===Number(id));if(!t)return '<section class="work-empty">This task is not in the saved work list. Reconnect and open My work.</section>';return `<section class="work-intro"><a href="/work">← All work</a><h2>${esc(t.summary)}</h2><p>${esc(t.created_by_name)} · ${esc(status(t.status))} · Each location settles separately.</p></section><div class="work-grid">${t.lines.filter(l=>l.execution_state!=='superseded').map(lineCard).join('')}</div>${t.lines.some(l=>l.execution_state==='superseded')?`<details class="work-archive"><summary>Earlier plans · do not execute</summary><div class="work-grid">${t.lines.filter(l=>l.execution_state==='superseded').map(lineCard).join('')}</div></details>`:''}`;}
function home(){const tasks=snapshot.tasks;return `<section class="work-intro"><span class="work-eyebrow">Your warehouse, in sync</span><h2>Ready for the next move</h2><p>Start at any ready location. Confirm only what you actually moved.</p><div class="work-actions"><a class="work-primary" href="/pick">Pick stock</a><a class="work-secondary" href="/put">Put stock</a></div></section><div class="work-grid">${tasks.map(t=>`<a class="work-task" href="/tasks/${t.id}" data-local-task="${t.id}"><div class="work-card-heading"><span class="work-eyebrow">${esc(t.type)} · #${t.id}</span>${badge(t.attention?'Needs review':status(t.status),t.attention?'warning':t.status==='completed'?'good':'')}</div><h3>${esc(t.summary)}</h3><p>${t.lines.filter(l=>['settled','cancelled'].includes(l.execution_state)).length} of ${t.lines.filter(l=>l.execution_state!=='superseded').length} locations closed${snapshot.user.role==='admin'?' · '+esc(t.created_by_name):''}</p><span class="work-link">Open task →</span></a>`).join('')||'<section class="work-empty"><h3>Your next task starts here</h3><p>Create a pick or put task to reserve your quantities.</p></section>'}</div>`;}
function labelsPage(){return `<section class="work-intro"><h2>Verify the right location</h2><p>QR labels identify the cell. They do not confirm quantity. Print at actual size and place beside the physical cell.</p><button type="button" data-print>Print labels</button></section><div class="label-grid">${snapshot.cells.map(c=>`<article class="print-label"><img src="/labels/${c.id}.svg" alt="QR code for ${esc(c.logical_code)}"><h2>${esc(c.logical_code)}</h2><p>LytGuide · location ${c.label_revision}</p>${snapshot.user.role==='admin'?form('mode',hidden('cellId',c.id)+`<label>Guidance<select name="mode"><option value="exclusive" ${c.guidance_mode==='exclusive'?'selected':''}>Exclusive turn</option><option value="shared" ${c.guidance_mode==='shared'?'selected':''}>Shared consumables</option></select></label><button class="secondary">Save mode</button>`):''}</article>`).join('')}</div>`;}
function ledger(){return `<section class="work-intro"><h2>Posted stock movements</h2><p>Signed quantities reflect the ledger, including corrections. Historical units remain visible.</p></section><div class="work-table-wrap"><table><thead><tr><th>When</th><th>Product / cell</th><th>Change</th><th>People / reference</th></tr></thead><tbody>${(snapshot.ledger||[]).map(r=>`<tr><td>${esc(new Date(r.created_at).toLocaleString())}</td><td>${esc(r.product_name)}<br>${esc(r.logical_code)}</td><td>${r.quantity_delta>0?'+':''}${esc(r.quantity_delta)} ${esc(r.unit_of_measure)}<br>${esc(r.type)}</td><td>${esc(r.performer_name||'Performer not attributed')}<br>Recorded by ${esc(r.reporter_name)}<br>${esc(r.origin_ref||r.reason)}</td></tr>`).join('')}</tbody></table></div>`;}
function render(){
 dirty=false;
 if(!snapshot){root.innerHTML='<section class="work-empty"><h2>No saved work on this device</h2><p>Connect to the warehouse and sign in to save your allocations.</p><a href="/login">Sign in</a></section>';return;}
 const queued=outbox.filter(o=>o.partition===key()&&!['recorded','duplicate','reserved','ready','busy','not-applied'].includes(o.state));
 const body=path==='/pick'?createPage('pick'):path==='/put'?createPage('put'):path==='/record-movement'?manualPage():path==='/pending-confirmations'?pendingPage():path==='/labels'?labelsPage():path==='/movement-history'?ledger():/^\/tasks\/\d+$/.test(path)?taskPage(path.split('/')[2]):home();
 root.innerHTML=`<div class="work-toolbar"><nav aria-label="Warehouse work"><a href="/work">My work</a><a href="/record-movement">Record movement</a><a href="/movement-history">History</a>${snapshot.user.role==='admin'?'<a href="/pending-confirmations">Pending confirmations</a>':''}</nav>${badge(online?'Connected to warehouse':'Offline · saved work',online?'good':'warning')}</div><p class="work-help">${esc(snapshot.user.name)} · Saved ${esc(new Date(snapshot.generatedAt).toLocaleString())}</p><div id="work-notice" role="status" aria-live="polite">${notice?`<p class="work-callout">${esc(notice)}</p>`:''}</div>${!online?'<p class="work-callout warning">Continue only known, preallocated work using the warehouse manual procedure. No fresh exclusive turn is available offline. Reports remain on this device until received.</p>':''}${queued.length?`<section class="work-queue"><h3>${queued.length} report${queued.length===1?'':'s'} to follow up</h3>${queued.map(o=>`<p>${badge(status(o.state),o.state==='review'?'warning':'')} ${esc(o.message||'Do not repeat the movement.')} <small>${esc(o.id)}</small></p>`).join('')}<button type="button" class="secondary" data-retry>Send saved reports / refresh</button></section>`:''}${body}<footer class="work-footer"><a href="/labels">Print location labels</a><a href="/">All warehouse functions</a><span>Saved work stays on this device. Use your own device account; clear local data before handing it over.</span><button type="button" class="text-button" data-export>Export saved reports for reconciliation</button><button type="button" class="text-button" data-forget>Clear local data (only after reports are received)</button></footer>`;
}
let syncing=false;
async function sync(){
 if(syncing||!snapshot)return;syncing=true;
 try{
  await refresh();
  outbox=await all('outbox');
  for(const o of outbox.filter(o=>o.partition===key()&&['local','sending','error'].includes(o.state))){
   // The frozen request is retried byte-for-byte under its original user/site identity.
   const r=await fetch('/api/work/'+o.action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(o.input)});
   const result=await r.json();
   if(!r.ok){o.state=r.status===400?(['report','manual','correct'].includes(o.action)?'rejected':'not-applied'):'error';o.message=result.error||'Not received. Keep this report and contact your supervisor.';notice=o.message;}
   else{o.state=result.status;o.message=result.message;o.result=result;notice=result.message;}
   await store('outbox','readwrite',s=>s.put(o));
  }
  await refresh();outbox=await all('outbox');
 }catch(e){online=false;notice=e instanceof TypeError?'Connection unavailable. Reports remain saved on this device.':e.message||'Connection unavailable. Reports remain saved on this device.';}
 finally{syncing=false;}
}
root.addEventListener('input',()=>{dirty=true;});
root.addEventListener('change',()=>{dirty=true;});
root.addEventListener('submit',async e=>{
 const f=e.target.closest('form[data-work-action]');if(!f)return;e.preventDefault();
 const button=f.querySelector('button:not([type="button"])');button.disabled=true;
 const feedback=f.querySelector('.form-feedback');const action=f.dataset.workAction;
 try{
  const values=Object.fromEntries(new FormData(f));
  for(const n of ['manual','keepOpen','dismissDuplicate'])if(n in values)values[n]=values[n]==='on'||values[n]==='true';
  if(action==='report'&&!online)values.manual=true;
  if(action==='manual') values.unit=snapshot.products.find(p=>p.id===Number(values.productId))?.unit_of_measure;
  if(action!=='acquire'){
   if(!online&&!['report','manual'].includes(action))throw new Error('Reconnect before changing plans or resolving work. Physical movement reports can still be saved.');
   const id=uid(),input={...values,requestId:id,site:snapshot.site,dataset:snapshot.dataset,deviceId};
   const entry={id,partition:key(),action,input,state:'local',message:'Saved locally. Awaiting warehouse receipt.',createdAt:new Date().toISOString()};
   await store('outbox','readwrite',s=>s.put(entry));outbox=await all('outbox');notice='Saved on this device. Awaiting warehouse receipt.';render();await sync();const received=outbox.find(o=>o.id===id);if(action==='create'&&received?.result?.taskId){location.href='/tasks/'+received.result.taskId;return;}render();
  }else{
   if(!online)throw new Error('Reconnect for this action. Existing physical work can still be saved as a movement report.');
   // Stable identity remains on the same form after a transport error.
   f._input ||= {...values,requestId:uid(),site:snapshot.site,dataset:snapshot.dataset,deviceId,method:f.dataset.scanned?'camera':'typed'};
   const r=await fetch('/api/work/'+action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(f._input)});
   const result=await r.json();if(!r.ok){f._input=null;throw new Error(result.error);}
   notice=result.message;
   if(result.taskId&&action==='create'){location.href='/tasks/'+result.taskId;return;}
   await refresh();render();
  }
 }catch(error){feedback.textContent=error.message;feedback.classList.add('error');button.disabled=false;}
});
root.addEventListener('click',async e=>{
 if(e.target.closest('[data-print]'))window.print();
 const q=e.target.closest('[data-quantity]');if(q){const field=q.closest('form').elements.quantity;field.value=q.dataset.quantity;field.focus();}
 if(e.target.closest('[data-retry]')){await sync();render();}
 if(e.target.closest('[data-export]')){
  const reports=outbox.filter(o=>o.partition===key());const blob=new Blob([JSON.stringify({warehouse:snapshot.site,account:snapshot.user.username,reports},null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='warehouse-saved-reports.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);return;
 }
 if(e.target.closest('[data-forget]')){
  if(outbox.some(o=>['local','sending','error','rejected'].includes(o.state))){notice='Unreceived reports remain on this device. Send them before clearing local data.';render();return;}
  await store('cache','readwrite',s=>s.clear());await store('outbox','readwrite',s=>s.clear());snapshot=null;outbox=[];render();return;
 }
 const scan=e.target.closest('[data-scan]');if(scan)await scanQR(scan.closest('form'));
 const link=e.target.closest('a');if(link&&!online&&link.getAttribute('href')?.startsWith('/')){const target=link.getAttribute('href');if(['/work','/record-movement'].includes(target)||/^\/tasks\/\d+$/.test(target)){e.preventDefault();path=target;render();}}
});
async function scanQR(f){
 const feedback=f.querySelector('.form-feedback');
 if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){feedback.textContent='Camera needs a trusted HTTPS connection (or localhost). Type the printed cell code to verify the location.';return;}
 const dialog=document.createElement('dialog');dialog.className='qr-dialog';dialog.innerHTML='<h2>Scan the location label</h2><p>Point your camera at the printed QR. This verifies location only.</p><video autoplay playsinline muted></video><button type="button">Close camera</button>';
 document.body.append(dialog);dialog.showModal();let stopped=false;
 const stop=()=>{stopped=true;cameraStream?.getTracks().forEach(t=>t.stop());dialog.remove();};dialog.querySelector('button').onclick=stop;dialog.addEventListener('cancel',stop);
 try{
  cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  const video=dialog.querySelector('video');video.srcObject=cameraStream;await video.play();const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d',{willReadFrequently:true});
  function frame(){if(stopped)return;if(video.readyState>=2){canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const p=ctx.getImageData(0,0,canvas.width,canvas.height);const code=window.jsQR(p.data,p.width,p.height);if(code){f.elements.location.value=code.data;f.dataset.scanned='true';feedback.textContent='QR captured. Press I’m at this location to verify it with the warehouse.';stop();return;}}requestAnimationFrame(frame);}requestAnimationFrame(frame);
 }catch(e){stop();feedback.textContent='Camera unavailable. Allow camera access or type the printed cell code.';}
}
window.addEventListener('offline',()=>{online=false;notice='Connection lost. Saved reports remain on this device.';if(!dirty)render();else document.querySelector('#work-notice').textContent=notice;});
window.addEventListener('online',async()=>{if(!dirty){await sync();render();}});
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&!dirty&&!document.activeElement?.closest('form')){await sync();render();}});
try{
 db=await openDB();
 if(snapshot)await cacheSnapshot();else{const active=await store('cache','readonly',s=>s.get('active'));snapshot=(await store('cache','readonly',s=>s.get(active?.key||'')))?.snapshot;}
 outbox=await all('outbox');
 for(const o of outbox.filter(o=>o.state==='rejected'&&!['report','manual','correct'].includes(o.action))){o.state='not-applied';await store('outbox','readwrite',s=>s.put(o));}
}catch(e){notice='Device storage is unavailable. Reports are not saved locally; resolve storage access before moving stock with this device.';}
render();
if(boot){await sync();render();}
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});

setInterval(async()=>{if(document.visibilityState==='visible'&&!dirty&&!document.activeElement?.closest('form')&&!cameraStream?.active){await sync();render();}},30000);
