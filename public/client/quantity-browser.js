const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const productLabel=p=>[p.cos_sec,p.part_no||p.sku,p.name,p.mpi_status].filter(Boolean).join(' · ');
export function quantityRows(rows,{mode,cellId,productId}){
 return rows.filter(r=>mode!=='bin'||r.cell.id===Number(cellId)).flatMap(r=>r.products.filter(p=>mode==='bin'||p.product_id===Number(productId)).map(p=>({...p,cell:r.cell})));
}
// Only a confirmed numeric delivery is labelled Showing. Polling follows the
// coordinator's actual sequence, rather than running a separate UI carousel.
export function visibleQuantity(target){
 if(target?.status!=='sent'||!target.numeric||target.sequenceDeliveryFailed)return null;
 const item=target.sequence?.[target.sequenceIndex||0];
 return {productId:item?.productId??target.productId,value:target.value,color:target.color};
}
export async function openQuantityBrowser({button,pageScope,show,stop,ended}){
 const request=(...args)=>pageScope?pageScope.fetch(...args):fetch(...args);
 const get=async url=>{const r=await request(url,{headers:{Accept:'application/json'}}),v=await r.json();if(!r.ok)throw Error(v.error||'Could not load quantities.');return v;};
 const initialScope=Object.fromEntries(['cellId','shelfId','warehouseId'].filter(k=>button.dataset[k]).map(k=>[k,button.dataset[k]]));
 const data=await get('/api/displays/quantities?'+new URLSearchParams(initialScope));
 if(pageScope?.active===false)return;
 const rows=data.rows,products=[...new Map(rows.flatMap(r=>r.products).map(p=>[p.product_id,p])).values()].sort((a,b)=>productLabel(a).localeCompare(productLabel(b)));
 let mode=initialScope.cellId?'bin':'product',cellId=initialScope.cellId||'',productId='',receipt=null,busy=false,polling=false,closed=false,timer=null,stream=null,zoom=null,cameraVersion=0;
 const frame=crypto.randomUUID(),d=document.createElement('dialog');d.className='task-edit-dialog ui-template quantity-browser';d.dataset.quantityBrowser='';d.dataset.mobileTable='scroll';
 d.setAttribute('aria-labelledby','quantity-browser-title');
 d.innerHTML=`<header class="review-task-header"><button type="button" class="secondary" data-back aria-label="Back">←</button><h2 id="quantity-browser-title">Show quantities</h2><button type="button" class="dialog-dismiss" data-back aria-label="Close">×</button></header><div class="quantity-browser-toolbar"><div class="work-views" role="group" aria-label="View quantities"><button type="button" data-mode="product">By product</button><button type="button" data-mode="bin">By bin</button></div><label data-product-choice>Product<select data-product data-searchable><option value="">Choose a product</option>${products.map(p=>`<option value="${p.product_id}">${esc(productLabel(p))}</option>`).join('')}</select></label><label data-bin-choice>Bin<select data-bin data-searchable><option value="">Choose a bin</option>${rows.map(r=>`<option value="${r.cell.id}">${esc([r.cell.name,r.cell.rack,r.cell.shed].filter(Boolean).join(' · '))}</option>`).join('')}</select></label><button type="button" class="secondary" data-scan>Scan bin QR</button></div><div class="quantity-browser-actions"><button type="button" data-show-product>Show quantity</button><button type="button" class="secondary" data-cycle>Cycle products</button><button type="button" class="secondary" data-stop disabled>Stop showing</button></div><p data-led-status role="status">Choose a product or bin. Nothing is lit until you press Show.</p><div class="table-wrap"><table class="my-work-table"><thead><tr><th>Bin</th><th>Section (cos_sec)</th><th>Part Number (part_no)</th><th>Nomenclature (nomen1)</th><th>MPI status</th><th>Quantity</th><th>Unit</th><th>LED</th></tr></thead><tbody data-quantity-rows></tbody></table></div><p data-error role="alert"></p><small>LED displays end after two minutes. Closing this window stops its display and restores previous work lights.</small>`;
 document.body.append(d);history.pushState({...history.state,quantityBrowser:frame},'');d.showModal();
 const status=d.querySelector('[data-led-status]'),error=d.querySelector('[data-error]');
 const setBusy=value=>{busy=value;d.querySelector('.quantity-browser-toolbar').inert=value;d.querySelectorAll('button,select').forEach(b=>b.disabled=value);renderControls();};
 function renderControls(){
  d.querySelector('[data-product-choice]').hidden=mode!=='product';d.querySelector('[data-bin-choice]').hidden=mode!=='bin';d.querySelector('[data-scan]').hidden=mode!=='bin';
  d.querySelector('[data-show-product]').hidden=mode!=='product';d.querySelector('[data-show-product]').disabled=busy||!productId;
  d.querySelector('[data-cycle]').hidden=mode!=='bin';d.querySelector('[data-cycle]').disabled=busy||!cellId||!rows.find(r=>r.cell.id===Number(cellId))?.products.length;
  d.querySelector('[data-stop]').disabled=busy||!receipt;
  const cycling=Boolean(receipt&&!receipt.scope?.productId&&receipt.scope?.cellId);
  d.querySelector('[data-cycle]').textContent=cycling?'Cycling products':'Cycle products';
  d.querySelector('[data-cycle]').setAttribute('aria-pressed',String(cycling));
  const productShowing=Boolean(receipt&&mode==='product'&&Number(receipt.scope?.productId)===Number(productId));
  d.querySelector('[data-show-product]').textContent=productShowing?'Showing quantity':'Show quantity';
  d.querySelector('[data-show-product]').disabled=busy||!productId||productShowing;
  for(const b of d.querySelectorAll('[data-mode]')){b.setAttribute('aria-pressed',String(b.dataset.mode===mode));b.classList.toggle('secondary',b.dataset.mode!==mode);}
 }
 function render(){
  renderControls();const entries=quantityRows(rows,{mode,cellId,productId});
  const empty=mode==='bin'&&cellId?'No recorded stock in this bin.':mode==='product'&&productId?'No recorded stock for this product.':'Choose a '+(mode==='bin'?'bin':'product')+' above.';
  d.dataset.quantityMode=mode;
  d.querySelector('thead').innerHTML=`<tr>${mode==='product'?'<th>Bin</th>':''}<th>Product · Part Number (part_no)</th><th>Quantity</th><th>LED</th></tr>`;
  d.querySelector('[data-quantity-rows]').innerHTML=entries.map(p=>`<tr data-bin-row="${p.cell.id}" data-product-row="${p.product_id}">${mode==='product'?`<td>${esc(p.cell.name)}</td>`:''}<td class="quantity-product"><strong>${esc(p.part_no||p.sku)}</strong><a href="/products/${p.product_id}">${esc(p.name)}</a><small>${p.cos_sec?`Section (cos_sec): ${esc(p.cos_sec)} · `:''}MPI: ${esc(p.mpi_status||'—')}</small></td><td class="quantity-value"><span data-value>${esc(p.on_hand)}</span> ${esc(p.unit_of_measure)}</td><td class="quantity-led"><span data-showing></span>${mode==='bin'?`<button type="button" class="secondary" data-show-row="${p.product_id}">Show</button>`:''}</td></tr>`).join('')||`<tr><td colspan="${mode==='bin'?3:4}">${empty}</td></tr>`;
  paint();
 }
 function paint(){
  for(const tr of d.querySelectorAll('[data-bin-row]')){
   const target=receipt?.targets?.find(t=>t.cellId===Number(tr.dataset.binRow)),current=visibleQuantity(target);
   const active=current?.productId===Number(tr.dataset.productRow);
   tr.classList.toggle('quantity-is-showing',active);if(active)tr.querySelector('[data-value]').textContent=String(current.value);
   const label=tr.querySelector('[data-showing]');label.textContent=active?`Showing ${current.value} · ${current.color}`:target?.sequenceDeliveryFailed?'Display not confirmed':target?.status==='sent'&&!target.numeric?'Quantity unavailable':target&&target.status!=='sent'?target.status:'';
   const b=tr.querySelector('[data-show-row]');if(b){b.textContent=active?'Showing':'Show';b.disabled=busy||active;b.setAttribute('aria-pressed',String(active));}
  }
 }
 async function refresh(){
  if(closed||busy||polling||!receipt)return;polling=true;const id=receipt.displayId;
  try{const states=await get('/api/displays/status');if(closed||receipt?.displayId!==id)return;const active=states.find(r=>r.id===id);
   if(active?.state==='active'){receipt={...active,displayId:id};renderControls();paint();}
   else{receipt=null;ended(id);status.textContent=active?'Display is being cleared. Previous work lights will resume after confirmation.':'Display ended. Choose Show to light quantities again.';renderControls();paint();}
  }catch{if(!closed){d.querySelectorAll('[data-showing]').forEach(el=>el.textContent='Display status unavailable');d.querySelectorAll('.quantity-is-showing').forEach(el=>el.classList.remove('quantity-is-showing'));status.textContent='Connection lost. Display status cannot be confirmed.';}}
  finally{polling=false;}
 }
 async function display(selection){
  setBusy(true);error.textContent='';
  try{const result=await show(selection);if(closed){if(result)await stop(result.displayId);return;}if(result){receipt={...result,scope:selection};status.textContent=result.message;paint();}}
  catch(e){error.textContent=e.message;}finally{if(!closed){setBusy(false);paint();}}
 }
 async function stopOwned(){if(!receipt)return;const id=receipt.displayId;const result=await stop(id);receipt=null;status.textContent=result.message;paint();}
 const stopCamera=()=>{cameraVersion++;zoom?.dispose();zoom=null;stream?.getTracks().forEach(t=>t.stop());stream=null;};
 async function resolveQr(text){const found=await get('/api/locations/resolve?label='+encodeURIComponent(text));if(!rows.some(r=>r.cell.id===found.cellId))throw Error('This bin is outside the selected rack or shed. Open Show all quantities in this IMS to inspect it.');cellId=String(found.cellId);mode='bin';d.querySelector('[data-bin]').value=cellId;d.querySelector('[data-bin]').dispatchEvent(new Event('change',{bubbles:true}));}
 async function scan(){
  const camera=document.createElement('dialog');camera.className='task-edit-dialog quantity-camera';camera.innerHTML='<header class="review-task-header"><h2>Scan bin QR</h2><button type="button" class="dialog-dismiss" aria-label="Close camera">×</button></header><video autoplay playsinline muted></video><form><label>Or enter QR text<input name="qr" required></label><button>Open bin</button></form><p role="alert"></p>';
  d.append(camera);camera.showModal();const close=()=>{stopCamera();camera.remove();};camera.querySelector('button').onclick=close;camera.oncancel=e=>{e.preventDefault();close();};
  const select=async text=>{try{await resolveQr(text);close();}catch(e){camera.querySelector('[role=alert]').textContent=e.message;}};
  camera.querySelector('form').onsubmit=e=>{e.preventDefault();void select(e.target.elements.qr.value);};
  const version=++cameraVersion;
  try{
   if(!globalThis.jsQR)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/client/vendor/jsQR.js';script.onload=resolve;script.onerror=()=>reject(Error('QR scanner unavailable. Enter QR text below.'));document.head.append(script);});
   if(closed||version!==cameraVersion)return;
   const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
   if(closed||version!==cameraVersion){media.getTracks().forEach(t=>t.stop());return;}stream=media;
   const video=camera.querySelector('video');video.srcObject=media;await video.play();const module=await import('./camera-zoom.js');if(version!==cameraVersion)return;zoom=module.mountCameraZoom(video);
   const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
   function frame(){if(version!==cameraVersion||closed)return;if(video.readyState>=2&&zoom.drawFrame(canvas,ctx)){const qr=globalThis.jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);if(qr){stopCamera();void select(qr.data);return;}}requestAnimationFrame(frame);}frame();
  }catch(e){if(version===cameraVersion){stopCamera();camera.querySelector('[role=alert]').textContent='Camera unavailable. Enter QR text below.';}}
 }
 async function close(){if(busy||closed)return;setBusy(true);try{await stopOwned();if(history.state?.quantityBrowser===frame)history.back();else dispose();}catch(e){error.textContent=e.message;setBusy(false);}}
 function dispose(){if(closed)return;closed=true;clearInterval(timer);stopCamera();window.removeEventListener('popstate',back);d.remove();}
 function back(){if(history.state?.quantityBrowser===frame)return;const id=receipt?.displayId;dispose();if(id)void stop(id).catch(e=>globalThis.WarehouseNotifications?.notify(e.message,{tone:'error'}));}
 window.addEventListener('popstate',back);pageScope?.own(dispose);
 d.oncancel=e=>{e.preventDefault();void close();};
 d.addEventListener('change',async e=>{
  if(busy||!e.target.matches('[data-product],[data-bin]')||!e.target.value)return;
  if(e.target.matches('[data-product]'))productId=e.target.value;else cellId=e.target.value;
  setBusy(true);try{await stopOwned();}catch(e){error.textContent=e.message;}finally{setBusy(false);render();}
 });
 d.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||busy)return;
  if(b.hasAttribute('data-back'))return void close();
  if(b.dataset.mode){setBusy(true);try{await stopOwned();mode=b.dataset.mode;}catch(e){error.textContent=e.message;}finally{setBusy(false);render();}return;}
  if(b.hasAttribute('data-scan'))return void scan();
  if(b.hasAttribute('data-stop')){setBusy(true);try{await stopOwned();}catch(e){error.textContent=e.message;}finally{setBusy(false);}return;}
  if(b.hasAttribute('data-show-product'))return void display({...initialScope,productId});
  if(b.hasAttribute('data-show-row'))return void display({cellId,productId:b.dataset.showRow});
  if(b.hasAttribute('data-cycle'))return void display({cellId});
 });
 d.querySelector('[data-bin]').value=cellId;render();globalThis.WarehouseCombobox?.init(d);
 timer=setInterval(refresh,500);
 return d;
}
