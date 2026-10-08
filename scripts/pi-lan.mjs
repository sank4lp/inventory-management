#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,unlinkSync,chmodSync,chownSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {dirname} from 'node:path';
import {
  APP_SERVICE,LAN_SERVICE,LAN_CONFIG,LAN_UNIT,LAN_STORAGE,LAN_ROOT_CERT,
  parseLanArguments,lanNetwork,renderLanConfig,renderLanUnit,checkOwnedFile,checkPortOwner,phoneUrl,
} from './lib/pi-lan.js';

function run(command,args,{optional=false,input}={}) {
  try { return execFileSync(command,args,{encoding:'utf8',timeout:20000,input,stdio:['pipe','pipe','pipe']}).trim(); }
  catch(error) {
    if(optional)return '';
    const message=String(error.stderr||error.message).trim();
    throw new Error(`${command} failed: ${message}`);
  }
}
function existing(path) {return existsSync(path)?readFileSync(path,'utf8'):null;}
function writeAtomic(path,contents) {
  mkdirSync(dirname(path),{recursive:true,mode:0o755});
  const staged=`${path}.new-${process.pid}`;
  try{writeFileSync(staged,contents,{mode:0o644});chmodSync(staged,0o644);renameSync(staged,path);}
  finally{if(existsSync(staged))unlinkSync(staged);}
}
function status(service,property) {return run('systemctl',['show',service,`--property=${property}`,'--value'],{optional:true});}
function requirePi() {
  if(process.platform!=='linux')throw new Error('Run this command on the Raspberry Pi. No Mac or Windows configuration is changed.');
}
function localProbe(appPort) {
  run('curl',['--noproxy','*','--fail','--silent','--show-error','--max-time','10','--output','/dev/null',`http://127.0.0.1:${appPort}/login`]);
}
function verify(options) {
  if(!existsSync(LAN_ROOT_CERT))throw new Error('The warehouse certificate has not been created yet. Check the HTTPS service status.');
  localProbe(options.appPort);
  if(status(LAN_SERVICE,'ActiveState')!=='active')throw new Error('The warehouse HTTPS service is not active.');
  // Certificate validation stays enabled; there is no insecure (-k) fallback.
  run('curl',['--noproxy','*','--fail','--silent','--show-error','--max-time','10','--cacert',LAN_ROOT_CERT,'--output','/dev/null',`${phoneUrl(options)}/login`]);
}
function preflight(options) {
  const network=lanNetwork(options.address,networkInterfaces());
  if(!existsSync('/usr/bin/caddy'))throw new Error('Caddy is not installed. On the Pi, install the caddy package first (instructions in docs/pi-local-network.md).');
  run('/usr/bin/caddy',['version']);
  run('id',['caddy']);
  if(status(APP_SERVICE,'ActiveState')!=='active')throw new Error('Start the existing inventory-management.service first. This setup never starts a second copy of the app.');
  localProbe(options.appPort);
  checkOwnedFile(existing(LAN_CONFIG),LAN_CONFIG);
  checkOwnedFile(existing(LAN_UNIT),LAN_UNIT);
  const listeners=run('ss',['-H','-ltnp',`sport = :${options.port}`]);
  const pid=status(LAN_SERVICE,'MainPID');
  checkPortOwner(listeners,pid&&pid!=='0'?pid:null);
  const config=renderLanConfig({...options,cidr:network.cidr});
  // Adapt the complete candidate before replacing any installed configuration.
  run('/usr/bin/caddy',['adapt','--adapter','caddyfile','--config','-'],{input:config});
  return {network,config};
}
function install(options) {
  if(process.getuid()!==0)throw new Error('Install needs sudo on the Raspberry Pi.');
  const {network,config}=preflight(options);
  const before={config:existing(LAN_CONFIG),unit:existing(LAN_UNIT),active:status(LAN_SERVICE,'ActiveState')==='active',enabled:run('systemctl',['is-enabled',LAN_SERVICE],{optional:true})==='enabled'};
  const uid=Number(run('id',['-u','caddy'])),gid=Number(run('id',['-g','caddy']));
  mkdirSync(LAN_STORAGE,{recursive:true,mode:0o700});chmodSync(LAN_STORAGE,0o700);chownSync(LAN_STORAGE,uid,gid);
  try {
    writeAtomic(LAN_CONFIG,config);
    // Only this separate service writes/renews its local certificates.
    run('runuser',['-u','caddy','--','/usr/bin/caddy','validate','--adapter','caddyfile','--config',LAN_CONFIG]);
    writeAtomic(LAN_UNIT,renderLanUnit());
    run('systemctl',['daemon-reload']);
    run('systemctl',['enable',LAN_SERVICE]);
    run('systemctl',['restart',LAN_SERVICE]);
    let lastError;
    for(let attempt=0;attempt<10;attempt++){
      try{verify(options);lastError=null;break;}catch(error){lastError=error;run('sleep',['1']);}
    }
    if(lastError)throw lastError;
  }catch(error){
    const recovery=[];
    const repair=(fn)=>{try{fn();}catch(e){recovery.push(e.message);}};
    repair(()=>run('systemctl',['stop',LAN_SERVICE]));
    if(!before.enabled)repair(()=>run('systemctl',['disable',LAN_SERVICE]));
    for(const [path,contents] of [[LAN_CONFIG,before.config],[LAN_UNIT,before.unit]])repair(()=>{if(contents==null){if(existsSync(path))unlinkSync(path);}else writeAtomic(path,contents);});
    repair(()=>run('systemctl',['daemon-reload']));
    if(before.active)repair(()=>run('systemctl',['start',LAN_SERVICE]));
    throw new Error(`HTTPS setup failed; restored the previous HTTPS configuration. The inventory service/database were not changed. ${error.message}${recovery.length?` Recovery needs attention: ${recovery.join('; ')}`:''}`);
  }
  console.log(`Warehouse HTTPS is ready at ${phoneUrl(options)}\nNetwork: ${network.cidr} (${network.interface})\nExisting inventory service and hardware configuration are unchanged.\nReserve ${options.address} in the router. Install the public certificate on your phone before opening the site.\nExport it: sudo node scripts/pi-lan.mjs certificate --address ${options.address}${options.port===443?'':` --port ${options.port}`}`);
}
function certificate(options) {
  verify(options);
  const target='/home/admin/lightguide-warehouse-root.cer';
  const publicCertificate=execFileSync('openssl',['x509','-in',LAN_ROOT_CERT,'-outform','DER'],{timeout:20000});
  if(existsSync(target)&&!readFileSync(target).equals(publicCertificate))throw new Error('A different certificate already exists in /home/admin. Rename it before exporting; do not replace a previously trusted warehouse certificate silently.');
  writeFileSync(target,publicCertificate,{mode:0o644});chmodSync(target,0o644);
  chownSync(target,Number(run('id',['-u','admin'])),Number(run('id',['-g','admin'])));
  console.log(`Public certificate: ${target}\n${run('openssl',['x509','-inform','DER','-in',target,'-noout','-fingerprint','-sha256'])}\nOnly this public certificate should be copied to the phone. Private keys remain on the Pi.`);
}

try {
  const options=parseLanArguments(process.argv.slice(2));
  if(options.command==='help')console.log('On the Raspberry Pi:\n  sudo node scripts/pi-lan.mjs check --address 192.168.1.140\n  sudo node scripts/pi-lan.mjs install --address 192.168.1.140\n  sudo node scripts/pi-lan.mjs verify --address 192.168.1.140\n  sudo node scripts/pi-lan.mjs certificate --address 192.168.1.140\nOptional: --port 8443, --app-port 3000\nSee docs/pi-local-network.md for phone certificate setup.');
  else {
    requirePi();
    if(options.command==='install')install(options);
    else if(options.command==='certificate')certificate(options);
    else if(options.command==='verify'){lanNetwork(options.address,networkInterfaces());verify(options);console.log(`Verified HTTPS and app access: ${phoneUrl(options)}`);}
    else {const {network}=preflight(options);console.log(`Checks passed for ${phoneUrl(options)} on ${network.cidr}. No configuration was changed.`);}
  }
}catch(error){console.error(error.message);process.exitCode=1;}
