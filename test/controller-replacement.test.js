import {createOperationsService} from '../src/modules/operations/service.js';
import {createHardwareService} from '../src/services/hardware.js';
import {guidanceBinding} from '../src/modules/operations/guidance.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {createFirmwareService} from '../src/services/firmware.js';
import {saveControllerProfile,loadControllerProfile,validateControllerConfiguration} from '../src/services/controller-profiles.js';
import {groupChecksum} from '../src/services/hardware-adapters/group-protocol.js';
import {ESP32_FIRMWARE_PROTOCOL} from '../src/services/firmware-constants.js';
import {resizedControllerProfile} from '../src/services/controller-layout.js';

const routing=Array.from({length:64},(_,i)=>[1,0,2,3][i]||0);
function response(address,request,actual) {
 const map=actual.routing.map(n=>n.toString(16).padStart(2,'0')).join('');
 const payload=`${address.toUpperCase()} config-status ${request} ${actual.revision.toString(16).padStart(8,'0')} ${actual.physicalCount} ${map} ${actual.fault?1:0}`;
 return {type:'controller-config',address,request,revision:actual.revision,physicalModules:actual.physicalCount,logicalModules:actual.logicalCount,routing:map,fault:!!actual.fault,checksum:groupChecksum(payload)};
}
function fixture(t,{missing=false,failUpload=false,failRestore=false,lostAck=false,badChecksum=false,profilelessLegacy=false,sameBoard=false,holdCompile=false,failRestoreOnce=false,chipIdentity=null,probeMatches=false,chipChanged=false,failCompile=false,loseSavedConfig=false,unreadableBeforeUpload=false}={}) {
 process.chdir(mkdtempSync(join(tmpdir(),'controller-replacement-')));
 const db=createDatabase({hashPassword,allowDemoInventorySeed:true});
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),operator=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 let controller=configureControllerModules(db,{controllerCode:'REPLACE-TEST',controllerAddress:'KEEP-ADDRESS',deviceIdentity:'OLD-USB',moduleCount:4,configuredBy:admin.id,firmwareVersion:profilelessLegacy?'simple-matrix-v13-rs485-addressed':ESP32_FIRMWARE_PROTOCOL});
 db.prepare("UPDATE cells SET active=1,display_name='Original '||id WHERE controller_id=?").run(controller.id);
 const cell=db.prepare('SELECT * FROM cells WHERE controller_id=? AND hardware_channel=1').get(controller.id),product=db.prepare('SELECT * FROM products LIMIT 1').get();
 db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,7,0)').run(product.id,cell.id);
 controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(controller.id);
 const desired={physicalCount:3,logicalCount:4,routing,revision:7};
 if(!missing&&!profilelessLegacy)saveControllerProfile(db,controller,desired);
 const commands=[],usb=[],backups=[],resumes=[];let resumeHook=null,releaseCompile;const compileGate=holdCompile?new Promise(resolve=>releaseCompile=resolve):null;let restoreAttempts=0;
 let actual=sameBoard?{...desired,fault:false}:{physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:false};
 const host={command:()=>process.execPath,support:()=>({simulated:false}),listDevices:()=>[{path:'/dev/test-esp32',deviceIdentity:sameBoard?'OLD-USB':'NEW-USB',recommended:true}],configureSerial:()=>({status:0}),
 async runFirmware(args){commands.push(args);if(args[0]==='compile'&&failCompile)throw new Error('Compiler missing fixture');if(args[0]==='compile'&&compileGate)await compileGate;if(args[0]==='upload'&&sameBoard)actual={physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:false};if(args[0]==='upload'&&failUpload)throw new Error('Upload failed.');return {simulated:false};}};
 let identityReads=0,identityFailure=false;if(chipIdentity)host.readChipIdentity=async()=>{identityReads++;if(identityFailure){identityFailure=false;throw new Error('Fixture USB identity failed');}if(loseSavedConfig&&identityReads===3)actual={physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:false};return chipChanged&&identityReads>1?'00:11:22:33:44:99':chipIdentity;};
 const service=createFirmwareService({db,config:{},logger:{info(){},warn(){},error(){}},backupService:{createCriticalBackup:args=>backups.push(args)},hostAdapter:host,
 onMaintenanceReleased:id=>{resumes.push({id,busy:!!db.prepare("SELECT 1 FROM app_metadata WHERE key='firmware_busy'").get()});resumeHook?.(id);},
 serialSessionFactory:()=>({async exchange(command,accept){
  usb.push(command);const tokens=command.split(' ');
  let reply;
  if(tokens[2]==='config-status') {if(unreadableBeforeUpload&&!commands.some(args=>args[0]==='upload'))throw new Error('Controller USB confirmation timed out.');if(chipIdentity&&tokens[1]==='KEEP-ADDRESS'&&!probeMatches)throw new Error('Controller USB confirmation timed out.');reply=response(tokens[1],tokens[3],actual);if(badChecksum)reply.checksum='00000000';}
  else if(tokens[2]==='configure') {
   restoreAttempts++;if(!failRestore&&!(failRestoreOnce&&restoreAttempts===1)){const map=tokens[6].match(/../g).map(n=>parseInt(n,16));actual={physicalCount:Number(tokens[5]),logicalCount:map.findLastIndex(n=>n>0)+1,routing:map,revision:parseInt(tokens[4],16)+1,fault:false};}
   if(lostAck)throw new Error('ACK lost.');
   reply={type:'ack',command:'configure',address:tokens[1],request:tokens[3]};
  }
  if(!accept(reply))throw new Error('Response did not match.');return reply;
 },close(){}})});
 t.after(()=>db.close());
 const input={replacement_controller_id:String(controller.id),replacement_confirmed:'1',port:'/dev/test-esp32',device_identity:sameBoard?'OLD-USB':'NEW-USB'};
 const snapshot=()=>JSON.stringify({cells:db.prepare('SELECT * FROM cells ORDER BY id').all(),stock:db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id,product_id').all(),ledger:db.prepare('SELECT * FROM transactions ORDER BY id').all()});
 const start=()=>service.startFlashJob(input,admin);
 async function finish(job){for(let i=0;i<200;i++){const current=service.getJob(job.id);if(current.status!=='running')return current;await wait(5);}throw new Error('Test job did not finish.');}
 return {db,service,admin,operator,controller,input,start,finish,commands,usb,backups,resumes,cell,product,releaseCompile,failNextIdentity(){identityFailure=true;},setResumeHook(fn){resumeHook=fn;},snapshot,setActual(value){actual=value;},setChipIdentity(value){chipIdentity=value;identityReads=0;}};
}

test('three different ESP32s sharing one USB serial can be added without overwriting any controller or locations',async t=>{
 const f=fixture(t,{chipIdentity:'00:11:22:33:44:01'}),before=f.snapshot(),ids=[];
 for(let n=1;n<=3;n++){
  f.setChipIdentity('00:11:22:33:44:0'+n);f.setActual({physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:false});
  const job=await f.finish(f.service.startFlashJob({...freshInput(f),controller_name:'NEW-'+n,controller_address:'NEW-ADDR-'+n},f.admin));
  assert.equal(job.status,'completed',JSON.stringify(job));ids.push(job.controllerId);
  assert.equal(f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get('controller_chip_identity:'+job.controllerId).value,'00:11:22:33:44:0'+n);
 }
 assert.equal(new Set(ids).size,3);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM controllers WHERE device_identity='NEW-USB'").get().n,3);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cells WHERE controller_id=?').get(f.controller.id).n,4);
 assert.ok(before.includes('Original '));assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(f.cell.id).available_quantity,7);
 const uploads=f.commands.filter(args=>args[0]==='upload').length;f.setChipIdentity('00:11:22:33:44:02');
 const repeated=await f.finish(f.service.startFlashJob({...freshInput(f),controller_name:'SHOULD-NOT-ADD'},f.admin));
 assert.equal(repeated.status,'failed');assert.match(repeated.error,/already registered as NEW-2/);assert.equal(f.commands.filter(args=>args[0]==='upload').length,uploads);
});
for(const confirmed of [false,true])test(`legacy shared USB requires explicit different-board confirmation (${confirmed})`,async t=>{
 const f=fixture(t,{chipIdentity:'00:11:22:33:44:01'});f.db.prepare("UPDATE controllers SET device_identity='NEW-USB' WHERE id=?").run(f.controller.id);
 const job=await f.finish(f.service.startFlashJob({...freshInput(f),shared_usb_confirmed:confirmed?'1':''},f.admin));
 assert.equal(job.status,confirmed?'completed':'failed',JSON.stringify(job));if(!confirmed){assert.match(job.error,/Confirm that you connected a different ESP32/);assert.equal(f.commands.length,0);}
});
test('a registered legacy controller responding at its saved address cannot be reset as a new controller',async t=>{
 const f=fixture(t,{chipIdentity:'00:11:22:33:44:01',probeMatches:true});f.db.prepare("UPDATE controllers SET device_identity='NEW-USB' WHERE id=?").run(f.controller.id);
 const before=f.snapshot(),job=await f.finish(f.service.startFlashJob({...freshInput(f),shared_usb_confirmed:'1'},f.admin));
 assert.equal(job.status,'failed');assert.match(job.error,/already registered as REPLACE-TEST/);assert.equal(f.commands.length,0);assert.equal(f.snapshot(),before);
});
test('changing ESP32s in the same USB port during compilation is refused before upload',async t=>{
 const f=fixture(t,{chipIdentity:'00:11:22:33:44:01',chipChanged:true});
 const job=await f.finish(f.service.startFlashJob(freshInput(f),f.admin));assert.equal(job.status,'failed');assert.match(job.error,/changed while compiling/);assert.ok(!f.commands.some(args=>args[0]==='upload'));
});

