// Display ownership is separate from arrival/physical execution ownership.
export function activeWorkGuidance(db, cellId=null) {
  return !!db.prepare("SELECT 1 FROM work_guidance WHERE (? IS NULL OR cell_id=?) AND json_extract(desired,'$.action') IN ('quantity','locate','count') LIMIT 1").get(cellId,cellId);
}
// The generation fences both operational sends and lower-priority utility cleanup.
export function displayOwner(db,cellId) {
  const row=db.prepare('SELECT * FROM work_guidance WHERE cell_id=?').get(cellId);
  if(!row)return null;const d=JSON.parse(row.desired);
  if(d.action==='count'){
    const owner=db.prepare(`SELECT i.run_id AS runId,i.id AS itemId,u.name AS name FROM stocktake_items i JOIN stocktake_runs r ON r.id=i.run_id JOIN users u ON u.id=i.assignee_id WHERE i.id=? AND i.generation=? AND i.state IN ('pending','counting','skipped','recheck') AND r.status NOT IN ('closed','completed')`).get(d.itemId,d.itemGeneration);
    return owner?{...owner,kind:'count',generation:row.generation}:null;
  }
  if(!['quantity','locate'].includes(d.action))return null;
  const owner=db.prepare(`SELECT l.id AS lineId,t.id AS taskId,u.name FROM task_lines l JOIN tasks t ON t.id=l.task_id JOIN users u ON u.id=t.assignee_id
    WHERE l.id=? AND l.execution_state IN ('ready','working') AND t.assignment_state='started' AND t.stop_requested=0 AND t.completed_at IS NULL AND t.review_followup=0
    AND NOT EXISTS(SELECT 1 FROM work_reports w WHERE w.line_id=l.id AND w.status IN ('review','received'))`).get(d.lineId);
  return owner?{...owner,kind:'task',generation:row.generation}:null;
}
export function waitingMessage(owner){return `Waiting for ${owner.name} · ${owner.kind==='count'?'Stocktake':'Task'} #${owner.taskId??owner.runId}. This location will become available when their cell work finishes or stops.`;}
export function guidanceBinding(db,cellId) {
  const c=db.prepare('SELECT c.controller_id,c.hardware_channel,c.binding_revision,ctrl.address,ctrl.module_count,ctrl.configured_at FROM cells c LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?').get(cellId);
  return JSON.stringify(c||null);
}
