export const STEPS={
  new:[['choose','Get started'],['system','Check Pi'],['network','Shed Wi-Fi'],['account','Administrator & recovery'],['phones','Phones & tablets'],['hardware','Controllers'],['locations','Locations & QR codes'],['finish','Ready']],
  configure:[['choose','Get started'],['system','Check Pi'],['network','Shed Wi-Fi'],['account','Administrator & recovery'],['phones','Phones & tablets'],['hardware','Controllers'],['locations','Locations & QR codes'],['finish','Ready']],
  replace:[['choose','Get started'],['system','Check Pi'],['network','Shed Wi-Fi'],['backup','Restore shed'],['phones','Phones & tablets'],['hardware','Check controllers'],['finish','Ready']],
};
export function initialSetupState(){return {format:1,revision:1,mode:null,step:'choose',done:[],completedAt:null,simulation:false,checks:{},startedAt:new Date().toISOString()};}
export function restartedSetupState(previous){
  const locationSetupReady=previous.locationSetupReady===true||previous.done?.includes('hardware')&&['locations','finish'].includes(previous.step);
  return {...initialSetupState(),revision:previous.revision+1,...(locationSetupReady?{locationSetupReady:true}:{})};
}
export function locationSetupProgress(controllers,cells){
  const ready=cells.filter(cell=>{const controller=controllers.find(row=>row.id===cell.controller_id);return controller&&Number.isInteger(cell.hardware_channel)&&cell.hardware_channel>0&&cell.hardware_channel<=controller.module_count&&cell.binding_verified_at;});
  const outputs=controllers.reduce((sum,row)=>sum+(Number.isInteger(row.physical_count??row.module_count)&&(row.physical_count??row.module_count)>0?(row.physical_count??row.module_count):0),0);
  return {mapped:ready.length,qrAssigned:cells.filter(cell=>cell.qr_verified).length,qrPending:cells.filter(cell=>!cell.qr_verified).length,outputsRemaining:Math.max(0,outputs-ready.length)};
}
export function locationCompletion(counts,{deferLocations=false,simulation=false}={}){
  if(typeof deferLocations!=='boolean')throw new Error('Choose whether to continue location setup later.');
  if(!simulation&&!deferLocations&&(!counts.cells.length||counts.mapped!==counts.cells.length||counts.outputsRemaining>0))throw new Error('Save the remaining locations, or choose Set up locations later. QR codes can be assigned later.');
  return {locationCount:counts.cells.length,locationsDeferred:deferLocations,locationSetupReady:true};
}
export function setupSteps(mode,state={}){
  const steps=STEPS[mode]||[['choose','Get started']];
  return mode==='replace'&&state.resetMode&&state.resetMode!=='restore'&&state.keepHardware===false?[...steps.slice(0,-1),['locations','Locations & QR codes'],steps.at(-1)]:steps;
}
export function advance(state,step,patch={}){
  const steps=setupSteps(state.mode,state).map(([key])=>key),index=steps.indexOf(step);
  if(index<0||state.step!==step)throw new Error('This step changed. Refresh Setup before continuing.');
  return {...state,...patch,done:[...new Set([...state.done,step])],step:steps[index+1]||'finish',revision:state.revision+1};
}
export function publicSetupState(state){const {uploadedBackup,...safe}=state;return {...safe,...(uploadedBackup?{backupFile:{id:uploadedBackup.id,name:uploadedBackup.name,bytes:uploadedBackup.bytes}}:{})};}
export function requireRevision(state,input){if(Number(input.revision)!==state.revision)throw Object.assign(new Error('Setup changed in another window. Refresh and try again.'),{status:409});}
export function validPassword(value,label='Password'){if(typeof value!=='string'||value.length<12||value.length>200)throw new Error(label+' must contain 12–200 characters.');return value;}
export function currentControllerReplies(controllers,since,now=Date.now()){
  return controllers.length>0&&controllers.every(row=>{const seen=Date.parse(row.last_seen_at);return row.heartbeat_status==='online'&&Number.isFinite(seen)&&seen>=since-1000&&seen<=now+5000;});
}
export function commissioningSelection(controllers, selectedIds, deferConfirmed=false){
  if(selectedIds==null)return controllers;
  if(!Array.isArray(selectedIds)||new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!Number.isSafeInteger(id)||!controllers.some(row=>row.id===id)))throw new Error('The controller selection changed. Refresh status and choose controllers again.');
  if(!selectedIds.length)throw new Error('Select at least one controller to check. You can add the others later.');
  if(selectedIds.length<controllers.length&&deferConfirmed!==true)throw new Error('Confirm that the unselected controllers will be checked later.');
  return controllers.filter(row=>selectedIds.includes(row.id));
}