test('replacement preserves controller identity, every cell and stock entry, and restores a route with a gap',async t=>{
 const f=fixture(t),before=f.snapshot(),job=await f.finish(f.start());
 assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.configurationVerified,true);
 assert.equal(job.physicalModuleCount,3);assert.deepEqual(job.assignedModules,[1,3,4]);
 assert.equal(job.controllerId,f.controller.id);assert.equal(job.controllerAddress,'KEEP-ADDRESS');
 assert.equal(f.snapshot(),before);
 const current=f.db.prepare('SELECT * FROM controllers WHERE id=?').get(f.controller.id);
 assert.equal(current.device_identity,'NEW-USB');assert.equal(current.heartbeat_status,'offline');
 const restored=loadControllerProfile(f.db,current);assert.deepEqual(restored.routing,routing);assert.equal(restored.physicalCount,3);
 assert.ok(f.commands[0].includes('--build-property'));assert.ok(f.commands[0].some(s=>s.includes('-DLED_MODULE_COUNT=0')));
 assert.ok(f.usb.some(s=>s.includes(' configure ')));assert.ok(f.backups.some(b=>b.source.startsWith('before-controller-replacement')));
 assert.equal(f.db.prepare("SELECT 1 FROM app_metadata WHERE key='firmware_busy'").get(),undefined);
});
for(const lostAck of [true,false])test(`replacement readback decides success when ACK is ${lostAck?'lost':'present'}`,async t=>{
 const f=fixture(t,{lostAck}),job=await f.finish(f.start());assert.equal(job.status,'completed');assert.equal(job.configurationVerified,true);
});
for(const option of ['failUpload','failRestore','badChecksum'])test(`${option} cannot replace device identity or change cells`,async t=>{
 const f=fixture(t,{[option]:true}),before=f.snapshot(),job=await f.finish(f.start());
 assert.equal(job.status,'failed');assert.equal(f.snapshot(),before);
 assert.equal(f.db.prepare('SELECT device_identity FROM controllers WHERE id=?').get(f.controller.id).device_identity,'OLD-USB');
 assert.ok(f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(`controller_replacement_pending:${f.controller.id}`));
});
test('missing backup, lost confirmation, wrong role and changed USB selection are refused before upload',t=>{
 const f=fixture(t,{missing:true});assert.throws(()=>f.start(),/No verified controller backup/);assert.equal(f.commands.length,0);
 assert.throws(()=>f.service.startFlashJob(f.input,f.operator),/not permitted/);
 saveControllerProfile(f.db,f.controller,{physicalCount:3,logicalCount:4,routing,revision:7});
 assert.throws(()=>f.service.startFlashJob({...f.input,replacement_confirmed:''},f.admin),/Confirm/);
 assert.throws(()=>f.service.startFlashJob({...f.input,device_identity:'OTHER'},f.admin),/changed/);
});
test('older fixed-routing firmware can be replaced from its known count without a live old board',async t=>{
 const f=fixture(t,{profilelessLegacy:true}),job=await f.finish(f.start());assert.equal(job.status,'completed');
 const profile=loadControllerProfile(f.db,f.db.prepare('SELECT * FROM controllers WHERE id=?').get(f.controller.id));
 assert.deepEqual(profile.routing,Array.from({length:64},(_,i)=>i<4?i+1:0));assert.ok(profile.verifiedAt);
});
test('connected original can be backed up; corrupted saved routing is rejected',async t=>{
 const f=fixture(t,{missing:true});f.setActual({physicalCount:3,logicalCount:4,routing,revision:7,fault:false});
 const result=await f.service.backupController(f.input,f.admin);assert.equal(result.profile.physicalCount,3);
 assert.equal(f.commands.length,0);
 const profile=JSON.parse(f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(`controller_profile:${f.controller.id}`).value);
 [profile.routing[0],profile.routing[2]]=[profile.routing[2],profile.routing[0]];
 f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(JSON.stringify(profile),`controller_profile:${f.controller.id}`);
 assert.throws(()=>loadControllerProfile(f.db,f.controller),/checksum/);
});
test('configuration responses bind nonce, address, fault and all route fields to checksum',()=>{
 const reply=response('ESP32-01','0123456789abcdef',{physicalCount:3,logicalCount:4,routing,revision:7,fault:false});
 assert.deepEqual(validateControllerConfiguration(reply,'ESP32-01','0123456789abcdef').routing,routing);
 for(const change of [{request:'bad'},{address:'OTHER'},{fault:true},{physicalModules:4},{checksum:'00000000'}])assert.throws(()=>validateControllerConfiguration({...reply,...change},'ESP32-01','0123456789abcdef'));
});


