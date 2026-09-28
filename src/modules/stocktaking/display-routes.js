import {can} from "../access/catalog.js";
import {randomUUID} from 'node:crypto';
import {page,escapeHtml as e} from '../../render.js';
import {ensureAuth,ensureApiAuth,ensureAdmin} from '../../server/http/auth-guards.js';
import {sendHtml,sendJson,sendRedirect} from '../../server/http/responses.js';
export function displayRoutes(request,response,url,user,state) {
 const d=state.displayCoordinator;
 if(url.pathname==='/api/displays/status'){if(!ensureApiAuth(response,user))return true;sendJson(response,d.status(user));return true;}
 if(request.method==='POST'&&['/api/displays/start','/api/displays/stop'].includes(url.pathname)) {
   if(!ensureApiAuth(response,user))return true;const i=request.parsedForm;
   const scope={kind:i.kind==='locate'?'locate':'quantity',...(i.cellId?{cellId:Number(i.cellId)}:{}),...(i.productId?{productId:Number(i.productId)}:{})};
   sendJson(response,url.pathname.endsWith('/stop')?d.stop(user,i.displayId):d.start(user,scope,{requestId:i.requestId}));return true;
 }
 if(request.method==='GET'&&url.pathname==='/quantities'){
   if(!ensureAuth(response,user))return true;const scope={kind:url.searchParams.get('kind')==='locate'?'locate':'quantity',...(url.searchParams.get('cellId')?{cellId:Number(url.searchParams.get('cellId'))}:{}),...(url.searchParams.get('productId')?{productId:Number(url.searchParams.get('productId'))}:{})};
   const rows=d.view(user,scope);sendHtml(response,page({title:'Locations · Quantity display',user,content:`<p>${scope.cellId?'Selected location':scope.productId?'Selected product across its locations':'Entire warehouse — page searches do not narrow this scope'}</p><div data-display-console data-scope="${e(JSON.stringify(scope))}">${can(user,scope.kind==='locate'?'locations.locate':'locations.quantity')?`<button data-display-start>${scope.kind==='locate'?'Start locator display':'Start quantity display'}</button>`:''}<p role="status" data-display-message></p><div data-display-active></div></div><p>Exact quantities remain on screen. Mixed-product cells need product selection; decimals and values over 999 use locator guidance instead of an inaccurate number.</p>${rows.map(({cell:c,products})=>`<section class="work-panel"><h2><a href="/cells/${c.id}">${e(c.display_name||c.logical_code)}</a></h2><p>${!c.controller_id?'Manual / unmapped':c.heartbeat_status==='online'?'Controller last reported online':'Controller unreachable or health unknown'}</p>${products.length?products.map(p=>`<article class="count-run"><h3>${e(p.name)}</h3><p>On shelf ${e(p.on_hand)} · Reserved ${e(p.reserved_quantity)} · ${p.uncertain?'Needs review':'Available to pick '+e(p.available)} ${e(p.unit_of_measure)}</p>${scope.cellId===c.id&&scope.productId===p.product_id?'<p class="work-help">Selected product at this location.</p>':`<a class="work-secondary" href="/quantities?cellId=${c.id}&productId=${p.product_id}">Select this product at this location</a>`}</article>`).join(''):'<p>No recorded stock.</p>'}</section>`).join('')}<script type="module" src="/client/displays.js"></script>`}));return true;
 }
 if(request.method==='POST'&&['/devices/cell-test','/devices/controller-ping','/api/admin/adjustments/light'].includes(url.pathname)) {
   if(!ensureAuth(response,user))return true;const f=request.parsedForm;
   if(url.pathname.endsWith('controller-ping')){const controller=state.db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(Number(f.controller_id));if(!controller)throw new Error('Controller not found.');const targets=Array.from({length:controller.module_count},(_,n)=>state.db.prepare('SELECT c.*,ctrl.address AS controller_address,ctrl.heartbeat_status FROM cells c JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE controller_id=? AND hardware_channel=?').get(controller.id,n+1)||{id:null,controller_id:controller.id,controller_address:controller.address,hardware_channel:n+1,logical_code:'Unconfigured output '+(n+1),heartbeat_status:controller.heartbeat_status});d.start(user,{kind:'locate',controllerTest:controller.id,controllerRevision:JSON.stringify([controller.address,controller.module_count,controller.configured_at]),setupTargets:targets},{requestId:f.requestId||randomUUID()});sendRedirect(response,'/quantities?kind=locate');}
   else {const result=d.start(user,{kind:'locate',cellId:Number(f.cell_id)},{requestId:f.requestId||randomUUID()});if(String(request.headers.accept||'').includes('json'))sendJson(response,{...result,ok:result.state!=='busy',degraded:result.state==='busy',cell:{id:Number(f.cell_id)},displayId:result.id});else sendRedirect(response,'/quantities?kind=locate&cellId='+Number(f.cell_id));}return true;
 }
 if(request.method==='POST'&&url.pathname==='/api/cells/locate/clear-all'){if(!ensureApiAuth(response,user))return true;throw new Error('Stop the owned display from its display screen. Bulk clears cannot override newer guidance.');}
 const oldProduct=url.pathname.match(/^\/products\/(\d+)\/find(\/clear)?$/),oldCell=url.pathname.match(/^\/api\/cells\/(\d+)\/(count|locate|ping)(\/clear)?$/);
 const oldWarehouse=['/products/quantities','/products/quantities/clear'].includes(url.pathname);
 if(request.method==='POST'&&(oldProduct||oldCell||oldWarehouse)){
   if(!ensureApiAuth(response,user))return true;const input=request.parsedForm;
   if(url.pathname.endsWith('/clear')||input.active===false){if(!input.displayId)throw new Error('Open quantity displays and stop the current request using its ownership receipt. A stale clear cannot stop newer guidance.');sendJson(response,{ok:true,degraded:false,...d.stop(user,input.displayId),...(oldCell?{cell:{id:Number(oldCell[1])}}:{})});return true;}
   const scope={kind:oldCell&&oldCell[2]!=='count'?'locate':'quantity',...(oldCell?{cellId:Number(oldCell[1])}:{}),...(oldProduct?{productId:Number(oldProduct[1])}:{}),...(input.product_id?{productId:Number(input.product_id)}:{})};
   const result=d.start(user,scope,{requestId:input.requestId||randomUUID()});
   if(String(request.headers.accept||'').includes('json')||oldCell)sendJson(response,{...result,ok:result.state!=='busy',degraded:result.state==='busy',displayId:result.id});else sendRedirect(response,'/quantities'+(oldProduct?'?productId='+oldProduct[1]:''));return true;
 }
 return false;
}
