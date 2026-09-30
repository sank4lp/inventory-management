import QRCode from 'qrcode';
import {page,escapeHtml as e} from '../../render.js';
import {ensureAuth,ensureApiAuth} from '../../server/http/auth-guards.js';
import {sendHtml,sendJson} from '../../server/http/responses.js';
export async function locationSetupRoutes(request,response,url,user,state){
 const service=state.locationSetupService;
 if(url.pathname.startsWith('/api/location-setup/')){if(!ensureApiAuth(response,user))return true;const action=url.pathname.split('/').pop();if(request.method==='GET'&&action==='snapshot')sendJson(response,service.snapshot(user));else if(request.method==='POST')sendJson(response,service.command(user,action,request.parsedForm));else sendJson(response,{error:'Unknown action'},404);return true;}
 if(request.method!=='GET'||!url.pathname.startsWith('/location-setup'))return false;
 if(!ensureAuth(response,user))return true;
 const s=service.snapshot(user);
 if(url.pathname==='/location-setup/print'){
   const tokens=(url.searchParams.get('tokens')||'').split(',');const labels=s.labels.filter(l=>l.state!=='revoked'&&tokens.includes(l.token));
   const cards=await Promise.all(labels.map(async l=>`<article class="setup-label">${await QRCode.toString(`lytguide:${s.site}:${l.token}:${l.revision}`,{type:'svg',margin:2})}<strong>${e(s.cells.find(c=>c.id===l.cell_id)?.display_name||'Setup sticker')}</strong><small>${e(l.token)}</small></article>`));
   sendHtml(response,page({title:'Location setup · Print unique stickers',user,content:`<p>Attach one unique sticker beside each light. These labels contain no password. <button onclick="print()">Print stickers</button></p><div class="setup-labels">${cards.join('')}</div>`}));return true;
 }
 sendHtml(response,page({title:'Location setup',user,content:`<div id="location-setup-app"></div><script id="location-setup-boot" type="application/json">${JSON.stringify(s).replace(/</g,'\\u003c')}</script><script src="/client/vendor/jsQR.js"></script><script type="module" src="/client/location-setup.js"></script>`}));return true;
}
