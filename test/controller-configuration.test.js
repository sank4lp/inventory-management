import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeControllerConfiguration} from '../src/services/hardware-adapters/controller-configuration.js';
import {validateControllerConfiguration} from '../src/services/controller-profiles.js';
import {groupChecksum} from '../src/services/hardware-adapters/group-protocol.js';

const initial={address:'ESP32-01',requestId:'0000000000000001',expectedRevision:0,physicalCount:20,routing:Array.from({length:64},(_,i)=>i<20?i+1:0)};
test('configuration encoder rejects partial routing, duplicate positions, missing outputs and broadcasts',()=>{
 for(const change of [{routing:[]},{routing:initial.routing.map((n,i)=>i===1?1:n)},{physicalCount:21},{address:'*'},{address:'ALL'},{expectedRevision:-1},{physicalCount:65},{requestId:'bad'}])assert.throws(()=>encodeControllerConfiguration({...initial,...change}));
 const command=encodeControllerConfiguration(initial),tokens=command.split(' ');
 assert.equal(tokens.at(-1),groupChecksum('ESP32-01 configure '+tokens.slice(3,-1).join(' ')));
 assert.ok(command.length<320);
});
test('firmware persists routing, preserves logical IDs through insert/remove, and rejects failed, stale or busy updates',t=>{
 const compiler=process.env.CXX||'c++';
 try {execFileSync(compiler,['--version'],{stdio:'ignore'});}catch{t.skip('C++ compiler unavailable');return;}
 const root=fileURLToPath(new URL('../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'runtime-config-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));const binary=join(dir,'config');
 execFileSync(compiler,['-std=c++17','-I',join(root,'test/fixtures/esp32'),join(root,'test/fixtures/esp32/runtime-config.cpp'),'-o',binary]);
 // Cross-check the host's exact wire encoding against the actual firmware checksum/parser.
 execFileSync(binary,[encodeControllerConfiguration(initial)]);
 execFileSync(binary,[]);
 const reply=JSON.parse(execFileSync(binary,['--usb-status'],{encoding:'utf8'}));
 const actual=validateControllerConfiguration(reply,'ESP32-01','0123456789abcdef');
 assert.equal(actual.physicalCount,4);
 assert.deepEqual(actual.routing.slice(0,4),[1,2,3,4]);
});
