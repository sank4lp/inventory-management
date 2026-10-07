export async function mount() {
const pageScope=globalThis.WarehousePageLifecycle?.current;
const setTimeout=(...args)=>pageScope?pageScope.timeout(...args):globalThis.setTimeout(...args);
const setInterval=(...args)=>pageScope?pageScope.interval(...args):globalThis.setInterval(...args);
const requestAnimationFrame=(...args)=>pageScope?pageScope.frame(...args):globalThis.requestAnimationFrame(...args);
const fetch=(...args)=>pageScope?pageScope.fetch(...args):globalThis.fetch(...args);
const onPage=(target,...args)=>pageScope?pageScope.listen(target,...args):target.addEventListener(...args);
const root=document.querySelector('[data-display-console]');
if (root) {
 const message = root.querySelector('[data-display-message]');
 const active = root.querySelector('[data-display-active]');
 async function request(path, body) {
  const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: {'Content-Type':'application/json'}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(15000)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Display request could not be confirmed.');
  return result;
 }
 async function show() {
  try {
   const rows = await request('/api/displays/status');
   active.replaceChildren();
   for (const row of rows) {
    const p = document.createElement('p');
    p.textContent = `Display ${row.state} until ${new Date(row.expires_at).toLocaleTimeString()}. `;
    if (row.canStop) {
     const button = document.createElement('button');
     button.textContent = 'Stop showing';
     button.onclick = async () => {
      button.disabled = true;
      try { const result = await request('/api/displays/stop', {displayId: row.id}); message.textContent = result.message || 'Display stopped.'; await show(); }
      catch (error) { message.textContent = error.message; button.disabled = false; }
     };
     p.append(button);
    } else p.append('Owned by another operator.');
    active.append(p);
   }
  } catch { message.textContent = 'Display status could not be refreshed. Reconnect to confirm its status.'; }
 }
 const start = root.querySelector('[data-display-start]');
 let pendingRequest;
 if (start) start.onclick = async () => {
  start.disabled = true;
  pendingRequest ||= {...JSON.parse(root.dataset.scope), requestId: crypto.randomUUID()};
  try {
   const result = await request('/api/displays/start', pendingRequest);
   pendingRequest = null;
   const counts = {numeric:0, locator:0, unmapped:0, unreachable:0};
   for (const target of result.targets || []) {
    if (target.status === 'sent') counts[target.numeric ? 'numeric' : 'locator']++;
    else counts[target.status] = (counts[target.status] || 0) + 1;
   }
   message.textContent = (result.message || result.error || 'Display request confirmed.') + ' ' + Object.entries(counts).map(([key,value]) => `${value} ${key}`).join(' · ');
   await show();
  } catch (error) { message.textContent = error.message + ' Retry to confirm the same request.'; }
  finally { start.disabled = false; }
 };
 show();
 setInterval(show, 20000);
 onPage(window,'online', show);
}
// Old utility controls lead to the same scope-aware, owner-safe display workspace.
onPage(document,'click',event=>{const b=event.target.closest('[data-locate-cell],[data-ping-cell]');if(!b||b.disabled)return;event.preventDefault();event.stopImmediatePropagation();const cell=b.dataset.cellId,q=new URLSearchParams();if(cell)q.set('cellId',cell);q.set('kind','locate');location.href='/quantities?'+q;},true);
const currentPath=location.pathname;
const currentArea=/^\/(settings|admin|devices|backups|location-setup)(\/|$)/.test(currentPath)?'/settings':currentPath==='/work/timing'?'/settings':currentPath==='/profile'?null:/^\/products(\/|$)/.test(currentPath)?'/products':/^\/(cells|locations|labels)(\/|$)/.test(currentPath)?'/cells':currentPath==='/quantities'?(new URLSearchParams(location.search).has('productId')?'/products':'/cells'):/^\/stocktaking(\/|$)/.test(currentPath)?'/stocktaking':/^\/reports(\/|$)/.test(currentPath)?'/reports':'work';
for(const link of document.querySelectorAll('.sidebar-footer>a,[data-nav-links]>a')){const active=currentArea==='work'?['/work','/work/overview'].includes(link.getAttribute('href')):link.getAttribute('href')===currentArea;link.classList.toggle('nav-link-active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}

}
if(typeof document!=='undefined'&&!globalThis.WarehouseNavigation?.mounting)await mount();
