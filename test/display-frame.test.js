import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {displayEntry,displayFrame} from '../src/services/hardware-adapters/display-frame.js';
import {createRs485Adapter} from '../src/services/hardware-adapters/rs485.js';
import {createHardwareService} from '../src/services/hardware.js';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {saveControllerProfile} from '../src/services/controller-profiles.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createStocktakingService} from '../src/modules/stocktaking/service.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';

const logger={info(){},warn(){},error(){},debug(){}};
function transport({drop=0,wrong=false,legacy=false}={}) {
 const writes=[];let pending='',frames=0;
 return {writes,config:{hardwareAdapter:'rs485',rs485WriteRepeats:1,rs485WriteRepeatDelayMs:0,rs485InterCommandDelayMs:0,
 rs485WriteLine(line){const command=line.trim();writes.push(command);const parts=command.split(' ');
  if(parts[2]==='ping')pending=JSON.stringify({type:'pong',address:parts[1],groupBlink:1,displayFrame:legacy?undefined:1});
  if(parts[2]==='display-frame'){frames++;pending=frames<=drop?'':JSON.stringify({type:'ack',command:'display-frame',address:(wrong===true||wrong===parts[1])?'OTHER':parts[1],request:parts[3],checksum:parts[5]});}
 },rs485ReadWindow(){const response=pending;pending='';return response;}}};
}
const cells=[1,2,3,4].map(n=>({id:n,controller_id:1,controller_address:'TEST',hardware_channel:n,logical_code:'C'+n}));
function decode(command){const data=Buffer.from(command.split(' ')[4],'hex'),entries=[];let offset=1;for(let i=0;i<data[0];i++){const length=data[offset+13];entries.push({channel:data[offset],mode:data[offset+1],text:data.subarray(offset+14,offset+14+length).toString('ascii')});offset+=14+length;}return entries;}

