import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {renderLanConfig} from '../lib/pi-lan.js';
import {STATE_ROOT,CONFIG_ROOT} from './pi-package.mjs';
import {publishDeviceEnrollment} from '../../src/services/device-enrollment.js';

export function packageLanConfig(config,network){
 return renderLanConfig({address:config.address,port:config.httpsPort,appPort:config.appPort,cidr:network.cidr,storage:join(STATE_ROOT,'caddy'),enrollPort:config.enrollPort});
}
export function publishEnrollment(config,owner){
 const certificatePath=join(STATE_ROOT,'caddy/pki/authorities/local/root.crt');
 if(!config.address||!config.enrollPort||!existsSync(certificatePath))return null;
 return publishDeviceEnrollment({...config,certificatePath,folder:join(STATE_ROOT,'caddy/enrollment'),metadataPath:join(CONFIG_ROOT,'device-access.json'),owner});
}
