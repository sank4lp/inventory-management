import {locationGroupFields,locationGroupValues,updateLocationGroupFields} from './location-groups.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const option=(value,label,selected)=>`<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`;
const table=(headers,rows,kind='')=>`<div class="ui-table-scroll" data-mobile-table="scroll"><table class="ui-table excel-table ${kind}"><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
function customFields(fields,values={},product=false){
  return fields.map(f=>{
    const key=product?f.id:f.field_key,type=product?f.data_type:f.field_type,value=values[key]??'',required=f.required?'required':'',choices=product?f.options||[]:JSON.parse(f.options_json||'[]');
    const control=type==='select'?`<select data-attribute="${esc(key)}" data-searchable ${required}>${option('','Choose',value)}${choices.map(v=>option(v,v,value)).join('')}</select>`:type==='boolean'?`<select data-attribute="${esc(key)}" ${required}>${option('','Choose',value)}${option('true','Yes',String(value))}${option('false','No',String(value))}</select>`:`<input data-attribute="${esc(key)}" type="${type==='number'?'number':type==='date'?'date':'text'}" ${type==='number'?'step="any"':''} value="${esc(value)}" ${required}>`;
    return `<label>${esc(f.label)}${control}</label>`;
  }).join('');
}

export async function mount(){
  const root=document.querySelector('#warehouse-excel');if(!root)return;
  const scope=globalThis.WarehousePageLifecycle?.current;
  const listen=(target,...args)=>scope?scope.listen(target,...args):target.addEventListener(...args);
  let draft=null,choices=null,checked=null,dialog=null,busy=false,displayIds=new Map(),frame=null,completed=false;
  const api=async(path,input)=>{
    const r=await(scope?scope.fetch(path,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(input)}):fetch(path,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(input)}));
    let result;try{result=await r.json();}catch{throw new Error('The server did not respond. Your import has not been confirmed. Retry when connected.');}
    if(!r.ok||result.error)throw new Error(result.error||'The request could not be completed.');return result;
  };
  async function stopLights(){
    for(const [controllerId,displayId] of displayIds){await api('/api/displays/stop',{displayId});displayIds.delete(controllerId);}
  }
  function modal(title,content){
    if(!dialog){dialog=document.createElement('dialog');dialog.className='task-edit-dialog excel-dialog ui-template';document.body.append(dialog);listen(dialog,'cancel',e=>{e.preventDefault();back();});listen(dialog,'click',click);listen(dialog,'change',change);listen(dialog,'submit',submit);}
    dialog.innerHTML=`<header class="review-task-header"><button type="button" class="secondary" data-excel-back aria-label="Back">←</button><h2>${esc(title)}</h2><button type="button" class="dialog-dismiss" data-excel-close aria-label="Close">×</button></header>${content}<p data-dialog-error role="alert"></p>`;
    if(!dialog.open)dialog.showModal();dialog.scrollTop=0;
  }
  function errorMessage(error){const target=dialog?.open?dialog.querySelector('[data-dialog-error]'):root.querySelector('[data-excel-error]');if(target){target.textContent=error.message;target.scrollIntoView({block:'nearest'});}}
  function setBusy(value){busy=value;if(dialog)dialog.querySelectorAll('button,fieldset').forEach(el=>el.disabled=value);root.querySelector('[data-excel-upload] button').disabled=value;}
  async function back(){if(busy)return;try{await stopLights();history.back();}catch(error){errorMessage(error);}}
  async function close(){if(busy)return;try{await stopLights();if(history.state?.excelImport?.id===frame)history.go(history.state.excelImport.step==='review'?-2:-1);else dialog?.close();}catch(error){errorMessage(error);}}
  const unknownLocations=()=>draft.locations.filter(l=>!l.existingId);
  const unknownProducts=()=>draft.products.filter(p=>!p.existing);
  function locationDetail(index){
    const group=unknownLocations()[index],saved=choices?.locations?.find(v=>v.key===group.key)||{},row=dialog.querySelector(`[data-location-row="${index}"]`),selected=row.querySelector('[data-use-location]').value,body=row.querySelector('[data-location-details]');
    if(selected!=='new'){body.innerHTML=selected?'<span class="muted">Uses the existing location.</span>':'';return;}
    const map=draft.choices.controllers.find(c=>c.id===Number(saved.controllerId)||!saved.controllerId&&c.name===group.mapping?.controller);
    const shelf=draft.choices.shelves.find(s=>s.name===group.mapping?.shelf&&draft.choices.warehouses.some(w=>w.id===s.warehouse_id&&w.name===group.mapping?.warehouse));
    body.innerHTML=`<div class="excel-field-grid"><label class="excel-create-check"><input type="checkbox" data-create-location ${saved.confirmed?'checked':''} required> Create this location</label><label>Location name<input data-location-name value="${esc(saved.displayName||group.name)}" maxlength="160" required></label><label>Controller<select data-controller data-searchable required>${option('','Choose controller',map?.id)}${draft.choices.controllers.map(c=>option(c.id,c.name||c.controller_code,map?.id)).join('')}</select></label><label>Physical LED<select data-physical data-searchable required></select></label>${draft.capabilities.lights?'<button type="button" class="secondary" data-light-numbers>Show LED numbers</button>':''}<div class="excel-location-groups">${locationGroupFields(draft.choices,{warehouse_name:saved.warehouseName||group.mapping?.warehouse,travel_instructions:saved.travelInstructions||group.mapping?.shelf,shelf_id:saved.shelfId||shelf?.id})}</div>${customFields(draft.choices.locationFields,saved.attributes)}</div>`;
    if(saved.warehouseId){body.querySelector('[data-location-warehouse]').value=saved.warehouseId;updateLocationGroupFields(body.querySelector('[data-location-warehouse]'),draft.choices);body.querySelector('[data-location-shelf]').value=saved.shelfId||'';updateLocationGroupFields(body.querySelector('[data-location-shelf]'),draft.choices);if(saved.newShelfName)body.querySelector('[name="newShelfName"]').value=saved.newShelfName;}
    fillPhysical(row,saved.physical||group.mapping?.physical);
  }
  function fillPhysical(row,selected=''){
    const id=Number(row.querySelector('[data-controller]').value),map=draft.choices.controllers.find(c=>c.id===id),select=row.querySelector('[data-physical]');
    select.innerHTML=option('','Choose LED',selected)+(map?.leds||[]).map(l=>`<option value="${l.physical}" ${l.cellId?'disabled':''} ${Number(selected)===l.physical?'selected':''}>${esc('LED '+l.physical+(l.cellId?' · '+l.name:''))}</option>`).join('');
    const button=row.querySelector('[data-light-numbers]');if(button){button.disabled=!map||!!map.error;button.textContent=displayIds.has(id)?'Stop LED numbers':'Show LED numbers';}
  }
  function resolveScreen(){
    const locations=unknownLocations(),products=unknownProducts();
    const locationRows=locations.map((l,index)=>{const saved=choices?.locations?.find(v=>v.key===l.key),selected=saved?.create?'new':saved?.existingId||'';return `<tr data-location-row="${index}"><td>${esc(l.name)}<small>${l.rows.length} ${l.rows.length===1?'row':'rows'}</small></td><td><label class="sr-only" for="excel-location-${index}">Location for ${esc(l.name)}</label><select id="excel-location-${index}" data-use-location data-searchable required>${option('','Choose existing or new',selected)}${draft.choices.cells.map(c=>option(c.id,c.name,selected)).join('')}${draft.capabilities.locations?option('new','+ Create new location',selected):''}</select></td><td data-location-details></td></tr>`;});
    const productRows=products.map((p,index)=>{const v=choices?.products?.find(v=>v.key===p.key)||p;return `<tr data-product-row="${index}"><td><label><input type="checkbox" data-new-product ${v.confirmed?'checked':''} required aria-label="Create ${esc(p.name||p.sku)}"> Create</label></td><td><div class="excel-field-grid"><label>SKU<input data-product="sku" value="${esc(v.sku)}" maxlength="160" required></label><label>Name<input data-product="name" value="${esc(v.name)}" maxlength="300" required></label></div></td><td><div class="excel-field-grid"><label>Unit<input data-product="unit" value="${esc(v.unit)}" required></label><label>Items per location<input type="number" min="0.000001" max="1000000000" step="any" data-product="itemsPerCell" value="${esc(v.itemsPerCell)}" required></label><label>Brand<input data-product="brand" value="${esc(v.brand)}" required></label><label>Category<input data-product="category" value="${esc(v.category)}"></label><label>Variant<input data-product="variant" value="${esc(v.variant)}"></label><label>Description<input data-product="description" value="${esc(v.description)}"></label>${customFields(draft.choices.productFields,v.attributes,true)}</div></td></tr>`;});
    modal('Review Excel file',`<form data-excel-resolve><fieldset><p>${esc(draft.fileName)} · ${draft.rows.mapping} mapping rows · ${draft.rows.stock} product rows</p>${locations.length?`<h3>Resolve location names</h3>${table(['In Excel','Use location','New location details'],locationRows,'excel-location-table')}`:'<p>All location names match existing locations.</p>'}${products.length?`<h3>Confirm new products</h3>${table(['Confirm','Product','Details'],productRows,'excel-product-table')}`:'<p>All SKUs match existing products.</p>'}${draft.rows.stock?`<div class="excel-field-grid excel-counter"><label>Stocktaking assigned to<select data-counter data-searchable>${option('','Choose counter',choices?.counterIds?.[0])}${draft.choices.counters.map(u=>option(u.id,u.name+' · '+u.role,choices?.counterIds?.[0])).join('')}</select></label><label>Due date<input type="date" data-due value="${esc(choices?.dueDate??draft.choices.dueDate??'')}"></label><small>Used only for quantity mismatches.</small></div>`:''}<div class="ui-actions"><button type="submit">Check import</button></div></fieldset></form>`);
    locations.forEach((_,index)=>locationDetail(index));
  }
  function collect(){
    const attributes=host=>Object.fromEntries([...host.querySelectorAll('[data-attribute]')].map(el=>[el.dataset.attribute,el.value==='true'?true:el.value==='false'?false:el.value]));
    return {id:draft.id,locations:unknownLocations().map((group,index)=>{
      const row=dialog.querySelector(`[data-location-row="${index}"]`),value=row.querySelector('[data-use-location]').value;
      return value!=='new'?{key:group.key,existingId:Number(value)}:{key:group.key,create:true,confirmed:row.querySelector('[data-create-location]').checked,displayName:row.querySelector('[data-location-name]').value,controllerId:Number(row.querySelector('[data-controller]').value),physical:Number(row.querySelector('[data-physical]').value),...locationGroupValues(row),attributes:attributes(row)};
    }),products:unknownProducts().map((group,index)=>{const row=dialog.querySelector(`[data-product-row="${index}"]`);return {key:group.key,confirmed:row.querySelector('[data-new-product]').checked,...Object.fromEntries([...row.querySelectorAll('[data-product]')].map(el=>[el.dataset.product,el.value])),attributes:attributes(row)};}),counterIds:dialog.querySelector('[data-counter]')?.value?[Number(dialog.querySelector('[data-counter]').value)]:[],dueDate:dialog.querySelector('[data-due]')?.value||''};
  }
  function summaryScreen(){
    const s=checked.summary;
    const newRows=[...s.newLocations.map(l=>`<tr><td>Location</td><td>${esc(l.name)}</td></tr>`),...s.newProducts.map(p=>`<tr><td>Product</td><td>${esc(p.sku)} · ${esc(p.name)}</td></tr>`)];
    const mappings=s.mappingChanges.map(m=>`<tr><td>${esc(m.cell)}</td><td>${esc(m.controller)}</td><td>${m.physical}</td></tr>`);
    const counts=s.stocktakes.flatMap(p=>p.cells.map(c=>`<tr><td>${esc(p.name)}<small>${esc(p.sku)}</small></td><td>${esc(c.cell)}</td><td>${c.recorded}</td><td>${c.imported}</td><td>${esc(p.unit)}</td></tr>`));
    modal('Confirm import',`<p>Stock quantities will stay unchanged. Only mismatched bins will be counted.</p>${newRows.length?`<h3>Create</h3>${table(['Type','Name'],newRows)}`:''}${mappings.length?`<h3>LED mappings</h3>${table(['Bin','Controller','Physical LED'],mappings)}`:''}${counts.length?`<h3>Stocktaking</h3>${table(['Product','Bin','In system','In Excel','Unit'],counts)}<p>${s.stocktakes.filter(p=>p.runId).length} new stocktake(s)${s.stocktakes.some(p=>p.existingRunIds.length)?' · Existing pending counts will be reused.':''}</p>`:'<p>Stock counts match. No stocktakes needed.</p>'}<div class="ui-actions"><button type="button" data-excel-apply>Save import</button><button type="button" class="secondary" data-excel-back>Back</button></div>`);
  }
  async function submit(event){
    if(!event.target.matches('[data-excel-resolve]'))return;event.preventDefault();if(busy)return;
    choices=collect();setBusy(true);
    try{await stopLights();checked=await api('/api/warehouse-excel/review',choices);history.pushState({...history.state,excelImport:{id:frame,step:'review'}},'');summaryScreen();}
    catch(error){errorMessage(error);}finally{setBusy(false);}
  }
  async function click(event){
    const button=event.target.closest('button');if(!button||busy)return;
    if(button.hasAttribute('data-excel-close'))return close();if(button.hasAttribute('data-excel-back'))return back();
    if(button.hasAttribute('data-light-numbers')){
      const row=button.closest('[data-location-row]'),controllerId=Number(row.querySelector('[data-controller]').value);setBusy(true);
      try{if(displayIds.has(controllerId)){await api('/api/displays/stop',{displayId:displayIds.get(controllerId)});displayIds.delete(controllerId);}else{const result=await api('/api/location-setup/displayLedNumbers',{controllerId,requestId:crypto.randomUUID()});displayIds.set(controllerId,result.id);}}
      catch(error){errorMessage(error);}finally{setBusy(false);for(const r of dialog.querySelectorAll('[data-location-row]'))if(r.querySelector('[data-controller]'))fillPhysical(r,r.querySelector('[data-physical]').value);}
    }
    if(button.hasAttribute('data-excel-apply')){
      setBusy(true);
      try{
        const result=await api('/api/warehouse-excel/apply',{id:checked.id,token:checked.token,confirmed:true});
        const host=root.querySelector('[data-excel-result]');host.hidden=false;host.innerHTML=`<section class="ui-panel"><h2>Import saved</h2><p>${result.newLocations.length} new location(s) · ${result.newProducts.length} new product(s) · ${result.mappingChanges.length} LED mapping(s)</p><p>Stock quantities are unchanged.</p>${result.warning?`<p role="alert">${esc(result.warning)}</p>`:''}${result.stocktakes.length?table(['Product','Stocktaking'],result.stocktakes.map(p=>`<tr><td>${esc(p.name)}</td><td>${[p.runId,...p.existingRunIds].filter(Boolean).map(id=>`<a href="/stocktaking?run=${id}">Stocktake #${id}</a>`).join(' · ')}</td></tr>`)):'<p>No stocktakes were needed.</p>'}</section>`;
        completed=true;dialog.close();dialog.replaceChildren();history.go(-2);host.scrollIntoView({block:'nearest'});
      }catch(error){errorMessage(error);}finally{setBusy(false);}
    }
  }
  function change(event){
    if(event.target.matches('[data-use-location]'))locationDetail(Number(event.target.closest('[data-location-row]').dataset.locationRow));
    if(event.target.matches('[data-controller]'))fillPhysical(event.target.closest('[data-location-row]'));
    if(event.target.closest('[data-location-groups]'))updateLocationGroupFields(event.target,draft.choices);
  }
  listen(root.querySelector('[data-excel-upload]'),'submit',async event=>{
    event.preventDefault();if(busy)return;const file=event.target.elements.workbook.files[0];if(!file)return;
    setBusy(true);root.querySelector('[data-excel-error]').textContent='';
    try{
      if(file.size>6*1024*1024)throw new Error('Choose an Excel file smaller than 6 MB.');
      const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('The file could not be read.'));reader.readAsDataURL(file);});
      draft=await api('/api/warehouse-excel/upload',{fileName:file.name,base64});choices=null;checked=null;completed=false;frame=crypto.randomUUID();history.pushState({...history.state,excelImport:{id:frame,step:'resolve'}},'');resolveScreen();
    }catch(error){errorMessage(error);}finally{setBusy(false);}
  });
  listen(window,'popstate',()=>{if(!dialog||!frame)return;const state=history.state?.excelImport;if(completed||state?.id!==frame){dialog.close();void stopLights().catch(errorMessage);}else if(state.step==='resolve')resolveScreen();else if(checked)summaryScreen();});
  scope?.guardLeave(()=>!busy);
  scope?.own(()=>{
    dialog?.remove();for(const displayId of displayIds.values())globalThis.fetch('/api/displays/stop',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({displayId})}).catch(()=>{});
    if(history.state?.excelImport?.id===frame){const state={...history.state};delete state.excelImport;history.replaceState(state,'');}
  });
}
if(typeof document!=='undefined')await mount();
