// Two independent disposable ARM64 containers model a failed Pi and replacement.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {chmodSync,chownSync,copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

assert.ok(process.env.LYTGUIDE_DISPOSABLE_CONTAINER);
const state='/var/lib/lytguide-test',base='http://127.0.0.1:3310',dbPath=state+'/data/inventory.db';
const run=(command,args=[])=>execFileSync(command,args,{encoding:'utf8',timeout:240000,stdio:['pipe','pipe','pipe']});
function query(sql,...values){const db=new DatabaseSync(dbPath,{readOnly:true});try{return JSON.parse(JSON.stringify(db.prepare(sql).all(...values)));}finally{db.close();}}
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function installServiceDouble(){mkdirSync('/run/systemd/system',{recursive:true});mkdirSync('/boot/firmware',{recursive:true});for(const [source,target] of [['systemctl-check.py','systemctl'],['findmnt-check.py','findmnt']]){copyFileSync('/work/test/fixtures/pi-package/'+source,'/usr/local/bin/'+target);chmodSync('/usr/local/bin/'+target,0o755);}}
let cookie;
async function login(username='qa',password='package-test-password') {const r=await fetch(base+'/login',{method:'POST',headers:{Connection:'close','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,password}),redirect:'manual'});assert.equal(r.status,302);const value=r.headers.get('set-cookie');assert.match(value,/HttpOnly/);assert.match(value,/Secure/);cookie=value.split(';')[0];}
async function command(action,input){const r=await fetch(base+'/api/work/'+action,{method:'POST',headers:{Connection:'close',Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deviceId:'replacement-check',...input})});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
installServiceDouble();
if(process.argv[2]==='produce') {
  run('lytguide-test',['setup','--no-start']);
  writeFileSync('/boot/firmware/config.txt','untouched boot configuration\n');
  const beforeBoot=digest('/boot/firmware/config.txt');
  run('lytguide-test',['start']);await login();
  const row=query('SELECT * FROM inventory_balances WHERE available_quantity>0 LIMIT 1')[0],product=query('SELECT * FROM products WHERE id=?',row.product_id)[0];
  const created=await command('create',{direction:'pick',productId:product.id,quantity:1,preferredCellId:row.cell_id});
  const archives=state+'/data/archives';mkdirSync(archives,{recursive:true,mode:0o700});
  const uid=Number(run('id',['-u','lytguide-test']).trim()),gid=Number(run('id',['-g','lytguide-test']).trim());chownSync(archives,uid,gid);
  writeFileSync(archives+'/business-history-transfer.json','{"verifiedArchivedHistory":true}\n');chownSync(archives+'/business-history-transfer.json',uid,gid);
  run('lytguide-test',['backup']);
  const index=JSON.parse(readFileSync('/boot/firmware/LYTGUIDE-RECOVERY/recovery-info.json'));
  assert.ok(existsSync('/boot/firmware/LYTGUIDE-RECOVERY/'+index.filename));assert.equal(digest('/boot/firmware/config.txt'),beforeBoot);
  run('lytguide-test',['backup','--output','/tmp/warehouse-transfer.lytbackup']);
  const expected={taskId:created.taskId,productId:product.id,cellId:row.cell_id,cookie,labels:query('SELECT id,label_id FROM cells ORDER BY id'),warehouse:query("SELECT value FROM app_metadata WHERE key='warehouse_identity'")[0].value,dataset:query("SELECT value FROM app_metadata WHERE key='dataset_generation'")[0].value,receipts:query('SELECT COUNT(*) n FROM operation_receipts')[0].n};
  writeFileSync('/tmp/transfer-expected.json',JSON.stringify(expected));
  await command('recordMovement',{productId:product.id,unit:product.unit_of_measure,confirmed:true,rows:[{direction:'put',cellId:row.cell_id,quantity:2}]});
  assert.equal(query('SELECT SUM(available_quantity) n FROM inventory_balances')[0].n,3);
  run('lytguide-test',['stop']);
  console.log('PASS source Pi: Finder-folder mirror, untouched boot files, portable export of active work and archived history; later source movement is separate.');
}else if(process.argv[2]==='consume') {
  run('lytguide-test',['setup','--no-start']);
  const expected=JSON.parse(readFileSync('/tmp/transfer-expected.json'));
  const targetBefore=digest('/etc/lytguide-test/config.json');
  writeFileSync('/tmp/broken.lytbackup',readFileSync('/tmp/warehouse-transfer.lytbackup').subarray(0,100));
  assert.throws(()=>run('lytguide-test',['restore','--file','/tmp/broken.lytbackup','--confirm','RESTORE','--no-start']));
  assert.equal(digest('/etc/lytguide-test/config.json'),targetBefore);assert.equal(query('SELECT SUM(available_quantity) n FROM inventory_balances')[0].n,null);
  run('lytguide-test',['restore','--file','/tmp/warehouse-transfer.lytbackup','--confirm','RESTORE','--no-start']);
  assert.equal(query('SELECT SUM(available_quantity) n FROM inventory_balances')[0].n,1);
  assert.deepEqual(query('SELECT id,label_id FROM cells ORDER BY id'),expected.labels);
  assert.equal(query("SELECT value FROM app_metadata WHERE key='warehouse_identity'")[0].value,expected.warehouse);
  assert.notEqual(query("SELECT value FROM app_metadata WHERE key='dataset_generation'")[0].value,expected.dataset);
  assert.ok(query('SELECT COUNT(*) n FROM operation_receipts')[0].n>=expected.receipts);
  assert.equal(query('SELECT outcome FROM tasks WHERE id=?',expected.taskId)[0].outcome,'needs_review');
  assert.equal(query("SELECT COUNT(*) n FROM work_reports WHERE status='review' AND quantity_known=0")[0].n,1);
  assert.equal(query("SELECT COUNT(*) n FROM users WHERE username='replacement-admin'")[0].n,0);
  assert.equal(JSON.parse(readFileSync('/etc/lytguide-test/config.json')).hardware,'simulator');
  assert.equal(readFileSync(state+'/data/archives/business-history-transfer.json','utf8'),'{"verifiedArchivedHistory":true}\n');
  run('lytguide-test',['start']);
  assert.equal((await fetch(base+'/api/work/snapshot',{headers:{Connection:'close',Cookie:expected.cookie}})).status,401);
  await login();
  const snapshot=await (await fetch(base+'/api/work/snapshot',{headers:{Connection:'close',Cookie:cookie}})).json();assert.equal(snapshot.tasks.find(t=>t.id===expected.taskId).outcome,'needs_review');
  console.log('PASS restored original warehouse, archived history and accounts; old sessions rejected and unfinished task is reviewable through the API.');
  const product=query('SELECT * FROM products WHERE id=?',expected.productId)[0];
  await command('recordMovement',{productId:product.id,unit:product.unit_of_measure,confirmed:true,rows:[{direction:'put',cellId:expected.cellId,quantity:1}]});
  run('lytguide-test',['stop']);
  const healthyConfig=digest('/etc/lytguide-test/config.json');
  writeFileSync('/tmp/lytguide-service-check/fail-next-app-start','1');
  assert.throws(()=>run('lytguide-test',['restore','--file','/tmp/warehouse-transfer.lytbackup','--confirm','RESTORE']));
  assert.equal(query('SELECT SUM(available_quantity) n FROM inventory_balances')[0].n,2);assert.equal(digest('/etc/lytguide-test/config.json'),healthyConfig);assert.equal(existsSync(state+'/restore-in-progress.json'),false);
  console.log('PASS failed activation retains the replacement warehouse stock and configuration.');
  // Model power disappearing after old data was moved aside but before commit.
  const folder=state+'/recovery/pre-restore-'+randomUUID();mkdirSync(folder,{mode:0o700});
  const names=['config.json','runtime.env','desktop-url'];for(const name of names)copyFileSync('/etc/lytguide-test/'+name,folder+'/'+name);
  writeFileSync(state+'/restore-in-progress.json',JSON.stringify({folder,oldConfig:names}));
  renameSync(state+'/data',folder+'/data');mkdirSync(state+'/data',{mode:0o700});
  writeFileSync(state+'/.setup-lock','2147483647');
  assert.throws(()=>run('lytguide-test',['start']));
  assert.throws(()=>run('/usr/lib/lytguide-test/check-restore.sh'));
  run('lytguide-test',['restore-rollback','--confirm','RESTORE']);
  assert.equal(query('SELECT SUM(available_quantity) n FROM inventory_balances')[0].n,2);assert.equal(existsSync(state+'/restore-in-progress.json'),false);
  run('lytguide-test',['start']);await login();run('lytguide-test',['stop']);
  console.log('PASS independent replacement Pi: original accounts, stock, QR identity, history and replay evidence; unfinished work reviewed; stale sessions rejected; simulator forced; corrupt import leaves data intact; failed activation and interrupted restore roll back safely.');
  console.log('Mount discovery/service management were doubled in containers; real FAT storage, Finder and Raspberry Pi boot remain field checks.');
}else throw new Error('Choose produce or consume in an isolated container.');
