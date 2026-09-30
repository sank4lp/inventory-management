const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>value?escape(new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'medium'}))+' IST':'Not recorded';
export function cellHistoryContent(data){
 return `<p>${data.scope==='own'?'Your recorded movements · ':''}${escape(data.cell.display_name||data.cell.logical_code)}</p><div class="table-wrap cell-timeline-wrap" tabindex="0" role="region" aria-label="Location movements"><table class="cell-timeline"><thead><tr>${['Timestamp (IST)','Task','Product','Movement','Quantity','Unit','Performed by','Recorded by','Note'].map(v=>'<th scope="col">'+v+'</th>').join('')}</tr></thead><tbody>${data.entries.map(e=>`<tr><td>${time(e.time)}</td><td>${e.taskId?'#'+escape(e.taskId):'—'}</td><td>${escape(e.product)}</td><td>${escape({pick:'Pick',put:'Put',adjust:'Correction',adjustment:'Correction'}[e.type]||e.type)}</td><td>${e.quantity>0?'+':''}${escape(e.quantity)}</td><td>${escape(e.unit)}</td><td>${escape(e.performer||'Not recorded')}</td><td>${escape(e.recorder||'Not recorded')}</td><td>${escape(e.reason||'—')}</td></tr>`).join('')||'<tr><td colspan="9">No recorded movements.</td></tr>'}</tbody></table></div><div class="history-pagination"><button type="button" class="secondary" data-cell-history-page="${data.page.number-1}" ${data.page.number<=1?'disabled':''}>Previous</button><span>Page ${data.page.number} of ${data.page.pages} · ${data.page.total} movements</span><button type="button" class="secondary" data-cell-history-page="${data.page.number+1}" ${data.page.number>=data.page.pages?'disabled':''}>Next</button></div>`;
}
const dialog=document.querySelector('[data-cell-history-dialog]');
if(dialog){
 let read=0,cellId=null,opener=null,frame=null;
 const content=dialog.querySelector('[data-cell-history-content]');
 async function load(page=1){
  const request=++read,cell=cellId;content.setAttribute('aria-busy','true');
  try{
   const response=await fetch('/api/work/cellHistory?'+new URLSearchParams({cellId:cell,page}),{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(15000)}),data=await response.json();
   if(request!==read||!dialog.open||cell!==cellId)return;
   if(!response.ok)throw new Error(data.error||'History could not be loaded. Try again.');
   if(String(data.actorId)!==dialog.dataset.actor||data.site!==dialog.dataset.site||data.dataset!==dialog.dataset.dataset)throw new Error('Account or warehouse changed. Reload this page.');
   content.innerHTML=cellHistoryContent(data);
  }catch(error){if(request===read&&dialog.open)content.innerHTML='<p class="work-callout warning">'+escape(error.message)+'</p><button type="button" class="secondary" data-cell-history-page="'+page+'">Retry</button>';}
  finally{if(request===read)content.removeAttribute('aria-busy');}
 }
 document.addEventListener('click',event=>{
  const button=event.target.closest('[data-cell-history]');if(!button)return;
  opener=button;cellId=button.dataset.cellHistory;content.innerHTML='<p>Loading movement history…</p>';
  frame=crypto.randomUUID();history.pushState({...history.state,cellHistoryFrame:frame},'');dialog.showModal();void load();
 });
 const back=()=>{if(history.state?.cellHistoryFrame===frame)history.back();else dialog.close();};
 dialog.addEventListener('click',event=>{if(event.target.closest('[data-cell-history-back]'))back();const page=event.target.closest('[data-cell-history-page]');if(page)void load(Number(page.dataset.cellHistoryPage));});
 dialog.addEventListener('cancel',event=>{event.preventDefault();back();});
 dialog.addEventListener('close',()=>{read++;opener?.focus();});
 window.addEventListener('popstate',()=>{if(dialog.open&&history.state?.cellHistoryFrame!==frame)dialog.close();});
}
