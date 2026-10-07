import {protectedPicks,putRoom,usedSpace,taskPrioritySql,yieldableClaim,reviewClaim} from './planning-policy.js';
import {createPlanningRecovery} from './planning-recovery.js';
import {createWorkHistory} from './history.js';
import {createTaskClosure} from './task-closure.js';
import {guidanceBinding,displayOwner,waitingMessage} from './guidance.js';
import {taskSelection,reviewSelection,workloads,returnedSelection} from './queries.js';
import {postMovement} from "../inventory/ledger.js";
import {currentActor,effectiveUser} from "../access/service.js";
import {can,assertCan,workTabs} from "../access/catalog.js";
import { describeLocation, validLocationLabel, saveLocationDescription } from "./location-contract.js";
import { workCapabilities } from "./access.js";
import { readPendingReviewTimeoutSettings, savePendingReviewTimeoutSettings } from "../../services/task-timeout-settings.js";
import { historicalFactor } from "./corrections.js";
import {controlledCell,countBoundary} from '../stocktaking/accounting.js';
import { createHash, randomUUID } from "node:crypto";
import { withTransaction } from "../../db.js";
import { createTaskRepository } from "../../repositories/task-repository.js";

const now = () => new Date().toISOString();
const rounded = (n) => Math.round(n * 1e6) / 1e6;
export function workQuantity(value, positive = false) {
  if (value === null || value === undefined || String(value).trim() === "") throw new Error("Enter an actual quantity; blank is different from zero.");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e9 || (positive && n === 0) || Math.abs(n - rounded(n)) > 1e-9) {
    throw new Error("Use a non-negative quantity with at most six decimal places (maximum 1 billion).");
  }
  return rounded(n);
}
const canonical = (value) => JSON.stringify(value, function(key, v) {
  return v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});

