import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,statSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {adaptLanConfig} from '../scripts/lib/pi-lan-caddy.js';
import {
  privateIPv4,parseLanArguments,lanNetwork,renderLanConfig,renderLanUnit,
  checkOwnedFile,checkPortOwner,phoneUrl,MANAGED_MARKER,
} from '../scripts/lib/pi-lan.js';

const interfaces={eth0:[{family:'IPv4',address:'192.168.1.140',netmask:'255.255.255.0',internal:false}],lo:[{family:'IPv4',address:'127.0.0.1',netmask:'255.0.0.0',internal:true}]};

test('Pi LAN preflight supports file-only Caddy builds and cleans up after success or failure',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lightguide-lan-test-'));
  const config=renderLanConfig({address:'192.168.1.140',cidr:'192.168.1.0/24'});
  let candidate;
  const execute=(command,args,options)=>{
    assert.equal(command,'/usr/bin/caddy');
    assert.deepEqual(args.slice(0,4),['adapt','--adapter','caddyfile','--config']);
    candidate=args[4];
    // Model the distribution build that cannot read --config - from stdin.
    if(candidate==='-')throw new Error('reading input file: open -: no such file or directory');
    assert.equal(readFileSync(candidate,'utf8'),config);
    assert.equal(statSync(candidate).mode&0o777,0o600);
    assert.equal(statSync(join(candidate,'..')).mode&0o777,0o700);
    assert.equal(options.input,undefined);
    return '{"admin":{"disabled":true}}\n';
  };
  try{
    assert.equal(adaptLanConfig(config,{tempRoot:dir,execute}),'{"admin":{"disabled":true}}');
    assert.equal(existsSync(candidate),false);
    assert.deepEqual(readdirSync(dir),[]);
    assert.throws(()=>adaptLanConfig(config,{tempRoot:dir,execute:(...args)=>{
      execute(...args);
      throw Object.assign(new Error('failed'),{stderr:'Error: invalid config'});
    }}),/\/usr\/bin\/caddy failed: Error: invalid config/);
    assert.equal(existsSync(candidate),false);
    assert.deepEqual(readdirSync(dir),[]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Pi LAN setup refuses public, loopback, injected and unassigned addresses',()=>{
  for(const address of ['8.8.8.8','0.0.0.0','127.0.0.1','::1','192.168.1.140\nadmin :2019','192.168.1.999']){
    assert.equal(privateIPv4(address),false);
    assert.throws(()=>parseLanArguments(['install','--address',address]));
  }
  for(const address of ['10.1.2.3','172.16.1.3','172.31.255.3','192.168.1.140'])assert.equal(privateIPv4(address),true);
  assert.throws(()=>lanNetwork('192.168.1.141',interfaces),/not assigned/);
  assert.deepEqual(lanNetwork('192.168.1.140',interfaces),{interface:'eth0',cidr:'192.168.1.0/24'});
  assert.throws(()=>lanNetwork('192.168.1.140',{eth0:[{...interfaces.eth0[0],netmask:'255.0.0.0'}]}),/private LAN/);
  assert.throws(()=>lanNetwork('192.168.1.140',{eth0:[{...interfaces.eth0[0],netmask:'255.0.255.0'}]}),/invalid/);
});

test('Pi LAN command preserves explicit ports and refuses malformed options',()=>{
  const options=parseLanArguments(['install','--address','192.168.1.140','--port','8443','--app-port','3001']);
  assert.deepEqual(options,{command:'install',address:'192.168.1.140',port:8443,appPort:3001});
  assert.equal(phoneUrl(options),'https://192.168.1.140:8443');
  assert.equal(phoneUrl({...options,port:443}),'https://192.168.1.140');
  for(const args of [['--port','0'],['--port','1.5'],['--port','65536'],['--port','3000'],['--app-port'],['--unknown','1']])assert.throws(()=>parseLanArguments(['install','--address','192.168.1.140',...args]));
});

test('Pi LAN configuration isolates the listener, origin and authority from development',()=>{
  const config=renderLanConfig({address:'192.168.1.140',port:8443,appPort:3001,cidr:'192.168.1.0/24'});
  assert.match(config,/https:\/\/192\.168\.1\.140:8443/);
  assert.match(config,/bind 192\.168\.1\.140/);
  assert.match(config,/remote_ip 192\.168\.1\.0\/24 127\.0\.0\.1/);
  assert.match(config,/reverse_proxy 127\.0\.0\.1:3001/);
  assert.match(config,/tls internal/);
  assert.match(config,/skip_install_trust/);
  assert.match(config,/admin off/);
  assert.doesNotMatch(config,/header_up Host|file_server|0\.0\.0\.0|acme_dns/);
  const unit=renderLanUnit();
  assert.match(unit,/User=caddy/);
  assert.match(unit,/StateDirectoryMode=0700/);
  assert.doesNotMatch(unit,/npm start|src\/server.js|HARDWARE_ADAPTER|SESSION_SECRET/);
});

test('Pi LAN refuses to replace unrelated files or stop another service using the port',()=>{
  checkOwnedFile(null,'example');
  checkOwnedFile(`${MANAGED_MARKER}\nconfig`,'example');
  assert.throws(()=>checkOwnedFile('other service','example'),/unmanaged/);
  checkPortOwner('',null);
  checkPortOwner('LISTEN 0 4096 192.168.1.140:443 *:* users:(("caddy",pid=420,fd=5))','420');
  assert.throws(()=>checkPortOwner('LISTEN users:(("nginx",pid=421,fd=5))','420'),/already in use/);
  assert.throws(()=>checkPortOwner('LISTEN 0 4096 *:443 *:*','420'),/already in use/);
});

test('Pi LAN wrapper refuses to install or expose the app on a development Mac',()=>{
  if(process.platform==='linux')return;
  const r=spawnSync('sh',[new URL('../scripts/install-pi-lan.sh',import.meta.url).pathname,'192.168.1.140'],{encoding:'utf8'});
  assert.equal(r.status,1);
  assert.match(r.stderr,/Raspberry Pi/);
});
