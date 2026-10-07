// Read-only, account-scoped notice on every signed-in page. Delivery stays in Work.
const account=document.body.dataset.accountId;
if(account && !document.querySelector('#work-app')) {
  const request=indexedDB.open('lytguide-work',1);
  request.onupgradeneeded=()=>{for(const name of ['cache','outbox'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'id'});};
  request.onsuccess=()=>{
    const db=request.result;
    const read=()=>{
      const tx=db.transaction('outbox'),get=tx.objectStore('outbox').getAll();
      get.onsuccess=()=>{
        const pending=get.result.filter(o=>o.partition?.endsWith(':'+account)&&!(o.action==='recordMovement'&&o.state==='not-applied')&&['local','sending','error','rejected','not-applied','activation-pending','activation-unknown'].includes(o.state));
        let strip=document.querySelector('#saved-work-status');
        if(!pending.length){strip?.remove();return;}
        if(!strip){strip=document.createElement('aside');strip.id='saved-work-status';strip.className='work-callout warning';strip.setAttribute('role','status');document.querySelector('main')?.prepend(strip);}
        strip.replaceChildren(document.createTextNode(`${pending.length} saved work update(s) need attention. They stay with this account after sign out. `));
        const link=document.createElement('a');link.href='/work';link.textContent='Open saved work';strip.append(link);
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
