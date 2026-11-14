import {dirname,join,resolve} from 'node:path';
import {createRecoveryCopy} from './card-recovery.mjs';
import {uninstallWarehouse} from './uninstall.mjs';
async function main(){
 if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid?.()!==0)throw new Error('Run this uninstaller with sudo on the Raspberry Pi.');
 if(process.argv.length!==2)throw new Error('Run the uninstaller without extra options.');
 await uninstallWarehouse({backup:(run,config,options)=>createRecoveryCopy(run,config,{...options,portableScript:join(dirname(resolve(process.argv[1])),'portable-backup.py')})});
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
