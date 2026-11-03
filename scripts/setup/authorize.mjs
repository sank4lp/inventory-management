import {randomBytes,createHash} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {SETUP_PORT} from './security.mjs';
import {INSTALL_ROOT} from '../release/pi-package.mjs';
import {findCardRecoveryDirectory} from '../release/card-recovery.mjs';

export const SETUP_RUNTIME='/run/lytguide-test-setup';
// systemd resolves ReadWritePaths before launching the protected service.
// Its narrow exception cannot create a missing child of the read-only boot
// volume, so prepare only our own folder before entering that namespace.
export function prepareRecoveryAccess(locate=findCardRecoveryDirectory){
  try{
    const directory=locate(),created=!existsSync(directory);
    mkdirSync(directory,{recursive:true,mode:0o700});
    return {directory,created};
  }catch(error){return {created:false,error:error.message};}
}
export async function authorizeSetup(){
  const args=process.argv.slice(2);if(args.length>1||args.some(arg=>arg!=='--resume'))throw new Error('Invalid Setup launch option.');
  if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid()!==0)throw new Error('Warehouse Setup must be authorised on the Raspberry Pi.');
  const uid=Number(process.env.PKEXEC_UID||process.env.SUDO_UID);
  if(!Number.isSafeInteger(uid)||uid<1)throw new Error('Open Warehouse Setup from the Pi desktop as its normal user.');
  const recovery=prepareRecoveryAccess();
  execFileSync('systemctl',[recovery.created?'restart':'start','lytguide-test-setup.service'],{stdio:['ignore','pipe','pipe'],timeout:30000});
  const expected=JSON.parse(readFileSync(join(INSTALL_ROOT,'candidate/release.json'),'utf8')).version;
  let version;
  for(let attempt=0;attempt<40;attempt++){
    try{const response=await fetch(`http://localhost:${SETUP_PORT}/setup-api/version`,{signal:AbortSignal.timeout(1000)});if(response.ok)version=(await response.json()).version;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}
  }
  if(version!==expected)throw new Error('Warehouse Setup was updated. Finish any controller operation, restart this Raspberry Pi, then open Warehouse Setup again.');
  mkdirSync(SETUP_RUNTIME,{recursive:true,mode:0o700});
  const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
  writeFileSync(join(SETUP_RUNTIME,hash+'.json'),JSON.stringify({uid,expiresAt:Date.now()+120000,restart:!args.includes('--resume')}),{flag:'wx',mode:0o600});
  process.stdout.write(`http://localhost:${SETUP_PORT}/#${token}\n`);
}
if(process.argv[1]?.endsWith('/wizard-authorize.cjs')||process.argv[1]?.endsWith('/authorize.mjs'))authorizeSetup().catch(error=>{console.error(error.message);process.exitCode=1;});
