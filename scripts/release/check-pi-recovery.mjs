// Disposable Linux-container check, using a service double rather than systemd boot.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync,existsSync,mkdirSync,readFileSync,readlinkSync,renameSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {request} from 'node:https';
import {DatabaseSync} from 'node:sqlite';

assert.ok(process.env.LYTGUIDE_DISPOSABLE_CONTAINER,'Never run against a warehouse installation.');
const root='/opt/lytguide-test',config='/etc/lytguide-test/config.json',database='/var/lib/lytguide-test/data/inventory.db';
const run=(name,args=[])=>execFileSync(name,args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000});
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function balance(){const db=new DatabaseSync(database,{readOnly:true});try{return db.prepare('SELECT SUM(available_quantity) n FROM inventory_balances').get().n;}finally{db.close();}}
mkdirSync('/run/systemd/system',{recursive:true});
cpSync('/work/test/fixtures/pi-package/systemctl-check.py','/usr/local/bin/systemctl');
run('chmod',['755','/usr/local/bin/systemctl']);
const node=`${root}/current/runtime/node`,address=JSON.parse(run(node,['-e','console.log(JSON.stringify(Object.values(require("node:os").networkInterfaces()).flat().find(x=>x.family==="IPv4"&&!x.internal).address))']));
const expectedStock=Number(process.env.LYTGUIDE_CHECK_EXPECTED_STOCK||1);assert.ok(Number.isFinite(expectedStock));
assert.equal(balance(),expectedStock);
run('lytguide-test',['setup','--address',address]);
const beforeCurrent=readlinkSync(`${root}/current`);
const ca='/var/lib/lytguide-test/caddy/pki/authorities/local/root.crt',beforeCa=digest(ca),beforeConfig=digest(config);
await new Promise((resolve,reject)=>{const req=request(`https://${address}:8443/login`,{ca:readFileSync(ca),timeout:5000},res=>{res.resume();res.on('end',()=>{try{assert.equal(res.statusCode,200);resolve();}catch(e){reject(e);}});});req.on('error',reject);req.end();});
console.log('PASS actual Caddy HTTPS, dedicated service users and certificate verification on an isolated LAN.');
assert.throws(()=>run('lytguide-test',['update','--no-start']),/failed/);
run('systemctl',['enable','inventory-management.service']);
let hardwareError;
try{run('lytguide-test',['setup','--hardware','rs485','--serial-port','/dev/null']);}catch(error){hardwareError=String(error.stderr);}
assert.match(hardwareError,/Stop and disable inventory-management.service/);
run('systemctl',['disable','inventory-management.service']);
assert.equal(digest(config),beforeConfig);assert.equal(balance(),expectedStock);
// An intact, deliberately incompatible candidate exercises post-switch failure recovery.
const broken=`${root}/releases/0.1.0~recovery-check`;
if(existsSync(broken))run('rm',['-rf',broken]);
run('cp',['-al',beforeCurrent,broken]);
unlinkSync(`${broken}/app/server.cjs`);writeFileSync(`${broken}/app/server.cjs`,'throw new Error("Deliberate isolated release-check startup failure");\n');
const manifest=JSON.parse(readFileSync(`${broken}/release.json`,'utf8'));manifest.version='0.1.0~recovery-check';
manifest.files.find(file=>file.path==='app/server.cjs').sha256=digest(`${broken}/app/server.cjs`);
unlinkSync(`${broken}/release.json`);writeFileSync(`${broken}/release.json`,JSON.stringify(manifest,null,2)+'\n');
symlinkSync(broken,`${root}/candidate.next`);renameSync(`${root}/candidate.next`,`${root}/candidate`);
let failure;
try{run('lytguide-test',['update']);}catch(error){failure=String(error.stderr);}
assert.match(failure,/previous test configuration was restored/);
assert.doesNotMatch(failure,/Recovery needs attention/);
assert.equal(readlinkSync(`${root}/current`),beforeCurrent);assert.equal(digest(config),beforeConfig);assert.equal(digest(ca),beforeCa);assert.equal(balance(),expectedStock);
assert.equal(run('systemctl',['is-active','lytguide-test.service']).trim(),'active');
assert.equal(run('systemctl',['is-active','lytguide-test-web.service']).trim(),'active');
symlinkSync(beforeCurrent,`${root}/candidate.next`);renameSync(`${root}/candidate.next`,`${root}/candidate`);
run('lytguide-test',['update']);
assert.equal(digest(ca),beforeCa);assert.equal(balance(),expectedStock);
run('lytguide-test',['certificate']);
run('lytguide-test',['stop']);
run('systemctl',['disable','lytguide-test.service','lytguide-test-web.service']);
console.log('PASS failed activation restores the prior release, configuration, database and services; explicit update retains stock and the same CA; competing legacy hardware service is protected.');
console.log('Service orchestration was simulated here; real Raspberry Pi systemd boot remains a field check.');

