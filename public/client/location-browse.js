export async function mount() {
const pageScope=globalThis.WarehousePageLifecycle?.current;
const setTimeout=(...args)=>pageScope?pageScope.timeout(...args):globalThis.setTimeout(...args);
const setInterval=(...args)=>pageScope?pageScope.interval(...args):globalThis.setInterval(...args);
const requestAnimationFrame=(...args)=>pageScope?pageScope.frame(...args):globalThis.requestAnimationFrame(...args);
const fetch=(...args)=>pageScope?pageScope.fetch(...args):globalThis.fetch(...args);
const onPage=(target,...args)=>pageScope?pageScope.listen(target,...args):target.addEventListener(...args);
let stream=null,cameraGeneration=0;
const status=document.querySelector('[data-browse-status]');
async function resolve(label){const r=await fetch('/api/locations/resolve?label='+encodeURIComponent(label));const v=await r.json();if(!r.ok)throw new Error(v.error);showLocation(v);}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showLocation(v){
 if(pageScope?.active===false)return;
 const d=document.createElement('dialog');d.className='task-edit-dialog location-inspect-dialog';d.innerHTML=`<header class="review-task-header"><h2>${esc(v.name)}</h2><button type="button" class="dialog-dismiss" aria-label="Close">×</button></header><p>${esc(v.description.directions)}${v.warehouseName?' · '+esc(v.warehouseName):''}</p><p>${v.products.length} products</p><div class="table-wrap"><table class="my-work-table"><thead><tr><th>Product</th><th>Quantity here</th><th>Warehouse stock</th><th>Available to pick</th>${v.canStocktake?'<th>Action</th>':''}</tr></thead><tbody>${v.products.map(p=>`<tr><td><a href="/products/${p.product_id}">${esc(p.name)}</a><br><small>${esc(p.sku)}</small></td><td>${esc(p.on_hand)} ${esc(p.unit_of_measure)}</td><td>${esc(p.warehouseStock)} ${esc(p.unit_of_measure)}</td><td>${esc(p.availableToPick)} ${esc(p.unit_of_measure)}</td>${v.canStocktake?`<td><a class="ghost-button" href="/stocktaking?productId=${p.product_id}&cellId=${v.cellId}">Stocktake</a></td>`:''}</tr>`).join('')||'<tr><td colspan="5">No recorded stock.</td></tr>'}</tbody></table></div><a class="secondary" href="/cells/${v.cellId}">Open location</a><button type="button" data-close-inspect>Close</button>`;
 document.body.append(d);d.showModal();const close=()=>d.remove();d.querySelector('.dialog-dismiss').onclick=close;d.querySelector('[data-close-inspect]').onclick=close;d.oncancel=close;pageScope?.own(close);
}
document.querySelector('[data-browse-qr]')?.addEventListener('submit',async ev=>{ev.preventDefault();try{await resolve(ev.target.elements.label.value);}catch(e){status.textContent=e.message;}});
const settings=document.querySelector('[data-cell-settings-dialog]'),modeForm=document.querySelector('[data-location-mode]');
let settingsFrame=null,savingMode=false;
const closeSettings=()=>{if(savingMode)return;if(history.state?.cellSettingsFrame===settingsFrame)history.back();else settings?.close();};
if(settings){
 onPage(document.querySelector('[data-open-cell-settings]'),'click',()=>{const feedback=modeForm.querySelector('[role=status]');feedback.textContent='';feedback.classList.remove('error');settingsFrame=crypto.randomUUID();history.pushState({...history.state,cellSettingsFrame:settingsFrame},'');settings.showModal();});
 for(const button of settings.querySelectorAll('[data-cell-settings-close]'))onPage(button,'click',closeSettings);
 onPage(settings,'cancel',event=>{event.preventDefault();closeSettings();});
 onPage(window,'popstate',()=>{if(settings.open&&history.state?.cellSettingsFrame!==settingsFrame){settings.close();if(!savingMode)modeForm.reset();}});
 pageScope?.own(()=>{settings.close();if(history.state?.cellSettingsFrame===settingsFrame){const state={...history.state};delete state.cellSettingsFrame;history.replaceState(state,'');}});
}
if(modeForm)onPage(modeForm,'submit',async ev=>{
 ev.preventDefault();if(savingMode)return;const f=ev.target,feedback=f.querySelector('[role=status]'),save=f.querySelector('button[type="submit"]'),mode=f.elements.mode.value;
 savingMode=true;save.disabled=true;feedback.textContent='';
 try{
  const r=await fetch('/api/work/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),cellId:Number(f.dataset.locationMode),mode})}),v=await r.json();
  if(!r.ok||v.error)throw new Error(v.error||'Not saved. Try again.');
  for(const option of f.elements.mode.options)option.defaultSelected=option.value===mode;
  savingMode=false;closeSettings();globalThis.WarehouseNotifications?.notify(v.message||'Cell access saved.');
 }catch(error){feedback.textContent=error.message||'Not saved. Reconnect and try again.';feedback.classList.add('error');}
 finally{savingMode=false;save.disabled=false;}
});
const stop=()=>{cameraGeneration++;stream?.getTracks().forEach(t=>t.stop());stream=null;};
document.querySelector('[data-browse-scan]')?.addEventListener('click',async()=>{try{stop();const generation=cameraGeneration;const host=document.querySelector('[data-browse-camera]');host.innerHTML='<video autoplay playsinline muted style="max-width:400px;width:100%"></video><button>Close camera</button>';host.querySelector('button').onclick=()=>{stop();host.innerHTML='';};const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});if(generation!==cameraGeneration||!host.isConnected){media.getTracks().forEach(t=>t.stop());return;}stream=media;const video=host.querySelector('video');video.srcObject=stream;await video.play();const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});async function frame(){if(!stream)return;if(video.videoWidth){canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const qr=jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);if(qr){stop();host.innerHTML='';try{await resolve(qr.data);}catch(e){status.textContent=e.message;}return;}}requestAnimationFrame(frame);}frame();}catch{stop();status.textContent='Camera unavailable. Enter the QR text manually.';}});
onPage(window,'pagehide',stop);pageScope?.own(stop);
// Active navigation follows URL context, including dynamic product/location names.
const path=location.pathname,href=path.startsWith('/cells')?'/cells':null;if(href)for(const a of document.querySelectorAll('[data-nav-links] a')){a.classList.toggle('nav-link-active',a.getAttribute('href')===href);if(a.getAttribute('href')===href)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}

}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)await mount();
