// Page modules own listeners, reads and timers; the surrounding app shell lives on.
export class PageScope {
  constructor(host=globalThis){this.host=host;this.active=true;this.cleanups=new Set();this.leavers=[];this.abort=new AbortController();}
  listen(target,type,listener,options){
    if(!this.active)return;
    if(type==='pagehide')this.cleanups.add(()=>listener({type:'pagehide',persisted:false}));
    target.addEventListener(type,listener,options);
    this.cleanups.add(()=>target.removeEventListener(type,listener,options));
  }
  timeout(callback,delay,...args){if(!this.active)return;let cleanup;const id=this.host.setTimeout(()=>{this.cleanups.delete(cleanup);if(this.active)callback(...args);},delay);cleanup=()=>this.host.clearTimeout(id);this.cleanups.add(cleanup);return id;}
  interval(callback,delay,...args){if(!this.active)return;const id=this.host.setInterval(()=>{if(this.active)callback(...args);},delay);this.cleanups.add(()=>this.host.clearInterval(id));return id;}
  frame(callback){if(!this.active)return;let cleanup;const id=this.host.requestAnimationFrame(time=>{this.cleanups.delete(cleanup);if(this.active)callback(time);});cleanup=()=>this.host.cancelAnimationFrame(id);this.cleanups.add(cleanup);return id;}
  async fetch(input,options={}){
    if(!this.active)throw new DOMException('Page changed','AbortError');
    // Mutations retain their receipt semantics; only obsolete reads are aborted.
    const method=String(options.method||'GET').toUpperCase();
    return this.host.fetch(input,['GET','HEAD'].includes(method)?{...options,signal:options.signal?AbortSignal.any([this.abort.signal,options.signal]):this.abort.signal}:options);
  }
  beforeLeave(callback){this.leavers.push(callback);}
  async leave(){for(const callback of this.leavers)await callback();}
  own(cleanup){if(this.active)this.cleanups.add(cleanup);else cleanup();}
  dispose(){if(!this.active)return;this.abort.abort();for(const cleanup of [...this.cleanups].reverse())try{cleanup();}catch{}this.cleanups.clear();this.active=false;this.leavers=[];}
}
if(typeof document!=='undefined')globalThis.WarehousePageLifecycle={current:new PageScope()};
