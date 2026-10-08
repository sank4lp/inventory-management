export async function mount() {
  const scope=globalThis.WarehousePageLifecycle?.current;
  const dialog=document.querySelector('[data-product-settings-dialog]');
  if(!dialog)return;
  const form=dialog.querySelector('[data-product-settings-form]');
  const discard=document.querySelector('[data-product-discard-dialog]');
  const error=dialog.querySelector('[data-product-settings-error]');
  const save=form.querySelector('[data-save-product-settings]');
  const opener=document.querySelector('[data-open-product-settings]');
  const listen=(node,event,fn)=>scope?scope.listen(node,event,fn):node.addEventListener(event,fn);
  const fingerprint=()=>JSON.stringify([...new FormData(form)].filter(([key])=>key!=='confirmed'));
  const original=fingerprint();
  let busy=false,frame=null,decision=null,backDone=null;
  const dirty=()=>fingerprint()!==original;
  const controls=()=>{form.inert=busy;form.setAttribute('aria-busy',String(busy));save.textContent=busy?'Saving…':'Save Details';save.disabled=busy||!form.elements.confirmed.checked;for(const button of dialog.querySelectorAll('button[type="button"]'))button.disabled=busy;};
  const askDiscard=()=>{
    if(decision)return decision.promise;
    let resolve;const promise=new Promise(r=>{resolve=r;});decision={promise,resolve};discard.showModal();return promise;
  };
  function answer(value){const pending=decision;decision=null;discard.close();pending?.resolve(value);}
  function stripFrame(){if(history.state?.productSettingsFrame===frame){const state={...history.state};delete state.productSettingsFrame;history.replaceState(state,'');}}
  async function closeEditor({navigate=false}={}){
    dialog.close();opener.disabled=true;
    try{
      if(navigate){stripFrame();return;}
      if(history.state?.productSettingsFrame===frame)await new Promise(resolve=>{backDone=resolve;history.back();});
    }finally{opener.disabled=false;if(opener.isConnected)opener.focus();}
  }
  async function requestClose(always=false){
    if(busy)return;
    if((always||dirty())&&!await askDiscard())return;
    form.reset();controls();error.textContent='';await closeEditor();
  }
  listen(opener,'click',()=>{error.textContent='';controls();frame=crypto.randomUUID();history.pushState({...history.state,productSettingsFrame:frame},'');dialog.showModal();});
  for(const button of dialog.querySelectorAll('[data-discard-product-settings]'))listen(button,'click',()=>void requestClose(button.textContent.trim()==='Discard changes'));
  listen(dialog,'cancel',event=>{event.preventDefault();void requestClose();});
  listen(discard.querySelector('[data-confirm-product-discard]'),'click',()=>answer(true));
  listen(discard.querySelector('[data-keep-product-editing]'),'click',()=>answer(false));
  listen(discard,'cancel',event=>{event.preventDefault();answer(false);});
  listen(form,'input',controls);listen(form,'change',controls);
  listen(window,'popstate',()=>{
    if(backDone){const resolve=backDone;backDone=null;resolve();return;}
    if(!dialog.open||history.state?.productSettingsFrame===frame)return;
    void(async()=>{
      if(busy||dirty()&&!await askDiscard()){history.pushState({...history.state,productSettingsFrame:frame},'');return;}
      form.reset();controls();error.textContent='';dialog.close();
    })();
  });
  listen(window,'beforeunload',event=>{if(busy||dirty()){event.preventDefault();event.returnValue='';}});
  scope?.guardLeave(async()=>{
    if(busy){error.textContent='Wait for the save to finish.';return false;}
    if(dirty()&&!await askDiscard())return false;
    form.reset();await closeEditor({navigate:true});return true;
  });
  scope?.own(()=>{answer(false);dialog.close();stripFrame();backDone?.();backDone=null;});
  listen(form,'submit',async event=>{
    event.preventDefault();if(busy||!form.reportValidity())return;
    busy=true;controls();error.textContent='';
    try{
      const response=await fetch(form.action,{method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams(new FormData(form))});
      if(!response.headers.get('content-type')?.includes('application/json'))throw Error('Could not save. Sign in again and retry.');
      const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save these changes.');
      busy=false;form.reset();await closeEditor();
      if(globalThis.WarehouseNavigation)await globalThis.WarehouseNavigation.go(result.redirectUrl,{refresh:true,replace:true});
      else location.assign(result.redirectUrl);
    }catch(problem){busy=false;error.textContent=problem.message||'Could not save. Check your connection and retry.';controls();}
  });
}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)await mount();
