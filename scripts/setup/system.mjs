import {execFileSync} from 'node:child_process';
import {accessSync,constants,existsSync,readFileSync,readdirSync,realpathSync,statSync,statfsSync} from 'node:fs';
import {join} from 'node:path';
import {currentNetwork,connectWifi} from './network.mjs';
import {findCardRecoveryDirectory} from '../release/card-recovery.mjs';
import {INSTALL_ROOT,STATE_ROOT} from '../release/pi-package.mjs';
import {supportedOs} from '../release/supported-os.mjs';

const run=(cmd,args=[],options={})=>execFileSync(cmd,args,{encoding:'utf8',timeout:10000,stdio:['pipe','pipe','pipe'],...options});
export function systemChecks(){
  const os=Object.fromEntries(readFileSync('/etc/os-release','utf8').split('\n').filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1).replace(/^"|"$/g,'')];}));
  const disk=statfsSync(STATE_ROOT),checks=[{id:'platform',label:'64-bit Raspberry Pi',ok:process.platform==='linux'&&process.arch==='arm64',detail:process.arch},{id:'os',label:'Supported Raspberry Pi OS',ok:supportedOs(os),detail:os.PRETTY_NAME},{id:'systemd',label:'Automatic startup',ok:existsSync('/run/systemd/system'),detail:'systemd'},{id:'storage',label:'Free storage',ok:disk.bavail*disk.bsize>=512*1024*1024,detail:(disk.bavail*disk.bsize/1024**3).toFixed(1)+' GB free'}];
  for(const [id,label,cmd,args] of [['python','Backup engine','python3',['-c','import sqlite3,tarfile;print("Ready")']],['network','Wi-Fi setup','nmcli',['--version']]])try{run(cmd,args);checks.push({id,label,ok:true,detail:'Ready offline'});}catch{checks.push({id,label,ok:false,detail:'Missing. Run the complete offline installer.'});}
  try{const directory=findCardRecoveryDirectory();accessSync(directory,constants.W_OK);checks.push({id:'recovery',label:'Mac-readable recovery storage',ok:true,detail:directory});}catch(error){checks.push({id:'recovery',label:'Mac-readable recovery storage',ok:false,detail:['ENOENT','EROFS','EACCES'].includes(error.code)?'Recovery folder is not writable. Close Setup, check that the SD-card boot volume is mounted read/write, and reopen Warehouse Setup.':error.message});}
  checks.push({id:'tools',label:'Included firmware tools',ok:existsSync(join(INSTALL_ROOT,'candidate/toolchain/toolchain.json')),detail:'No downloads required'});
  return {checks,os,network:currentNetwork(run),internetRequired:false,date:new Date().toISOString()};
}
export function serialPorts(){
  const paths=[];
  for(const folder of ['/dev/serial/by-id','/dev'])if(existsSync(folder))for(const name of readdirSync(folder)){if(folder==='/dev'&&!/^tty(?:USB|ACM)\d+$/.test(name))continue;const path=join(folder,name);try{if(statSync(path).isCharacterDevice()&&realpathSync(path).startsWith('/dev/'))paths.push({path,label:name,device:realpathSync(path)});}catch{}}
  return paths.sort((a,b)=>a.path.localeCompare(b.path));
}
async function main(){
  if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid()!==0)throw new Error('Run setup on the Raspberry Pi.');
  const input=JSON.parse(readFileSync(0,'utf8'));
  if(input.action==='system')console.log(JSON.stringify(systemChecks()));
  else if(input.action==='network')console.log(JSON.stringify(currentNetwork(run)));
  else if(input.action==='serial')console.log(JSON.stringify(serialPorts()));
  else if(input.action==='connect')console.log(JSON.stringify(await connectWifi(run,input)));
  else throw new Error('Unknown setup check.');
}
if(process.argv[1]?.endsWith('/wizard-system.cjs')||process.argv[1]?.endsWith('/system.mjs'))main().catch(error=>{console.error(error.message);process.exitCode=1;});
