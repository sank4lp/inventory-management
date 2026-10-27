import {createHash} from 'node:crypto';
import {encodeControllerConfiguration} from './hardware-adapters/controller-configuration.js';
import {groupChecksum} from './hardware-adapters/group-protocol.js';

export function validateControllerConfiguration(reply, address, request = null, {allowFault=false} = {}) {
  if (!reply || reply.type !== 'controller-config' || reply.address?.toUpperCase() !== address.toUpperCase() || typeof reply.fault !== 'boolean' || !allowFault && reply.fault || request && reply.request !== request) throw new Error('Controller did not return a matching, healthy configuration.');
  if (!Number.isInteger(reply.revision) || reply.revision < 0 || reply.revision > 0xffffffff || !/^[a-f0-9]{128}$/.test(reply.routing)) throw new Error('Invalid controller configuration response.');
  const routing=reply.routing.match(/../g).map(n=>parseInt(n,16));
  encodeControllerConfiguration({address,requestId:'0000000000000000',expectedRevision:0,physicalCount:reply.physicalModules,routing});
  const logicalCount=routing.findLastIndex(n=>n>0)+1;
  if (reply.logicalModules !== logicalCount) throw new Error('Controller logical output count does not match its routing.');
  const rev=reply.revision.toString(16).padStart(8,'0');
  const payload=`${address.toUpperCase()} config-status ${reply.request || '-'} ${rev} ${reply.physicalModules} ${reply.routing} ${reply.fault?1:0}`;
  if (reply.checksum !== groupChecksum(payload)) throw new Error('Controller configuration checksum does not match.');
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
