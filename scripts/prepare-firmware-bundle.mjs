// Developer/release preparation only. No downloads and no controller access.
// Usage: node scripts/prepare-firmware-bundle.mjs <staged-root> <platform> <arch>
// Staged root must contain bin/arduino-cli, data/ (installed ESP32 core), user/ (NeoPixel library).
import {readdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {ESP32_FIRMWARE_PROTOCOL} from '../src/services/firmware-constants.js';
const [rootArg,platform,arch]=process.argv.slice(2);if(!rootArg||!['linux','darwin'].includes(platform)||!['arm64','x64'].includes(arch))throw new Error('Supply a staged root, platform and architecture.');
const root=resolve(rootArg),files=[];
function walk(dir){for(const name of readdirSync(dir)){if(relative(root,join(dir,name))==='data/inventory.yaml')continue;const path=join(dir,name),stat=lstatSync(path);if(stat.isDirectory())walk(path);else if(stat.isFile()||stat.isSymbolicLink())files.push({path:relative(root,path),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});}}
for(const directory of ['bin','data','user'])walk(join(root,directory));
const coreVersion='3.0.7',libraryVersion='1.12.3',cliVersion='1.3.1';
if(!files.some(f=>f.path.includes('/esp32/'+coreVersion+'/platform.txt'))||!files.some(f=>f.path.endsWith('Adafruit_NeoPixel/library.properties')))throw new Error('Stage the pinned ESP32 core and NeoPixel library before preparing the bundle.');
const core=readFileSync(join(root,'data/packages/esp32/hardware/esp32/'+coreVersion+'/platform.txt'),'utf8');
if(!new RegExp('^version='+coreVersion.replaceAll('.', '\\.')+'$','m').test(core))throw new Error('ESP32 core version does not match the pinned release.');
const library=readFileSync(join(root,'user/libraries/Adafruit_NeoPixel/library.properties'),'utf8');
if(!new RegExp('^version='+libraryVersion.replaceAll('.', '\\.')+'$','m').test(library))throw new Error('NeoPixel version does not match the pinned release.');
const manifest={version:1,platform,arch,protocol:ESP32_FIRMWARE_PROTOCOL,cliVersion,coreVersion,libraryVersion,executable:'bin/arduino-cli',data:'data',user:'user',files};
writeFileSync(join(root,'toolchain.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({root,platform,arch,files:files.length,cliVersion,coreVersion,libraryVersion}));