test('new provisioning also saves a verified host-side backup for future replacement',async t=>{
 const f=fixture(t),identity=Array.from({length:64},(_,i)=>i<4?i+1:0);
 f.setActual({physicalCount:4,logicalCount:4,routing:identity,revision:0,fault:false});
 const job=await f.finish(f.service.startFlashJob({port:f.input.port,device_identity:f.input.device_identity,controller_name:'NEW-TEST',controller_address:'FRESH-ADDR',module_count:'4'},f.admin));
 assert.equal(job.status,'completed',JSON.stringify(job));
 const controller=f.db.prepare('SELECT * FROM controllers WHERE id=?').get(job.controllerId);
 assert.deepEqual(loadControllerProfile(f.db,controller).routing,identity);
 assert.equal(f.db.prepare('SELECT device_identity FROM controllers WHERE id=?').get(f.controller.id).device_identity,'OLD-USB');
});
function freshInput(f){return {port:f.input.port,device_identity:f.input.device_identity,controller_name:'FRESH-TEST',controller_address:'FRESH-ADDR',module_count:'4',controller_setup_mode:'fresh',fresh_setup_confirmed:'1'};}
for(const fault of [false,true])test(`confirmed fresh setup replaces a reused board's ${fault?'faulted':'different healthy'} LED setup only after verified readback`,async t=>{
 const f=fixture(t),before=f.snapshot(),oldProfile=loadControllerProfile(f.db,f.controller);
 f.setActual(fault?{physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:true}:{physicalCount:3,logicalCount:4,routing,revision:7,fault:false});
 const job=await f.finish(f.service.startFlashJob(freshInput(f),f.admin));
 assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.freshSetup,true);assert.equal(job.configurationVerified,true);
 assert.ok(f.commands[0].some(s=>s.includes('-DLED_MODULE_COUNT=0')),'fresh boards start with outputs disabled');
 const write=f.usb.find(s=>s.includes(' configure '));assert.ok(write);
 const parts=write.split(' ');assert.equal(parts[1],'FRESH-ADDR');assert.equal(parts[4],fault?'00000000':'00000007');assert.equal(parts[5],'4');
 assert.equal(parts[6],Array.from({length:64},(_,i)=>(i<4?i+1:0).toString(16).padStart(2,'0')).join(''));
 const current=f.db.prepare('SELECT * FROM controllers WHERE id=?').get(job.controllerId);
 assert.equal(loadControllerProfile(f.db,current).physicalCount,4);assert.equal(current.device_identity,'NEW-USB');
 assert.deepEqual(loadControllerProfile(f.db,f.controller),oldProfile);
 assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=? AND product_id=?').get(f.cell.id,f.product.id).available_quantity,7);
 assert.equal(f.db.prepare('SELECT device_identity FROM controllers WHERE id=?').get(f.controller.id).device_identity,'OLD-USB');
});
test('fresh setup requires its own confirmation and cannot reset an already registered ESP32 or replace a controller implicitly',t=>{
 const f=fixture(t);
 assert.throws(()=>f.service.startFlashJob({...freshInput(f),fresh_setup_confirmed:''},f.admin),/Confirm/);
 assert.throws(()=>f.service.startFlashJob({...freshInput(f),replacement_controller_id:String(f.controller.id)},f.admin),/Fresh setup cannot/);
 assert.throws(()=>f.service.startFlashJob({...freshInput(f),controller_setup_mode:'keep'},f.admin),/supported/);
 assert.throws(()=>f.service.startFlashJob(freshInput(f),f.operator),/not permitted/);
 f.db.prepare('UPDATE controllers SET device_identity=? WHERE id=?').run('NEW-USB',f.controller.id);
 assert.throws(()=>f.service.startFlashJob(freshInput(f),f.admin),/already registered here/);
 assert.equal(f.commands.length,0);assert.equal(f.usb.length,0);
});
test('legacy new-controller calls cannot silently replace a faulted saved configuration',async t=>{
 const f=fixture(t);f.setActual({physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:true});
 const {controller_setup_mode,fresh_setup_confirmed,...input}=freshInput(f);
 const job=await f.finish(f.service.startFlashJob(input,f.admin));assert.equal(job.status,'failed');assert.match(job.error,/Set up as fresh controller/);
 assert.equal(f.usb.some(s=>s.includes(' configure ')),false);assert.equal(f.db.prepare("SELECT id FROM controllers WHERE controller_code='FRESH-TEST'").get(),undefined);
});
for(const option of ['badChecksum','failRestore'])test(`fresh setup ${option} refuses registration and preserves existing warehouse records`,async t=>{
 const f=fixture(t,{[option]:true}),before=f.snapshot();f.setActual({physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:true});
 const job=await f.finish(f.service.startFlashJob(freshInput(f),f.admin));assert.equal(job.status,'failed');assert.equal(f.snapshot(),before);
 assert.equal(f.db.prepare("SELECT id FROM controllers WHERE controller_code='FRESH-TEST'").get(),undefined);
 if(option==='badChecksum')assert.equal(f.usb.some(s=>s.includes(' configure ')),false);
});
test('fresh setup verifies the applied configuration after a lost acknowledgement',async t=>{
 const f=fixture(t,{lostAck:true});f.setActual({physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:true});
 const job=await f.finish(f.service.startFlashJob(freshInput(f),f.admin));assert.equal(job.status,'completed',JSON.stringify(job));assert.ok(job.logs.some(row=>row.line.includes('Setup confirmation missing')));
});
test('a running replacement excludes another flash or backup operation',async t=>{
 const f=fixture(t),job=f.start();
 assert.throws(()=>f.start(),/maintenance/);
 await assert.rejects(()=>f.service.backupController(f.input,f.admin),/maintenance/);
 assert.equal((await f.finish(job)).status,'completed');
});

