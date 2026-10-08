import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ESP32_FIRMWARE_PROTOCOL} from '../../services/firmware-constants.js';
// A bundle is prepared before installation; running the app never installs packages.
export function offlineBundle(root,{platform=process.platform,arch=process.arch}={}) {
  const base=realpathSync(root),manifest=JSON.parse(readFileSync(join(base,'toolchain.json'),'utf8'));
  if(manifest.version!==1||manifest.platform!==platform||manifest.arch!==arch||manifest.protocol!==ESP32_FIRMWARE_PROTOCOL)throw new Error('Firmware toolchain does not match this host or controller protocol.');
  const inside=path=>{const p=realpathSync(resolve(base,path));if(relative(base,p).startsWith('..')||p===base)throw new Error('Toolchain files must stay inside the bundle.');return p;};
  if(!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Firmware bundle has no integrity manifest.');
  for(const file of manifest.files){if(!/^[a-f0-9]{64}$/.test(file.sha256)||createHash('sha256').update(readFileSync(inside(file.path))).digest('hex')!==file.sha256)throw new Error('Firmware toolchain integrity check failed: '+file.path);}
  const executable=inside(manifest.executable);
  if(!manifest.files.some(f=>inside(f.path)===executable))throw new Error('Firmware executable is not covered by integrity checks.');
  for(const name of ['cliVersion','coreVersion','libraryVersion'])if(!manifest[name])throw new Error('Firmware tool versions must be pinned.');
  return {root:base,manifest,executable,env:{...process.env,ARDUINO_DIRECTORIES_DATA:inside(manifest.data),ARDUINO_DIRECTORIES_USER:inside(manifest.user),ARDUINO_BUILD_CACHE_PATH:join(tmpdir(),'lightguide-arduino-cache'),ARDUINO_UPDATER_ENABLE_NOTIFICATION:'false',ARDUINO_NETWORK_CLOUD_API_SKIP_BOARD_DETECTION_CALLS:'true'}};
}
export function createHostAdapter({config={},platform=process.platform,arch=process.arch,discover=()=>[],spawnProcess=spawn,runSync=spawnSync}={}) {
  const simulated=config.firmwareSimulation===true;
  const root=config.firmwareToolchainRoot||process.env.FIRMWARE_TOOLCHAIN_ROOT;
  let bundle;
  const bundleNow=()=>root?(bundle||=offlineBundle(root,{platform,arch})):null;
  const command=()=>bundleNow()?.executable||config.arduinoCliPath||process.env.ARDUINO_CLI_PATH||'arduino-cli';
  const environment=()=>bundleNow()?.env||process.env;
  const support=()=>({id:simulated?'simulator':platform==='linux'&&arch==='arm64'?'raspberry-pi':'legacy-host',platform,arch,simulated,firmwareStrategy:'offline-compilation',bundled:Boolean(root),packagedPlatform:platform==='linux'&&arch==='arm64',physicalVerified:false});
  return {
    support,
    command,
    listDevices(){if(simulated)return [{path:'simulator:esp32',canonicalPath:'simulator:esp32',deviceIdentity:'simulator:esp32',label:'Simulated ESP32',kind:'esp32',recommended:true}];return discover(command(),environment());},
    configureSerial(port){if(platform!=='linux')throw new Error('Physical serial configuration is supported on Linux; use the simulator on this host.');return runSync('stty',['-F',port,'115200','cs8','-cstopb','-parenb','-ixon','-ixoff','raw','-echo'],{timeout:5000});},
    verifyToolchain(){const b=bundleNow();if(!b)return {ready:false,reason:'No bundled offline toolchain configured. Existing explicitly installed Arduino tools remain available.',...support()};const result=runSync(command(),['version','--format','json'],{env:environment(),encoding:'utf8',timeout:5000});if(result.status!==0)throw new Error('Bundled Arduino CLI could not run on this host.');const v=JSON.parse(result.stdout);if(String(v.VersionString||v.version||'').replace(/^v/,'')!==b.manifest.cliVersion)throw new Error('Arduino CLI version differs from the bundle manifest.');return {ready:true,...support(),versions:{cli:b.manifest.cliVersion,core:b.manifest.coreVersion,library:b.manifest.libraryVersion}};},
    runFirmware(args,{onOutput=()=>{},timeoutMs=180000,cwd=process.cwd()}={}) {
      if(!['compile','upload'].includes(args[0]))throw new Error('Only offline compile and upload operations are permitted.');
      if(args.some(x=>['--profile','--additional-urls'].includes(x)))throw new Error('Firmware jobs cannot fetch dependencies or profiles.');
      if(simulated){onOutput('Simulator: '+args[0]+' contract completed; no compiler or physical device was used.');return Promise.resolve({simulated:true});}
      if(root)this.verifyToolchain();
      return new Promise((resolveJob,reject)=>{
        let timedOut=false,killTimer;
        const child=spawnProcess(command(),args,{cwd,env:environment(),stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
        const stop=signal=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{child.kill(signal);}};
        const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');killTimer=setTimeout(()=>stop('SIGKILL'),3000);},timeoutMs);
        const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);};
        child.stdout.on('data',d=>onOutput(d.toString()));child.stderr.on('data',d=>onOutput(d.toString()));
        child.on('error',e=>{cleanup();reject(e);});
        child.on('close',code=>{cleanup();if(timedOut)reject(new Error('Firmware operation timed out. Re-detect and inspect the controller before retrying.'));else if(code===0)resolveJob({simulated:false});else reject(new Error('Firmware '+args[0]+' exited with code '+code+'. No success was assumed.'));});
      });
    },
  };
}
