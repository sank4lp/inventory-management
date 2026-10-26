// Shared by controller mapping and Add location. No inventory is posted by this editor.
export function createLedMapper({root,getSnapshot,refresh,render,scope,escapeHtml:e}) {
  const get=()=>getSnapshot();
  let dirty=false,saving=false,pending=null,displayId=null,dialogResolve=null;
  const listen=(target,...args)=>scope?scope.listen(target,...args):target.addEventListener(...args);
  const requestKey=`led-mapping-request:${get().site}:${get().dataset}:${get().user.id}`;
  try{pending=JSON.parse(sessionStorage.getItem(requestKey)||'null');}catch{}
  function setSaving(value){saving=value;for(const el of root.querySelectorAll('button,input,select,textarea')){if(value){el.dataset.ledDisabled=el.disabled?'1':'0';el.disabled=true;}else if(el.dataset.ledDisabled!=null){el.disabled=el.dataset.ledDisabled==='1';delete el.dataset.ledDisabled;}}}
  function status(text){const node=root.querySelector('[data-led-status]');if(node)node.textContent=text;}
  async function request(action,input,{mutation=false}={}){
    if(pending&&mutation&&pending.action!==action)throw Error('Retry the unconfirmed save before making another change.');
    const receipt=mutation?(pending||{action,input:{...input,requestId:crypto.randomUUID(),site:get().site,dataset:get().dataset,actorId:get().user.id}}):{action,input:{...input,requestId:crypto.randomUUID()}};
    if(mutation){pending=receipt;sessionStorage.setItem(requestKey,JSON.stringify(receipt));}
    const r=await fetch('/api/location-setup/'+receipt.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(receipt.input),signal:AbortSignal.timeout(15000)});
    const result=await r.json();
    if(mutation&&(r.ok||r.status<500)){pending=null;sessionStorage.removeItem(requestKey);}
    if(!r.ok||result.error){if(result.code==='OUTSTANDING_WORK')await(await import('./setup-work-dialog.js')).showSetupWorkResponse(r,{scope,error:result});throw Error(result.error||'Could not save.');}
    return result;
  }
  function showRecovery(){if(!pending)return;const d=root.querySelector('[data-led-dialog][open]');if(d&&!d.querySelector('[data-led-retry]'))d.insertAdjacentHTML('beforeend','<button type="button" data-led-retry>Retry unconfirmed save</button>');}
  async function canLeave(){if(saving)return false;if(!dirty&&!pending)return true;return await question('Unsaved changes would be lost. Continue?','',[['yes','Continue']])==='yes';}
  scope?.guardLeave(canLeave);
  scope?.beforeLeave(()=>{if(saving)throw Error('Wait for the save to finish.');});
  listen(window,'beforeunload',ev=>{if(dirty||pending){ev.preventDefault();ev.returnValue='';}});
  const controller=()=>get().ledControllers?.find(c=>c.id===Number(root.querySelector('[data-led-controller]')?.value));
  function chooser(selected){return `<label>Controller<select data-led-controller>${(get().ledControllers||[]).map(c=>`<option value="${c.id}" ${c.id===Number(selected)?'selected':''}>${e(c.name||c.controller_code)}</option>`).join('')}</select></label>`;}
  function fields(){return (get().fields||[]).filter(f=>f.enabled).map(f=>`<label>${e(f.label)}${f.required?' *':''}${f.field_type==='select'?`<select name="attr:${e(f.field_key)}" ${f.required?'required':''}><option value="">Choose…</option>${JSON.parse(f.options_json).map(v=>`<option>${e(v)}</option>`).join('')}</select>`:`<input name="attr:${e(f.field_key)}" ${f.field_type==='number'?'type="number" step="any"':''} ${f.required?'required':''}>`}</label>`).join('');}
  function page(){
    const selected=new URL(location.href).searchParams.get('controller');
    return `<section class="ui-panel led-mapper"><div class="led-toolbar-slot"><div class="led-mapping-toolbar"><a class="secondary" href="/devices#controller-health">← Controllers</a><div><button type="button" class="secondary" data-led-display>Display LED number</button><button type="button" data-led-save>Save</button></div></div></div><header class="ui-panel-heading"><div><h2>Map LEDs to locations</h2><p>Choose a location beside each LED number, or type a new name. Save to apply your changes.</p></div></header>${chooser(selected)}<p role="status" aria-live="polite" data-led-status>${pending?'A save was not confirmed. Retry it before editing.':'All changes saved.'}</p>${pending?'<button type="button" data-led-retry>Retry unconfirmed save</button>':''}<div data-led-rows></div></section>`;
  }
  function rows(){const c=controller(),host=root.querySelector('[data-led-rows]');if(!host)return;
    host.innerHTML=!c?'<p>No controllers yet. <a href="/devices#controller-setup">Add a new controller</a>.</p>':c.error?`<p class="work-callout">${e(c.error)} <a href="/devices#controller-edit-${c.id}">Edit controller</a></p>`:`<datalist id="led-location-names">${get().cells.map(v=>`<option value="${e(v.description.name)}"></option>`).join('')}</datalist><div class="led-mapping-list">${c.leds.map(l=>`<div class="led-mapping-row" data-led-row="${l.physical}"><strong>LED ${l.physical}</strong>${l.channel?`<div><label class="sr-only" for="led-location-${l.physical}">Location for LED ${l.physical}</label><input id="led-location-${l.physical}" list="led-location-names" data-led-name data-original="${e(l.name)}" value="${e(l.name)}" maxlength="160" placeholder="Choose or type a location" autocomplete="off"><small data-led-hint>${l.name?'Mapped location':'Unassigned'}</small><div data-led-new-fields hidden>${fields()}</div></div>`:'<p>Not routed. Update this controller’s configuration before mapping it.</p>'}</div>`).join('')}</div>`;
    root.querySelector('[data-led-save]').disabled=!!pending||!c||!!c.error;
    root.querySelector('[data-led-display]').disabled=!get().capabilities.includes('hardware.test')||!c||!!c.error;
  }
  function wirePage(){rows();positionToolbar();const select=root.querySelector('[data-led-controller]');if(select)select.dataset.previous=select.value;}
  function positionToolbar(){
    const slot=root.querySelector('.led-toolbar-slot'),bar=slot?.querySelector('.led-mapping-toolbar');if(!bar)return;
    const mobile=matchMedia('(max-width: 700px)').matches,box=slot.getBoundingClientRect();
    if(!bar.classList.contains('led-toolbar-floating'))slot.style.height=bar.offsetHeight+'px';
    bar.classList.toggle('led-toolbar-floating',mobile&&box.top<68&&slot.closest('.led-mapper').getBoundingClientRect().bottom>120);
  }
  listen(window,'scroll',positionToolbar,{capture:true,passive:true});listen(window,'resize',positionToolbar);
  function dialog(title,html){
    let d=root.querySelector('[data-led-dialog]');if(!d){root.insertAdjacentHTML('beforeend','<dialog class="task-edit-dialog location-settings-dialog led-mapping-dialog" data-led-dialog></dialog>');d=root.querySelector('[data-led-dialog]');listen(d,'cancel',ev=>{ev.preventDefault();closeDialog();});}
    d.innerHTML=`<header class="review-task-header"><h2>${e(title)}</h2><button type="button" class="dialog-dismiss" aria-label="Close" data-led-close>×</button></header>${html}<p data-led-error role="alert"></p>`;
    if(!d.open)d.showModal();return d;
  }
  async function closeDialog(){if(saving)return;if(dirty&&root.querySelector('[data-led-add]')&&!await canLeave())return;if(root.querySelector('[data-led-add]'))dirty=false;root.querySelector('[data-led-dialog]')?.close();dialogResolve?.(null);dialogResolve=null;}
  function question(title,body,buttons){
    const previous=root.querySelector('[data-led-dialog]');const saved=previous?.open?document.createDocumentFragment():null;if(saved)while(previous.firstChild)saved.append(previous.firstChild);
    const d=dialog(title,`${body}<div class="led-dialog-actions">${buttons.map(([value,label])=>`<button type="button" data-led-answer="${value}">${e(label)}</button>`).join('')}<button type="button" class="secondary" data-led-answer="cancel">Back</button></div>`);
    return new Promise(resolve=>{const finish=value=>{dialogResolve=null;if(saved){d.replaceChildren(saved);if(!d.open)d.showModal();}else d.close();resolve(value);};dialogResolve=finish;for(const b of d.querySelectorAll('[data-led-answer]'))b.onclick=()=>finish(b.dataset.ledAnswer==='cancel'?null:b.dataset.ledAnswer);});
  }

  function findName(name){return get().cells.find(c=>[c.description.name,c.logical_code].some(v=>v?.toLowerCase()===name.trim().toLowerCase()));}
  async function resolveRows(c,changes){
    for(const row of changes){const led=c.leds.find(l=>l.physical===row.physical),old=get().cells.find(x=>x.id===led.cellId),target=findName(row.name);if(target)row.cellId=target.id;
      if(!old||old.id===target?.id)continue;
      const answer=await question('Is this the same location?',`<p>LED ${led.physical} is mapped to <strong>${e(old.description.name)}</strong>. You selected <strong>${e(row.name)}</strong>.</p><p>Are these the same physical location, or different locations?</p>`,[['same','Same location'],['different','Different locations']]);
      if(!answer)return false;
      row.resolution=answer;
      if(answer==='same'){
        row.keepName=await question('Which name should we keep?',`<p>Stock, QR identity and history will stay with ${e(old.description.name)}.</p>`,[['current',old.description.name],['entered',row.name]]);if(!row.keepName)return false;
        if(target){const confirmed=await question('Combine these location names?',`<p>The identity holding stock will be kept. The empty duplicate will be archived with its history, and its QR label will stop working. Both stocked locations must be reconciled first.</p>`,[['yes','Combine names']]);if(!confirmed)return false;row.mergeConfirmed=true;}
      }else if(old.hasStock){await moveStock(old);return false;}
    }return true;
  }
  function attributes(host){return Object.fromEntries([...host.querySelectorAll('[name^="attr:"]')].map(i=>[i.name.slice(5),i.value]));}
  async function stopDisplay(){if(!displayId)return;const r=await fetch('/api/displays/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayId})});if(!r.ok)throw Error('Could not stop LED numbers. Try again before saving.');displayId=null;for(const b of root.querySelectorAll('[data-led-display]'))b.textContent='Display LED number';}
  async function display(c){if(!c)throw Error('Choose a physical LED first.');if(displayId){await stopDisplay();return;}
    const result=await request('displayLedNumbers',{controllerId:c.id});displayId=result.id;for(const b of root.querySelectorAll('[data-led-display]'))b.textContent='Hide LED numbers';
    const sent=result.targets?.filter(t=>t.status==='sent').length||0;const msg=sent?`${sent} LED numbers displayed for up to two minutes.${result.targets.some(t=>t.status!=='sent')?' Some LEDs are busy or offline.':''}`:result.message||'No LEDs could be displayed.';status(msg);const feedback=root.querySelector('[data-led-dialog][open] [data-led-error]');if(feedback)feedback.textContent=msg;
  }
  async function save(){if(saving||pending)return;const c=controller();if(!c)return;
    const changes=[...root.querySelectorAll('[data-led-row]')].filter(el=>el.querySelector('[data-led-name]')?.value.trim()!==el.querySelector('[data-led-name]')?.dataset.original).map(el=>({physical:Number(el.dataset.ledRow),name:el.querySelector('[data-led-name]').value.trim(),attributes:attributes(el)}));
    if(!changes.length){status('All changes saved.');return;}
    try{if(!await resolveRows(c,changes))return;await stopDisplay();setSaving(true);status('Saving…');const result=await request('saveLedMappings',{controllerId:c.id,revision:c.revision,rows:changes},{mutation:true});dirty=false;await refresh();render();status(result.message);}catch(error){status(error.message+(pending?' Retry the unconfirmed save.':''));if(pending)root.querySelector('[data-led-status]')?.insertAdjacentHTML('afterend','<button type="button" data-led-retry>Retry unconfirmed save</button>');}finally{setSaving(false);showRecovery();}
  }
  function add(existing=null){
    if(pending){dialog('Save awaiting confirmation','<p>Retry this saved request before editing locations.</p><button type="button" data-led-retry>Retry unconfirmed save</button>');return;}
    const c=existing;dialog(c?'Map LED':'Add location',`<form data-led-add><div class="led-mapping-toolbar"><button type="button" class="secondary" data-led-display ${get().capabilities.includes('hardware.test')?'':'disabled'}>Display LED number</button><button type="submit">Save</button></div><label>Location name<input name="displayName" value="${e(c?.description.name)}" required maxlength="160" ${c?'readonly':''}></label><label>Physical LED<select name="physical" data-led-physical ${get().capabilities.includes('hardware.map')?'':'disabled'}><option value="">Manual location (no LED)</option>${(get().ledControllers||[]).flatMap(ctrl=>ctrl.leds.filter(l=>l.channel).map(l=>`<option value="${ctrl.id}:${l.physical}" ${c?.controller_id===ctrl.id&&c?.hardware_channel===l.channel?'selected':''}>${e(ctrl.name)} · LED ${l.physical}${l.name?' · '+e(l.name):' · Unassigned'}</option>`)).join('')}</select></label><p>Choose the LED at this cell. Existing stock stays protected.</p>${c?'':fields()}<input type="hidden" name="existingId" value="${c?.id||''}"></form>`);
  }
  async function saveAdd(form){
    if(saving||pending)return;const name=form.elements.displayName.value.trim(),selected=form.elements.physical.value;
    try{
      if(!selected){if(form.elements.existingId.value)throw Error('Choose a physical LED.');await stopDisplay();setSaving(true);await request('manual',{displayName:name,attributes:attributes(form)},{mutation:true});}
      else{const [id,physical]=selected.split(':').map(Number),c=get().ledControllers.find(c=>c.id===id),rows=[{physical,name,attributes:attributes(form)}];if(!await resolveRows(c,rows))return;await stopDisplay();setSaving(true);await request('saveLedMappings',{controllerId:id,revision:c.revision,rows},{mutation:true});}
      dirty=false;root.querySelector('[data-led-dialog]')?.close();await refresh();render();
    }catch(error){const d=root.querySelector('[data-led-dialog]');if(!d?.open)dialog('Could not save',`<p>${e(error.message)}</p>${pending?'<button type="button" data-led-retry>Retry unconfirmed save</button>':''}`);else d.querySelector('[data-led-error]').textContent=error.message;}finally{setSaving(false);showRecovery();}
  }
  async function moveStock(cell){
    const existing=get().ledMoves?.find(m=>m.cellId===cell.id);
    if(existing){showMove(cell,existing);return;}
    await stopDisplay();const plan=await request('planLedMove',{cellId:cell.id});
    const d=dialog('Move products to other cells',`<p>Empty <strong>${e(cell.description.name)}</strong> before reassigning its LED. Review the suggested destinations or choose your own. Stock changes only as you complete the tasks.</p><form data-led-move="${cell.id}">${plan.products.map(p=>`<fieldset data-move-product="${p.productId}"><legend>${e(p.name)} · ${p.quantity} ${e(p.unit)}</legend>${p.shortfall?`<p class="work-callout">Space is short by ${p.shortfall} ${e(p.unit)}. Check items per cell or choose custom locations.</p>`:''}<div data-destinations>${(p.suggested.length?p.suggested:[{cellId:'',quantity:p.quantity}]).map(dest=>destination(p,dest)).join('')}</div><button type="button" class="secondary" data-add-destination="${p.productId}">Add destination</button>${plan.canEditCapacity?`<details><summary>Update items per cell</summary><label>Items per cell<input type="number" min="${p.itemsPerCell}" step="any" data-capacity data-previous="${p.itemsPerCell}" value="${p.itemsPerCell}"></label><label><input type="checkbox" data-capacity-confirm>I checked that this quantity fits in a normal cell.</label></details>`:'<p>Ask someone with product capacity access to update items per cell if needed.</p>'}</fieldset>`).join('')}<button type="submit">Create move tasks</button><button type="button" class="secondary" data-led-close>Back to mapping</button></form>`);
    d.movePlan=plan;
  }
  function destination(p,d){return `<div class="led-move-destination"><label>Destination<select data-destination required><option value="">Choose location</option>${p.choices.map(c=>`<option value="${c.id}" ${c.id===Number(d.cellId)?'selected':''}>${e(c.name)} · space ${c.space} ${e(p.unit)}</option>`).join('')}</select></label><label>Quantity<input data-move-quantity type="number" min="0.000001" step="any" required value="${d.quantity}"></label><button type="button" class="secondary" data-remove-destination aria-label="Remove destination">×</button></div>`;}
  function showMove(cell,move,message=''){dialog('Move tasks',`<p>${e(message||'Complete the picks first, then put the products in their destination cells. Return here to save the mapping afterwards.')}</p><p><a class="green-button" href="/work">Open My work</a></p><p>Pick tasks: ${move.picks.map(id=>'#'+id).join(', ')}<br>Put tasks: ${move.puts.map(id=>'#'+id).join(', ')}</p><button type="button" class="danger-button" data-led-discard="${cell.id}">Discard move</button><button type="button" class="secondary" data-led-close>Back to mapping</button>`);}
  async function refreshKeepingDraft(){
    const draft=[...root.querySelectorAll('[data-led-row]')].filter(el=>el.querySelector('[data-led-name]')).map(el=>({physical:el.dataset.ledRow,name:el.querySelector('[data-led-name]').value,attributes:attributes(el)}));
    await refresh();render();
    for(const row of draft){const el=root.querySelector(`[data-led-row="${row.physical}"]`);if(!el)continue;el.querySelector('[data-led-name]').value=row.name;for(const field of el.querySelectorAll('[name^="attr:"]'))field.value=row.attributes[field.name.slice(5)]||'';}
    dirty=draft.some(row=>{const el=root.querySelector(`[data-led-row="${row.physical}"] [data-led-name]`);return el&&el.value.trim()!==el.dataset.original;});
  }
  function moves(){return (pending?'<p class="work-callout">A save was not confirmed. <button type="button" data-led-retry>Retry unconfirmed save</button></p>':'')+(get().ledMoves||[]).map(m=>`<p class="work-callout">Move for ${e(get().cells.find(c=>c.id===m.cellId)?.description.name)} <button type="button" class="secondary" data-led-move-status="${m.cellId}">View / discard move</button></p>`).join('');}
  listen(root,'click',ev=>{if(ev.target.closest('[data-ui-dialog-back]')?.closest('[data-led-dialog]')){ev.preventDefault();ev.stopPropagation();closeDialog();}},true);
  listen(root,'input',ev=>{if(ev.target.matches('[data-led-name]')){dirty=true;const el=ev.target.closest('[data-led-row]'),newName=!!ev.target.value.trim()&&!findName(ev.target.value);el.querySelector('[data-led-hint]').textContent=newName?'New location — created when you save':'Existing location';el.querySelector('[data-led-new-fields]').hidden=!newName;dirty=[...root.querySelectorAll('[data-led-name]')].some(i=>i.value.trim()!==i.dataset.original);status(dirty?'Unsaved changes.':'All changes saved.');}else if(ev.target.closest('[data-led-add]'))dirty=true;});
  listen(root,'change',async ev=>{if(ev.target.matches('[data-led-controller]')){if(!await canLeave()){ev.target.value=ev.target.dataset.previous;return;}dirty=false;ev.target.dataset.previous=ev.target.value;rows();status('All changes saved.');}if(ev.target.closest('[data-led-add]'))dirty=true;});
  listen(root,'submit',async ev=>{const f=ev.target;if(!f.matches('[data-led-add],[data-led-move]'))return;ev.preventDefault();ev.stopImmediatePropagation();if(f.matches('[data-led-add]'))return saveAdd(f);
    try{setSaving(true);const products=[...f.querySelectorAll('[data-move-product]')].map(el=>({productId:Number(el.dataset.moveProduct),destinations:[...el.querySelectorAll('.led-move-destination')].map(row=>({cellId:Number(row.querySelector('[data-destination]').value),quantity:Number(row.querySelector('[data-move-quantity]').value)}))}));const capacities=[...f.querySelectorAll('[data-capacity]')].filter(i=>Number(i.value)!==Number(i.dataset.previous)).map(i=>({productId:Number(i.closest('[data-move-product]').dataset.moveProduct),itemsPerCell:Number(i.value),previousCapacity:Number(i.dataset.previous),confirmed:i.closest('details').querySelector('[data-capacity-confirm]').checked}));const cell=get().cells.find(c=>c.id===Number(f.dataset.ledMove));const result=await request('moveLedStock',{cellId:cell.id,products,capacities},{mutation:true});await refresh();showMove(cell,result,result.message);}catch(error){root.querySelector('[data-led-error]').textContent=error.message;}finally{setSaving(false);showRecovery();}
  });
  listen(root,'click',async ev=>{const b=ev.target.closest('button');if(!b)return;try{
    if(b.hasAttribute('data-led-save'))await save();
    if(b.hasAttribute('data-led-close'))closeDialog();
    if(b.hasAttribute('data-led-display')){const selection=root.querySelector('[data-led-dialog][open] [data-led-physical]')?.value;const available=get().ledControllers.filter(c=>!c.error);await display(selection?get().ledControllers.find(c=>c.id===Number(selection.split(':')[0])):controller()||(available.length===1?available[0]:null));}
    if(b.hasAttribute('data-led-retry')){if(saving||!pending)return;setSaving(true);const r=await request(pending.action,pending.input,{mutation:true});dirty=false;await refresh();render();status(r.message);}
    if(b.dataset.addDestination){const d=root.querySelector('[data-led-dialog]'),p=d.movePlan.products.find(p=>p.productId===Number(b.dataset.addDestination));b.previousElementSibling.insertAdjacentHTML('beforeend',destination(p,{quantity:''}));}
    if(b.hasAttribute('data-remove-destination'))b.closest('.led-move-destination').remove();
    if(b.dataset.ledMoveStatus){const m=get().ledMoves.find(m=>m.cellId===Number(b.dataset.ledMoveStatus));showMove(get().cells.find(c=>c.id===m.cellId),m);}
    if(b.dataset.ledDiscard){if(!await question('Discard this move?','<p>Unstarted tasks will be cancelled. Work already started must be checked; recorded stock changes will be kept. The LED mapping stays unchanged.</p>',[['yes','Discard move']]))return;setSaving(true);const r=await request('discardLedMove',{cellId:Number(b.dataset.ledDiscard),confirmed:true},{mutation:true});root.querySelector('[data-led-dialog]').close();await refreshKeepingDraft();status(r.message+(dirty?' Unsaved mapping changes remain.':''));if(r.status==='review')dialog('Check moved products',`<p>${e(r.message)}</p><a href="/pending-confirmations">Open Needs review</a> · <a href="/work">Open My work</a>`);}
  }catch(error){const feedback=root.querySelector('[data-led-dialog][open] [data-led-error]');if(feedback)feedback.textContent=error.message;else status(error.message);}finally{setSaving(false);showRecovery();}});
  scope?.own(()=>{if(displayId)fetch('/api/displays/stop',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({displayId})}).catch(()=>{});});
  return {page,wirePage,add,moves};
}