function existingWork(f){
 const hardware=createHardwareService({db:f.db,config:{hardwareAdapter:'simulator'},logger:{info(){},warn(){},error(){},debug(){}}});
 const work=createOperationsService({db:f.db,hardwareService:hardware});
 f.db.prepare("UPDATE controllers SET heartbeat_status='online' WHERE id=?").run(f.controller.id);
 const cmd=(action,input={})=>work.command(f.admin,action,{requestId:crypto.randomUUID(),...input});
 const started=cmd('create',{direction:'pick',productId:f.product.id,quantity:2,plan_cell_id:f.cell.id}),line=work.task(f.admin,started.taskId).lines[0];
 cmd('acquire',{lineId:line.id,revision:line.revision,location:line.logical_code,deviceId:'existing-work'});
 const queued=cmd('create',{direction:'pick',productId:f.product.id,quantity:1,plan_cell_id:f.cell.id});
 cmd('manual',{productId:f.product.id,cellId:f.cell.id,direction:'pick',quantity:1,unit:f.product.unit_of_measure,performerId:'unknown',reason:'Earlier entry waiting for verification'});
 f.setResumeHook(id=>work.flushGuidance({restoreCells:f.db.prepare('SELECT id FROM cells WHERE controller_id=?').all(id).map(c=>c.id)}));
 const snapshot=()=>JSON.stringify(Object.fromEntries(['tasks','task_lines','work_reservations','work_reports','work_settlements','cell_turns','work_instruction_history','inventory_balances','transactions','cells'].map(table=>[table,f.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])));
 return {work,hardware,cmd,started,queued,line,snapshot};
}
test('same-board update preserves active and queued tasks, pending evidence and binding; pauses and restores guidance',async t=>{
 const f=fixture(t,{sameBoard:true,holdCompile:true}),w=existingWork(f),before=w.snapshot(),binding=guidanceBinding(f.db,f.cell.id);
 const job=f.start();assert.equal(job.preservesTasks,true);assert.ok(f.db.prepare("SELECT 1 FROM app_metadata WHERE key='firmware_busy'").get());
 assert.match(w.work.task(f.admin,w.started.taskId).lines[0].guidance.message,/maintenance/);
 assert.throws(()=>w.cmd('create',{direction:'pick',productId:f.product.id,quantity:1}),/maintenance/);
 assert.equal(w.snapshot(),before);f.releaseCompile();const result=await f.finish(job);assert.equal(result.status,'completed',JSON.stringify(result));
 assert.equal(w.snapshot(),before);assert.equal(guidanceBinding(f.db,f.cell.id),binding);assert.equal(f.resumes.at(-1).busy,false);
 assert.equal(f.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get('controller_firmware_hold:'+f.controller.id),undefined);
 assert.equal(f.db.prepare('SELECT delivered FROM work_guidance WHERE cell_id=?').get(f.cell.id).delivered,1,JSON.stringify(f.db.prepare('SELECT * FROM device_events ORDER BY id DESC LIMIT 5').all()));
 assert.equal(w.work.task(f.admin,w.started.taskId).lines[0].execution_state,'working');assert.equal(w.work.task(f.admin,w.queued.taskId).lines[0].execution_state,'ready');
});
test('same-board setup backup is allowed with unfinished tasks and does not change their identities',async t=>{
 const f=fixture(t,{sameBoard:true}),w=existingWork(f),before=w.snapshot(),binding=guidanceBinding(f.db,f.cell.id);
 const result=await f.service.backupController(f.input,f.admin);assert.equal(result.profile.physicalCount,3);assert.equal(w.snapshot(),before);assert.equal(guidanceBinding(f.db,f.cell.id),binding);assert.equal(f.resumes.at(-1).busy,false);
 const previous=loadControllerProfile(f.db,f.controller);f.setActual({physicalCount:4,logicalCount:4,routing:Array.from({length:64},(_,i)=>i<4?i+1:0),revision:8,fault:false});
 await assert.rejects(()=>f.service.backupController(f.input,f.admin),/count or order changed/);assert.deepEqual(loadControllerProfile(f.db,f.controller),previous);
});
test('a different board or changed requested count cannot use the in-place exception',t=>{
 const f=fixture(t),w=existingWork(f),before=w.snapshot();assert.throws(()=>f.start(),e=>e.code==='OUTSTANDING_WORK');assert.equal(f.commands.length,0);assert.equal(w.snapshot(),before);
});
test('in-place update rejects a count change or unexpected saved order before uploading',async t=>{
 const f=fixture(t,{sameBoard:true}),w=existingWork(f),before=w.snapshot();assert.throws(()=>f.service.startFlashJob({...f.input,module_count:4},f.admin),/Confirm the new LED count/);
 f.setActual({physicalCount:3,logicalCount:4,routing:[2,0,1,3,...Array(60).fill(0)],revision:8,fault:false});const result=await f.finish(f.start());assert.equal(result.status,'failed');assert.match(result.error,/count or order differs/);assert.equal(f.commands.length,0);assert.equal(w.snapshot(),before);
 assert.equal(f.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get('controller_firmware_hold:'+f.controller.id),undefined);
});
test('unverified update leaves tasks intact and lights held; retry can restore the saved profile after an interrupted upload',async t=>{
 const f=fixture(t,{sameBoard:true,failRestoreOnce:true}),w=existingWork(f),before=w.snapshot();
 const first=await f.finish(f.start());assert.equal(first.status,'failed');assert.equal(w.snapshot(),before);assert.equal(w.hardware.ensureControllerReady(f.controller.id).ok,false);
 assert.match(w.work.task(f.admin,w.started.taskId).lines[0].guidance.message,/not yet verified/);
 const retried=await f.finish(f.start());assert.equal(retried.status,'completed',JSON.stringify(retried));assert.equal(w.snapshot(),before);assert.equal(w.hardware.ensureControllerReady(f.controller.id).ok,true);
});


