import {usedSpace,protectedPicks} from './planning-policy.js';
import {createHash} from 'node:crypto';
import {historicalFactor} from './corrections.js';
import {can,assertCan} from '../access/catalog.js';
import {controlledCell,countBoundary} from '../stocktaking/accounting.js';

const round=n=>Math.round(n*1e6)/1e6;
const now=()=>new Date().toISOString();

// Aggregate final task totals. This module runs only inside command()'s transaction.
// Ledger history is append-only; settlements retain their original report attribution.
export function createTaskClosure({db,line,currentTask,progressToken,workQuantity,movement,insertReport,review,event,releaseTurn,syncReservations,taskProgress,assignmentEvent,markDiscrepancy}) {
 const lines=id=>db.prepare('SELECT id FROM task_lines WHERE task_id=? ORDER BY id').all(id).map(r=>line(r.id));
 const pending=id=>db.prepare("SELECT r.* FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received') ORDER BY r.id").all(id);
 const pendingCase=id=>pending(id).find(r=>JSON.parse(r.payload).taskClosure);
 const hasClosed=id=>!!db.prepare("SELECT 1 FROM work_events e JOIN task_lines l ON l.id=e.line_id WHERE l.task_id=? AND e.event_type='task_closed_actuals'").get(id);
 function totals(id){
  const rows=new Map();for(const l of lines(id)){if(l.execution_state==='superseded')continue;const row=rows.get(l.cell_id)||{cellId:l.cell_id,quantity:0,logical_code:l.logical_code};if(l.execution_state==='settled')row.quantity=round(row.quantity+l.actual_quantity);rows.set(l.cell_id,row);}return [...rows.values()];
 }
 function token(id){
  // Unrelated warehouse work must not invalidate a task confirmation. Stock and
  // competing reservations are validated from current balances inside the transaction.
  const state={progress:progressToken(id),products:db.prepare('SELECT DISTINCT p.id,p.unit_of_measure FROM products p JOIN task_lines l ON l.product_id=p.id WHERE l.task_id=? ORDER BY p.id').all(id)};
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
 }
 function rowsFor(t,input){
  if(!['yes','no'].includes(input.currentStatus))throw new Error('Choose Yes or No to confirm the current task status.');
  let rows=input.currentStatus==='yes'?totals(t.id):input.actuals;
  if(!Array.isArray(rows)||!rows.length||rows.length>200)throw new Error('Enter at least one actual location, including zero if nothing moved (maximum 200).');
  const ids=new Set();const normalized=rows.map(row=>{const cellId=Number(row.cellId),cell=db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);if(!cell||!Number.isInteger(cellId)||ids.has(cellId))throw new Error('Choose each actual location once.');ids.add(cellId);return {cellId,quantity:workQuantity(row.quantity)};});
  workQuantity(round(normalized.reduce((n,r)=>n+r.quantity,0)));return normalized;
 }
 function fresh(actor,input,supervisor=false){
  const t=currentTask(actor,input,supervisor?'review.resolve':false);
  if(!supervisor){assertCan(actor,'work.stop');if(t.assignee_id!==actor.id)throw new Error('Only the assigned operator can close this task. Send team work through authorized review.');}
  if(t.completed_at)throw new Error('This task is already closed. Refresh its recorded result.');
  if(input.progressToken!==progressToken(t.id)||input.closureToken!==token(t.id))throw new Error('Task or stock changed. Your draft is kept; reopen the latest task before confirming.');
  return t;
 }
 function finalize(actor,t,rows,input,supervisor=false,caseReport=null){
  const all=lines(t.id),first=all[0];if(!first||all.some(l=>l.product_id!==first.product_id||l.unit_of_measure!==first.unit_of_measure))throw new Error('Product or accounting units changed. Send for review; original movement units must be reconciled first.');
  let factor;try{factor=historicalFactor(db,first.product_id,first.unit_of_measure,t.started_at);}catch{throw new Error('Accounting units changed without reliable conversion history. Preserve the draft for review and reconcile product conversion history first.');}
  const unresolved=pending(t.id).filter(r=>r.id!==caseReport?.id);
  if(unresolved.some(r=>r.product_id!==first.product_id||r.direction!==t.type||r.unit!==first.unit_of_measure))throw new Error('Some pending evidence concerns another product, direction or unit. Resolve that original entry first; final task totals cannot replace it.');
  if(!supervisor&&(t.review_followup||unresolved.some(r=>(r.quantity_known===0?line(r.line_id).instruction_owner!==actor.id||!!db.prepare('SELECT 1 FROM work_instruction_history WHERE line_id=? AND assignee_id!=?').get(r.line_id,actor.id):r.performer_id!==actor.id||r.reporter_id!==actor.id)||r.product_id!==first.product_id||r.direction!==t.type||r.unit!==first.unit_of_measure)))throw new Error('Unverified movement needs a supervisor. Your draft is kept; choose Send for review.');
  if(!supervisor&&all.some(l=>l.execution_state==='working'&&l.instruction_owner!==actor.id))throw new Error('Earlier work belongs to another operator. Send for review.');
  if(!supervisor&&unresolved.length&&input.currentStatus==='yes')throw new Error('There are unverified entries beyond the recorded totals. Enter actual totals with No, or Send for review.');
  const wanted=new Map(rows.map(r=>[r.cellId,r.quantity])),prior=new Map(totals(t.id).map(r=>[r.cellId,r.quantity]));
  const cells=[...new Set([...wanted.keys(),...prior.keys()])],deltas=[];
  for(const cellId of cells){
   const actual=wanted.get(cellId)||0,previous=prior.get(cellId)||0,delta=round((actual-previous)*factor*(t.type==='pick'?-1:1));
   const cell=db.prepare('SELECT * FROM cells WHERE id=?').get(cellId),related=all.filter(l=>l.cell_id===cellId);
   if(controlledCell(db,cellId))throw new Error('A location has controlled stock under review. Keep this pending until that review is resolved.');
   if(!cell.active&&delta&&!supervisor)throw new Error('An actual location is inactive. Send for review before changing its stock.');
   const boundary=countBoundary(db,{cell_id:cellId},related.length===1?related[0]:null);
   const countId=input.countLinks?.[cellId];let accounted=false;
   if(countId){
    if(!supervisor)throw new Error('Only an authorized verifier can link stocktake accounting.');
    const count=db.prepare('SELECT o.*,i.cell_id FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id JOIN stocktake_settlements s ON s.observation_id=o.id WHERE o.id=?').get(countId),item=count?JSON.parse(count.lines_json).find(l=>l.productId===first.product_id):null;
    const used=Number(db.prepare('SELECT COALESCE(SUM(ABS(COALESCE(x.accounted_delta,r.quantity))),0) q FROM stocktake_movement_links x JOIN work_reports r ON r.id=x.report_id WHERE x.observation_id=? AND r.product_id=?').get(countId,first.product_id).q);
    if(!delta||!item||count.cell_id!==cellId||item.unit!==first.current_unit||Math.sign(item.difference)!==Math.sign(delta)||Math.abs(delta)+used>Math.abs(item.difference)+1e-9)throw new Error('The selected stocktake does not account for this location, unit and correction difference.');
    accounted=true;
   }
   if(delta&&related.some(l=>db.prepare("SELECT 1 FROM work_events WHERE line_id=? AND event_type IN ('allocation_accounted_elsewhere','movement_accounted_by_stocktake')").get(l.id))&&!accounted)throw new Error('Earlier totals are accounted for elsewhere. Link the corresponding count correction or reconcile the original accounting before changing them.');
   if(delta&&boundary&&!accounted&&!(supervisor&&input.afterCountVerified===true))throw new Error(`Stocktaking may already include this movement at ${cell.logical_code}. Open the original evidence below and match it to the stock count before saving, so the quantity is not changed twice.`);
   if(!supervisor&&db.prepare("SELECT 1 FROM work_reports r LEFT JOIN task_lines l ON l.id=r.line_id WHERE r.cell_id=? AND r.status IN ('review','received') AND (l.task_id IS NULL OR l.task_id!=?)").get(cellId,t.id))throw new Error('Other uncertain movement exists at this location. Keep this task pending for review.');
   const bal=Number(db.prepare('SELECT available_quantity q FROM inventory_balances WHERE product_id=? AND cell_id=?').get(first.product_id,cellId)?.q||0);
   const held=kind=>Number(db.prepare("SELECT COALESCE(SUM(r.quantity),0) q FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE r.state='held' AND r.kind=? AND l.cell_id=? AND l.task_id!=? AND (?='put' OR l.product_id=?)").get(kind,cellId,t.id,kind,first.product_id).q);
   const stockDelta=accounted?0:delta,next=round(bal+stockDelta),occupied=Number(db.prepare('SELECT COALESCE(SUM(available_quantity),0) q FROM inventory_balances WHERE cell_id=?').get(cellId).q);
   // Final physical totals may supersede reservations, never physical stock limits.
   // Check every location before posting any movement (the caller owns the transaction).
   if(next< -1e-9&&stockDelta<0)throw new Error(t.type==='pick'?`${cell.logical_code}: actual pick ${actual} ${first.unit_of_measure} exceeds the stock available for this task (${round(previous+bal/factor)} ${first.unit_of_measure}, including ${previous} already recorded). Check the location and quantity, or correct its stock count before saving.`:`${cell.logical_code}: reducing the put quantity would leave stock below zero. Check the location and final quantity, or correct its stock count before saving.`);
   if(stockDelta>0&&usedSpace(db,cellId,{reservations:false})+stockDelta/first.items_per_cell>1+1e-9)throw new Error(`${cell.logical_code}: this quantity exceeds the location capacity of ${first.items_per_cell} ${first.current_unit}. Check the location and quantity, or correct the capacity before saving.`);
   if(next<protectedPicks(db,cellId,first.product_id,0,t.id)-1e-9||stockDelta>0&&usedSpace(db,cellId,{excludingTask:t.id})+stockDelta/first.items_per_cell>1+1e-9){if(!supervisor&&input.alignPhysical!==true)throw new Error('Actual totals conflict with another reservation. Open Review to align the verified physical movement.');markDiscrepancy(cellId,first.product_id,'Verified task closure conflicts with another task reservation. Other task claims remain intact.');}
   if(stockDelta>0&&!t.allow_mixed_put&&(db.prepare('SELECT 1 FROM inventory_balances WHERE cell_id=? AND product_id!=? AND available_quantity>0').get(cellId,first.product_id)||db.prepare("SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE r.state='held' AND r.kind='put' AND l.cell_id=? AND l.product_id!=? AND l.task_id!=?").get(cellId,first.product_id,t.id))){if(!supervisor)throw new Error('Actual totals conflict with another product at this location. Send for review.');markDiscrepancy(cellId,first.product_id,'Verified task closure leaves mixed products. Reconcile this location.');}
   deltas.push({cellId,actual,previous,delta,accounted,countId:countId||null});
  }
  const originalPerformers=[...new Set(db.prepare('SELECT r.performer_id FROM work_settlements s JOIN task_lines l ON l.id=s.line_id JOIN work_reports r ON r.id=s.report_id WHERE l.task_id=?').all(t.id).map(r=>r.performer_id))];
  const fallback=supervisor||originalPerformers.some(id=>id!==actor.id)?null:actor.id;
  for(const {cellId,actual,previous,delta,accounted,countId} of deltas){
   let candidates=all.filter(l=>l.cell_id===cellId&&l.execution_state!=='superseded');
   if(!candidates.length&&actual>0){const id=Number(db.prepare("INSERT INTO task_lines(task_id,product_id,cell_id,planned_quantity,guidance_color,unit_of_measure,execution_state,instruction_owner,assignment_generation) VALUES(?,?,?,0,?,?,'ready',?,?)").run(t.id,first.product_id,cellId,t.type==='pick'?'green':'red',first.unit_of_measure,t.assignee_id,t.assignment_generation).lastInsertRowid);const l=line(id);all.push(l);candidates=[l];}
   let remaining=actual;const allocations=candidates.map(l=>{const quantity=Math.min(remaining,l.execution_state==='settled'?l.actual_quantity:0);remaining=round(remaining-quantity);return {l,quantity};});
   if(remaining&&allocations.length)allocations[0].quantity=round(allocations[0].quantity+remaining);
   // Post each line's correction separately so each original performer remains attributable.
   for(const {l,quantity} of allocations){
    const settlement=db.prepare('SELECT s.*,r.performer_id FROM work_settlements s JOIN work_reports r ON r.id=s.report_id WHERE s.line_id=?').get(l.id),old=l.execution_state==='settled'?l.actual_quantity:0;
    const performer=settlement?settlement.performer_id:fallback;
    const change=round((quantity-old)*factor*(t.type==='pick'?-1:1));
    if(change&&!accounted)movement({actor,performer,productId:first.product_id,cellId,quantity:change,type:'adjustment',taskId:t.id,lineId:l.id,origin:`task-close:${input.requestId}:${l.id}`,reason:input.verification||'Final actual task total confirmed by assigned operator',unit:first.current_unit});
    if(!settlement){const report=insertReport(actor,{quantity,cellId,performerId:supervisor?(performer??'unknown'):actor.id,origin:`task-close:${input.requestId}:${l.id}`,reason:'Final actual total at task closure'},l);db.prepare("UPDATE work_reports SET status='posted',performer_id=?,resolved_at=?,resolver_id=?,verification=? WHERE id=?").run(performer,now(),supervisor?actor.id:null,input.verification||'Operator confirmed actual totals',report.id);db.prepare('INSERT INTO work_settlements(line_id,report_id,quantity,cell_id,unit,created_at) VALUES(?,?,?,?,?,?)').run(l.id,report.id,quantity,cellId,first.unit_of_measure,now());db.prepare('INSERT INTO work_origins(origin_ref,report_id) VALUES(?,?)').run(report.origin_ref,report.id);}else db.prepare('UPDATE work_settlements SET quantity=? WHERE line_id=?').run(quantity,l.id);
    db.prepare("UPDATE task_lines SET actual_quantity=?,exception_quantity=?,execution_state='settled',revision=revision+1,note=? WHERE id=?").run(quantity,Math.max(0,round(l.planned_quantity-quantity)),input.verification||'Task closed with confirmed actual totals',l.id);
    if(accounted)event('movement_accounted_by_stocktake',actor,l.id,{observationId:countId,verification:input.verification,taskClosure:true});
    event('task_close_line_reconciled',actor,l.id,{previous:old,actual:quantity,delta:change,performer,requestId:input.requestId});
   }
   if(accounted){const r=insertReport(actor,{quantity:actual,cellId,performerId:'unknown',origin:`closure-count:${input.requestId}:${cellId}`,reason:input.verification},candidates[0]||first);db.prepare("UPDATE work_reports SET status='duplicate',resolver_id=?,resolved_at=?,verification=? WHERE id=?").run(actor.id,now(),input.verification,r.id);db.prepare('INSERT INTO stocktake_movement_links(report_id,observation_id,actor_id,evidence,created_at,accounted_delta) VALUES(?,?,?,?,?,?)').run(r.id,countId,actor.id,input.verification,now(),delta);}
  }
  for(const l of all){db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(l.id);releaseTurn(l);if(!['settled','superseded'].includes(line(l.id).execution_state))db.prepare("UPDATE task_lines SET execution_state='cancelled',revision=revision+1 WHERE id=?").run(l.id);}
  for(const r of pending(t.id)){db.prepare("UPDATE work_reports SET status='resolved',resolver_id=?,resolved_at=?,verification=?,case_revision=case_revision+1 WHERE id=?").run(actor.id,now(),input.verification||'Reconciled against confirmed final task totals',r.id);event('task_close_evidence_reconciled',actor,r.line_id,{original:JSON.parse(r.payload),actuals:rows},r.id);}
  db.prepare('UPDATE tasks SET stop_requested=1,assignment_generation=assignment_generation+1 WHERE id=?').run(t.id);
  event('task_closed_actuals',actor,first.id,{taskId:t.id,actuals:rows,deltas,accountingUnit:first.current_unit,taskUnit:first.unit_of_measure,conversionFactor:factor,supervisor,verification:input.verification||null,requestId:input.requestId});assignmentEvent(actor,t.id,'closed_actuals',t.assignee_id,{actuals:rows});syncReservations();taskProgress(t.id);
  return {status:'recorded',taskId:t.id,closed:true,reportId:caseReport?.id,message:'Task closed with confirmed actual movement. Remaining reservations released.'};
 }
 function attest(input){
  if(input.workerStopped!==true)throw new Error('Confirm all workers stopped and the actual totals are verified.');
  const attestation='Checkbox attestation: all workers have stopped and the actual totals are verified.';
  const legacy=String(input.verification||'').trim();
  return {...input,verification:legacy?`${attestation} Additional verification: ${legacy}`:attestation};
 }
 function close(actor,input){
  const supervisor=input.verifiedClosure===true;
  if(supervisor){assertCan(actor,'review.resolve');assertCan(actor,'review.stop');input=attest(input);}
  const t=fresh(actor,input,supervisor);if(t.assignee_id!==actor.id)assertCan(actor,'work.teamStop');
  if((t.explicit_close||input.taskFinish===true)&&!supervisor&&lines(t.id).some(l=>['ready','working'].includes(l.execution_state)))throw new Error('Finish each remaining location, or choose Complete Task and confirm supervisor review for unfinished work.');
  if(pendingCase(t.id))throw new Error('Task closure is already awaiting supervisor review. Open that case.');
  const rows=rowsFor(t,input);
  if(input.finalTaskCompletion===true||input.finalTaskCompletion==='true'){
   const actual=round(rows.reduce((sum,row)=>sum+row.quantity,0));
   if(actual!==t.requested_quantity)throw new Error('Actual total differs from the requested quantity. Send this task for supervisor review.');
  }
  return finalize(actor,t,rows,input,supervisor);
 }
 function requestReview(actor,t,actuals,requestId,automatic=false,currentStatus='yes'){
  const first=lines(t.id)[0],perCell=t.explicit_close===1;const r=insertReport(actor,{quantity:workQuantity(round(actuals.reduce((n,r)=>n+r.quantity,0))),origin:`task-closure:${requestId}`,taskClosure:true,actuals,currentStatus,reason:automatic?'All locations recorded with less than the requested quantity':perCell?'Unfinished locations submitted for supervisor decision':'Final task movement totals submitted for review'},first,true);
  db.prepare('UPDATE work_reports SET performer_id=NULL WHERE id=?').run(r.id);
  review(r,automatic?'All locations are recorded, but the task total is short. A supervisor can assign the remainder or close it as recorded.':perCell?'Unfinished locations need a supervisor decision. Completed cell movements remain recorded.':'Task closure requested. Verify all final location totals together; no stock correction has been posted.');db.prepare('UPDATE tasks SET stop_requested=1,assignment_generation=assignment_generation+1 WHERE id=?').run(t.id);assignmentEvent(actor,t.id,'closure_review_requested',t.assignee_id,{reportId:r.id,actuals,automatic});return {status:'review',taskId:t.id,reportId:r.id,message:automatic?'All locations recorded. The remaining quantity needs a supervisor decision.':perCell?'Unfinished work sent to supervisor. Completed cell movements remain recorded.':'Sent for review. Actual entries are saved; the task is not closed and stock is not confirmed.'};
 }
 function send(actor,input){
  const team=can(actor,'work.teamStop');let t;if(team){t=currentTask(actor,input);if(t.completed_at||input.progressToken!==progressToken(t.id)||input.closureToken!==token(t.id))throw new Error('Task changed. Refresh before requesting review.');}else t=fresh(actor,input);
  if(input.taskFinish===true&&input.unfinishedConfirmed!==true)throw new Error('Confirm that the unfinished work should go to a supervisor.');
  if(pendingCase(t.id))throw new Error('Task closure is already awaiting supervisor review.');
  return requestReview(actor,t,rowsFor(t,input),input.requestId,false,input.currentStatus);
 }
 function sendAutomatically(actor,taskId,requestId){
  const t=db.prepare('SELECT * FROM tasks WHERE id=? AND workflow_version=2').get(taskId);
  if(!t||!t.explicit_close||t.completed_at||t.stop_requested||t.review_followup||pending(t.id).length)return null;
  const all=lines(t.id).filter(l=>l.execution_state!=='superseded');
  const actual=round(all.reduce((n,l)=>n+(l.execution_state==='settled'?l.actual_quantity:0),0));
  if(!all.some(l=>l.execution_state==='settled')||all.some(l=>['ready','working'].includes(l.execution_state))||actual>=t.requested_quantity)return null;
  return requestReview(actor,t,rowsFor(t,{currentStatus:'yes'}),requestId,true);
 }
 function resolve(actor,input,report){assertCan(actor,'review.resolve');assertCan(actor,'review.stop');if(input.keepOpen)return null;const t=fresh(actor,input,true);if(report.line_id==null||line(report.line_id).task_id!==t.id)throw new Error('This review belongs to another task.');input=attest(input);return finalize(actor,t,rowsFor(t,input),input,true,report);}
 return {close,send,sendAutomatically,resolve,totals,token,pendingCase,hasClosed};
}
