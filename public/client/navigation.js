import {PageScope} from './page-lifecycle.js';

export const PAGE_MODULES=new Set(['/app.js','/client/displays.js','/client/recommendation-actuals.js','/client/work.js','/client/stocktaking.js','/client/location-setup.js','/client/location-browse.js','/client/location-history.js','/client/product-settings.js','/client/roles.js']);
export function navigationTarget(href,current){const target=new URL(href,current),from=new URL(current);return target.origin===from.origin&&!/^\/(api|auth|login|logout|register|offline)(\/|$)/.test(target.pathname)?target:null;}
const shell=typeof document!=='undefined'&&document.querySelector('.dashboard-body .dashboard-shell'),body=typeof document!=='undefined'&&document.querySelector('.page-body');
if(shell&&body){
 let current=location.href,loading=null,serial=0,committing=false,queued=null;
 if('scrollRestoration' in history)history.scrollRestoration='manual';
 document.body.dataset.shellId=crypto.randomUUID();
 const identity=document.body.dataset.notificationScope;
 const loadedClassic=new Set([...document.querySelectorAll('script[src]:not([type="module"])')].map(s=>new URL(s.src,location.href).pathname));
 const persistent=new Set(['/client/navigation.js','/client/page-lifecycle.js','/client/searchable-select.js','/client/notifications.js','/client/mobile-nav.js','/client/work-outbox-status.js','/client/stocktake-status.js']);
 const currentScope=()=>globalThis.WarehousePageLifecycle.current;
 const savedPositions=new Map();let deciding=false;
 async function permitLeave(pop){if(deciding)return false;deciding=true;try{const permitted=await currentScope().canLeave();if(!permitted&&pop){history.pushState({warehousePage:true},'',current);window.dispatchEvent(new CustomEvent('warehouse:navigation-cancelled'));}return permitted;}finally{deciding=false;}}
 function updateSidebar(next){
   const old=document.querySelector('.dashboard-sidebar'),fresh=next.querySelector('.dashboard-sidebar');
   if(!old||!fresh)return;
   // Retain the sidebar itself. Refresh its contents only if the permitted links changed.
   const signature=node=>JSON.stringify([...node.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')));
   if(signature(old)!==signature(fresh)){location.reload();return;}
   const counterparts=[...fresh.querySelectorAll('a[href]')];
   for(const [index,link] of [...old.querySelectorAll('a[href]')].entries()){const counterpart=counterparts[index];if(!counterpart)continue;link.classList.toggle('nav-link-active',counterpart.classList.contains('nav-link-active'));if(counterpart.hasAttribute('aria-current'))link.setAttribute('aria-current',counterpart.getAttribute('aria-current'));else link.removeAttribute('aria-current');}
   old.classList.remove('mobile-menu-open');const menu=old.querySelector('.mobile-nav-toggle');if(menu){menu.setAttribute('aria-expanded','false');menu.textContent='Menu';}
 }
 async function script(source,token){
   const url=new URL(source.getAttribute('src'),location.href);if(url.origin!==location.origin)throw Error('This page needs a refresh.');const path=url.pathname;
   if(persistent.has(path))return;
   if(source.type==='module'){if(!PAGE_MODULES.has(path))throw Error('This page needs a refresh.');const module=await import(path);await module.mount();return;}
   if(source.type!=='module'&&loadedClassic.has(path))return;
   await new Promise((resolve,reject)=>{const tag=document.createElement('script');tag.src=source.type==='module'?path+'?page='+token:path;tag.type=source.type;tag.dataset.pageScript='';tag.onload=resolve;tag.onerror=()=>reject(Error('Could not load this page.'));document.body.append(tag);});
   if(source.type!=='module')loadedClassic.add(path);
 }
 async function go(href,{pop=false,replace=false,refresh=false}={}){
   if(committing){queued=[href,{pop,replace}];return;}
   const target=navigationTarget(href,location.href);
   if(target?.href===current&&!pop&&!refresh)return;
   if(!await permitLeave(pop))return;
   if(!target){location.assign(href);return;}
   const token=++serial;loading?.abort();const controller=new AbortController();loading=controller;
   body.setAttribute('aria-busy','true');
   try{
     const response=await fetch(target.href,{headers:{Accept:'text/html'},cache:'no-store',signal:controller.signal});
     if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))throw Error('This page could not be opened. Try again.');
     const next=new DOMParser().parseFromString(await response.text(),'text/html'),content=next.querySelector('.page-body');
     if(token!==serial)return;
     const sources=new Map();for(const source of next.querySelectorAll('script[src]'))sources.set(new URL(source.src,location.href).pathname,source);const scripts=[...sources.values()];
     const unsupported=[...next.querySelectorAll('script:not([src])')].some(s=>s.type!=='application/json'&&s.textContent.trim())||scripts.some(s=>s.type==='module'&&!persistent.has(new URL(s.src,location.href).pathname)&&!PAGE_MODULES.has(new URL(s.src,location.href).pathname));
     if(!content||next.body.dataset.notificationScope!==identity||unsupported){location.assign(response.url||target.href);return;}
     await currentScope().leave();if(token!==serial)return;
     committing=true;globalThis.WarehouseNavigation.mounting=true;
     savedPositions.set(current,{x:scrollX,y:scrollY});
     currentScope().dispose();document.querySelectorAll('[data-page-script]').forEach(s=>s.remove());
     globalThis.WarehousePageLifecycle.current=new PageScope();
     current=response.url||target.href;
     if(!pop){const state={warehousePage:true};if(replace)history.replaceState(state,'',current);else history.pushState(state,'',current);}
     for(const executable of content.querySelectorAll('script[src],script:not([type="application/json"])'))executable.remove();
     body.replaceChildren(...content.childNodes);
     const health=document.querySelector('[data-system-notice]'),freshHealth=next.querySelector('[data-system-notice]');if(health&&freshHealth){health.textContent=freshHealth.textContent;health.hidden=freshHealth.hidden;}
     document.title=next.title;const heading=document.querySelector('.page-header h1');heading.textContent=next.querySelector('.page-header h1')?.textContent||next.title;
     updateSidebar(next);
     // New flash messages belong to this page, while the reminder and bell stay mounted.
     for(const source of next.querySelectorAll('[data-notification-source]:not([data-stocktake-reminder]):not([data-system-notice])'))if(!source.closest('.page-body'))body.append(source.cloneNode(true));
     window.dispatchEvent(new CustomEvent('warehouse:page-loaded'));
     for(const source of scripts)await script(source,token);
     if(token!==serial)return;
     const destination=new URL(current),anchor=destination.hash&&document.getElementById(decodeURIComponent(destination.hash.slice(1)));
     if(anchor)anchor.scrollIntoView();else{const position=pop?savedPositions.get(current):null;scrollTo(position?.x||0,position?.y||0);}
     heading.tabIndex=-1;heading.focus({preventScroll:true});
   }catch(error){
     if(error.name==='AbortError')return;
     if(pop)history.pushState({warehousePage:true},'',current);
     globalThis.WarehouseNotifications?.notify(error.message||'Could not open this page. Try again.',{tone:'error'});
     if(committing)location.replace(current);
   }finally{if(token===serial){body.removeAttribute('aria-busy');loading=null;}if(committing){committing=false;globalThis.WarehouseNavigation.mounting=false;if(queued){const next=queued;queued=null;void go(...next);}}}
 }
 globalThis.WarehouseNavigation={go,adopt(href){current=new URL(href,location.href).href;}};
 document.addEventListener('click',event=>{
   const link=event.target.closest?.('a[href]');if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.hasAttribute('download')||(link.target&&link.target!=='_self'))return;
   const target=navigationTarget(link.href,location.href);if(!target)return;
   if(target.pathname===location.pathname&&target.search===location.search&&target.hash)return;
   event.preventDefault();void go(target.href);
 });
 document.addEventListener('submit',event=>{
   const form=event.target;if(event.defaultPrevented||!(form instanceof HTMLFormElement)||form.target||(event.submitter?.formMethod||form.method||'get').toLowerCase()!=='get')return;
   const target=navigationTarget(event.submitter?.formAction||form.action,location.href);if(!target)return;
   const data=new FormData(form,event.submitter);target.search=new URLSearchParams([...data].filter(([,value])=>typeof value==='string')).toString();event.preventDefault();void go(target.href);
 });
 window.addEventListener('popstate',event=>{
   // Modal frames remain owned by the current page; filters reload only their content.
   const previous=new URL(current);
   if(currentScope().ownsPop?.(event))return;
   if(previous.pathname===location.pathname&&(event.state?.workModal||previous.search===location.search))return;
   if(location.href===current)return;
   void go(location.href,{pop:true});
 });
}
