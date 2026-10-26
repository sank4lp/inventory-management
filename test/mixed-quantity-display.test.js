import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {MIXED_PRODUCT_COLORS,mixedQuantityTiming} from '../src/services/quantity-display.js';

test('mixed quantity colours never reuse workflow colours and timing covers a full scroll',()=>{
 assert.deepEqual(MIXED_PRODUCT_COLORS,['cyan','white','pink']);
 for(const color of MIXED_PRODUCT_COLORS)assert.ok(!['yellow','amber','red','green','blue','orange','purple'].includes(color));
 assert.equal(mixedQuantityTiming(4).durationMs,4000);
 assert.equal(mixedQuantityTiming(10).durationMs,2760);
 assert.equal(mixedQuantityTiming(100).durationMs,3600);
 for(const value of [-1,2.5,1000,'LOC'])assert.throws(()=>mixedQuantityTiming(value));
});

test('actual matrix sketch parses addressed once, scrolls one pass and preserves other module/task modes',t=>{
 const compiler=process.env.CXX||'c++';
 const probe=spawnSync(compiler,['--version'],{encoding:'utf8',timeout:10000});
 if(probe.error?.code==='ENOENT'){t.skip('A native C++ compiler is needed for the firmware harness.');return;}
 assert.equal(probe.status,0,probe.stderr);
 const folder=mkdtempSync(join(tmpdir(),'lyt-matrix-once-'));
 writeFileSync(join(folder,'Adafruit_NeoPixel.h'),`
#pragma once
#include <cstdint>
#include <cctype>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <vector>
#include <string>
using byte=uint8_t;
inline unsigned long mockNow=1000;
inline unsigned long millis(){return mockNow;}
inline void pinMode(int,int){} inline void digitalWrite(int,int){} inline void delayMicroseconds(int){}
#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define SERIAL_8N1 0
#define NEO_GRB 0
#define NEO_KHZ800 0
class HardwareSerial{public:HardwareSerial(int=0){} size_t setRxBufferSize(size_t n){return n;} void begin(int,int=0,int=0,int=0){} int available(){return 0;} int read(){return -1;} void print(const char*){} void flush(){}};
inline HardwareSerial Serial;
class Adafruit_NeoPixel{public:std::vector<uint32_t> values;int brightness=0;Adafruit_NeoPixel(int n,int,int):values(n){} uint8_t *getPixels(){return values.empty()?nullptr:reinterpret_cast<uint8_t *>(values.data());} void begin(){} void show(){} void setBrightness(int n){brightness=n;} uint32_t Color(int r,int g,int b){return (r<<16)|(g<<8)|b;} void setPixelColor(int i,uint32_t c){values.at(i)=c;}};
`);
 const sketch=fileURLToPath(new URL('../firmware/esp32-simple-matrix/esp32-simple-matrix.ino',import.meta.url));
 writeFileSync(join(folder,'check.cpp'),`
#include <cassert>
#include "${sketch}"
void command(const char* text){char buffer[160];strncpy(buffer,text,159);buffer[159]=0;handleLine(buffer);}
void step(){mockNow+=120;updateScrolls();}
int main(){
 setup();assert(pixels.brightness==255);int first,second;assert(parseModuleNumber("1",&first));assert(parseModuleNumber("2",&second));
 command("to ESP32-01 text 1 \\"10\\" cyan 120 100 once");
 assert(modules[first].scrollOnce);assert(modules[first].color==pixels.Color(0,255,255));assert(modules[first].mode==MODE_SCROLL);
 command("to ESP32-01 digit 2 \\"4\\" green 120 100");assert(modules[second].mode==MODE_STATIC);
 mockNow+=119;updateScrolls();assert(modules[first].scrollOffset==W);mockNow+=1;updateScrolls();
 for(int i=1;i<22;i++)step();assert(modules[first].mode==MODE_SCROLL);step();assert(modules[first].mode==MODE_OFF);step();assert(modules[first].mode==MODE_OFF);assert(modules[second].mode==MODE_STATIC);
 command("to ESP32-01 text 1 \\"100\\" pink 120 100 once");assert(modules[first].color==pixels.Color(255,0,255));for(int i=0;i<29;i++)step();assert(modules[first].mode==MODE_SCROLL);step();assert(modules[first].mode==MODE_OFF);
 command("to ESP32-01 text 1 \\"4\\" white 120 100 once");assert(modules[first].mode==MODE_STATIC);for(int i=0;i<40;i++)step();assert(modules[first].mode==MODE_STATIC);
 command("to ESP32-01 digit 1 \\"100\\" green 120 100");assert(!modules[first].scrollOnce);for(int i=0;i<35;i++)step();assert(modules[first].mode==MODE_SCROLL);
 command("to ESP32-01 text 1 \\"10\\" white 120 100");assert(!modules[first].scrollOnce);for(int i=0;i<24;i++)step();assert(modules[first].mode==MODE_SCROLL);
 command("to OTHER text 1 \\"9\\" pink 120 100 once");assert(strcmp(modules[first].text,"10")==0);
 return 0;
}
`);
 const output=join(folder,'check'),build=spawnSync(compiler,['-std=c++17','-I',folder,'-I',fileURLToPath(new URL('./fixtures/esp32',import.meta.url)),join(folder,'check.cpp'),'-o',output],{encoding:'utf8',timeout:30000});
 assert.equal(build.status,0,build.stdout+'\n'+build.stderr);
 const run=spawnSync(output,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
});
