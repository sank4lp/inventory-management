import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase} from '../src/db.js';
import {hashPassword,verifyPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {buildResetWarehouse} from '../scripts/release/reset-data.mjs';

for(const resetMode of ['clear-work','fresh'])for(const keepHardware of [true,false])test(`${resetMode}, hardware ${keepHardware?'kept':'cleared'}: stock/work reset without editing source or controller firmware`,()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-reset-')),cwd=process.cwd();let source,dest;
  try{
    process.chdir(root);source=createDatabase({hashPassword,bootstrapAdmin:{name:'Old owner',username:'oldowner',password:'old-owner-password'},allowDevAuthSeeds:false,allowWarehouseSeeds:false,allowDemoInventorySeed:false});
    const owner=source.prepare('SELECT * FROM users').get(),product=source.prepare('SELECT * FROM products LIMIT 1').get();
    const controller=configureControllerModules(source,{controllerCode:'REUSE',controllerAddress:'KEEP-ADDRESS',moduleCount:3,configuredBy:owner.id});
    source.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?)').run('controller_chip_identity:'+controller.id,'00:11:22:33:44:55','2026-01-01');
    const cell=source.prepare('SELECT * FROM cells WHERE controller_id=? LIMIT 1').get(controller.id);
    source.prepare("UPDATE cells SET active=1,display_name='Original bin',binding_verified_at='2026-01-01',binding_verified_by=? WHERE id=?").run(owner.id,cell.id);
    source.prepare("INSERT INTO location_labels(token,cell_id,state,created_at,qr_value,scanned_at,bound_by) VALUES('keep-label',?,'bound','2026-01-01','customer-qr','2026-01-01',?)").run(cell.id,owner.id);
    source.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,7,0)').run(product.id,cell.id);
    source.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('deadline_defaults','{\"hours\":4}','2026-01-01')").run();
    const before=source.prepare('SELECT * FROM inventory_balances').all(),usersBefore=source.prepare('SELECT * FROM users').all();
    const folder=join(root,'reset');const result=buildResetWarehouse(source,folder,{resetMode,keepHardware,username:'newowner',password:'1234',warehouseName:'Fresh Warehouse'});
    dest=new DatabaseSync(join(folder,'data/inventory.db'));
    for(const table of ['inventory_balances','tasks','transactions','stocktake_runs','work_reports','operation_receipts','work_guidance'])assert.equal(dest.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,table);
    assert.equal(dest.prepare('SELECT COUNT(*) n FROM products').get().n,resetMode==='fresh'?0:source.prepare('SELECT COUNT(*) n FROM products').get().n);
    assert.equal(dest.prepare('SELECT username FROM users').get().username,resetMode==='fresh'?'newowner':'oldowner');
    assert.ok(verifyPassword(resetMode==='fresh'?'1234':'old-owner-password',dest.prepare('SELECT password_hash FROM users').get().password_hash));
    assert.equal(dest.prepare('SELECT COUNT(*) n FROM controllers').get().n,keepHardware?1:0);
    assert.equal(dest.prepare('SELECT value FROM app_metadata WHERE key=?').get('controller_chip_identity:'+controller.id)?.value,keepHardware?'00:11:22:33:44:55':undefined);
    assert.equal(dest.prepare('SELECT COUNT(*) n FROM cells').get().n,keepHardware?source.prepare('SELECT COUNT(*) n FROM cells').get().n:0);
    assert.equal(dest.prepare('SELECT COUNT(*) n FROM location_labels').get().n,keepHardware?1:0);
    if(keepHardware){assert.equal(dest.prepare('SELECT address FROM controllers').get().address,'KEEP-ADDRESS');assert.equal(dest.prepare('SELECT qr_value FROM location_labels').get().qr_value,'customer-qr');assert.equal(dest.prepare('SELECT heartbeat_status FROM controllers').get().heartbeat_status,'offline');}
    assert.deepEqual(dest.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.notEqual(dest.prepare("SELECT value FROM app_metadata WHERE key='dataset_generation'").get().value,source.prepare("SELECT value FROM app_metadata WHERE key='dataset_generation'").get().value);
    if(keepHardware)assert.equal(dest.prepare("SELECT value FROM app_metadata WHERE key='warehouse_identity'").get().value,source.prepare("SELECT value FROM app_metadata WHERE key='warehouse_identity'").get().value,'printed QR codes keep their warehouse identity');
    assert.equal(result.reconnectCandidates.length,keepHardware?0:1);
    assert.deepEqual(source.prepare('SELECT * FROM inventory_balances').all(),before);assert.deepEqual(source.prepare('SELECT * FROM users').all(),usersBefore);
  }finally{dest?.close();source?.close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
});
