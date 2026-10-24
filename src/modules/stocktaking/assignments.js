import {can} from '../access/catalog.js';

const membership = (actor, alias = 'i') => `(${alias}.assignee_id=${Number(actor.id)} OR EXISTS(SELECT 1 FROM stocktake_item_counters m WHERE m.item_id=${alias}.id AND m.user_id=${Number(actor.id)}))`;
const team = actor => actor.role === 'admin' && can(actor, 'count.team');
const assigned = `EXISTS(SELECT 1 FROM stocktake_items i WHERE i.run_id=r.id AND i.state!='excluded' AND (i.assignee_id IS NOT NULL OR EXISTS(SELECT 1 FROM stocktake_item_counters m WHERE m.item_id=i.id)))`;
const personal = actor => `EXISTS(SELECT 1 FROM stocktake_items i WHERE i.run_id=r.id AND i.state!='excluded' AND ${membership(actor)})`;
const remaining = actor => `EXISTS(SELECT 1 FROM stocktake_items i WHERE i.run_id=r.id AND i.state IN ('pending','counting','skipped','recheck') AND ${membership(actor)})`;
const total = `(SELECT COUNT(*) FROM stocktake_items i WHERE i.run_id=r.id AND i.state!='excluded')`;
const completed = `(SELECT COUNT(*) FROM stocktake_items i WHERE i.run_id=r.id AND i.state='counted')`;
const review = `r.status='review'`;
const lifecycle = `CASE WHEN ${review} THEN 'review' WHEN r.paused_at IS NOT NULL OR r.started_at IS NOT NULL THEN 'in_progress' ELSE 'not_started' END`;
const status = `CASE WHEN ${review} THEN 'Count needs review' WHEN r.paused_at IS NOT NULL THEN 'Paused' WHEN r.started_at IS NOT NULL THEN 'In progress' ELSE 'Not started' END`;
const scope = actor => `${assigned} AND ${team(actor) ? '1' : personal(actor)}`;

// Negative IDs namespace stocktakes in this combined read model only. Commands
// still use the positive run ID and the Stocktaking API, never Pick/Put commands.
export function stocktakeWorkRowsSql(actor) {
  if (!can(actor, 'count.view')) return '';
  return `SELECT -r.id,'stocktake',CASE WHEN ${personal(actor)} THEN ${Number(actor.id)} ELSE NULL END,
    r.created_at,NULL,r.due_date,'open','started','stocktake',${total},${completed},MAX(0,${total}-${completed}),
    CASE WHEN ${total}>0 THEN ROUND(${completed}*100.0/${total},1) ELSE 0 END,${lifecycle},${status},0,${review},
    NULL,r.title,'locations' FROM stocktake_runs r WHERE r.status NOT IN ('closed','completed','stopped') AND ${scope(actor)}`;
}

export function stocktakeWorkItem(db, actor, id) {
  if (!can(actor, 'count.view')) return null;
  const r = db.prepare(`SELECT r.*,${total} total,${completed} completed,${personal(actor)} mine,${remaining(actor)} can_count,
    ${lifecycle} work_state,${status} work_status,u.name assigned_by_name
    FROM stocktake_runs r LEFT JOIN users u ON u.id=r.created_by
    WHERE r.id=? AND r.status NOT IN ('closed','completed','stopped') AND ${scope(actor)}`).get(id);
  if (!r) return null;
  return {
    id: -r.id, stocktake_id: r.id, work_kind: 'stocktake', type: 'stocktake', summary: r.title,
    lines: [], requested_quantity: r.total, recorded_quantity: r.completed, remaining_quantity: r.total-r.completed,
    work_progress: r.total ? Math.round(r.completed*1000/r.total)/10 : 0,
    work_state: r.work_state, work_status: r.work_status, work_priority: 'low',
    assignee_id: r.mine ? actor.id : null, assigned_by_name: r.assigned_by_name,
    assigned_at: r.created_at, started_at: r.started_at, created_at: r.created_at, due_at: r.due_date,
    assignment_generation: r.revision, paused_at: r.paused_at, completed_at: null,
    canAct: !!r.can_count && can(actor, 'count.perform'), outcome: 'open',
    action_label: r.paused_at || r.started_at ? 'Resume' : 'Start',
  };
}

export function nextAssignedStocktake(db, actor) {
  if (!can(actor, 'count.perform')) return null;
  const r = db.prepare(`SELECT r.id FROM stocktake_runs r WHERE r.status NOT IN ('closed','completed','stopped')
    AND ${remaining(actor)} ORDER BY r.created_at,r.id LIMIT 1`).get();
  return r ? stocktakeWorkItem(db, actor, r.id) : null;
}
