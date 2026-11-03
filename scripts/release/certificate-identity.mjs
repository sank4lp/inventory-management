import {X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';

export const AUTHORITY_FILES=['root.crt','root.key','intermediate.crt','intermediate.key'];
export function checkAuthority(folder,{now=Date.now()}={}){
  for(const name of AUTHORITY_FILES)if(!existsSync(join(folder,name)))throw new Error('The saved phone certificate identity is incomplete.');
  const root=new X509Certificate(readFileSync(join(folder,'root.crt'))),intermediate=new X509Certificate(readFileSync(join(folder,'intermediate.crt')));
  const matches=(cert,name)=>cert.publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(createPrivateKey(readFileSync(join(folder,name)))).export({type:'spki',format:'der'}));
  if(!root.ca||!root.verify(root.publicKey)||!intermediate.ca||!intermediate.checkIssued(root)||!intermediate.verify(root.publicKey)||!matches(root,'root.key')||!matches(intermediate,'intermediate.key'))throw new Error('The saved phone certificate keys do not match.');
  if(Date.parse(root.validFrom)>now||Date.parse(root.validTo)<=now)throw new Error('The saved phone certificate is outside its valid dates. Check the Pi date/time before restoring.');
  return {fingerprint:root.fingerprint256,intermediateExpired:Date.parse(intermediate.validTo)<=now};
}
export function discardExpiredIntermediate(folder){const result=checkAuthority(folder);if(result.intermediateExpired)for(const name of ['intermediate.crt','intermediate.key'])rmSync(join(folder,name));return result;}
