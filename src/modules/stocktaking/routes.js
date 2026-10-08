import {page} from '../../render.js';
import {sendHtml,sendJson} from '../../server/http/responses.js';
import {ensureAuth,ensureApiAuth} from '../../server/http/auth-guards.js';
export async function stocktakingRoutes(request,response,url,user,state) {
  const service=state.stocktakingService;
  if(url.pathname.startsWith('/api/stocktaking/')) {
    if(!ensureApiAuth(response,user))return true;
    const action=url.pathname.slice('/api/stocktaking/'.length);
    if(request.method==='GET'&&action==='snapshot')sendJson(response,service.snapshot(user));
    else if(request.method==='GET'&&action==='movements')sendJson(response,service.movements(user,url.searchParams.get('observationId'),url.searchParams.get('q')||''));
    else if(request.method==='POST')sendJson(response,service.command(user,action,request.parsedForm));
    else sendJson(response,{error:'Action not found.'},404);
    return true;
  }
  if(request.method==='GET'&&['/stocktaking','/stocktaking/results','/stocktaking/offline'].includes(url.pathname)) {
    const offline=url.pathname==='/stocktaking/offline';if(!offline&&!ensureAuth(response,user))return true;
    const snapshot=offline?null:service.snapshot(user),boot=JSON.stringify(snapshot).replace(/</g,'\\u003c');
    sendHtml(response,page({title:'Stocktaking',user:offline?null:user,content:`<div id="stocktaking-app"><p>Loading stocktaking…</p></div><script id="stocktaking-boot" type="application/json">${boot}</script><script src="/client/vendor/jsQR.js"></script><script type="module" src="/client/stocktaking.js"></script>`}),200,{'Cache-Control':'no-store'});return true;
  }
  return false;
}
