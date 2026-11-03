import {createCipheriv,createDecipheriv,createHash,createPrivateKey,createPublicKey,generateKeyPairSync,privateDecrypt,publicEncrypt,randomBytes,scryptSync,constants} from 'node:crypto';
import {createReadStream,createWriteStream,openSync,readSync,writeSync,closeSync,statSync,existsSync,readFileSync,writeFileSync,renameSync,rmSync,fsyncSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';

const MAGIC=Buffer.from('LYTGUIDE-SEALED-1\n'),MAX_HEADER=65536;
const decode=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Error('Invalid protected recovery file.');return Buffer.from(value,'base64');};
const fingerprint=pem=>createHash('sha256').update((pem?.type==='public'?pem:createPublicKey(pem)).export({type:'spki',format:'der'})).digest('hex');
export function createRecoveryProfile(password){
  if(typeof password!=='string'||password.length<12||password.length>200)throw new Error('Choose a recovery password of 12–200 characters.');
  const pair=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'der'}});
  const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),cipher=createCipheriv('aes-256-gcm',key,iv);
  try{return {version:1,publicKey:pair.publicKey,keyId:fingerprint(pair.publicKey),privateKey:{salt:salt.toString('base64'),iv:iv.toString('base64'),data:Buffer.concat([cipher.update(pair.privateKey),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')}};}
  finally{key.fill(0);pair.privateKey.fill(0);}
}
export function validateRecoveryProfile(profile){
  if(profile?.version!==1||typeof profile.publicKey!=='string'||profile.publicKey.length>2048||!profile.privateKey||fingerprint(profile.publicKey)!==profile.keyId)throw new Error('Invalid recovery encryption identity.');
  const p=profile.privateKey;
  if(decode(p.salt).length!==16||decode(p.iv).length!==12||decode(p.tag).length!==16||decode(p.data).length<1000||decode(p.data).length>8192)throw new Error('Invalid recovery encryption identity.');
  const key=createPublicKey(profile.publicKey);if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength!==3072)throw new Error('Unsupported recovery encryption key.');
  return profile;
}
export function unlockRecoveryProfile(profile,password){
  validateRecoveryProfile(profile);
  if(typeof password!=='string'||password.length>200)throw new Error('Enter the recovery password.');
  const p=profile.privateKey,key=scryptSync(password,decode(p.salt),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});let bytes;
  try{const decipher=createDecipheriv('aes-256-gcm',key,decode(p.iv));decipher.setAuthTag(decode(p.tag));bytes=Buffer.concat([decipher.update(decode(p.data)),decipher.final()]);const result=createPrivateKey({key:bytes,type:'pkcs8',format:'der'});if(fingerprint(createPublicKey(result))!==profile.keyId)throw new Error();return result;}
  catch{throw new Error('The recovery password is incorrect, or this backup is damaged.');}
  finally{key.fill(0);bytes?.fill(0);}
}
export function readSealedHeader(path){
  const fd=openSync(path,'r');try{
    const first=Buffer.alloc(MAGIC.length+4),n=readSync(fd,first,0,first.length,0);
    if(n<MAGIC.length||!first.subarray(0,MAGIC.length).equals(MAGIC))return null;
    const size=first.readUInt32BE(MAGIC.length);if(n!==first.length||size<100||size>MAX_HEADER)throw new Error('Invalid protected recovery header.');
    const bytes=Buffer.alloc(size);if(readSync(fd,bytes,0,size,first.length)!==size)throw new Error('Incomplete protected recovery file.');
    let header;try{header=JSON.parse(bytes);}catch{throw new Error('Invalid protected recovery header.');}
    validateRecoveryProfile(header.profile);if(header.version!==1||decode(header.iv).length!==12||decode(header.wrappedKey).length!==384)throw new Error('Invalid protected recovery header.');
    const offset=first.length+size,total=statSync(path).size;if(total<=offset+16)throw new Error('Incomplete protected recovery file.');
    const tag=Buffer.alloc(16);readSync(fd,tag,0,16,total-16);return {header,bytes,offset,total,tag};
  }finally{closeSync(fd);}
}
async function durable(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export async function sealRecovery(source,destination,profile){
  validateRecoveryProfile(profile);if(existsSync(destination))throw new Error('The recovery output already exists.');
  const key=randomBytes(32),iv=randomBytes(12),wrappedKey=publicEncrypt({key:profile.publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key);
  const bytes=Buffer.from(JSON.stringify({version:1,profile,iv:iv.toString('base64'),wrappedKey:wrappedKey.toString('base64')}));
  const prefix=Buffer.alloc(MAGIC.length+4);MAGIC.copy(prefix);prefix.writeUInt32BE(bytes.length,MAGIC.length);
  const temp=destination+'.sealing';let fd;
  try{
    fd=openSync(temp,'wx',0o600);writeSync(fd,prefix);writeSync(fd,bytes);closeSync(fd);fd=null;
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(bytes);
    await pipeline(createReadStream(source),cipher,createWriteStream(temp,{flags:'a'}));
    fd=openSync(temp,'a');writeSync(fd,cipher.getAuthTag());fsyncSync(fd);closeSync(fd);fd=null;renameSync(temp,destination);
  }finally{if(fd!=null)closeSync(fd);key.fill(0);rmSync(temp,{force:true});}
}
export async function openRecovery(source,destination,password){
  const sealed=readSealedHeader(source);if(!sealed)return null;
  if(existsSync(destination))throw new Error('Recovery staging file already exists.');
  const privateKey=unlockRecoveryProfile(sealed.header.profile,password);let key;
  try{
    key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},decode(sealed.header.wrappedKey));
    const decipher=createDecipheriv('aes-256-gcm',key,decode(sealed.header.iv));decipher.setAAD(sealed.bytes);decipher.setAuthTag(sealed.tag);
    let count=0;const bound=new Transform({transform(chunk,encoding,callback){count+=chunk.length;callback(count>8*1024**3?new Error('Recovery data is too large.'):null,chunk);}});
    await pipeline(createReadStream(source,{start:sealed.offset,end:sealed.total-17}),decipher,bound,createWriteStream(destination,{flags:'wx',mode:0o600}));
    await durable(destination);return sealed.header.profile;
  }catch(error){rmSync(destination,{force:true});throw new Error('The recovery file could not be unlocked. Check the password and try the other recovery copy.');}
  finally{key?.fill(0);}
}
