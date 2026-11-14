import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import vm from 'node:vm';
import {installSessionGuard,SessionExpiredError,readRequestOptions} from '../public/client/session.js';

class TestHost extends EventTarget {
 constructor(fetch){super();this.fetch=fetch;this.document=new EventTarget();this.document.body={dataset:{accountId:'1',sessionRemainingMs:'43200000'}};this.document.visibilityState='visible';this.replacements=[];this.location={href:'http://warehouse/work',origin:'http://warehouse',replace:path=>this.replacements.push(path)};this.CustomEvent=class extends Event{constructor(type){super(type);}};this.timers=new Map();this.sequence=0;this.setTimeout=(fn,delay)=>{this.timers.set(++this.sequence,{fn,delay});return this.sequence;};this.clearTimeout=id=>this.timers.delete(id);}
}
test('a sleeping tab checks its wall-clock expiry before a click and keeps device work intact',()=>{
 const now=Date.now;let time=now();Date.now=()=>time;
 try{
  const host=new TestHost(async()=>({status:200})),guard=installSessionGuard(host);let actions=0,expirations=0;
  host.document.addEventListener('click',()=>actions++);host.addEventListener('warehouse:session-expired',()=>expirations++);
  assert.equal(guard.check(),true);time+=24*60*60*1000;
  const click=new Event('click',{cancelable:true});host.document.dispatchEvent(click);
  assert.equal(click.defaultPrevented,true);assert.equal(actions,0);assert.equal(expirations,1);assert.match(host.replacements[0],/^\/login\?/);assert.equal(guard.check(),false);host.document.dispatchEvent(new Event('submit',{cancelable:true}));assert.equal(host.replacements.length,1);assert.equal(host.timers.size,0);guard.dispose();
 }finally{Date.now=now;}
});
test('foreground expiry timer and page restore return to login without waiting for a warehouse API',()=>{
 const original=Date.now;let time=original();Date.now=()=>time;
 try{for(const event of ['timer','pageshow','focus','visibilitychange']){
  const host=new TestHost(async()=>{throw Error('The server is unreachable');}),guard=installSessionGuard(host);guard.remaining(5);time+=5;
  if(event==='timer')for(const value of [...host.timers.values()])value.fn();else (event==='visibilitychange'?host.document:host).dispatchEvent(new Event(event));
  assert.equal(host.replacements.length,1);guard.dispose();
 }}finally{Date.now=original;}
});
test('expired API responses and HTML login redirects never become permanent rejections of a saved mutation',async()=>{
 for(const response of [{status:401},{status:200,redirected:true,url:'http://warehouse/login'}]){
  const receipts=[],host=new TestHost(async(input,options)=>{receipts.push(options);return response;}),guard=installSessionGuard(host),pending={requestId:'original-request',quantity:4,state:'saved'};
  await assert.rejects(host.fetch('/api/work/report',{method:'POST',body:JSON.stringify(pending)}),error=>error instanceof SessionExpiredError&&error.reauthentication===true&&!error.definite);
  assert.equal(receipts.length,1);assert.equal(receipts[0].signal,undefined);assert.equal(JSON.parse(receipts[0].body).requestId,pending.requestId);assert.equal(pending.state,'saved');assert.equal(host.replacements.length,1);guard.dispose();
 }
});
test('a permission denial, external 401 and an unreachable server do not expire a valid warehouse session',async()=>{
 const host=new TestHost(async url=>{if(String(url).includes('unreachable'))throw Error('offline');return {status:String(url).includes('other.example')?401:403};}),guard=installSessionGuard(host);
 assert.equal((await host.fetch('/api/work/report',{method:'POST'})).status,403);assert.equal((await host.fetch('https://other.example/api')).status,401);await assert.rejects(host.fetch('/unreachable'),/offline/);assert.equal(host.replacements.length,0);assert.equal(guard.check(),true);guard.dispose();
});
test('resume verifies the account and expiry; a failed connection retains the session',async()=>{
 for(const state of ['valid','expired','other account','offline']){
  const host=new TestHost(async()=>{if(state==='offline')throw Error('offline');return state==='expired'?{status:401}:{status:200,ok:true,json:async()=>({userId:state==='other account'?2:1,remainingMs:123456})};}),guard=installSessionGuard(host);await guard.verify();
  assert.equal(host.replacements.length,state==='expired'||state==='other account'?1:0);if(state==='valid')assert.equal([...host.timers.values()][0].delay,123456);guard.dispose();
 }
});
test('stalled reads have a deadline and keep caller cancellation; mutation receipt handling stays unchanged',async()=>{
 const source=new AbortController(),options=readRequestOptions({signal:source.signal,cache:'no-store'},10);source.abort();assert.equal(options.signal.aborted,true);assert.equal(options.cache,'no-store');
 const stalled=readRequestOptions({},5);await Promise.all([new Promise(resolve=>setTimeout(resolve,10)),assert.rejects(new Promise((resolve,reject)=>stalled.signal.addEventListener('abort',()=>reject(stalled.signal.reason))),{name:'TimeoutError'})]);
});
test('navigation timeouts fall back to the existing saved-work page instead of waiting forever',async()=>{
 const handlers={},scope={URL,location:{origin:'http://warehouse'},AbortSignal,self:{addEventListener:(type,fn)=>handlers[type]=fn},fetch:async(request,options)=>{assert.ok(options.signal);throw Error('warehouse unavailable');},caches:{match:async key=>({offline:key})}};
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),scope);
 for(const path of ['/work','/stocktaking?run=1']){
  let reply;handlers.fetch({request:{url:'http://warehouse'+path,method:'GET',mode:'navigate'},respondWith:promise=>reply=promise});assert.equal((await reply).offline,path.startsWith('/stocktaking')?'/stocktaking/offline':'/offline');
 }
});
test('signed-in HTML exposes only remaining session time; expired requests cannot reach stock actions',async()=>{
 process.env.NO_SERVER_LISTEN='1';process.env.HARDWARE_ADAPTER='simulator';process.env.DEMO_INVENTORY_SEED='1';process.chdir(mkdtempSync(join(tmpdir(),'lyt-session-http-')));
 const {requestHandler}=await import('../src/server.js'),{getAppState}=await import('../src/server/app-state.js'),{createSessionCookie}=await import('../src/services/auth.js');
 const {db}=getAppState(),admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),cookie=createSessionCookie(admin);
 const call=async(path,cookie='',method='GET',data={})=>{
  const req=Readable.from(method==='POST'?[Buffer.from(JSON.stringify(data))]:[]);Object.assign(req,{url:path,method,headers:{host:'localhost',cookie,'content-type':'application/json'}});
  const res={statusCode:200,headers:{},body:'',writeHead(code,headers){this.statusCode=code;this.headers=headers;},end(body=''){this.body+=body;}};await requestHandler(req,res);return res;
 };
 const session=await call('/api/session',cookie),value=JSON.parse(session.body);assert.equal(session.statusCode,200);assert.equal(value.userId,admin.id);assert.ok(value.remainingMs>43100000&&value.remainingMs<=43200000);assert.equal(session.headers['Cache-Control'],'no-store');assert.deepEqual(Object.keys(value).sort(),['remainingMs','userId']);
 const work=await call('/work',cookie);assert.match(work.body,/data-session-remaining-ms="\d+"/);assert.match(work.body,/src="\/client\/session.js"/);assert.equal(work.headers['Cache-Control'],'no-store');
 const original=Date.now;let expired;try{Date.now=()=>original()-13*60*60*1000;expired=createSessionCookie(admin);}finally{Date.now=original;}
 const denied=await call('/api/session',expired);assert.equal(denied.statusCode,401);
 const login=await call('/work',expired);assert.equal(login.statusCode,302);assert.equal(login.headers.Location,'/login');assert.equal(login.headers['Cache-Control'],'no-store');
 const before=db.prepare('SELECT COUNT(*) n FROM tasks').get().n;assert.equal((await call('/api/work/create',expired,'POST',{direction:'pick',productId:1,quantity:1,requestId:'stale-session-request'})).statusCode,401);assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);
 assert.equal((await call('/api/session')).statusCode,401);
 const signIn=await call('/login');assert.equal(signIn.statusCode,200);assert.doesNotMatch(signIn.body,/data-session-remaining-ms|src="\/client\/session.js"/);
});
