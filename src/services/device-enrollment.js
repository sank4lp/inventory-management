import {X509Certificate,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,chmodSync,chownSync,existsSync,lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {isIP} from 'node:net';

export const DEVICE_ACCESS_FILE='/etc/inventory-management/device-access.json';
export const PACKAGE_DEVICE_ACCESS_FILE='/etc/lytguide-test/device-access.json';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function privateAddress(value){const n=String(value).split('.').map(Number);return isIP(value)===4&&(n[0]===10||n[0]===192&&n[1]===168||n[0]===172&&n[1]>=16&&n[1]<=31);}
function port(value){if(!Number.isInteger(value)||value<1||value>65535)throw new Error('Invalid device access port.');return value;}
export function deviceEnrollment({address,httpsPort=443,enrollPort,certificate,warehouseName}){
  if(!privateAddress(address))throw new Error('Device setup needs the Pi’s private network address.');
  if(enrollPort!=null&&(port(enrollPort)<1024||enrollPort===httpsPort))throw new Error('Certificate download needs a separate port from 1024 to 65535.');
  const cert=new X509Certificate(certificate);if(!cert.ca||!cert.verify(cert.publicKey))throw new Error('The warehouse root certificate is invalid.');
  const base=host=>`https://${host}${port(httpsPort)===443?'':':'+httpsPort}`;
  return {version:1,address,warehouseName:String(warehouseName||`Warehouse at ${address}`).slice(0,160),appUrl:base(address)+'/work',
    downloadUrl:enrollPort?`http://${address}:${port(enrollPort)}/`:null,certificate:cert.raw.toString('base64'),fingerprint:cert.fingerprint256,validFrom:cert.validFrom,validTo:cert.validTo,httpsPort,enrollPort:enrollPort||null};
}
export function readDeviceEnrollment({path=process.env.LYTGUIDE_DEVICE_ACCESS_FILE||(process.env.LYTGUIDE_SETUP_PENDING_FILE?PACKAGE_DEVICE_ACCESS_FILE:DEVICE_ACCESS_FILE),now=Date.now()}={}){
  const input=JSON.parse(readFileSync(path,'utf8'));
  if(input.version!==1)throw new Error('Update phone access using Warehouse Setup on this Pi.');
  const record=deviceEnrollment({...input,certificate:Buffer.from(input.certificate||'','base64')});
  if(Date.parse(record.validFrom)>now||Date.parse(record.validTo)<=now)throw new Error('Check the Pi date/time and renew warehouse phone access before connecting a new device.');
  return record;
}
export function deviceInstructions(){return `<details><summary>iPhone / iPad</summary><ol><li>Download the certificate. Open Settings → General → VPN &amp; Device Management and install the downloaded profile.</li><li>Open Settings → General → About → Certificate Trust Settings. Enable full trust for this warehouse certificate.</li><li>Open LytGuide in Safari. Tap Share → Add to Home Screen, name the shortcut after this warehouse, then tap Add.</li></ol></details><details><summary>Android phone / tablet</summary><ol><li>Download the certificate. In Settings, search for “Install a certificate” and select CA certificate. Choose the downloaded file. Menu names vary.</li><li>Open LytGuide in Chrome. Tap ⋮ → Add to Home screen or Install app, then confirm. Use the warehouse name for the shortcut when prompted.</li></ol></details>`;}
export function enrollmentPage(record){return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect this device · LytGuide</title><style>body{font:16px system-ui;margin:0 auto;padding:20px;max-width:560px;line-height:1.5;color:#173b32;background:#f4f7f5}main{background:white;border:1px solid #d8e3dd;border-radius:14px;padding:18px}h1{font-size:24px;margin:0 0 8px}h2{font-size:18px}a.button{display:block;padding:12px;background:#17654e;color:white;border-radius:9px;text-align:center;text-decoration:none;margin:12px 0}code,.url{display:block;overflow-wrap:anywhere;font-size:13px}details{border-top:1px solid #d8e3dd;padding:12px 0}summary{font-weight:600;cursor:pointer}ol{padding-left:22px}li{margin:10px 0}</style><main><h1>Connect this device</h1><p>${esc(record.warehouseName)} · LytGuide</p><p>Stay connected to this warehouse’s Wi-Fi.</p><h2>1. Install the certificate</h2><p>Compare this fingerprint with Settings → Connect a device on the Pi before installing.</p><code>${esc(record.fingerprint)}</code><a class="button" href="/root.cer" download="LytGuide-warehouse.cer">Download certificate</a>${deviceInstructions()}<h2>2. Open LytGuide</h2><a class="button" href="${esc(record.appUrl)}">Open LytGuide</a><span class="url">${esc(record.appUrl)}</span><h2>3. Add to Home Screen</h2><p>Name the shortcut after this warehouse so it is easy to recognise. Your phone will ask you to confirm.</p><details><summary>Using several warehouses</summary><p>Install each Pi’s certificate once and save a separate shortcut for each warehouse. Each Pi has its own address, data and sign-in. When several Pis share a Wi-Fi network, Wi-Fi cannot choose the warehouse for you.</p></details><p>This page shares only the public certificate. Sign in only after opening the secure LytGuide address.</p></main></html>`;}
function atomic(path,value,mode,owner){mkdirSync(dirname(path),{recursive:true,mode:0o755});const tmp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,value,{flag:'wx',mode});chmodSync(tmp,mode);if(owner)chownSync(tmp,owner.uid,owner.gid);renameSync(tmp,path);}finally{rmSync(tmp,{force:true});}}
export function publishDeviceEnrollment({certificatePath,folder,metadataPath,owner,...config}) {
  const record=deviceEnrollment({...config,certificate:readFileSync(certificatePath)});
  if(existsSync(folder)&&lstatSync(folder).isSymbolicLink())throw new Error('The certificate download folder must not be a symbolic link.');
  mkdirSync(folder,{recursive:true,mode:0o700});
  chmodSync(folder,0o700);
  if(owner)chownSync(folder,owner.uid,owner.gid);
  const files=[
    [join(folder,'root.cer'),Buffer.from(record.certificate,'base64'),0o600,owner],
    [join(folder,'index.html'),enrollmentPage(record),0o600,owner],
    // Readable metadata contains only public information; never copy private keys.
    [metadataPath,JSON.stringify(record,null,2)+'\n',0o644,undefined],
  ];
  const before=files.map(([path])=>{
    if(!existsSync(path))return null;
    const stat=lstatSync(path);
    if(!stat.isFile())throw new Error('Device setup files must be regular files.');
    return {bytes:readFileSync(path),mode:stat.mode&0o777,owner:{uid:stat.uid,gid:stat.gid}};
  });
  const written=[];
  try {
    files.forEach(([path,bytes,mode,fileOwner],index)=>{
      atomic(path,bytes,mode,fileOwner);written.push(index);
    });
  } catch(error) {
    const failures=[];
    for(const index of written.reverse()){
      const old=before[index],path=files[index][0];
      try {if(old)atomic(path,old.bytes,old.mode,old.owner);else rmSync(path,{force:true});}
      catch(cause){failures.push(cause.message);}
    }
    throw new Error(`Could not publish device setup: ${error.message}${failures.length?'; recovery needs attention: '+failures.join('; '):''}`);
  }
  return record;
}
