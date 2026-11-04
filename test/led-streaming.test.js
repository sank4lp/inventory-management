import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {displayFrame,displayEntry} from '../src/services/hardware-adapters/display-frame.js';
import {validateControllerConfiguration} from '../src/services/controller-profiles.js';
import {createRs485Adapter} from '../src/services/hardware-adapters/rs485.js';

const root=fileURLToPath(new URL('../',import.meta.url));
function build(t,source,flags=[]) {
  const compiler=process.env.CXX||'c++';
  try{execFileSync(compiler,['--version'],{stdio:'ignore'});}catch{t.skip('C++ compiler unavailable');return;}
  const dir=mkdtempSync(join(tmpdir(),'led-streaming-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const binary=join(dir,'check');
  execFileSync(compiler,['-std=c++17','-I',join(root,'test/fixtures/esp32/rmt'),'-I',join(root,'test/fixtures/esp32'),...flags,source,'-o',binary]);return binary;
}
test('streaming driver sends whole chains with bounded storage, timeout and safe recovery',t=>{
  const binary=build(t,join(root,'test/fixtures/esp32/led-streaming.cpp'));if(binary)execFileSync(binary,[]);
});
test('17, 18, 22 and 64 matrices render heartbeats and report output failures without losing RS485',t=>{
  const dir=mkdtempSync(join(tmpdir(),'led-sketch-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const frame=displayFrame('ESP32-01','0123456789abcdef',[displayEntry('to ESP32-01 digit 1 "8" green 120 100')]).command;
  const source=join(dir,'check.cpp');
  writeFileSync(source,`
#include <cassert>
#include "${root}firmware/esp32-simple-matrix/esp32-simple-matrix.ino"
void command(const char *text){RS485.output.clear();RS485.input+=std::string(text)+"\\n";loop();}
int main(){setup();assert(!ledOutputFault && !configurationFault);int lit=0;for(auto c:pixels.colors)if(c)lit++;assert(lit==LED_MODULE_COUNT);
auto saved=runtimeConfig;Adafruit_NeoPixel::failShow=true;
command(${JSON.stringify(frame)});assert(RS485.output.find("led-output-failed")!=std::string::npos);assert(RS485.output.find("\\\"type\\\":\\\"ack\\\"")==std::string::npos);
command("to ESP32-01 ping");assert(RS485.output.find("\\\"ledReady\\\":false")!=std::string::npos);assert(!configurationFault);assert(memcmp(&saved,&runtimeConfig,sizeof(saved))==0);
Adafruit_NeoPixel::failShow=false;command(${JSON.stringify(frame)});assert(!ledOutputFault);assert(RS485.output.find("display-frame")!=std::string::npos);
usbMaintenance=true;Serial.output.clear();char request[]="to ESP32-01 config-status 0123456789abcdef";handleLine(request);usbMaintenance=false;printf("%s",Serial.output.c_str());
}`);
  for(const count of [17,18,22,64]) {
    const binary=build(t,source,[`-DLED_MODULE_COUNT=${count}`,'-DLYTGUIDE_TEST_LED_FAILURE=Adafruit_NeoPixel::failShow']);if(!binary)return;
    const reply=JSON.parse(execFileSync(binary,[],{encoding:'utf8'}));
    assert.equal(validateControllerConfiguration(reply,'ESP32-01').physicalCount,count);
    assert.equal(reply.led.ready,true);
    for(const error of [-1,257,263]) {
      const failed={...reply,led:{version:1,driver:'rmt-stream',ready:false,error}};
      assert.throws(()=>validateControllerConfiguration(failed,'ESP32-01'),/LED output failed/);
      assert.equal(validateControllerConfiguration(failed,'ESP32-01',null,{allowLedFault:true}).physicalCount,count);
    }
    for(const led of [null,{...reply.led,ready:'yes'},{...reply.led,error:1},{...reply.led,error:NaN}]) {
      assert.throws(()=>validateControllerConfiguration({...reply,led},'ESP32-01',null,{allowLedFault:true}),/invalid LED output diagnostics/);
    }
  }
});
test('display failure is surfaced immediately and never mistaken for a delivered frame',t=>{
  let pending='',frames=0;
  const adapter=createRs485Adapter({config:{rs485WriteLine(line){
    if(line.includes(' ping'))pending=JSON.stringify({type:'pong',address:'CTRL',modules:22,ledReady:true,displayFrame:1});
    if(line.includes(' display-frame ')){frames++;pending=JSON.stringify({type:'error',address:'CTRL',message:'led-output-failed',error:263});}
  },rs485ReadWindow(){const reply=pending;pending='';return reply;}},logger:{debug(){},warn(){}}});
  t.after(()=>adapter.dispose());
  const result=adapter.batch(()=>adapter.showCellQuantity({id:1,controller_address:'CTRL',hardware_channel:1},5));
  assert.equal(frames,1);assert.equal(result.failures.length,1);
  assert.match(result.failures[0].message,/received the command, but its LED output failed/);
});
test('browser distinguishes a responsive controller with failed LED output from a silent RS485 bus',t=>{
  let ready=false;
  const adapter=createRs485Adapter({config:{rs485WriteLine(){},rs485ReadWindow(){return JSON.stringify({type:'pong',address:'CTRL',modules:22,ledReady:ready,ledError:ready?0:263,displayFrame:1});}},logger:{debug(){},warn(){}}});
  t.after(()=>adapter.dispose());
  const failed=adapter.checkControllerHealth({address:'CTRL',controller_code:'CTRL2'});
  assert.equal(failed.ok,false);assert.match(failed.message,/responds on RS485, but its LED output failed/);
  ready=true;assert.equal(adapter.checkControllerHealth({address:'CTRL',controller_code:'CTRL2'}).ok,true);
});
