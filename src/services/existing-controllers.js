import {currentActor} from '../modules/access/service.js';
import {guardSetupChange} from '../modules/operations/guards.js';
import {configureControllerModules} from './inventory.js';
import {saveControllerProfile} from './controller-profiles.js';

// Register a controller by reading its existing configuration. There is no
// compiler, upload, configure or erase operation in this path.
export function connectExistingController({db,hardwareService},input,user){
  const actor=currentActor(db,user,'hardware.controllers');guardSetupChange(db);
  const name=String(input.controller_name||'').trim().toUpperCase().replace(/\s+/g,'-'),address=String(input.controller_address||'').trim().toUpperCase();
  if(!/^[A-Z0-9._:-]{1,80}$/.test(name)||!/^[A-Z0-9._:-]{1,80}$/.test(address)||/^(ALL|BROADCAST)$/.test(address))throw new Error('Enter the controller name and its exact saved RS485 address.');
  if(db.prepare('SELECT 1 FROM controllers WHERE controller_code=? OR address=?').get(name,address))throw new Error('This controller is already registered. Use Controller health to check its connection.');
  const actual=hardwareService.inspectExistingController(address);
  if(actual.address!==address)throw new Error('The reply belongs to a different controller. Nothing was registered.');
  currentActor(db,user,'hardware.controllers');guardSetupChange(db);
  return configureControllerModules(db,{controllerCode:name,controllerAddress:address,moduleCount:actual.configuration.logicalCount,configuredBy:actor.id,firmwareVersion:actual.firmwareVersion},controller=>{
    // Unrouted logical slots must not appear as configurable physical LEDs.
    for(const cell of db.prepare('SELECT id,hardware_channel FROM cells WHERE controller_id=?').all(controller.id))if(!actual.configuration.routing[cell.hardware_channel-1])db.prepare('DELETE FROM cells WHERE id=? AND active=0').run(cell.id);
    saveControllerProfile(db,controller,actual.configuration);
    db.prepare('INSERT INTO system_events(event_type,status,message,payload,created_at) VALUES(?,?,?,?,?)').run('controller_reconnected','info','Connected existing controller without flashing firmware.',JSON.stringify({controllerId:controller.id,address}),new Date().toISOString());
  });
}
