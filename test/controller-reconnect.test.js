import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createHardwareService} from '../src/services/hardware.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {createRs485Adapter} from '../src/services/hardware-adapters/rs485.js';

function fixture() {
  const original=process.cwd();process.chdir(mkdtempSync(join(tmpdir(),'controller-reconnect-')));
  const db=createDatabase({hashPassword,allowDemoInventorySeed:true});
  const controllers=db.prepare('SELECT * FROM controllers ORDER BY id LIMIT 2').all();
  const cells=db.prepare('SELECT * FROM cells ORDER BY id LIMIT 3').all();
  db.exec('DELETE FROM inventory_balances; UPDATE cells SET controller_id=NULL,hardware_channel=NULL');
  controllers.forEach((c,i)=>db.prepare("UPDATE controllers SET address=?,heartbeat_status='offline',module_count=20 WHERE id=?").run('RECOVER'+i,c.id));
  cells.forEach((c,i)=>db.prepare('UPDATE cells SET controller_id=?,hardware_channel=? WHERE id=?').run(controllers[0].id,i+1,c.id));
  const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
  let time=new Date('2026-10-08T12:00:00Z'), lastAddress=null, probes=0;
  const writes=[], responding=new Set(), logger={info(){},warn(){},error(){},debug(){}};
  const hardware=createHardwareService({db,logger,clock:()=>time,config:{hardwareAdapter:'rs485',rs485WriteRepeats:2,rs485WriteRepeatDelayMs:0,rs485InterCommandDelayMs:0,
    rs485WriteLine:line=>{writes.push(line.trim());const ping=line.match(/^to (\S+) ping/);if(ping)lastAddress=ping[1];},
    rs485ReadWindow:timeout=>{if(timeout<=80){probes++;return '';}return responding.has(lastAddress)?JSON.stringify({type:'pong',address:lastAddress})+'\n':'';}}});
  const work=createOperationsService({db,hardwareService:hardware,logger}),display=createDisplayCoordinator({db,hardwareService:hardware,operationsService:work,clock:()=>time});
  const start=(kind='quantity',scope={})=>display.start(admin,{kind,cellIds:cells.map(c=>c.id),...scope},{requestId:randomUUID()});
  return {db,hardware,work,display,admin,cells,controllers,writes,responding,start,probes:()=>probes,advance:ms=>time=new Date(time.getTime()+ms),end(){hardware.dispose();db.close();process.chdir(original);}};
}

test('re-powered controller is checked once before displaying on all its cells',()=>{
  const f=fixture();try{
    f.responding.add('RECOVER0');const result=f.start();
    assert.ok(result.targets.every(t=>t.status==='sent'));assert.equal(f.probes(),1);
    assert.equal(f.db.prepare('SELECT heartbeat_status FROM controllers WHERE id=?').get(f.controllers[0].id).heartbeat_status,'online');
    assert.equal(f.writes.filter(line=>/text \d+ "0"/.test(line)).length,6);
  }finally{f.end();}
});

test('offline requests share a ten-second cooldown, then recover without service restart',()=>{
  const f=fixture();try{
    const failed=f.start();assert.ok(failed.targets.every(t=>t.status==='unreachable'));
    assert.match(failed.message,/Controller is offline.*power and connection/);assert.equal(f.probes(),1);
    f.advance(9999);f.responding.add('RECOVER0');f.start('ping');assert.equal(f.probes(),1);
    assert.ok(f.writes.every(line=>!line.includes('text')&&!line.includes('blink')));
    f.advance(1);const recovered=f.start('locate');assert.equal(f.probes(),2);assert.ok(recovered.targets.every(t=>t.status==='sent'));
  }finally{f.end();}
});

test('cooldown is per controller and a recent background probe is reused',()=>{
  const f=fixture();try{
    const c=f.db.prepare('SELECT * FROM controllers WHERE id=?').get(f.controllers[0].id);
    f.hardware.checkControllerHealth(c);assert.equal(f.probes(),1);
    f.db.prepare('UPDATE cells SET controller_id=?,hardware_channel=1 WHERE id=?').run(f.controllers[1].id,f.cells[2].id);
    f.responding.add('RECOVER1');const result=f.start();assert.equal(f.probes(),2);
    assert.equal(result.targets.find(t=>t.cellId===f.cells[2].id).status,'sent');
    assert.ok(result.targets.filter(t=>t.cellId!==f.cells[2].id).every(t=>t.status==='unreachable'));
  }finally{f.end();}
});

test('task guidance reconnects through the same hardware boundary without changing reservations',()=>{
  const f=fixture();try{
    f.responding.add('RECOVER0');const product=f.db.prepare('SELECT * FROM products LIMIT 1').get();
    f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,8,0)').run(product.id,f.cells[0].id);
    const created=f.work.command(f.admin,'create',{requestId:randomUUID(),direction:'pick',productId:product.id,quantity:2});
    const task=f.work.task(f.admin,created.taskId);assert.equal(task.lines[0].guidance.state,'sent');assert.equal(f.probes(),1);
    assert.equal(task.lines[0].reserved,2);assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(f.cells[0].id).available_quantity,8);
  }finally{f.end();}
});

test('a utility request never probes or overwrites a cell owned by active work',()=>{
  const f=fixture();try{
    f.responding.add('RECOVER0');const product=f.db.prepare('SELECT * FROM products LIMIT 1').get();
    f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,8,0)').run(product.id,f.cells[0].id);
    f.work.command(f.admin,'create',{requestId:randomUUID(),direction:'pick',productId:product.id,quantity:2});
    f.advance(10000);f.db.prepare("UPDATE controllers SET heartbeat_status='offline' WHERE id=?").run(f.controllers[0].id);
    const n=f.writes.length,checks=f.probes();const result=f.start('quantity',{cellIds:[f.cells[0].id]});
    assert.equal(result.targets[0].status,'busy');assert.equal(f.probes(),checks);assert.equal(f.writes.length,n);
  }finally{f.end();}
});

test('controller probe stops within its supplied budget before sending after a slow drain',()=>{
  const writes=[];const adapter=createRs485Adapter({logger:{debug(){},warn(){}},config:{rs485WriteLine:line=>writes.push(line),rs485ReadWindow:timeout=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,timeout);return '';}}});
  try{
    const began=performance.now();assert.throws(()=>adapter.checkControllerHealth({id:1,address:'RECOVER',controller_code:'Test'},{timeoutMs:40}),/timed out/);
    assert.ok(performance.now()-began<500);assert.equal(writes.length,0);
  }finally{adapter.dispose();}
});
