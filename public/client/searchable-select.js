// Progressive enhancement: the original select remains the canonical form field.
// This module owns only data-searchable selects, never the legacy data-combo-box controls.
export function matchingOptions(options, query) {
 const term=String(query||'').trim().toLocaleLowerCase();
 return Array.from(options).filter(o=>!o.disabled&&!o.hidden&&(!term||o.textContent.toLocaleLowerCase().includes(term)));
}
export function selectionError(value, query, required) {
 return value?'':query.trim()?'Choose an option from the list.':required?'Choose an option.':'';
}
const controls=new WeakMap();let sequence=0,openControl=null;
export function enhanceSelect(select){
 if(controls.has(select))return controls.get(select);
 const doc=select.ownerDocument,wrap=doc.createElement('span'),input=doc.createElement('input'),toggle=doc.createElement('button'),panel=doc.createElement('span'),list=doc.createElement('span'),status=doc.createElement('span');
 const id='searchable-'+(++sequence),labels=Array.from(select.labels||[]),label=select.getAttribute('aria-label')||labels.map(l=>{const copy=l.cloneNode(true);for(const field of copy.querySelectorAll('select,input,button'))field.remove();return copy.textContent.trim();}).join(' ')||select.name;
 wrap.className='searchable-select';input.type='text';input.name=select.name+'Query';input.autocomplete='off';input.className='searchable-input';input.id=id;input.setAttribute('role','combobox');input.setAttribute('aria-label',label);input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');input.setAttribute('aria-controls',id+'-options');input.setAttribute('aria-describedby',id+'-status');input.dataset.comboQuery='';
 input.placeholder=select.options[0]?.value===''?select.options[0].textContent:'Type to search';
 if(select.hasAttribute('form'))input.setAttribute('form',select.getAttribute('form'));
 toggle.type='button';toggle.className='searchable-toggle';toggle.tabIndex=-1;toggle.setAttribute('aria-label','Show '+label+' options');toggle.textContent='▾';
 panel.className='searchable-panel';panel.hidden=true;panel.dataset.floating='';
 const topLayer=typeof panel.showPopover==='function';if(topLayer)panel.setAttribute('popover','manual');list.id=id+'-options';list.setAttribute('role','listbox');list.setAttribute('aria-label',label+' options');status.id=id+'-status';status.className='searchable-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 panel.append(list,status);select.before(wrap);wrap.append(select,input,toggle,panel);select.classList.add('searchable-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
 for(const l of labels)if(l.htmlFor===select.id)l.htmlFor=input.id;
 let active=-1,visible=[],editing=false,lastValue=select.value,request=0,controller,timer,busy=false,remoteReady=false,remoteMessage='',failed=false;
 const remote=Boolean(select.dataset.searchRemote);
 const notify=()=>{select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));};
 const validate=()=>{input.setCustomValidity(selectionError(select.value,input.value,select.required));input.setAttribute('aria-invalid',input.validationMessage?'true':'false');};
 const abort=()=>{clearTimeout(timer);controller?.abort();request++;busy=false;input.removeAttribute('aria-busy');};
 const close=()=>{if(topLayer&&panel.matches(':popover-open'))panel.hidePopover();panel.hidden=true;doc.removeEventListener('pointerdown',outside);doc.removeEventListener('scroll',reposition,true);doc.defaultView.removeEventListener('resize',reposition);doc.defaultView.visualViewport?.removeEventListener('resize',reposition);doc.defaultView.visualViewport?.removeEventListener('scroll',reposition);if(openControl===close)openControl=null;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;abort();};
 function highlight(index){active=index;Array.from(list.children).forEach((el,i)=>{el.classList.toggle('is-active',i===active);});if(active<0)input.removeAttribute('aria-activedescendant');else{input.setAttribute('aria-activedescendant',list.children[active].id);list.children[active].scrollIntoView({block:'nearest'});}}
 function choose(option){if(select.disabled||option.disabled)return;abort();select.value=option.value;lastValue=select.value;editing=false;input.value=option.value?option.textContent:'';validate();close();notify();input.focus();}
 function place(){
  const rect=wrap.getBoundingClientRect(),view=doc.defaultView,viewport=view.visualViewport;
  const top=viewport?.offsetTop||0,left=viewport?.offsetLeft||0,width=viewport?.width||view.innerWidth,bottom=top+(viewport?.height||view.innerHeight);
  const below=bottom-rect.bottom-8,above=rect.top-top-8,up=below<180&&above>below,height=Math.max(44,Math.min(300,up?above:below));
  wrap.classList.toggle('opens-up',up);panel.style.maxHeight=height+'px';panel.style.minWidth='0';panel.style.width=Math.min(Math.max(rect.width,260),width-16)+'px';panel.style.maxWidth=(width-16)+'px';
  panel.style.left=Math.max(left+8,Math.min(rect.left,left+width-8-parseFloat(panel.style.width)))+'px';
  panel.style.top=(up?Math.max(top+8,rect.top-Math.min(panel.scrollHeight,height)-4):rect.bottom+4)+'px';
 }
 function reposition(){if(panel.hidden)return;if(!select.isConnected)return close();place();}
 function outside(event){if(!wrap.contains(event.target)&&!panel.contains(event.target))close();}
 function showPanel(){
  if(openControl&&openControl!==close)openControl();openControl=close;
  if(!topLayer&&!panel.parentNode?.matches('dialog'))(select.closest('dialog')||doc.body).append(panel);
  panel.hidden=false;input.setAttribute('aria-expanded','true');if(topLayer&&!panel.matches(':popover-open'))panel.showPopover();
  doc.addEventListener('pointerdown',outside);doc.addEventListener('scroll',reposition,true);doc.defaultView.addEventListener('resize',reposition);doc.defaultView.visualViewport?.addEventListener('resize',reposition);doc.defaultView.visualViewport?.addEventListener('scroll',reposition);
 }

 function paint(message){
  if(remote&&message!==undefined)remoteMessage=message;
  visible=busy||failed?[]:matchingOptions(select.options,remote?'':editing?input.value:'').filter(o=>o.value||!select.required);active=-1;input.removeAttribute('aria-activedescendant');list.replaceChildren();
  for(const [i,option] of visible.entries()){const row=doc.createElement('span');row.id=id+'-option-'+i;row.className='searchable-option';row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.value===select.value));row.textContent=option.textContent;row.addEventListener('pointerdown',e=>e.preventDefault());row.addEventListener('click',e=>{e.preventDefault();choose(option);});list.append(row);}
  place();status.textContent=message||(remote&&remoteMessage)||(visible.length?`${visible.length} ${visible.length===1?'option':'options'}. Use arrow keys and Enter to choose.`:'No matching options.');
 }
 function search(){
  if(!remote)return paint();
  abort();controller=new AbortController();const token=request,query=editing?input.value:'';busy=true;failed=false;input.setAttribute('aria-busy','true');paint('Searching…');
  timer=setTimeout(()=>{if(!select.isConnected||select.disabled)return close();const event=new CustomEvent('combobox:search',{bubbles:true,cancelable:true,detail:{query,signal:controller.signal,resolve(result){if(token!==request||!select.isConnected||select.disabled)return;busy=false;input.removeAttribute('aria-busy');remoteReady=true;remoteMessage=result.message||'';const chosen=select.value,chosenLabel=select.selectedOptions[0]?.textContent;select.replaceChildren(new Option(input.placeholder,''),...result.options.map(o=>new Option(o.label,o.value)));if(chosen&&!result.options.some(o=>String(o.value)===chosen))select.add(new Option(chosenLabel,chosen));select.value=chosen;lastValue=select.value;paint(result.message);validate();},reject(message){if(token!==request||!select.isConnected)return;busy=false;input.removeAttribute('aria-busy');failed=true;remoteMessage=message||'Search failed. Type or reopen to retry.';paint(remoteMessage);}}});if(select.dispatchEvent(event))event.detail.reject('Search unavailable. Reconnect and try again.');},250);
 }
 function open(){sync();if(input.disabled)return;showPanel();if(remote)search();else paint();}
 function sync(){
  if(select.selectedOptions[0]?.disabled||select.selectedOptions[0]?.hidden)select.value='';
  const disabled=select.disabled||Boolean(select.closest('fieldset[disabled]'));input.disabled=disabled;toggle.disabled=disabled;input.required=select.required;input.setAttribute('aria-required',String(select.required));
  if(select.value!==lastValue){editing=false;lastValue=select.value;}
  if(!editing){input.value=select.value?select.selectedOptions[0]?.textContent||'':'';}
  validate();if(disabled)close();else if(!panel.hidden&&!busy)paint();
 }
 input.addEventListener('input',()=>{editing=true;select.value='';lastValue='';validate();if(panel.hidden)showPanel();search();notify();});
 input.addEventListener('click',()=>{if(panel.hidden)open();});
 toggle.addEventListener('click',()=>{input.focus();panel.hidden?open():close();});
 input.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(panel.hidden){open();}if(visible.length)highlight(e.key==='ArrowDown'?Math.min(active+1,visible.length-1):active<0?visible.length-1:Math.max(0,active-1));}
  else if(e.key==='Enter'&&!panel.hidden){e.preventDefault();if(active>=0&&visible[active])choose(visible[active]);}
  else if(e.key==='Escape'&&!panel.hidden){e.preventDefault();e.stopPropagation();close();}
  else if(e.key==='Tab')close();
 });
 wrap.addEventListener('focusout',e=>{if(!wrap.contains(e.relatedTarget)&&!panel.contains(e.relatedTarget))close();});
 select.addEventListener('change',()=>{if(!editing)sync();});
 select.addEventListener('invalid',e=>{e.preventDefault();input.focus();input.reportValidity();});
 const observer=new MutationObserver(()=>{if(!select.isConnected)return;const before=lastValue;sync();if(before&&!select.value)notify();if(remote&&remoteReady&&!panel.hidden&&!busy)paint();});observer.observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','required','selected','hidden']});
 const api={sync,close,restoreQuery(){editing=!select.value&&Boolean(input.value);lastValue=select.value;sync();},destroy(){close();observer.disconnect();if(!topLayer)panel.remove();},input};controls.set(select,api);sync();return api;
}
export function init(root=document){for(const select of root.querySelectorAll('select[data-searchable]'))enhanceSelect(select);}
export function sync(root=document){init(root);for(const select of root.querySelectorAll('select[data-searchable]'))controls.get(select).sync();}
export function restore(root=document){init(root);for(const select of root.querySelectorAll('select[data-searchable]'))controls.get(select).restoreQuery();}
if(typeof document!=='undefined'){
 globalThis.WarehouseCombobox={init,sync,restore};init();
 new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1){if(n.matches('select[data-searchable]'))enhanceSelect(n);init(n);}for(const r of records)for(const n of r.removedNodes)if(n.nodeType===1&&!n.isConnected){if(n.matches('select[data-searchable]'))controls.get(n)?.destroy();for(const s of n.querySelectorAll('select[data-searchable]'))controls.get(s)?.destroy();}}).observe(document.body,{childList:true,subtree:true});
 document.addEventListener('submit',e=>{for(const s of e.target.querySelectorAll('select[data-searchable]')){const c=controls.get(s);c?.sync();if(c&&!c.input.checkValidity()){e.preventDefault();e.stopImmediatePropagation();c.input.reportValidity();break;}}},true);
 document.addEventListener('reset',e=>setTimeout(()=>{for(const s of e.target.querySelectorAll('select[data-searchable]')){const c=controls.get(s);if(c){c.input.value='';c.restoreQuery();}}},0));
}
