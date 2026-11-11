export function mount(){
  const form=document.querySelector('[data-led-test-form]');
  if(!form||form.dataset.mounted)return;
  form.dataset.mounted='true';
  const all=form.querySelector('[data-led-select-all]'),boxes=[...form.querySelectorAll('[data-led-choice]')],count=form.querySelector('[data-led-selection-count]');
  const scope=globalThis.WarehousePageLifecycle?.current;
  const listen=(node,...args)=>scope?scope.listen(node,...args):node.addEventListener(...args);
  const refresh=()=>{const n=boxes.filter(b=>b.checked).length;all.checked=!!boxes.length&&n===boxes.length;all.indeterminate=n>0&&n<boxes.length;count.textContent=`${n} selected`;};
  listen(all,'change',()=>{boxes.forEach(b=>b.checked=all.checked);refresh();});
  boxes.forEach(b=>listen(b,'change',refresh));
  listen(form,'submit',event=>{if(event.submitter?.getAttribute('formaction')?.endsWith('/stop'))return;if(!boxes.some(b=>b.checked)){event.preventDefault();all.setCustomValidity('Select at least one LED matrix.');all.reportValidity();}});
  listen(form,'change',()=>all.setCustomValidity(''));
  for(const button of form.querySelectorAll('[data-until]')){
    const reset=()=>{button.removeAttribute('formaction');button.removeAttribute('data-until');button.setAttribute('aria-pressed','false');button.textContent=button.dataset.ledPattern==='ping'?'Ping':'Locate';};
    const delay=Math.max(0,Date.parse(button.dataset.until)-Date.now());
    if(scope)scope.timeout(reset,delay);else globalThis.setTimeout(reset,delay);
  }
  refresh();
}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)mount();
