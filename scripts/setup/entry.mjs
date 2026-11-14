import {readFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createSetupServer} from './server.mjs';
import {SetupDriver} from './driver.mjs';
import {SETUP_PORT} from './security.mjs';
import {STATE_ROOT,INSTALL_ROOT} from '../release/pi-package.mjs';

if(process.platform!=='linux'||process.arch!=='arm64'||process.getuid()!==0)throw new Error('Shed Setup runs only on the Raspberry Pi.');
const driver=new SetupDriver();
const server=createSetupServer({driver,port:SETUP_PORT,buildVersion:JSON.parse(readFileSync(join(INSTALL_ROOT,'candidate/release.json'),'utf8')).version,assets:join(INSTALL_ROOT,'candidate/setup-ui'),uploadDirectory:join(STATE_ROOT,'setup/uploads'),
  redeem(hash){const path=join('/run/lytguide-test-setup',hash+'.json');if(!/^[a-f0-9]{64}$/.test(hash)||!existsSync(path))return null;const value=JSON.parse(readFileSync(path,'utf8'));unlinkSync(path);return value;},
  onIdle(){server.close(()=>process.exit(0));},
});
server.listen(SETUP_PORT,'127.0.0.1');