test('one frame covers all primitives and single calls use matching acknowledgements without blind repeats',t=>{
 const wire=transport(),adapter=createRs485Adapter({config:wire.config,logger});t.after(()=>adapter.dispose());
 adapter.batch(()=>{adapter.showCellQuantity(cells[0],12);adapter.activateGuidance({id:1,type:'pick'},[{...cells[1],cell_id:2,planned_quantity:7}]);adapter.setCellLocate(cells[2],true,{managed:true});adapter.clearCellQuantity(cells[3]);});
 const frames=wire.writes.filter(c=>c.includes(' display-frame '));assert.equal(frames.length,1);assert.deepEqual(decode(frames[0]),[{channel:1,mode:1,text:'12'},{channel:2,mode:2,text:'7'},{channel:3,mode:5,text:''},{channel:4,mode:3,text:''}]);
 assert.equal(adapter.batch(()=>adapter.sendCellTest(cells[0])).failures.length,0);assert.equal(wire.writes.filter(c=>c.includes(' display-frame ')).length,2);
 assert.equal(wire.writes.some(c=>/ (text|digit|locate|clear|blink) /.test(c)),false);
});
test('lost ACK retries the identical frame; wrong controller cannot confirm it or cause legacy fallback',t=>{
 for(const settings of [{drop:2},{wrong:true}]){
  const wire=transport(settings),adapter=createRs485Adapter({config:wire.config,logger});t.after(()=>adapter.dispose());
  const result=adapter.batch(()=>adapter.showCellQuantity(cells[0],9));const frames=wire.writes.filter(c=>c.includes(' display-frame '));
  assert.equal(frames.length,3);assert.equal(new Set(frames).size,1);assert.equal(result.failures.length,settings.wrong?1:0);
  assert.equal(wire.writes.some(c=>c.includes(' text ')),false);
 }
});
test('frame entry validation refuses oversized or non-ASCII text and invalid physical outputs',()=>{
 for(const command of ['to TEST text 0 "7" red 120 100','to TEST text 65 "7" red 120 100',`to TEST text 1 "${'a'.repeat(56)}" white 120 100`,'to TEST text 1 "é" red 120 100','to TEST blink 1 green 101 5000'])assert.throws(()=>displayEntry(command));
});
function fixture(t,settings={}) {
 process.chdir(mkdtempSync(join(tmpdir(),'display-frame-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:false}),admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
 const configured=configureControllerModules(db,{controllerCode:'FAST',controllerAddress:'TEST',moduleCount:4,configuredBy:admin.id});
 db.prepare("UPDATE controllers SET heartbeat_status='online' WHERE id=?").run(configured.id);
 db.prepare("UPDATE cells SET active=1,display_name='Cell '||hardware_channel WHERE controller_id=?").run(configured.id);
 const controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(configured.id);
 saveControllerProfile(db,controller,{physicalCount:4,logicalCount:4,routing:Array.from({length:64},(_,i)=>i<4?i+1:0),revision:1});
 const wire=transport(settings),hardware=createHardwareService({db,config:wire.config,logger}),work=createOperationsService({db,hardwareService:hardware,logger,deferStocktakeDisplays:!!settings.deferStocktakeDisplays}),display=createDisplayCoordinator({db,hardwareService:hardware,operationsService:work});
 const cells=db.prepare('SELECT * FROM cells WHERE controller_id=? ORDER BY hardware_channel').all(controller.id);
 t.after(()=>{work.dispose();hardware.dispose();db.close();});return {db,admin,controller,cells,wire,hardware,work,display};
}
test('all display kinds share one guarded frame per controller, including stopping them',t=>{
 const f=fixture(t);const before=f.db.prepare('SELECT * FROM inventory_balances').all();
 for(const kind of ['module_number','quantity','cell_name','items_per_location','capacity_total','capacity_available','locate']){
  f.wire.writes.length=0;const display=f.display.start(f.admin,{kind,cellIds:f.cells.map(c=>c.id)});
  assert.equal(display.targets.filter(t=>t.status==='sent').length,4,kind);
  assert.equal(f.wire.writes.filter(c=>c.includes(' display-frame ')).length,1,kind);
  f.wire.writes.length=0;f.display.stop(f.admin,display.id);const clears=f.wire.writes.filter(c=>c.includes(' display-frame '));assert.equal(clears.length,1,kind);assert.ok(decode(clears[0]).every(e=>e.mode===3));
 }
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_balances').all(),before);
});
test('unacknowledged delivery is never marked successful and cleanup remains retryable',t=>{
 const f=fixture(t,{wrong:true}),display=f.display.start(f.admin,{kind:'module_number',cellIds:f.cells.map(c=>c.id)});
 assert.equal(display.targets.filter(t=>t.status==='sent').length,0);assert.ok(display.targets.every(t=>t.deliveryUnconfirmed));
 assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(display.id).state,'expiring');
 const newer=f.display.start(f.admin,{kind:'module_number',cellIds:f.cells.map(c=>c.id)});assert.ok(newer.targets.every(t=>t.status==='busy'));
 const unowned=f.hardware.showCellQuantity({...f.cells[0],controller_address:'TEST'},9);assert.equal(unowned.ok,false);
 const events=f.db.prepare("SELECT payload FROM device_events WHERE event_type='cell_quantity_displayed'").all();assert.equal(events.length,4);assert.ok(events.every(e=>JSON.parse(e.payload).status==='degraded'));
});
test('work guidance shares a controller frame and does not mark failed sends delivered',t=>{
 const f=fixture(t),p=f.db.prepare('SELECT id FROM products LIMIT 1').get();
 for(const c of f.cells)f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,2,0)').run(p.id,c.id);
 const result=f.work.command(f.admin,'create',{requestId:crypto.randomUUID(),direction:'pick',productId:p.id,quantity:7});assert.ok(result.taskId);
 const frames=f.wire.writes.filter(c=>c.includes(' display-frame '));assert.equal(frames.length,1);assert.equal(decode(frames[0]).length,4);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_guidance WHERE delivered=1').get().n,4);
});
test('native firmware validates the whole frame, latches once, and deduplicates retries',t=>{
 const compiler=process.env.CXX||'c++';try{execFileSync(compiler,['--version'],{stdio:'ignore'});}catch{t.skip('C++ compiler unavailable');return;}
 const folder=mkdtempSync(join(tmpdir(),'display-frame-native-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
 const frame=(request,commands)=>displayFrame('ESP32-01',request,commands.map(displayEntry)).command;
 const first=frame('0123456789abcdef',['to ESP32-01 text 1 "12" cyan 120 100 once','to ESP32-01 digit 2 "7" green 120 100','to ESP32-01 blink 3 green 100 5000','to ESP32-01 locate 4 red 100 300000']);
 const clear=frame('0123456789abcde0',['to ESP32-01 clear 1']);
 const invalid=frame('0123456789abcde1',['to ESP32-01 digit 1 "9" green 120 100','to ESP32-01 digit 5 "9" green 120 100']);
 const maximum=frame('0123456789abcde2',Array.from({length:64},(_,i)=>`to ESP32-01 text ${i+1} "${'X'.repeat(55)}" white 120 100`));
 const root=fileURLToPath(new URL('../',import.meta.url));writeFileSync(join(folder,'check.cpp'),`
#include <cassert>
#include "${root}firmware/esp32-simple-matrix/esp32-simple-matrix.ino"
void command(const char *input){char buffer[9216];strncpy(buffer,input,9215);buffer[9215]=0;RS485.output.clear();handleLine(buffer);}
int main(){setup();int initial=pixels.shows;
command(${JSON.stringify(first)});assert(pixels.shows==initial+1);assert(strcmp(modules[0].text,"12")==0);assert(modules[0].scrollOnce);assert(modules[1].mode==MODE_STATIC);assert(modules[2].testStartedAt==modules[3].locateStartedAt);assert(RS485.output.find("display-frame")!=std::string::npos);
command(${JSON.stringify(first)});assert(pixels.shows==initial+1);
command(${JSON.stringify(invalid)});assert(pixels.shows==initial+1);assert(strcmp(modules[0].text,"12")==0);assert(RS485.output.find("invalid-display-frame")!=std::string::npos);
command(${JSON.stringify(first.slice(0,-1)+(first.at(-1)==='0'?'1':'0'))});assert(pixels.shows==initial+1);
command(${JSON.stringify(first.replace('to ESP32-01','to OTHER'))});assert(pixels.shows==initial+1);
command(${JSON.stringify(clear)});assert(pixels.shows==initial+2);assert(modules[0].mode==MODE_IDLE);
command(${JSON.stringify(first)});assert(pixels.shows==initial+2);assert(modules[0].mode==MODE_IDLE);
usbMaintenance=true;command(${JSON.stringify(first)});assert(RS485.output.empty());usbMaintenance=false;
runtimeConfig.physicalCount=64;runtimeConfig.logicalCount=64;for(int i=0;i<64;i++)runtimeConfig.routing[i]=i+1;
delete pixelDriver;pixelDriver=new Adafruit_NeoPixel(4096,LED_PIN,NEO_GRB+NEO_KHZ800);command(${JSON.stringify(maximum)});assert(pixels.shows==1);assert(strlen(modules[63].text)==55);
return 0;}`);
 const binary=join(folder,'check');execFileSync(compiler,['-std=c++17','-I',join(root,'test/fixtures/esp32'),join(folder,'check.cpp'),'-o',binary]);execFileSync(binary,[]);
});


test('healthy framed calls bypass even an explicitly configured legacy inter-command delay',t=>{
 const wire=transport();wire.config.rs485InterCommandDelayMs=500;
 const adapter=createRs485Adapter({config:wire.config,logger});t.after(()=>adapter.dispose());
 adapter.checkControllerHealth({address:'TEST',controller_code:'TEST'});
 const original=Atomics.wait,waits=[];Atomics.wait=(...args)=>{waits.push(args[3]);return 'timed-out';};
 try{adapter.batch(()=>{for(const cell of cells)adapter.showCellQuantity(cell,7);});adapter.clearCellQuantity(cells[0]);}finally{Atomics.wait=original;}
 assert.ok(waits.every(ms=>ms<=1),JSON.stringify(waits));assert.equal(wire.writes.filter(c=>c.includes(' display-frame ')).length,2);
});
test('modern grouped ping uses the shared frame with the same confirmed delivery',t=>{
 const wire=transport(),adapter=createRs485Adapter({config:wire.config,logger});t.after(()=>adapter.dispose());
 const result=adapter.sendCellTests(cells);assert.equal(result.ok,true);const frames=wire.writes.filter(c=>c.includes(' display-frame '));assert.equal(frames.length,1);assert.equal(decode(frames[0]).length,4);assert.ok(result.events.every(e=>e.payload.confirmed));
});
test('failed work frames retain reservations and leave every output pending delivery',t=>{
 const f=fixture(t,{wrong:true}),p=f.db.prepare('SELECT id FROM products LIMIT 1').get();
 for(const c of f.cells)f.db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,2,0)').run(p.id,c.id);
 const result=f.work.command(f.admin,'create',{requestId:crypto.randomUUID(),direction:'pick',productId:p.id,quantity:7});assert.ok(result.taskId);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_guidance WHERE delivered=0').get().n,4);
 assert.equal(f.db.prepare("SELECT SUM(quantity) n FROM work_reservations WHERE state='held'").get().n,7);
});

test('one failed controller does not fail another controller in the same shared batch',t=>{
 const f=fixture(t,{wrong:'TEST'}),other=configureControllerModules(f.db,{controllerCode:'HEALTHY',controllerAddress:'HEALTHY',moduleCount:1,configuredBy:f.admin.id});
 f.db.prepare("UPDATE controllers SET heartbeat_status='online' WHERE id=?").run(other.id);f.db.prepare('UPDATE cells SET active=1 WHERE controller_id=?').run(other.id);
 const second=f.db.prepare('SELECT * FROM cells WHERE controller_id=?').get(other.id);
 const results=f.hardware.batchLedUpdates(()=>[f.hardware.showCellQuantity({...f.cells[0],controller_address:'TEST'},1),f.hardware.showCellQuantity({...second,controller_address:'HEALTHY'},2)]);
 assert.equal(results[0].ok,false);assert.equal(results[1].ok,true);
 assert.equal(f.wire.writes.filter(c=>c.startsWith('to TEST display-frame')).length,3);assert.equal(f.wire.writes.filter(c=>c.startsWith('to HEALTHY display-frame')).length,1);
});
test('background stocktake updates queued together use one controller frame',async t=>{
 const f=fixture(t,{deferStocktakeDisplays:true}),count=createStocktakingService({db:f.db,operationsService:f.work});
 const command=(action,input)=>count.command(f.admin,action,{requestId:crypto.randomUUID(),...input});
 const run=command('create',{mode:'selected',cellIds:f.cells.map(c=>c.id),counterIds:[f.admin.id]});command('start',{runId:run.runId});
 for(let i=0;i<100&&!f.wire.writes.some(c=>c.includes(' display-frame '));i++)await new Promise(resolve=>setTimeout(resolve,5));
 const frames=f.wire.writes.filter(c=>c.includes(' display-frame '));assert.equal(frames.length,1);assert.equal(decode(frames[0]).length,4);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM work_guidance WHERE delivered=1').get().n,4);
});
