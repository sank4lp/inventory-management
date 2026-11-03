import {X509Certificate} from 'node:crypto';
import {mkdirSync,writeFileSync,chownSync,chmodSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {renderLanConfig} from '../lib/pi-lan.js';
import {STATE_ROOT} from './pi-package.mjs';

export function packageLanConfig(config,network){
  const storage=join(STATE_ROOT,'caddy'),base=renderLanConfig({address:config.address,port:config.httpsPort,appPort:config.appPort,cidr:network.cidr,storage});
  if(!config.enrollPort)return base;
  return base+`\n# Public certificate download only. Warehouse sign-in always uses HTTPS.\nhttp://${config.address}:${config.enrollPort} {\n bind ${config.address}\n @warehouse remote_ip ${network.cidr} 127.0.0.1\n handle @warehouse {\n  root * ${storage}/enrollment\n  header Cache-Control "no-store"\n  header X-Content-Type-Options "nosniff"\n  header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'"\n  @certificate path /root.cer\n  header @certificate Content-Type application/pkix-cert\n  file_server\n }\n handle {\n  respond "Connect to the warehouse Wi-Fi." 403\n }\n}\n`;
}
export function publishEnrollment(config,owner){
  const certPath=join(STATE_ROOT,'caddy/pki/authorities/local/root.crt');
  if(!config.address||!config.enrollPort||!existsSync(certPath))return null;
  const cert=new X509Certificate(readFileSync(certPath)),folder=join(STATE_ROOT,'caddy/enrollment');mkdirSync(folder,{recursive:true,mode:0o700});chownSync(folder,owner.uid,owner.gid);
  const html=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect this device · LytGuide</title><style>body{font:16px system-ui;margin:24px auto;padding:16px;max-width:560px;line-height:1.5;color:#173b32}a{display:block;padding:14px;background:#11734d;color:white;border-radius:10px;text-align:center}code{display:block;overflow-wrap:anywhere;font-size:13px}</style><h1>Connect this device</h1><p>Compare this fingerprint with Warehouse Setup on the Pi before trusting the certificate.</p><code>${cert.fingerprint256}</code><p><a href="/root.cer" download="LytGuide-warehouse.cer">Download warehouse certificate</a></p><p>iPhone/iPad: install the downloaded profile in Settings → General → VPN &amp; Device Management, then enable it in About → Certificate Trust Settings.</p><p>Android: install this file as a CA certificate in Security settings. Menu names vary.</p><p>When finished, open <a href="https://${config.address}:${config.httpsPort}/work">LytGuide</a></p><p>This page shares only the public certificate. Enter warehouse passwords only on the HTTPS site.</p></html>`;
  for(const [name,value] of [['root.cer',cert.raw],['index.html',html]]){const path=join(folder,name);writeFileSync(path,value,{mode:0o600});chownSync(path,owner.uid,owner.gid);chmodSync(path,0o600);}
  return {fingerprint:cert.fingerprint256,downloadUrl:`http://${config.address}:${config.enrollPort}`,appUrl:`https://${config.address}:${config.httpsPort}/work`};
}
