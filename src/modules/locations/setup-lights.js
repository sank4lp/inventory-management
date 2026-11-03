import {loadControllerProfile} from '../../services/controller-profiles.js';

export function setupLedMap(db,controller){
 const profile=loadControllerProfile(db,controller);
 const routing=profile?.routing||Array.from({length:controller.module_count},(_,i)=>i+1);
 return Array.from({length:profile?.physicalCount||controller.module_count},(_,index)=>({physical:index+1,channel:routing.indexOf(index+1)+1}));
}
export function setupControllerSignature(db,controller){
 const profile=loadControllerProfile(db,controller);
 return JSON.stringify([controller.id,controller.address,controller.module_count,controller.configured_at,profile?.checksum||null]);
}
export function nextSetupOutput(db,controller,session,{afterCurrent=false}={}){
 const outputs=setupLedMap(db,controller).filter(led=>led.channel);
 if(!outputs.length)throw new Error('This controller has no configured LED outputs. Check its Hardware settings.');
 if(afterCurrent){const index=outputs.findIndex(led=>led.channel===session.output);return outputs[(index+1)%outputs.length].channel;}
 const skipped=JSON.parse(session.skipped_json||'[]');
 return outputs.find(led=>!skipped.includes(led.channel)&&!db.prepare('SELECT binding_verified_at FROM cells WHERE controller_id=? AND hardware_channel=? AND active=1').get(controller.id,led.channel)?.binding_verified_at)?.channel||outputs[0].channel;
}
export function showSetupLights({db,displayCoordinator},actor,session,{mode='selected',showNumbers=Boolean(session.show_numbers),requestId}={}){
 const controller=db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(session.controller_id);
 if(!controller||setupControllerSignature(db,controller)!==session.controller_snapshot)throw new Error('Controller configuration changed. Restart setup for this controller. Saved locations are kept.');
 if(!['selected','numbers','all','ping'].includes(mode))throw new Error('Choose a supported setup display.');
 const previous=session.display_id?db.prepare('SELECT * FROM display_requests WHERE id=? AND actor_id=?').get(session.display_id,actor.id):null;
 const previousScope=previous?JSON.parse(previous.scope_json):null;
 if(previous&&['active','expiring'].includes(previous.state)){
  displayCoordinator.stop(actor,previous.id);
  if(db.prepare('SELECT state FROM display_requests WHERE id=?').get(previous.id)?.state!=='stopped')throw new Error('The controller has not confirmed clearing its previous lights. Check its connection and retry Re-Light.');
 }
 const selected=setupLedMap(db,controller).find(led=>led.channel===session.output);
 if(!selected)throw new Error('Select a configured LED before lighting this controller.');
 const targets=setupLedMap(db,controller).filter(led=>led.channel).map(led=>{
  const cell=db.prepare('SELECT * FROM cells WHERE controller_id=? AND hardware_channel=?').get(controller.id,led.channel);
  return {...cell,id:cell?.id||null,cell_id:cell?.id||null,controller_id:controller.id,controller_address:controller.address,controller_active:controller.active,hardware_channel:led.channel,heartbeat_status:controller.heartbeat_status,logical_code:cell?.logical_code||'LED '+led.physical,setupNumber:led.physical,setupDisplay:mode==='selected'?(led.channel===session.output?(showNumbers?'flash':'locate'):(showNumbers?'number':'dark')):mode==='numbers'?'number':mode==='all'?'locate':'ping'};
 });
 const scope={kind:'setup',setupSession:session.id,setupGeneration:session.generation,setupMode:mode,setupControllerSnapshot:session.controller_snapshot,controllerRevision:JSON.stringify([controller.address,controller.module_count,controller.configured_at]),selectedChannel:session.output,showNumbers,setupTargets:targets};
 if(mode==='ping')scope.restoreSetupScope=previousScope?.kind==='setup'?(previousScope.setupMode==='ping'?previousScope.restoreSetupScope:previousScope):{...scope,setupMode:'selected',setupTargets:targets.map(target=>({...target,setupDisplay:target.hardware_channel===session.output?(showNumbers?'flash':'locate'):(showNumbers?'number':'dark')}))};
 const result=displayCoordinator.start(actor,scope,{requestId});
 db.prepare('UPDATE location_setup_sessions SET display_id=?,display_mode=?,show_numbers=?,updated_at=? WHERE id=? AND generation=?').run(result.id||null,mode,showNumbers?1:0,new Date().toISOString(),session.id,session.generation);
 return {...result,ready:result.state==='active'&&result.targets.length===targets.length&&result.targets.every(target=>target.status==='sent'),message:result.targets.every(target=>target.status==='sent')?(mode==='selected'?'Selected LED is lit.':mode==='numbers'?'LED numbers are showing.':mode==='all'?'All LEDs are locating in red.':'All LEDs are pinging for five seconds.'):result.message};
}
