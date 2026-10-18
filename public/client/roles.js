import {requestUiConfirmation} from './ui-template.js';

export function formSignature(entries) {
  return JSON.stringify([...entries].map(([key,value])=>[key,String(value)]).sort(([a,av],[b,bv])=>a.localeCompare(b)||av.localeCompare(bv)));
}
export function requiredPermissions(catalog, current) {
  const required=new Set(current);
  let changed=true;
  while(changed) {
    changed=false;
    for(const capability of catalog.filter(item=>required.has(item.id))) {
      for(const id of capability.id==='access.manage'?catalog.map(item=>item.id):capability.requires) {
        if(!required.has(id)) { required.add(id); changed=true; }
      }
    }
  }
  return catalog.filter(capability=>required.has(capability.id)&&!current.has(capability.id));
}

export function mount() {
  const form=document.querySelector('[data-role-editor]');
  if(!form||form.dataset.roleEditorMounted) return;
  form.dataset.roleEditorMounted='true';
  const root=form.closest('.ui-template');
  const scope=globalThis.WarehousePageLifecycle?.current;
  const listen=(node,...args)=>scope?scope.listen(node,...args):node.addEventListener(...args);
  const {catalog,settings}=JSON.parse(document.querySelector('#role-catalog').textContent);
  const forms=[form,...root.querySelectorAll('[data-role-assignment]')];
  const signature=element=>formSignature(new FormData(element));
  const baseline=new Map(forms.map(element=>[element,signature(element)]));
  const dirtyForms=()=>forms.filter(element=>signature(element)!==baseline.get(element));
  const selected=()=>new Set([...form.querySelectorAll('[data-capability]:checked')].map(input=>input.dataset.capability));
  const approved=new WeakSet();
  let leaving=false, deciding=false;

  function refresh() {
    const current=selected(),missing=requiredPermissions(catalog,current);
    const areas=[['work.view','Work'],['products.view','Products'],['locations.view','Locations'],['count.view','Stocktaking'],['reports.view','Reports']].filter(([id])=>current.has(id)).map(([,label])=>label);
    const setup=settings.filter(item=>current.has(item[2])).map(item=>item[1]);
    form.querySelector('[data-role-preview]').textContent=`Can open: ${areas.join(', ')||'Profile only'}${setup.length?'. Settings: '+setup.join(', '):''}.`;
    const prerequisite=form.querySelector('[data-role-prerequisites]');
    const include=form.querySelector('[data-include-required]');
    prerequisite.hidden=!missing.length;
    prerequisite.textContent=missing.length ? current.has('access.manage')?'Managing roles and invitations requires full Admin access. Adding it will allow every permission.':'Also needed: '+missing.map(capability=>capability.label).join(', ')+'.' : '';
    include.hidden=!missing.length;
    include.textContent=current.has('access.manage')?'Allow full Admin access':'Add required permissions';
    form.querySelector('[data-save-role]').disabled=missing.length>0;
    for(const group of form.querySelectorAll('[data-permission-group]')) {
      group.querySelector('[data-permission-count]').textContent=group.querySelectorAll('[data-capability]:checked').length+' allowed';
      const more=group.querySelector('[data-more-permission-count]');
      if(more) more.textContent=more.closest('details').querySelectorAll('[data-capability]:checked').length+' allowed';
    }
    for(const assignment of forms.slice(1)) assignment.querySelector('button[type=submit],button:not([type])').disabled=signature(assignment)===baseline.get(assignment);
  }
  listen(form.querySelector('[data-include-required]'),'click',()=>{
    const missing=new Set(requiredPermissions(catalog,selected()).map(capability=>capability.id));
    for(const input of form.querySelectorAll('[data-capability]')) if(missing.has(input.dataset.capability)) input.checked=true;
    leaving=false; refresh();
  });
  listen(root,'input',()=>{leaving=false;refresh();});
  listen(root,'change',()=>{leaving=false;refresh();});

  async function confirmDiscard(drafts, saving=false) {
    if(!drafts.length) return true;
    if(deciding) return false;
    deciding=true;
    try {
      return await requestUiConfirmation({
        title:'Unsaved changes',
        message:saving?'Saving this form will discard your other unsaved changes. Continue?':'Leave this page without saving your changes?',
        label:saving?'Save and leave':'Leave page',cancelLabel:'Stay here',requireCheck:false,danger:true,
        facts:[['Unsaved changes',drafts.map(draft=>draft===form?'Role details':draft.querySelector('label')?.textContent||'Role assignment').join(', ')]],
      });
    } finally { deciding=false; }
  }
  scope?.guardLeave(async()=>{
    const allowed=await confirmDiscard(dirtyForms());
    if(allowed) leaving=true;
    return allowed;
  });
  listen(window,'beforeunload',event=>{
    if(!leaving&&dirtyForms().length) { event.preventDefault(); event.returnValue=''; }
  });
  // Saving one form must not silently lose edits made in another assignment.
  listen(root,'submit',async event=>{
    const submitted=event.target;
    if(!forms.includes(submitted)) return;
    if(approved.has(submitted)) { approved.delete(submitted); leaving=true; return; }
    if(!submitted.reportValidity()) { event.preventDefault(); return; }
    const other=dirtyForms().filter(draft=>draft!==submitted);
    if(!other.length) { leaving=true; return; }
    event.preventDefault();
    const submitter=event.submitter;
    if(await confirmDiscard(other,true)&&submitted.isConnected) {
      approved.add(submitted); leaving=true; submitted.requestSubmit(submitter);
    }
  });
  refresh();
}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting) mount();
