import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import QRCode from 'qrcode';
import {deviceEnrollment, readDeviceEnrollment, publishDeviceEnrollment, enrollmentPage} from '../src/services/device-enrollment.js';
import {deviceAccessRoutes} from '../src/modules/device-access/routes.js';
import {routeAllowed} from '../src/modules/access/routes-policy.js';
import {SETTINGS} from '../src/modules/access/catalog.js';
import {renderLanConfig, parseLanArguments} from '../scripts/lib/pi-lan.js';
import {packageLanConfig} from '../scripts/release/lan-enrollment.mjs';

let root, cert, otherCert;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'lytguide-enrollment-test-'));
  for (const label of ['one', 'two']) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=Test warehouse ${label}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(root, label+'.key'), '-out', join(root, label+'.crt')], {stdio:'ignore'});
  }
  cert = readFileSync(join(root, 'one.crt'));
  otherCert = readFileSync(join(root, 'two.crt'));
});
after(() => rmSync(root, {recursive:true, force:true}));
const config = {address:'192.168.1.140', httpsPort:443, enrollPort:8444, warehouseName:'North warehouse'};
const response = () => ({headers:{}, body:'', writeHead(status, headers){this.status=status;this.headers=headers;}, end(body=''){this.body=body;}});
const admin = {id:1, role:'admin', name:'Administrator'};
const call = async (path, record, user=admin) => {
  const res=response();
  await deviceAccessRoutes({method:'GET'}, res, new URL(path, 'http://localhost'), user, {read:()=>record});
  return res;
};

test('multiple Pis on the same Wi-Fi have separate addresses and certificates; no shared-hostname promise', () => {
  const first=deviceEnrollment({...config, certificate:cert});
  const second=deviceEnrollment({...config, address:'192.168.1.141', httpsPort:8443, warehouseName:'South warehouse', certificate:otherCert});
  assert.equal(first.appUrl, 'https://192.168.1.140/work');
  assert.equal(second.appUrl, 'https://192.168.1.141:8443/work');
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(first.downloadUrl, second.downloadUrl);
  const html=enrollmentPage(second);
  assert.match(html, /South warehouse/);
  assert.match(html, /separate shortcut/);
  assert.match(html, /Wi-Fi cannot choose/);
  assert.doesNotMatch(html, /192\.168\.1\.140|lytguide\.local|PRIVATE KEY/);
});

