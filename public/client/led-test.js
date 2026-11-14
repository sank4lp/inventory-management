export function mount(){
  const form=document.querySelector('[data-led-test-form]');
  if(!form||form.dataset.mounted)return;
  form.dataset.mounted='true';
  const root=form.closest('.led-test-page');
  const all=form.querySelector('[data-led-select-all]'),boxes=[...form.querySelectorAll('[data-led-choice]')],count=form.querySelector('[data-led-selection-count]');
  const error=root.querySelector('[data-led-error]'),results=root.querySelector('[data-led-results]');
  const mode=form.elements.mode,content=form.elements.text;
  const scope=globalThis.WarehousePageLifecycle?.current;
  const listen=(node,...args)=>scope?scope.listen(node,...args):node.addEventListener(...args);
  const fetchPage=(url,options={})=>scope?scope.fetch(url,options):globalThis.fetch(url,options);
  let busy=false,checking=false,version=0;
  const alive=()=>form.isConnected&&(!scope||scope.active);
  const showError=message=>{error.textContent=message;error.hidden=!message;};
  const refresh=()=>{const n=boxes.filter(b=>b.checked).length;all.checked=!!boxes.length&&n===boxes.length;all.indeterminate=n>0&&n<boxes.length;count.textContent=`${n} selected`;};
  const displayMode=()=>{const solid=mode.value==='solid';content.disabled=solid;content.required=!solid;content.closest('[data-led-content]').hidden=solid;mode.closest('.led-test-controls').dataset.mode=mode.value;};
  listen(all,'change',()=>{boxes.forEach(b=>b.checked=all.checked);refresh();});
  boxes.forEach(b=>listen(b,'change',refresh));
  listen(mode,'change',displayMode);
  listen(form,'change',()=>all.setCustomValidity(''));
  async function readResponse(response){
    if(response.redirected||!response.headers.get('content-type')?.includes('application/json'))throw new Error('The session may have ended. Sign in again in another tab, then retry this action.');
    const data=await response.json();
    if(!data.html)throw new Error(data.error||'The LED status could not be loaded. Try again.');
    return data;
  }
  function sync(data,{rotateRequest=false}={}){
    const page=new DOMParser().parseFromString(data.html,'text/html');
    const next=page.querySelector('[data-led-test-form]');
    if(!next)throw new Error('The LED status could not be loaded. Try again.');
    form.elements.displayId.value=next.elements.displayId.value;
    if(rotateRequest)form.elements.requestId.value=next.elements.requestId.value;
    for(const button of form.querySelectorAll('[data-led-pattern]')){
      const updated=next.querySelector(`[data-led-pattern="${button.dataset.ledPattern}"]`);
      for(const attribute of ['formaction','data-until','aria-pressed']){
        if(updated.hasAttribute(attribute))button.setAttribute(attribute,updated.getAttribute(attribute));else button.removeAttribute(attribute);
      }
      if(button.textContent!==updated.textContent)button.textContent=updated.textContent;
      button.disabled=updated.disabled;
    }
    const nextResults=page.querySelector('[data-led-results]');
    if(results.dataset.version!==nextResults.dataset.version){results.innerHTML=nextResults.innerHTML;results.dataset.version=nextResults.dataset.version;}
  }
  listen(root,'submit',async event=>{
    const submitted=event.target;
    if(submitted!==form&&!submitted.closest('[data-led-results]'))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(busy)return;
    const button=event.submitter;
    const url=button?.getAttribute('formaction')||submitted.getAttribute('action');
    const stopping=url.endsWith('/stop');
    if(!stopping){
      if(!boxes.some(b=>b.checked)){all.setCustomValidity('Select at least one LED matrix.');all.reportValidity();return;}
      if((button?.value||'show')==='show'&&!form.reportValidity())return;
    }
    const body=new URLSearchParams(new FormData(submitted));
    if(button?.name)body.set(button.name,button.value);
    busy=true;version++;showError('');root.setAttribute('aria-busy','true');
    const buttons=[...root.querySelectorAll('button')],disabled=buttons.map(b=>b.disabled);
    buttons.forEach(b=>b.disabled=true);
    let data;
    try{
      data=await readResponse(await fetchPage(url,{method:'POST',headers:{Accept:'application/json'},body}));
      if(!alive())return;
      // Keep draft fields and selected matrices untouched. Only delivery state changes.
      sync(data,{rotateRequest:true});showError(data.error||'');
    }catch(failure){if(alive())showError(`${failure.message} If delivery is uncertain, retry the same action or use Stop test.`);}
    finally{
      busy=false;root.removeAttribute('aria-busy');
      buttons.forEach((b,i)=>{b.disabled=disabled[i];});
      if(data&&alive())sync(data);
    }
  });
  // Confirm expiry from the server instead of claiming that an unconfirmed clear succeeded.
  async function checkStatus(){
    if(busy||checking||!alive()||document.hidden||!root.querySelector('[data-led-results] form'))return;
    checking=true;const started=version;
    try{
      const data=await readResponse(await fetchPage('/settings/led-test',{headers:{Accept:'application/json'},cache:'no-store'}));
      if(alive()&&!busy&&started===version)sync(data);
    }catch{/* A transient polling failure must not erase the last confirmed state. */}
    finally{checking=false;}
  }
  if(scope)scope.interval(checkStatus,2000);else{const timer=setInterval(()=>{if(!alive())clearInterval(timer);else checkStatus();},2000);}
  refresh();displayMode();
}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)mount();
