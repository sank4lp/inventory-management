import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {NEOPIXEL_LIBRARY_VERSION,NEOPIXEL_ESP_DRIVER_SHA256} from '../src/services/firmware-constants.js';

test('actual NeoPixel driver fixes the four-matrix ESP32 stack overflow and preserves pulse encoding and allocation-failure recovery',t=>{
 const compiler=process.env.CXX||'c++';
 try{execFileSync(compiler,['--version'],{stdio:'ignore'});}catch{t.skip('C++ compiler unavailable');return;}
 const fixtures=fileURLToPath(new URL('./fixtures/neopixel-driver/',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'neopixel-driver-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const fixed=join(fixtures,'esp-1.12.4.c'),old=join(fixtures,'esp-1.12.3.c');
 assert.equal(NEOPIXEL_LIBRARY_VERSION,'1.12.4');
 assert.equal(createHash('sha256').update(readFileSync(fixed)).digest('hex'),NEOPIXEL_ESP_DRIVER_SHA256);
 const args=['-std=c++17','-DESP32','-Werror=vla','-I',fixtures];
 const before=spawnSync(compiler,[...args,'-x','c++','-c',old,'-o',join(dir,'old.o')],{encoding:'utf8'});
 assert.notEqual(before.status,0,'old driver must expose its variable-length loop-stack buffer');
 assert.match(before.stderr,/variable.length|vla/i);
 const binary=join(dir,'fixed');
 execFileSync(compiler,[...args,'-DNEO_DRIVER_SOURCE="'+fixed+'"',join(fixtures,'driver-check.cpp'),'-o',binary]);
 const output=execFileSync(binary,[],{encoding:'utf8'});
 assert.match(output,/PASS actual fixed driver/);assert.match(output,/24576 bytes off the loop stack/);
});
