import {createServer,request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,openSync,writeSync,closeSync,fsyncSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import QRCode from 'qrcode';
import {createSetupSessions,validateLocalRequest,setupProxyAllowed,SETUP_PORT} from './security.mjs';

const MAX_UPLOAD=2*1024**3;
function json(response,value,status=200,headers={}){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});response.end(JSON.stringify(value));}
async function body(request){let bytes=0,chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>65536)throw Object.assign(new Error('Setup request is too large.'),{status:413});chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Invalid setup request.');}}
export function embedHtml(html){return html.replace(/<script[^>]+src="\/client\/(session|notifications|work-outbox-status|stocktake-status|mobile-nav)\.js"[^>]*><\/script>/g,'').replace('</head>',`<style>.dashboard-sidebar,.page-header,.sidebar-footer,.ui-settings-links,.ui-toolbar,.stocktake-reminder,.global-notifications,.notification-toast{display:none!important}.dashboard-shell,.dashboard-content{display:block!important;margin:0!important;padding:0!important}.page-shell{max-width:none!important;padding:0!important;margin:0!important}.page-body,.ui-settings-page{padding:0!important;margin:0!important}.ui-template{width:100%}body{background:transparent!important}</style></head>`);}
export function createSetupServer({driver,redeem,assets,iconPath,buildVersion='development',uploadDirectory,port=SETUP_PORT,onIdle=()=>{}}){
  let job=null,lastActivity=Date.now(),uploading=false;
  const sessions=createSetupSessions({redeem,onAuthorize(grant){if(grant.restart!==true)return;if(job?.running||uploading)throw Object.assign(new Error('Setup is still working. Wait for the current step to finish, then reopen Setup.'),{status:409});driver.restart();job=null;}});
  const server=createServer(async(request,response)=>{
    const actualPort=server.address()?.port||port;
    // Native controller forms need their same-origin identity. no-referrer
    // makes Chromium navigation POSTs send Origin: null; fetch POSTs do not.
    // same-origin still withholds referrers from other origins.
    response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','same-origin');
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try{
      validateLocalRequest(request,{port:actualPort,mutation:request.method!=='GET'});lastActivity=Date.now();
      const url=new URL(request.url,`http://${request.headers.host}`);
      if(request.method==='GET'&&['/','/wizard.css','/wizard.js','/icon.svg'].includes(url.pathname)){
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);response.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(readFileSync(file==='icon.svg'&&iconPath?iconPath:join(assets,file)));return;
      }
      if(request.method==='GET'&&url.pathname==='/setup-api/version'){json(response,{version:buildVersion});return;}
      if(request.method==='POST'&&url.pathname==='/setup-api/unlock'){
        const input=await body(request),token=await sessions.unlock(input.token);json(response,{ok:true},200,{'Set-Cookie':`lytguide_setup=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800`});return;
      }
      const actor=sessions.actor(request.headers.cookie);
      const cookie=request.headers.cookie.match(/(?:^|;\s*)lytguide_setup=([a-f0-9]{64})(?:;|$)/)[1];
      response.setHeader('Set-Cookie',`lytguide_setup=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800`);
      if(request.method==='GET'&&url.pathname==='/setup-api/status'){json(response,{...await driver.status(),job});return;}
      if(request.method==='GET'&&url.pathname==='/setup-api/refresh'){
        if(job?.running){json(response,{...await driver.status(),job});return;}json(response,{...await driver.refresh(),job});return;
      }
      if(request.method==='GET'&&url.pathname==='/setup-api/phone-qr'){
        const status=await driver.status(),value=status.phone?.downloadUrl||status.phone?.appUrl;if(!value)throw new Error('Finish the warehouse network setup first.');response.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});response.end(await QRCode.toString(value,{type:'svg',margin:2,width:220}));return;
      }
      if(request.method==='GET'&&url.pathname==='/setup-api/certificate'){
        const value=await driver.certificate();response.writeHead(200,{'Content-Type':'application/pkix-cert','Content-Disposition':'attachment; filename="LytGuide-warehouse.cer"','Cache-Control':'no-store'});response.end(value);return;
      }
      if(request.method==='POST'&&url.pathname==='/setup-api/backup-upload'){
        if(job?.running||uploading)throw Object.assign(new Error('Wait for the current setup step to finish.'),{status:409});
        if(Number(request.headers['content-length']||0)>MAX_UPLOAD)throw Object.assign(new Error('The recovery file is larger than 2 GB.'),{status:413});
        mkdirSync(uploadDirectory,{recursive:true,mode:0o700});
        const id=randomUUID(),temp=join(uploadDirectory,id+'.writing'),target=join(uploadDirectory,id+'.lytbackup');let fd,bytes=0;uploading=true;
        try{fd=openSync(temp,'wx',0o600);for await(const chunk of request){bytes+=chunk.length;if(bytes>MAX_UPLOAD)throw new Error('The recovery file is larger than 2 GB.');writeSync(fd,chunk);}if(!bytes)throw new Error('Choose a non-empty recovery file.');fsyncSync(fd);closeSync(fd);fd=null;renameSync(temp,target);const name=decodeURIComponent(String(request.headers['x-backup-name']||'Recovery backup')).slice(0,180).replace(/[\r\n\0]/g,'');json(response,await driver.upload(id,name,bytes,target));}catch(error){rmSync(target,{force:true});throw error;}finally{if(fd!=null)closeSync(fd);rmSync(temp,{force:true});uploading=false;}return;
      }
      if(request.method==='POST'&&url.pathname==='/setup-api/action'){
        if(job?.running||uploading)throw Object.assign(new Error('Wait for the current setup step to finish.'),{status:409});
        const input=await body(request);if(typeof input.action!=='string')throw new Error('Choose a setup action.');
        job={id:randomUUID(),action:input.action,running:true,startedAt:Date.now(),error:null};const current=job;
        // Secrets live only in this request's job. They are not put in status,
        // job history, persisted setup state, child argv or logs.
        Promise.resolve().then(()=>driver.action(input.action,input,actor)).then(()=>{current.running=false;current.finishedAt=Date.now();},error=>{current.running=false;current.finishedAt=Date.now();current.error=error.message;});json(response,{job:current},202);return;
      }
      if(setupProxyAllowed(request.method,url.pathname)){
        if(job?.running)throw Object.assign(new Error('Setup is updating the warehouse. Wait a moment, then retry.'),{status:409});
        const target=`http://127.0.0.1:${driver.appPort()}`;
        const headers={...request.headers,host:`127.0.0.1:${driver.appPort()}`,cookie:driver.appCookie(),origin:target};delete headers['accept-encoding'];delete headers['x-setup-csrf'];
        const upstream=httpRequest(target+request.url,{method:request.method,headers,timeout:120000},incoming=>{
          const output={...incoming.headers,'cache-control':'no-store','referrer-policy':'same-origin'};delete output['set-cookie'];delete output['content-length'];delete output['content-security-policy'];
          if(incoming.headers['content-type']?.includes('text/html')){const chunks=[];incoming.on('data',c=>chunks.push(c));incoming.on('end',()=>{response.writeHead(incoming.statusCode,output);response.end(embedHtml(Buffer.concat(chunks).toString('utf8')));});}
          else{response.writeHead(incoming.statusCode,output);incoming.pipe(response);}
        });upstream.on('timeout',()=>upstream.destroy(new Error('Controller setup took too long. Refresh and retry.')));upstream.on('error',()=>{if(!response.headersSent)json(response,{error:'The warehouse is starting. Wait a moment and refresh this setup panel.'},503);else response.destroy();});request.pipe(upstream);return;
      }
      json(response,{error:'This page is available in the warehouse after setup.'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},error.status||400);else response.destroy();}
  });
  const timer=setInterval(()=>{if(!job?.running&&Date.now()-lastActivity>30*60000)onIdle();},60000);timer.unref();server.on('close',()=>clearInterval(timer));return server;
}
