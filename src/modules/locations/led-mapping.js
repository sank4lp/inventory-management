import {displayOwner} from '../operations/guidance.js';
import {createHash} from 'node:crypto';
import {loadControllerProfile} from '../../services/controller-profiles.js';
import {guardSetupChange} from '../operations/guards.js';
import {saveLocationDescription} from '../operations/location-contract.js';
import {assertCan} from '../access/catalog.js';

// Physical positions come from the verified routing backup, never from cell names.
export function controllerLedMap(db, controller) {
  let profile;
  try { profile=loadControllerProfile(db,controller); } catch(error) { return {...controller,error:error.message,leds:[]}; }
  if(!profile)return {...controller,error:'Save a verified controller backup from Edit controller before mapping its LEDs.',leds:[]};
  const cells=db.prepare('SELECT * FROM cells WHERE controller_id=? ORDER BY id').all(controller.id);
  const leds=Array.from({length:profile.physicalCount},(_,index)=>{
    const physical=index+1,channel=profile.routing.indexOf(physical)+1,c=cells.find(c=>c.hardware_channel===channel);
    return {physical,channel,cellId:c?.active?c.id:null,name:c?.active?(c.display_name||c.logical_code):'',bindingRevision:c?.binding_revision||null};
  });
  const revision=createHash('sha256').update(JSON.stringify([controller.address,controller.configured_at,profile.checksum||profile.routing,leds,db.prepare('SELECT id,display_name,logical_code,active,controller_id,hardware_channel,description_revision,binding_revision FROM cells ORDER BY id').all()])).digest('hex');
  return {id:controller.id,name:controller.controller_code,leds,revision};
}
export function createLedMapping({db,newCell,validateValues,event,operationsService,displayCoordinator}) {
  const cell=id=>db.prepare('SELECT * FROM cells WHERE id=? AND active=1').get(Number(id));
  const hasStock=id=>!!db.prepare('SELECT 1 FROM inventory_balances WHERE cell_id=? AND available_quantity!=0').get(id);
  const controller=id=>{const c=db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(Number(id));if(!c)throw Error('Controller not found.');return c;};
  const snapshot=()=>db.prepare('SELECT * FROM controllers WHERE active=1').all().map(c=>controllerLedMap(db,c));
  function save(actor,input) {
    assertCan(actor,'hardware.map');
    if(db.prepare("SELECT value FROM app_metadata WHERE key='firmware_busy'").get()?.value)throw Error('Finish controller maintenance before changing mappings.');
    guardSetupChange(db);
    const c=controller(input.controllerId),map=controllerLedMap(db,c);
    if(map.error)throw Error(map.error);
    if(input.revision!==map.revision)throw Error('Locations or controller setup changed. Reload the page and review the latest mappings.');
    if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>64)throw Error('Choose the LEDs to save.');
    const physicals=new Set(),targets=new Set();
    const rows=input.rows.map(row=>{
      const led=map.leds.find(l=>l.physical===Number(row.physical));
      if(!led?.channel||physicals.has(led.physical))throw Error('Choose each configured physical LED once.');
      physicals.add(led.physical);
      const name=String(row.name||'').trim();
      if(!name||name.length>160||/[\u0000-\u001f\u007f]/.test(name))throw Error('Enter a readable location name, up to 160 characters.');
      const matches=db.prepare('SELECT * FROM cells WHERE active=1 AND (display_name=? COLLATE NOCASE OR logical_code=? COLLATE NOCASE)').all(name,name);
      if(matches.length>1)throw Error('This name matches multiple locations. Rename them first.');
      let target=row.cellId?cell(row.cellId):matches[0];
      if(row.cellId&&(!target||![target.display_name,target.logical_code].some(n=>n?.toLowerCase()===name.toLowerCase())))throw Error('The selected location changed. Choose it again.');
      const old=led.cellId?cell(led.cellId):null;
      for(const item of [old,target].filter(Boolean)){
        if(displayOwner(db,item.id)?.kind==='count')throw Error('Finish or pause stocktaking at this location before changing its mapping.');
        if(db.prepare("SELECT 1 FROM location_qr_reassignments WHERE status='ready' AND (source_cell_id=? OR target_cell_id=?)").get(item.id,item.id))throw Error('Finish or cancel the pending QR reassignment for this location first.');
      }
      if(old&&old.id!==target?.id){
        if(row.resolution==='same'){
          assertCan(actor,'locations.manage');
          if(!['current','entered'].includes(row.keepName))throw Error('Choose which name to keep.');
          const keptName=row.keepName==='entered'?name:old.display_name||old.logical_code;
          if(target){
            if(row.mergeConfirmed!==true)throw Error('Confirm combining these names and retiring the duplicate QR label.');
            if(target.controller_id)throw Error('The selected location has another LED. Correct its mapping before combining these locations.');
            if(hasStock(old.id)&&hasStock(target.id))throw Error('Both saved locations contain stock. Reconcile their actual quantities before combining their identities.');
            // Keep the identity holding stock; archive the empty duplicate without deleting its history.
            const survivor=hasStock(target.id)?target:old,duplicate=survivor.id===old.id?target:old;
            if(db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get('led_move_source:'+duplicate.id))throw Error('Finish or discard the duplicate location’s move tasks first.');
            db.prepare("UPDATE cells SET active=0,controller_id=NULL,hardware_channel=NULL,mapping_status='unmapped' WHERE id=?").run(duplicate.id);
            db.prepare("UPDATE location_labels SET state='revoked' WHERE cell_id=? AND state='bound'").run(duplicate.id);
            event(actor,'location_names_combined',{survivorCellId:survivor.id,archivedCellId:duplicate.id,keptName});
            target=survivor;
          }else target=old;
          if((target.display_name||target.logical_code)!==keptName)saveLocationDescription(db,actor,{cellId:target.id,descriptionRevision:target.description_revision,displayName:keptName,travelInstructions:target.travel_instructions});
        }else{
          if(row.resolution!=='different')throw Error('Confirm whether these are the same location or different locations.');
          const moveRecord=db.prepare('SELECT value FROM app_metadata WHERE key=?').get('led_move_source:'+old.id);
          if(moveRecord){const move=JSON.parse(moveRecord.value);if([...move.picks,...move.puts].some(id=>{const task=db.prepare('SELECT completed_at,outcome FROM tasks WHERE id=?').get(id);return !task?.completed_at||task.outcome!=='completed';}))throw Error('Complete all linked pick and put tasks before reassigning this LED.');}
          if(hasStock(old.id))throw Error('Move all products out using the move tasks before reassigning this LED.');
        }
      }
      if(target?.controller_id&&(target.controller_id!==c.id||target.hardware_channel!==led.channel))throw Error(`${name} already has an LED. Remove that mapping first.`);
      if(!target){assertCan(actor,'locations.manage');const attributes=validateValues(row.attributes||{});target=newCell(actor,name);saveLocationDescription(db,actor,{cellId:target.id,descriptionRevision:target.description_revision,displayName:name,attributes,travelInstructions:row.travelInstructions,warehouseName:row.warehouseName});db.prepare("INSERT OR IGNORE INTO location_labels(token,revision,cell_id,state,created_at,bound_at,bound_by) VALUES(?,?,?,'bound',datetime('now'),datetime('now'),?)").run(target.label_id,target.label_revision,target.id,actor.id);}
      if(targets.has(target.id))throw Error('Choose a different location for each LED.');
      targets.add(target.id);
      return {led,target};
    });
    for(const {led,target} of rows){
      if(led.cellId===target.id)continue;
      db.prepare("UPDATE cells SET controller_id=NULL,hardware_channel=NULL,mapping_status='unmapped' WHERE controller_id=? AND hardware_channel=?").run(c.id,led.channel);
      db.prepare("UPDATE cells SET controller_id=?,hardware_channel=?,mapping_status='mapped',last_mapped_at=datetime('now'),mapped_by=? WHERE id=?").run(c.id,led.channel,actor.id,target.id);
      event(actor,'mapping_saved',{cellId:target.id,controllerId:c.id,output:led.channel,physical:led.physical});
    }
    if(db.prepare('SELECT 1 FROM cells c JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.hardware_channel IS NOT NULL GROUP BY ctrl.address,c.hardware_channel HAVING COUNT(*)>1 LIMIT 1').get())throw Error('Physical LED mapping is ambiguous. Check controller addresses before saving.');
    return {status:'recorded',message:'Locations and LED mappings saved.',cellIds:rows.map(r=>r.target.id)};
  }
  function move(actor,input){
    assertCan(actor,'hardware.map');assertCan(actor,'work.pick');assertCan(actor,'work.put');
    const source=cell(input.cellId);if(!source)throw Error('Location not found.');
    guardSetupChange(db,{cellId:source.id});
    return operationsService.reserveLocationMove(actor,{...input,sourceCellId:source.id});
  }
  function display(actor,input){
    assertCan(actor,'hardware.test');const c=controller(input.controllerId),map=controllerLedMap(db,c);if(map.error)throw Error(map.error);
    const setupTargets=map.leds.filter(l=>l.channel).map(l=>({...db.prepare('SELECT * FROM cells WHERE controller_id=? AND hardware_channel=?').get(c.id,l.channel),controller_id:c.id,controller_address:c.address,controller_active:c.active,hardware_channel:l.channel,heartbeat_status:c.heartbeat_status,logical_code:'LED '+l.physical}));
    return displayCoordinator.start(actor,{kind:'module_number',controllerTest:c.id,controllerRevision:JSON.stringify([c.address,c.module_count,c.configured_at]),setupTargets},{requestId:input.requestId});
  }
  return {snapshot,save,move,display,discard:(a,i)=>operationsService.discardLocationMove(a,{...i,sourceCellId:i.cellId}),plan:(a,i)=>operationsService.locationMovePlan(a,{sourceCellId:i.cellId})};
}