test('confirmed replacement transfers existing work to the new physical board without changing task bindings',async t=>{
 const f=fixture(t,{holdCompile:true}),w=existingWork(f),before=w.snapshot(),binding=guidanceBinding(f.db,f.cell.id);
 assert.throws(()=>f.start(),e=>e.code==='OUTSTANDING_WORK');
 const job=f.service.startFlashJob({...f.input,keep_existing_work:'1'},f.admin);
 assert.equal(job.preservesTasks,true);assert.equal(w.snapshot(),before);
 assert.match(w.work.task(f.admin,w.started.taskId).lines[0].guidance.message,/maintenance/);
 f.releaseCompile();const result=await f.finish(job);assert.equal(result.status,'completed',JSON.stringify(result));
 assert.equal(w.snapshot(),before);assert.equal(guidanceBinding(f.db,f.cell.id),binding);
 assert.equal(f.db.prepare('SELECT device_identity FROM controllers WHERE id=?').get(f.controller.id).device_identity,'NEW-USB');
 assert.deepEqual(loadControllerProfile(f.db,f.db.prepare('SELECT * FROM controllers WHERE id=?').get(f.controller.id)).routing,routing);
 assert.equal(w.work.task(f.admin,w.started.taskId).lines[0].execution_state,'working');
 assert.equal(f.db.prepare('SELECT delivered FROM work_guidance WHERE cell_id=?').get(f.cell.id).delivered,1);
});
test('keeping work still requires a verified profile, unchanged count, confirmation and permissions',t=>{
 const f=fixture(t),w=existingWork(f),before=w.snapshot();
 for(const override of [{replacement_confirmed:''},{module_count:4},{device_identity:'OTHER'}])assert.throws(()=>f.service.startFlashJob({...f.input,keep_existing_work:'1',...override},f.admin));
 assert.throws(()=>f.service.startFlashJob({...f.input,keep_existing_work:'1'},f.operator),/not permitted/);
 assert.throws(()=>f.service.startFlashJob({port:f.input.port,device_identity:f.input.device_identity,controller_name:'NEW-WORK-TEST',module_count:4,keep_existing_work:'1'},f.admin),e=>e.code==='OUTSTANDING_WORK');
 assert.equal(f.commands.length,0);assert.equal(w.snapshot(),before);
});
test('failed preserved replacement retains tasks and original identity until verified retry succeeds',async t=>{
 const f=fixture(t,{failRestoreOnce:true}),w=existingWork(f),before=w.snapshot();
 const start=()=>f.service.startFlashJob({...f.input,keep_existing_work:'1'},f.admin);
 assert.equal((await f.finish(start())).status,'failed');assert.equal(w.snapshot(),before);
 assert.equal(f.db.prepare('SELECT device_identity FROM controllers WHERE id=?').get(f.controller.id).device_identity,'OLD-USB');
 assert.equal(w.hardware.ensureControllerReady(f.controller.id).ok,false);
 assert.equal((await f.finish(start())).status,'completed');assert.equal(w.snapshot(),before);
 assert.equal(f.db.prepare('SELECT device_identity FROM controllers WHERE id=?').get(f.controller.id).device_identity,'NEW-USB');
});

