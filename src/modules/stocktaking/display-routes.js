import {randomUUID} from 'node:crypto';
import {ensureAuth,ensureApiAuth} from '../../server/http/auth-guards.js';
import {sendJson,sendRedirect} from '../../server/http/responses.js';
export function displayRoutes(request,response,url,user,state) {
 const d=state.displayCoordinator;
 const displayKind=value=>['capacity_total','capacity_available'].includes(value)?value:'quantity';
 if(url.pathname==='/api/displays/status'){if(!ensureApiAuth(response,user))return true;sendJson(response,d.status(user));return true;}
 if(request.method==='POST'&&['/api/displays/start','/api/displays/stop'].includes(url.pathname)) {
   if(!ensureApiAuth(response,user))return true;const i=request.parsedForm;
   const scope={kind:['locate','ping','module_number'].includes(i.kind)?i.kind:displayKind(i.displayKind||i.kind),...(i.cellId?{cellId:Number(i.cellId)}:{}),...(i.productId?{productId:Number(i.productId)}:{}),...(i.overrideWork==='1'?{overrideWork:true}:{})};
   sendJson(response,url.pathname.endsWith('/stop')?d.stop(user,i.displayId):d.start(user,scope,{requestId:i.requestId,promptOnBusy:i.promptOnBusy==='1',confirmOverride:i.confirmOverride==='1',previewOnly:i.previewOnly==='1'}));return true;
 }
 // Retired display page: old bookmarks return to the normal product/location view.
 if(request.method==='GET'&&url.pathname==='/quantities'){
   if(!ensureAuth(response,user))return true;
   const productId=Number(url.searchParams.get('productId')),cellId=Number(url.searchParams.get('cellId'));
   sendRedirect(response,Number.isSafeInteger(productId)&&productId>0?'/products/'+productId:Number.isSafeInteger(cellId)&&cellId>0?'/cells/'+cellId:'/cells');return true;
 }
 if(request.method==='POST'&&['/devices/cell-test','/devices/controller-ping','/api/admin/adjustments/light'].includes(url.pathname)) {
   if(!ensureAuth(response,user))return true;const f=request.parsedForm;
   if(url.pathname.endsWith('controller-ping')){const controller=state.db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(Number(f.controller_id));if(!controller)throw new Error('Controller not found.');const targets=Array.from({length:controller.module_count},(_,n)=>state.db.prepare('SELECT c.*,ctrl.address AS controller_address,ctrl.heartbeat_status FROM cells c JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE controller_id=? AND hardware_channel=?').get(controller.id,n+1)||{id:null,controller_id:controller.id,controller_address:controller.address,hardware_channel:n+1,logical_code:'Unconfigured output '+(n+1),heartbeat_status:controller.heartbeat_status});const result=d.start(user,{kind:'ping',...(f.overrideWork==='1'?{overrideWork:true}:{}),controllerTest:controller.id,controllerRevision:JSON.stringify([controller.address,controller.module_count,controller.configured_at]),setupTargets:targets},{requestId:f.requestId||randomUUID(),promptOnBusy:f.promptOnBusy==='1',previewOnly:f.previewOnly==='1',confirmOverride:f.confirmOverride==='1'});if(String(request.headers.accept||'').includes('json'))sendJson(response,{...result,ok:result.state!=='busy',degraded:result.state==='busy',displayId:result.id});else sendRedirect(response,'/devices#controller-health');}
   else {const result=d.start(user,{kind:url.pathname.endsWith('cell-test')?'ping':'locate',cellId:Number(f.cell_id)},{requestId:f.requestId||randomUUID()});if(String(request.headers.accept||'').includes('json'))sendJson(response,{...result,ok:result.state!=='busy',degraded:result.state==='busy',cell:{id:Number(f.cell_id)},displayId:result.id});else sendRedirect(response,'/devices#cell-mapping');}return true;
 }
 if(request.method==='POST'&&url.pathname==='/api/cells/locate/clear-all'){if(!ensureApiAuth(response,user))return true;throw new Error('Stop the owned display from its display screen. Bulk clears cannot override newer guidance.');}
 const oldProduct=url.pathname.match(/^\/products\/(\d+)\/find(\/clear)?$/),oldCell=url.pathname.match(/^\/api\/cells\/(\d+)\/(count|locate|ping)(\/clear)?$/);
 const oldWarehouse=['/products/quantities','/products/quantities/clear'].includes(url.pathname);
 if(request.method==='POST'&&(oldProduct||oldCell||oldWarehouse)){
   if(!ensureApiAuth(response,user))return true;const input=request.parsedForm;
   if(url.pathname.endsWith('/clear')||input.active===false){if(!input.displayId)throw new Error('Open quantity displays and stop the current request using its ownership receipt. A stale clear cannot stop newer guidance.');sendJson(response,{ok:true,degraded:false,...d.stop(user,input.displayId),...(oldCell?{cell:{id:Number(oldCell[1])}}:{})});return true;}
   const scope={kind:oldCell&&oldCell[2]!=='count'?oldCell[2]:displayKind(input.displayKind),...(oldCell?{cellId:Number(oldCell[1])}:{}),...(oldProduct?{productId:Number(oldProduct[1])}:{}),...(input.product_id?{productId:Number(input.product_id)}:{}),...(input.overrideWork==='1'?{overrideWork:true}:{})};
   const result=d.start(user,scope,{requestId:input.requestId||randomUUID(),promptOnBusy:input.promptOnBusy==='1',confirmOverride:input.confirmOverride==='1',previewOnly:input.previewOnly==='1'});
   if(String(request.headers.accept||'').includes('json')||oldCell)sendJson(response,{...result,ok:result.state!=='busy',degraded:result.state==='busy',displayId:result.id});else sendRedirect(response,oldProduct?'/products/'+oldProduct[1]:'/products');return true;
 }
 return false;
}
