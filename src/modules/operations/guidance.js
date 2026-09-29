// Display ownership is separate from arrival/physical execution ownership.
export function activeWorkGuidance(db) {
  return !!db.prepare("SELECT 1 FROM task_lines WHERE execution_state='working' LIMIT 1").get() ||
    !!db.prepare("SELECT 1 FROM work_guidance WHERE (json_extract(desired,'$.action') IN ('quantity','locate') OR delivered=0 AND json_extract(desired,'$.action')='clear') LIMIT 1").get();
}
export function guidanceBinding(db,cellId) {
  const c=db.prepare('SELECT c.controller_id,c.hardware_channel,c.binding_revision,ctrl.address,ctrl.module_count,ctrl.configured_at FROM cells c LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?').get(cellId);
  return JSON.stringify(c||null);
}
