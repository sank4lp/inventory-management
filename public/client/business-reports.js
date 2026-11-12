export function mount(){
 const root=document.querySelector('[data-business-reports]');if(!root||root.dataset.mounted)return;root.dataset.mounted='true';
 const scope=globalThis.WarehousePageLifecycle?.current,listen=(node,...args)=>node&&(scope?scope.listen(node,...args):node.addEventListener(...args));
 let printDetails=[],originalDocument=null,printing=false;
 const reset=()=>{if(originalDocument){root.querySelector('.business-report-document').replaceChildren(...originalDocument);originalDocument=null;}document.body.classList.remove('business-report-printing');for(const details of printDetails)details.open=false;printDetails=[];};
 const print=()=>{printDetails=[...root.querySelectorAll('.business-report-help:not([open])')];for(const details of printDetails)details.open=true;document.body.classList.add('business-report-printing');try{window.print();}catch{reset();}};
 listen(root.querySelector('[data-business-report-print]'),'click',async event=>{
  if(printing)return;printing=true;const button=event.currentTarget,label=button.textContent;button.disabled=true;button.textContent='Preparing…';
  try{const url=new URL(location.href);url.searchParams.set('print','1');const response=await(scope?scope.fetch(url):fetch(url));if(!response.ok)throw Error('The full report could not load. Try again.');const html=await response.text(),doc=new DOMParser().parseFromString(html,'text/html'),full=doc.querySelector('.business-report-document');if(!full)throw Error('Sign in again before printing.');const target=root.querySelector('.business-report-document');originalDocument=[...target.childNodes];target.replaceChildren(...full.childNodes);print();}
  catch(error){reset();globalThis.WarehouseNotifications?.notify(error.message);}
  finally{button.disabled=false;button.textContent=label;printing=false;}
 });listen(window,'afterprint',reset);scope?.own(reset);
 listen(root.querySelector('[data-report-page]'),'change',event=>{const next=new URL(event.target.value,location.origin),current=new URL(location.href);for(const name of ['section',...(next.pathname==='/reports/stocktake-range'?['run']:[])])if(current.searchParams.get(name))next.searchParams.set(name,current.searchParams.get(name));const path=next.pathname+next.search;if(globalThis.WarehouseNavigation)void globalThis.WarehouseNavigation.go(path);else location.assign(path);});
 const form=root.querySelector('[data-threshold-form]');let selected=null,busy=false,opener=null;
 listen(root,'click',event=>{
  const button=event.target.closest('[data-threshold]');if(!button||!form)return;
  selected=JSON.parse(button.dataset.threshold);opener=button;
  form.querySelector('[data-threshold-product]').textContent=[selected.name,selected.mpi].filter(Boolean).join(' · ');
  form.querySelector('[data-threshold-unit]').textContent=selected.unit;
  form.querySelector('[data-threshold-period]').textContent={day:'Day',week:'Week',fortnight:'15 days',month:'Month',quarter:'3 months'}[selected.period];
  form.elements.slowBelow.value=selected.slowBelow;form.elements.fastAbove.value=selected.fastAbove;
  form.querySelector('[data-threshold-message]').textContent='';form.querySelector('[type=submit]').disabled=false;
 });
 listen(form,'submit',async event=>{
  event.preventDefault();if(busy||!selected||!form.reportValidity())return;
  busy=true;const save=form.querySelector('[type=submit]'),message=form.querySelector('[data-threshold-message]');save.disabled=true;message.textContent='Saving…';
  const input={...selected,slowBelow:form.elements.slowBelow.value,fastAbove:form.elements.fastAbove.value};
  try{
   const options={method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)};
   const response=await(scope?scope.fetch('/api/reports/movement-threshold',options):fetch('/api/reports/movement-threshold',options));
   const data=await response.json();if(!response.ok||data.error)throw new Error(data.error||'Thresholds could not be saved.');
   selected={...selected,revision:data.threshold.revision,slowBelow:data.threshold.slow_below,fastAbove:data.threshold.fast_above};opener.dataset.threshold=JSON.stringify(selected);opener.textContent='Edit';
   const badge=opener.closest('tr').querySelector('[data-movement-value]');
   const category=selected.quantity<selected.slowBelow?'Slow':selected.quantity>selected.fastAbove?'Fast':'Normal';
   if(badge){badge.textContent=category;badge.dataset.movementValue=category;}
   // Refresh the whole report after closing, keeping its summary and filters in sync.
   form.dataset.saved='true';message.textContent='Saved. Close to refresh the report.';
  }catch(error){message.textContent=error.message;}finally{busy=false;save.disabled=false;}
 });
 const dialog=form?.closest('dialog');
 listen(dialog,'close',()=>{if(form.dataset.saved==='true'){delete form.dataset.saved;if(globalThis.WarehouseNavigation)void globalThis.WarehouseNavigation.go(location.href,{refresh:true});else location.reload();}});
 scope?.guardLeave(()=>!busy);
}
if(typeof document!=='undefined')mount();
