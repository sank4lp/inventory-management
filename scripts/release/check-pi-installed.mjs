// Isolated Linux container acceptance. Never run against a warehouse instance.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const root='/opt/lytguide-test/current',base='http://127.0.0.1:3310',database='/var/lib/lytguide-test/data/inventory.db';
assert.equal(process.platform,'linux');assert.equal(process.arch,'arm64');
const env={...process.env,...Object.fromEntries(readFileSync('/etc/lytguide-test/runtime.env','utf8').split('\n').filter(s=>s&&!s.startsWith('#')).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}))};
assert.equal(env.NODE_ENV,'production');assert.equal(env.HARDWARE_ADAPTER,'simulator');assert.equal(existsSync(`${root}/node_modules`),false);
const dependencies=JSON.parse(readFileSync(`${root}/app/dependencies.json`,'utf8'));
assert.ok(dependencies.dependencies.some(d=>d.name==='xlsx'&&d.includedIn.includes('app/server.cjs')));
let server,cookie;
async function start(){server=spawn('runuser',['-u','lytguide-test','--',`${root}/runtime/node`,`${root}/app/server.cjs`],{cwd:root,env,stdio:['ignore','ignore','inherit']});for(let i=0;i<50;i++){try{const r=await fetch(`${base}/login`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('Packaged app did not start.');}
async function stop(){if(!server)return;const child=server;server=null;child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));}
async function get(path){const r=await fetch(base+path,{headers:cookie?{Cookie:cookie}:{},redirect:'manual'});if(r.status!==200)assert.fail(`${path}: ${r.status} ${await r.text()}`);return r;}
async function json(path){const r=await get(path);return r.json();}
async function command(action,input){const r=await fetch(`${base}/api/work/${action}`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:base},body:JSON.stringify({requestId:randomUUID(),deviceId:'package-acceptance',...input}),redirect:'manual'});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
function balance(productId){const db=new DatabaseSync(database,{readOnly:true});try{return db.prepare('SELECT COALESCE(SUM(available_quantity),0) n FROM inventory_balances WHERE product_id=?').get(productId).n;}finally{db.close();}}
try{
  await start();
  assert.equal((await fetch(`${base}/api/work/snapshot`)).status,401);
  const login=await fetch(`${base}/login`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'qa',password:'package-test-password'}),redirect:'manual'});
  assert.equal(login.status,302);const header=login.headers.get('set-cookie');assert.match(header,/HttpOnly/);assert.match(header,/Secure/);cookie=header.split(';')[0];
  for(const path of ['/work','/work/overview','/work/history','/work/task-history','/work/active-assignments','/record-movement','/recommended-actions','/products','/cells','/stocktaking','/reports','/settings/people','/settings/roles','/devices','/location-setup','/admin/product-fields','/backups','/work/timing','/settings/system','/profile'])await get(path);
  for(const path of ['/styles.css','/ui-template.css','/app.js','/sw.js','/client/work.js','/client/vendor/jsQR.js'])await get(path);
  await get('/warehouse-excel');await get('/settings/connect-device');
  const workbook=Buffer.from(await (await get('/warehouse-excel/template.xlsx')).arrayBuffer());
  assert.equal(workbook.readUInt32LE(0),0x04034b50);
  const upload=await fetch(`${base}/api/warehouse-excel/upload`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:base,Accept:'application/json'},body:JSON.stringify({fileName:'empty-sample.xlsx',base64:workbook.toString('base64')})});
  assert.equal(upload.status,400);
  assert.match((await upload.json()).error,/Add at least one mapping or product row/);
  const snapshot=await json('/api/work/snapshot'),product=snapshot.products[0],cell=snapshot.cells[0];assert.ok(product&&cell);assert.equal(balance(product.id),0);
  const svg=await (await get(`/labels/${cell.id}.svg`)).text();assert.match(svg,/<svg/);
  const input={requestId:randomUUID(),productId:product.id,unit:product.unit_of_measure,confirmed:true,rows:[{direction:'put',cellId:cell.id,quantity:2}]};
  assert.equal((await command('recordMovement',input)).status,'recorded');assert.equal(balance(product.id),2);assert.equal((await command('recordMovement',input)).replayed,true);assert.equal(balance(product.id),2);
  for(const [direction,quantity,expected] of [['put',2,4],['pick',3,1]]){
    const created=await command('create',{direction,quantity,productId:product.id,preferredCellId:cell.id});
    let task=(await json(`/api/work/snapshot?taskId=${created.taskId}`)).tasks.find(t=>t.id===created.taskId);assert.ok(task);
    for(const original of task.lines.filter(l=>l.execution_state==='ready')){
      task=(await json(`/api/work/snapshot?taskId=${created.taskId}`)).tasks.find(t=>t.id===created.taskId);let line=task.lines.find(l=>l.id===original.id);
      await command('acquire',{lineId:line.id,revision:line.revision,method:'arrival'});
      task=(await json(`/api/work/snapshot?taskId=${created.taskId}`)).tasks.find(t=>t.id===created.taskId);line=task.lines.find(l=>l.id===original.id);
      const done=await command('report',{lineId:line.id,revision:line.revision,assignmentGeneration:line.current_generation,cellId:line.cell_id,unit:line.unit_of_measure,quantity:line.planned_quantity,method:'manual',manualReason:'Package acceptance cell check',cellCompletion:true});assert.equal(done.status,'recorded');
    }
    task=(await json(`/api/work/snapshot?taskId=${created.taskId}`)).tasks.find(t=>t.id===created.taskId);assert.equal(task.outcome,'completed');assert.equal(balance(product.id),expected);
  }
  const badOrigin=await fetch(`${base}/api/work/recordMovement`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:'https://other.invalid'},body:JSON.stringify(input)});assert.equal(badOrigin.status,400);assert.equal(balance(product.id),1);
  await stop();await start();assert.equal(balance(product.id),1);assert.equal((await command('recordMovement',input)).replayed,true);assert.equal(balance(product.id),1);
  const db=new DatabaseSync(database,{readOnly:true});try{assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role='operator'").get().n,0);assert.ok(db.prepare('SELECT COUNT(*) n FROM transactions').get().n>=3);}finally{db.close();}
  console.log('PASS packaged ARM64 runtime without node_modules: production login, pages, local assets, QR generation, Excel workbook export and parsing, Put/Pick completion, receipt replay, stock persistence and origin guard.');
}finally{await stop();}
