// The shell checks the current run; its stable identity survives page changes and dismissal.
const badge=document.querySelector('[data-stocktake-badge]');
async function update(){
 try{
  const response=await fetch('/api/stocktaking/snapshot',{cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok)return;
  const s=await response.json();if(String(s.user.id)!==document.body.dataset.accountId)return;
  if(badge){badge.textContent=s.badge;badge.hidden=!s.badge;}
  const r=s.runs.find(r=>r.actionable);
  if(r){
   const message=r.reviews&&(s.capabilities.approve||s.capabilities.recount)?`Stocktaking: ${r.reviews} differences need review`:!r.items.some(i=>s.capabilities.count&&i.active!==0&&i.assignee_id===s.user.id&&['pending','counting','skipped','recheck'].includes(i.state))?'Stocktaking — assign / review locations':r.overdue?'Stocktaking overdue — continue':r.started_at?'Stocktaking in progress — continue':'Stocktaking pending — start';
   globalThis.WarehouseNotifications?.notify(message,{key:'stocktaking-run:'+r.id,tone:'warning',href:'/stocktaking?run='+r.id});
  }
  const saved=JSON.parse(localStorage.getItem('lightguide-stocktaking-v1')||'null'),partition=`${s.site}:${s.user.id}`,requests=new Map((saved?.queues?.[partition]||[]).map(q=>[q.id,q]));
  for(let n=0;n<localStorage.length;n++){const key=localStorage.key(n);if(key?.startsWith('lightguide-stocktake-request:'+partition+':'))try{const row=JSON.parse(localStorage.getItem(key));if(row?.partition===partition)requests.set(row.id,row);}catch{}}
  const pending=[...requests.values()].filter(q=>!q.result).length;
  if(pending)globalThis.WarehouseNotifications?.notify(`${pending} saved count request(s) need receipt`,{key:'saved-count-requests',tone:'warning',href:'/stocktaking?device_help=1'});
 }catch{/* Retain the last known reminder; a failed read is not a new stocktaking event. */}
}
update();setInterval(update,30000);window.addEventListener('online',update);
window.addEventListener('stocktaking-updated',update);window.addEventListener('storage',update);