test('device metadata is public-only and certificate bytes match the real CA; publishing keeps the CA unchanged', () => {
  const metadataPath=join(root, 'public', 'access.json'), folder=join(root, 'enrollment');
  const input={...config, certificatePath:join(root, 'one.crt'), metadataPath, folder};
  const record=publishDeviceEnrollment({...input, sessionSecret:'not-public', password:'not-public'});
  assert.deepEqual(readDeviceEnrollment({path:metadataPath}), record);
  assert.deepEqual(readFileSync(join(folder, 'root.cer')), new X509Certificate(cert).raw);
  assert.equal(statSync(metadataPath).mode & 0o777, 0o644);
  assert.equal(statSync(join(folder, 'root.cer')).mode & 0o777, 0o600);
  const published=readFileSync(metadataPath, 'utf8')+readFileSync(join(folder, 'index.html'), 'utf8');
  assert.doesNotMatch(published, /not-public|PRIVATE KEY|sessionSecret|password"/);
  const updated=publishDeviceEnrollment({...input, address:'192.168.1.142'});
  assert.equal(updated.fingerprint, record.fingerprint);
  assert.equal(readDeviceEnrollment({path:metadataPath}).appUrl, 'https://192.168.1.142/work');
  assert.deepEqual(readFileSync(join(root, 'one.crt')), cert);
  // Restoration republishes the restored warehouse's CA, not the replacement Pi's former one.
  const restored=publishDeviceEnrollment({...input, certificatePath:join(root, 'two.crt')});
  assert.notEqual(restored.fingerprint, record.fingerprint);
  assert.deepEqual(readFileSync(join(folder, 'root.cer')), new X509Certificate(otherCert).raw);
  assert.equal(readDeviceEnrollment({path:metadataPath}).fingerprint, restored.fingerprint);
});

test('unsafe addresses, ports, malformed/expired certificates and unsupported metadata are rejected', () => {
  for(const address of ['8.8.8.8', '127.0.0.1', '192.168.1.140\nadmin :2019'])assert.throws(()=>deviceEnrollment({...config, address, certificate:cert}));
  for(const enrollPort of [443, -1, 80, 70000])assert.throws(()=>deviceEnrollment({...config, enrollPort, certificate:cert}));
  assert.throws(()=>deviceEnrollment({...config, certificate:readFileSync(join(root, 'one.key'))}));
  const file=join(root, 'invalid.json');
  writeFileSync(file, JSON.stringify(deviceEnrollment({...config, certificate:cert})));
  assert.throws(()=>readDeviceEnrollment({path:file, now:Date.parse(new X509Certificate(cert).validTo)+1}), /date\/time/);
  assert.throws(()=>readDeviceEnrollment({path:file, now:0}), /date\/time/);
  writeFileSync(file, JSON.stringify({...deviceEnrollment({...config, certificate:cert}), version:9}));
  assert.throws(()=>readDeviceEnrollment({path:file}), /Update phone access/);
});

test('Settings displays a QR for the non-TLS certificate page; download returns only the CA', async () => {
  const record=deviceEnrollment({...config, certificate:cert});
  const page=await call('/settings/connect-device', record);
  assert.equal(page.status, 200);
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.ok(page.body.includes(await QRCode.toString(record.downloadUrl, {type:'svg', margin:2, width:220})));
  for(const text of ['North warehouse', 'Certificate Trust Settings', 'Android phone / tablet', 'Add to Home Screen', 'separate shortcut', record.fingerprint])assert.ok(page.body.includes(text), text);
  const download=await call('/settings/connect-device/root.cer', record);
  assert.equal(download.headers['Content-Type'], 'application/pkix-cert');
  assert.match(download.headers['Content-Disposition'], /attachment/);
  assert.equal(download.headers['Cache-Control'], 'no-store');
  assert.deepEqual(download.body, new X509Certificate(cert).raw);
});

test('device setup follows Settings permissions; missing or invalid setup offers recovery instead of a broken QR', async () => {
  assert.ok(SETTINGS.some(([url])=>url==='/settings/connect-device'));
  for(const path of ['/settings/connect-device', '/settings/connect-device/root.cer']) {
    assert.equal(routeAllowed(admin, 'GET', path), true);
    assert.equal(routeAllowed({id:2, role:'operator'}, 'GET', path), false);
    await assert.rejects(()=>call(path, deviceEnrollment({...config, certificate:cert}), {id:2, role:'operator'}), /not permitted/);
  }
  const read=()=>{throw Object.assign(new Error('missing'), {code:'ENOENT'});};
  for(const path of ['/settings/connect-device', '/settings/connect-device/root.cer']) {
    const res=response();await deviceAccessRoutes({method:'GET'},res,new URL(path,'http://localhost'),admin,{read});
    assert.equal(res.status,path.endsWith('.cer')?503:200);
    assert.match(res.body,/Phone access has not been published/);
    assert.doesNotMatch(res.body,/device-enrollment-qr|BEGIN CERTIFICATE/);
  }
});

test('warehouse names are escaped in both screens; phone bootstrap exposes no sign-in form', async () => {
  const record=deviceEnrollment({...config, warehouseName:'<script>alert(1)</script>', certificate:cert});
  for(const html of [enrollmentPage(record),(await call('/settings/connect-device',record)).body]) {
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
  }
  assert.doesNotMatch(enrollmentPage(record), /<form|<input|<script/);
});

test('Git and packaged installers restrict public download to three read-only paths on the local network', () => {
  const network={cidr:'192.168.1.0/24'};
  for(const caddy of [renderLanConfig({...config,port:443,appPort:3000,...network}),packageLanConfig({...config,appPort:3310},network)]) {
    const bootstrap=caddy.slice(caddy.indexOf('http://'));
    assert.match(bootstrap,/path \/ \/index\.html \/root\.cer/);
    assert.match(bootstrap,/method GET HEAD/);
    assert.match(bootstrap,/remote_ip 192\.168\.1\.0\/24 127\.0\.0\.1/);
    assert.match(bootstrap,/Cache-Control "no-store"/);
    assert.doesNotMatch(bootstrap,/reverse_proxy|pki\/authorities/);
    assert.match(caddy,/tls internal/);
  }
  assert.throws(()=>renderLanConfig({...config,port:443,appPort:8444,...network}), /Invalid certificate-download/);
  assert.deepEqual(parseLanArguments(['install','--address',config.address,'--enroll-port','8444','--name','Main warehouse']),{command:'install',address:config.address,port:443,appPort:3000,enrollPort:8444,warehouseName:'Main warehouse'});
});

test('failed enrollment publication restores the previous downloadable certificate and instructions', () => {
  const folder=join(root,'rollback-enrollment'),metadataPath=join(root,'rollback.json');
  const input={...config,certificatePath:join(root,'one.crt'),metadataPath,folder};
  publishDeviceEnrollment(input);
  const before=readFileSync(join(folder,'index.html'));
  const blocker=join(root,'not-a-directory');writeFileSync(blocker,'occupied');
  assert.throws(()=>publishDeviceEnrollment({...input,certificatePath:join(root,'two.crt'),metadataPath:join(blocker,'access.json')}),/Could not publish/);
  assert.deepEqual(readFileSync(join(folder,'root.cer')),new X509Certificate(cert).raw);
  assert.deepEqual(readFileSync(join(folder,'index.html')),before);
  assert.equal(readDeviceEnrollment({path:metadataPath}).fingerprint,new X509Certificate(cert).fingerprint256);
});

test('real application routes expose Settings, the stylesheet and certificate while enforcing sign-in', async () => {
  const cwd=process.cwd();
  const {Readable,Writable}=await import('node:stream');
  const {finished}=await import('node:stream/promises');
  const data=mkdtempSync(join(tmpdir(),'device-app-test-'));
  symlinkSync(join(cwd,'public'),join(data,'public'));
  process.chdir(data);process.env.NO_SERVER_LISTEN='1';process.env.HARDWARE_ADAPTER='simulator';
  const metadataPath=join(root,'http-access.json');
  writeFileSync(metadataPath,JSON.stringify(deviceEnrollment({...config,certificate:cert})));
  process.env.LYTGUIDE_DEVICE_ACCESS_FILE=metadataPath;
  try{
    const {requestHandler}=await import('../src/server.js');
    const {getAppState}=await import('../src/server/app-state.js');
    const {createSessionCookie}=await import('../src/services/auth.js');
    const {db}=getAppState(),user=db.prepare("SELECT * FROM users WHERE role='admin'").get();
    const request=async(path,signedIn=true)=>{
      const req=Readable.from([]);Object.assign(req,{method:'GET',url:path,headers:{host:'localhost',...(signedIn?{cookie:createSessionCookie(user)}:{})}});
      const chunks=[],res=new Writable({write(chunk,encoding,next){chunks.push(Buffer.from(chunk));next();}});
      res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};
      await requestHandler(req,res);await finished(res);
      return {status:res.status,headers:res.headers,body:Buffer.concat(chunks)};
    };
    assert.match((await request('/settings')).body.toString(),/href="\/settings\/connect-device"/);
    const page=await request('/settings/connect-device');assert.equal(page.status,200);assert.match(page.body.toString(),/North warehouse/);
    const css=await request('/device-enrollment.css',false);assert.equal(css.status,200);assert.match(css.headers['Content-Type'],/text\/css/);assert.match(css.body.toString(),/device-enrollment-grid/);
    const download=await request('/settings/connect-device/root.cer');assert.equal(download.status,200);assert.deepEqual(download.body,new X509Certificate(cert).raw);
    const guest=await request('/settings/connect-device/root.cer',false);assert.equal(guest.status,302);assert.equal(guest.headers.Location,'/login');
    const manifest=await request('/manifest.webmanifest',false);assert.equal(manifest.status,200);assert.equal(JSON.parse(manifest.body).start_url,'/work');
    db.close();
  }finally{process.chdir(cwd);delete process.env.LYTGUIDE_DEVICE_ACCESS_FILE;rmSync(data,{recursive:true,force:true});}
});
