import {can,SETTINGS} from "../access/catalog.js";
import {randomUUID} from 'node:crypto';
import {page} from '../../render.js';
import {sendHtml,sendRedirect,sendJson} from '../../server/http/responses.js';
import {ensureAdmin,ensureAuth} from '../../server/http/auth-guards.js';
export function phaseTwoNavigation(request,response,url,user,state) {
  if(request.method==='POST'&&url.pathname==='/admin/adjustments') {
    if(!ensureAuth(response,user))return true;
    throw new Error('Open Stocktaking to identify the location, record a fresh count and approve its verified correction. This older form has no safe counting baseline.');
  }
  if(request.method==='POST'&&url.pathname==='/recommended-actions/apply') {
    if(!ensureAuth(response,user))return true;
    const f=request.parsedForm,moves=Object.keys(f).filter(k=>/^move_source_\d+$/.test(k)).map(k=>{const n=k.split('_').pop();return {sourceCellId:f[k],targetCellId:f['move_cell_'+n],picked:f['actual_pick_'+n],put:f['actual_put_'+n]};});
    const result=state.operationsService.command(user,'recommendation',{requestId:f.requestId,productId:f.product_id,reason:f.physical_note,physicalConfirmed:f.physical_confirmed==='on',moves});
    if(String(request.headers.accept||'').includes('json'))sendJson(response,result);else sendRedirect(response,'/work?flash='+encodeURIComponent(result.message));return true;
  }
  if(request.method==='POST'&&url.pathname==='/recommended-actions/light-cell') {
    if(!ensureAuth(response,user))return true;
    const f=request.parsedForm,indices=Object.keys(f).filter(k=>/^move_source_\d+$/.test(k)).map(k=>k.split('_').pop()).filter(n=>f.light_move_index==='all'||String(f.light_move_index)===n);
    if(!indices.length||indices.some(n=>!Number.isFinite(Number(f['move_qty_'+n]))||Number(f['move_qty_'+n])<=0))throw new Error('Choose a positive suggested quantity for the display.');
    const instructions=indices.flatMap(n=>[{cellId:Number(f['move_source_'+n]),direction:'pick',quantity:Number(f['move_qty_'+n])},{cellId:Number(f['move_cell_'+n]),direction:'put',quantity:Number(f['move_qty_'+n])}]);
    const cellIds=[...new Set(instructions.map(i=>i.cellId))];
    state.displayCoordinator.start(user,{kind:'recommendation',cellIds,instructions,productId:Number(f.product_id),recommendationKey:f.recommendation_key},{requestId:(f.requestId||randomUUID())+'-light-'+String(f.light_move_index)});
    sendRedirect(response,'/recommended-actions?key='+encodeURIComponent(f.recommendation_key));return true;
  }
  if(request.method==='POST'&&['/recommended-actions/light-cell/clear','/recommended-actions/clear-leds'].includes(url.pathname)){if(!ensureAuth(response,user))return true;sendRedirect(response,'/recommended-actions');return true;}
  if(request.method!=='GET')return false;
  if(url.pathname==='/settings'||url.pathname==='/admin') {
    if(!ensureAuth(response,user))return true;
    const links=SETTINGS.filter(x=>can(user,x[2])).map(([href,title])=>[href,title,'']);
    const legacyRedirect=url.pathname==='/admin'?`<script>const targets={'#registration-keys':'/settings/people#registration-keys','#users':'/settings/people#users','#count-adjustment':'/stocktaking','#settings':'/settings/system','#report-format':'/reports?format=1','#database-health':'/settings/system#database-health'};if(targets[location.hash])location.replace(targets[location.hash]);</script>`:'';
    sendHtml(response,page({title:'Settings',user,content:`<div class="work-grid">${links.map(([href,title,description])=>`<section class="work-panel"><h2><a href="${href}">${title}</a></h2><p>${description}</p></section>`).join('')}</div>${legacyRedirect}`}));return true;
  }
  if(['/settings/people','/settings/system'].includes(url.pathname)){if(!ensureAuth(response,user))return true;sendHtml(response,state.pages.renderAdmin(user,null,url.pathname.endsWith('people')?'people':'system'));return true;}
  if(url.pathname==='/locations/manage'){if(!ensureAuth(response,user))return true;sendHtml(response,page({title:'Locations · Manage',user,content:`<p><a href="/cells">← Locations</a> · <a href="/location-setup">Set up locations by scanning</a> · <a href="/location-setup?view=fields">Location fields</a></p>${state.pages.renderDeviceConfigSection('cell-management')}`}));return true;}
  if(url.pathname==='/reports/stocktake-differences'){if(!ensureAuth(response,user))return true;sendRedirect(response,'/stocktaking/results'+(url.search||''));return true;}
  return false;
}
