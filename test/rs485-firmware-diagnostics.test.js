import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {controllerBusDiagnostics,validateControllerConfiguration} from '../src/services/controller-profiles.js';

test('actual sketch reports UART startup failure, preserves GPIO4 transmit ordering and distinguishes USB from bus traffic',t=>{
  const compiler=process.env.CXX||'c++';
  try{execFileSync(compiler,['--version'],{stdio:'ignore'});}catch{t.skip('C++ compiler unavailable');return;}
  const root=fileURLToPath(new URL('../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'rs485-diagnostics-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));const binary=join(dir,'diagnostics');
  execFileSync(compiler,['-std=c++17','-I',join(root,'test/fixtures/esp32'),join(root,'test/fixtures/esp32/rs485-diagnostics.cpp'),'-o',binary]);
  const good=JSON.parse(execFileSync(binary,[],{encoding:'utf8'}));
  assert.equal(validateControllerConfiguration(good,'ESP32-01','0123456789abcdef').physicalCount,4);
  assert.deepEqual(controllerBusDiagnostics(good),{version:1,ready:true,baud:115200,rxPin:16,txPin:17,directionPin:4,rxBytes:49,rxLines:3,txBytes:good.rs485.txBytes,pingRequests:2});
  assert.ok(good.rs485.txBytes>0);
  const quantized=JSON.parse(execFileSync(binary,['--quantized-baud'],{encoding:'utf8'}));
  assert.equal(quantized.rs485.baud,115942);
  assert.equal(validateControllerConfiguration(quantized,'ESP32-01').physicalCount,4,'valid hardware divider rounding must not cause a successful upload to fail verification');
  const failed=JSON.parse(execFileSync(binary,['--failed-uart'],{encoding:'utf8'}));
  assert.equal(failed.fault,false,'a valid LED setup must not conceal failed UART initialization');
  assert.throws(()=>validateControllerConfiguration(failed,'ESP32-01'),/RS485 serial port did not start/);
  assert.throws(()=>validateControllerConfiguration(failed,'ESP32-01',null,{allowFault:true}),/RS485 serial port did not start/,'LED setup recovery cannot waive the new firmware UART check');
  assert.equal(validateControllerConfiguration(failed,'ESP32-01',null,{allowFault:true,allowBusFault:true}).physicalCount,4,'pre-upload recovery may inspect an old failed UART');
  const legacy={...good};delete legacy.rs485;assert.equal(controllerBusDiagnostics(legacy),null);assert.equal(validateControllerConfiguration(legacy,'ESP32-01').physicalCount,4);
  for(const changes of [{ready:'yes'},{rxBytes:-1},{txBytes:NaN},{rxPin:40},{version:2}])assert.throws(()=>controllerBusDiagnostics({...good,rs485:{...good.rs485,...changes}}),/invalid RS485 diagnostics/);
  for(const baud of [0,9600,112000,118000,4294967295])assert.throws(()=>validateControllerConfiguration({...good,rs485:{...good.rs485,baud}},'ESP32-01'),new RegExp(`reports ${baud} baud; expected about 115200`));
  for(const baud of [114048,115107,115201,115942,116352])assert.equal(validateControllerConfiguration({...good,rs485:{...good.rs485,baud}},'ESP32-01').physicalCount,4);
  for(const baud of [114047,116353])assert.throws(()=>validateControllerConfiguration({...good,rs485:{...good.rs485,baud}},'ESP32-01'),/within 1%/);
  assert.throws(()=>controllerBusDiagnostics({...good,rs485:{...good.rs485,rxBytes:-1}}),/rxBytes: -1/);
});
