import {randomUUID} from 'node:crypto';
import {existsSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {networkInterfaces} from 'node:os';
import {privateIPv4} from '../lib/pi-lan.js';

export function splitNmcli(line){const values=[''];let escape=false;for(const c of line){if(escape){values[values.length-1]+=c;escape=false;}else if(c==='\\')escape=true;else if(c===':')values.push('');else values[values.length-1]+=c;}return values;}
function keyValue(value){return String(value).replaceAll('\\','\\\\').replaceAll('\n','\\n').replaceAll('\r','\\r').replaceAll('\t','\\t').replaceAll(' ','\\s');}
export function wifiKeyfile({ssid,password,device,uuid=randomUUID(),security='wpa-psk'}){
  if(typeof ssid!=='string'||!Buffer.byteLength(ssid)||Buffer.byteLength(ssid)>32||ssid.includes('\0'))throw new Error('Choose a Wi-Fi name of 1–32 bytes.');
  if(!/^[a-zA-Z0-9_.-]{1,40}$/.test(device))throw new Error('Choose an available Wi-Fi adapter.');
  if(!['wpa-psk','sae'].includes(security)||typeof password!=='string'||(!/^[a-fA-F0-9]{64}$/.test(password)&&(password.length<8||Buffer.byteLength(password)>63))||/[\0\n\r]/.test(password))throw new Error('Enter the Wi-Fi password (8–63 characters).');
  return `[connection]\nid=LytGuide warehouse Wi-Fi\nuuid=${uuid}\ntype=wifi\ninterface-name=${device}\nautoconnect=true\n\n[wifi]\nmode=infrastructure\nssid=${keyValue(ssid)}\n\n[wifi-security]\nkey-mgmt=${security}\npsk=${keyValue(password)}\n\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n`;
}
export function currentNetwork(run){
  const addresses=Object.entries(networkInterfaces()).flatMap(([name,rows])=>(rows||[]).filter(row=>row.family==='IPv4'&&!row.internal&&privateIPv4(row.address)).map(row=>({name,address:row.address,netmask:row.netmask})));
  let devices=[],networks=[],available=false;
  try{devices=run('nmcli',['-t','-f','DEVICE,TYPE,STATE,CONNECTION','device','status']).trim().split('\n').filter(Boolean).map(line=>{const [device,type,state,connection]=splitNmcli(line);return {device,type,state,connection};});available=true;}catch{}
  if(available)try{networks=run('nmcli',['-t','-f','SSID,SIGNAL,SECURITY','device','wifi','list','--rescan','no']).trim().split('\n').filter(Boolean).map(line=>{const [ssid,signal,security]=splitNmcli(line);return {ssid,signal:Number(signal),security};}).filter(row=>row.ssid);}catch{}
  networks=networks.filter((row,index,all)=>all.findIndex(item=>item.ssid===row.ssid)===index).sort((a,b)=>b.signal-a.signal);
  return {addresses,devices,networks,available};
}
export async function connectWifi(run,input,{directory='/etc/NetworkManager/system-connections'}={}){
  const before=currentNetwork(run),device=before.devices.find(row=>row.device===input.device&&row.type==='wifi');
  if(!device)throw new Error('The selected Wi-Fi adapter is not available.');
  const security=before.networks.find(row=>row.ssid===input.ssid)?.security||'';
  if(/802\.1X|EAP/i.test(security))throw new Error('This network uses enterprise sign-in. Connect it in Raspberry Pi network settings, then return here and use the current connection.');
  const uuid=randomUUID(),path=join(directory,`lytguide-${uuid}.nmconnection`);
  let previous='';try{previous=run('nmcli',['-g','GENERAL.CON-UUID','device','show',device.device]).trim();}catch{}
  writeFileSync(path,wifiKeyfile({...input,uuid,security:/WPA3/.test(security)&&!/WPA2/.test(security)?'sae':'wpa-psk'}),{flag:'wx',mode:0o600});
  try {
    run('nmcli',['connection','load',path]);run('nmcli',['--wait','60','connection','up','uuid',uuid],{timeout:75000});
    const result=currentNetwork(run);if(!result.addresses.some(row=>row.name===device.device))throw new Error('Wi-Fi connected without a shed IP address. Check the router DHCP settings.');
    return result;
  }catch(error){
    try{run('nmcli',['connection','delete','uuid',uuid]);}catch{}if(existsSync(path))rmSync(path);
    if(/^[a-fA-F0-9-]{36}$/.test(previous))try{run('nmcli',['--wait','30','connection','up','uuid',previous],{timeout:45000});}catch{}
    throw new Error('Could not connect to shed Wi-Fi. Check its name/password and router. '+(error.message.includes('DHCP')?error.message:''));
  }
}
