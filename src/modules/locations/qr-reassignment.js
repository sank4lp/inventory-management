import {randomUUID} from 'node:crypto';
import {displayOwner} from '../operations/guidance.js';
import {guardSetupChange} from '../operations/guards.js';
import {describeLocation} from '../operations/location-contract.js';

export function createQrReassignment({db,label,event,clearOldLabel}) {
 const now=()=>new Date().toISOString();
 const cell=id=>{const c=db.prepare('SELECT * FROM cells WHERE id=? AND active=1').get(Number(id));if(!c)throw new Error('Location is no longer available. Reopen Manage Locations.');return c;};
 const name=c=>describeLocation(db,c.id).name;
 function guard(c){
  if(!c)throw new Error('Location is no longer available. Reopen Manage Locations.');
  if(displayOwner(db,c.id)?.kind==='count')throw new Error('Finish or pause counting '+name(c)+' before changing its QR.');
  guardSetupChange(db,{cellId:c.id});
 }
 function conflict(l,target){
  if(l.state!=='bound'||l.cell_id===target?.id)return;
  const source=db.prepare('SELECT * FROM cells WHERE id=?').get(l.cell_id);
  const error=new Error('QR reassignment is not allowed yet. This QR already belongs to another location: '+name(source)+'. Go there and confirm its current QR, then assign a replacement QR in Manage Locations first.');
  error.code='QR_ASSIGNED';
  error.qrConflict={sourceCellId:source.id,sourceName:name(source),targetCellId:target?.id||null,targetName:target?name(target):'this light',labelToken:l.token};
  throw error;
 }
 function available(l){
  const transfer=db.prepare("SELECT * FROM location_qr_reassignments WHERE label_token=? AND status='ready'").get(l.token);
  if(transfer){const error=new Error('This QR is reserved for a reassignment. Finish it in Manage Locations.');error.code='QR_REASSIGNMENT_PENDING';error.transferId=transfer.id;error.targetCellId=transfer.target_cell_id;throw error;}
 }
 function fresh(c,labelId,revision){
  if(c.label_id!==labelId||c.label_revision!==Number(revision))throw new Error('Location QR changed. Reopen Manage Locations and check both locations.');
 }
 function bind(l,c,a){
  db.prepare('UPDATE cells SET label_id=?,label_revision=?,description_revision=description_revision+1 WHERE id=?').run(l.token,l.revision,c.id);
  db.prepare("UPDATE location_labels SET state='bound',cell_id=?,bound_at=?,bound_by=?,scanned_at=? WHERE token=?").run(c.id,now(),a.id,now(),l.token);
 }
 function repair(a,i){
  const source=cell(i.sourceCellId),target=cell(i.targetCellId);
  if(source.id===target.id)throw new Error('Choose two different locations.');
  fresh(source,i.sourceLabelId,i.sourceLabelRevision);fresh(target,i.targetLabelId,i.targetLabelRevision);
  if(i.sourceConfirmed!==true||i.replacementConfirmed!==true)throw new Error('Confirm you are at the original location and its replacement sticker is attached.');
  const old=label(i.sourceQr);
  if(old.state!=='bound'||old.cell_id!==source.id||old.token!==source.label_id)throw new Error('Scan the current QR at '+name(source)+' before replacing it.');
  if(db.prepare("SELECT 1 FROM location_qr_reassignments WHERE target_cell_id=? AND status='ready'").get(target.id))throw new Error('Finish or cancel this location’s pending QR reassignment first.');
  const replacement=label(i.label,{enroll:true});available(replacement);conflict(replacement,source);
  if(replacement.token===old.token||replacement.state!=='unbound')throw new Error('Use a new, unassigned replacement QR at '+name(source)+'.');
  guard(source);guard(target);
  // The original cell keeps its identity and stock; only its sticker changes.
  db.prepare("UPDATE location_labels SET state='unbound',cell_id=NULL,scanned_at=NULL WHERE token=?").run(old.token);
  bind(replacement,source,a);
  const id=randomUUID();
  db.prepare("INSERT INTO location_qr_reassignments(id,label_token,source_cell_id,target_cell_id,replacement_token,replacement_revision,target_label_id,target_label_revision,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,old.token,source.id,target.id,replacement.token,replacement.revision,target.label_id,target.label_revision,a.id,now());
  event(a,'qr_reassignment_source_repaired',{transferId:id,sourceCellId:source.id,targetCellId:target.id,oldToken:old.token,replacementToken:replacement.token,sourceQrConfirmed:true,replacementConfirmed:true});
  return {status:'recorded',transferId:id,sourceCellId:source.id,targetCellId:target.id,message:'Replacement QR saved at '+name(source)+'. Go to '+name(target)+' and scan the released QR there.'};
 }
 function transfer(id){
  const row=db.prepare("SELECT * FROM location_qr_reassignments WHERE id=? AND status='ready'").get(String(id));
  if(!row)throw new Error('This QR reassignment is already finished or unavailable. Refresh Manage Locations.');
  return row;
 }
 function complete(a,i){
  const row=transfer(i.transferId),source=cell(row.source_cell_id),target=cell(row.target_cell_id);
  fresh(source,row.replacement_token,row.replacement_revision);fresh(target,row.target_label_id,row.target_label_revision);fresh(target,i.labelId,i.labelRevision);
  if(Number(i.cellId)!==target.id||i.confirmed!==true)throw new Error('Scan and confirm the released QR at the intended destination.');
  const qr=label(i.label),replacement=db.prepare('SELECT * FROM location_labels WHERE token=?').get(row.replacement_token);
  if(!replacement||replacement.state!=='bound'||replacement.cell_id!==source.id)throw new Error('Check the replacement QR at the original location again.');
  if(qr.token!==row.label_token||qr.state!=='unbound')throw new Error('Scan the QR released by this reassignment.');
  guard(target);clearOldLabel(target,a);bind(qr,target,a);
  db.prepare("UPDATE location_qr_reassignments SET status='completed',resolved_by=?,resolved_at=? WHERE id=?").run(a.id,now(),row.id);
  event(a,'qr_reassigned',{transferId:row.id,sourceCellId:source.id,targetCellId:target.id,token:qr.token,replacementToken:replacement.token});
  return {status:'recorded',message:'QR reassigned. Both locations keep their stock and history.'};
 }
 function cancel(a,i){
  const row=transfer(i.transferId);
  if(i.confirmed!==true)throw new Error('Confirm cancellation. The released QR will be retired; the replacement QR stays at the original location.');
  db.prepare("UPDATE location_labels SET state='revoked' WHERE token=? AND state='unbound'").run(row.label_token);
  db.prepare("UPDATE location_qr_reassignments SET status='cancelled',resolved_by=?,resolved_at=? WHERE id=?").run(a.id,now(),row.id);
  event(a,'qr_reassignment_cancelled',{transferId:row.id,sourceCellId:row.source_cell_id,targetCellId:row.target_cell_id,token:row.label_token});
  return {status:'recorded',message:'Reassignment cancelled. The replacement QR and both locations’ stock are unchanged.'};
 }
 function snapshot(){
  return db.prepare("SELECT * FROM location_qr_reassignments WHERE status='ready' ORDER BY created_at").all().map(row=>({...row,sourceName:describeLocation(db,row.source_cell_id).name,targetName:describeLocation(db,row.target_cell_id).name}));
 }
 return {guard,conflict,available,repair,complete,cancel,snapshot};
}
