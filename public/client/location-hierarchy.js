import {locationTree} from './location-tree.js';

export async function mount() {
 const root=document.querySelector('[data-location-tree]'),boot=document.querySelector('#location-hierarchy-boot'),edit=document.querySelector('[data-edit-layout]');
 if(!root||!boot||!edit)return;
 const scope=globalThis.WarehousePageLifecycle?.current;
 const listen=(target,...args)=>scope?scope.listen(target,...args):target.addEventListener(...args);
 const read=JSON.parse(boot.textContent),cards=read.cards;
 let base=structuredClone(read),draft=structuredClone(read),editing=false,busy=false,pending=null,drag=null;
 const save=document.querySelector('[data-save-layout]'),cancel=document.querySelector('[data-cancel-layout]'),add=document.querySelector('[data-add-warehouse]'),hint=document.querySelector('[data-layout-hint]'),error=document.querySelector('[data-layout-error]');
 const payload=value=>({version:value.version,warehouses:value.warehouses.map(w=>({id:w.id,name:w.name})),shelves:value.shelves.map(s=>({id:s.id,name:s.name,warehouseId:s.warehouse_id})),cells:value.cells.map(c=>({id:c.id,shelfId:c.shelf_id}))});
 const dirty=()=>JSON.stringify(payload(base))!==JSON.stringify(payload(draft));
 const mark=()=>{save.disabled=busy||!dirty();error.textContent='';pending=null;};
 const expanded=()=>new Set([...root.querySelectorAll('details[open]')].map(d=>d.dataset.warehouseZone?'warehouse:'+d.dataset.warehouseZone:'shelf:'+d.dataset.shelfZone));
 let normalMarkup=root.innerHTML;
 function refreshLabels(){
  const warehouses=new Map(draft.warehouses.map(w=>[String(w.id),w])),shelves=new Map(draft.shelves.map(s=>[String(s.id),s]));
  for(const node of root.querySelectorAll('[data-warehouse-zone]'))node.querySelector('summary [data-group-label]').textContent=warehouses.get(node.dataset.warehouseZone).name;
  for(const node of root.querySelectorAll('[data-shelf-zone]')){const shelf=shelves.get(node.dataset.shelfZone);node.querySelector('summary [data-group-label]').textContent=shelf.name;node.querySelector('[data-drag-kind="shelf"]')?.setAttribute('aria-label','Drag '+shelf.name);}
  for(const node of root.querySelectorAll('[data-tree-cell]')){const c=draft.cells.find(v=>String(v.id)===node.dataset.treeCell),s=shelves.get(String(c.shelf_id)),w=warehouses.get(String(s.warehouse_id));const subtitle=node.querySelector('.location-card-subtitle');subtitle.textContent=s.name+' · '+w.name;subtitle.title=subtitle.textContent;}
  for(const select of root.querySelectorAll('[data-shelf-warehouse],[data-cell-shelf]'))for(const option of select.options){const shelf=shelves.get(option.value),label=select.hasAttribute('data-shelf-warehouse')?warehouses.get(option.value).name:warehouses.get(String(shelf.warehouse_id)).name+' / '+shelf.name;if(option.textContent!==label)option.textContent=label;}
 }
 function render(open=null){
  root.classList.toggle('is-editing',editing);
  root.innerHTML=locationTree(draft,cards,{editing,open,displayCapabilities:read.displayCapabilities||[]});
  refreshLabels();globalThis.WarehouseCombobox?.init(root);
 }
 function controls(){edit.hidden=editing;save.hidden=cancel.hidden=add.hidden=hint.hidden=!editing;save.disabled=busy||!dirty();cancel.disabled=add.disabled=busy;root.inert=busy;}
 const fetch=(...args)=>scope?scope.fetch(...args):globalThis.fetch(...args);
 const notify=text=>globalThis.WarehouseNotifications?.notify(text);
 async function confirmDiscard(){
  if(busy)return false;if(!dirty())return true;
  return new Promise(resolve=>{const d=document.createElement('dialog');d.className='location-settings-dialog';d.innerHTML='<header class="review-task-header"><h2>Discard layout changes?</h2></header><div class="work-actions"><button type="button" class="secondary" data-keep>Keep editing</button><button type="button" class="danger-button" data-discard>Discard changes</button></div>';document.body.append(d);let done=false;const close=answer=>{if(done)return;done=true;d.remove();resolve(answer);};d.querySelector('[data-keep]').onclick=()=>close(false);d.querySelector('[data-discard]').onclick=()=>close(true);d.oncancel=event=>{event.preventDefault();close(false);};scope?.own(()=>close(false));d.showModal();});
 }
 scope?.guardLeave(confirmDiscard);
 listen(window,'beforeunload',event=>{if(busy||dirty()){event.preventDefault();event.returnValue='';}});
 listen(edit,'click',()=>{editing=true;draft=structuredClone(base);render();controls();});
 listen(cancel,'click',async()=>{if(!await confirmDiscard())return;draft=structuredClone(base);editing=false;root.classList.remove('is-editing');root.innerHTML=normalMarkup;error.textContent='';controls();});
 listen(add,'click',()=>{const open=expanded(),id='new-'+crypto.randomUUID();draft.warehouses.push({id,name:'New warehouse'});open.add('warehouse:'+id);render(open);mark();root.querySelector(`[data-warehouse-name="${id}"]`).focus();});
 listen(root,'click',event=>{const b=event.target.closest('[data-add-shelf]');if(!b)return;const open=expanded(),id='new-'+crypto.randomUUID();draft.shelves.push({id,name:'New shed/shelf',warehouse_id:b.dataset.addShelf});open.add('shelf:'+id);render(open);mark();root.querySelector(`[data-shelf-name="${id}"]`).focus();});
 listen(root,'input',event=>{const t=event.target;if(t.hasAttribute('data-warehouse-name'))draft.warehouses.find(w=>String(w.id)===t.dataset.warehouseName).name=t.value;else if(t.hasAttribute('data-shelf-name'))draft.shelves.find(s=>String(s.id)===t.dataset.shelfName).name=t.value;else return;refreshLabels();mark();});
 function move(kind,id,to){
  if(kind==='cell'){const c=draft.cells.find(v=>String(v.id)===String(id));if(!c||String(c.shelf_id)===String(to)||!draft.shelves.some(s=>String(s.id)===String(to)))return;c.shelf_id=to;}
  else {const s=draft.shelves.find(v=>String(v.id)===String(id));if(!s||String(s.warehouse_id)===String(to)||!draft.warehouses.some(w=>String(w.id)===String(to)))return;s.warehouse_id=to;}
  const open=expanded();if(kind==='cell'){open.add('shelf:'+to);open.add('warehouse:'+draft.shelves.find(s=>String(s.id)===String(to)).warehouse_id);}else open.add('warehouse:'+to);
  render(open);mark();
 }
 listen(root,'change',event=>{const t=event.target;if(t.hasAttribute('data-cell-shelf'))move('cell',t.dataset.cellShelf,t.value);else if(t.hasAttribute('data-shelf-warehouse'))move('shelf',t.dataset.shelfWarehouse,t.value);});
 function cleanupDrag(){for(const el of root.querySelectorAll('.location-drop-target'))el.classList.remove('location-drop-target');root.classList.remove('is-dragging');drag?.ghost?.remove();drag=null;}
 listen(root,'pointerdown',event=>{const handle=event.target.closest('[data-drag-kind]');if(!handle||!editing||busy||event.button!==0)return;event.preventDefault();drag={kind:handle.dataset.dragKind,id:handle.dataset.dragId,x:event.clientX,y:event.clientY,pointer:event.pointerId,started:false};root.setPointerCapture(event.pointerId);});
 listen(root,'pointermove',event=>{
  if(!drag||event.pointerId!==drag.pointer)return;
  if(!drag.started&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6)return;
  event.preventDefault();if(!drag.started){drag.started=true;root.classList.add('is-dragging');drag.ghost=document.createElement('div');drag.ghost.className='location-drag-ghost';drag.ghost.textContent=drag.kind==='cell'?'Move cell':'Move shed/shelf';document.body.append(drag.ghost);}
  drag.ghost.style.left=event.clientX+12+'px';drag.ghost.style.top=event.clientY+12+'px';
  for(const el of root.querySelectorAll('.location-drop-target'))el.classList.remove('location-drop-target');
  const target=document.elementFromPoint(event.clientX,event.clientY)?.closest(drag.kind==='cell'?'[data-shelf-zone]':'[data-warehouse-zone]');
  drag.to=target&&root.contains(target)?(drag.kind==='cell'?target.dataset.shelfZone:target.dataset.warehouseZone):null;target?.classList.add('location-drop-target');
 });
 listen(root,'pointerup',event=>{if(!drag||event.pointerId!==drag.pointer)return;const {kind,id,to,started}=drag;cleanupDrag();if(started&&to)move(kind,id,to);});
 listen(root,'pointercancel',cleanupDrag);scope?.own(cleanupDrag);
 listen(save,'click',async()=>{
  if(busy||!dirty())return;
  if(!root.querySelectorAll('input').length||![...root.querySelectorAll('input')].every(i=>i.reportValidity()))return;
  const body=payload(draft);pending??={...body,requestId:crypto.randomUUID(),actorId:read.actorId,site:read.site,dataset:read.dataset};busy=true;controls();error.textContent='';
  try{
   const response=await fetch('/api/location-setup/hierarchy',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(pending),signal:AbortSignal.timeout(15000)});const result=await response.json();
   if(!response.ok||result.error)throw new Error(result.error||'Layout was not saved. Check the names and try again.');
   draft={...draft,...result.hierarchy};base=structuredClone(draft);pending=null;editing=false;busy=false;render();normalMarkup=root.innerHTML;controls();notify(result.message);
   if(globalThis.WarehouseNavigation)await globalThis.WarehouseNavigation.go(location.href,{refresh:true});else location.reload();
  }catch(problem){busy=false;controls();error.textContent=problem.message||'Could not save. Your changes are still here. Retry when connected.';}
 });
}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)await mount();
