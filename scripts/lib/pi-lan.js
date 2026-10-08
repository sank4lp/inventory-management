import {isIP} from 'node:net';

export const LAN_SERVICE = 'inventory-management-lan.service';
export const APP_SERVICE = 'inventory-management.service';
export const LAN_CONFIG = '/etc/inventory-management/lan.Caddyfile';
export const LAN_STORAGE = '/var/lib/inventory-management-lan';
export const LAN_ROOT_CERT = `${LAN_STORAGE}/pki/authorities/local/root.crt`;
export const LAN_UNIT = `/etc/systemd/system/${LAN_SERVICE}`;
export const MANAGED_MARKER = '# LightGuide LAN HTTPS; managed by scripts/pi-lan.mjs';

export function privateIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseLanArguments(args) {
  const [command = 'help', ...rest] = args;
  if (!['help','check','install','verify','certificate'].includes(command)) throw new Error('Use check, install, verify or certificate.');
  const options = {command,address:'',port:443,appPort:3000};
  const names = {'--address':'address','--port':'port','--app-port':'appPort'};
  for (let i=0;i<rest.length;i+=2) {
    const name=names[rest[i]], value=rest[i+1];
    if (!name || !value || value.startsWith('--')) throw new Error('Each option needs a value: --address, --port, --app-port.');
    if (name==='address') options.address=value;
    else {
      if (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>65535) throw new Error('Ports must be whole numbers from 1 to 65535.');
      options[name]=Number(value);
    }
  }
  if (command!=='help' && !privateIPv4(options.address)) throw new Error('Supply the Pi’s private IPv4 address, for example --address 192.168.1.140.');
  if (options.port===options.appPort) throw new Error('HTTPS and the existing app must use different ports.');
  return options;
}

export function lanNetwork(address, interfaces) {
  if (!privateIPv4(address)) throw new Error('Only a private IPv4 address can be used for warehouse access.');
  const matches=Object.entries(interfaces).flatMap(([name,rows])=>(rows||[]).filter(row=>row.address===address&&!row.internal&&row.family==='IPv4').map(row=>({name,...row})));
  if (matches.length!==1) throw new Error('This address is not assigned to one Pi network interface. Check hostname -I and reserve the address in the router.');
  const row=matches[0], mask=row.netmask.split('.').map(Number);
  if (mask.length!==4 || mask.some(n=>!Number.isInteger(n)||n<0||n>255)) throw new Error('The network mask is invalid.');
  const bits=mask.map(n=>n.toString(2).padStart(8,'0')).join('');
  if (!/^1+0*$/.test(bits)) throw new Error('The network mask is invalid.');
  const prefix=bits.indexOf('0')===-1?32:bits.indexOf('0');
  const network=address.split('.').map((v,i)=>Number(v)&mask[i]).join('.');
  const last=address.split('.').map((v,i)=>Number(v)|(~mask[i]&255)).join('.');
  // Do not turn a private listener into permission for an entire/public network.
  if (!privateIPv4(network) || !privateIPv4(last) || prefix>30) throw new Error('Use a private LAN subnet with room for phones, for example 192.168.1.0/24.');
  return {interface:row.name,cidr:`${network}/${prefix}`};
}

export function renderLanConfig({address,port=443,appPort=3000,cidr,storage=LAN_STORAGE}) {
  if (!privateIPv4(address) || !/^\d+(?:\.\d+){3}\/\d{1,2}$/.test(cidr)) throw new Error('Invalid LAN address or subnet.');
  for (const value of [port,appPort]) if (!Number.isInteger(value)||value<1||value>65535) throw new Error('Invalid port.');
  if (port===appPort) throw new Error('HTTPS and the app must use different ports.');
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(storage)) throw new Error('Invalid certificate storage directory.');
  return `${MANAGED_MARKER}
{
    admin off
    persist_config off
    auto_https disable_redirects
    skip_install_trust
    storage file_system ${storage}
    servers {
        protocols h1 h2
    }
}

https://${address}:${port} {
    bind ${address}
    tls internal
    encode gzip

    @warehouse remote_ip ${cidr} 127.0.0.1
    handle @warehouse {
        reverse_proxy 127.0.0.1:${appPort}
    }
    handle {
        respond "Connect to the warehouse Wi-Fi to open LightGuide." 403
    }
}
`;
}

export function renderLanUnit() {
  return `${MANAGED_MARKER}
[Unit]
Description=LightGuide warehouse HTTPS access
Wants=network-online.target
After=network-online.target ${APP_SERVICE}

[Service]
Type=simple
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --config ${LAN_CONFIG} --adapter caddyfile
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s
StateDirectory=inventory-management-lan
StateDirectoryMode=0700
Environment=XDG_DATA_HOME=${LAN_STORAGE}
Environment=XDG_CONFIG_HOME=${LAN_STORAGE}
WorkingDirectory=${LAN_STORAGE}
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${LAN_STORAGE}
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

export function checkOwnedFile(contents,path) {
  if (contents!=null&&!contents.startsWith(`${MANAGED_MARKER}\n`)) throw new Error(`Refusing to replace an unmanaged file: ${path}`);
}

export function checkPortOwner(listeners,pid) {
  const rows=listeners.trim().split('\n').filter(Boolean);
  if (rows.some(row=>!pid||!row.includes(`pid=${pid},`))) throw new Error('The HTTPS port is already in use. Keep the other service; choose --port 8443, or run the check with sudo to identify ownership.');
}

export function phoneUrl({address,port}) {
  return `https://${address}${port===443?'':`:${port}`}`;
}
