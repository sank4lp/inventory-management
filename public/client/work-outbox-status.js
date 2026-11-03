// Read-only, account-scoped notice on every signed-in page. Delivery stays in Work.
const account=document.body.dataset.accountId;
let notificationScope;try{notificationScope=JSON.parse(document.body.dataset.notificationScope||'null');}catch{}
if(account && !document.querySelector('#work-app')) {
  const request=indexedDB.open('lytguide-work',1);
  request.onupgradeneeded=()=>{for(const name of ['cache','outbox'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'id'});};
  request.onsuccess=()=>{
    const db=request.result;
    const read=()=>{
      const tx=db.transaction('outbox'),get=tx.objectStore('outbox').getAll();
      get.onsuccess=()=>{
        const pending=get.result.filter(o=>(notificationScope?o.partition===`${notificationScope[0]}:${account}`:o.partition?.endsWith(':'+account))&&!(o.action==='recordMovement'&&o.state==='not-applied')&&['local','sending','error','rejected','not-applied','activation-pending','activation-unknown'].includes(o.state));
        if(!pending.length){globalThis.WarehouseNotifications?.clearKey?.('saved-work');return;}
        const item={message:`${pending.length} saved work update(s) need attention. Open My Work to check or retry.`,options:{key:'saved-work',tone:'warning',href:'/work'}};
        if(globalThis.WarehouseNotifications)globalThis.WarehouseNotifications.notify(item.message,item.options);
        else(globalThis.warehouseNotificationQueue||=[]).push(item);
      };
    };read();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')read();});
  };
}

// Contextual Pick/Put links retain the product/location filters and scroll position.
if(account){
 document.addEventListener('click',event=>{
  const link=event.target.closest('a[href]');if(!link)return;
  const target=new URL(link.href,location.href);
  if(target.origin===location.origin&&['/pick','/put'].includes(target.pathname)&&/^\/(products|cells)(\/|$)/.test(location.pathname)){
   const origin=location.pathname+location.search+location.hash;target.searchParams.set('return_to',origin);link.href=target.pathname+target.search;
   try{sessionStorage.setItem('work-origin:'+account,JSON.stringify({origin,top:scrollY}));}catch{}
  }
 });
 try{const saved=JSON.parse(sessionStorage.getItem('work-origin:'+account)||'null');if(saved?.origin===location.pathname+location.search+location.hash)requestAnimationFrame(()=>scrollTo({top:saved.top,behavior:'instant'}));}catch{}
}
