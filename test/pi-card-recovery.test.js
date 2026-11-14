import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,writeFileSync,closeSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {prepareRecoveredDatabase} from '../scripts/release/restore-data.mjs';
import {acquireRecoveryLock,recoveryUnits,recoveryVolume} from '../scripts/release/card-recovery.mjs';
import {createOperationsService} from '../src/modules/operations/service.js';

function fixture(fn){const cwd=process.cwd(),root=realpathSync(mkdtempSync(join(tmpdir(),'lytguide-recovery-')));let db;try{process.chdir(root);db=createDatabase({hashPassword,bootstrapAdmin:{name:'QA',username:'qa',password:'backup-test-password'},allowDevAuthSeeds:false,allowDemoInventorySeed:false});return fn({root,db});}finally{db?.close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});}}
test('portable recovery format: WAL, archives, corrupt files, safe extraction, card rotation and disk limits',()=>fixture(({root,db})=>{
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const result=spawnSync('python3',[new URL('./pi-recovery-checks.py',import.meta.url).pathname,join(root,'data/inventory.db')],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stderr,/Ran 8 tests/);assert.match(result.stderr,/OK/);
}));
test('replacement preparation preserves stock, accounts, QR mappings and durable receipts while putting unfinished work into review',()=>fixture(({db})=>{
  const actor=db.prepare("SELECT * FROM users WHERE username='qa'").get(),product=db.prepare('SELECT * FROM products ORDER BY id LIMIT 1').get(),cell=db.prepare('SELECT * FROM cells ORDER BY id LIMIT 1').get();
  const operations=createOperationsService({db});
  operations.command(actor,'recordMovement',{requestId:'recovery-stock-fixture',productId:product.id,unit:product.unit_of_measure,confirmed:true,rows:[{direction:'put',cellId:cell.id,quantity:4}]});
  const created=operations.command(actor,'create',{requestId:'recovery-task-fixture',direction:'pick',productId:product.id,quantity:2});
  operations.dispose();
  const before=db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id,product_id').all(),identity=db.prepare("SELECT value FROM app_metadata WHERE key='warehouse_identity'").get().value,dataset=db.prepare("SELECT value FROM app_metadata WHERE key='dataset_generation'").get().value,labels=db.prepare('SELECT id,label_id FROM cells ORDER BY id').all(),receipts=db.prepare('SELECT COUNT(*) n FROM operation_receipts').get().n;
  const result=prepareRecoveredDatabase(db,{createdAt:'2026-10-27T12:00:00Z'});
  assert.equal(result.unfinishedTasks,1);assert.deepEqual(db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id,product_id').all(),before);
  assert.deepEqual(db.prepare('SELECT id,label_id FROM cells ORDER BY id').all(),labels);
  assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key='warehouse_identity'").get().value,identity);
  assert.notEqual(db.prepare("SELECT value FROM app_metadata WHERE key='dataset_generation'").get().value,dataset);
  assert.equal(db.prepare('SELECT session_version FROM users WHERE id=?').get(actor.id).session_version,actor.session_version+1);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM operation_receipts').get().n>=receipts);
  assert.equal(db.prepare('SELECT outcome FROM tasks WHERE id=?').get(created.taskId).outcome,'needs_review');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM work_reports WHERE status='review' AND quantity_known=0").get().n,1);
  for(const table of ['cell_turns','work_guidance','stocktake_display_claims'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
}));
test('only a mounted Mac-readable volume is eligible for the card mirror',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'lytguide-volume-'))),path=join(root,'LYTGUIDE-RECOVERY');
  try{
    assert.equal(recoveryVolume(path,()=>({filesystems:[{target:root,fstype:'vfat'}]})),path);
    assert.throws(()=>recoveryVolume(path,()=>({filesystems:[{target:'/',fstype:'ext4'}]})),/FAT/);
    assert.throws(()=>recoveryVolume(path,()=>({filesystems:[{target:'/another',fstype:'vfat'}]})),/outside/);
    symlinkSync(root,path);assert.throws(()=>recoveryVolume(path,()=>({filesystems:[{target:root,fstype:'vfat'}]})),/symbolic link/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('recovery lock excludes concurrent work and reclaims a dead process after power loss',()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-lock-')),path=join(root,'lock');let fd;
  try{fd=acquireRecoveryLock(path);assert.throws(()=>acquireRecoveryLock(path),/Another/);closeSync(fd);fd=null;rmSync(path);writeFileSync(path,'2147483647');fd=acquireRecoveryLock(path);assert.ok(fd>=0);}
  finally{if(fd!=null)closeSync(fd);rmSync(root,{recursive:true,force:true});}
});
test('scheduled recovery has bounded time and writes only app state and its own card folder',()=>{
  const units=recoveryUnits();assert.match(units.timer,/OnUnitActiveSec=15min/);assert.match(units.service,/ProtectSystem=strict/);assert.match(units.service,/TimeoutStartSec=5min/);assert.match(units.service,/LYTGUIDE-RECOVERY/);assert.doesNotMatch(units.service,/ReadWritePaths=\/boot\s|PrivateTmp|npm/);
});