function sequentialProfile(f,count=4){
 const profile={physicalCount:count,logicalCount:count,routing:Array.from({length:64},(_,i)=>i<count?i+1:0),revision:4};
 saveControllerProfile(f.db,f.controller,profile);f.setActual({...profile,fault:false});return profile;
}
test('increasing LED count preserves names, QR identities and stock and creates only new unassigned outputs',async t=>{
 const f=fixture(t,{sameBoard:true}),profile=sequentialProfile(f),cells=f.db.prepare('SELECT * FROM cells WHERE controller_id=? ORDER BY id').all(f.controller.id);
 const job=await f.finish(f.service.startFlashJob({...f.input,module_count:6,layout_change_confirmed:'1'},f.admin));
 assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.physicalModuleCount,6);
 const current=f.db.prepare('SELECT * FROM controllers WHERE id=?').get(f.controller.id);
 assert.equal(current.module_count,6);assert.deepEqual(loadControllerProfile(f.db,current).routing.slice(0,6),[1,2,3,4,5,6]);
 assert.deepEqual(f.db.prepare('SELECT * FROM cells WHERE controller_id=? AND hardware_channel<=4 ORDER BY id').all(f.controller.id),cells);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cells WHERE controller_id=? AND hardware_channel>4 AND active=0').get(f.controller.id).n,2);
 assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(f.cell.id).available_quantity,7);
 assert.equal(job.layoutChanged,true);assert.equal(profile.physicalCount,4);
});
test('reducing LED count removes only unused tail outputs and refuses named, stocked or historical locations',async t=>{
 const f=fixture(t,{sameBoard:true});sequentialProfile(f);
 const input={...f.input,module_count:2,layout_change_confirmed:'1'};
 assert.throws(()=>f.service.startFlashJob(input,f.admin),/Move its stock and unmap/);assert.equal(f.commands.length,0);
 f.db.prepare('UPDATE cells SET active=0,display_name=NULL WHERE controller_id=? AND hardware_channel>2').run(f.controller.id);
 const job=await f.finish(f.service.startFlashJob(input,f.admin));assert.equal(job.status,'completed',JSON.stringify(job));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cells WHERE controller_id=?').get(f.controller.id).n,2);
 assert.equal(f.db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(f.cell.id).available_quantity,7);
});
test('count changes require confirmation, legal range and no outstanding work, including when keeping tasks',t=>{
 const f=fixture(t,{sameBoard:true});sequentialProfile(f);
 for(const n of [0,-1,65,1.5,'four'])assert.throws(()=>f.service.startFlashJob({...f.input,module_count:n,layout_change_confirmed:'1'},f.admin),/whole number/);
 assert.throws(()=>f.service.startFlashJob({...f.input,module_count:8},f.admin),/Confirm the new LED count/);
 existingWork(f);assert.throws(()=>f.service.startFlashJob({...f.input,module_count:8,layout_change_confirmed:'1',keep_existing_work:'1'},f.admin),e=>e.code==='OUTSTANDING_WORK');assert.equal(f.commands.length,0);
});
test('logical gaps and stable mappings survive appending LEDs; configured slots are not reused',t=>{
 const f=fixture(t);f.db.prepare('UPDATE cells SET active=0 WHERE controller_id=? AND hardware_channel=2').run(f.controller.id);
 const result=resizedControllerProfile(f.db,f.controller,loadControllerProfile(f.db,f.controller),5);
 assert.deepEqual(result.routing.slice(0,6),[1,0,2,3,4,5]);assert.equal(result.logicalCount,6);
});
test('same bridge serial cannot disguise a different chip during an explicit firmware update',async t=>{
 const f=fixture(t,{sameBoard:true,chipIdentity:'00:11:22:33:44:02',probeMatches:true}),before=f.snapshot();
 f.db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?)').run('controller_chip_identity:'+f.controller.id,'00:11:22:33:44:01',new Date().toISOString());
 const job=await f.finish(f.service.startFlashJob({...f.input,maintenance_action:'update'},f.admin));
 assert.equal(job.status,'failed');assert.match(job.error,/different ESP32/);assert.equal(f.commands.length,0);assert.equal(f.snapshot(),before);
 assert.equal(f.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get('controller_firmware_hold:'+f.controller.id),undefined);
});
test('explicit replacement refuses the original chip and refuses a chip owned by another controller',async t=>{
 const f=fixture(t,{chipIdentity:'00:11:22:33:44:01',probeMatches:true});
 f.db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?)').run('controller_chip_identity:'+f.controller.id,'00:11:22:33:44:01',new Date().toISOString());
 let job=await f.finish(f.service.startFlashJob({...f.input,maintenance_action:'replace'},f.admin));assert.equal(job.status,'failed');assert.match(job.error,/original ESP32/);
 const other=f.db.prepare('SELECT id FROM controllers WHERE id!=? LIMIT 1').get(f.controller.id);
 f.db.prepare('UPDATE controllers SET active=1 WHERE id=?').run(other.id);
 f.db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?)').run('controller_chip_identity:'+other.id,'00:11:22:33:44:02',new Date().toISOString());f.setChipIdentity('00:11:22:33:44:02');
 job=await f.finish(f.service.startFlashJob({...f.input,maintenance_action:'replace'},f.admin));assert.equal(job.status,'failed');assert.match(job.error,/already registered/);assert.equal(f.commands.length,0);
});
test('a compile failure releases the controller without holding its lights; failed jobs remain available after reopening',async t=>{
 const f=fixture(t,{sameBoard:true,failCompile:true}),before=f.snapshot();
 const job=await f.finish(f.start());assert.equal(job.status,'failed');assert.match(job.recoveryHint,/Nothing was uploaded/);assert.equal(f.commands.length,1);assert.equal(f.snapshot(),before);
 assert.equal(f.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get('controller_firmware_hold:'+f.controller.id),undefined);
 const reopened=createFirmwareService({db:f.db,logger:{}});assert.deepEqual(reopened.getJob(job.id),job);
});
test('a faulted original ESP32 can recover from its verified warehouse profile',async t=>{
 const f=fixture(t,{sameBoard:true});f.setActual({physicalCount:0,logicalCount:0,routing:Array(64).fill(0),revision:0,fault:true});
 const job=await f.finish(f.start());assert.equal(job.status,'completed',JSON.stringify(job));assert.ok(job.logs.some(row=>row.line.includes('saved-setup fault')));
});
test('registration and profile metadata commit atomically after USB verification',async t=>{
 const f=fixture(t),before=f.snapshot(),count=f.db.prepare('SELECT COUNT(*) n FROM controllers').get().n;
 f.db.exec("CREATE TRIGGER fail_firmware_metadata BEFORE INSERT ON app_metadata WHEN NEW.key='firmware_matrix_devices' BEGIN SELECT RAISE(ABORT,'test disk write failure'); END");
 const job=await f.finish(f.service.startFlashJob(freshInput(f),f.admin));assert.equal(job.status,'failed');assert.match(job.error,/test disk write failure/);
 assert.equal(f.snapshot(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM controllers').get().n,count);assert.equal(f.db.prepare("SELECT 1 FROM app_metadata WHERE key LIKE 'controller_profile:%' AND value LIKE '%FRESH-TEST%'").get(),undefined);
});
test('maximum supported count verifies all 64 outputs without affecting other controllers',async t=>{
 const f=fixture(t),job=await f.finish(f.service.startFlashJob({...freshInput(f),module_count:64},f.admin));assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.assignedModules.length,64);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cells WHERE controller_id=?').get(job.controllerId).n,64);
});
test('a running job is exposed after navigation and cannot be started twice',async t=>{
 const f=fixture(t,{holdCompile:true}),job=f.start();
 assert.equal(f.service.getFlashOptions().activeJob.id,job.id);assert.equal(f.service.getJob(job.id).status,'running');assert.throws(()=>f.start(),/maintenance/);
 f.releaseCompile();assert.equal((await f.finish(job)).status,'completed');assert.equal(f.service.getFlashOptions().activeJob,null);
});


test('post-reset verification refuses a controller that did not retain its saved setup',async t=>{
 const f=fixture(t,{chipIdentity:'00:11:22:33:44:01',loseSavedConfig:true}),before=f.snapshot();
 const job=await f.finish(f.service.startFlashJob(freshInput(f),f.admin));assert.equal(job.status,'failed');assert.match(job.error,/did not keep its LED setup/);assert.equal(f.snapshot(),before);
});
test('interrupted uploads keep recovery holds across retries that fail before a new upload',async t=>{
 const f=fixture(t,{sameBoard:true,failRestoreOnce:true,chipIdentity:'00:11:22:33:44:01',probeMatches:true}),first=await f.finish(f.start());assert.equal(first.status,'failed');
 f.failNextIdentity();const second=await f.finish(f.start());assert.equal(second.status,'failed');assert.match(second.error,/Fixture USB identity failed/);
 // A failed pre-upload ROM check on the next try must not erase uncertainty
 // from the previous upload, even though this retry never reached uploading.
 f.db.prepare("UPDATE controllers SET firmware_version='simple-matrix-v15-rs485-addressed' WHERE id=?").run(f.controller.id);
 const original=f.service.getJob(first.id);assert.equal(original.status,'failed');
 const pending=JSON.parse(f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get('controller_replacement_pending:'+f.controller.id).value);assert.equal(pending.uploadStarted,true);
 const key='firmware_job:interrupted-test';f.db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?)').run(key,JSON.stringify({id:'interrupted-test',status:'running'}),new Date().toISOString());
 f.db.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('firmware_busy',?,?)").run('interrupted-test',new Date().toISOString());
 f.db.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('firmware_busy_owner',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({id:'interrupted-test',pid:2147483000}),new Date().toISOString());
 const reopened=createFirmwareService({db:f.db,logger:{}}),job=reopened.getJob('interrupted-test');assert.equal(job.status,'failed');assert.equal(job.stage,'interrupted');assert.match(job.error,/interrupted/);
 assert.ok(f.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get('controller_firmware_hold:'+f.controller.id));assert.equal(f.db.prepare("SELECT 1 FROM app_metadata WHERE key='firmware_busy'").get(),undefined);
 assert.equal((await f.finish(f.start())).status,'completed');
});


test('an original ESP32 with a damaged nonresponsive application can be reflashed from its verified profile',async t=>{
 const f=fixture(t,{sameBoard:true,chipIdentity:'00:11:22:33:44:01',probeMatches:true,unreadableBeforeUpload:true}),before=f.snapshot();
 const job=await f.finish(f.service.startFlashJob({...f.input,maintenance_action:'update'},f.admin));assert.equal(job.status,'completed',JSON.stringify(job));assert.ok(job.logs.some(row=>row.line.includes('old firmware could not report')));assert.equal(f.snapshot(),before);assert.equal(job.configurationVerified,true);
});
