import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createHostAdapter,offlineBundle,installedEsptool} from '../src/modules/hardware/host-adapter.js';
import {ESP32_FIRMWARE_PROTOCOL} from '../src/services/firmware-constants.js';
function bundle(){const root=mkdtempSync(join(tmpdir(),'firmware-contract-'));for(const d of ['bin','data','user'])mkdirSync(join(root,d));writeFileSync(join(root,'bin/arduino-cli'),'test fixture executable, never run');const manifest={version:1,platform:'linux',arch:'arm64',protocol:ESP32_FIRMWARE_PROTOCOL,cliVersion:'1.3.1',coreVersion:'3.0.7',libraryVersion:'1.12.4',executable:'bin/arduino-cli',data:'data',user:'user',files:[{path:'bin/arduino-cli',sha256:createHash('sha256').update('test fixture executable, never run').digest('hex')}]};writeFileSync(join(root,'toolchain.json'),JSON.stringify(manifest));return {root,manifest};}
test('Pi and simulator provide the same discovery and firmware execution interface; simulation is explicit',async()=>{const seen=[],pi=createHostAdapter({platform:'linux',arch:'arm64',discover:()=>[{path:'/dev/ttyUSB0',deviceIdentity:'usb:A'}],runSync:(exe,args)=>{seen.push({exe,args});return {status:0};}}),sim=createHostAdapter({config:{firmwareSimulation:true}});assert.equal(pi.support().id,'raspberry-pi');assert.equal(pi.listDevices()[0].deviceIdentity,'usb:A');pi.configureSerial('/dev/ttyUSB0');assert.deepEqual(seen[0].args,['-F','/dev/ttyUSB0','115200','cs8','-cstopb','-parenb','-ixon','-ixoff','-crtscts','clocal','-hupcl','raw','-echo']);assert.equal(sim.listDevices()[0].deviceIdentity,'simulator:esp32');assert.equal((await sim.runFirmware(['compile'],{onOutput:t=>seen.push(t)})).simulated,true);assert.match(seen[1],/no compiler or physical device/);assert.throws(()=>sim.runFirmware(['core','install']),/offline compile/);assert.equal(sim.support().physicalVerified,false);assert.throws(()=>createHostAdapter({platform:'darwin'}).configureSerial('/dev/cu.test'),/supported on Linux/);});
test('offline bundle pins host, protocol, versions and hashes and rejects tampering',()=>{const f=bundle();assert.equal(offlineBundle(f.root,{platform:'linux',arch:'arm64'}).manifest.cliVersion,'1.3.1');assert.throws(()=>offlineBundle(f.root,{platform:'darwin',arch:'arm64'}),/does not match/);writeFileSync(join(f.root,'bin/arduino-cli'),'changed');assert.throws(()=>offlineBundle(f.root,{platform:'linux',arch:'arm64'}),/integrity/);});
test('firmware execution refuses missing tools, wrong version, nonzero exit and interruption; never installs dependencies',async()=>{const f=bundle();const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>child.emit('close',null);setTimeout(()=>child.emit('close',2),1);return child;};const host=createHostAdapter({config:{firmwareToolchainRoot:f.root},platform:'linux',arch:'arm64',spawnProcess,runSync:()=>({status:0,stdout:JSON.stringify({VersionString:'1.3.1'})})});assert.equal(host.verifyToolchain().ready,true);await assert.rejects(()=>host.runFirmware(['upload','-p','/dev/ttyUSB0']),/No success was assumed/);assert.throws(()=>host.runFirmware(['compile','--profile','remote']),/cannot fetch/);const wrong=createHostAdapter({config:{firmwareToolchainRoot:f.root},platform:'linux',arch:'arm64',runSync:()=>({status:0,stdout:'{"VersionString":"0.0"}'})});assert.throws(()=>wrong.verifyToolchain(),/version differs/);const hanging=createHostAdapter({spawnProcess:()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>queueMicrotask(()=>child.emit('close',null));return child;}});await assert.rejects(()=>hanging.runFirmware(['compile'],{timeoutMs:5}),/timed out/);});
test('older bundled LED drivers are refused before any controller upload',()=>{
 const f=bundle();writeFileSync(join(f.root,'toolchain.json'),JSON.stringify({...f.manifest,libraryVersion:'1.12.3'}));
 assert.throws(()=>offlineBundle(f.root,{platform:'linux',arch:'arm64'}),/older LED driver/);
});
test('ESP32 identity is read from the checked offline ROM tool, not inferred from a USB bridge serial',async()=>{
 const f=bundle(),directory=join(f.root,'data/packages/esp32/tools/esptool_py/4.6');mkdirSync(directory,{recursive:true});
 const path='data/packages/esp32/tools/esptool_py/4.6/esptool.py';writeFileSync(join(f.root,path),'# synthetic read-only esptool fixture');
 f.manifest.files.push({path,sha256:createHash('sha256').update(readFileSync(join(f.root,path))).digest('hex')});writeFileSync(join(f.root,'toolchain.json'),JSON.stringify(f.manifest));
 const calls=[];let output='MAC: 70:4B:CA:46:D7:B8\n';
 const spawnProcess=(command,args)=>{calls.push({command,args});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(output));child.emit('close',0);});return child;};
 const host=createHostAdapter({config:{firmwareToolchainRoot:f.root},platform:'linux',arch:'arm64',spawnProcess});
 assert.equal(await host.readChipIdentity('/dev/ttyUSB1'),'70:4b:ca:46:d7:b8');assert.equal(calls[0].command,'python3');assert.equal(calls[0].args.at(-1),'read_mac');assert.ok(!calls[0].args.includes('write_flash'));
 output='No MAC was returned';await assert.rejects(()=>host.readChipIdentity('/dev/ttyUSB1'),/identity could not be verified/);
 await assert.rejects(()=>host.readChipIdentity('/dev/../bad'),/valid ESP32/);
});

