const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const option=(value,label,selected)=>`<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`;
const table=(headers,rows)=>`<div class="table-wrap business-import-table"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const columns={issue:[['comp_no','Computer Number'],['gs_no','Issue Number'],['issu_dt','Issue Date'],['sub_depot','Sub Depot'],['cos_sec','Section'],['part_no','Part Number'],['nomen1','Nomenclature'],['auth','Description'],['qty_iss','Quantity Issued'],['au','AU'],['cust_code','Customer Code'],['cust','Customer'],['sus_no','Sus Number']],received:[['comp_no','Computer Number'],['rv_no','Received Number'],['rv_dt','Received Date'],['sub_depot','Sub Depot'],['cos_sec','Section'],['part_no','Part Number'],['condition','Condition'],['nomen1','Nomenclature'],['qty_r','Quantity Received'],['au','AU'],['cust_code','Customer Code'],['cust','Customer'],['sus_no','Sus Number'],['created_by','Created By'],['inspected_by','Inspected By']]};
// Bound rendered controls independently of file size; row numbers remain Excel row IDs.
export function importPage(rows,page=0,size=50){
 size=[20,50,100].includes(Number(size))?Number(size):50;
 const pages=Math.max(1,Math.ceil(rows.length/size));page=Math.max(0,Math.min(pages-1,Number(page)||0));
 return {rows:rows.slice(page*size,(page+1)*size),page,size,pages,total:rows.length,start:rows.length?page*size+1:0,end:Math.min((page+1)*size,rows.length)};
}
export function mergeImportChoices(previous,visible){
 const rows=new Map((previous.rows||[]).map(row=>[row.row,row]));
 for(const row of visible.rows||[])rows.set(row.row,{...rows.get(row.row),...row});
 return {...previous,...visible,rows:[...rows.values()]};
}
const pager=(info,view)=>`<nav class="business-import-pager" aria-label="Import rows"><span role="status">Rows ${info.start}–${info.end} of ${info.total} · Page ${info.page+1} of ${info.pages}</span><label>Rows per page<select data-import-page-size="${view}">${[20,50,100].map(n=>option(n,n,info.size)).join('')}</select></label><button type="button" class="secondary" data-import-page="${info.page-1}" data-import-view="${view}" ${info.page===0?'disabled':''}>Previous</button><button type="button" class="secondary" data-import-page="${info.page+1}" data-import-view="${view}" ${info.page+1===info.pages?'disabled':''}>Next</button></nav>`;
export function importRowPresentation(row,saved=false) {
 const status=row.status==='blocked'&&row.issueCode==='STOCKTAKE_ASSIGNEE_REQUIRED'?'assignment_required':['ready','blocked','existing','excluded','excluded_uns'].includes(row.status)?row.status:'blocked';
 const label={ready:saved?'Saved':'Valid — ready to save',blocked:'Invalid — not saved',assignment_required:'Stocktake assignment required — not saved',existing:'Already imported',excluded:'Skipped',excluded_uns:'Excluded — UNS'}[status];
 const message=String(row.message||row.errors?.join(' ')||(status==='blocked'?'This row could not be validated. Go back to the rows and check the import again.':''));
 return {status,label,message};
}
export function stocktakeAssignmentNotice(result){
 const count=(result.rows||[]).filter(r=>r.status==='blocked'&&r.issueCode==='STOCKTAKE_ASSIGNEE_REQUIRED').length;
 return count?`<p role="status" class="import-assignment-notice">${count} row(s) need a stocktake assignee, not a correction to the product data. Go back to rows and choose <strong>Stocktaking assigned to</strong>, or select <strong>Products only — skip stocktaking</strong>. These rows have not been saved.</p>`:'';
}
export function resultTable(result,saved=false,page=0,size=50){if(!result.rows?.length)return '';const info=importPage(result.rows,page,size);return pager(info,saved?'saved':'confirm')+table(['Row','Validation','Section (cos_sec)','Part Number (part_no)','Nomenclature (nomen1)','MPI Status (mpi_status)','Details / reason','Task / Stocktake'],info.rows.map(r=>`<tr data-import-status="${esc(importRowPresentation(r,saved).status)}"><td>${esc(r.row)}</td><td><strong class="import-row-validation">${esc(importRowPresentation(r,saved).label)}</strong></td><td>${esc(r.values.cos_sec)}</td><td>${esc(r.values.part_no)}</td><td>${saved&&r.productId?`<a href="/products/${r.productId}">${esc(r.values.nomen1)}</a>`:esc(r.values.nomen1)}</td><td>${esc(r.mpiStatus||r.values.mpi_status||'—')}</td><td>${r.productName&&r.productName!==r.values.nomen1?`<small>Uses ${saved?`<a href="/products/${r.productId}">${esc(r.productName)}</a>`:esc(r.productName)}</small>`:''}<span class="import-row-reason">${esc(importRowPresentation(r,saved).message)}</span>${r.recorded!==undefined?`<small>In system: ${esc(r.recorded)} · In Excel: ${esc(r.expected)}</small>`:''}</td><td>${r.taskId?(saved||r.status==='existing'?`<a href="/tasks/${r.taskId}">Task #${r.taskId}</a>`:'Task to create'):r.stocktakeId?(saved?`<a href="/stocktaking?run=${r.stocktakeId}">Stocktake #${r.stocktakeId}</a>`:'Stocktake to create'):'—'}</td></tr>`));}
export function currentStock(row,choice={}){
 const exact=row.variants.find(v=>v.mpi_status===row.values.mpi_status);
 const p=exact||(choice?.sourceProductId==='new'?null:row.variants.find(v=>String(v.id)===String(choice?.sourceProductId))||(row.variants.length===1?row.variants[0]:null));
 return p?p.currentStock:row.variants.length&&choice?.sourceProductId!=='new'?'Choose MPI row':'New product (0)';
}
export async function mount(){
 const root=document.querySelector('#business-import');if(!root)return;
 const scope=globalThis.WarehousePageLifecycle?.current,listen=(el,...args)=>scope?scope.listen(el,...args):el.addEventListener(...args);
 let draft=null,choices={},preview=null,dialog=null,busy=false,frame=null,mergeRows=[],editPage=0,confirmPage=0,savedPage=0,pageSize=50,savedResult=null;
 const optionSources=new Map();let optionSourceId=0;let rowChoices=new Map();
 function multi(field,label,items,selected=[],scope='row'){
  const key=String(++optionSourceId);optionSources.set(key,items);
  return `<details class="business-multiselect" data-multi="${field}" data-multi-scope="${scope}" data-option-source="${key}" data-selected="${esc(JSON.stringify(selected))}"><summary>${esc(label)} <small>${selected.length?selected.length+' selected':'Choose'}</small></summary><div><input type="search" data-option-search aria-label="Search ${esc(label)}" placeholder="Search"><div class="business-option-list"></div><small data-options-summary></small>${field==='cellIds'?'<small>New product: blank means whole shed.</small>':''}<button type="button" class="secondary" data-more-options hidden>Show more options</button></div></details>`;
 }
 function optionList(details,limit=100){
  const selected=new Set(JSON.parse(details.dataset.selected||'[]')),term=details.querySelector('[data-option-search]').value.trim().toLowerCase();
  const matches=(optionSources.get(details.dataset.optionSource)||[]).filter(v=>String(v.label||v.name).toLowerCase().includes(term));
  details.dataset.optionLimit=String(limit);
  details.querySelector('.business-option-list').innerHTML=matches.slice(0,limit).map(v=>`<label><input type="checkbox" value="${v.id}" ${selected.has(v.id)?'checked':''}>${esc(v.label||v.name)}</label>`).join('');
  details.querySelector('[data-options-summary]').textContent=`${Math.min(limit,matches.length)} of ${matches.length} options`;
  details.querySelector('[data-more-options]').hidden=matches.length<=limit;
 }
 const api=async(action,data)=>{const r=await(scope?scope.fetch('/api/business-import/'+action,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Accept:'application/json'},...(data?{body:JSON.stringify(data)}:{})}):fetch('/api/business-import/'+action,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Accept:'application/json'},...(data?{body:JSON.stringify(data)}:{})}));const body=await r.json();if(!r.ok||body.error)throw new Error(body.error||'Could not complete this request.');return body;};
 const error=e=>{const target=dialog?.open?dialog.querySelector('[data-business-error]'):root.querySelector('[data-import-error]');if(target)target.textContent=e.message;};
 function modal(title,content,push=true){
  if(!dialog){dialog=document.createElement('dialog');dialog.className='task-edit-dialog excel-dialog ui-template business-import-dialog';dialog.dataset.mobileTable='scroll';document.body.append(dialog);listen(dialog,'cancel',e=>{e.preventDefault();if(!busy)history.back();});listen(dialog,'click',click);listen(dialog,'submit',submit);listen(dialog,'change',change);listen(dialog,'toggle',event=>{const details=event.target;if(details.matches('[data-option-source]')&&details.open)optionList(details);},true);listen(dialog,'input',event=>{if(event.target.matches('[data-option-search]')){const details=event.target.closest('[data-multi]');if(details.dataset.optionSource){optionList(details);return;}const term=event.target.value.toLowerCase();details.querySelectorAll('.business-option-list label').forEach(l=>l.hidden=!l.textContent.toLowerCase().includes(term));}});}
  if(push){frame=crypto.randomUUID();history.pushState({...history.state,businessImport:frame},'');}
  dialog.innerHTML=`<header class="review-task-header"><button type="button" class="secondary" data-import-back aria-label="Back">←</button><h2>${esc(title)}</h2><button type="button" class="dialog-dismiss" data-import-back aria-label="Close">×</button></header>${content}<p data-business-error role="alert"></p>`;
  if(!dialog.open)dialog.showModal();dialog.scrollTop=0;
 }
 listen(window,'popstate',()=>{if(dialog?.open&&history.state?.businessImport!==frame){dialog.close();frame=null;}});
 scope?.own(()=>{dialog?.remove();dialog=null;});
 scope?.guardLeave(()=>!busy);
 function values(row,productId=null){return draft.columns.map(([key])=>`<td>${productId&&['cos_sec','part_no','nomen1'].includes(key)?`<a href="/products/${productId}">${esc(row.values[key])}</a>`:esc(row.values[key]??'—')}</td>${draft.kind==='products'&&key==='stok_ser'?`<td data-current-stock>${esc(currentStock(row,rowChoices.get(row.row)))}</td>`:''}`).join('');}
 function rowControls(row){
  const p=rowChoices.get(row.row)||{},isProduct=draft.kind==='products',uns=draft.kind==='received'&&String(row.values.condition).trim().toUpperCase()==='UNS';
  if(uns)return '<span>UNS — no Put task. MPI: CURRENT.</span>';
  const mpi=isProduct?row.values.mpi_status:draft.kind==='received'?'CURRENT':p.mpiStatus||choices.mpiStatus||'CURRENT',exact=row.variants.find(v=>v.mpi_status===mpi);
  const chooseSource=isProduct&&!exact&&row.variants.length>0;
  if(chooseSource&&!p.sourceProductId&&row.variants.length===1)p.sourceProductId=row.variants[0].id;
  return `<div class="business-row-controls">${row.rememberedProduct?`<small>Uses <a href="/products/${row.rememberedProduct.id}">${esc(row.rememberedProduct.name)}</a></small>`:''}${draft.kind==='issue'?`<label>MPI Status (mpi_status)<select data-row-field="mpiStatus" data-searchable>${draft.choices.mpi.map(v=>option(v,v,mpi)).join('')}</select></label>`:!isProduct?'<span>MPI Status: CURRENT</span>':''}${chooseSource?`<label>Update MPI row<select data-row-field="sourceProductId" data-searchable>${option('','Choose',p.sourceProductId)}${row.variants.map(v=>option(v.id,v.mpi_status,p.sourceProductId)).join('')}${option('new','Add new status',p.sourceProductId)}</select></label>`:''}<label class="checkbox-line"><input type="checkbox" data-row-field="createConfirmed" ${p.createConfirmed?'checked':''}>Create if new</label><label>Items per location<input type="number" min="0.000001" step="any" data-row-field="itemsPerCell" value="${esc(p.itemsPerCell??(exact&&!exact.capacity_pending?exact.items_per_cell:''))}" placeholder="${isProduct?'Set during stocktake':'Required for new Put'}"></label>${isProduct?`<div data-stocktake-options ${choices.skipStocktake?'hidden':''}>${multi('cellIds','Locations to count',draft.choices.cells,p.cellIds||[])}</div>`:''}${row.existingLine?.task_id?`<label class="checkbox-line"><input type="checkbox" data-row-field="updateConfirmed" ${p.updateConfirmed?'checked':''}>Update unstarted Task #${row.existingLine.task_id} if changed</label>`:''}${!isProduct?`<label class="checkbox-line"><input type="checkbox" data-row-field="skip" ${p.skip?'checked':''}>Skip this row</label>`:""}</div>`;
 }
 function reviewScreen(push=true){
  const isProduct=draft.kind==='products',info=importPage(draft.rows,editPage,pageSize);editPage=info.page;optionSources.clear();rowChoices=new Map((choices.rows||[]).map(row=>[row.row,row]));
  modal('Review '+(isProduct?'products':draft.kind==='issue'?'Issue Voucher':'Received Voucher'),`<form data-import-review><fieldset><div class="business-import-options">${isProduct?`<label class="checkbox-line"><input type="checkbox" data-global="skipStocktake" ${choices.skipStocktake?'checked':''}>Products only — skip stocktaking</label><div class="business-import-options" data-stocktake-options ${choices.skipStocktake?'hidden':''}>${multi('counterIds','Stocktaking assigned to',draft.choices.counters.map(u=>({...u,label:u.name+' · '+u.role})),choices.counterIds||[],'global')}<label>Stocktake due date<input type="date" data-global="countDueDate" value="${esc(choices.countDueDate??draft.choices.dueDate)}"></label></div>`:`<label>Assigned to<select data-global="assigneeId" data-searchable ${draft.kind==='received'&&draft.rows.every(r=>String(r.values.condition).trim().toUpperCase()==='UNS')?'':'required'}>${option('','Choose person',choices.assigneeId)}${draft.choices.assignees.map(u=>option(u.id,u.name+' · '+u.role,choices.assigneeId)).join('')}</select></label><label>Due in<input type="number" min="1" data-global="dueDuration" value="${esc(choices.dueDuration||8)}" required></label><label>Time unit<select data-global="dueUnit">${['minutes','hours','days'].map(v=>option(v,v,choices.dueUnit||'hours')).join('')}</select></label>${draft.kind==='issue'?`<label>MPI for all rows<select data-global="mpiStatus" data-searchable>${draft.choices.mpi.map(v=>option(v,v,choices.mpiStatus||'CURRENT')).join('')}</select></label>`:''}`}<label class="checkbox-line"><input type="checkbox" data-confirm-all ${choices.createAll?'checked':''}>Create all new products</label></div>${isProduct?`<label class="checkbox-line"><input type="checkbox" data-select-import-all ${(choices.rows||[]).every(r=>!r.skip)?'checked':''}>Select all products</label>`:''}${pager(info,'edit')}${table([...(isProduct?['Import']:[]),'Row',...draft.columns.flatMap(([key,label])=>[`${label} (${key})`,...(isProduct&&key==='stok_ser'?['Current quantity in system']:[])]),'Options'],info.rows.map(r=>`<tr data-import-row="${r.row}"${r.errors.length?' data-import-status="blocked"':''}>${isProduct?`<td class="merge-selection-cell"><input type="checkbox" data-import-selected ${!rowChoices.get(r.row)?.skip?'checked':''} aria-label="Import row ${r.row}"></td>`:''}<td>${r.row}${r.errors.length?`<span class="import-row-reason"><strong>Invalid:</strong> ${esc(r.errors.join(' '))}</span>`:''}</td>${values(r,r.variants.length===1?r.variants[0].id:null)}<td>${rowControls(r)}</td></tr>`))}<div class="ui-actions"><button type="submit">Check import</button></div></fieldset></form>`,push);
 }
 function collect(){
  const value=el=>el.type==='checkbox'?el.checked:el.multiple?[...el.selectedOptions].map(o=>Number(o.value)):el.value;
  const selections=(host,scope)=>Object.fromEntries([...host.querySelectorAll('[data-multi-scope="'+scope+'"]')].map(el=>[el.dataset.multi,el.dataset.optionSource?JSON.parse(el.dataset.selected||'[]'):[...el.querySelectorAll('input[type=checkbox]:checked')].map(c=>Number(c.value))]));
  return mergeImportChoices(choices,{id:draft.id,merges:choices.merges||[],...selections(dialog,'global'),...Object.fromEntries([...dialog.querySelectorAll('[data-global]')].map(el=>[el.dataset.global,value(el)])),rows:[...dialog.querySelectorAll('[data-import-row]')].map(row=>({row:Number(row.dataset.importRow),...(row.querySelector("[data-import-selected]")?{skip:!row.querySelector("[data-import-selected]").checked}:{}),...selections(row,'row'),...Object.fromEntries([...row.querySelectorAll('[data-row-field]')].map(el=>[el.dataset.rowField,value(el)]))}))});
 }
 function change(event){
  if(event.target.matches('[data-select-import-all]')){choices=collect();choices.rows.forEach(r=>r.skip=!event.target.checked);dialog.querySelectorAll('[data-import-selected]').forEach(el=>el.checked=event.target.checked);}
  if(event.target.matches('[data-import-selected]')){choices=collect();dialog.querySelector('[data-select-import-all]').checked=choices.rows.every(r=>!r.skip);}
  if(event.target.matches('[data-row-field="sourceProductId"]')){choices=collect();const row=event.target.closest('[data-import-row]');row.querySelector('[data-current-stock]').textContent=currentStock(draft.rows.find(r=>r.row===Number(row.dataset.importRow)),choices.rows.find(r=>r.row===Number(row.dataset.importRow)));}
  if(event.target.matches('[data-merge-main]')){const selected=event.target.selectedOptions[0];dialog.querySelector('[name="mergeName"]').value=selected.dataset.name||'';}
  if(event.target.matches('[data-global="skipStocktake"]'))dialog.querySelectorAll('[data-stocktake-options]').forEach(el=>el.hidden=event.target.checked);
  const multiple=event.target.closest('[data-multi]');if(multiple){if(multiple.dataset.optionSource&&event.target.type==='checkbox'){const ids=new Set(JSON.parse(multiple.dataset.selected||'[]'));const id=Number(event.target.value);if(event.target.checked)ids.add(id);else ids.delete(id);multiple.dataset.selected=JSON.stringify([...ids]);}multiple.querySelector('summary small').textContent=(multiple.dataset.optionSource?JSON.parse(multiple.dataset.selected||'[]').length:multiple.querySelectorAll('input[type=checkbox]:checked').length)+' selected';}
  if(event.target.matches('[data-confirm-all]')){choices=collect();choices.createAll=event.target.checked;choices.rows.forEach(row=>row.createConfirmed=event.target.checked);dialog.querySelectorAll('[data-row-field="createConfirmed"]').forEach(el=>el.checked=event.target.checked);}
  if(event.target.matches('[data-global="mpiStatus"]')){choices=collect();choices.rows.forEach(row=>row.mpiStatus=event.target.value);dialog.querySelectorAll('[data-row-field="mpiStatus"]').forEach(el=>{el.value=event.target.value;el.dispatchEvent(new Event('change',{bubbles:true}));});}
  if(event.target.matches('[data-import-page-size]')){const view=event.target.dataset.importPageSize;if(view==='edit')choices=collect();pageSize=Number(event.target.value);showPage(view,0);}
 }

 function mergeSummary(result,editable=false){
  if(!result.merges?.length)return '';
  return `<section><h3>${editable?'Planned merges':'Product merges'}</h3>${table(['Name to keep','Products / aliases','Stock after merge',...(editable?['Action']:[])],result.merges.map((m,index)=>`<tr><td>${esc(m.name)}</td><td>${m.aliases?.map(a=>esc(a.cos_sec+' / '+a.part_no)).join('<br>')||'Rows '+(m.rows||[]).join(', ')+(m.mainProductId?' → existing product':'')}</td><td>${m.variants?.map(v=>esc(v.mpi+': '+v.quantity+' '+v.unit)).join('<br>')||'Preview on Check import'}</td>${editable?`<td><button type="button" class="secondary" data-remove-merge="${index}">Remove</button></td>`:''}</tr>`))}</section>`;
 }
 function mergeScreen(){
  const rows=draft.rows.filter(r=>mergeRows.includes(r.row));
  modal('Merge selected products',`<form data-merge-rows-form><label>Main product<select data-merge-main data-searchable required>${rows.map(r=>`<option value="row:${r.row}" data-name="${esc(r.values.nomen1)}">Row ${r.row} · ${esc(r.values.cos_sec+' / '+r.values.part_no+' · '+r.values.nomen1)}</option>`).join('')}${draft.choices.products.map(p=>`<option value="product:${p.id}" data-name="${esc(p.name)}">${esc(p.label)}</option>`).join('')}</select></label><label>Name to keep<input name="mergeName" maxlength="500" value="${esc(rows[0]?.values.nomen1)}" required></label><p>Stock totals are added within each MPI status. Future imports will use this product and name.</p><div class="ui-actions"><button>Add merge</button><button type="button" class="secondary" data-import-edit>Back to rows</button></div></form>`,false);
 }
 function confirmScreen(){modal('Confirm import',`<p>${preview.ready} ready · ${preview.blocked} need attention · ${preview.existing} already created · ${preview.excluded} excluded. Save valid rows applies to selected valid rows across all pages.${draft.kind==='products'&&preview.rows.some(r=>r.stocktakeId)?' One combined stocktake will cover the differences.':''}</p>${stocktakeAssignmentNotice(preview)}${mergeSummary(preview)}${resultTable(preview,false,confirmPage,pageSize)}<div class="ui-actions"><button type="button" data-import-apply>Save valid rows</button><button type="button" class="secondary" data-import-edit>Back to rows</button></div>`,false);}
 function savedScreen(){const result=savedResult;root.querySelector('[data-import-result]').innerHTML=`<section class="ui-panel"><h2>${result.kind==='merge'?'Merge complete':'Import result'}</h2><p>${esc(result.message)}</p>${stocktakeAssignmentNotice(result)}${mergeSummary(result)}${resultTable(result,true,savedPage,pageSize)}${result.kind==='merge'?'<div class="ui-actions"><button type="button" data-merge-another>Merge more products</button><a class="ghost-button" href="/products">Products</a></div>':''}</section>`;}
 function showPage(view,page){if(view==='edit'){editPage=page;reviewScreen(false);}else if(view==='confirm'){confirmPage=page;confirmScreen();}else if(view==='saved'){savedPage=page;savedScreen();}}
 async function submit(event){
  if(event.target.matches('[data-merge-rows-form]')){event.preventDefault();const [type,id]=event.target.querySelector('[data-merge-main]').value.split(':');choices.merges=[...(choices.merges||[]),{rows:mergeRows,name:event.target.elements.mergeName.value,...(type==='row'?{mainRow:Number(id)}:{mainProductId:Number(id)})}];reviewScreen(false);return;}

  if(!event.target.matches('[data-import-review]'))return;event.preventDefault();if(busy)return;
  choices=collect();busy=true;event.target.querySelector('fieldset').disabled=true;const checkButton=event.target.querySelector('button[type=submit]');checkButton.textContent='Checking all rows…';
  try{preview=await api('review',choices);confirmPage=0;confirmScreen();}
  catch(e){error(e);event.target.querySelector('fieldset').disabled=false;checkButton.textContent='Check import';}finally{busy=false;}
 }
 async function click(event){
  const button=event.target.closest('button');if(!button||busy)return;
  if(button.matches('[data-more-options]')){const details=button.closest('[data-option-source]');optionList(details,Number(details.dataset.optionLimit||100)+100);return;}
  if(button.matches('[data-import-page]')){const view=button.dataset.importView;if(view==='edit')choices=collect();showPage(view,Number(button.dataset.importPage));return;}
  if(button.matches('[data-merge-another]')){if(globalThis.WarehouseNavigation)await globalThis.WarehouseNavigation.go(location.href,{refresh:true});else location.reload();return;}
  if(button.matches('[data-merge-rows]')){choices=collect();mergeScreen();return;}
  if(button.matches('[data-remove-merge]')){choices=collect();choices.merges.splice(Number(button.dataset.removeMerge),1);reviewScreen(false);return;}
  if(button.matches('[data-import-back]')){history.back();return;}
  if(button.matches('[data-import-edit]')){reviewScreen(false);return;}
  if(button.matches('[data-import-apply]')){
   busy=true;button.disabled=true;button.textContent='Saving valid rows…';
   try{const result=await api('apply',{id:preview.id,token:preview.token,confirmed:true});savedResult=result;savedPage=0;savedScreen();if(result.kind==='merge'&&mergeForm)mergeForm.hidden=true;history.back();await loadVouchers();}
   catch(e){error(e);button.disabled=false;button.textContent="Save valid rows";}finally{busy=false;}
  }
 }
 async function loadVouchers(){
  const host=root.querySelector('[data-voucher-list]');if(!host)return;
  const data=await api('vouchers');host.innerHTML=data.vouchers.length?table(['Voucher','Type','Lines','Pending','UNS excluded','Imported'],data.vouchers.map(v=>`<tr><td><button type="button" class="ghost-button" data-voucher-id="${v.id}">${esc(v.number)}</button></td><td>${v.kind==='issue'?'Issue':'Received'}</td><td>${v.line_count}</td><td>${v.pending_count}</td><td>${v.excluded_count}</td><td>${esc(new Date(v.created_at).toLocaleString())}</td></tr>`)):'<p>No vouchers imported.</p>';
 }
 async function openVoucher(id){try{const v=await api('voucher?id='+encodeURIComponent(id)),cols=columns[v.kind];modal(`${v.kind==='issue'?'Issue':'Received'} Voucher ${v.number}`,table([...cols.map(([key,label])=>`${label} (${key})`),'MPI Status','Assigned to','Task','Status'],v.rows.map(r=>`<tr>${cols.map(([key])=>`<td>${r.product_id&&['cos_sec','part_no','nomen1'].includes(key)?`<a href="/products/${r.product_id}">${esc(r.values[key])}</a>`:esc(r.values[key]??'—')}</td>`).join('')}<td>${esc(r.mpi_status||'—')}</td><td>${esc(r.assigned_to||'—')}</td><td>${r.task_id?`<a href="/tasks/${r.task_id}">#${r.task_id}</a>`:'—'}</td><td>${esc(r.message||r.outcome||r.status)}</td></tr>`)));}catch(e){error(e);}}
 listen(root,'click',event=>{if(event.target.closest('[data-merge-another],[data-import-page]'))void click(event);const button=event.target.closest('[data-voucher-id]');if(button)void openVoucher(button.dataset.voucherId);});
 listen(root,'change',event=>{if(event.target.matches('[data-import-page-size]'))change(event);});
 const mergeForm=root.querySelector('[data-product-merge]');if(mergeForm){
  listen(mergeForm,'input',event=>{if(event.target.matches('[data-option-search]')){const q=event.target.value.toLowerCase();mergeForm.querySelectorAll('.business-option-list label').forEach(el=>el.hidden=!el.textContent.toLowerCase().includes(q));}});
  listen(mergeForm,'change',event=>{if(event.target.name==='mainProductId')mergeForm.elements.name.value=event.target.selectedOptions[0].dataset.name||'';});
  listen(mergeForm,'submit',async event=>{event.preventDefault();if(busy)return;busy=true;const button=mergeForm.querySelector('button');button.disabled=true;try{preview=await api('mergeReview',{mainProductId:Number(mergeForm.elements.mainProductId.value),name:mergeForm.elements.name.value,productIds:[...mergeForm.querySelectorAll('[data-multi="productIds"] input:checked')].map(el=>Number(el.value))});modal('Confirm product merge',`${mergeSummary(preview)}<p>Stock and task links will be combined. MPI statuses stay separate. A backup is saved before merging.</p><div class="ui-actions"><button type="button" data-import-apply>Merge products</button></div>`);}catch(e){error(e);}finally{busy=false;button.disabled=false;}});
 }
 const productForm=root.querySelector('[data-business-product]');if(productForm)listen(productForm,'submit',async event=>{
  event.preventDefault();if(busy||!productForm.reportValidity())return;busy=true;productForm.querySelector('button').disabled=true;
  try{const result=await api('saveProduct',Object.fromEntries(new FormData(productForm)));busy=false;if(globalThis.WarehouseNavigation)await globalThis.WarehouseNavigation.go(result.redirectUrl);else location.assign(result.redirectUrl);}catch(e){error(e);}finally{busy=false;productForm.querySelector('button').disabled=false;}
 });
 const upload=root.querySelector('[data-business-upload]');if(upload)listen(upload,'submit',async event=>{
  event.preventDefault();if(busy)return;const file=upload.elements.file.files[0];if(!file)return;
  if(file.size>6*1024*1024){error(new Error('Choose a file smaller than 6 MB.'));return;}
  busy=true;const uploadButton=upload.querySelector('button'),uploadLabel=uploadButton.textContent;uploadButton.disabled=true;uploadButton.textContent='Reading file…';
  try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read this file.'));reader.readAsDataURL(file);});draft=await api('upload',{kind:upload.elements.kind?.value||root.dataset.importKind,fileName:file.name,base64});choices={dueDuration:draft.choices.taskDueMinutes%60===0?draft.choices.taskDueMinutes/60:draft.choices.taskDueMinutes,dueUnit:draft.choices.taskDueMinutes%60===0?'hours':'minutes'};choices.rows=draft.rows.map(row=>{const mpi=draft.kind==='products'?row.values.mpi_status:'CURRENT',exact=row.variants.find(v=>v.mpi_status===mpi);return {row:row.row,mpiStatus:mpi,createConfirmed:false,skip:false,itemsPerCell:exact&&!exact.capacity_pending?exact.items_per_cell:'',...(draft.kind==='products'&&!exact&&row.variants.length===1?{sourceProductId:row.variants[0].id}:{})};});preview=null;mergeRows=[];editPage=0;reviewScreen();}
  catch(e){error(e);}finally{busy=false;uploadButton.disabled=false;uploadButton.textContent=uploadLabel;}
 });
 try{await loadVouchers();const id=new URL(location.href).searchParams.get('voucher');if(id)await openVoucher(id);}catch(e){error(e);}
}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)await mount();
