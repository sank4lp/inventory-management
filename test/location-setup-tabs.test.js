import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {saveControllerProfile} from '../src/services/controller-profiles.js';
import {createHardwareService} from '../src/services/hardware.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {createLocationSetupService} from '../src/modules/locations/service.js';

function fixture(t,routing=[1,2,3,4]){
 const cwd=process.cwd(),folder=mkdtempSync(join(tmpdir(),'location-tabs-'));process.chdir(folder);
 const db=createDatabase({hashPassword,allowDemoInventorySeed:false}),admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
 const saved=configureControllerModules(db,{controllerCode:'SETUP-FOUR',controllerAddress:'SETUP-FOUR',moduleCount:4,configuredBy:admin.id});db.prepare("UPDATE controllers SET heartbeat_status='online' WHERE id=?").run(saved.id);
 const controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(saved.id);saveControllerProfile(db,controller,{physicalCount:4,logicalCount:4,routing:[...routing,...Array(60).fill(0)],revision:1});
 const logger={info(){},warn(){},error(){}};let time=new Date();const start=time.getTime();const hardware=createHardwareService({db,config:{hardwareAdapter:'simulator'},logger}),work=createOperationsService({db,hardwareService:hardware,logger}),display=createDisplayCoordinator({db,hardwareService:hardware,operationsService:work,clock:()=>time}),setup=createLocationSetupService({db,operationsService:work,displayCoordinator:display});
 const command=(action,input={})=>setup.command(admin,action,{requestId:randomUUID(),...input});const selected=()=>setup.snapshot(admin).sessions.find(s=>s.controller_id===controller.id);const request=()=>db.prepare('SELECT * FROM display_requests WHERE id=?').get(selected().display_id);const targets=()=>JSON.parse(request().targets_json);
 const bind=(name,extra={})=>{const s=selected();return command('bind',{sessionId:s.id,generation:s.generation,fieldSignature:setup.snapshot(admin).fieldSignature,displayName:name,qrLater:true,physicalConfirmed:true,...extra});};
 t.after(()=>{work.dispose();hardware.dispose();db.close();process.chdir(cwd);rmSync(folder,{recursive:true,force:true});});
 return {db,admin,controller,command,selected,request,targets,bind,display,hardware,setup,start,setTime:ms=>{time=new Date(start+ms);}};
}

