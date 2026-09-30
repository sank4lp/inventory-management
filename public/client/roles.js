(()=>{
 const form=document.querySelector('[data-role-editor]');if(!form)return;
 const {catalog,settings}=JSON.parse(document.querySelector('#role-catalog').textContent);
 const selected=()=>new Set([...form.querySelectorAll('[data-capability]:checked')].map(x=>x.dataset.capability));
 function requiredAccess(current){
  const required=new Set(current);let changed=true;
  while(changed){changed=false;for(const c of catalog.filter(c=>required.has(c.id)))for(const id of c.id==='access.manage'?catalog.map(c=>c.id):c.requires)if(!required.has(id)){required.add(id);changed=true;}}
  return catalog.filter(c=>required.has(c.id)&&!current.has(c.id));
 }
 const refresh=()=>{
  const current=selected(),missing=requiredAccess(current);
  const nav=[['work.view','Work'],['products.view','Products'],['locations.view','Locations'],['count.view','Stocktaking'],['reports.view','Reports']].filter(([c])=>current.has(c)).map(([,n])=>n);
  const permitted=settings.filter(x=>current.has(x[2])).map(x=>x[1]);
  form.querySelector('[data-role-preview]').textContent=`Navigation: ${nav.join(', ')||'Account only'}. Settings: ${permitted.join(', ')||'None'}. ${current.size} permitted actions and views.`;
  form.querySelector('[data-role-prerequisites]').textContent=missing.length?'Required additional access: '+missing.map(c=>c.label).join('; ')+'. Include these permissions or uncheck the action that needs them.':'All required access is selected.';
  form.querySelector('[data-include-required]').hidden=!missing.length;
 };
 form.querySelector('[data-include-required]').addEventListener('click',()=>{const missing=new Set(requiredAccess(selected()).map(c=>c.id));for(const box of form.querySelectorAll('[data-capability]'))if(missing.has(box.dataset.capability))box.checked=true;refresh();});
 form.addEventListener('change',refresh);refresh();
})();
