import {createHash} from 'node:crypto';
import {encodeControllerConfiguration} from './hardware-adapters/controller-configuration.js';
import {groupChecksum} from './hardware-adapters/group-protocol.js';

export function controllerBusDiagnostics(reply) {
  const status=reply?.rs485;
  if(status===undefined)return null; // Existing firmware has no UART diagnostics.
  const invalid=field=>new Error(`The ESP32 returned invalid RS485 diagnostics (${field}: ${(JSON.stringify(status?.[field])??'missing').slice(0,60)}). Keep USB connected and read its setup again.`);
  if(!status || typeof status!=='object' || Array.isArray(status))throw invalid('rs485');
  if(status.version!==1)throw invalid('version');
  if(typeof status.ready!=='boolean')throw invalid('ready');
  for(const key of ['baud','rxPin','txPin','directionPin','rxBytes','rxLines','txBytes','pingRequests']) {
    if(!Number.isInteger(status[key]) || status[key]<0 || status[key]>0xffffffff)throw invalid(key);
  }
  for(const key of ['rxPin','txPin','directionPin'])if(status[key]>39)throw invalid(key);
  if(!status.ready && status.baud!==0)throw invalid('baud');
  return {...status};
}

export function validateControllerConfiguration(reply, address, request = null, {allowFault=false,allowBusFault=false} = {}) {
  if (!reply || reply.type !== 'controller-config' || reply.address?.toUpperCase() !== address.toUpperCase() || typeof reply.fault !== 'boolean' || request && reply.request !== request) throw new Error('The ESP32 configuration reply did not match this controller. Check the selected USB device and try again.');
  if (!Number.isInteger(reply.revision) || reply.revision < 0 || reply.revision > 0xffffffff || !/^[a-f0-9]{128}$/.test(reply.routing)) throw new Error('Invalid controller configuration response.');
  const routing=reply.routing.match(/../g).map(n=>parseInt(n,16));
  encodeControllerConfiguration({address,requestId:'0000000000000000',expectedRevision:0,physicalCount:reply.physicalModules,routing});
  const logicalCount=routing.findLastIndex(n=>n>0)+1;
  if (reply.logicalModules !== logicalCount) throw new Error('Controller logical output count does not match its routing.');
  const rev=reply.revision.toString(16).padStart(8,'0');
  const payload=`${address.toUpperCase()} config-status ${reply.request || '-'} ${rev} ${reply.physicalModules} ${reply.routing} ${reply.fault?1:0}`;
  if (reply.checksum !== groupChecksum(payload)) throw new Error('Controller configuration checksum does not match.');
  const bus=controllerBusDiagnostics(reply);
  if(bus && !bus.ready && !allowBusFault)throw new Error('The ESP32 LED setup is readable over USB, but its RS485 serial port did not start. Check the selected ESP32 board and firmware tools before flashing again.');
  // baudRate() reads the hardware divider, not the exact requested number.
  // For example, ESP32's 1 MHz REF_TICK can report 115942 for 115200.
  // Allow at most 1% divider error; genuinely wrong or failed readback remains
  // a separate actionable error, never a malformed configuration response.
  if(bus?.ready && Math.abs(bus.baud-115200)>115200*0.01 && !allowBusFault)throw new Error(`The ESP32 RS485 port reports ${bus.baud} baud; expected about 115200 (within 1%). Keep USB connected and check the firmware serial configuration.`);
  if (reply.fault && !allowFault) throw new Error('The ESP32 could not load its saved LED setup. For a reused board, choose Set up as fresh controller to replace its old setup, or restore its previous controller setup to keep the LED mapping.');
  return {physicalCount:reply.physicalModules,logicalCount,routing,revision:reply.revision,fault:reply.fault};
}

function profileChecksum(profile) {
  return createHash('sha256').update(JSON.stringify([profile.version,profile.controllerId,profile.controllerName,profile.address,profile.physicalCount,profile.logicalCount,profile.routing,profile.revision])).digest('hex');
}

export function saveControllerProfile(db,controller,configuration) {
  if(configuration.fault)throw new Error('Cannot save a replacement backup from a controller with a configuration fault.');
  encodeControllerConfiguration({address:controller.address,requestId:'0000000000000000',expectedRevision:0,...configuration});
  if (configuration.logicalCount !== controller.module_count) throw new Error('Saved controller count differs from its mappings. Reconcile the controller setup first.');
  const profile={version:1,controllerId:controller.id,controllerName:controller.controller_code,address:controller.address,...configuration,verifiedAt:new Date().toISOString()};
  profile.checksum=profileChecksum(profile);
  db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`controller_profile:${controller.id}`,JSON.stringify(profile),profile.verifiedAt);
  return profile;
}

export function loadControllerProfile(db,controller) {
  const row=db.prepare('SELECT value FROM app_metadata WHERE key=?').get(`controller_profile:${controller.id}`);
  if (!row) {
    const version=/^simple-matrix-v(\d+)-rs485-addressed$/.exec(controller.firmware_version || '');
    if(version && Number(version[1])<=13 && controller.module_count>=1 && controller.module_count<=64) {
      return {version:1,controllerId:controller.id,controllerName:controller.controller_code,address:controller.address,physicalCount:controller.module_count,logicalCount:controller.module_count,routing:Array.from({length:64},(_,i)=>i<controller.module_count?i+1:0),revision:0,verifiedAt:null,source:'legacy-fixed-routing'};
    }
    return null;
  }
  let profile;try {profile=JSON.parse(row.value);}catch{throw new Error('Saved controller backup is damaged. Save a verified backup again.');}
  if (profile.checksum!==profileChecksum(profile))throw new Error('Saved controller backup checksum does not match. Save a verified backup again.');
  if (profile.version!==1 || profile.controllerId!==controller.id || profile.address!==controller.address || profile.controllerName!==controller.controller_code || profile.logicalCount!==controller.module_count) throw new Error('Controller backup no longer matches its saved setup. Save a verified backup again.');
  encodeControllerConfiguration({address:controller.address,requestId:'0000000000000000',expectedRevision:0,...profile});
  if(profile.routing.findLastIndex(n=>n>0)+1!==profile.logicalCount)throw new Error('Invalid saved logical output count.');
  return profile;
}