export function createOperationsService({ db, hardwareService = null, logger = null }) {
  const tasks = createTaskRepository(db);
  const metadata = (key) => db.prepare("SELECT value FROM app_metadata WHERE key=?").get(key)?.value;
  const identity = () => ({ site: metadata("warehouse_identity"), dataset: metadata("dataset_generation") });
  const event = (type, actor, lineId, payload, reportId = null) => db.prepare(
    "INSERT INTO work_events(line_id,report_id,actor_id,event_type,payload,created_at) VALUES(?,?,?,?,?,?)",
  ).run(lineId || null, reportId, actor?.id || null, type, JSON.stringify(payload), now());

  function actorNow(actor, permission = false) {
    return currentActor(db,actor,permission === true ? 'review.resolve' : permission || undefined);
  }
  function line(id) {
    const value = db.prepare(`SELECT l.*, t.created_by, t.type, t.workflow_version, t.status AS task_status,
      t.started_at AS task_started_at, t.allow_mixed_put, t.plan_revision, t.attention,t.review_followup, t.completed_at, t.assignee_id, t.assignment_state, t.assignment_generation AS current_generation, t.requested_quantity, p.name AS product_name, p.sku, p.items_per_cell,
      p.unit_of_measure AS current_unit, c.logical_code, c.guidance_mode, c.active AS cell_active,
      c.controller_id, c.hardware_channel, c.binding_revision, c.label_id, c.label_revision, ctrl.address AS controller_address
      FROM task_lines l JOIN tasks t ON t.id=l.task_id JOIN products p ON p.id=l.product_id
      JOIN cells c ON c.id=l.cell_id LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE l.id=?`).get(Number(id));
    if (!value) throw new Error("Allocation not found.");
    return value;
  }
  function own(actor, allocation) {
    if (!can(actor,"work.teamStop") && actor.id !== allocation.assignee_id) throw new Error("You can act only on your own allocations.");
  }
  function held(cellId, productId, kind, excluding = 0) {
    return rounded(Number(db.prepare(`SELECT COALESCE(SUM(r.quantity),0) AS qty FROM work_reservations r
      JOIN task_lines l ON l.id=r.line_id WHERE r.state='held' AND r.kind=? AND l.cell_id=?
      AND (? IS NULL OR l.product_id=?) AND l.id!=?`).get(kind, cellId, productId, productId, excluding)?.qty || 0));
  }
  function balance(productId, cellId) {
    return Number(db.prepare("SELECT available_quantity FROM inventory_balances WHERE product_id=? AND cell_id=?").get(productId, cellId)?.available_quantity || 0);
  }
  function occupancy(cellId) {
    return Number(db.prepare("SELECT COALESCE(SUM(available_quantity),0) AS qty FROM inventory_balances WHERE cell_id=?").get(cellId).qty);
  }
  function compatible(cellId, productId, excluding = 0, protectUnstarted = false) {
    return !db.prepare("SELECT 1 FROM inventory_balances WHERE cell_id=? AND product_id!=? AND available_quantity>0").get(cellId, productId)
      && !db.prepare(`SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id JOIN tasks t ON t.id=l.task_id
        WHERE r.state='held' AND r.kind='put' AND l.cell_id=? AND l.product_id!=? AND l.id!=? AND NOT ${protectUnstarted?reviewClaim():yieldableClaim()}`).get(cellId, productId, excluding);
  }
  function syncReservations() {
    db.exec(`UPDATE inventory_balances SET reserved_quantity=COALESCE((SELECT SUM(r.quantity)
      FROM work_reservations r JOIN task_lines l ON l.id=r.line_id
      WHERE r.state='held' AND r.kind='pick' AND l.product_id=inventory_balances.product_id
      AND l.cell_id=inventory_balances.cell_id),0)`);
  }
  function taskProgress(taskId) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    const lines = db.prepare("SELECT * FROM task_lines WHERE task_id=? AND execution_state!='superseded'").all(taskId);
    const open = lines.some(l=>['ready','working'].includes(l.execution_state));
    const review = db.prepare(`SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id
      WHERE l.task_id=? AND r.status IN ('review','received')`).get(taskId);
    const actual = rounded(lines.reduce((n,l)=>n+(l.execution_state==='settled'?l.actual_quantity:0),0));
    const returned = t.assignment_state==='returned' && !t.stop_requested;
    const needsFinalReview = !t.stop_requested && (
      t.explicit_close && actual < t.requested_quantity ||
      t.review_followup && (t.review_remaining_quantity > 0 || actual < t.requested_quantity)
    );
    const outcome = review?'needs_review':returned?'needs_assignment':open||needsFinalReview?'open':actual >= t.requested_quantity && actual>0?'completed':actual>0?'stopped':'cancelled';
    const closed = ['completed','stopped','cancelled'].includes(outcome);
    if(closed&&!t.completed_at)event('task_completed',null,null,{taskId,outcome,quantity:actual});
    db.prepare('UPDATE tasks SET status=?,outcome=?,attention=?,completed_at=?,last_touched_at=? WHERE id=?')
      .run(closed?(outcome==='completed'?'completed':'cancelled'):'pending_review',outcome,review?1:0,closed?(t.completed_at||now()):null,now(),taskId);
  }
  // Earlier versions left fully recorded cell-by-cell tasks open until a second tap.
  for(const {id} of db.prepare(`SELECT t.id FROM tasks t WHERE t.workflow_version=2
    AND t.explicit_close=1 AND t.completed_at IS NULL AND t.stop_requested=0
    AND t.assignment_state!='returned' AND t.review_followup=0 AND t.requested_quantity>0
    AND (SELECT COALESCE(SUM(l.actual_quantity),0) FROM task_lines l
      WHERE l.task_id=t.id AND l.execution_state='settled')>=t.requested_quantity
    AND NOT EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=t.id AND l.execution_state IN ('ready','working'))
    AND NOT EXISTS(SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id
      WHERE l.task_id=t.id AND r.state='held')
    AND NOT EXISTS(SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id
      WHERE l.task_id=t.id AND r.status IN ('review','received'))`).all())withTransaction(db,()=>taskProgress(id));
  const closure=createTaskClosure({db,line,currentTask,progressToken,workQuantity,movement:(input)=>movement(input),insertReport,review,event,releaseTurn,syncReservations,taskProgress,assignmentEvent,markDiscrepancy});
  for(const {id,assignee_id} of db.prepare(`SELECT t.id,t.assignee_id FROM tasks t WHERE t.workflow_version=2
    AND t.explicit_close=1 AND t.completed_at IS NULL AND t.stop_requested=0 AND t.review_followup=0
    AND t.requested_quantity>(SELECT COALESCE(SUM(l.actual_quantity),0) FROM task_lines l
      WHERE l.task_id=t.id AND l.execution_state='settled')
    AND EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=t.id AND l.execution_state='settled')
    AND NOT EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=t.id AND l.execution_state IN ('ready','working'))
    AND NOT EXISTS(SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id
      WHERE l.task_id=t.id AND r.state='held')
    AND NOT EXISTS(SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id
      WHERE l.task_id=t.id AND r.status IN ('review','received'))`).all()){
    const actor=db.prepare('SELECT * FROM users WHERE id=?').get(assignee_id);
    if(actor)withTransaction(db,()=>closure.sendAutomatically(actor,id,`auto-reconcile-${id}`));
  }
  function captureInstruction(id) {
    const l=line(id);
    const description=describeLocation(db,l.cell_id);
    const context={...description,productId:l.product_id,quantity:l.planned_quantity,unit:l.unit_of_measure,type:l.type};
    db.prepare('UPDATE task_lines SET instruction_snapshot=?,instruction_owner=?,assignment_generation=? WHERE id=?')
      .run(JSON.stringify(context),l.assignee_id,l.current_generation,l.id);
    db.prepare('INSERT OR IGNORE INTO work_instruction_history(line_id,revision,assignee_id,assignment_generation,snapshot,created_at) VALUES(?,?,?,?,?,?)')
      .run(l.id,l.revision,l.assignee_id,l.current_generation,JSON.stringify(context),now());
  }
  function executeOwner(actor,l,input) {
    if(actor.id!==l.assignee_id) throw new Error('Only the current assigned operator can execute this work. Reassign eligible work first.');
    if(input.assignmentGeneration!=null && Number(input.assignmentGeneration)!==l.current_generation) throw new Error('This assignment changed. Refresh before continuing.');
    if(l.review_followup)throw new Error('Check moved quantity first. This assignment is for observation only until verified.');
    if(l.assignment_state==='offered') throw new Error('Start task before arriving at a location.');
  }
  function hasEvidence(id) {return Boolean(db.prepare("SELECT 1 FROM work_reports WHERE line_id=? AND status IN ('review','received')").get(id));}
  function setGuidance(cellId, desired) {
    db.prepare(`INSERT INTO work_guidance(cell_id,generation,desired,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(cell_id) DO UPDATE SET generation=excluded.generation,desired=excluded.desired,delivered=0,updated_at=excluded.updated_at`)
      .run(cellId, randomUUID(), JSON.stringify(desired), now());
  }
  function releaseTurn(allocation) {
    db.prepare("DELETE FROM cell_turns WHERE line_id=?").run(allocation.id);
    // Reconciliation after the transaction elects the next display without clearing a newer owner.
  }
  function instructionProblem(l){
    if(l.instruction_snapshot&&JSON.parse(l.instruction_snapshot).bindingRevision!==l.binding_revision)return 'Location mapping changed. Ask a supervisor to update these instructions before new work.';
    if(!l.cell_active)return 'Location is inactive. Ask a supervisor to update this task.';
    if(controlledCell(db,l.cell_id))return 'Stock is under condition review. Ask a supervisor before continuing.';
    if(hasEvidence(l.id))return 'This task needs a quantity check. Report work already performed; do not repeat it.';
    if(l.current_unit!==l.unit_of_measure)return 'The product unit changed. Ask a supervisor to reconcile these instructions.';
    if(db.prepare('SELECT 1 FROM work_discrepancies WHERE cell_id=? AND product_id=?').get(l.cell_id,l.product_id))return 'Stock at this location needs reconciliation before new work.';
    const r=db.prepare("SELECT quantity FROM work_reservations WHERE line_id=? AND state='held'").get(l.id);
    if(!r||r.quantity<l.planned_quantity)return 'This task no longer has its expected reservation. Refresh or ask a supervisor.';
    if(l.type==='pick'&&balance(l.product_id,l.cell_id)+1e-9<protectedPicks(db,l.cell_id,l.product_id))return 'Recorded stock cannot cover the reserved picks. Ask a supervisor to reconcile stock.';
    if(l.type==='put'&&((!l.allow_mixed_put&&!compatible(l.cell_id,l.product_id))||usedSpace(db,l.cell_id,{protectActiveOnly:true})>1+1e-9))return 'Recorded put capacity cannot cover these reservations. Ask a supervisor to reconcile capacity.';
    return null;
  }
  function reconcileGuidance() {
    const cells=db.prepare("SELECT cell_id FROM work_guidance UNION SELECT cell_id FROM task_lines WHERE execution_state IN ('ready','working') UNION SELECT i.cell_id FROM stocktake_display_claims c JOIN stocktake_items i ON i.id=c.item_id").all();
    for(const {cell_id:cellId} of cells){
      const previous=db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(cellId),old=previous?JSON.parse(previous.desired):null;
      const c=db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);if(!c)continue;
      const binding=guidanceBinding(db,cellId);
      const candidates=db.prepare(`SELECT l.id FROM task_lines l JOIN tasks t ON t.id=l.task_id JOIN work_reservations r ON r.line_id=l.id
        WHERE l.cell_id=? AND l.execution_state IN ('ready','working') AND l.planned_quantity>0 AND r.state='held'
        AND t.workflow_version=2 AND t.assignment_state='started' AND t.guidance_paused=0 AND t.review_followup=0 AND t.completed_at IS NULL AND t.stop_requested=0
        AND NOT EXISTS(SELECT 1 FROM work_reports w WHERE w.line_id=l.id AND w.status IN ('review','received'))
        ORDER BY COALESCE(t.started_at,t.assigned_at),l.id`).all(cellId).map(({id})=>line(id)).filter(l=>can(effectiveUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(l.assignee_id)),'work.execute')&&!instructionProblem(l));
      const counts=db.prepare(`SELECT cl.*,i.run_id,i.cell_id FROM stocktake_display_claims cl JOIN stocktake_items i ON i.id=cl.item_id JOIN stocktake_runs r ON r.id=i.run_id
        WHERE i.cell_id=? AND i.generation=cl.generation AND i.assignee_id=cl.actor_id AND i.state IN ('pending','counting','skipped','recheck') AND r.status NOT IN ('closed','completed') ORDER BY cl.requested_at,cl.item_id`).all(cellId).filter(v=>can(effectiveUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(v.actor_id)),'count.perform'));
      // Preserve an existing display. Arrival never preempts it, including shared-locator cells.
      const existing=candidates.find(l=>l.id===old?.lineId),existingCount=counts.find(i=>i.item_id===old?.itemId&&i.generation===old?.itemGeneration);
      const countFirst=!existing&&!existingCount&&counts[0]&&(!candidates[0]||counts[0].requested_at<candidates[0].task_started_at);
      // A paused operator may already have moved stock here. Protect that
      // physical turn while leaving the display dark until an explicit resume.
      const pausedTurn=db.prepare(`SELECT 1 FROM cell_turns turn JOIN task_lines l ON l.id=turn.line_id JOIN tasks t ON t.id=l.task_id
        WHERE turn.cell_id=? AND t.guidance_paused=1 AND l.execution_state='working'`).get(cellId);
      const owner=pausedTurn?null:existing||(!existingCount&&!countFirst?candidates[0]:null),count=pausedTurn?null:existingCount||(!owner?counts[0]:null);
      const desired=!c.active?old?{action:'clear',binding:old.binding||binding}:null:count?{action:'count',itemId:count.item_id,itemGeneration:count.generation,binding:count.binding}:owner?{action:c.guidance_mode==='shared'?'locate':'quantity',lineId:owner.id,quantity:owner.planned_quantity,binding}:old?{action:'clear',binding:old.binding||binding}:null;
      if(desired&&JSON.stringify(desired)!==JSON.stringify(old))setGuidance(cellId,desired);
    }
  }
  function requestCountGuidance(actor,item){
    const binding=guidanceBinding(db,item.cell_id),attempt=db.prepare('SELECT baseline_json FROM stocktake_attempts WHERE item_id=? AND generation=? AND observation_id IS NULL ORDER BY started_at DESC LIMIT 1').get(item.id,item.generation);
    if(attempt&&JSON.parse(attempt.baseline_json).guidanceBinding!==binding)throw new Error('Count location mapping changed. Save any earlier evidence or skip this attempt before starting a fresh count.');
    db.prepare(`INSERT INTO stocktake_display_claims(item_id,generation,actor_id,binding,requested_at) VALUES(?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET generation=excluded.generation,actor_id=excluded.actor_id,binding=excluded.binding,requested_at=CASE WHEN stocktake_display_claims.generation=excluded.generation THEN stocktake_display_claims.requested_at ELSE excluded.requested_at END`).run(item.id,item.generation,actor.id,binding,now());
    reconcileGuidance();return displayOwner(db,item.cell_id);
  }
  function markDiscrepancy(cellId, productId, reason) {
    db.prepare(`INSERT INTO work_discrepancies(cell_id,product_id,reason,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(cell_id,product_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at`)
      .run(cellId, productId, reason, now());
  }
  const movement=input=>postMovement(db,input);
  function performerFor(actor, input, fallback = null) {
    if (!can(actor,'review.resolve')) {
      if (Object.hasOwn(input, 'performerId') && String(input.performerId) !== String(actor.id)) throw new Error('Operators can report only their own performance. Ask an admin to attribute somebody else’s work.');
      return actor.id;
    }
    const id = Object.hasOwn(input, 'performerId') ? input.performerId : fallback;
    if (id === '' || id == null || id === 'unknown') return null;
    const person = db.prepare('SELECT id FROM users WHERE id=?').get(Number(id));
    if (!person) throw new Error('Choose an existing performer or Unknown / unverified.');
    return person.id;
  }
  function manualAccounting(report, quantity = report.quantity) {
    const unit = db.prepare('SELECT unit_of_measure FROM products WHERE id=?').get(report.product_id).unit_of_measure;
    try {
      const factor = historicalFactor(db, report.product_id, report.unit, report.occurred_at || report.created_at);
      const accountingQuantity = workQuantity(quantity * factor);
      return { unit, factor, quantity: accountingQuantity, available: true, evidence: `Recorded conversion history from ${report.unit} to ${unit}; factor ${factor}; movement time ${report.occurred_at || report.created_at}` };
    } catch (error) { return { unit, available: false, reason: error.message }; }
  }
  function insertReport(actor, input, allocation = null, internalClosure = false) {
    const product = db.prepare("SELECT * FROM products WHERE id=?").get(Number(input.productId ?? allocation?.product_id));
    const cell = db.prepare("SELECT * FROM cells WHERE id=?").get(Number(input.cellId ?? allocation?.cell_id));
    if (!product || !cell) throw new Error("Choose an existing product and location.");
    const quantity = workQuantity(input.quantity);
    const direction = input.direction || allocation?.type;
    if (!["pick", "put", "count"].includes(direction)) throw new Error("Choose Pick, Put, or Count observation.");
    const origin = String(input.origin || `allocation:${allocation?.id || randomUUID()}`).trim();
    if (!origin || origin.length > 180) throw new Error("Use a movement reference up to 180 characters.");
    const reportId = randomUUID();
    db.prepare(`INSERT INTO work_reports(id,origin_ref,line_id,product_id,cell_id,direction,quantity,unit,performer_id,
      reporter_id,status,reason,payload,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'received',?,?,?,?)`)
      .run(reportId, origin, allocation?.id || null, product.id, cell.id, direction, quantity,
        input.unit || allocation?.unit_of_measure || product.unit_of_measure,
        performerFor(actor, input, allocation ? actor.id : null),
        actor.id, input.reason || null, JSON.stringify({...input,taskClosure:internalClosure||undefined}), input.occurredAt || null, now());
    if(input.unknown) db.prepare("UPDATE work_reports SET quantity_known=0,performer_id=NULL WHERE id=?").run(reportId);
    return db.prepare("SELECT * FROM work_reports WHERE id=?").get(reportId);
  }
  function review(report, reason) {
    event('review_requested',{id:report.reporter_id},report.line_id,{reason},report.id);
    db.prepare("UPDATE work_reports SET status='review',reason=? WHERE id=?").run(reason, report.id);
    if (report.line_id && !JSON.parse(report.payload).unknown) {
      db.prepare("UPDATE work_reports SET status='superseded',verification='Operator entry received; physical verification remains pending' WHERE line_id=? AND origin_ref LIKE 'attention:%' AND status='review'").run(report.line_id);
    }
    if (report.line_id) {
      const allocation = line(report.line_id);
      db.prepare("UPDATE tasks SET attention=1,outcome='needs_review',completed_at=NULL WHERE id=?").run(allocation.task_id);
      db.prepare("UPDATE cell_turns SET uncertain=1 WHERE line_id=?").run(allocation.id);
    }
    return { status: "review", reportId: report.id, message: reason };
  }
  function settle(actor, report, allocation, supervisor = false, verification = "") {
    if(controlledCell(db,report.cell_id)&&!supervisor)return review(report,'This location has goods under controlled condition review. Actual movement is retained for verification.');
    if(report.direction!==allocation.type) return review(report,"The reported action differs from the task. Verify this physical movement separately.");
    if(report.product_id!==allocation.product_id) return review(report,"The reported product differs from the allocation. Reconcile the retained entry as a separate verified physical movement.");
    const already = db.prepare("SELECT * FROM work_settlements WHERE line_id=?").get(allocation.id);
    if (already) {
      if (already.quantity === report.quantity && already.cell_id === report.cell_id && already.unit === report.unit) {
        db.prepare("UPDATE work_reports SET status='duplicate',resolved_at=? WHERE id=?").run(now(), report.id);
        return { status: "recorded", reportId: already.report_id, duplicate: true, message: "This allocation was already recorded." };
      }
      if(supervisor && report.cell_id===allocation.cell_id && report.unit===allocation.unit_of_measure) {
        const result=correct(actor,{lineId:allocation.id,revision:allocation.revision,quantity:report.quantity,verification,requestId:report.id,performerId:report.performer_id},true);
        if(result.status==='recorded') {
          db.prepare("UPDATE work_reports SET status='posted',resolved_at=?,resolver_id=?,verification=? WHERE id=?").run(now(),actor.id,verification,report.id);
          event('late_report_reconciled',actor,allocation.id,{verification},report.id);
          return {...result,reportId:report.id};
        }
        return result;
      }
      return review(report, "This allocation has already been settled differently. The later physical entry is retained; an admin can correct the recorded allocation.");
    }
    if(countBoundary(db,report,allocation)&&!(supervisor&&JSON.parse(report.payload).countBoundaryCleared===true))return review(report,'A stocktake correction may already include this movement. Review its count correction before posting again.');
    if (!supervisor && ["cancelled", "superseded"].includes(allocation.execution_state)) return review(report, "The original allocation changed or was cancelled. Verify the reported physical movement before recording it.");
    const qty = report.quantity;
    const acknowledged=JSON.parse(report.payload).cellCompletion===true&&JSON.parse(report.payload).differenceConfirmed===true;
    if (report.product_id !== allocation.product_id || report.unit !== allocation.current_unit || (!supervisor && report.cell_id !== allocation.cell_id && !acknowledged)) return review(report, "The location or accounting unit changed. Retained for supervisor reconciliation; nothing has been silently converted or relocated.");
    const originPosted=db.prepare("SELECT r.* FROM work_origins o JOIN work_reports r ON r.id=o.report_id WHERE o.origin_ref=?").get(report.origin_ref);
    if(originPosted && (originPosted.quantity!==qty || originPosted.product_id!==report.product_id || originPosted.cell_id!==report.cell_id || originPosted.unit!==report.unit || originPosted.direction!==allocation.type)) return review(report,"This source movement reference was already posted differently. Retain both entries and reconcile them.");
    const onHand = balance(report.product_id, report.cell_id);
    if (!originPosted && allocation.type === "pick") {
      if (qty > onHand + 1e-9 && !supervisor) return review(report, "Reported pick exceeds recorded stock. Keep the full entry and reconcile the location; no quantity was capped.");
      if(qty>onHand+1e-9) markDiscrepancy(report.cell_id,report.product_id,"Verified pick exceeds prior book stock. Full actual retained as a negative balance; reconcile missing movements.");
      const other = protectedPicks(db,report.cell_id,report.product_id,allocation.id);
      if (!supervisor && qty > rounded(onHand - other) + 1e-9) return review(report, "Actual pick conflicts with another reservation. An admin must verify it; other allocations can settle independently.");
      if (supervisor && onHand - qty < other - 1e-9) markDiscrepancy(report.cell_id, report.product_id, `Reservation shortage: ${rounded(other - (onHand - qty))} ${report.unit}. Existing claims remain intact.`);
    } else if(!originPosted) {
      if (!allocation.allow_mixed_put && !compatible(report.cell_id, report.product_id, allocation.id) && !supervisor) return review(report, "This put conflicts with another product in the location. Keep the actual entry for reconciliation.");
      if(!allocation.allow_mixed_put&&!compatible(report.cell_id,report.product_id,allocation.id)) markDiscrepancy(report.cell_id,report.product_id,"Verified physical put left mixed products; reconcile this location.");
      const excess = rounded((usedSpace(db,report.cell_id,{excludingLine:allocation.id,protectActiveOnly:true}) + qty/allocation.items_per_cell - 1)*allocation.items_per_cell);
      if (excess > 1e-9 && !supervisor) return review(report, "The put quantity exceeds the space available after other reservations. An admin must check the actual quantity and location capacity.");
      if (excess > 1e-9) markDiscrepancy(report.cell_id, report.product_id, `Capacity exceeded by ${excess} ${report.unit}; physical entry verified by admin.`);
    }
    if(!originPosted) movement({ actor, performer: report.performer_id, productId: report.product_id, cellId: report.cell_id,
      quantity: allocation.type === "pick" ? -qty : qty, type: allocation.type, taskId: allocation.task_id,
      lineId: allocation.id, origin: report.origin_ref, reason: verification || report.reason || "Operator actual confirmation", unit: report.unit });
    db.prepare("INSERT INTO work_settlements(line_id,report_id,quantity,cell_id,unit,created_at) VALUES(?,?,?,?,?,?)")
      .run(allocation.id, report.id, qty, report.cell_id, report.unit, now());
    db.prepare("UPDATE task_lines SET actual_quantity=?,exception_quantity=?,execution_state='settled',revision=revision+1,note=? WHERE id=?")
      .run(qty, Math.max(0, rounded(allocation.planned_quantity - qty)), verification || report.reason, allocation.id);
    db.prepare("UPDATE work_reservations SET state='settled' WHERE line_id=?").run(allocation.id);
    db.prepare("UPDATE work_reports SET status='posted',resolved_at=?,resolver_id=?,verification=? WHERE id=?")
      .run(now(), supervisor ? actor.id : null, verification || null, report.id);
    db.prepare("INSERT OR IGNORE INTO work_origins(origin_ref,report_id) VALUES(?,?)").run(report.origin_ref, report.id);
    releaseTurn(allocation);
    if(report.cell_id!==allocation.cell_id){
      db.prepare("UPDATE task_lines SET cell_id=? WHERE id=?").run(report.cell_id,allocation.id);
      event('actual_location_verified',actor,allocation.id,{plannedCell:allocation.cell_id,actualCell:report.cell_id},report.id);
    }
    if(!['superseded','cancelled'].includes(allocation.execution_state)) rebalanceRemaining(allocation.task_id);
    if(supervisor && qty>0 && ['superseded','cancelled'].includes(allocation.execution_state)) {
      for(const other of db.prepare("SELECT id FROM task_lines WHERE task_id=? AND id!=? AND execution_state IN ('ready','working')").all(allocation.task_id,allocation.id)) {
        askReview(actor,{lineId:other.id,reason:'Earlier physical instructions were verified after replanning. Confirm replacement work has stopped and verify its actual before continuing.'});
      }
    }
    syncReservations();
    event("allocation_settled", actor, allocation.id, { planned: allocation.planned_quantity, actual: qty, supervisor, verification }, report.id);
    taskProgress(allocation.task_id);
    const automaticReview=!supervisor?closure.sendAutomatically(actor,allocation.task_id,`auto-final-cell-${report.id}`):null;
    return { status: "recorded", reportId: report.id, reviewReportId: automaticReview?.reportId, taskId: allocation.task_id, quantity: qty, message: `${qty} ${report.unit} recorded at ${allocation.logical_code}.${automaticReview?' '+automaticReview.message:''}` };
  }
  function plan(product,input,remaining) {
    const restricted=['location','mixed'].includes(input.recovery?.mode)?Number(input.recovery.cellId):Number(input.plan_cell_id||0);
    const allowMixed=input.recovery?.mode==='mixed'||input.allow_mixed_put===1;
    const preferred = (input.preferredCellIds || [input.preferredCellId]).map(Number);
    const cells = db.prepare("SELECT * FROM cells WHERE active=1 ORDER BY row_number,column_number,logical_code").all()
      .sort((a, b) => Number(!!displayOwner(db,a.id)) - Number(!!displayOwner(db,b.id)) || Number(preferred.includes(b.id)) - Number(preferred.includes(a.id)) ||
        (input.direction === "put" ? Number(balance(product.id, b.id) > 0) - Number(balance(product.id, a.id) > 0) : 0));
    const allocations = [];
    for (const cell of cells) {
      if (remaining <= 0) break;
      if(restricted&&cell.id!==restricted)continue;
      if(controlledCell(db,cell.id))continue;
      if (db.prepare("SELECT 1 FROM work_discrepancies WHERE cell_id=? AND product_id=?").get(cell.id, product.id)) continue;
      const room = input.direction === "pick"
        ? rounded(balance(product.id, cell.id) - protectedPicks(db,cell.id,product.id,0,0,{protectUnstarted:input.protectUnstarted}))
        : (allowMixed||compatible(cell.id, product.id,0,input.protectUnstarted)) ? putRoom(db,cell.id,product,{protectUnstarted:input.protectUnstarted}) : 0;
      if (room <= 0) continue;
      const quantity = Math.min(room, remaining);
      allocations.push({ product_id: product.id, cell_id: cell.id, planned_quantity: quantity, guidance_color: input.direction === "pick" ? "green" : "red" });
      remaining = rounded(remaining - quantity);
    }
    if (remaining > 0) {
      const recorded=Number(db.prepare('SELECT COALESCE(SUM(MAX(0,available_quantity)),0) n FROM inventory_balances WHERE product_id=?').get(product.id).n);
      const overStock=input.direction==='pick'&&Number(input.quantity??remaining)>recorded;
      const error=new Error(input.direction==='put'?`Not enough put capacity. Space for ${rounded(allocations.reduce((n,l)=>n+l.planned_quantity,0))} ${product.unit_of_measure} is available now${restricted?' at the selected location':''}. Active work and locations needing checks are protected. Choose another location or check items per cell.`:overStock?`Not enough recorded stock: ${recorded} ${product.unit_of_measure}. Reduce the pick or confirm the actual stock in the cells first.`:'Not enough stock after active reservations and location checks. Unstarted or review reservations can be used; active picks remain protected. Reduce the quantity or finish active work first.');
      if(input.recovery?.mode==='count')error.message='Not enough stock in the confirmed cells for this pick. Nothing was saved. Check the counts or go back and reduce the pick quantity.';
      error.planning={direction:input.direction,productId:product.id,code:input.direction==='put'?'put_capacity':overStock?'pick_count':'pick_reserved'};throw error;
    }
    return allocations;
  }
  // New work may take over only unstarted/review claims, never active stock or space.
  // Keep old claims and physical evidence for supervisor review instead of deleting them.
  function relocateUnstartedTask(actor,taskId,replacementTaskId) {
    const oldTask=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    const old=db.prepare("SELECT * FROM task_lines WHERE task_id=? AND execution_state!='superseded'").all(taskId);
    if(oldTask.assignment_state!=='offered'||!old.length||old.some(l=>l.execution_state!=='ready'||l.started_at||hasEvidence(l.id)))return false;
    db.exec('SAVEPOINT relocate_offer');
    try{
      for(const l of old)db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(l.id);
      const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(old[0].product_id);
      const next=plan(product,{direction:oldTask.type,allow_mixed_put:oldTask.allow_mixed_put,plan_cell_id:oldTask.plan_cell_id,protectUnstarted:true},rounded(old.reduce((n,l)=>n+l.planned_quantity,0)));
      for(const l of old)db.prepare("UPDATE task_lines SET execution_state='superseded',revision=revision+1 WHERE id=?").run(l.id);
      for(const allocation of next){
        tasks.addLine(taskId,allocation);
        const l=db.prepare('SELECT * FROM task_lines WHERE task_id=? ORDER BY id DESC LIMIT 1').get(taskId);
        db.prepare("UPDATE task_lines SET execution_state='ready',unit_of_measure=? WHERE id=?").run(product.unit_of_measure,l.id);
        db.prepare('INSERT INTO work_reservations(line_id,kind,quantity) VALUES(?,?,?)').run(l.id,oldTask.type,l.planned_quantity);
        captureInstruction(l.id);
      }
      db.prepare('UPDATE tasks SET plan_revision=plan_revision+1 WHERE id=?').run(taskId);
      event('unissued_plan_replaced',actor,null,{taskId,previousLines:old.map(l=>l.id),replacementTaskId,reason:'Unstarted work moved to other available locations after newer work took priority.'});
      db.exec('RELEASE relocate_offer');syncReservations();return true;
    }catch(error){
      db.exec('ROLLBACK TO relocate_offer; RELEASE relocate_offer');
      if(error.planning)return false;
      throw error;
    }
  }
  function flagDisplacedReservations(actor,taskId) {
    const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(taskId));
    if(!t||t.attention||t.review_followup)return;
    const own=db.prepare("SELECT l.*,p.items_per_cell FROM task_lines l JOIN products p ON p.id=l.product_id WHERE l.task_id=? AND l.execution_state!='superseded'").all(t.id);
    for(const cellId of new Set(own.map(l=>l.cell_id))){
      const claims=db.prepare(`SELECT l.id,r.quantity,p.items_per_cell,l.product_id FROM work_reservations r JOIN task_lines l ON l.id=r.line_id JOIN tasks old ON old.id=l.task_id JOIN products p ON p.id=l.product_id
        WHERE r.state='held' AND r.kind=? AND l.cell_id=? AND l.task_id!=? AND ${yieldableClaim('l','old')}
        ${t.type==='pick'?'AND l.product_id=?':''} ORDER BY old.assigned_at,old.id,l.id`).all(t.type,cellId,t.id,...(t.type==='pick'?[own[0].product_id]:[]));
      const heldHere=db.prepare("SELECT r.quantity,l.product_id,p.items_per_cell FROM work_reservations r JOIN task_lines l ON l.id=r.line_id JOIN products p ON p.id=l.product_id WHERE l.task_id=? AND l.cell_id=? AND r.state='held'").all(t.id,cellId);
      let remaining=t.type==='pick'?balance(own[0].product_id,cellId)-protectedPicks(db,cellId,own[0].product_id,0,t.id)-heldHere.reduce((n,r)=>n+r.quantity,0)
        :1-usedSpace(db,cellId,{excludingTask:t.id,protectActiveOnly:true})-heldHere.reduce((n,r)=>n+r.quantity/r.items_per_cell,0);
      for(const claim of claims){
        const amount=t.type==='pick'?claim.quantity:claim.quantity/claim.items_per_cell;
        const incompatible=t.type==='put'&&!t.allow_mixed_put&&heldHere.some(r=>r.product_id!==claim.product_id);
        if(!incompatible&&amount<=remaining+1e-9){remaining-=amount;continue;}
        const l=line(claim.id);
        if(relocateUnstartedTask(actor,l.task_id,t.id)){
          const replacementClaims=db.prepare("SELECT r.quantity,p.items_per_cell FROM work_reservations r JOIN task_lines l ON l.id=r.line_id JOIN products p ON p.id=l.product_id WHERE r.state='held' AND l.task_id=? AND l.cell_id=?").all(l.task_id,cellId);
          remaining-=replacementClaims.reduce((n,r)=>n+(t.type==='pick'?r.quantity:r.quantity/r.items_per_cell),0);
          continue;
        }
        const reason=`Stock or space reserved here was taken over by Task #${t.id}. Update the remaining work or close this task.`;
        if(db.prepare("SELECT 1 FROM work_events WHERE line_id=? AND event_type='reservation_displaced' AND json_extract(payload,'$.replacementTaskId')=?").get(l.id,t.id))continue;
        let report=db.prepare("SELECT * FROM work_reports WHERE line_id=? AND status IN ('review','received') ORDER BY created_at LIMIT 1").get(l.id);
        if(!report)report=insertReport(actor,{quantity:0,unknown:true,origin:`reservation-conflict:${l.id}:${t.id}`,reason},l);
        review(report,report.reason&&report.reason!==reason?report.reason+' '+reason:reason);
        event('reservation_displaced',actor,l.id,{replacementTaskId:t.id,reason},report.id);
        taskProgress(l.task_id);
      }
    }
  }
  function timingSettings() {
    const raw=metadata('assignment_warning_minutes');
    return {enabled:raw!=='disabled',minutes:raw && raw!=='disabled'?Number(raw):120,timezone:metadata('warehouse_timezone')||Intl.DateTimeFormat().resolvedOptions().timeZone,
      inactivityMinutes:readPendingReviewTimeoutSettings(db).timeoutMinutes};
  }
  function saveTiming(actor,input) {
    actorNow(actor,"work.timing");
    const minutes=Number(input.minutes)*(input.timeUnit==='hours'?60:1);
    if(input.enabled!==false && (!Number.isFinite(minutes)||minutes<=0||minutes>525600))throw new Error('Choose a positive warning duration up to one year.');
    const value=input.enabled===false?'disabled':String(minutes);
    db.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('assignment_warning_minutes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(value,now());
    if(input.inactivityMinutes!=null)savePendingReviewTimeoutSettings(db,{timeoutMinutes:input.inactivityMinutes});
    event('work_timing_changed',actor,null,{previous:input.previous,value,inactivityMinutes:input.inactivityMinutes});
    return {status:'recorded',message:'Timing saved. Existing task deadlines are unchanged. Inactivity review remains a separate rule.'};
  }
  function validatedDue(actor,value) {
    actorNow(actor,"work.deadline");
    if(!value)return null;
    const time=Date.parse(value);if(!Number.isFinite(time))throw new Error('Choose a valid due date and time.');
    return new Date(time).toISOString();
  }
  function eligibleAssignee(actor,id) {
    actorNow(actor,"work.assign");
    const person=db.prepare('SELECT * FROM users WHERE id=?').get(Number(id));
    if(!workCapabilities(effectiveUser(db,person)).execute)throw new Error('Choose an active operator eligible to execute work.');
    return person;
  }
  function assignmentEvent(actor,taskId,type,previous,payload={}) {
    const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    db.prepare('INSERT INTO task_assignment_events(task_id,actor_id,event_type,generation,previous_assignee,assignee_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(taskId,actor.id,type,t.assignment_generation,previous,t.assignee_id,JSON.stringify(payload),now());
  }
  function currentTask(actor,input,admin=false) {
    if(admin)actorNow(actor,typeof admin==="string"?admin:"work.assign");
    const t=db.prepare('SELECT * FROM tasks WHERE id=? AND workflow_version=2').get(Number(input.taskId));
    if(!t)throw new Error('Task not found.');
    if((admin===true||admin==='work.assign')&&!can(actor,'work.team'))task(actor,t.id);
    if(!admin && !can(actor,'work.teamStop') && t.assignee_id!==actor.id)throw new Error('Only your assigned work can be changed.');
    if(Number(input.generation)!==t.assignment_generation)throw new Error('This assignment changed. Refresh before trying again.');
    return t;
  }
  function replanUnissuedTask(actor,t){
    const old=db.prepare('SELECT * FROM task_lines WHERE task_id=?').all(t.id);
    if(!old.length||old.some(l=>l.execution_state!=='ready'||l.started_at||l.device_id||hasEvidence(l.id)||displayOwner(db,l.cell_id)?.lineId===l.id))return;
    if(!old.some(l=>displayOwner(db,l.cell_id)))return;
    // Offers have never owned a display. Keep their snapshots and replace only on explicit Start.
    for(const l of old)db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(l.id);
    const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(old[0].product_id);
    const replacement=product?plan(product,{direction:t.type,allow_mixed_put:t.allow_mixed_put,plan_cell_id:t.plan_cell_id},rounded(old.reduce((n,l)=>n+l.planned_quantity,0))):null;
    if(!replacement)throw new Error('Product is unavailable. Ask a supervisor to update this task.');
    const same=replacement.length===old.length&&replacement.every((r,i)=>r.cell_id===old[i].cell_id&&r.planned_quantity===old[i].planned_quantity);
    if(same){for(const l of old)db.prepare("UPDATE work_reservations SET state='held' WHERE line_id=?").run(l.id);return;}
    for(const l of old)db.prepare("UPDATE task_lines SET execution_state='superseded',revision=revision+1 WHERE id=?").run(l.id);
    for(const r of replacement){tasks.addLine(t.id,r);const l=db.prepare('SELECT * FROM task_lines WHERE task_id=? ORDER BY id DESC LIMIT 1').get(t.id);db.prepare("UPDATE task_lines SET execution_state='ready',unit_of_measure=? WHERE id=?").run(product.unit_of_measure,l.id);db.prepare('INSERT INTO work_reservations(line_id,kind,quantity) VALUES(?,?,?)').run(l.id,t.type,l.planned_quantity);}
    event('unissued_plan_replaced',actor,null,{taskId:t.id,previousLines:old.map(l=>l.id),reason:'Prefer available locations at explicit Start'});syncReservations();
  }
  function startTask(actor,input) {
    const t=currentTask(actor,input);
    if(input.progressToken&&input.progressToken!==progressToken(t.id))throw new Error('Task instructions changed. Refresh before starting.');
    if(t.review_followup)throw new Error('Check moved quantity first. Resume verified remaining work after the check.');
    if(db.prepare("SELECT 1 FROM work_events e JOIN task_lines l ON l.id=e.line_id JOIN work_reports r ON r.id=e.report_id WHERE l.task_id=? AND e.event_type='reservation_displaced' AND r.status IN ('review','received')").get(t.id))throw new Error('Stock or space for this task was taken over by newer work. Ask a supervisor to update or close it before starting.');
    if(t.assignee_id!==actor.id)throw new Error('Only the assigned operator can start this task.');
    if(!['offered','legacy','started'].includes(t.assignment_state)||t.completed_at)throw new Error('This task is no longer available to start.');
    if(t.assignment_state!=='started') {
      replanUnissuedTask(actor,t);
      db.prepare("UPDATE tasks SET assignment_state='started',assignment_generation=assignment_generation+1,guidance_paused=0,guidance_session=?,last_touched_at=?,started_at=? WHERE id=?").run(input.guidanceSession||null,now(),now(),t.id);
      for(const l of db.prepare("SELECT id FROM task_lines WHERE task_id=? AND execution_state='ready'").all(t.id)) {db.prepare('UPDATE task_lines SET revision=revision+1 WHERE id=?').run(l.id);captureInstruction(l.id);}
      assignmentEvent(actor,t.id,'started',t.assignee_id);
    }
    return {status:'recorded',taskId:t.id,generation:db.prepare('SELECT assignment_generation FROM tasks WHERE id=?').get(t.id).assignment_generation,message:'Task started. Go to a location; arrival requests your turn.'};
  }
  function deadline(actor,input) {
    const t=currentTask(actor,input,"work.deadline"),due=validatedDue(actor,input.dueAt);
    if(!String(input.reason||'').trim())throw new Error('Give a reason for changing the deadline.');
    db.prepare('UPDATE tasks SET due_at=?,assignment_generation=assignment_generation+1 WHERE id=?').run(due,t.id);
    // Deadline edits do not alter physical instructions; generation protects concurrent admin changes.
    assignmentEvent(actor,t.id,'deadline_changed',t.assignee_id,{previous:t.due_at,dueAt:due,reason:input.reason});
    return {status:'recorded',message:'Deadline changed and recorded in task history.'};
  }
  function releaseUntouched(actor,l,state='cancelled') {
    if(l.execution_state!=='ready'||hasEvidence(l.id))throw new Error('Resolve physical evidence before releasing this location.');
    captureInstruction(l.id);
    db.prepare('UPDATE task_lines SET execution_state=?,revision=revision+1 WHERE id=?').run(state,l.id);
    db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(l.id);
    releaseTurn(l);syncReservations();event('unstarted_cancelled',actor,l.id,{declaration:'Nothing moved',state});
  }
  function askReview(actor,input) {
    const l=line(input.lineId);
    if(!can(actor,'work.teamStop') && actor.id!==l.assignee_id && !db.prepare('SELECT 1 FROM work_instruction_history WHERE line_id=? AND assignee_id=?').get(l.id,actor.id))throw new Error('Only your current or earlier assigned work can be reported.');
    event('uncertainty_reported',actor,l.id,input);
    if(hasEvidence(l.id))return {status:'review',message:'This location is already awaiting review. Do not repeat the movement.'};
    const r=insertReport(actor,{...input,quantity:0,unknown:true,origin:`attention:${l.id}`,reason:input.reason||'Operator is unsure what moved'},l);
    return review(r,'Actual movement is unknown. A supervisor must verify before this work is released.');
  }
  function retireUntouchedTimerCase(actor,l) {
    if(l.execution_state!=='ready'||db.prepare("SELECT assignment_source FROM tasks WHERE id=?").get(l.task_id)?.assignment_source==='legacy'||l.started_at||l.device_id||db.prepare("SELECT 1 FROM work_events WHERE line_id=? AND event_type IN ('location_ready','uncertainty_reported')").get(l.id)||db.prepare('SELECT 1 FROM cell_turns WHERE line_id=?').get(l.id))return;
    const reports=db.prepare("SELECT * FROM work_reports WHERE line_id=? AND status IN ('review','received')").all(l.id);
    if(!reports.length||reports.some(r=>r.origin_ref!==`attention:${l.id}`||r.quantity_known!==0||r.reason!=="Inactivity needs verification. Expected quantity is shown for context; enter an actual quantity or keep pending."||JSON.parse(r.payload).reason!=="Actual quantity is unknown; zero is not a verified answer."))return;
    for(const r of reports){db.prepare("UPDATE work_reports SET status='resolved',resolver_id=?,resolved_at=?,verification=?,case_revision=case_revision+1 WHERE id=?").run(actor.id,now(),'Untouched instruction cancelled/returned; automatic inactivity case retired. No actual quantity was inferred or stock posted.',r.id);event('untouched_inactivity_retired',actor,l.id,{reportId:r.id},r.id);}
  }
  function stopTask(actor,input) {
    const t=currentTask(actor,input);
    if(t.assignee_id!==actor.id)assertCan(actor,"work.teamStop");
    let uncertain=false;
    for(const item of db.prepare("SELECT id FROM task_lines WHERE task_id=? AND execution_state IN ('ready','working')").all(t.id)) {
      const l=line(item.id);retireUntouchedTimerCase(actor,l);
      if(l.execution_state==='ready'&&!hasEvidence(l.id))releaseUntouched(actor,l);
      else {askReview(actor,{lineId:l.id,reason:'Stop requested; verify physical work and confirm the original worker has stopped.'});uncertain=true;}
    }
    db.prepare('UPDATE tasks SET stop_requested=1,assignment_generation=assignment_generation+1 WHERE id=?').run(t.id);
    assignmentEvent(actor,t.id,'stop_requested',t.assignee_id,{uncertain});taskProgress(t.id);
    return {status:uncertain?'review':'recorded',message:uncertain?'Untouched locations stopped. Active or uncertain work remains in Needs review.':'Remaining work stopped. Recorded quantities remain in history.'};
  }
  function returnTask(actor,input,allowSelf=false) {
    const t=currentTask(actor,input);
    if(t.assignee_id!==actor.id || !allowSelf&&t.assignment_source==='self')throw new Error('Decline is for work assigned to you. Use Stop for self-created work.');
    if(t.completed_at)throw new Error('This task is already closed.');
    let uncertain=false;
    for(const item of db.prepare("SELECT id FROM task_lines WHERE task_id=? AND execution_state IN ('ready','working')").all(t.id)) {
      const l=line(item.id);retireUntouchedTimerCase(actor,l);
      if(l.execution_state==='ready'&&!hasEvidence(l.id))releaseUntouched(actor,l,'superseded');
      else {askReview(actor,{lineId:l.id,reason:'Operator handed back work; verify actual and confirm physical work has stopped.'});uncertain=true;}
    }
    db.prepare("UPDATE tasks SET assignee_id=NULL,assignment_state='returned',assignment_generation=assignment_generation+1 WHERE id=?").run(t.id);
    uncertain=uncertain||db.prepare("SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received')").get(t.id)!=null;
    assignmentEvent(actor,t.id,'returned',t.assignee_id,{reason:String(input.reason||'').slice(0,200),note:String(input.note||'').slice(0,2000),uncertain});taskProgress(t.id);
    return {status:uncertain?'review':'recorded',message:uncertain?'Return received. Physical work still needs review before reassignment.':'Returned to Needs assignment. The original deadline is unchanged.'};
  }
  function progressToken(taskId) {
    const t=db.prepare('SELECT assignment_generation,assignee_id,assignment_state,requested_quantity,review_remaining_quantity,due_at,stop_requested,completed_at,review_followup,review_handover_verified FROM tasks WHERE id=?').get(taskId);
    const lines=db.prepare('SELECT id,revision,execution_state,planned_quantity,actual_quantity FROM task_lines WHERE task_id=? ORDER BY id').all(taskId);
    const reports=db.prepare('SELECT r.id,r.status,r.case_revision,r.quantity,r.quantity_known FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? ORDER BY r.id').all(taskId);
    return createHash('sha256').update(canonical({t,lines,reports})).digest('hex');
  }
  function returnEvent(t,input) {
    const e=db.prepare("SELECT * FROM task_assignment_events WHERE task_id=? AND event_type='returned' ORDER BY id DESC LIMIT 1").get(t.id);
    if(t.assignment_state!=='returned'||!e||Number(input.returnEventId)!==e.id)throw new Error('This return changed. Refresh before trying again.');
    return e;
  }
  function acknowledgeReturn(actor,input) {
    const t=currentTask(actor,input,true),e=returnEvent(t,input);
    const inserted=db.prepare('INSERT OR IGNORE INTO work_return_acknowledgements(return_event_id,actor_id,created_at) VALUES(?,?,?)').run(e.id,actor.id,now());
    if(inserted.changes)assignmentEvent(actor,t.id,'return_acknowledged',e.previous_assignee,{returnEventId:e.id});
    return {status:'recorded',message:'Return acknowledged. Remaining work and quantity checks are unchanged.'};
  }
  function updateReturned(actor,input) {
    const t=currentTask(actor,input,true);returnEvent(t,input);
    if(input.progressToken!==progressToken(t.id))throw new Error('Task quantities or assignment changed. Close this dialog and check the latest task.');
    if(db.prepare("SELECT 1 FROM task_lines l WHERE l.task_id=? AND (l.execution_state='working' OR EXISTS(SELECT 1 FROM work_reports r WHERE r.line_id=l.id AND r.status IN ('review','received')))").get(t.id))throw new Error('Check moved quantity first. Confirm physical work has stopped before reassignment.');
    const remaining=workQuantity(input.remainingQuantity,true);
    const actual=rounded(db.prepare("SELECT COALESCE(SUM(actual_quantity),0) n FROM task_lines WHERE task_id=? AND execution_state='settled'").get(t.id).n);
    const requested=workQuantity(rounded(actual+remaining),true);
    const due=input.changeDue===true?validatedDue(actor,input.dueAt):t.due_at;
    if(input.changeDue===true)assertCan(actor,'work.deadline');
    db.prepare('UPDATE tasks SET requested_quantity=?,due_at=? WHERE id=?').run(requested,due,t.id);
    const result=reassign(actor,input);
    assignmentEvent(actor,t.id,'returned_task_updated',null,{returnEventId:Number(input.returnEventId),previousRequested:t.requested_quantity,requested,completed:actual,remaining,previousDue:t.due_at,dueAt:due});
    return {...result,message:'Task updated and remaining work assigned. Completed movements are retained.'};
  }
  function updateReviewTask(actor,input){
    const t=currentTask(actor,input,true),person=eligibleAssignee(actor,input.assigneeId);
    if(input.progressToken!==progressToken(t.id))throw new Error('Task quantities or assignment changed. Refresh before saving.');
    if(closure.hasClosed(t.id)||t.completed_at)throw new Error('Closed tasks cannot be reassigned.');
    const remaining=workQuantity(input.remainingQuantity,true),pending=!!db.prepare("SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received')").get(t.id);
    const planCellId=input.planCellId===undefined?(t.plan_cell_id||0):Number(input.planCellId||0);
    if(!Number.isInteger(planCellId)||planCellId<0||planCellId&&!db.prepare('SELECT id FROM cells WHERE id=? AND active=1').get(planCellId))throw new Error('Choose an active location for the remaining work.');
    let due=t.due_at;
    if(input.changeDue===true){assertCan(actor,'work.deadline');if(input.noDeadline===true)due=null;else{const minutes=Number(input.duration)*({minutes:1,hours:60,days:1440}[input.timeUnit]||0);if(!Number.isFinite(minutes)||minutes<1||minutes>525600)throw new Error('Choose a deadline duration from one minute to one year.');due=new Date(Date.now()+minutes*60000).toISOString();}}
    const actual=rounded(db.prepare("SELECT COALESCE(SUM(actual_quantity),0) n FROM task_lines WHERE task_id=? AND execution_state='settled'").get(t.id).n);
    if(pending){
      const result=assignReview(actor,input);db.prepare('UPDATE tasks SET review_remaining_quantity=?,due_at=?,plan_cell_id=? WHERE id=?').run(remaining,due,planCellId||null,t.id);
      assignmentEvent(actor,t.id,'review_intent_updated',t.assignee_id,{previousRemaining:t.review_remaining_quantity??Math.max(0,t.requested_quantity-actual),remaining,previousDue:t.due_at,dueAt:due});
      return {...result,taskId:t.id,message:'Assignment saved. Movement still needs review; stock holds remain and work has not restarted.'};
    }
    if(db.prepare("SELECT 1 FROM task_lines WHERE task_id=? AND execution_state='working'").get(t.id))throw new Error('Finish or stop active location work before changing its assignment.');
    db.prepare('UPDATE tasks SET requested_quantity=?,review_remaining_quantity=NULL,due_at=?,plan_cell_id=? WHERE id=?').run(workQuantity(actual+remaining,true),due,planCellId||null,t.id);
    const result=reassign(actor,{...input,assigneeId:person.id});assignmentEvent(actor,t.id,'review_task_updated',t.assignee_id,{previousRequested:t.requested_quantity,requested:actual+remaining,remaining,previousDue:t.due_at,dueAt:due});return {...result,taskId:t.id,message:'Task assignment updated.'};
  }
  function assignReview(actor,input) {
    const t=currentTask(actor,input,true),person=eligibleAssignee(actor,input.assigneeId);
    if(input.progressToken!==progressToken(t.id))throw new Error('Task quantities or assignment changed. Close this dialog and check the latest task.');
    if(!db.prepare("SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received')").get(t.id))throw new Error('This task no longer needs a quantity check. Refresh before assigning it.');
    // Change responsibility only: original instructions, physical turn, reports and reservations remain immutable.
    db.prepare("UPDATE tasks SET assignee_id=?,assigned_by=?,assigned_at=?,assignment_state='started',assignment_source='assigned',assignment_generation=assignment_generation+1,review_followup=1,review_handover_verified=0,stop_requested=0,completed_at=NULL WHERE id=?").run(person.id,actor.id,now(),t.id);
    assignmentEvent(actor,t.id,'review_assigned',t.assignee_id,{reason:String(input.reason||'').slice(0,2000),dueAt:t.due_at});
    return {status:'recorded',message:'Quantity check assigned. Existing movement evidence and reservations remain held.'};
  }
  function observeReview(actor,input) {
    const t=currentTask(actor,input),l=line(input.lineId);
    if(t.assignee_id!==actor.id||l.task_id!==t.id||!hasEvidence(l.id))throw new Error('This quantity check changed. Refresh before saving an observation.');
    if(input.progressToken&&input.progressToken!==progressToken(t.id))throw new Error('Task evidence changed. Refresh before saving an observation.');
    const note=String(input.note||'').trim();if(!note)throw new Error('Describe what you checked and who did the original movement.');
    const quantity=input.quantity==null||String(input.quantity).trim()===''?null:workQuantity(input.quantity);
    event('review_observation',actor,l.id,{quantity,note:note.slice(0,2000),generation:t.assignment_generation});
    return {status:'recorded',message:'Observation saved for the verifier. No movement or performer was assumed.'};
  }
  function resumeFollowup(actor,input) {
    const t=currentTask(actor,input);
    if(t.assignee_id!==actor.id||!t.review_followup||!t.review_handover_verified)throw new Error('The verifier must check the moved quantity and confirm the original worker has stopped.');
    if(input.progressToken!==progressToken(t.id))throw new Error('Task quantities changed. Refresh before planning remaining work.');
    return reassign(actor,{...input,assigneeId:actor.id},true);
  }
  function reassign(actor,input,resume=false) {
    const t=currentTask(actor,input,!resume),person=resume?actor:eligibleAssignee(actor,input.assigneeId);
    if(closure.hasClosed(t.id)||closure.pendingCase(t.id))throw new Error('Final task closure cannot be reopened or reassigned. Review retained evidence separately.');
    if(t.review_followup&&!t.review_handover_verified)throw new Error('Verify moved quantity and confirm the original worker has stopped before reassignment.');
    const lines=db.prepare('SELECT * FROM task_lines WHERE task_id=?').all(t.id);
    if(lines.some(l=>l.execution_state==='working'||hasEvidence(l.id)))throw new Error('Resolve / hand over active or uncertain work first. Confirm with the original worker that physical work has stopped.');
    if(t.completed_at && t.outcome!=='stopped')throw new Error('Closed work cannot be reassigned.');
    const actual=rounded(lines.filter(l=>l.execution_state==='settled').reduce((n,l)=>n+l.actual_quantity,0));
    const remaining=t.review_remaining_quantity??rounded(t.requested_quantity-actual);
    if(t.review_remaining_quantity!=null)db.prepare('UPDATE tasks SET requested_quantity=?,review_remaining_quantity=NULL WHERE id=?').run(workQuantity(actual+remaining,true),t.id);
    if(remaining<=0)throw new Error('The requested quantity is already fulfilled.');
    for(const l of lines.filter(l=>l.execution_state==='ready'))releaseUntouched(actor,line(l.id),'superseded');
    const original=lines[0],product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(original.product_id);
    if(!product)throw new Error('The product is no longer active.');
    const allocations=plan(product,{direction:t.type,allow_mixed_put:t.allow_mixed_put,plan_cell_id:t.plan_cell_id},remaining);
    db.prepare("UPDATE tasks SET assignee_id=?,assigned_by=?,assigned_at=?,assignment_state='offered',assignment_source='assigned',assignment_generation=assignment_generation+1,stop_requested=0,review_followup=0,review_handover_verified=0,completed_at=NULL WHERE id=?").run(person.id,resume?t.assigned_by:actor.id,resume?t.assigned_at:now(),t.id);
    for(const allocation of allocations) {
      tasks.addLine(t.id,allocation);const l=db.prepare('SELECT id FROM task_lines WHERE task_id=? ORDER BY id DESC LIMIT 1').get(t.id);
      db.prepare("UPDATE task_lines SET execution_state='ready',unit_of_measure=? WHERE id=?").run(product.unit_of_measure,l.id);
      db.prepare('INSERT INTO work_reservations(line_id,kind,quantity) VALUES(?,?,?)').run(l.id,t.type,allocation.planned_quantity);captureInstruction(l.id);
    }
    assignmentEvent(actor,t.id,resume?'verified_work_resumed':'reassigned',t.assignee_id,{remaining,dueAt:t.due_at,reason:input.reason||''});syncReservations();taskProgress(t.id);
    return {status:'recorded',message:'Remaining work assigned. Recorded performers and the original deadline are unchanged.'};
  }
  function rebalanceRemaining(taskId) {
    const t=db.prepare('SELECT requested_quantity FROM tasks WHERE id=?').get(taskId);
    let remaining=Math.max(0,rounded(t.requested_quantity-db.prepare("SELECT COALESCE(SUM(actual_quantity),0) n FROM task_lines WHERE task_id=? AND execution_state='settled'").get(taskId).n));
    const active=db.prepare("SELECT * FROM task_lines WHERE task_id=? AND execution_state IN ('ready','working') ORDER BY CASE execution_state WHEN 'working' THEN 0 ELSE 1 END,id").all(taskId);
    for(const l of active) {
      if(l.execution_state==='working'||hasEvidence(l.id)) {remaining=Math.max(0,rounded(remaining-l.planned_quantity));continue;}
      const next=Math.min(l.planned_quantity,remaining);remaining=rounded(remaining-next);
      if(next===l.planned_quantity)continue;
      captureInstruction(l.id);
      db.prepare("UPDATE task_lines SET planned_quantity=?,execution_state=?,revision=revision+1 WHERE id=?").run(next,next?'ready':'cancelled',l.id);
      db.prepare('UPDATE work_reservations SET quantity=?,state=? WHERE line_id=?').run(next,next?'held':'released',l.id);
      captureInstruction(l.id);event('remaining_plan_updated',null,l.id,{previous:l.planned_quantity,quantity:next});
    }
  }
  function assignmentDuration(input) {
    const defaulted=input.dueDuration===undefined&&input.dueUnit===undefined;
    const value=defaulted?8:input.dueDuration,unit=defaulted?'hours':input.dueUnit;
    const factor={minutes:1,hours:60,days:1440}[unit];
    const minutes=Number(value)*factor;
    if(!['string','number'].includes(typeof value)||!String(value).trim()||!factor||!Number.isFinite(minutes)||minutes<1||minutes>525600)throw new Error('Choose a due duration from 1 minute to 365 days.');
    return minutes;
  }
  function create(actor, input, assignmentForm=false) {
    if(assignmentForm){
      actorNow(actor,'work.assign');
      if(!input.assigneeId)throw new Error('Choose a person to assign this task to.');
      if(input.dueAt!=null)throw new Error('Use a due duration for a new assignment.');
    }
    assertCan(actor,input.direction==='put'?'work.put':'work.pick');
    if(metadata("firmware_busy")) throw new Error("Controller maintenance is in progress. Report physical work manually; reserve new work after maintenance finishes.");
    const product = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(Number(input.productId));
    if (!product) throw new Error("Choose an active product.");
    if (!["pick", "put"].includes(input.direction)) throw new Error("Choose Pick or Put.");
    let remaining = workQuantity(input.quantity, true);
    const recoveryResult=planningRecovery.prepare(actor,input,product);
    const allocations=plan(product,input,remaining);
    const task = tasks.createPendingReviewTask({ type: input.direction, summary: `${input.direction === "pick" ? "Pick" : "Put"} ${input.quantity} ${product.unit_of_measure} of ${product.sku}`, createdBy: actor.id, lines: allocations });
    db.prepare('UPDATE tasks SET allow_mixed_put=?,plan_cell_id=? WHERE id=?').run(input.recovery?.mode==='mixed'?1:0,['location','mixed'].includes(input.recovery?.mode)?Number(input.recovery.cellId):null,task.id);
    const assignee = input.assigneeId ? eligibleAssignee(actor, input.assigneeId) : actor;
    const assignedAt=now(), timing=timingSettings();
    const duration=assignmentForm?assignmentDuration(input):null;
    const dueAt=assignmentForm?new Date(Date.parse(assignedAt)+duration*60000).toISOString():input.dueAt ? validatedDue(actor,input.dueAt) : timing.enabled ? new Date(Date.parse(assignedAt)+timing.minutes*60000).toISOString() : null;
    db.prepare("UPDATE tasks SET workflow_version=2,assignee_id=?,assigned_by=?,assigned_at=?,assignment_state=?,assignment_source=?,due_at=?,requested_quantity=?,instruction_note=?,guidance_session=? WHERE id=?")
      .run(assignee.id,actor.id,assignedAt,input.assigneeId?'offered':'started',input.assigneeId?'assigned':'self',dueAt,workQuantity(input.quantity,true),String(input.note||'').slice(0,2000),input.assigneeId?null:input.guidanceSession||null,task.id);
    assignmentEvent(actor,task.id,'assigned',null,{dueAt,...(assignmentForm?{durationMinutes:duration}:{}),source:input.assigneeId?'assigned':'self'});
    for (const allocation of task.lines) {
      db.prepare("UPDATE task_lines SET execution_state='ready',unit_of_measure=(SELECT unit_of_measure FROM products WHERE id=task_lines.product_id) WHERE id=?").run(allocation.id);
      db.prepare("INSERT INTO work_reservations(line_id,kind,quantity) VALUES(?,?,?)").run(allocation.id, input.direction, allocation.planned_quantity);
    }
    for (const allocation of task.lines) captureInstruction(allocation.id);
    syncReservations();
    event("task_reserved", actor, null, { taskId: task.id, lines: task.lines.map(l => l.id) });
    if(!input.assigneeId)assignmentEvent(actor,task.id,'started',assignee.id);
    return { ...recoveryResult, status: "reserved", taskId: task.id, generation:1, message: assignmentForm?`Task assigned to ${assignee.name}.`:"Quantities reserved. Follow the location guidance, then tap I’m at this location on arrival." };
  }
  // Reopening creates new instructions; finalized movements and their late-report
  // boundaries remain attached to the original task.
  function reopenTask(actor,input) {
    const original=currentTask(actor,input,true),source=task(actor,original.id);
    if(source.reopened_task_id)throw new Error(`Already reopened as Task #${source.reopened_task_id}. Open that task instead.`);
    if(!original.completed_at||source.attention||source.closure_review_id||source.lines.some(l=>['ready','working'].includes(l.execution_state)||l.reports.some(r=>['review','received'].includes(r.status))))throw new Error('Finish or review the existing task before reopening it.');
    if(input.progressToken!==source.progress_token||input.closureToken!==source.closure_token)throw new Error('Task quantities changed. Close this form and reopen the latest task.');
    const first=source.lines[0],product=first&&db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(first.product_id);
    if(!product)throw new Error('This product is no longer active. Restore it in Products before reopening.');
    if(source.lines.some(l=>l.product_id!==product.id||l.unit_of_measure!==product.unit_of_measure))throw new Error('The product unit changed. Create a new task using its current unit.');
    if(Number(input.productId)!==product.id||input.direction!==source.type)throw new Error('The product or action changed. Reopen the original task again.');
    const result=create(actor,{productId:product.id,direction:source.type,quantity:input.quantity,assigneeId:input.assigneeId,dueDuration:input.dueDuration,dueUnit:input.dueUnit,recovery:input.recovery,requestId:input.requestId},true);
    assignmentEvent(actor,original.id,'reopened',original.assignee_id,{nextTaskId:result.taskId,quantity:workQuantity(input.quantity,true),unit:product.unit_of_measure});
    assignmentEvent(actor,result.taskId,'reopened_from',null,{sourceTaskId:original.id});
    return {...result,sourceTaskId:original.id,message:`Task #${result.taskId} assigned. Earlier movements stay in Task #${original.id}.`};
  }
  function resumeTask(actor,input) {
    const t=currentTask(actor,input);
    if(t.assignee_id!==actor.id||t.assignment_state!=='started'||t.review_followup||t.stop_requested||t.completed_at)throw new Error('Only your started, open execution task can be resumed.');
    if(input.progressToken!==progressToken(t.id))throw new Error('Task instructions changed. Refresh before resuming.');
    const eligible=db.prepare("SELECT id FROM task_lines WHERE task_id=? AND execution_state IN ('ready','working') AND planned_quantity>0").all(t.id).map(r=>line(r.id)).filter(l=>!hasEvidence(l.id));
    if(!eligible.length)throw new Error('No location is ready to resume. Check the outstanding movement or task result.');
    const supplied=typeof input.instructions==='string'?JSON.parse(input.instructions):input.instructions;
    if(!Array.isArray(supplied)||supplied.length!==eligible.length||new Set(supplied.map(x=>Number(x.lineId))).size!==eligible.length||eligible.some(l=>!supplied.some(x=>Number(x.lineId)===l.id&&Number(x.revision)===l.revision&&Number(x.bindingRevision)===l.binding_revision)))throw new Error('Location instructions changed. Refresh before resuming.');
    db.prepare('UPDATE tasks SET guidance_paused=0,guidance_session=? WHERE id=?').run(input.guidanceSession||null,t.id);
    const claims=eligible.flatMap(l=>guide(actor,{...input,lineId:l.id,revision:l.revision,bindingRevision:l.binding_revision}).guidanceClaims);
    assignmentEvent(actor,t.id,'resumed',t.assignee_id);
    return {status:'recorded',taskId:t.id,generation:t.assignment_generation,guidanceClaims:claims,guidanceCells:claims.map(c=>c.cellId),message:'Task resumed. Follow the location guidance; arrival is a separate action.'};
  }
  function pauseTask(actor,input) {
    const t=currentTask(actor,input);
    if(t.assignee_id!==actor.id||t.assignment_state!=='started'||t.completed_at||t.stop_requested)return {status:'recorded',message:'Task is no longer active.'};
    // A late pagehide from an older tab cannot darken a task resumed elsewhere.
    if(!input.guidanceSession||input.guidanceSession!==t.guidance_session)return {status:'recorded',message:'An older task page was ignored.'};
    if(!t.guidance_paused){
      db.prepare('UPDATE tasks SET guidance_paused=1,guidance_session=NULL WHERE id=?').run(t.id);
      assignmentEvent(actor,t.id,'paused',t.assignee_id);
    }
    return {status:'recorded',taskId:t.id,message:'Task paused. Resume it to relight its locations.'};
  }
  function guide(actor,input) {
    const t=currentTask(actor,input),l=line(input.lineId);
    if(t.assignee_id!==actor.id||l.task_id!==t.id)throw new Error('Only the assigned operator can refresh this task’s light.');
    if(t.assignment_state!=='started'||t.review_followup||t.stop_requested||t.completed_at)throw new Error('Start eligible work before requesting its light. Quantity-check assignments cannot execute work.');
    if(t.guidance_paused)throw new Error('Resume this task before requesting its light.');
    if(l.revision!==Number(input.revision)||l.binding_revision!==Number(input.bindingRevision))throw new Error('Location instructions changed. Refresh the task before requesting its light.');
    if(!['ready','working'].includes(l.execution_state)||l.planned_quantity<=0||hasEvidence(l.id))throw new Error('This location is closed or needs a quantity check. Follow the current task.');
    if(metadata('firmware_busy'))throw new Error('Controller maintenance is in progress. Follow your screen.');
    reconcileGuidance();
    const row=db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(l.cell_id),desired=row?JSON.parse(row.desired):null;
    // An explicit action may resend its own elected display, never claim another worker’s display or physical turn.
    const owned=l.controller_id&&l.hardware_channel&&desired?.lineId===l.id&&['quantity','locate'].includes(desired.action)&&desired.binding===guidanceBinding(db,l.cell_id);
    if(owned)db.prepare('UPDATE work_guidance SET delivered=0 WHERE cell_id=? AND generation=?').run(l.cell_id,row.generation);
    return {status:'recorded',guidanceCells:owned?[l.cell_id]:[],guidanceClaims:owned?[{cellId:l.cell_id,generation:row.generation,lineId:l.id}]:[],message:owned?'Light refresh requested. Check the cell and quantity on screen.':guidanceStatus(l,actor)?.message||'Follow the current task instructions.'};
  }
  function acquire(actor, input) {
    if(metadata("firmware_busy")) throw new Error("Controller maintenance is in progress. No new guidance is available.");
    const allocation = line(input.lineId); executeOwner(actor, allocation, input);
    if(db.prepare('SELECT guidance_paused FROM tasks WHERE id=?').get(allocation.task_id)?.guidance_paused)throw new Error('Resume this task before arriving at a location.');
    if(controlledCell(db,allocation.cell_id))throw new Error('This location has a condition review. Ask a supervisor to resolve affected instructions; report any actual movement already performed.');
    if (!input.deviceId) throw new Error("A device identity is required.");
    if (allocation.revision !== Number(input.revision) || !["ready", "working"].includes(allocation.execution_state)) throw new Error("This allocation changed. Refresh it before requesting guidance; already performed work can still be reported.");
    if (db.prepare("SELECT 1 FROM work_reports WHERE line_id=? AND status='review'").get(allocation.id)) throw new Error("This task needs supervisor review. You can still report actual work.");
    if (input.method !== "arrival" && (String(input.location).startsWith("lytguide:") ? !validLocationLabel(db,identity().site,allocation,input.location) : String(input.location).trim().toUpperCase() !== allocation.logical_code.toUpperCase())) throw new Error("That location does not match this allocation.");
    if (allocation.execution_state === "working" && allocation.device_id !== input.deviceId) throw new Error("Another device already started this allocation. Report existing work or ask an admin to resolve it; do not repeat the movement.");
    const problem=instructionProblem(allocation);if(problem)throw new Error(problem);
    reconcileGuidance();const owner=displayOwner(db,allocation.cell_id);
    if(owner&&(owner.kind!=='task'||owner.lineId!==allocation.id))return {status:'busy',message:waitingMessage(owner)};
    if(!owner)throw new Error('This location is not available for execution. Refresh the task or ask a supervisor.');
    const turn=db.prepare('SELECT * FROM cell_turns WHERE cell_id=?').get(allocation.cell_id);
    if(turn?.line_id===allocation.id&&turn.device_id!==input.deviceId)throw new Error('Another device already started this allocation. Do not repeat the movement.');
    db.prepare('DELETE FROM cell_turns WHERE cell_id=? AND line_id!=?').run(allocation.cell_id,allocation.id);
    db.prepare("INSERT OR IGNORE INTO cell_turns(cell_id,line_id,actor_id,device_id,generation,acquired_at) VALUES(?,?,?,?,?,?)").run(allocation.cell_id,allocation.id,actor.id,input.deviceId,randomUUID(),now());
    if (allocation.execution_state === "ready") db.prepare("UPDATE task_lines SET execution_state='working',device_id=?,started_at=?,revision=revision+1 WHERE id=?").run(input.deviceId, now(), allocation.id);
    captureInstruction(allocation.id);
    db.prepare("UPDATE tasks SET last_touched_at=? WHERE id=?").run(now(), allocation.task_id);

    event("location_ready", actor, allocation.id, { method: input.method || "typed", device: input.deviceId, mode: allocation.guidance_mode });
    return { status: "ready", revision: line(allocation.id).revision, message: allocation.guidance_mode === "shared" ? "Shared location. Follow your phone's action and quantity; the light is only a locator." : "Your turn at this location. Confirm the actual quantity when finished." };
  }
  function reportActual(actor, input) {
    const allocation = line(input.lineId);
    if(input.cellCompletion===true&&input.differenceConfirmed!==true&&(Number(input.cellId)!==allocation.cell_id||Number(input.quantity)!==allocation.planned_quantity))throw new Error('Confirm the changed location or quantity before completing this cell.');
    const previousOwner = db.prepare('SELECT 1 FROM work_instruction_history WHERE line_id=? AND assignee_id=?').get(allocation.id,actor.id);
    if(actor.id!==allocation.assignee_id && !previousOwner && !can(actor,'review.resolve')) throw new Error('You can report only your own allocations or earlier assigned work.');
    const report = insertReport(actor, {...input,unknown:false}, allocation);
    if(!can(actor,"work.execute"))return review(report,"Permissions changed. Earlier physical evidence retained for authorized review; no inventory was posted.");
    if (input.dataset && input.dataset !== identity().dataset) return review(report, 'Report comes from an earlier restored dataset. Verify the original physical work.');
    if(actor.id!==allocation.assignee_id || input.assignmentGeneration!=null && Number(input.assignmentGeneration)!==allocation.current_generation) return review(report,'Ownership changed. Earlier physical evidence is retained under its original reporter; do not repeat the movement.');
    if(closure.hasClosed(allocation.task_id)||closure.pendingCase(allocation.task_id))return review(report,'Late physical evidence retained after a task closure request. A supervisor must reconcile it against the final task totals; stock was not changed.');
    if(allocation.review_followup)return review(report,'Physical evidence retained for verification during the assigned quantity check.');
    const settled = db.prepare('SELECT 1 FROM work_settlements WHERE line_id=?').get(allocation.id);
    if (settled) return settle(actor, report, allocation);
    if (report.product_id !== allocation.product_id || report.direction!==allocation.type || Number(input.revision) !== allocation.revision || input.unit !== allocation.unit_of_measure || Number(input.cellId) !== allocation.cell_id && !(input.cellCompletion===true&&input.differenceConfirmed===true)) return review(report, 'The original allocation, location, or unit changed. Your actual movement entry was retained; the replacement plan was not posted.');
    if(input.cellCompletion===true)db.prepare('UPDATE tasks SET explicit_close=1 WHERE id=?').run(allocation.task_id);
    if(input.cellCompletion===true&&Number(input.cellId)!==allocation.cell_id&&!db.prepare('SELECT 1 FROM cells WHERE id=? AND active=1').get(Number(input.cellId)))return review(report,'The actual location is inactive. A supervisor must verify the moved items before stock is changed.');
    if(input.method==='camera' && !validLocationLabel(db,identity().site,allocation,input.location)) return review(report,'The location label changed or does not match. Verify the original physical work.');
    if(input.method==='manual' && !String(input.manualReason||'').trim()) return review(report,'Manual completion needs a reason and verification of the cell.');
    if (db.prepare("SELECT 1 FROM work_reports WHERE line_id=? AND status='review' AND id!=?").get(allocation.id,report.id) || allocation.execution_state!=='working' || allocation.device_id!==input.deviceId || input.manual===true) return review(report,'Actual work received for supervisor verification. No new guidance or movement has been assumed.');
    return settle(actor,report,allocation);
  }
  function verify(actor,input) {
    const l=line(input.lineId);executeOwner(actor,l,input);
    if(l.execution_state!=='working'||l.revision!==Number(input.revision)||l.device_id!==input.deviceId||hasEvidence(l.id))throw new Error('This location changed or needs review. Refresh before finishing.');
    if(!validLocationLabel(db,identity().site,l,input.location))throw new Error('Wrong, unknown or revoked QR. Scan this cell’s label, complete manually, or report another location.');
    event('location_verified',actor,l.id,{cellId:l.cell_id});
    return {status:'verified',revision:l.revision,message:'Location checked. Press Finish only after moving the items.'};
  }
  function resolve(actor, input) {
    actorNow(actor, input.dismissDuplicate?"review.link":"review.resolve");
    if(input.stopRemaining)assertCan(actor,"review.stop");
    const report = db.prepare("SELECT * FROM work_reports WHERE id=?").get(input.reportId);
    if (!report) throw new Error("Report not found.");
    if (input.caseRevision!=null && Number(input.caseRevision)!==report.case_revision) throw new Error('Another supervisor changed this case. Refresh before resolving.');
    if (!['review','received'].includes(report.status)) return { status: "recorded", message: "This entry is already resolved.", reportId: report.id };
    if(JSON.parse(report.payload).taskClosure&&!input.keepOpen)return closure.resolve(actor,input,report);
    // Individual evidence remains reviewable; any resolution changes the aggregate progress token.

    if (input.keepOpen) { db.prepare("UPDATE work_reports SET case_revision=case_revision+1 WHERE id=?").run(report.id); event("verification_deferred", actor, report.line_id, { reason: input.verification || "Unable to verify" }, report.id); return { status: "review", message: "Kept pending. No quantity was assumed." }; }
    if(report.line_id&&line(report.line_id).review_followup){if(input.workerStopped!==true)throw new Error('Confirm the original worker has stopped before resolving this assigned quantity check.');db.prepare('UPDATE tasks SET review_handover_verified=1 WHERE id=?').run(line(report.line_id).task_id);}
    const verification = String(input.verification || "").trim();
    if (!verification) throw new Error("Choose how you verified the actual quantity.");
    if (/^Other evidence \(describe below\)(?::\s*)?$/.test(verification)) throw new Error("Describe the verification evidence.");
    const boundary=report.direction!=='count'?countBoundary(db,report,report.line_id?line(report.line_id):null):null;
    if(input.countCorrectionId) {
      const o=db.prepare(`SELECT o.*,i.cell_id FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id JOIN stocktake_settlements s ON s.observation_id=o.id WHERE o.id=?`).get(input.countCorrectionId);
      const counted=o?JSON.parse(o.lines_json).find(l=>l.productId===report.product_id):null;
      const alreadyLinked=db.prepare(`SELECT COALESCE(SUM(ABS(COALESCE(x.accounted_delta,r.quantity))),0) q FROM stocktake_movement_links x JOIN work_reports r ON r.id=x.report_id WHERE x.observation_id=? AND r.product_id=?`).get(input.countCorrectionId,report.product_id).q;
      const settlement=report.line_id?db.prepare('SELECT * FROM work_settlements WHERE line_id=?').get(report.line_id):null;
      const accountedDelta=(report.quantity-(settlement?.quantity||0))*(report.direction==='pick'?-1:1);
      if(!['pick','put'].includes(report.direction)||!o||o.cell_id!==report.cell_id||!counted||report.quantity_known===0||counted.unit!==report.unit||Math.sign(counted.difference)!==Math.sign(accountedDelta)||Math.abs(accountedDelta)+alreadyLinked>Math.abs(counted.difference)+1e-9)throw new Error('This correction does not account for the reported product, unit and quantity.');
      db.prepare('INSERT INTO stocktake_movement_links(report_id,observation_id,actor_id,evidence,created_at,accounted_delta) VALUES(?,?,?,?,?,?)').run(report.id,o.id,actor.id,verification,now(),accountedDelta);
      db.prepare("UPDATE work_reports SET status='duplicate',verification=?,resolver_id=?,resolved_at=? WHERE id=?").run(verification+'; accounted by stocktake '+o.id,actor.id,now(),report.id);
      db.prepare('INSERT OR IGNORE INTO work_origins(origin_ref,report_id) VALUES(?,?)').run(report.origin_ref,report.id);
      if(report.line_id){const l=line(report.line_id);if(!db.prepare('SELECT 1 FROM work_settlements WHERE line_id=?').get(l.id)){db.prepare('INSERT INTO work_settlements VALUES(?,?,?,?,?,?)').run(l.id,report.id,report.quantity,report.cell_id,report.unit,now());db.prepare("UPDATE task_lines SET execution_state='settled',actual_quantity=?,revision=revision+1 WHERE id=?").run(report.quantity,l.id);db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(l.id);releaseTurn(l);syncReservations();}}
      if(settlement){db.prepare('UPDATE work_settlements SET quantity=? WHERE line_id=?').run(report.quantity,report.line_id);db.prepare('UPDATE task_lines SET actual_quantity=?,revision=revision+1 WHERE id=?').run(report.quantity,report.line_id);}
      if(report.line_id)taskProgress(line(report.line_id).task_id);
      event('movement_accounted_by_stocktake',actor,report.line_id,{observationId:o.id,verification},report.id);
      return {status:'recorded',message:'Linked to the count correction. No stock was subtracted or added again.'};
    }
    if(boundary&&input.afterCountVerified!==true&&!input.dismissDuplicate)throw new Error('Review the stocktake correction first. Link it if it already accounts for this movement, or explicitly verify this was a separate later movement.');
    if (input.dismissDuplicate) {
      const linked = db.prepare("SELECT * FROM work_reports WHERE id=? AND status='posted'").get(input.duplicateOf);
      if (!linked || linked.id === report.id || linked.product_id!==report.product_id || linked.cell_id!==report.cell_id || linked.direction!==report.direction) throw new Error("Choose the recorded entry that already accounts for this movement.");
      const allocation = report.line_id ? line(report.line_id) : null;
      if (allocation && ['ready','working'].includes(allocation.execution_state)) {
        if (input.closeAllocation !== true) throw new Error('Confirm that the linked movement fully accounts for this allocation before closing it. Its reservation and turn remain held.');
        if (linked.product_id !== allocation.product_id || linked.cell_id !== allocation.cell_id || linked.unit !== allocation.unit_of_measure || (report.quantity_known !== 0 && (report.unit !== linked.unit || report.quantity !== linked.quantity))) {
          throw new Error('The linked movement does not match this allocation entry. Verify the actual quantity and location before resolving it.');
        }
        db.prepare("INSERT INTO work_settlements(line_id,report_id,quantity,cell_id,unit,created_at) VALUES(?,?,?,?,?,?)")
          .run(allocation.id, linked.id, linked.quantity, linked.cell_id, linked.unit, now());
        db.prepare("UPDATE task_lines SET actual_quantity=?,exception_quantity=?,execution_state='settled',revision=revision+1,note=? WHERE id=?")
          .run(linked.quantity, Math.max(0, rounded(allocation.planned_quantity-linked.quantity)), `${verification}; already covered by ${linked.id}`, allocation.id);
        db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(allocation.id);
        releaseTurn(allocation);
        syncReservations();
        db.prepare("UPDATE work_reports SET status='resolved',resolver_id=?,resolved_at=?,verification=? WHERE line_id=? AND status='review' AND origin_ref LIKE 'attention:%' AND id!=?")
          .run(actor.id, now(), verification, allocation.id, report.id);
        event('allocation_accounted_elsewhere', actor, allocation.id, { linkedReport:linked.id, quantity:linked.quantity, verification }, report.id);
      }
      db.prepare("UPDATE work_reports SET status='duplicate',verification=?,resolver_id=?,resolved_at=? WHERE id=?").run(`${verification}; already covered by ${linked.id}`, actor.id, now(), report.id);
      if (allocation) taskProgress(allocation.task_id);
      event("duplicate_verified", actor, report.line_id, { linkedReport: linked.id, verification }, report.id);
      return { status: "recorded", message: "Linked to its existing movement; no stock was posted again." };
    }
    const quantity = workQuantity(input.quantity);
    // Preserve the original report; supervisor's verified actual is a separate report.
    const verified = insertReport(actor, { ...JSON.parse(report.payload), productId: report.product_id, cellId: report.cell_id,
      direction: report.direction, unit: report.unit, quantity, occurredAt:report.occurred_at || report.created_at, unknown:false, origin: report.origin_ref, reason: verification, countBoundaryCleared:input.afterCountVerified===true,
      performerId: Object.hasOwn(input, "performerId") ? input.performerId : report.performer_id }, report.line_id ? line(report.line_id) : null);
    let result;
    if (report.direction === "count") {
      db.prepare("UPDATE work_reports SET status='resolved',resolver_id=?,resolved_at=?,verification=? WHERE id IN (?,?)").run(actor.id,now(),verification,report.id,verified.id);
      event("count_observation_reviewed",actor,null,{observed:quantity,verification,noStockChange:true},report.id);
      return {status:"recorded",message:"Count observation reviewed. No stock balance was replaced. Record any separately verified movement or correction with its own evidence."};
    }
    if (report.line_id) result = settle(actor, verified, line(report.line_id), true, verification);
    else result = postManual(actor, verified, verification, input);
    if (result.status === "recorded") {
      db.prepare("UPDATE work_reports SET status='resolved',resolver_id=?,resolved_at=?,verification=? WHERE id=?").run(actor.id, now(), verification, report.id);
      if (report.line_id) {
        db.prepare("UPDATE work_reports SET status='resolved',resolver_id=?,resolved_at=?,verification=? WHERE line_id=? AND status='review' AND origin_ref LIKE 'attention:%'").run(actor.id, now(), verification, report.line_id);
        if(input.stopRemaining) stopTask(actor,{taskId:line(report.line_id).task_id,generation:db.prepare('SELECT assignment_generation FROM tasks WHERE id=?').get(line(report.line_id).task_id).assignment_generation});
        taskProgress(line(report.line_id).task_id);
      }
    }
    return result;
  }
  function resolveAndAssignRemaining(actor,input){
    assertCan(actor,'review.resolve');assertCan(actor,'review.stop');assertCan(actor,'work.assign');
    const report=db.prepare('SELECT * FROM work_reports WHERE id=?').get(input.reportId);
    if(!report||!['review','received'].includes(report.status)||!JSON.parse(report.payload).taskClosure)throw new Error('Open the current task completion review before assigning remaining work.');
    const original=currentTask(actor,input,true),first=line(report.line_id);
    if(first.task_id!==original.id)throw new Error('This review belongs to another task.');
    const assigned=eligibleAssignee(actor,input.assigneeId);
    if(!Array.isArray(input.actuals))throw new Error('Confirm the actual quantities at each location first.');
    const actual=rounded(input.actuals.reduce((sum,row)=>sum+workQuantity(row.quantity),0));
    const remaining=rounded(original.requested_quantity-actual);
    if(remaining<=0)throw new Error('No quantity remains to assign. Save the actual movement and close this task instead.');
    const closed=closure.resolve(actor,input,report);
    const next=create(actor,{direction:original.type,productId:first.product_id,quantity:remaining,assigneeId:assigned.id},true);
    assignmentEvent(actor,original.id,'reopened',original.assignee_id,{nextTaskId:next.taskId,quantity:remaining,unit:first.unit_of_measure});
    assignmentEvent(actor,next.taskId,'reopened_from',null,{sourceTaskId:original.id});
    return {...closed,newTaskId:next.taskId,message:`Actual movement accepted. Task #${next.taskId} assigned for the remaining ${remaining} ${first.unit_of_measure}.`};
  }
  function postManual(actor, report, verification, input) {
    if(countBoundary(db,report)&&input.afterCountVerified!==true)throw new Error('A stocktake correction may already account for this movement. Verify or link it first.');
    const mapping = manualAccounting(report);
    const existing = db.prepare("SELECT r.* FROM work_origins o JOIN work_reports r ON r.id=o.report_id WHERE o.origin_ref=?").get(report.origin_ref);
    if (existing) {
      const sameMovement = existing.product_id===report.product_id && existing.cell_id===report.cell_id && existing.direction===report.direction;
      const sameOriginal = existing.quantity===report.quantity && existing.unit===report.unit;
      const sameAccounting = existing.accounting_unit===report.unit && existing.accounting_quantity===report.quantity;
      if (sameMovement && (sameOriginal || sameAccounting)) {
        db.prepare("UPDATE work_reports SET status='duplicate',resolved_at=?,resolver_id=?,verification=? WHERE id=?").run(now(),actor.id,verification,report.id);
        return {status:'recorded',duplicate:true,reportId:existing.id,message:'This movement reference was already recorded.'};
      }
      return review(report, 'This movement reference was already posted with different details. Verify whether this is a correction or another physical movement.');
    }
    let quantity = mapping.quantity, evidence = mapping.evidence;
    if (report.unit !== mapping.unit || !mapping.available) {
      quantity = workQuantity(input.accountingQuantity);
      if (input.accountingUnit !== mapping.unit) throw new Error('The accounting unit changed. Refresh and verify the current-unit quantity.');
      if (mapping.available) {
        if (quantity !== mapping.quantity) throw new Error(`Recorded conversion gives ${mapping.quantity} ${mapping.unit}. Verify that exact accounting quantity.`);
      } else {
        const provenance = String(input.conversionProvenance || '').trim();
        if (!provenance) throw new Error('Conversion history is unavailable or exceeds supported precision. Enter a verified current-unit quantity and its evidence; no factor will be guessed.');
        evidence = `Supervisor established ${quantity} ${mapping.unit} for original ${report.quantity} ${report.unit}: ${provenance}`;
      }
    }
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(report.product_id);
    const onHand = balance(report.product_id, report.cell_id);
    if (report.direction === 'pick' && quantity > onHand) markDiscrepancy(report.cell_id,report.product_id,'Verified manual pick exceeds book stock. Full actual recorded; reconcile missing movements.');
    const delta = report.direction === 'pick' ? -quantity : quantity;
    movement({actor,performer:report.performer_id,productId:report.product_id,cellId:report.cell_id,quantity:delta,type:report.direction,origin:report.origin_ref,reason:verification,unit:mapping.unit});
    db.prepare('UPDATE work_reports SET accounting_quantity=?,accounting_unit=?,conversion_evidence=? WHERE id=?').run(quantity,mapping.unit,evidence,report.id);
    if (report.direction==='pick' && onHand+delta<held(report.cell_id,report.product_id,'pick')) markDiscrepancy(report.cell_id,report.product_id,'Verified manual pick left outstanding reservations short. Existing claims were not silently reduced.');
    if (report.direction==='put' && !compatible(report.cell_id,report.product_id)) markDiscrepancy(report.cell_id,report.product_id,'Verified manual movement left mixed products in this location.');
    if (report.direction==='put' && usedSpace(db,report.cell_id)>1+1e-9) markDiscrepancy(report.cell_id,report.product_id,'Verified manual put exceeds planned capacity. Review the location.');
    event('manual_quantity_verified',actor,null,{originalQuantity:report.quantity,originalUnit:report.unit,accountingQuantity:quantity,accountingUnit:mapping.unit,evidence,performerId:report.performer_id},report.id);
    db.prepare("INSERT INTO work_origins(origin_ref,report_id) VALUES(?,?)").run(report.origin_ref, report.id);
    db.prepare("UPDATE work_reports SET status='posted',resolved_at=?,resolver_id=?,verification=? WHERE id=?").run(now(), actor.id, verification, report.id);
    event("manual_movement_recorded", actor, null, { quantity: report.quantity, direction: report.direction, verification }, report.id);
    return { status: "recorded", reportId: report.id, message: "Completed physical movement recorded. No lights or new task were activated." };
  }
  function cancel(actor, input) {
    const allocation=line(input.lineId);own(actor,allocation);
    if(allocation.review_followup)throw new Error('Check moved quantity first. Return or stop the task to hand back remaining work.');
    if(Number(input.revision)!==allocation.revision || !['ready','working'].includes(allocation.execution_state))throw new Error('This allocation changed. Refresh; preserve any physical entry.');
    if(hasEvidence(allocation.id))throw new Error('Resolve pending physical entries before cancelling this location.');
    if(allocation.execution_state==='working') {
      executeOwner(actor,allocation,input);
      if(input.zeroConfirmed!==true)throw new Error('Explicitly declare Nothing moved before cancelling started work.');
      return reportActual(actor,{...input,quantity:0,cellId:allocation.cell_id,unit:allocation.unit_of_measure});
    }
    releaseUntouched(actor,allocation,'cancelled');taskProgress(allocation.task_id);
    return {status:'recorded',message:'Nothing moved — location cancelled. Only its reservation was released.'};
  }
  function rejectCell(actor,input){
    const allocation=line(input.lineId);own(actor,allocation);executeOwner(actor,allocation,input);
    if(!['ready','working'].includes(allocation.execution_state)||Number(input.revision)!==allocation.revision||hasEvidence(allocation.id))throw new Error('This cell changed. Refresh the task before rejecting it.');
    if(allocation.execution_state==='working'&&allocation.device_id!==input.deviceId)throw new Error('This cell is active on another device. Resume there or ask a supervisor to check it.');
    if(input.zeroConfirmed!==true)throw new Error('Confirm that nothing moved at this cell. If stock moved, record the actual quantity instead.');
    const reasons=['Location is full','Different product is here','Insufficient quantity','Location cannot be reached','Other'];
    if(!reasons.includes(input.reason)||input.reason==='Other'&&!String(input.note||'').trim())throw new Error('Choose a reason, or describe the issue under Other.');
    const reason=input.reason+(input.note?' — '+String(input.note).trim().slice(0,500):'');
    db.prepare('UPDATE tasks SET explicit_close=1 WHERE id=?').run(allocation.task_id);
    const report=insertReport(actor,{...input,quantity:0,cellId:allocation.cell_id,unit:allocation.unit_of_measure,reason,cellRejection:true},allocation);
    db.prepare("UPDATE task_lines SET execution_state='cancelled',revision=revision+1,note=? WHERE id=?").run(reason,allocation.id);
    db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(allocation.id);
    releaseTurn(allocation);syncReservations();
    const result=review(report,'This cell was skipped with zero movement. Check the reason and assign the remaining work or close the task.');
    event('cell_rejected',actor,allocation.id,{reason,reportId:report.id},report.id);taskProgress(allocation.task_id);
    return {...result,taskId:allocation.task_id,message:'Cell skipped. The supervisor can review and reassign the remaining work.'};
  }
  function correct(actor, input, verified = false) {
    const allocation = line(input.lineId); if(allocation.assignee_id!==actor.id)assertCan(actor,"review.resolve");
    if(allocation.review_followup&&!verified&&!can(actor,'review.resolve'))throw new Error('This task is assigned for observation only. Save an observation for the verifier before correcting recorded movements.');
    if(!verified&&!can(actor,'work.correct'))return review(insertReport(actor,{...input,correction:true,reason:input.verification||input.reason||'Earlier record correction received after permissions changed'},allocation),'Permission changed. Earlier correction retained for supervisor verification; no stock was posted.');
    if (allocation.execution_state !== "settled" || Number(input.revision) !== allocation.revision) throw new Error("This recorded allocation changed. Refresh before correcting it.");
    if (db.prepare("SELECT 1 FROM work_events WHERE line_id=? AND event_type IN ('allocation_accounted_elsewhere','movement_accounted_by_stocktake')").get(allocation.id)) throw new Error('This allocation is covered by an existing movement. Correct the original movement record so stock is adjusted only once.');
    const verification = String(input.verification || "").trim();
    if (!verification) throw new Error("Give a reason for correcting this earlier record. Use Record completed movement for a new physical return or pick.");
    const factor=historicalFactor(db,allocation.product_id,allocation.unit_of_measure,allocation.completed_at||allocation.started_at);
    const quantity = workQuantity(input.quantity);
    if(!verified&&countBoundary(db,{cell_id:allocation.cell_id},allocation))return review(insertReport(actor,{...input,productId:allocation.product_id,cellId:allocation.cell_id,direction:allocation.type,quantity,unit:allocation.unit_of_measure},allocation),'This earlier correction overlaps a stocktake. Verify whether its difference is already included before changing stock again.');
    const delta = rounded((quantity - allocation.actual_quantity) * factor * (allocation.type === "pick" ? -1 : 1));
    const next = rounded(balance(allocation.product_id, allocation.cell_id) + delta);
    const shortage=next<0 || next<protectedPicks(db,allocation.cell_id,allocation.product_id);
    const overflow=delta>0 && usedSpace(db,allocation.cell_id)+delta/allocation.items_per_cell>1+1e-9;
    if((shortage||overflow)&&!verified) return review(insertReport(actor,{...input,unit:allocation.unit_of_measure,cellId:allocation.cell_id,quantity,reason:verification,correction:true},allocation),'Proposed correction conflicts with stock or reservations. The full proposal is retained for supervisor verification.');
    if(shortage||overflow) markDiscrepancy(allocation.cell_id,allocation.product_id,'Supervisor verified a correction that leaves a stock/capacity discrepancy. Existing reservations remain intact.');
    movement({ actor, performer: verified ? performerFor(actor,input) : (db.prepare("SELECT performer_id FROM work_reports WHERE id=(SELECT report_id FROM work_settlements WHERE line_id=?)").get(allocation.id)?.performer_id ?? null), productId: allocation.product_id, cellId: allocation.cell_id,
      quantity: delta, type: "adjustment", taskId: allocation.task_id, lineId: allocation.id,
      origin: `correction:${input.requestId}`, reason: verification, unit: allocation.current_unit });
    db.prepare("UPDATE task_lines SET actual_quantity=?,exception_quantity=?,revision=revision+1 WHERE id=?").run(quantity, Math.max(0, allocation.planned_quantity - quantity), allocation.id);
    db.prepare("UPDATE work_settlements SET quantity=? WHERE line_id=?").run(quantity, allocation.id);
    taskProgress(allocation.task_id);
    event("record_corrected", actor, allocation.id, { previous: allocation.actual_quantity, actual: quantity, verification });
    return { status: "recorded", message: "Correction recorded with its previous value preserved in history." };
  }
  function replan(actor,input) {
    const old=line(input.lineId);own(actor,old);
    if(old.review_followup)throw new Error('Check moved quantity first.');
    if(old.type!=='put'||old.execution_state!=='ready'||old.revision!==Number(input.revision))throw new Error("Only an unchanged, unstarted put allocation can be replanned.");
    if(db.prepare("SELECT 1 FROM work_reports WHERE line_id=? AND status IN ('review','received')").get(old.id))throw new Error("Resolve this allocation's physical entries before replanning it.");
    const cell=db.prepare("SELECT * FROM cells WHERE id=? AND active=1").get(Number(input.cellId));
    const quantity=workQuantity(input.quantity,true);
    if(!cell||(!old.allow_mixed_put&&!compatible(cell.id,old.product_id,old.id))||quantity>putRoom(db,cell.id,old,{excludingLine:old.id})+1e-9)throw new Error("Replacement allocation exceeds available compatible capacity.");
    db.prepare("UPDATE task_lines SET execution_state='superseded',revision=revision+1 WHERE id=?").run(old.id);
    db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(old.id);
    tasks.addLine(old.task_id,{product_id:old.product_id,cell_id:cell.id,planned_quantity:quantity,guidance_color:'red'});
    const fresh=db.prepare("SELECT id FROM task_lines WHERE task_id=? ORDER BY id DESC LIMIT 1").get(old.task_id);
    db.prepare("UPDATE task_lines SET execution_state='ready' WHERE id=?").run(fresh.id);
    db.prepare("INSERT INTO work_reservations(line_id,kind,quantity) VALUES(?,'put',?)").run(fresh.id,quantity);
    db.prepare("UPDATE tasks SET plan_revision=plan_revision+1,last_touched_at=? WHERE id=?").run(now(),old.task_id);
    captureInstruction(fresh.id);
    event('allocation_replanned',actor,old.id,{replacementLineId:fresh.id,oldCell:old.cell_id,cellId:cell.id,quantity});
    return {status:'recorded',message:'Unstarted allocation replanned. Earlier instructions remain in the audit history.'};
  }
  function recordMovement(actor,input){
    actorNow(actor,'work.report');
    if(input.confirmed!==true)throw new Error('Confirm that these items have already been moved.');
    const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(input.productId));
    if(!product)throw new Error('Choose an active product.');
    if(input.unit!==product.unit_of_measure)throw new Error('The product unit changed. Refresh the product before saving.');
    if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>100)throw new Error('Add between 1 and 100 movement rows.');
    const performer=performerFor(actor,input,actor.id),picks=new Map();
    const rows=input.rows.map((row,index)=>{
      if(!['pick','put'].includes(row.direction))throw new Error(`Row ${index+1}: choose Pick or Put.`);
      assertCan(actor,row.direction==='pick'?'work.pick':'work.put');
      const cell=db.prepare('SELECT id,logical_code FROM cells WHERE id=? AND active=1').get(Number(row.cellId));
      if(!cell)throw new Error(`Row ${index+1}: choose an active location.`);
      const quantity=workQuantity(row.quantity,true);
      if(row.direction==='pick')picks.set(cell.id,rounded((picks.get(cell.id)||0)+quantity));
      return {...row,cellId:cell.id,quantity,location:cell.logical_code};
    });
    for(const [cellId,quantity] of picks){const stock=balance(product.id,cellId);if(stock<=0||quantity>stock+1e-9){const name=rows.find(r=>r.cellId===cellId).location;throw new Error(`${name}: ${stock} ${product.unit_of_measure} recorded here; cannot record a pick of ${quantity}. Choose a location holding this product or correct its stock in Stocktaking first.`);}}
    const transactionIds=rows.map((row,index)=>movement({actor,performer,productId:product.id,cellId:row.cellId,quantity:row.quantity*(row.direction==='pick'?-1:1),type:row.direction,origin:'record-movement:'+input.requestId+':'+index,reason:String(input.note||'Work already completed').slice(0,2000),unit:product.unit_of_measure}));
    for(const row of rows)if(held(row.cellId,product.id,'pick')>balance(product.id,row.cellId))markDiscrepancy(row.cellId,product.id,'Recorded movement left reserved picks short. Check outstanding tasks.');
    syncReservations();
    event('completed_movements_recorded',actor,null,{productId:product.id,rows,transactionIds});
    return {status:'recorded',transactionIds,message:'Movement saved. Stock updated.'};
  }
  const actions = {
    recommendation(actor,input) {
      if(input.physicalConfirmed!==true||!String(input.reason||'').trim())throw new Error('Confirm the actual physical movements and record what happened.');
      if(!Array.isArray(input.moves)||!input.moves.length)throw new Error('Enter the actual for each planned movement, including zero.');
      const reports=[];
      for(const [index,move] of input.moves.entries()) {
        if(Number(move.sourceCellId)===Number(move.targetCellId))throw new Error('Source and target must differ.');
        for(const [direction,cellId,value] of [['pick',move.sourceCellId,move.picked],['put',move.targetCellId,move.put]]) {
          const quantity=workQuantity(value);
          const report=insertReport(actor,{productId:input.productId,cellId,direction,quantity,origin:'recommendation:'+input.requestId+':'+index+':'+direction,reason:input.reason,unknown:false});
          review(report,'Recommendation physical result retained for verification. Picked and put quantities are separate; no planned quantity was posted.');reports.push(report.id);
        }
      }
      event('recommendation_observed',actor,null,{...input,reports});
      return {status:'review',reportIds:reports,message:'Actual movements saved for supervisor verification, including any partial or interrupted move. No suggested quantity was posted automatically.'};
    },
    locationDetails(actor,input) {actorNow(actor,"locations.manage");const result=saveLocationDescription(db,actor,input);event("location_description_changed",actor,null,input);return result;},
    closeTask:closure.close,sendTaskReview:closure.send,
    assign:(actor,input)=>create(actor,input,true), reopen:reopenTask, updateReviewTask, replan, verify, start: startTask, decline: returnTask, handBack:(actor,input)=>returnTask(actor,input,true), acknowledgeReturn, updateReturned, assignReview, observeReview, resumeFollowup, reassign, stop: stopTask, deadline, timing: saveTiming, askReview,
    reconcile(actor,input) {
      actorNow(actor,"review.reconcile");
      const cell=Number(input.cellId),product=Number(input.productId),quantity=workQuantity(input.quantity);
      if(!input.verification)throw new Error('Record how you verified the reconciled location.');
      if(held(cell,null,'pick')||held(cell,null,'put')||db.prepare("SELECT 1 FROM work_reports WHERE cell_id=? AND status IN ('received','review')").get(cell))throw new Error('Resolve outstanding allocations and movement entries at this location first.');
      if(quantity!==balance(product,cell))throw new Error('Verified count differs from the ledger. Record the separately verified correction before clearing this discrepancy.');
      db.prepare('DELETE FROM work_discrepancies WHERE cell_id=? AND product_id=?').run(cell,product);
      event('location_reconciled',actor,null,input);
      return {status:'recorded',message:'Verified location reconciled and available for new plans.'};
    },
    create, resume:resumeTask, pause:pauseTask, guide, acquire, report: reportActual, resolve, resolveAndAssignRemaining, cancel, rejectCell, correct,
    recordMovement,
    manual(actor, input) { const report = insertReport(actor, {...input,unknown:false}); return review(report, input.direction === "count" ? "Count observation during ongoing work; no balance replacement was made." : "Completed movement received for supervisor verification. No new instructions were activated."); },
    mode(actor, input) {
      actorNow(actor, "locations.mode");
      if (!["exclusive", "shared"].includes(input.mode)) throw new Error("Choose exclusive or shared guidance.");
      if (db.prepare(`SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.cell_id=? AND r.state='held'`).get(Number(input.cellId))) throw new Error("Settle outstanding allocations before changing this location's guidance mode.");
      db.prepare("UPDATE cells SET guidance_mode=? WHERE id=?").run(input.mode, Number(input.cellId));
      event("guidance_mode_changed", actor, null, input);
      return { status: "recorded", message: "Location guidance mode updated." };
    },
  };
  function command(actor, action, input) {
    if (!actions[action]) throw new Error("Unknown work action.");
    const id = String(input.requestId || "");
    if (id.length < 8 || id.length > 160) throw new Error("A stable request identity is required. Reload the form; keep any physical entry for review.");
    const fingerprint = createHash("sha256").update(canonical({ action, input })).digest("hex");
    const result = withTransaction(db, () => {
      const current = actorNow(actor);
      if(input.actorId!=null && Number(input.actorId)!==current.id)throw new Error("This saved command belongs to another account. Sign in as its original reporter.");
      if (input.site && input.site !== identity().site) throw new Error("This saved update belongs to another warehouse.");
      const receipt = db.prepare("SELECT * FROM operation_receipts WHERE actor_id=? AND request_id=?").get(current.id, id);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error("This request was already submitted with different details. Retrieve its result before changing the entry.");
        return { ...JSON.parse(receipt.result_json), replayed: true };
      }
      if (input.dataset && input.dataset !== identity().dataset && !["report", "manual"].includes(action)) throw new Error("The warehouse dataset changed. Refresh before requesting new work.");
      const permissions={reopen:'work.assign',updateReviewTask:'work.assign',closeTask:can(current,'work.stop')?'work.stop':'work.teamStop',sendTaskReview:can(current,'work.stop')?'work.stop':'work.teamStop',resume:'work.execute',pause:'work.execute',guide:'work.execute',assign:'work.assign',create:input.direction==='put'?'work.put':'work.pick',acquire:'work.execute',verify:'work.execute',start:'work.execute',decline:'work.execute',handBack:'work.execute',assignReview:'work.assign',observeReview:'work.execute',resumeFollowup:'work.execute',acknowledgeReturn:'work.assign',updateReturned:'work.assign',reassign:'work.assign',stop:can(current,'work.stop')?'work.stop':'work.teamStop',deadline:'work.deadline',timing:'work.timing',askReview:'work.report',report:'work.execute',manual:'work.report',recordMovement:'work.report',recommendation:'work.report',cancel:'work.stop',rejectCell:'work.stop',correct:'work.correct',replan:'work.execute',locationDetails:'locations.manage',mode:'locations.mode',reconcile:'review.reconcile',resolve:input.dismissDuplicate?'review.link':'review.resolve',resolveAndAssignRemaining:'review.resolve'};
      const required=permissions[action];if(!required)throw new Error('Unknown work permission.');
      if(!can(current,required)&&!['report','manual','askReview','correct'].includes(action))assertCan(current,required);
      if(['reassign','stop','handBack','decline'].includes(action)&&input.progressToken&&input.progressToken!==progressToken(Number(input.taskId)))throw new Error('Task quantities changed. Refresh before changing this task.');
      if(input.assignmentEditor==='task'){
        if(!['reassign','updateReturned','assignReview'].includes(action))throw new Error('Invalid assignment action.');
        const t=currentTask(current,input,true);
        if(input.progressToken!==progressToken(t.id))throw new Error('Task quantities or assignment changed. Refresh before saving.');
        if(Number(input.assigneeId)===t.assignee_id)throw new Error('Choose another person to change the assignment.');
      }
      const value = actions[action](current, input);
      if(['create','assign','start','reopen','updateReturned','updateReviewTask','resumeFollowup','replan','report'].includes(action)){
        const taskId=value.taskId||input.taskId||(input.lineId?line(input.lineId).task_id:null);
        if(taskId)flagDisplacedReservations(current,taskId);
      }
      reconcileGuidance();
      db.prepare("INSERT INTO operation_receipts(actor_id,request_id,fingerprint,result_json,created_at) VALUES(?,?,?,?,?)")
        .run(current.id, id, fingerprint, JSON.stringify(value), now());
      return value;
    });
    if(action==='observeReview'||['guide','resume','start','create'].includes(action)&&result.replayed)return result;
    try { flushGuidance(['guide','resume'].includes(action)?{claims:result.guidanceClaims}:{}); } catch (error) { logger?.warn?.("work.guidance.deferred", { error: error.message }); }
    return result;
  }
  function overridingQuantityDisplay(cellId) {
    return !!db.prepare(`SELECT 1 FROM display_requests d, json_each(d.targets_json) t
      WHERE d.state IN ('active','expiring') AND json_extract(d.scope_json,'$.overrideWork')=1
      AND json_extract(t.value,'$.cellId')=? AND json_extract(t.value,'$.status')='sent' LIMIT 1`).get(cellId);
  }
  function flushGuidance({restore=false,restoreCells=[],claims=null}={}) {
    withTransaction(db,()=>{
      reconcileGuidance();
      if(restore){db.prepare("UPDATE work_guidance SET delivered=0 WHERE json_extract(desired,'$.action') IN ('quantity','locate','count')").run();}
      for (const cellId of restoreCells) db.prepare("UPDATE work_guidance SET delivered=0 WHERE cell_id=?").run(cellId);
    });
    if (!hardwareService) return;
    for (const row of db.prepare("SELECT * FROM work_guidance WHERE delivered=0").all()) {
      if (overridingQuantityDisplay(row.cell_id)) continue;
      const desired = JSON.parse(row.desired);
      if(claims&&!claims.some(c=>c.cellId===row.cell_id&&c.generation===row.generation&&c.lineId===desired.lineId))continue;
      const cell = db.prepare("SELECT c.*,ctrl.address AS controller_address FROM cells c LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?").get(row.cell_id);
      if (!cell || desired.binding!==guidanceBinding(db,row.cell_id)) continue;
      let result;
      const context = { workGeneration: row.generation, workCellId: row.cell_id, workBinding:desired.binding, source: "work_coordinator" };
      if (desired.action === "clear") {
        result = hardwareService.clearGuidance({ id: null, type: "pick" }, [cell], context);
      } else if(desired.action==='count'){
        result=hardwareService.showCellQuantity(cell,'LOC','yellow',context);
      } else {
        const allocation = line(desired.lineId);
        if (!["ready","working"].includes(allocation.execution_state)) continue;
        result = desired.action === "locate"
          ? hardwareService.showCellQuantity(cell, "LOC", "yellow", context)
          : hardwareService.activateGuidance({ id: allocation.task_id, type: allocation.type }, [allocation], context);
      }
      if (result?.ok && !result.degraded) db.prepare("UPDATE work_guidance SET delivered=1 WHERE cell_id=? AND generation=?").run(row.cell_id, row.generation);
    }
  }
  function guidanceStatus(l,actor=null){
    if(l.assignment_state!=='started'||!['ready','working'].includes(l.execution_state))return null;
    const problem=instructionProblem(l);if(problem)return {state:'blocked',message:problem};
    if(db.prepare('SELECT guidance_paused FROM tasks WHERE id=?').get(l.task_id)?.guidance_paused)return {state:'paused',message:'Task paused — Resume task to relight the locations.'};
    const owner=displayOwner(db,l.cell_id);
    if(owner&&(owner.kind!=='task'||owner.lineId!==l.id)){
      const visible=actor&&(owner.kind==='task'?can(actor,'work.team')||db.prepare('SELECT 1 FROM tasks WHERE id=? AND (assignee_id=? OR created_by=?)').get(owner.taskId,actor.id,actor.id):can(actor,'count.team'));
      return {state:'waiting',message:waitingMessage(owner),blocker:{kind:owner.kind,name:owner.name,taskId:owner.taskId,runId:owner.runId,...(visible?{href:owner.kind==='task'?'/tasks/'+owner.taskId:'/stocktaking?run='+owner.runId}:{})}};
    }
    if(metadata('firmware_busy'))return {state:'manual',message:'Controller maintenance is in progress. Follow the cell instructions on screen.'};
    if(!l.controller_id||!l.hardware_channel)return {state:'manual',message:'Manual location — follow the cell name and quantity on your screen.'};
    const row=db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(l.cell_id),d=row?JSON.parse(row.desired):null;
    if(!owner)return {state:'blocked',message:'This task is not eligible for light guidance. Refresh its assignment and permissions.'};
    if(overridingQuantityDisplay(l.cell_id))return {state:'manual',message:'Light temporarily shows another display. Use the task instructions on screen; task guidance returns when that display ends.'};
    if(!row.delivered||d.binding!==guidanceBinding(db,l.cell_id))return {state:'manual',message:'Light not confirmed sent — follow the cell name and quantity on your screen.'};
    return d.action==='locate'?{state:'shared',message:'Your task owns this locator — use your action and quantity on screen.'}:{state:'sent',message:`Quantity guidance sent: ${l.planned_quantity} ${l.unit_of_measure}. Check the cell label on arrival.`};
  }
  function task(actor, id) {
    const current=actorNow(actor),result=tasks.get(Number(id));if(!result)return null;
    const history=db.prepare(`SELECT e.*,u.name AS actor_name,a.name AS assignee_name,prev.name AS previous_name FROM task_assignment_events e
      JOIN users u ON u.id=e.actor_id LEFT JOIN users a ON a.id=e.assignee_id LEFT JOIN users prev ON prev.id=e.previous_assignee WHERE task_id=? ORDER BY e.id`).all(result.id);
    const wasAssigned=result.created_by===current.id||history.some(e=>e.assignee_id===current.id||e.previous_assignee===current.id);
    assertCan(current,'work.view');
    if(!can(current,'work.team')&&!(can(current,'review.view')&&db.prepare("SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received')").get(result.id))&&result.assignee_id!==current.id&&!wasAssigned)throw new Error('This task belongs to another operator.');
    const firstMovement=db.prepare('SELECT product_quantity_before,unit_of_measure FROM transactions WHERE task_id=? ORDER BY id LIMIT 1').get(result.id),lastMovement=db.prepare('SELECT product_quantity_after,unit_of_measure FROM transactions WHERE task_id=? ORDER BY id DESC LIMIT 1').get(result.id);
    result.quantity_before=firstMovement?.product_quantity_before??null;result.quantity_after=lastMovement?.product_quantity_after??null;result.quantity_before_unit=firstMovement?.unit_of_measure;result.quantity_after_unit=lastMovement?.unit_of_measure;
    result.canAct=can(current,"work.execute")&&result.assignee_id===current.id;
    const assignee=db.prepare('SELECT name,username FROM users WHERE id=?').get(result.assignee_id);result.assignee_name=assignee?.name||null;result.assignee_username=assignee?.username||null;
    const assigner=db.prepare('SELECT name,username FROM users WHERE id=?').get(result.assigned_by);result.assigned_by_name=assigner?.name||null;result.assigned_by_username=assigner?.username||null;
    result.assignment_history=history;
    const previousAssignment=[...history].reverse().find(e=>e.assignee_id!=null||e.previous_assignee!=null);
    result.previous_assignee_id=result.assignee_id??previousAssignment?.assignee_id??previousAssignment?.previous_assignee??null;
    result.reopened_task_id=JSON.parse(history.find(e=>e.event_type==='reopened')?.payload||'{}').nextTaskId||null;
    result.reopened_from_task_id=JSON.parse(history.find(e=>e.event_type==='reopened_from')?.payload||'{}').sourceTaskId||null;
    result.progress_token=progressToken(result.id);
    result.closure_token=closure.token(result.id);result.recorded_movements=closure.totals(result.id);result.closure_review_id=closure.pendingCase(result.id)?.id||null;result.closure_case_revision=result.closure_review_id?db.prepare('SELECT case_revision FROM work_reports WHERE id=?').get(result.closure_review_id).case_revision:null;result.closure_count_options=can(current,'review.resolve')?db.prepare('SELECT o.id,o.lines_json,i.cell_id,c.logical_code,r.title FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id JOIN cells c ON c.id=i.cell_id JOIN stocktake_runs r ON r.id=i.run_id JOIN stocktake_settlements s ON s.observation_id=o.id ORDER BY s.created_at DESC LIMIT 100').all():[];result.closed_actuals=closure.hasClosed(result.id);result.closure_actuals=result.closure_review_id?JSON.parse(db.prepare('SELECT payload FROM work_reports WHERE id=?').get(result.closure_review_id).payload).actuals:null;
    result.review_observations=db.prepare("SELECT e.*,u.name AS observer_name,c.logical_code FROM work_events e JOIN task_lines l ON l.id=e.line_id JOIN cells c ON c.id=l.cell_id JOIN users u ON u.id=e.actor_id WHERE l.task_id=? AND e.event_type='review_observation' ORDER BY e.id").all(result.id);
    const returned=history.filter(e=>e.event_type==='returned').at(-1);
    if(returned){result.return_event={...returned,...JSON.parse(returned.payload),acknowledgement:db.prepare('SELECT a.*,u.name AS actor_name FROM work_return_acknowledgements a JOIN users u ON u.id=a.actor_id WHERE a.return_event_id=?').get(returned.id)||null};}
    result.lines=result.lines.map(item=>({...line(item.id),guidance:guidanceStatus(line(item.id),current),canAct:result.canAct&&result.assignment_state!=='offered'&&!result.review_followup,
      directions:JSON.parse(item.instruction_snapshot||'null')||describeLocation(db,item.cell_id),
      attribution:db.prepare(`SELECT p.name AS performer,r.name AS reporter,v.name AS reviewer FROM work_settlements s JOIN work_reports w ON w.id=s.report_id
        LEFT JOIN users p ON p.id=w.performer_id LEFT JOIN users r ON r.id=w.reporter_id LEFT JOIN users v ON v.id=w.resolver_id WHERE s.line_id=?`).get(item.id)||null,
      reserved:db.prepare("SELECT quantity FROM work_reservations WHERE line_id=? AND state='held'").get(item.id)?.quantity||0,
      reports:db.prepare(`SELECT r.id,r.status,r.quantity,r.quantity_known,r.unit,r.reason,json_extract(r.payload,'$.reason') AS entered_reason,r.created_at,performer.name AS performer_name,reporter.name AS reporter_name FROM work_reports r LEFT JOIN users performer ON performer.id=r.performer_id LEFT JOIN users reporter ON reporter.id=r.reporter_id WHERE r.line_id=? ORDER BY r.created_at DESC`).all(item.id)}));
    if(result.lines[0])result.summary=`${result.type==='pick'?'Pick':'Put'} ${result.requested_quantity} ${result.lines[0].unit_of_measure} of ${result.lines[0].product_name}`;
    result.recorded_quantity=rounded(result.lines.filter(l=>l.execution_state==='settled').reduce((n,l)=>n+l.actual_quantity,0));
    result.remaining_quantity=Math.max(0,rounded(result.requested_quantity-result.recorded_quantity));
    result.outcome=result.attention?'needs_review':result.assignment_state==='returned'&&!result.stop_requested?'needs_assignment':result.outcome==='open'&&result.completed_at?(result.recorded_quantity>=result.requested_quantity?'completed':result.recorded_quantity>0?'stopped':'cancelled'):result.outcome;
    const due=Date.parse(result.due_at),time=Date.now();
    result.clock_invalid=!Number.isFinite(time)||time<Date.parse(result.started_at)-60000;
    result.overdue=!result.clock_invalid&&!['completed','stopped','cancelled'].includes(result.outcome)&&Number.isFinite(due)&&time>due;
    result.overdue_minutes=result.overdue?Math.floor((time-due)/60000):0;
    if(!result.completed_at&&result.review_remaining_quantity!=null)result.remaining_quantity=result.review_remaining_quantity;
    result.work_priority=['low','medium','high'][db.prepare(`SELECT ${taskPrioritySql()} n FROM tasks t WHERE t.id=?`).get(result.id).n];
    return result;
  }
  // Advisory planning read: no reconciliation, reservations, receipts or hardware delivery.
  function productStock(actor,query={}) {
    const current=actorNow(actor,'work.view');
    if(!['work.pick','work.put','work.assign'].some(p=>can(current,p)))throw new Error('Product planning is not available for your role.');
    const product=db.prepare('SELECT id,unit_of_measure,items_per_cell FROM products WHERE id=? AND active=1').get(Number(query.productId));
    if(!product)throw new Error('Choose an active product.');
    const cells=db.prepare('SELECT id,active FROM cells').all();
    let recorded=0,pickReserved=0,incomingReserved=0,availableToPick=0,putCapacity=0,unavailableUnreserved=0,spaceForMore=0;
    for(const cell of cells){
      const stock=balance(product.id,cell.id),pick=held(cell.id,product.id,'pick'),incoming=held(cell.id,product.id,'put');
      recorded+=stock;pickReserved+=pick;incomingReserved+=incoming;
      // Physical room is separate from reservations and temporary work locks.
      // Include empty cells and spare room where this product already lives.
      // In mixed cells, putRoom accounts for every product's share of space.
      if(cell.active&&(stock>0||occupancy(cell.id)===0))spaceForMore+=putRoom(db,cell.id,product,{reservations:false});
      const free=Math.max(0,rounded(stock-protectedPicks(db,cell.id,product.id)));
      const blocked=!cell.active||controlledCell(db,cell.id)
        ||db.prepare('SELECT 1 FROM work_discrepancies WHERE cell_id=? AND product_id=?').get(cell.id,product.id)
;
      if(blocked){unavailableUnreserved+=free;continue;}
      availableToPick+=free;
      if(compatible(cell.id,product.id))putCapacity+=putRoom(db,cell.id,product);
    }
    const team=can(current,'work.team');
    const total=db.prepare("SELECT COUNT(*) n FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE r.state='held' AND l.product_id=?").get(product.id).n;
    const visible=db.prepare(`SELECT r.kind,r.quantity,l.unit_of_measure AS unit,l.task_id AS taskId,c.logical_code AS location,t.assignment_state AS assignmentState,t.attention,
      u.name AS assignee FROM work_reservations r JOIN task_lines l ON l.id=r.line_id JOIN tasks t ON t.id=l.task_id
      JOIN cells c ON c.id=l.cell_id LEFT JOIN users u ON u.id=t.assignee_id
      WHERE r.state='held' AND l.product_id=? AND (? OR t.assignee_id=?) ORDER BY t.id DESC,l.id LIMIT 101`).all(product.id,Number(team),current.id);
    return {...identity(),actorId:current.id,productId:product.id,unit:product.unit_of_measure,generatedAt:now(),
      recorded:rounded(recorded),pickReserved:rounded(pickReserved),incomingReserved:rounded(incomingReserved),availableToPick:rounded(availableToPick),putCapacity:rounded(putCapacity),unavailableUnreserved:rounded(unavailableUnreserved),
      spaceForMore:rounded(spaceForMore),totalCapacity:rounded(recorded+spaceForMore),itemsPerCell:product.items_per_cell,
      reservationCount:total,reservations:visible.slice(0,100),moreReservations:visible.length>100,detailScope:team?'team':'own'};
  }
  function snapshot(actor,query={}) {
    const current=actorNow(actor);
    if(query.view==='assign')assertCan(current,'work.assign');
    if(!can(current,'work.view'))return {...identity(),user:current,workTabs:workTabs(current),capabilities:workCapabilities(current),timing:{},operators:[],performers:[],reports:db.prepare('SELECT id,status FROM work_reports WHERE reporter_id=?').all(current.id),tasks:[],products:[],cells:can(current,'locations.labels')?db.prepare('SELECT id,logical_code,label_id,label_revision,guidance_mode FROM cells WHERE active=1').all().map(c=>({...c,description:describeLocation(db,c.id)})):[],pending:[],postedReports:[],contents:[],discrepancies:[],generatedAt:now()};
    const selection=taskSelection(db,current,query),taskList=query.view==='activity'?[]:query.taskId?[task(current,Number(query.taskId))].filter(Boolean):selection.ids.map(id=>({...task(current,id),...selection.metrics?.get(id)}));
    const watchedTasks=[...new Set(String(query.watch||'').split(',').map(Number).filter(id=>id>0&&!selection.ids.includes(id)))].slice(0,100).flatMap(id=>{try{const value=task(current,id);return value?[value]:[];}catch{return [];}});
    const returned=returnedSelection(db,current,query);
    const products=db.prepare('SELECT id,sku,name,unit_of_measure,items_per_cell FROM products WHERE active=1 ORDER BY name').all();
    const cells=db.prepare('SELECT id,logical_code,label_id,label_revision,guidance_mode FROM cells WHERE active=1 ORDER BY row_number,column_number').all().map(c=>({...c,description:describeLocation(db,c.id)}));
    const reviews=reviewSelection(db,current,query),pending=reviews.rows,loads=workloads(db);
    const planner=['work.pick','work.put','work.report'].some(cap=>can(current,cap)),productIds=new Set([...taskList.flatMap(t=>t.lines.map(l=>l.product_id)),...pending.map(r=>r.product_id)]),cellIds=new Set([...taskList.flatMap(t=>t.lines.map(l=>l.cell_id)),...pending.map(r=>r.cell_id)]);
    const visibleProducts=can(current,'products.view')||planner?products:products.filter(p=>productIds.has(p.id)),visibleCells=can(current,'locations.view')||can(current,'work.stop')||can(current,'work.teamStop')||planner?cells:cells.filter(c=>cellIds.has(c.id));
    const operators=(can(current,'work.assign')||can(current,'work.team')||can(current,'review.view'))?db.prepare('SELECT id,name,username,status,role FROM users ORDER BY name').all().map(u=>{
      const effective=effectiveUser(db,u),load=loads.find(v=>v.id===u.id);
      return {...u,role_name:effective.role_name,eligible:workCapabilities(effective).execute,...(can(current,'work.assign')?{assignedTaskCount:load?.open||0}:{}),...((can(current,'work.team')||can(current,'review.view'))?load:{})};
    }):[];
    return {...identity(),user:current,workTabs:workTabs(current),capabilities:workCapabilities(current),timing:timingSettings(),operators,performers:operators,...(query.view==='activity'?{activity:history.activityHistory(current,query)}:{}),
      reports:db.prepare("SELECT id,status FROM work_reports WHERE (?='admin' OR reporter_id=? OR performer_id=?)").all(can(current,"review.view")?"admin":"own",current.id,current.id),
      tasks:taskList,watchedTasks,returnedTasks:returned.ids.map(id=>task(current,id)),returnedPage:returned.page,myWorkPriority:selection.priority,myWorkNextTask:selection.priority?task(current,selection.priority.id):null,taskPage:selection.page,taskCounts:selection.counts,inactivityAlerts:inactivityAlerts(current),reviewPage:reviews.page,reviewTotal:reviews.total,reviewGroups:reviews.groups,products:visibleProducts,cells:visibleCells,pending:pending.map(r=>({...r,...(JSON.parse(r.payload).taskClosure?{closureTask:task(current,r.task_id),closureActuals:JSON.parse(r.payload).actuals,closureCounts:db.prepare('SELECT o.id,o.lines_json,i.cell_id,c.logical_code,r.title FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id JOIN stocktake_runs r ON r.id=i.run_id JOIN cells c ON c.id=i.cell_id JOIN stocktake_settlements s ON s.observation_id=o.id ORDER BY s.created_at DESC LIMIT 100').all()}:{}),reviewFollowup:r.task_id?Boolean(db.prepare('SELECT review_followup FROM tasks WHERE id=?').get(r.task_id)?.review_followup):false,observations:r.task_id?task(current,r.task_id).review_observations:[],countOverlap:Boolean(countBoundary(db,r,r.line_id?line(r.line_id):null)),countEvidence:countBoundary(db,r,r.line_id?line(r.line_id):null)?countCandidates(current,{reportId:r.id})[0]||null:null,accounting:!r.line_id&&r.direction!=='count'?manualAccounting(r):null})),generatedAt:now(),
      postedReports:can(current,'review.view')?db.prepare(`SELECT r.*,p.name AS product_name,c.logical_code,u.name AS performer_name FROM work_reports r
        JOIN products p ON p.id=r.product_id JOIN cells c ON c.id=r.cell_id LEFT JOIN users u ON u.id=r.performer_id WHERE r.status='posted' ORDER BY r.created_at DESC LIMIT 500`).all():[],
      contents:db.prepare(`SELECT b.cell_id,b.product_id,b.available_quantity,p.name,p.unit_of_measure FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.available_quantity!=0`).all().filter(c=>visibleCells.some(v=>v.id===c.cell_id)&&visibleProducts.some(v=>v.id===c.product_id)),
      discrepancies:can(current,'review.view')?db.prepare('SELECT d.*,c.logical_code,p.name AS product_name FROM work_discrepancies d JOIN cells c ON c.id=d.cell_id JOIN products p ON p.id=d.product_id').all():[]};
  }
  function inactivityAlerts(actor){
    return db.prepare(`SELECT t.id AS taskId,u.name AS name,a.detected_at AS detectedAt FROM work_inactivity_alerts a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=t.assignee_id
      WHERE a.last_touched_at=t.last_touched_at AND t.assignment_state='started' AND t.stop_requested=0 AND t.completed_at IS NULL AND t.review_followup=0
      AND (? OR t.assignee_id=?) AND EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=t.id AND l.execution_state='working' AND NOT EXISTS(SELECT 1 FROM work_reports r WHERE r.line_id=l.id AND r.status IN ('received','review')))
      ORDER BY a.detected_at,t.id`).all(Number(can(actor,'work.team')),actor.id);
  }
  function flagInactivity({ at = new Date(), timeoutMs = 5 * 60000, restoreGuidance=false } = {}) {
    const staleIds = withTransaction(db, () => {
      // An idle connection is an alert, never a declaration that physical work stopped.
      const active=db.prepare("SELECT id,last_touched_at FROM tasks WHERE workflow_version=2 AND assignment_state='started' AND stop_requested=0 AND completed_at IS NULL AND last_touched_at<=? AND EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=tasks.id AND l.execution_state='working')").all(new Date(at.getTime()-timeoutMs).toISOString());
      for(const t of active)db.prepare('INSERT INTO work_inactivity_alerts(task_id,last_touched_at,detected_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET last_touched_at=excluded.last_touched_at,detected_at=excluded.detected_at WHERE work_inactivity_alerts.last_touched_at!=excluded.last_touched_at').run(t.id,t.last_touched_at,at.toISOString());
      const stale = db.prepare("SELECT id FROM tasks WHERE workflow_version=2 AND status='pending_review' AND attention=0 AND last_touched_at<=? AND assignment_source='legacy' AND NOT EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=tasks.id AND l.execution_state='working') AND EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=tasks.id AND l.execution_state='ready')").all(new Date(at.getTime() - timeoutMs).toISOString());
      for (const task of stale) {
        db.prepare("UPDATE tasks SET attention=1,outcome='needs_review',completed_at=NULL WHERE id=?").run(task.id);
        for (const item of db.prepare("SELECT l.id FROM task_lines l JOIN tasks t ON t.id=l.task_id WHERE l.task_id=? AND (l.execution_state='working' OR t.assignment_source='legacy' AND l.execution_state='ready')").all(task.id)) {
          const allocation = line(item.id);
          const owner = db.prepare("SELECT * FROM users WHERE id=?").get(allocation.assignee_id || allocation.created_by);
          const report = insertReport(owner, { quantity: 0, unknown: true, origin: `attention:${allocation.id}`, reason: "Actual quantity is unknown; zero is not a verified answer." }, allocation);
          review(report, "Inactivity needs verification. Expected quantity is shown for context; enter an actual quantity or keep pending.");
          if(!db.prepare('SELECT 1 FROM work_guidance WHERE cell_id=?').get(allocation.cell_id))setGuidance(allocation.cell_id,{action:'clear',binding:guidanceBinding(db,allocation.cell_id)});

        }
      }
      return stale.map(t => t.id);
    });
    // The maintenance timer also retries pending deliveries when no new task is stale.
    try { flushGuidance({restore:restoreGuidance}); } catch (error) { logger?.warn?.('work.guidance.deferred', { error:error.message }); }
    return staleIds;
  }
  function countCandidates(actor,input) {
    actorNow(actor,'review.view');
    const report=db.prepare('SELECT * FROM work_reports WHERE id=?').get(input.reportId);if(!report)throw new Error('Review entry not found.');
    const q=String(input.q||'').toLowerCase().slice(0,160);
    return db.prepare(`SELECT o.id,o.lines_json,o.received_at,o.counted_at,u.name counter_name,v.name reviewer_name,r.title,c.logical_code FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id JOIN stocktake_runs r ON r.id=i.run_id JOIN cells c ON c.id=i.cell_id JOIN stocktake_settlements s ON s.observation_id=o.id JOIN users u ON u.id=o.counter_id LEFT JOIN users v ON v.id=o.reviewer_id WHERE i.cell_id=? AND EXISTS(SELECT 1 FROM json_each(o.lines_json) j WHERE json_extract(j.value,'$.productId')=?) AND instr(lower(r.title||' '||c.logical_code||' '||u.name||' '||o.received_at),?)>0 ORDER BY o.received_at DESC LIMIT 100`).all(report.cell_id,report.product_id,q).map(o=>({...o,lines:JSON.parse(o.lines_json).filter(l=>l.productId===report.product_id)}));
  }
  function searchMovements(actor, input) {
    actorNow(actor,"review.view");
    const report=db.prepare('SELECT * FROM work_reports WHERE id=?').get(String(input.reportId||''));
    if(!report)throw new Error('Review entry not found.');
    const query=String(input.q||'').trim().slice(0,180);
    // Search the entire posted history, bounded per response; never guess a match.
    return db.prepare(`SELECT r.*,u.name AS performer_name FROM work_reports r LEFT JOIN users u ON u.id=r.performer_id
      WHERE r.status='posted' AND r.product_id=? AND r.cell_id=? AND r.direction=?
      AND (?='' OR instr(lower(r.origin_ref||' '||r.id||' '||r.created_at||' '||COALESCE(u.name,'')||' '||r.quantity),lower(?))>0)
      ORDER BY r.created_at DESC,r.id LIMIT 100`).all(report.product_id,report.cell_id,report.direction,query,query);
  }
  const planningRecovery=createPlanningRecovery({db,workQuantity,event});
  function planningOptions(actor,input){return {...identity(),actorId:actor.id,...planningRecovery.options(actorNow(actor,'work.view'),input)};}
  const history=createWorkHistory({db,actorNow,task,identity});
  return { ...history, command, task, snapshot, identity, actorNow, line, held, requestCountGuidance, reconcileGuidance, flushGuidance, flagInactivity, searchMovements, countCandidates, productStock, planningOptions };
}
