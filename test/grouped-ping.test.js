import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRs485Adapter} from '../src/services/hardware-adapters/rs485.js';
import {groupChecksum,groupMask} from '../src/services/hardware-adapters/group-protocol.js';

const cells=[1,2,3,4].map(n=>({id:n,controller_id:1,controller_address:'TEST',hardware_channel:n,logical_code:`C${n}`}));
function fixture(t,{supported=true,drop=0,wrong=false,offline=false}={}) {
  const writes=[];let pending='',groups=0;
  const adapter=createRs485Adapter({logger:{debug(){},warn(){}},config:{
    rs485WriteRepeats:1,rs485InterCommandDelayMs:0,rs485WriteRepeatDelayMs:0,
    rs485WriteLine(line){
      writes.push(line.trim());
      if(line.includes(' ping')) pending=offline?'':JSON.stringify({type:'pong',address:'TEST',groupBlink:supported?1:undefined});
      if(line.includes('blink-group')) {
        groups++;
        const request=line.trim().split(' ')[3];
        pending=groups<=drop?'':JSON.stringify({type:'ack',command:'blink-group',address:wrong?'OTHER':'TEST',request});
      }
    },
    rs485ReadWindow(){const result=pending;pending='';return result;},
  }});
  t.after(()=>adapter.dispose());return {adapter,writes};
}
test('group mask boundaries and standard CRC vector',()=>{
  assert.equal(groupChecksum('123456789'),'cbf43926');
  assert.equal(groupMask([1,2,3,4]),'f'+'0'.repeat(63));
  assert.equal(groupMask([255]),'0'.repeat(63)+'4');
  for(const n of [0,256,1.5,NaN])assert.throws(()=>groupMask([n]));
});
test('four cells use one checksummed group command and matching acknowledgement',t=>{
  const f=fixture(t),result=f.adapter.sendCellTests(cells);
  assert.equal(result.ok,true);assert.equal(result.events.length,4);
  const commands=f.writes.filter(s=>s.includes('blink-group'));assert.equal(commands.length,1);
  const tokens=commands[0].split(' ');assert.equal(tokens[4],groupMask([1,2,3,4]));
  assert.equal(tokens.at(-1),groupChecksum('TEST '+tokens.slice(3,-1).join(' ')));
  assert.ok(result.events.every(e=>e.payload.confirmed));
});
test('lost command or acknowledgement is retried with identical request identity',t=>{
  const f=fixture(t,{drop:2}),result=f.adapter.sendCellTests(cells);
  assert.equal(result.ok,true);
  const commands=f.writes.filter(s=>s.includes('blink-group'));assert.equal(commands.length,3);assert.equal(new Set(commands).size,1);
});
test('wrong controller acknowledgements do not report success or trigger individual fallback',t=>{
  const f=fixture(t,{wrong:true}),result=f.adapter.sendCellTests(cells);
  assert.equal(result.ok,false);assert.equal(result.degraded,true);
  assert.equal(f.writes.filter(s=>s.includes('blink-group')).length,3);
  assert.equal(f.writes.filter(s=>s.includes(' blink ')).length,0);
});
test('known legacy firmware retains individual delivery, offline controller gets no LED commands',t=>{
  const legacy=fixture(t,{supported:false});assert.equal(legacy.adapter.sendCellTests(cells).ok,true);
  assert.equal(legacy.writes.filter(s=>s.includes(' blink ')).length,4);
  const offline=fixture(t,{offline:true});assert.equal(offline.adapter.sendCellTests(cells).ok,false);
  assert.equal(offline.writes.filter(s=>s.includes('blink')).length,0);
});
test('group must stay on one controller',t=>{
  const f=fixture(t);assert.throws(()=>f.adapter.sendCellTests([cells[0],{...cells[1],controller_address:'OTHER'}]));
  assert.equal(f.writes.length,0);
});
test('actual firmware decoder validates whole group, refreshes once and suppresses duplicate animations',t=>{
  const compiler=process.env.CXX||'c++';
  try {execFileSync(compiler,['--version'],{stdio:'ignore'});}catch{t.skip('C++ compiler unavailable');return;}
  const dir=mkdtempSync(join(tmpdir(),'group-firmware-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=fileURLToPath(new URL('../',import.meta.url)),binary=join(dir,'group-test');
  execFileSync(compiler,['-std=c++17','-I',join(root,'test/fixtures/esp32'),join(root,'test/fixtures/esp32/grouped-ping.cpp'),'-o',binary]);
  execFileSync(binary,[]);
});
