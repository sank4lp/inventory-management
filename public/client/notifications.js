import {NotificationStore} from './notification-store.js';

let button=document.querySelector('[data-notifications-button]');
const offlineTitle=document.querySelector('.offline-shell h1')||(!document.body.dataset.accountId&&document.querySelector('#stocktaking-app')?document.querySelector('.page-header h1'):null);
if(!button&&offlineTitle){const header=offlineTitle.closest('.page-header')||document.createElement('header');if(!header.isConnected){header.className='page-header';offlineTitle.before(header);header.append(offlineTitle);}button=document.createElement('button');button.type='button';button.className='global-notifications-button';button.setAttribute('aria-label','Notifications');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','global-notifications');button.innerHTML='<svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span class="global-notification-count" data-notification-count hidden>0</span>';header.append(button);}

let storage;try{storage=localStorage;}catch{}
let scope;try{scope=JSON.parse(document.body.dataset.notificationScope||'null');}catch{}
let store=new NotificationStore({storage,scope});
const panel=document.createElement('section');
panel.id='global-notifications';panel.className='global-notification-panel';
panel.setAttribute('popover','auto');panel.setAttribute('aria-label','Notifications');
panel.innerHTML='<header><h2>Notifications</h2><button type="button" class="notification-close" aria-label="Close notifications">×</button></header><button type="button" class="secondary notification-clear" data-clear-notifications>Clear all</button><ol></ol><p data-notification-empty>No notifications yet.</p>';
document.body.append(panel);
const host=document.createElement('div');host.className='global-toast-host';
host.setAttribute('popover','manual');host.setAttribute('aria-live','polite');host.setAttribute('aria-atomic','true');document.body.append(host);
const nativeLayers=typeof panel.showPopover==='function';
if(!nativeLayers){panel.hidden=true;host.hidden=true;}
const isOpen=element=>nativeLayers?element.matches(':popover-open'):!element.hidden;
function showLayer(element){if(nativeLayers)element.showPopover();else{element.hidden=false;element.classList.add('is-open');if(element===panel)button?.setAttribute('aria-expanded','true');}}
function hideLayer(element){if(nativeLayers)element.hidePopover();else{element.hidden=true;element.classList.remove('is-open');if(element===panel)button?.setAttribute('aria-expanded','false');}}
let timer,exitTimer;
function render() {
  const unread=store.unread;
  if(button){button.setAttribute('aria-label',unread?`Notifications, ${unread} unread`:'Notifications');const badge=button.querySelector('[data-notification-count]');badge.textContent=unread>99?'99+':String(unread);badge.hidden=!unread;}
  const list=panel.querySelector('ol');list.replaceChildren();
  for(const row of store.rows) {
    const item=document.createElement('li');item.dataset.tone=row.tone;
    const text=document.createElement(row.href?'a':'p');text.textContent=row.message;if(row.href)text.href=row.href;
    const time=document.createElement('time');time.dateTime=new Date(row.at).toISOString();time.textContent=new Date(row.at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='notification-close';dismiss.setAttribute('aria-label','Dismiss '+row.message);dismiss.textContent='×';dismiss.onclick=()=>{store.dismiss(row.id);render();if(host.querySelector(`[data-notification-id="${row.id}"]`))dismissToast();};item.append(text,time,dismiss);list.append(item);
  }
  panel.querySelector('[data-notification-empty]').hidden=Boolean(store.rows.length);panel.querySelector('[data-clear-notifications]').disabled=!store.rows.length;
}
function positionPanel() {
  const box=button?.getBoundingClientRect();if(!box)return;
  panel.style.top=Math.max(8,Math.min(box.bottom+8,innerHeight-140))+'px';
  const width=Math.min(document.documentElement.clientWidth,document.documentElement.getBoundingClientRect().width),panelWidth=Math.min(380,width-32);
  panel.style.width=panelWidth+'px';
  panel.style.left=Math.max(12,Math.min(box.right-panelWidth,width-panelWidth-12))+'px';panel.style.right='auto';
  panel.style.maxHeight=Math.max(120,innerHeight-box.bottom-24)+'px';
}
function closePanel(){if(isOpen(panel)){hideLayer(panel);button?.focus();}}
function dismissToast(){clearTimeout(timer);host.replaceChildren();if(isOpen(host))hideLayer(host);}
function showToast(row) {
  clearTimeout(timer);clearTimeout(exitTimer);host.setAttribute('aria-live',row.tone==='error'?'assertive':'polite');
  // At most two layers occupy the SAME slot during the crossfade; never a tall stack.
  for(const stale of host.querySelectorAll('.is-leaving'))stale.remove();
  const previous=host.lastElementChild;if(previous){previous.classList.add('is-leaving');previous.setAttribute('aria-hidden','true');previous.inert=true;}
  const toast=document.createElement('div');toast.className='global-toast';toast.dataset.tone=row.tone;toast.dataset.notificationId=row.id;
  const text=document.createElement('p');text.textContent=row.message;
  const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='notification-close';dismiss.setAttribute('aria-label','Dismiss notification');dismiss.textContent='×';dismiss.onclick=()=>{store.dismiss(row.id);render();dismissToast();};
  toast.append(text,dismiss);host.append(toast);if(!isOpen(host))showLayer(host);
  exitTimer=setTimeout(()=>previous?.remove(),240);timer=setTimeout(dismissToast,10000);
}
function notify(message,options={}) {
  // Offline shells have no signed-in server header; use the cached work's own identity.
  if(!scope&&options.scope){scope=options.scope;store=new NotificationStore({storage,scope});}
  if(scope&&options.scope&&JSON.stringify(scope)!==JSON.stringify(options.scope))return;
  const row=store.add(message,options);render();if(!row)return;
  if(isOpen(panel))store.read();render();showToast(row);
}
globalThis.WarehouseNotifications={notify,clearKey(key){store.clearKey(key);},setOfflineScope(snapshot){if(document.body.dataset.accountId||!snapshot?.user)return;const next=[snapshot.site,snapshot.dataset,snapshot.user.id];if(JSON.stringify(scope)===JSON.stringify(next))return;scope=next;dismissToast();closePanel();store=new NotificationStore({storage,scope});render();}};
for(const item of globalThis.warehouseNotificationQueue||[])notify(item.message,item.options);
globalThis.warehouseNotificationQueue=[];
button?.addEventListener('click',()=>{
  if(isOpen(panel))closePanel();else{store.sync();store.read();render();positionPanel();showLayer(panel);panel.querySelector('button').focus();}
});
panel.querySelector('header button').onclick=closePanel;panel.querySelector('[data-clear-notifications]').onclick=()=>{store.clear();render();dismissToast();};
panel.addEventListener('toggle',()=>button?.setAttribute('aria-expanded',String(isOpen(panel))));
window.addEventListener('resize',positionPanel);window.addEventListener('scroll',positionPanel,true);
window.addEventListener('storage',event=>{if(event.key===store.key){store.sync();render();}});
document.addEventListener('click',event=>{if(!nativeLayers&&isOpen(panel)&&!panel.contains(event.target)&&!button?.contains(event.target))closePanel();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePanel();dismissToast();}});
// Convert shared server flashes and changing health/reminder messages into notifications.
const sourceObservers=new Map();
function captureSources(container=document){for(const [source,observer] of sourceObservers)if(!source.isConnected){observer.disconnect();sourceObservers.delete(source);}for(const source of container.querySelectorAll('[data-notification-source]')) {if(source.dataset.notificationBound)return;source.dataset.notificationBound='true';
  let previousMessage='';const capture=()=>{
    const message=source.textContent.trim();if(!message){if(previousMessage&&source.dataset.notificationKey)store.clearKey(source.dataset.notificationKey);previousMessage='';return;}previousMessage=message;
    notify(message,{tone:source.dataset.notificationTone||'info',key:source.dataset.notificationKey||'',href:source.querySelector('a')?.getAttribute('href')||''});
  };
  capture();const observer=new MutationObserver(capture);observer.observe(source,{childList:true,subtree:true,characterData:true});sourceObservers.set(source,observer);
} }
captureSources();
window.addEventListener('warehouse:page-loaded',()=>captureSources(document.querySelector('.page-body')));
render();
