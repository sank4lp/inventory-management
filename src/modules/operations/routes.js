import { createHash } from "node:crypto";
import QRCode from 'qrcode';
import { page, escapeHtml } from '../../render.js';
import { sendHtml, sendJson, sendRedirect, appendFlash } from '../../server/http/responses.js';
import { ensureAuth, ensureApiAuth } from '../../server/http/auth-guards.js';

const paths = new Set(['/work','/pick','/put','/pending-confirmations','/record-movement','/movement-history','/labels']);
export async function operationsRoutes(request,response,url,user,state) {
  const {operationsService:work,db}=state;
  if (url.pathname === '/offline') {
    sendHtml(response, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved work · LytGuide</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/work.css"><body><main class="offline-shell"><a href="/work">LytGuide · Work</a><h1>Saved warehouse work</h1><p>Use this device’s saved allocations. Offline movement reports need supervisor verification. No new exclusive turn is granted offline.</p><div id="work-app"></div></main><script src="/client/vendor/jsQR.js"></script><script type="module" src="/client/work.js"></script></body></html>`); return true;
  }
  if (url.pathname.startsWith('/api/work/')) {
    if (!ensureApiAuth(response,user)) return true;
    const action=url.pathname.slice('/api/work/'.length);
    if(request.method==='GET' && action==='snapshot') {const data=work.snapshot(user);const taskId=Number(url.searchParams.get('taskId'));if(taskId&&!data.tasks.some(t=>t.id===taskId)){const task=work.task(user,taskId);if(task)data.tasks.unshift(task);}sendJson(response,data);}
    else if(request.method==='POST') sendJson(response,work.command(user,action,request.parsedForm));
    else sendJson(response,{error:'Action not found.'},404);
    return true;
  }
  const qr=url.pathname.match(/^\/labels\/(\d+)\.svg$/);
  if(qr) {
    if(!ensureAuth(response,user)) return true;
    const c=db.prepare('SELECT * FROM cells WHERE id=?').get(Number(qr[1]));
    if(!c) {sendJson(response,{error:'Location not found'},404);return true;}
    const svg=await QRCode.toString(`lytguide:${work.identity().site}:${c.label_id}:${c.label_revision}`,{type:'svg',errorCorrectionLevel:'M',margin:3});
    response.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});response.end(svg);return true;
  }
  const older=url.pathname.match(/^\/tasks\/(\d+)\/(confirm|correct)$/);
  if(request.method==='POST'&&older&&db.prepare('SELECT workflow_version FROM tasks WHERE id=?').get(Number(older[1]))?.workflow_version===2) {
    if(!ensureAuth(response,user))return true;
    const f=request.parsedForm;
    const actuals=Object.entries(f).filter(([k,v])=>/^actual_\d+$/.test(k)&&String(v).trim()!=='');
    if(!actuals.length)throw new Error('No explicit actual quantities were supplied. Open the allocation and report the physical work, including explicit zero when verified.');
    for(const [name,quantity] of actuals){
      const l=work.line(Number(name.slice(7)));
      if(l.task_id!==Number(older[1]))throw new Error('The submitted allocation does not belong to this task.');
      work.command(user,'report',{requestId:'older:'+createHash('sha256').update(JSON.stringify({actor:user.id,task:older[1],line:l.id,form:f})).digest('hex'),lineId:l.id,revision:-1,cellId:Number(f['actual_cell_'+l.id]||l.cell_id),unit:l.unit_of_measure,quantity,manual:true,reason:f.note||'Actual received from an older task form; verify original instructions.'});
    }
    sendRedirect(response,appendFlash('/tasks/'+older[1],'Actual reports received for supervisor verification. No replacement planned quantity was posted.','warning'));return true;
  }
  const match=url.pathname.match(/^\/tasks\/(\d+)$/);
  const task=match ? db.prepare('SELECT workflow_version FROM tasks WHERE id=?').get(Number(match[1])) : null;
  if (request.method==='POST' && ['/pick','/put'].includes(url.pathname)) {
    throw new Error('This older planning form has changed. Open Pick or Put again to reserve work safely.');
  }
  if(request.method!=='GET'|| (!paths.has(url.pathname) && task?.workflow_version!==2)) return false;
  if(!ensureAuth(response,user)) return true;
  if(url.pathname==='/pending-confirmations' && user.role!=='admin'){sendRedirect(response,'/work');return true;}
  const snapshot=work.snapshot(user);
  if(match) { const requested=work.task(user,match[1]); if(requested&&!snapshot.tasks.some(t=>t.id===requested.id))snapshot.tasks.unshift(requested); }
  const titles={'/work':'My work','/pick':'Pick','/put':'Put','/pending-confirmations':'Pending confirmations','/record-movement':'Record completed movement','/movement-history':'Movement history','/labels':'Location labels'};
  if(url.pathname==='/movement-history') snapshot.ledger=db.prepare(`SELECT tr.*,p.name AS product_name,c.logical_code,u.name AS reporter_name,actor.name AS performer_name FROM transactions tr JOIN products p ON p.id=tr.product_id JOIN cells c ON c.id=tr.cell_id JOIN users u ON u.id=tr.user_id LEFT JOIN users actor ON actor.id=tr.performed_by WHERE (?='admin' OR tr.user_id=? OR tr.performed_by=?) ORDER BY tr.id DESC LIMIT 300`).all(user.role,user.id,user.id);
  const boot=JSON.stringify({snapshot,path:url.pathname}).replace(/</g,'\\u003c');
  sendHtml(response,page({title:titles[url.pathname]||`Task #${match[1]}`,user,content:`<link rel="stylesheet" href="/work.css"><link rel="manifest" href="/manifest.webmanifest"><div id="work-app"><p>Loading your warehouse work…</p></div><noscript>Work confirmations require JavaScript for durable receipts. Enable JavaScript to continue.</noscript><script id="work-boot" type="application/json">${boot}</script><script src="/client/vendor/jsQR.js"></script><script type="module" src="/client/work.js"></script>`}),200,{'Cache-Control':'no-store'});
  return true;
}
