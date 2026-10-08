// Column preferences belong to the signed-in user, never to task data.
export function fitColumnWidths(columns, available) {
 const minimum=columns.map(c=>c.minimum||64), base=minimum.reduce((a,b)=>a+b,0);
 if(available<base){
  const floors=columns.map(c=>c.floor||48), floor=floors.reduce((a,b)=>a+b,0), ratio=Math.max(0,available-floor)/Math.max(1,base-floor);
  return minimum.map((width,i)=>floors[i]+(width-floors[i])*ratio);
 }
 const extra=available-base, weights=columns.map(c=>c.weight||1), total=weights.reduce((a,b)=>a+b,0);
 return minimum.map((width,i)=>width+extra*weights[i]/total);
}
export function changedColumnWidths(widths,index,delta) {
 return widths.map((width,i)=>i===index?Math.max(48,Math.min(2000,width+delta)):width);
}
export function validColumnPreferences(value, keys) {
 return value&&keys.every(key=>Number.isFinite(value[key])&&value[key]>=48&&value[key]<=2000)?keys.map(key=>value[key]):null;
}

export function mountTableColumns(root,{preferenceKey,storage}={}) {
 const doc=root.ownerDocument, view=doc.defaultView, initialized=new WeakSet();
 const storageKey='lightguide:table-columns:'+preferenceKey;
 let preferences=null, drag=null, disposed=false;
 try{storage??=globalThis.localStorage;preferences=JSON.parse(storage.getItem(storageKey));}catch{/* Storage may be unavailable. Resizing still works. */}
 const tables=()=>[...root.querySelectorAll('table[data-resizable-table]')];
 const headers=table=>[...table.querySelectorAll('thead th')];
 const defaults={task:90,product:130,type:76,assignedTo:170,unit:72,requested:114,completed:116,remaining:108,priority:98,status:104,progress:108,state:150,action:118};
 const floors={product:110,assignedTo:140,requested:90,state:130,action:110};
 const definition=table=>headers(table).map(th=>({key:th.dataset.column,label:th.querySelector('a')?.textContent.replace(/[↑↓↕]/g,'').trim()||th.textContent.trim(),minimum:defaults[th.dataset.column]||64,floor:floors[th.dataset.column]||64,weight:['product','assignedTo','state'].includes(th.dataset.column)?2:1}));
 const persist=(columns,widths)=>{
  preferences=Object.fromEntries(columns.map((column,i)=>[column.key,widths[i]]));
  try{storage.setItem(storageKey,JSON.stringify(preferences));}catch{/* Optional preference only. */}
 };
 function apply(table,widths){
  // Expanding the browser should never leave a gap at the right content edge.
  widths=[...widths];widths[widths.length-1]+=Math.max(0,table.parentElement.clientWidth-widths.reduce((a,b)=>a+b,0));
  let group=table.querySelector('colgroup[data-column-widths]');
  if(!group){group=doc.createElement('colgroup');group.dataset.columnWidths='';table.prepend(group);}
  if(group.children.length!==widths.length)group.replaceChildren(...widths.map(()=>doc.createElement('col')));
  widths.forEach((width,i)=>{const size=width+'px';if(group.children[i].style.width!==size)group.children[i].style.width=size;});
  const size=widths.reduce((a,b)=>a+b,0)+'px';if(table.style.width!==size)table.style.width=size;
  table._columnWidths=widths;
  headers(table).forEach((th,i)=>{const handle=th.querySelector('[data-column-resizer]');if(handle)handle.setAttribute('aria-valuenow',Math.round(widths[i]));});
 }
 function refresh(){
  if(disposed)return;
  for(const table of tables()){
   const columns=definition(table);if(!columns.length||columns.some(c=>!c.key))continue;
   const widths=validColumnPreferences(preferences,columns.map(c=>c.key))||fitColumnWidths(columns,table.parentElement.clientWidth);
   headers(table).forEach((th,i)=>{
    if(initialized.has(th))return;initialized.add(th);
    const handle=doc.createElement('span');handle.className='table-column-resizer';handle.dataset.columnResizer=String(i);handle.tabIndex=0;
    handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','Resize '+columns[i].label+' column');
    handle.setAttribute('aria-valuemin','48');handle.setAttribute('aria-valuemax','2000');handle.title='Drag to resize. Arrow keys also resize.';th.append(handle);
   });
   apply(table,widths);
  }
 }
 function down(event){
  const handle=event.target.closest('[data-column-resizer]');if(!handle||event.button!==0)return;
  const table=handle.closest('table');event.preventDefault();handle.focus();
  drag={table,handle,index:Number(handle.dataset.columnResizer),x:event.clientX,widths:[...table._columnWidths],pointerId:event.pointerId};
  handle.setPointerCapture?.(event.pointerId);table.classList.add('table-resizing');
 }
 function move(event){
  if(!drag||event.pointerId!==drag.pointerId)return;
  apply(drag.table,changedColumnWidths(drag.widths,drag.index,event.clientX-drag.x));
 }
 function finish(event){
  if(!drag||event&&event.pointerId!==drag.pointerId)return;
  const current=drag;drag=null;current.table.classList.remove('table-resizing');
  if(current.handle.hasPointerCapture?.(current.pointerId))current.handle.releasePointerCapture(current.pointerId);
  persist(definition(current.table),current.table._columnWidths);
 }
 function key(event){
  const handle=event.target.closest('[data-column-resizer]');if(!handle||!['ArrowLeft','ArrowRight'].includes(event.key))return;
  event.preventDefault();const table=handle.closest('table');
  const widths=changedColumnWidths(table._columnWidths,Number(handle.dataset.columnResizer),(event.key==='ArrowRight'?1:-1)*(event.shiftKey?50:10));
  persist(definition(table),widths);apply(table,widths);
 }
 function click(event){
  if(event.target.closest('[data-column-resizer]')){event.preventDefault();event.stopPropagation();}
  if(!event.target.closest('[data-fit-columns]'))return;
  finish();preferences=null;try{storage.removeItem(storageKey);}catch{}
  refresh();
 }
 // Header replacements (sorting/selection) and background refreshes retain widths.
 const observer=new view.MutationObserver(refresh);observer.observe(root,{childList:true,subtree:true});
 const resize=new view.ResizeObserver(()=>{if(!drag)refresh();});resize.observe(root);
 root.addEventListener('pointerdown',down);root.addEventListener('keydown',key);root.addEventListener('click',click);
 view.addEventListener('pointermove',move);view.addEventListener('pointerup',finish);view.addEventListener('pointercancel',finish);
 refresh();
 return ()=>{
  finish();disposed=true;observer.disconnect();resize.disconnect();
  root.removeEventListener('pointerdown',down);root.removeEventListener('keydown',key);root.removeEventListener('click',click);
  view.removeEventListener('pointermove',move);view.removeEventListener('pointerup',finish);view.removeEventListener('pointercancel',finish);
 };
}
