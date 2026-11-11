import {createHmac,timingSafeEqual} from 'node:crypto';
export const READINESS_PATH='/_lytguide/ready';
export const readinessToken=secret=>createHmac('sha256',secret).update('lytguide-local-readiness-v1').digest('hex');
export function runtimeReadiness(request,response,url,{enabled,secret,getDb}){
  if(!enabled||url.pathname!==READINESS_PATH)return false;
  const given=String(request.headers['x-lytguide-probe']||''),expected=readinessToken(secret);
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
  if(request.method!=='GET'||!local||!/^[a-f0-9]{64}$/.test(given)||!timingSafeEqual(Buffer.from(given),Buffer.from(expected))){response.writeHead(404,{'Cache-Control':'no-store'});response.end();return true;}
  try{
    const row=getDb().prepare("SELECT value FROM app_metadata WHERE key='dataset_generation'").get();
    if(!row?.value)throw new Error('Shed not ready');
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({ready:true,service:'lytguide-runtime-v1'}));
  }catch{response.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({ready:false}));}
  return true;
}
