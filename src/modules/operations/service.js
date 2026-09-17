import { historicalFactor } from "./corrections.js";
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

  function actorNow(actor, admin = false) {
    const current = db.prepare("SELECT id,name,username,role,status,session_version FROM users WHERE id=?").get(Number(actor?.id));
    if (!current || current.status !== "active" || (actor.session_version != null && current.session_version !== actor.session_version)) {
      throw new Error("Your session is no longer active. Sign in again; pending reports remain available for review.");
    }
    if (admin && current.role !== "admin") throw new Error("Admin access is required.");
    return current;
  }
  function line(id) {
    const value = db.prepare(`SELECT l.*, t.created_by, t.type, t.workflow_version, t.status AS task_status,
      t.plan_revision, t.attention, t.completed_at, p.name AS product_name, p.sku, p.items_per_cell,
      p.unit_of_measure AS current_unit, c.logical_code, c.guidance_mode, c.active AS cell_active,
      c.controller_id, c.hardware_channel, c.label_id, c.label_revision, ctrl.address AS controller_address
      FROM task_lines l JOIN tasks t ON t.id=l.task_id JOIN products p ON p.id=l.product_id
      JOIN cells c ON c.id=l.cell_id LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE l.id=?`).get(Number(id));
    if (!value) throw new Error("Allocation not found.");
    return value;
  }
  function own(actor, allocation) {
    if (actor.role !== "admin" && actor.id !== allocation.created_by) throw new Error("You can act only on your own allocations.");
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
  function compatible(cellId, productId, excluding = 0) {
    return !db.prepare("SELECT 1 FROM inventory_balances WHERE cell_id=? AND product_id!=? AND available_quantity>0").get(cellId, productId)
      && !db.prepare(`SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id
        WHERE r.state='held' AND r.kind='put' AND l.cell_id=? AND l.product_id!=? AND l.id!=?`).get(cellId, productId, excluding);
  }
  function syncReservations() {
    db.exec(`UPDATE inventory_balances SET reserved_quantity=COALESCE((SELECT SUM(r.quantity)
      FROM work_reservations r JOIN task_lines l ON l.id=r.line_id
      WHERE r.state='held' AND r.kind='pick' AND l.product_id=inventory_balances.product_id
      AND l.cell_id=inventory_balances.cell_id),0)`);
  }
  function taskProgress(taskId) {
    const open = db.prepare("SELECT COUNT(*) n FROM task_lines WHERE task_id=? AND execution_state NOT IN ('settled','cancelled','superseded')").get(taskId).n;
    const review = db.prepare(`SELECT COUNT(*) n FROM work_reports r JOIN task_lines l ON l.id=r.line_id
      WHERE l.task_id=? AND r.status='review'`).get(taskId).n;
    db.prepare("UPDATE tasks SET status=?,attention=?,completed_at=?,last_touched_at=? WHERE id=?")
      .run(open ? "pending_review" : "completed", review ? 1 : 0, open ? null : (db.prepare("SELECT completed_at FROM tasks WHERE id=?").get(taskId)?.completed_at || now()), now(), taskId);
  }
  function setGuidance(cellId, desired) {
    db.prepare(`INSERT INTO work_guidance(cell_id,generation,desired,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(cell_id) DO UPDATE SET generation=excluded.generation,desired=excluded.desired,delivered=0,updated_at=excluded.updated_at`)
      .run(cellId, randomUUID(), JSON.stringify(desired), now());
  }
  function releaseTurn(allocation) {
    const deleted = db.prepare("DELETE FROM cell_turns WHERE line_id=?").run(allocation.id).changes;
    const otherShared = db.prepare(`SELECT 1 FROM task_lines WHERE cell_id=? AND id!=? AND execution_state='working'`).get(allocation.cell_id, allocation.id);
    if (deleted || (allocation.guidance_mode === "shared" && !otherShared)) setGuidance(allocation.cell_id, { action: "clear" });
  }
  function markDiscrepancy(cellId, productId, reason) {
    db.prepare(`INSERT INTO work_discrepancies(cell_id,product_id,reason,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(cell_id,product_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at`)
      .run(cellId, productId, reason, now());
  }
  function movement({ actor, performer, productId, cellId, quantity, type, taskId = null, lineId = null, origin, reason, unit }) {
    db.prepare("INSERT OR IGNORE INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,0,0)").run(productId, cellId);
    db.prepare("UPDATE inventory_balances SET available_quantity=ROUND(available_quantity+?,6) WHERE product_id=? AND cell_id=?").run(quantity, productId, cellId);
    if (quantity !== 0) db.prepare(`INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,task_id,task_line_id,
      origin_ref,performed_by,reason,unit_of_measure,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(type, productId, cellId, quantity, actor.id, taskId, lineId, origin, performer || null, reason, unit, now());
  }
  function performerFor(actor, input, fallback = null) {
    if (actor.role !== 'admin') {
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
  function insertReport(actor, input, allocation = null) {
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
        performerFor(actor, input, allocation?.created_by),
        actor.id, input.reason || null, JSON.stringify(input), input.occurredAt || null, now());
    if(input.unknown) db.prepare("UPDATE work_reports SET quantity_known=0 WHERE id=?").run(reportId);
    return db.prepare("SELECT * FROM work_reports WHERE id=?").get(reportId);
  }
  function review(report, reason) {
    db.prepare("UPDATE work_reports SET status='review',reason=? WHERE id=?").run(reason, report.id);
    if (report.line_id && !JSON.parse(report.payload).unknown) {
      db.prepare("UPDATE work_reports SET status='superseded',verification='Operator report received; physical verification remains pending' WHERE line_id=? AND origin_ref LIKE 'attention:%' AND status='review'").run(report.line_id);
    }
    if (report.line_id) {
      const allocation = line(report.line_id);
      db.prepare("UPDATE tasks SET attention=1 WHERE id=?").run(allocation.task_id);
      db.prepare("UPDATE cell_turns SET uncertain=1 WHERE line_id=?").run(allocation.id);
    }
    return { status: "review", reportId: report.id, message: reason };
  }
  function settle(actor, report, allocation, supervisor = false, verification = "") {
    if(report.product_id!==allocation.product_id) return review(report,"The reported product differs from the allocation. Reconcile the retained report as a separate verified physical movement.");
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
      return review(report, "This allocation has already been settled differently. The later physical report is retained; an admin can correct the recorded allocation.");
    }
    if (!supervisor && ["cancelled", "superseded"].includes(allocation.execution_state)) return review(report, "The original allocation changed or was cancelled. Verify the reported physical movement before recording it.");
    const qty = report.quantity;
    if (report.product_id !== allocation.product_id || report.unit !== allocation.current_unit || (!supervisor && report.cell_id !== allocation.cell_id)) return review(report, "The location or accounting unit changed. Retained for supervisor reconciliation; nothing has been silently converted or relocated.");
    const originPosted=db.prepare("SELECT r.* FROM work_origins o JOIN work_reports r ON r.id=o.report_id WHERE o.origin_ref=?").get(report.origin_ref);
    if(originPosted && (originPosted.quantity!==qty || originPosted.product_id!==report.product_id || originPosted.cell_id!==report.cell_id || originPosted.unit!==report.unit || originPosted.direction!==allocation.type)) return review(report,"This source movement reference was already posted differently. Retain both reports and reconcile them.");
    const onHand = balance(report.product_id, report.cell_id);
    if (!originPosted && allocation.type === "pick") {
      if (qty > onHand + 1e-9 && !supervisor) return review(report, "Reported pick exceeds recorded stock. Keep the full report and reconcile the location; no quantity was capped.");
      if(qty>onHand+1e-9) markDiscrepancy(report.cell_id,report.product_id,"Verified pick exceeds prior book stock. Full actual retained as a negative balance; reconcile missing movements.");
      const other = held(report.cell_id, report.product_id, "pick", allocation.id);
      if (!supervisor && qty > rounded(onHand - other) + 1e-9) return review(report, "Actual pick conflicts with another reservation. An admin must verify it; other allocations can settle independently.");
      if (supervisor && onHand - qty < other - 1e-9) markDiscrepancy(report.cell_id, report.product_id, `Reservation shortage: ${rounded(other - (onHand - qty))} ${report.unit}. Existing claims remain intact.`);
    } else if(!originPosted) {
      if (!compatible(report.cell_id, report.product_id, allocation.id) && !supervisor) return review(report, "This put conflicts with another product in the location. Keep the actual report for reconciliation.");
      if(!compatible(report.cell_id,report.product_id,allocation.id)) markDiscrepancy(report.cell_id,report.product_id,"Verified physical put left mixed products; reconcile this location.");
      const excess = rounded(occupancy(report.cell_id) + held(report.cell_id, null, "put", allocation.id) + qty - allocation.items_per_cell);
      if (excess > 1e-9 && !supervisor) return review(report, "Actual put exceeds unreserved capacity. An admin must verify the report.");
      if (excess > 1e-9) markDiscrepancy(report.cell_id, report.product_id, `Capacity exceeded by ${excess} ${report.unit}; physical report verified by admin.`);
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
    syncReservations();
    taskProgress(allocation.task_id);
    event("allocation_settled", actor, allocation.id, { planned: allocation.planned_quantity, actual: qty, supervisor, verification }, report.id);
    return { status: "recorded", reportId: report.id, taskId: allocation.task_id, quantity: qty, message: `${qty} ${report.unit} recorded at ${allocation.logical_code}.` };
  }
  function create(actor, input) {
    if(metadata("firmware_busy")) throw new Error("Controller maintenance is in progress. Report physical work manually; reserve new work after maintenance finishes.");
    const product = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(Number(input.productId));
    if (!product) throw new Error("Choose an active product.");
    if (!["pick", "put"].includes(input.direction)) throw new Error("Choose Pick or Put.");
    let remaining = workQuantity(input.quantity, true);
    const preferred = (input.preferredCellIds || [input.preferredCellId]).map(Number);
    const cells = db.prepare("SELECT * FROM cells WHERE active=1 ORDER BY row_number,column_number,logical_code").all()
      .sort((a, b) => Number(preferred.includes(b.id)) - Number(preferred.includes(a.id)) ||
        (input.direction === "put" ? Number(balance(product.id, b.id) > 0) - Number(balance(product.id, a.id) > 0) : 0));
    const allocations = [];
    for (const cell of cells) {
      if (remaining <= 0) break;
      if (db.prepare("SELECT 1 FROM work_discrepancies WHERE cell_id=? AND product_id=?").get(cell.id, product.id)) continue;
      const room = input.direction === "pick"
        ? rounded(balance(product.id, cell.id) - held(cell.id, product.id, "pick"))
        : compatible(cell.id, product.id) ? rounded(product.items_per_cell - occupancy(cell.id) - held(cell.id, null, "put")) : 0;
      if (room <= 0) continue;
      const quantity = Math.min(room, remaining);
      allocations.push({ product_id: product.id, cell_id: cell.id, planned_quantity: quantity, guidance_color: input.direction === "pick" ? "green" : "red" });
      remaining = rounded(remaining - quantity);
    }
    if (remaining > 0) throw new Error(`Not enough dependable ${input.direction === "pick" ? "unreserved stock" : "put capacity"} for this plan. Adjust the request, or use Record completed movement for work performed manually.`);
    const task = tasks.createPendingReviewTask({ type: input.direction, summary: `${input.direction === "pick" ? "Pick" : "Put"} ${input.quantity} ${product.unit_of_measure} of ${product.sku}`, createdBy: actor.id, lines: allocations });
    db.prepare("UPDATE tasks SET workflow_version=2 WHERE id=?").run(task.id);
    for (const allocation of task.lines) {
      db.prepare("UPDATE task_lines SET execution_state='ready',unit_of_measure=(SELECT unit_of_measure FROM products WHERE id=task_lines.product_id) WHERE id=?").run(allocation.id);
      db.prepare("INSERT INTO work_reservations(line_id,kind,quantity) VALUES(?,?,?)").run(allocation.id, input.direction, allocation.planned_quantity);
    }
    syncReservations();
    event("task_reserved", actor, null, { taskId: task.id, lines: task.lines.map(l => l.id) });
    return { status: "reserved", taskId: task.id, message: "Quantities reserved. Scan a location when you arrive; future displays remain free." };
  }
  function acquire(actor, input) {
    if(metadata("firmware_busy")) throw new Error("Controller maintenance is in progress. No new guidance is available.");
    const allocation = line(input.lineId); own(actor, allocation);
    if (!input.deviceId) throw new Error("A device identity is required.");
    if (allocation.revision !== Number(input.revision) || !["ready", "working"].includes(allocation.execution_state)) throw new Error("This allocation changed. Refresh it before requesting guidance; already performed work can still be reported.");
    if (db.prepare("SELECT 1 FROM work_reports WHERE line_id=? AND status='review'").get(allocation.id)) throw new Error("This task needs supervisor review. You can still report actual work.");
    const expected = `lytguide:${identity().site}:${allocation.label_id}:${allocation.label_revision}`;
    if (input.location !== expected && String(input.location).trim().toUpperCase() !== allocation.logical_code.toUpperCase()) throw new Error("That location does not match this allocation.");
    if (allocation.execution_state === "working" && allocation.device_id !== input.deviceId) throw new Error("Another device already started this allocation. Report existing work or ask an admin to resolve it; do not repeat the movement.");
    if (allocation.guidance_mode === "exclusive") {
      const turn = db.prepare("SELECT * FROM cell_turns WHERE cell_id=?").get(allocation.cell_id);
      if (turn && (turn.line_id !== allocation.id || turn.device_id !== input.deviceId || turn.uncertain)) return { status: "busy", message: "This location is in use or awaiting verification. Choose another ready location, or continue through the manual reporting procedure." };
      db.prepare("INSERT OR IGNORE INTO cell_turns(cell_id,line_id,actor_id,device_id,generation,acquired_at) VALUES(?,?,?,?,?,?)")
        .run(allocation.cell_id, allocation.id, actor.id, input.deviceId, randomUUID(), now());
    }
    if (allocation.execution_state === "ready") db.prepare("UPDATE task_lines SET execution_state='working',device_id=?,started_at=?,revision=revision+1 WHERE id=?").run(input.deviceId, now(), allocation.id);
    db.prepare("UPDATE tasks SET last_touched_at=? WHERE id=?").run(now(), allocation.task_id);
    setGuidance(allocation.cell_id, { action: allocation.guidance_mode === "shared" ? "locate" : "quantity", lineId: allocation.id });
    event("location_ready", actor, allocation.id, { method: input.method || "typed", device: input.deviceId, mode: allocation.guidance_mode });
    return { status: "ready", revision: line(allocation.id).revision, message: allocation.guidance_mode === "shared" ? "Shared location. Follow your phone's action and quantity; the light is only a locator." : "Your turn at this location. Confirm the actual quantity when finished." };
  }
  function reportActual(actor, input) {
    const allocation = line(input.lineId); own(actor, allocation);
    const report = insertReport(actor, {...input,unknown:false}, allocation);
    if (input.dataset && input.dataset !== identity().dataset) return review(report, "Report comes from an earlier restored dataset. Review the physical evidence before posting.");
    const settled = db.prepare("SELECT 1 FROM work_settlements WHERE line_id=?").get(allocation.id);
    if (settled) return settle(actor, report, allocation);
    if (report.product_id !== allocation.product_id || Number(input.revision) !== allocation.revision || input.unit !== allocation.unit_of_measure || Number(input.cellId) !== allocation.cell_id) return review(report, "The original allocation, location, or unit changed. Your actual movement report was retained; the replacement plan was not posted.");
    if (db.prepare("SELECT 1 FROM work_reports WHERE line_id=? AND status='review' AND id!=?").get(allocation.id, report.id) || allocation.execution_state !== "working" || allocation.device_id !== input.deviceId || input.manual === true) return review(report, "Actual work received for supervisor verification. No new guidance or movement has been assumed.");
    return settle(actor, report, allocation);
  }
  function resolve(actor, input) {
    actorNow(actor, true);
    const report = db.prepare("SELECT * FROM work_reports WHERE id=?").get(input.reportId);
    if (!report) throw new Error("Report not found.");
    if (input.keepOpen) { event("verification_deferred", actor, report.line_id, { reason: input.verification || "Unable to verify" }, report.id); return { status: "review", message: "Kept pending. No quantity was assumed." }; }
    const verification = String(input.verification || "").trim();
    if (!verification) throw new Error("Choose how you verified the actual quantity.");
    if (!['review','received'].includes(report.status)) return { status: "recorded", message: "This report is already resolved.", reportId: report.id };
    if (input.dismissDuplicate) {
      const linked = db.prepare("SELECT * FROM work_reports WHERE id=? AND status='posted'").get(input.duplicateOf);
      if (!linked || linked.id === report.id || linked.product_id!==report.product_id || linked.cell_id!==report.cell_id || linked.direction!==report.direction) throw new Error("Choose the recorded report that already accounts for this movement.");
      const allocation = report.line_id ? line(report.line_id) : null;
      if (allocation && ['ready','working'].includes(allocation.execution_state)) {
        if (input.closeAllocation !== true) throw new Error('Confirm that the linked movement fully accounts for this allocation before closing it. Its reservation and turn remain held.');
        if (linked.product_id !== allocation.product_id || linked.cell_id !== allocation.cell_id || linked.unit !== allocation.unit_of_measure || (report.quantity_known !== 0 && (report.unit !== linked.unit || report.quantity !== linked.quantity))) {
          throw new Error('The linked movement does not match this allocation report. Verify the actual quantity and location before resolving it.');
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
      direction: report.direction, unit: report.unit, quantity, occurredAt:report.occurred_at || report.created_at, unknown:false, origin: report.origin_ref, reason: verification,
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
        taskProgress(line(report.line_id).task_id);
      }
    }
    return result;
  }
  function postManual(actor, report, verification, input) {
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
    if (report.direction==='put' && occupancy(report.cell_id)+held(report.cell_id,null,'put')>product.items_per_cell) markDiscrepancy(report.cell_id,report.product_id,'Verified manual put exceeds planned capacity. Review the location.');
    event('manual_quantity_verified',actor,null,{originalQuantity:report.quantity,originalUnit:report.unit,accountingQuantity:quantity,accountingUnit:mapping.unit,evidence,performerId:report.performer_id},report.id);
    db.prepare("INSERT INTO work_origins(origin_ref,report_id) VALUES(?,?)").run(report.origin_ref, report.id);
    db.prepare("UPDATE work_reports SET status='posted',resolved_at=?,resolver_id=?,verification=? WHERE id=?").run(now(), actor.id, verification, report.id);
    event("manual_movement_recorded", actor, null, { quantity: report.quantity, direction: report.direction, verification }, report.id);
    return { status: "recorded", reportId: report.id, message: "Completed physical movement recorded. No lights or new task were activated." };
  }
  function cancel(actor, input) {
    const allocation = line(input.lineId); own(actor, allocation);
    if (allocation.execution_state !== "ready" || Number(input.revision) !== allocation.revision) throw new Error("Only an unchanged, unstarted allocation can be cancelled. Report actual work or ask an admin to resolve uncertainty.");
    db.prepare("UPDATE task_lines SET execution_state='cancelled',revision=revision+1 WHERE id=?").run(allocation.id);
    db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(allocation.id);
    syncReservations(); taskProgress(allocation.task_id);
    event("unstarted_cancelled", actor, allocation.id, { declaration: "Operator declared no physical work" });
    return { status: "recorded", message: "Unstarted allocation cancelled; its reservation was released." };
  }
  function correct(actor, input, verified = false) {
    const allocation = line(input.lineId); own(actor, allocation);
    if (allocation.execution_state !== "settled" || Number(input.revision) !== allocation.revision) throw new Error("This recorded allocation changed. Refresh before correcting it.");
    if (db.prepare("SELECT 1 FROM work_events WHERE line_id=? AND event_type='allocation_accounted_elsewhere'").get(allocation.id)) throw new Error('This allocation is covered by an existing movement. Correct the original movement record so stock is adjusted only once.');
    const verification = String(input.verification || "").trim();
    if (!verification) throw new Error("Give a reason for correcting this earlier record. Use Record completed movement for a new physical return or pick.");
    const factor=historicalFactor(db,allocation.product_id,allocation.unit_of_measure,allocation.completed_at||allocation.started_at);
    const quantity = workQuantity(input.quantity);
    const delta = rounded((quantity - allocation.actual_quantity) * factor * (allocation.type === "pick" ? -1 : 1));
    const next = rounded(balance(allocation.product_id, allocation.cell_id) + delta);
    const shortage=next<0 || next<held(allocation.cell_id,allocation.product_id,'pick');
    const overflow=delta>0 && occupancy(allocation.cell_id)+held(allocation.cell_id,null,'put')+delta>allocation.items_per_cell;
    if((shortage||overflow)&&!verified) return review(insertReport(actor,{...input,unit:allocation.unit_of_measure,cellId:allocation.cell_id,quantity,reason:verification,correction:true},allocation),'Proposed correction conflicts with stock or reservations. The full proposal is retained for supervisor verification.');
    if(shortage||overflow) markDiscrepancy(allocation.cell_id,allocation.product_id,'Supervisor verified a correction that leaves a stock/capacity discrepancy. Existing reservations remain intact.');
    movement({ actor, performer: verified ? performerFor(actor,input) : (db.prepare("SELECT performer_id FROM work_reports WHERE id=(SELECT report_id FROM work_settlements WHERE line_id=?)").get(allocation.id)?.performer_id ?? null), productId: allocation.product_id, cellId: allocation.cell_id,
      quantity: delta, type: "adjustment", taskId: allocation.task_id, lineId: allocation.id,
      origin: `correction:${input.requestId}`, reason: verification, unit: allocation.current_unit });
    db.prepare("UPDATE task_lines SET actual_quantity=?,exception_quantity=?,revision=revision+1 WHERE id=?").run(quantity, Math.max(0, allocation.planned_quantity - quantity), allocation.id);
    db.prepare("UPDATE work_settlements SET quantity=? WHERE line_id=?").run(quantity, allocation.id);
    event("record_corrected", actor, allocation.id, { previous: allocation.actual_quantity, actual: quantity, verification });
    return { status: "recorded", message: "Correction recorded with its previous value preserved in history." };
  }
  function replan(actor,input) {
    const old=line(input.lineId);own(actor,old);
    if(old.type!=='put'||old.execution_state!=='ready'||old.revision!==Number(input.revision))throw new Error("Only an unchanged, unstarted put allocation can be replanned.");
    if(db.prepare("SELECT 1 FROM work_reports WHERE line_id=? AND status IN ('review','received')").get(old.id))throw new Error("Resolve this allocation's physical reports before replanning it.");
    const cell=db.prepare("SELECT * FROM cells WHERE id=? AND active=1").get(Number(input.cellId));
    const quantity=workQuantity(input.quantity,true);
    if(!cell||!compatible(cell.id,old.product_id,old.id)||occupancy(cell.id)+held(cell.id,null,'put',old.id)+quantity>old.items_per_cell)throw new Error("Replacement allocation exceeds available compatible capacity.");
    db.prepare("UPDATE task_lines SET execution_state='superseded',revision=revision+1 WHERE id=?").run(old.id);
    db.prepare("UPDATE work_reservations SET state='released' WHERE line_id=?").run(old.id);
    tasks.addLine(old.task_id,{product_id:old.product_id,cell_id:cell.id,planned_quantity:quantity,guidance_color:'red'});
    const fresh=db.prepare("SELECT id FROM task_lines WHERE task_id=? ORDER BY id DESC LIMIT 1").get(old.task_id);
    db.prepare("UPDATE task_lines SET execution_state='ready' WHERE id=?").run(fresh.id);
    db.prepare("INSERT INTO work_reservations(line_id,kind,quantity) VALUES(?,'put',?)").run(fresh.id,quantity);
    db.prepare("UPDATE tasks SET plan_revision=plan_revision+1,last_touched_at=? WHERE id=?").run(now(),old.task_id);
    const total=db.prepare("SELECT SUM(planned_quantity) n FROM task_lines WHERE task_id=? AND execution_state NOT IN ('superseded','cancelled')").get(old.task_id).n;
    tasks.updateSummary(old.task_id,`Put ${total} ${old.unit_of_measure} of ${old.sku}`);
    event('allocation_replanned',actor,old.id,{replacementLineId:fresh.id,oldCell:old.cell_id,cellId:cell.id,quantity});
    return {status:'recorded',message:'Unstarted allocation replanned. Earlier instructions remain in the audit history.'};
  }
  const actions = {
    replan,
    reconcile(actor,input) {
      actorNow(actor,true);
      const cell=Number(input.cellId),product=Number(input.productId),quantity=workQuantity(input.quantity);
      if(!input.verification)throw new Error('Record how you verified the reconciled location.');
      if(held(cell,null,'pick')||held(cell,null,'put')||db.prepare("SELECT 1 FROM work_reports WHERE cell_id=? AND status IN ('received','review')").get(cell))throw new Error('Resolve outstanding allocations and reports at this location first.');
      if(quantity!==balance(product,cell))throw new Error('Verified count differs from the ledger. Record the separately verified correction before clearing this discrepancy.');
      db.prepare('DELETE FROM work_discrepancies WHERE cell_id=? AND product_id=?').run(cell,product);
      event('location_reconciled',actor,null,input);
      return {status:'recorded',message:'Verified location reconciled and available for new plans.'};
    },
    create, acquire, report: reportActual, resolve, cancel, correct,
    manual(actor, input) { const report = insertReport(actor, {...input,unknown:false}); return review(report, input.direction === "count" ? "Count observation during ongoing work; no balance replacement was made." : "Completed movement received for supervisor verification. No new instructions were activated."); },
    mode(actor, input) {
      actorNow(actor, true);
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
    if (id.length < 8 || id.length > 160) throw new Error("A stable request identity is required. Reload the form; keep any physical report for review.");
    const fingerprint = createHash("sha256").update(canonical({ action, input })).digest("hex");
    const result = withTransaction(db, () => {
      const current = actorNow(actor);
      if (input.site && input.site !== identity().site) throw new Error("This report belongs to another warehouse.");
      const receipt = db.prepare("SELECT * FROM operation_receipts WHERE actor_id=? AND request_id=?").get(current.id, id);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new Error("This request was already submitted with different details. Retrieve its result before changing the report.");
        return { ...JSON.parse(receipt.result_json), replayed: true };
      }
      if (input.dataset && input.dataset !== identity().dataset && !["report", "manual"].includes(action)) throw new Error("The warehouse dataset changed. Refresh before requesting new work.");
      const value = actions[action](current, input);
      db.prepare("INSERT INTO operation_receipts(actor_id,request_id,fingerprint,result_json,created_at) VALUES(?,?,?,?,?)")
        .run(current.id, id, fingerprint, JSON.stringify(value), now());
      return value;
    });
    try { flushGuidance(); } catch (error) { logger?.warn?.("work.guidance.deferred", { error: error.message }); }
    return result;
  }
  function flushGuidance() {
    if (!hardwareService) return;
    for (const row of db.prepare("SELECT * FROM work_guidance WHERE delivered=0").all()) {
      const desired = JSON.parse(row.desired);
      const cell = db.prepare("SELECT c.*,ctrl.address AS controller_address FROM cells c LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?").get(row.cell_id);
      if (!cell) continue;
      let result;
      const context = { workGeneration: row.generation, workCellId: row.cell_id, source: "work_coordinator" };
      if (desired.action === "clear") {
        if (db.prepare("SELECT 1 FROM cell_turns WHERE cell_id=? AND uncertain=0").get(cell.id)) continue;
        result = hardwareService.clearGuidance({ id: null, type: "pick" }, [cell], context);
      } else {
        const allocation = line(desired.lineId);
        if (allocation.execution_state !== "working") continue;
        result = desired.action === "locate"
          ? hardwareService.showCellQuantity(cell, "LOC", "yellow", context)
          : hardwareService.activateGuidance({ id: allocation.task_id, type: allocation.type }, [allocation], context);
      }
      if (result?.ok && !result.degraded) db.prepare("UPDATE work_guidance SET delivered=1 WHERE cell_id=? AND generation=?").run(row.cell_id, row.generation);
    }
  }
  function task(actor, id) {
    const current = actorNow(actor);
    const result = tasks.get(Number(id));
    if (!result) return null;
    // Existing admin visibility is preserved; operators' work interface is scoped.
    result.canAct = current.role === "admin" || result.created_by === current.id;
    result.lines = result.lines.map(item => ({ ...line(item.id), canAct:result.canAct,
      reserved: db.prepare("SELECT quantity FROM work_reservations WHERE line_id=? AND state='held'").get(item.id)?.quantity || 0,
      reports: db.prepare("SELECT id,status,quantity,quantity_known,reason,created_at FROM work_reports WHERE line_id=? ORDER BY created_at DESC").all(item.id),
    }));
    return result;
  }
  function snapshot(actor) {
    const current = actorNow(actor);
    const mine = db.prepare(`SELECT t.*,u.name AS operator_name FROM tasks t JOIN users u ON u.id=t.created_by
      WHERE t.workflow_version=2 AND (?='admin' OR t.created_by=?) AND (t.status='pending_review' OR t.id IN (SELECT id FROM tasks WHERE workflow_version=2 AND status!='pending_review' AND (?='admin' OR created_by=?) ORDER BY id DESC LIMIT 100)) ORDER BY CASE WHEN t.status='pending_review' THEN 0 ELSE 1 END,t.id DESC`).all(current.role, current.id,current.role,current.id);
    const products = db.prepare("SELECT id,sku,name,unit_of_measure,items_per_cell FROM products WHERE active=1 ORDER BY name").all();
    const cells = db.prepare("SELECT id,logical_code,label_id,label_revision,guidance_mode FROM cells WHERE active=1 ORDER BY row_number,column_number").all();
    const pending = current.role === "admin" ? db.prepare(`SELECT r.*,p.name AS product_name,p.sku,c.logical_code,
      u.name AS operator_name,reporter.name AS reporter_name,l.planned_quantity,l.actual_quantity,l.execution_state,l.revision,l.task_id
      FROM work_reports r JOIN products p ON p.id=r.product_id JOIN cells c ON c.id=r.cell_id
      LEFT JOIN users u ON u.id=r.performer_id JOIN users reporter ON reporter.id=r.reporter_id
      LEFT JOIN task_lines l ON l.id=r.line_id WHERE r.status IN ('review','received') ORDER BY r.created_at`).all() : [];
    return { ...identity(), user: current, performers: current.role==='admin' ? db.prepare('SELECT id,name,username,status FROM users ORDER BY name').all() : [], reports:db.prepare("SELECT id,status FROM work_reports WHERE (?='admin' OR reporter_id=? OR performer_id=?)").all(current.role,current.id,current.id), tasks: mine.map(t => task(current, t.id)), products, cells, pending:pending.map(r=>({...r,accounting:!r.line_id && r.direction!=='count' ? manualAccounting(r) : null})), generatedAt: now(),
      discrepancies: db.prepare("SELECT d.*,c.logical_code,p.name AS product_name FROM work_discrepancies d JOIN cells c ON c.id=d.cell_id JOIN products p ON p.id=d.product_id").all() };
  }
  function flagInactivity({ at = new Date(), timeoutMs = 5 * 60000 } = {}) {
    const staleIds = withTransaction(db, () => {
      const stale = db.prepare("SELECT id FROM tasks WHERE workflow_version=2 AND status='pending_review' AND attention=0 AND last_touched_at<=?").all(new Date(at.getTime() - timeoutMs).toISOString());
      for (const task of stale) {
        db.prepare("UPDATE tasks SET attention=1 WHERE id=?").run(task.id);
        for (const item of db.prepare("SELECT id FROM task_lines WHERE task_id=? AND execution_state IN ('ready','working')").all(task.id)) {
          const allocation = line(item.id);
          const owner = db.prepare("SELECT * FROM users WHERE id=?").get(allocation.created_by);
          const report = insertReport(owner, { quantity: 0, unknown: true, origin: `attention:${allocation.id}`, reason: "Actual quantity is unknown; zero is not a verified answer." }, allocation);
          review(report, "Inactivity needs verification. Expected quantity is shown for context; enter an actual quantity or keep pending.");
          const guidance = db.prepare('SELECT desired FROM work_guidance WHERE cell_id=?').get(allocation.cell_id);
          const desired = guidance ? JSON.parse(guidance.desired) : null;
          // A waiting or older allocation must not replace another operator's guidance.
          if (!desired || desired.lineId === allocation.id) {
            const activeShared = allocation.guidance_mode === 'shared' && db.prepare(`SELECT l.id FROM task_lines l JOIN tasks t ON t.id=l.task_id
              WHERE l.cell_id=? AND l.id!=? AND l.execution_state='working' AND t.attention=0 ORDER BY l.started_at DESC LIMIT 1`).get(allocation.cell_id, allocation.id);
            setGuidance(allocation.cell_id, activeShared ? { action:'locate', lineId:activeShared.id } : { action:'clear' });
          }
        }
      }
      return stale.map(t => t.id);
    });
    // The maintenance timer also retries pending deliveries when no new task is stale.
    try { flushGuidance(); } catch (error) { logger?.warn?.('work.guidance.deferred', { error:error.message }); }
    return staleIds;
  }
  return { command, task, snapshot, identity, actorNow, line, held, flushGuidance, flagInactivity };
}
