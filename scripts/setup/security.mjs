import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
export {commissioningRoute as setupProxyAllowed} from '../../src/modules/setup/gate.js';

export const SETUP_PORT=3311;
export const SETUP_SESSION_MS=30*60*1000;
const hash=value=>createHash('sha256').update(value).digest('hex');
export function sameSecret(left,right){const a=Buffer.from(String(left)),b=Buffer.from(String(right));return a.length===b.length&&timingSafeEqual(a,b);}
export function allowedHost(host,port=SETUP_PORT){return host===`localhost:${port}`||host===`127.0.0.1:${port}`;}
export function validateLocalRequest(request,{port=SETUP_PORT,mutation=false}={}){
  if(!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)||!allowedHost(request.headers.host,port))throw Object.assign(new Error('Open Setup on this Raspberry Pi.'),{status:403});
  if(mutation&&request.headers.origin!==`http://${request.headers.host}`)throw Object.assign(new Error('Open this action from the Setup window.'),{status:403});
}
export function createSetupSessions({redeem,onAuthorize=()=>{},clock=()=>Date.now()}={}){
  const sessions=new Map();
  return {
    async unlock(token){
      if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new Error('Setup authorisation expired. Open Shed Setup again.');
      const grant=await redeem(hash(token));
      if(!grant||grant.expiresAt<clock()||!Number.isInteger(grant.uid)||grant.uid<1)throw new Error('Setup authorisation expired. Open Shed Setup again.');
      await onAuthorize(grant);
      if(grant.restart===true)sessions.clear();
      const value=randomBytes(32).toString('hex');sessions.set(hash(value),{uid:grant.uid,expiresAt:clock()+SETUP_SESSION_MS});return value;
    },
    actor(header=''){
      const match=header.match(/(?:^|;\s*)lytguide_setup=([a-f0-9]{64})(?:;|$)/),key=match?hash(match[1]):'',session=sessions.get(key);
      if(!session||session.expiresAt<clock()){sessions.delete(key);throw Object.assign(new Error('Setup authorisation expired. Open Shed Setup again.'),{status:401});}
      session.expiresAt=clock()+SETUP_SESSION_MS;return {uid:session.uid};
    },
  };
}
