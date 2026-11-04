const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function shelfOptions(hierarchy,warehouseId,selected='') {
 return '<option value="">Choose shed/shelf</option>'+(hierarchy.shelves||[]).filter(s=>s.warehouse_id===Number(warehouseId)).map(s=>`<option value="${s.id}" ${String(s.id)===String(selected)?'selected':''}>${escapeHtml(s.name)}</option>`).join('')+'<option value="new">+ Add new shed/shelf</option>';
}
export function locationGroupFields(hierarchy={},current={}) {
 const warehouses=hierarchy.warehouses||[];
 const warehouse=warehouses.find(w=>w.name===current.warehouse_name)||warehouses.find(w=>w.name==='Default Warehouse')||warehouses[0];
 return `<div class="location-group-fields" data-location-groups><label>Warehouse<select name="warehouseId" data-location-warehouse data-searchable required>${warehouses.map(w=>`<option value="${w.id}" ${w.id===warehouse?.id?'selected':''}>${escapeHtml(w.name)}</option>`).join('')}</select></label><label>Shed/Shelf<select name="shelfId" data-location-shelf data-searchable required>${shelfOptions(hierarchy,warehouse?.id,current.shelf_id)}</select></label><label data-new-shelf hidden>New shed/shelf name<input name="newShelfName" maxlength="1000" disabled></label></div>`;
}
export function updateLocationGroupFields(target,hierarchy={}) {
 const group=target.closest('[data-location-groups]');if(!group)return;
 const shelf=group.querySelector('[data-location-shelf]');
 if(target.matches('[data-location-warehouse]'))shelf.innerHTML=shelfOptions(hierarchy,target.value);
 const field=group.querySelector('[data-new-shelf]'),input=field.querySelector('input'),adding=shelf.value==='new';
 field.hidden=!adding;input.disabled=!adding;input.required=adding;
 if(adding&&target===shelf)input.focus();
}
export function locationGroupValues(host) {
 const group=host.querySelector('[data-location-groups]');if(!group)return {};
 return {warehouseId:group.querySelector('[name="warehouseId"]').value,shelfId:group.querySelector('[name="shelfId"]').value,...(group.querySelector('[name="shelfId"]').value==='new'?{newShelfName:group.querySelector('[name="newShelfName"]').value}:{})};
}
