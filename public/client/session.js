const READ_TIMEOUT_MS=15000;
const RECHECK_AFTER_MS=60000;
export class SessionExpiredError extends Error {
 constructor(){super('Your session ended. Sign in again to continue.');this.name='SessionExpiredError';this.reauthentication=true;}
}
export function sessionRequestUrl(input,base){try{return new URL(typeof input==='string'||input instanceof URL?input:input.url,base);}catch{return null;}}
export function sessionResponseExpired(response,origin){
 if(response.status===401)return true;
 if(!response.redirected||!response.url)return false;
 const url=new URL(response.url,origin);return url.origin===origin&&url.pathname==='/login';
}
export function readRequestOptions(options={},timeoutMs=READ_TIMEOUT_MS){
 const timeout=AbortSignal.timeout(timeoutMs);
 return {...options,signal:options.signal?AbortSignal.any([options.signal,timeout]):timeout};
}
export function installSessionGuard(host=globalThis){
 const doc=host.document;if(!doc?.body?.dataset.accountId||host.WarehouseSession)return host.WarehouseSession;
 const originalFetch=host.fetch.bind(host),nativeFetch=host.fetch,account=String(doc.body.dataset.accountId);
 let deadline=null,timer=null,ended=false,disposed=false,checking=null,lastChecked=Date.now();
 const listeners=[];
 function on(target,type,fn,options){target.addEventListener(type,fn,options);listeners.push(()=>target.removeEventListener(type,fn,options));}
 function end(){
  if(ended||disposed)return;ended=true;host.clearTimeout(timer);
  host.dispatchEvent(new host.CustomEvent('warehouse:session-expired'));
  // Keep local drafts and original request receipts for the same user to recover.
  host.location.replace('/login?flash=Your+session+ended.+Sign+in+again+to+continue.&tone=info');
 }
 function check(){if(ended)return false;if(deadline!==null&&Date.now()>=deadline){end();return false;}return true;}
 function remaining(ms){
  if(ms===undefined||ms===null||ms==='')return;
  const value=Number(ms);if(!Number.isFinite(value)||value<0)return;
  deadline=Date.now()+value;host.clearTimeout(timer);
  if(check())timer=host.setTimeout(check,Math.min(value,2147483647));
 }
 async function guardedFetch(input,options={}){
  const url=sessionRequestUrl(input,host.location.href),local=url?.origin===host.location.origin;
  if(local&&!check())throw new SessionExpiredError();
  const method=String(options.method||input?.method||'GET').toUpperCase();
  const response=await originalFetch(input,local&&['GET','HEAD'].includes(method)?readRequestOptions(options):options);
  if(local&&sessionResponseExpired(response,host.location.origin)){end();throw new SessionExpiredError();}
  return response;
 }
 async function verify(){
  if(disposed||ended||doc.visibilityState==='hidden'||!check())return;
  if(checking)return checking;
  lastChecked=Date.now();
  checking=(async()=>{
   try{
    const response=await originalFetch('/api/session',readRequestOptions({cache:'no-store',credentials:'same-origin'},10000));
    if(disposed)return;
    if(sessionResponseExpired(response,host.location.origin)){end();return;}
    if(!response.ok)return;
    const value=await response.json();if(disposed)return;
    if(String(value.userId)!==account){end();return;}
    remaining(value.remainingMs);
   }catch{/* A lost warehouse connection is not proof that authentication expired. */}
   finally{checking=null;}
  })();return checking;
 }
 function resume(){if(!check())return;if(doc.visibilityState!=='hidden'&&Date.now()-lastChecked>=RECHECK_AFTER_MS)void verify();}
 function interaction(event){if(check())return;event.preventDefault();event.stopImmediatePropagation();}
 const api={check,remaining,verify,dispose(){disposed=true;host.clearTimeout(timer);for(const remove of listeners)remove();if(host.fetch===guardedFetch)host.fetch=nativeFetch;delete host.WarehouseSession;}};
 host.WarehouseSession=api;host.fetch=guardedFetch;
 for(const type of ['click','submit','keydown'])on(doc,type,interaction,true);
 on(doc,'visibilitychange',resume);on(host,'pageshow',resume);on(host,'focus',resume);on(host,'online',()=>{if(check())void verify();});
 remaining(doc.body.dataset.sessionRemainingMs);
 return api;
}
if(typeof document!=='undefined')installSessionGuard();