function legacyTools({native=false}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'legacy Arduino = data-'))),tool=join(root,native?'esptool':'esptool.py');
 writeFileSync(tool,'synthetic ESP32 ROM tool; test never executes this file');
 const details={build_properties:[`tools.esptool_py.path=${root}`,`tools.esptool_py.cmd=${native?'esptool':'esptool.py'}`,`runtime.tools.esptool_py.path=${join(root,'wrong-version')}`]};
 return {root,tool,details};
}
test('legacy Git service reads chip identity using its existing Arduino core without an offline bundle',async()=>{
 const f=legacyTools(),calls=[];let mac='70:4B:CA:46:D7:B8';
 const host=createHostAdapter({config:{arduinoCliPath:'/existing/arduino-cli',esp32Fqbn:'esp32:esp32:esp32wrover'},platform:'linux',arch:'arm64',
  runSync:(exe,args,options)=>{calls.push({exe,args,options});return {status:0,stdout:JSON.stringify(f.details)};},
  spawnProcess:(exe,args)=>{calls.push({exe,args});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('MAC: '+mac+'\n'));child.emit('close',0);});return child;}});
 assert.equal(host.support().bundled,false);
 assert.equal(await host.readChipIdentity('/dev/ttyUSB1'),'70:4b:ca:46:d7:b8');
 assert.equal(calls[0].exe,'/existing/arduino-cli');assert.deepEqual(calls[0].args,['board','details','--fqbn','esp32:esp32:esp32wrover','--format','json']);
 assert.equal(calls[0].options.env,process.env);assert.equal(calls[1].exe,'python3');assert.equal(calls[1].args[0],f.tool);assert.equal(calls[1].args.at(-1),'read_mac');
 assert.ok(!calls.some(call=>call.args.some(arg=>['install','update-index','write_flash'].includes(arg))));
 mac='70:4B:CA:46:D7:B9';assert.equal(await host.readChipIdentity('/dev/ttyUSB1',{fqbn:'esp32:esp32:esp32'}),'70:4b:ca:46:d7:b9');assert.equal(calls[2].args[3],'esp32:esp32:esp32');
 mac='missing';await assert.rejects(()=>host.readChipIdentity('/dev/ttyUSB1'),/identity could not be verified/);
});
test('legacy discovery follows the selected core, supports explicit data directories and native esptool executables',()=>{
 for(const native of [false,true]){
  const f=legacyTools({native}),env={ARDUINO_DIRECTORIES_DATA:'/service Arduino data',ARDUINO_DIRECTORIES_USER:'/service Arduino user'};
  const tool=installedEsptool({cli:'/custom/bin/arduino-cli',env,runSync:(cli,args,options)=>{assert.equal(cli,'/custom/bin/arduino-cli');assert.deepEqual(options.env,env);return {status:0,stdout:JSON.stringify(f.details)};}});
  assert.deepEqual(tool,native?{command:f.tool,args:[]}:{command:'python3',args:[f.tool]});
 }
});
test('legacy discovery rejects missing cores, malformed metadata and missing tools with service-account guidance',()=>{
 const f=legacyTools();
 const bad=[{status:1,stderr:'core not installed'},{status:0,stdout:'not json'},...[
  {},{build_properties:'not an array'},
  {build_properties:['tools.esptool_py.path={runtime.tools.esptool_py.path}']},
  {build_properties:['tools.esptool_py.path=relative/path']},
  {build_properties:[`tools.esptool_py.path=${f.root}/missing`]},
  {build_properties:[`tools.esptool_py.path=${f.root}`,'tools.esptool_py.cmd=../../unrelated']},
 ].map(details=>({status:0,stdout:JSON.stringify(details)}))];
 for(const result of bad)assert.throws(()=>installedEsptool({cli:'arduino-cli',runSync:()=>result}),/service account/);
 assert.throws(()=>installedEsptool({cli:'arduino-cli',fqbn:'--invalid',runSync:()=>{throw new Error('should not call CLI');}}),/valid ESP32 board/);
});
test('an invalid explicitly configured bundle never falls back to legacy tools',async()=>{
 const f=bundle();writeFileSync(join(f.root,'bin/arduino-cli'),'tampered');let discovered=false;
 const host=createHostAdapter({config:{firmwareToolchainRoot:f.root},platform:'linux',arch:'arm64',runSync:()=>{discovered=true;return {status:0};}});
 await assert.rejects(()=>host.readChipIdentity('/dev/ttyUSB1'),/integrity/);assert.equal(discovered,false);
});
