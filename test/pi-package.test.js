import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {INSTALL_ROOT,STATE_ROOT,listReleaseFiles,runtimeEnvironment,serviceUnit,validateReleaseVersion,validateTestConfig,verifyRelease} from '../scripts/release/pi-package.mjs';

const config={appPort:3310,httpsPort:8443,hardware:'simulator',serialPort:'',sessionSecret:'a'.repeat(64),siteId:'test-123'};
test('test package separates stock, ports, privileges and hardware from the existing Pi app',()=>{
  assert.equal(INSTALL_ROOT,'/opt/lytguide-test');assert.equal(STATE_ROOT,'/var/lib/lytguide-test');
  const unit=serviceUnit(),web=serviceUnit(true),env=runtimeEnvironment(config);
  assert.match(unit,/User=lytguide-test\n/);assert.match(web,/User=lytguide-test-web\n/);
  assert.match(unit,/SupplementaryGroups=dialout/);assert.match(unit,/ProtectHome=true/);assert.match(unit,/PrivateTmp=true/);assert.doesNotMatch(unit,/User=root|inventory-management.service/);
  assert.match(unit,/current\/runtime\/node/);assert.match(web,/current\/runtime\/caddy/);
  assert.match(env,/NODE_ENV=production/);assert.match(env,/HARDWARE_ADAPTER=simulator/);assert.match(env,/DEMO_INVENTORY_SEED=0/);
  assert.doesNotMatch(env,/BOOTSTRAP_ADMIN_PASSWORD|admin123|node_modules|npm start/);
});
test('test configuration rejects invalid ports, shared ports, injected serial paths and missing secrets',()=>{
  assert.deepEqual(validateTestConfig(config),config);
  for(const change of [{appPort:80},{httpsPort:3310},{appPort:3.1},{httpsPort:65536},{hardware:'unknown'},{hardware:'rs485',serialPort:'/dev/ttyUSB0\nNODE_ENV=development'},{hardware:'simulator',serialPort:'/dev/ttyUSB0\nNODE_ENV=development'},{sessionSecret:''},{siteId:'site\nPORT=1'}])assert.throws(()=>validateTestConfig({...config,...change}));
  assert.match(runtimeEnvironment({...config,hardware:'rs485',serialPort:'/dev/serial/by-id/usb-ESP32'}),/HARDWARE_ADAPTER=rs485/);
});
test('a test release detects altered and added files while leaving the mutable database outside integrity checks',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lytguide-package-'));
  try{
    mkdirSync(join(dir,'app'));writeFileSync(join(dir,'app/server.cjs'),'server');symlinkSync('/var/lib/lytguide-test/data',join(dir,'data'));
    mkdirSync(join(dir,'toolchain/data'),{recursive:true});symlinkSync('/var/lib/lytguide-test/cache/arduino-inventory.yaml',join(dir,'toolchain/data/inventory.yaml'));
    const files=listReleaseFiles(dir),manifest={version:'0.1.0~test.1',platform:'linux',arch:'arm64',licensing:'test-unlicensed',files};
    writeFileSync(join(dir,'release.json'),JSON.stringify(manifest));assert.equal(verifyRelease(dir).files.length,1);
    writeFileSync(join(dir,'app/server.cjs'),'tampered');assert.throws(()=>verifyRelease(dir),/integrity/);
    writeFileSync(join(dir,'app/server.cjs'),'server');writeFileSync(join(dir,'extra'),'unexpected');assert.throws(()=>verifyRelease(dir),/integrity/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('release verification refuses a symlink escaping the payload and a wrong target or licensing format',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lytguide-package-'));
  try{
    symlinkSync('/etc/hosts',join(dir,'escape'));assert.throws(()=>listReleaseFiles(dir),/escapes/);
    rmSync(join(dir,'escape'));writeFileSync(join(dir,'release.json'),JSON.stringify({version:'1.0',platform:'darwin',arch:'arm64',licensing:'test-unlicensed',files:[]}));assert.throws(()=>verifyRelease(dir),/ARM64 test/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('release versions cannot introduce shell or filesystem operations',()=>{
  assert.equal(validateReleaseVersion('0.1.0~test.20261027.1'),'0.1.0~test.20261027.1');
  for(const v of ['../bad','x/1','1; reboot','1\n2','', '1..2'])assert.throws(()=>validateReleaseVersion(v));
});
test('portable archive builder creates a real ARM64 Debian package with root-owned files and executable hooks',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lytguide-deb-'));
  try{
    const root=join(dir,'root'),control=join(dir,'control'),output=join(dir,'test.deb');mkdirSync(root);mkdirSync(control);writeFileSync(join(root,'hello'),'hello');writeFileSync(join(control,'control'),'Package: test\nVersion: 1\nArchitecture: arm64\n');writeFileSync(join(control,'postinst'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    const result=spawnSync('python3',[new URL('../scripts/release/make-archives.py',import.meta.url).pathname,'deb',root,output,'--control',control,'--epoch','1234'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const data=readFileSync(output);assert.equal(data.subarray(0,8).toString(),'!<arch>\n');let offset=8;const members=[];while(offset<data.length){const head=data.subarray(offset,offset+60).toString(),name=head.slice(0,16).trim().replace(/\/$/,''),size=Number(head.slice(48,58));members.push(name);offset+=60+size+(size%2);}assert.deepEqual(members,['debian-binary','control.tar.gz','data.tar.gz']);assert.equal(offset,data.length);
    const verify=spawnSync('python3',['-c',`import sys,tarfile,gzip,io\nb=open(sys.argv[1],'rb').read();i=8\nwhile i<len(b):\n h=b[i:i+60];n=h[:16].decode().strip().rstrip('/');s=int(h[48:58]);v=b[i+60:i+60+s];i+=60+s+s%2\n if n.endswith('.tar.gz'):\n  t=tarfile.open(fileobj=io.BytesIO(v),mode='r:gz')\n  assert all(x.uid==0 and x.gid==0 for x in t.getmembers())\n  if n=='control.tar.gz':assert t.getmember('./postinst').mode&0o111\n`,output],{encoding:'utf8'});assert.equal(verify.status,0,verify.stderr);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Mac setup guard does not mutate the development host',()=>{
  if(process.platform==='linux')return;
  const r=spawnSync(process.execPath,[new URL('../scripts/release/control.mjs',import.meta.url).pathname,'setup'],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/64-bit Raspberry Pi/);
});
test('a fresh production-style package can bootstrap a named admin and restart without demo accounts or stock',()=>{
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),'lytguide-bootstrap-'));let db;
  try{
    process.chdir(dir);const options={hashPassword,bootstrapAdmin:{name:'Test admin',username:'qa',password:'test-bootstrap-password'},allowDevAuthSeeds:false,allowDemoInventorySeed:false};
    db=createDatabase(options);assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username='qa'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username IN ('admin','operator')").get().n,0);assert.equal(db.prepare('SELECT COALESCE(SUM(available_quantity),0) n FROM inventory_balances').get().n,0);assert.ok(db.prepare('SELECT COUNT(*) n FROM cells').get().n>0);db.close();db=null;
    db=createDatabase(options);assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  }finally{db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});}
});
