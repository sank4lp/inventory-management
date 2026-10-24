const controllers = new WeakMap();
const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');

export function confirmationMarkup({title, message, label = 'Confirm', facts = [], danger = false, requireCheck = true, cancelLabel = 'Cancel'}) {
  return `<header class="review-task-header"><button type="button" class="ui-button-secondary" data-ui-back>← Back</button><h2 id="ui-confirm-title" tabindex="-1">${escapeHtml(title)}</h2></header>
    ${facts.length ? `<dl class="ui-facts" aria-label="Details">${facts.map(([name,value])=>`<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
    <p class="ui-confirm-message">${escapeHtml(message)}</p>
    ${requireCheck ? '<label class="ui-check"><input type="checkbox" data-ui-confirmed>I confirm this change.</label>' : ''}
    <div class="ui-dialog-actions"><button type="button" class="ui-button-secondary" data-ui-back>${escapeHtml(cancelLabel)}</button><button type="button" class="${danger?'danger-button':''}" data-ui-accept${requireCheck?' disabled':''}>${escapeHtml(label)}</button></div>`;
}

export function mount() {
  const root = document.querySelector('.ui-template');
  if (!root || root.dataset.uiMounted) return;
  root.dataset.uiMounted = 'true';
  const scope = globalThis.WarehousePageLifecycle?.current;
  let active = null;
  const listen = (node, ...args) => scope ? scope.listen(node, ...args) : node.addEventListener(...args);
  const oldOwnsPop = scope?.ownsPop;

  function finish() {
    if (!active) return;
    const current = active;
    active = null;
    current.dialog.close();
    if (!current.preserve) current.dialog.remove();
    current.opener?.focus?.();
    current.resolve(current.decision === true);
  }
  function back(accepted = false) {
    if (!active || active.closing) return;
    active.closing = true;
    active.decision = accepted;
    if (history.state?.uiDialog === active.id) history.back();
    else finish();
  }
  if (scope) scope.ownsPop = event => Boolean(active) || oldOwnsPop?.(event);
  listen(window,'popstate',()=>{ if (active && history.state?.uiDialog !== active.id) finish(); });

  function confirm(options, opener) {
    if (active) return Promise.resolve(false);
    return new Promise(resolve=>{
      const dialog = document.createElement('dialog');
      dialog.className = 'task-edit-dialog ui-dialog';
      dialog.setAttribute('aria-labelledby','ui-confirm-title');
      dialog.innerHTML = confirmationMarkup(options);
      const id = crypto.randomUUID();
      active = {dialog, resolve, id, opener, decision:false};
      root.append(dialog);
      history.pushState({...history.state, uiDialog:id},'',location.href);
      dialog.addEventListener('cancel',event=>{event.preventDefault();back();});
      dialog.querySelector('[data-ui-confirmed]')?.addEventListener('change',event=>{
        dialog.querySelector('[data-ui-accept]').disabled = !event.target.checked;
      });
      dialog.addEventListener('click',event=>{
        if (event.target.closest('[data-ui-back]')) back();
        else if (event.target.closest('[data-ui-accept]') && (options.requireCheck === false || dialog.querySelector('[data-ui-confirmed]').checked)) back(true);
      });
      dialog.showModal();
      dialog.querySelector('h2').focus();
    });
  }
  function openPanel(dialog, opener) {
    if (active || !dialog?.matches('[data-ui-panel-dialog]')) return;
    const id = crypto.randomUUID();
    active = {dialog, id, opener, decision:false, preserve:true, resolve:()=>{}};
    history.pushState({...history.state, uiDialog:id},'',location.href);
    dialog.showModal();
    dialog.querySelector('h2')?.focus();
  }
  for (const dialog of root.querySelectorAll('[data-ui-panel-dialog]')) {
    listen(dialog,'cancel',event=>{event.preventDefault();back();});
  }
  listen(root,'click',event=>{
    const opener=event.target.closest('[data-ui-open-dialog]');
    if (opener) openPanel(root.querySelector('#'+CSS.escape(opener.dataset.uiOpenDialog)),opener);
    if (event.target.closest('[data-ui-close-dialog]')) back();
  });
  // Deep links still reveal their destination after moving occasional settings
  // into disclosures (for example a product's unit conversion shortcut).
  function revealHash() {
    if (!location.hash) return;
    let target; try { target=root.querySelector(location.hash); } catch { return; }
    if (!target) return;
    if (target.matches('[data-ui-panel-dialog]')) { openPanel(target,document.activeElement); return; }
    for(let parent=target;parent&&parent!==root;parent=parent.parentElement) if(parent.matches('details')) parent.open=true;
  }
  revealHash(); listen(window,'hashchange',revealHash);
  controllers.set(root, {confirm});
  async function submit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !root.contains(form)) return;
    let options;
    if (form.hasAttribute('data-ui-confirm')) {
      try { options = JSON.parse(form.dataset.uiConfirm); } catch { event.preventDefault(); return; }
    } else if (form.matches('[data-delete-cell-form]')) {
      options = {title:'Delete location', label:'Delete location', danger:true,
        message:'The location must be empty. Its LED module remains available for mapping.',
        facts:[['Location',form.dataset.cellName||'Selected location']]};
      if (form.dataset.cellHasStock === 'true') {
        event.preventDefault(); event.stopImmediatePropagation();
        globalThis.WarehouseNotifications?.notify('Move all stock out before deleting this location.',{tone:'error'});
        return;
      }
    } else return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!form.reportValidity()) return;
    const submitter = event.submitter;
    if (!await confirm(options, submitter) || !form.isConnected) return;
    // A confirmed native POST keeps the original fields and endpoint. Bypass
    // only the previous browser confirmation, never the server authorization.
    if (submitter?.name) {
      const field = document.createElement('input');
      field.type='hidden'; field.name=submitter.name; field.value=submitter.value; form.append(field);
    }
    if (submitter) submitter.disabled = true;
    HTMLFormElement.prototype.submit.call(form);
  }
  listen(root,'submit',submit,true);

  // Existing setup/QR dialogs retain their contents and handlers; adopt only
  // the shared header and Back affordance used by the Work dialogs.
  function enhanceDialogs() {
    for (const dialog of root.querySelectorAll('dialog:not(.ui-dialog)')) {
      let header = dialog.querySelector('.review-task-header');
      if (!header) {
        const title = dialog.querySelector(':scope > h2');
        if (title) {
          header = document.createElement('header');
          header.className = 'review-task-header';
          title.replaceWith(header); header.append(title);
        }
      }
      if (!header || header.querySelector('[data-ui-dialog-back],[data-review-back],[data-ui-close-dialog]')) continue;
      const button = document.createElement('button');
      button.type='button'; button.className='ui-button-secondary'; button.dataset.uiDialogBack=''; button.textContent='← Back';
      header.prepend(button);
    }
  }
  listen(root,'click',event=>{
    const button=event.target.closest('[data-ui-dialog-back]');
    if (!button) return;
    const dialog=button.closest('dialog');
    const close=dialog?.querySelector('[data-close-location],[data-cancel]');
    if (close) close.click(); else dialog?.close();
  });
  const observer = new MutationObserver(enhanceDialogs);
  observer.observe(root,{subtree:true,childList:true});
  enhanceDialogs();
  scope?.own(()=>{observer.disconnect();finish();controllers.delete(root);scope.ownsPop=oldOwnsPop;});
}
export function requestUiConfirmation(options, opener = document.activeElement) {
  mount();
  return controllers.get(document.querySelector('.ui-template'))?.confirm(options, opener) || Promise.resolve(false);
}
if (typeof document!=='undefined' &&!globalThis.WarehouseNavigation?.mounting) mount();
