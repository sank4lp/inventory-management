const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const same=(a,b)=>String(a)===String(b);
const cellCount=n=>`${n} ${n===1?'cell':'cells'}`;
// The server and edit mode share this tree so collapsed groups and cards stay consistent.
export function locationTree(layout,cards,{editing=false,open=null,showEmpty=true}={}) {
 const opened=(kind,id)=>!open||open.has(kind+':'+id)?'open':'';
 const handle=(kind,id,name)=>editing?`<button type="button" class="location-drag-handle" data-drag-kind="${kind}" data-drag-id="${e(id)}" aria-label="Drag ${e(name)}" title="Drag to move, or use the dropdown">⠿</button>`:'';
 const warehouses=layout.warehouses.filter(w=>showEmpty||layout.shelves.some(s=>same(s.warehouse_id,w.id)&&layout.cells.some(c=>same(c.shelf_id,s.id))));
 return warehouses.map(w=>{
  const shelves=layout.shelves.filter(s=>same(s.warehouse_id,w.id)&&(showEmpty||layout.cells.some(c=>same(c.shelf_id,s.id))));
  const count=layout.cells.filter(c=>shelves.some(s=>same(c.shelf_id,s.id))).length;
  return `<details class="location-warehouse" data-warehouse-zone="${e(w.id)}" ${opened('warehouse',w.id)}><summary><span data-group-label>${e(w.name)}</span><small>${cellCount(count)}</small></summary>${editing?`<div class="location-group-editor"><label>Warehouse name<input data-warehouse-name="${e(w.id)}" value="${e(w.name)}" maxlength="160" required></label><button type="button" class="secondary" data-add-shelf="${e(w.id)}">Add shed/shelf</button></div>`:''}<div class="location-shelves">${shelves.map(s=>{
   const cells=layout.cells.filter(c=>same(c.shelf_id,s.id));
   return `<details class="location-shelf" data-shelf-zone="${e(s.id)}" ${opened('shelf',s.id)}><summary><span data-group-label>${e(s.name)}</span><small>${cellCount(cells.length)}</small></summary>${editing?`<div class="location-group-editor">${handle('shelf',s.id,s.name)}<label>Shed/Shelf name<input data-shelf-name="${e(s.id)}" value="${e(s.name)}" maxlength="1000" required></label><label>Warehouse<select data-shelf-warehouse="${e(s.id)}" data-searchable required>${layout.warehouses.map(v=>`<option value="${e(v.id)}" ${same(v.id,s.warehouse_id)?'selected':''}>${e(v.name)}</option>`).join('')}</select></label></div>`:''}<div class="location-cell-grid">${cells.map(c=>`<div class="location-tree-cell" data-tree-cell="${e(c.id)}">${cards[c.id]||''}${editing?`<div class="location-cell-editor">${handle('cell',c.id,c.display_name||c.logical_code)}<label>Move to shed/shelf<select data-cell-shelf="${e(c.id)}" data-searchable required>${layout.shelves.map(v=>`<option value="${e(v.id)}" ${same(v.id,c.shelf_id)?'selected':''}>${e(layout.warehouses.find(w=>same(w.id,v.warehouse_id))?.name)} / ${e(v.name)}</option>`).join('')}</select></label></div>`:''}</div>`).join('')||'<p class="location-empty">No cells in this shed/shelf.</p>'}</div></details>`;
  }).join('')||'<p class="location-empty">No sheds/shelves yet.</p>'}</div></details>`;
 }).join('')||'<p>No locations match this search.</p>';
}