test('four LEDs start at one and save-and-next lights the next tab without a second client request, wrapping to one',t=>{
 const f=fixture(t);const started=f.command('start',{controllerId:f.controller.id});assert.equal(started.lighting.ready,true);assert.equal(f.selected().output,1);assert.equal(f.selected().leds.length,4);
 assert.deepEqual(f.targets().map(target=>target.setupDisplay),['locate','dark','dark','dark']);
 for(let led=1;led<=4;led++){
  const old=f.selected().display_id,result=f.bind('Bin '+led);assert.equal(result.lighting.ready,true);assert.equal(f.selected().output,led===4?1:led+1);assert.equal(f.db.prepare('SELECT state FROM display_requests WHERE id=?').get(old).state,'stopped');assert.equal(f.targets().filter(target=>target.setupDisplay==='locate').length,1);assert.equal(f.targets().find(target=>target.setupDisplay==='locate').channel,led===4?1:led+1);
 }
 assert.equal(f.setup.snapshot(f.admin).cells.filter(cell=>cell.controller_id===f.controller.id&&cell.binding_verified_at).length,4);
 const selected=f.selected(),requestId=randomUUID(),before=f.db.prepare('SELECT COUNT(*) n FROM device_events').get().n;
 const input={requestId,sessionId:selected.id,generation:selected.generation,channel:3};f.setup.command(f.admin,'select',input);const sent=f.db.prepare('SELECT COUNT(*) n FROM device_events').get().n;assert.ok(sent>before);assert.equal(f.setup.command(f.admin,'select',input).replayed,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM device_events').get().n,sent);assert.equal(f.selected().output,3);
 assert.throws(()=>f.command('bind',{sessionId:selected.id,generation:selected.generation,displayName:'Stale',qrLater:true,physicalConfirmed:true}),/changed/);
});
test('fresh inactive LED entries supply the real revision during setup and become active only after saving',t=>{
 const f=fixture(t);f.command('start',{controllerId:f.controller.id});
 for(let channel=1;channel<=4;channel++){
  const snapshot=f.setup.snapshot(f.admin),session=f.selected();
  const inactive=snapshot.setupCells.find(cell=>cell.controller_id===f.controller.id&&cell.hardware_channel===channel);
  assert.ok(inactive,'New LED output must be available to the setup form');assert.equal(inactive.active,0);
  assert.ok(!snapshot.cells.some(cell=>cell.id===inactive.id),'Unfinished LED must stay out of ordinary locations');
  const form={sessionId:session.id,generation:String(session.generation),channel:String(channel),descriptionRevision:String(inactive.description_revision),fieldSignature:snapshot.fieldSignature,displayName:'Fresh Cell '+channel,warehouseName:'Warehouse One',travelInstructions:'Shelf One',qrLater:true,physicalConfirmed:true};
  f.command('bind',form);assert.equal(f.selected().output,channel===4?1:channel+1);
  const cell=f.setup.snapshot(f.admin).cells.find(cell=>cell.id===inactive.id);assert.equal(cell.active,1);assert.equal(cell.display_name,form.displayName);assert.ok(cell.binding_verified_at);
 }
 assert.equal(f.setup.snapshot(f.admin).setupCells.filter(cell=>cell.controller_id===f.controller.id).length,0);
});
test('physical LED tabs and yellow numbers follow verified routing, not the logical channel order',t=>{
 const f=fixture(t,[2,1,4,3]);f.command('start',{controllerId:f.controller.id});assert.equal(f.selected().output,2);assert.equal(f.selected().leds[0].physical,1);
 f.bind('Physical one');assert.equal(f.selected().output,1);
 f.command('display',{sessionId:f.selected().id,generation:f.selected().generation,mode:'numbers'});
 assert.deepEqual(f.targets().map(target=>[target.channel,target.value,target.color]),[[2,1,'yellow'],[1,2,'yellow'],[4,3,'yellow'],[3,4,'yellow']]);
 assert.throws(()=>f.bind('Unsafe while all numbers show'),/Select this LED/);
});
test('the selected LED flickers every 500 ms while other LED numbers remain yellow, and pause cancels further flashes',t=>{
 const f=fixture(t);f.command('start',{controllerId:f.controller.id});f.command('light',{sessionId:f.selected().id,generation:f.selected().generation,showNumbers:true});
 assert.equal(f.selected().show_numbers,1);assert.deepEqual(f.targets().map(target=>target.setupDisplay),['flash','number','number','number']);assert.deepEqual(f.targets().slice(1).map(target=>target.color),['yellow','yellow','yellow']);
 let before=f.db.prepare('SELECT COUNT(*) n FROM device_events').get().n;f.setTime(499);f.display.expire();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM device_events').get().n,before);
 f.setTime(500);f.display.expire();assert.equal(f.targets()[0].flashOn,false);let last=JSON.parse(f.db.prepare('SELECT payload FROM device_events ORDER BY id DESC LIMIT 1').get().payload);assert.equal(last.color,'#000000');assert.equal(last.hardwareChannel,1);
 f.setTime(1000);f.display.expire();assert.equal(f.targets()[0].flashOn,true);last=JSON.parse(f.db.prepare('SELECT payload FROM device_events ORDER BY id DESC LIMIT 1').get().payload);assert.equal(last.color,'red');assert.equal(last.pattern,'inward-ripple');
 f.command('pause',{sessionId:f.selected().id,generation:f.selected().generation});before=f.db.prepare('SELECT COUNT(*) n FROM device_events').get().n;f.setTime(2000);f.display.expire();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM device_events').get().n,before);assert.equal(f.selected().display_id,null);
});
test('all-LED locate and five-second green ping are exclusive views, and ping restores the prior view without reviving a stale selection',t=>{
 const f=fixture(t);f.command('start',{controllerId:f.controller.id});f.command('display',{sessionId:f.selected().id,generation:f.selected().generation,mode:'all'});assert.ok(f.targets().every(target=>target.setupDisplay==='locate'&&target.color==='red'));
 f.command('display',{sessionId:f.selected().id,generation:f.selected().generation,mode:'ping'});assert.ok(f.targets().every(target=>target.setupDisplay==='ping'&&target.color==='green'));const ping=f.request().id;
 f.setTime(5001);f.display.expire();assert.equal(f.selected().display_mode,'all');assert.notEqual(f.selected().display_id,ping);assert.ok(f.targets().every(target=>target.setupDisplay==='locate'));
 f.command('display',{sessionId:f.selected().id,generation:f.selected().generation,mode:'ping'});f.command('select',{sessionId:f.selected().id,generation:f.selected().generation,channel:4});const current=f.selected().display_id;f.setTime(11000);f.display.expire();assert.equal(f.selected().display_id,current);assert.equal(f.selected().output,4);assert.equal(f.selected().display_mode,'selected');
});
test('not-lighting remains unfinished, revisiting preloads its saved cell, and controller changes can restart the session without deleting cells',t=>{
 const f=fixture(t);f.command('start',{controllerId:f.controller.id});f.bind('Saved first');let current=f.selected();f.command('select',{sessionId:current.id,generation:current.generation,channel:1});current=f.selected();f.command('skip',{sessionId:current.id,generation:current.generation,reason:'Not lighting'});assert.equal(f.selected().output,2);assert.equal(f.setup.snapshot(f.admin).cells.find(cell=>cell.display_name==='Saved first').binding_verified_at,null);
 const old=f.selected();f.db.prepare("UPDATE controllers SET configured_at='changed' WHERE id=?").run(f.controller.id);assert.throws(()=>f.command('light',{sessionId:old.id,generation:old.generation}),/configuration changed/);
 const started=f.command('start',{controllerId:f.controller.id});assert.notEqual(started.sessionId,old.id);assert.ok(f.setup.snapshot(f.admin).cells.some(cell=>cell.display_name==='Saved first'));
});

test('a disconnected flickering LED stops rapid retries and cannot verify a cell until Re-Light succeeds',t=>{
 const f=fixture(t);f.command('start',{controllerId:f.controller.id});f.command('light',{sessionId:f.selected().id,generation:f.selected().generation,showNumbers:true});
 const send=f.hardware.showCellQuantity;let attempts=0;f.hardware.showCellQuantity=()=>{attempts++;return {ok:false,deliveryUnconfirmed:true};};
 f.setTime(500);f.display.expire();assert.equal(attempts,1);assert.equal(f.targets()[0].status,'unreachable');assert.equal(f.selected().lightReady,false);
 for(const time of [600,1000,1500]){f.setTime(time);f.display.expire();}assert.equal(attempts,1);assert.throws(()=>f.bind('Unconfirmed'),/Select this LED/);
 f.hardware.showCellQuantity=send;f.command('light',{sessionId:f.selected().id,generation:f.selected().generation});assert.equal(f.selected().lightReady,true);
});

test('an unfinished session from the earlier wizard upgrades its fingerprint without resetting saved LEDs or its selected output',t=>{
 const f=fixture(t);f.command('start',{controllerId:f.controller.id});f.bind('Before update');let current=f.selected();f.command('pause',{sessionId:current.id,generation:current.generation});
 const controller=f.db.prepare('SELECT * FROM controllers WHERE id=?').get(f.controller.id),legacy=JSON.stringify([controller.id,controller.address,controller.module_count,controller.configured_at]);f.db.prepare('UPDATE location_setup_sessions SET controller_snapshot=? WHERE id=?').run(legacy,current.id);
 f.command('start',{controllerId:controller.id});assert.equal(f.selected().id,current.id);assert.equal(f.selected().output,2);assert.ok(f.setup.snapshot(f.admin).cells.find(cell=>cell.display_name==='Before update').binding_verified_at);assert.equal(JSON.parse(f.selected().controller_snapshot).length,5);
 // Re-Light also works directly from an older displayed session without forcing a restart.
 f.db.prepare('UPDATE location_setup_sessions SET controller_snapshot=? WHERE id=?').run(legacy,current.id);current=f.selected();f.command('light',{sessionId:current.id,generation:current.generation});assert.equal(f.selected().lightReady,true);assert.ok(f.setup.snapshot(f.admin).cells.find(cell=>cell.display_name==='Before update').binding_verified_at);
 f.bind('After update');assert.equal(f.selected().output,3);
});
