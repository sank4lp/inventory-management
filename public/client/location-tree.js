const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const same=(a,b)=>String(a)===String(b);
const cellCount=n=>`${n} ${n===1?'cell':'cells'}`;
const icon=kind=>`<svg class="location-level-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${kind==='warehouse'?'<path d="m3 9 9-6 9 6v12H3Z"/><path d="M8 21V11h8v10M8 15h8M8 18h8M10 7h4"/>':'<path d="M4 3v18M20 3v18M4 8h16M4 14h16M4 20h16M8 5v3M15 10v4M9 16v4"/>'}</svg>`;
const chevron='<svg class="location-disclosure" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 10 4 4 4-4"/></svg>';
function groupHeading(kind,name,count,shelves=0){
 return `${icon(kind)}<span class="location-group-title"><span class="location-level-label">${kind==='warehouse'?'Warehouse':'Shed / Shelf'}</span><span data-group-label>${e(name)}</span></span><span class="location-group-count">${kind==='warehouse'?`${shelves} ${shelves===1?'shed/shelf':'sheds/shelves'} · `:''}${cellCount(count)}</span>${chevron}`;
}
function groupDisplays(kind,id,name,capabilities,editing) {
 if(editing)return '';
 const scope=kind==='warehouse'?'warehouse':'shelf';
 const choices=[['cell_name','Show cell names','Hide cell names','locations.locate'],['module_number','Show LED numbers','Hide LED numbers','hardware.test'],['quantity','Show quantities','Hide quantities','locations.quantity']];
 const buttons=choices.filter(([, , ,permission])=>capabilities.includes(permission)).map(([display,label,active])=>`<button type="button" class="ghost-button count-button" data-show-product-quantity data-quantity-key="${scope}:${e(id)}:${display}" data-${scope}-id="${e(id)}" data-display-kind="${display}" data-activate-endpoint="/api/displays/start" data-clear-endpoint="/api/displays/stop" data-show-label="${label}" data-active-label="${active}" data-active-title="Click again to stop this LED display." aria-pressed="false" title="${label} on every mapped LED in ${e(name)}">${label}</button>`).join('');
 return buttons?`<div class="location-group-displays" role="group" aria-label="LED displays for ${e(name)}">${buttons}</div>`:'';
}
// The same renderer owns view and edit mode, including the disclosure and drag targets.
export function locationTree(layout,cards,{editing=false,open=null,showEmpty=true,displayCapabilities=[]}={}) {
 const opened=(kind,id)=>!open||open.has(kind+':'+id)?'open':'';
 const handle=(kind,id,name)=>editing?`<button type="button" class="location-drag-handle" data-drag-kind="${kind}" data-drag-id="${e(id)}" aria-label="Drag ${e(name)}" title="Drag to move, or use the dropdown">⠿</button>`:'';
 const warehouses=layout.warehouses.filter(w=>showEmpty||layout.shelves.some(s=>same(s.warehouse_id,w.id)&&layout.cells.some(c=>same(c.shelf_id,s.id))));
 return warehouses.map(w=>{
  const shelves=layout.shelves.filter(s=>same(s.warehouse_id,w.id)&&(showEmpty||layout.cells.some(c=>same(c.shelf_id,s.id))));
  const count=layout.cells.filter(c=>shelves.some(s=>same(c.shelf_id,s.id))).length;
  return `<details class="location-warehouse" data-warehouse-zone="${e(w.id)}" ${opened('warehouse',w.id)}><summary>${groupHeading('warehouse',w.name,count,shelves.length)}</summary>${groupDisplays('warehouse',w.id,w.name,displayCapabilities,editing)}${editing?`<div class="location-group-editor"><label>Warehouse name<input data-warehouse-name="${e(w.id)}" value="${e(w.name)}" maxlength="160" required></label><button type="button" class="secondary" data-add-shelf="${e(w.id)}">Add shed/shelf</button></div>`:''}<div class="location-shelves">${shelves.map(s=>{
   const cells=layout.cells.filter(c=>same(c.shelf_id,s.id));
   return `<details class="location-shelf" data-shelf-zone="${e(s.id)}" ${opened('shelf',s.id)}><summary>${groupHeading('shelf',s.name,cells.length)}</summary>${groupDisplays('shelf',s.id,s.name,displayCapabilities,editing)}${editing?`<div class="location-group-editor">${handle('shelf',s.id,s.name)}<label>Shed/Shelf name<input data-shelf-name="${e(s.id)}" value="${e(s.name)}" maxlength="1000" required></label><label>Warehouse<select data-shelf-warehouse="${e(s.id)}" data-searchable required>${layout.warehouses.map(v=>`<option value="${e(v.id)}" ${same(v.id,s.warehouse_id)?'selected':''}>${e(v.name)}</option>`).join('')}</select></label></div>`:''}<div class="location-cell-grid">${cells.map(c=>`<div class="location-tree-cell" data-tree-cell="${e(c.id)}">${cards[c.id]||''}${editing?`<div class="location-cell-editor">${handle('cell',c.id,c.display_name||c.logical_code)}<label>Move to shed/shelf<select data-cell-shelf="${e(c.id)}" data-searchable required>${layout.shelves.map(v=>`<option value="${e(v.id)}" ${same(v.id,c.shelf_id)?'selected':''}>${e(layout.warehouses.find(w=>same(w.id,v.warehouse_id))?.name)} / ${e(v.name)}</option>`).join('')}</select></label></div>`:''}</div>`).join('')||'<p class="location-empty">No cells in this shed/shelf.</p>'}</div></details>`;
  }).join('')||'<p class="location-empty">No sheds/shelves yet.</p>'}</div></details>`;
 }).join('')||'<p>No locations match this search.</p>';
}
