export function hasOutstandingWork(db, { cellId = null, productId = null } = {}) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='work_reservations'").get()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id
    WHERE r.state='held' AND (? IS NULL OR l.cell_id=?) AND (? IS NULL OR l.product_id=?) LIMIT 1`)
    .get(cellId, cellId, productId, productId)) || Boolean(db.prepare(`SELECT 1 FROM work_reports
    WHERE status IN ('review','received') AND (? IS NULL OR cell_id=?) AND (? IS NULL OR product_id=?) LIMIT 1`)
    .get(cellId, cellId, productId, productId));
}

export function guardUtilityDisplays(db, scope = {}) {
  if(db.prepare("SELECT name FROM sqlite_master WHERE name='display_requests'").get()&&db.prepare("SELECT 1 FROM display_requests WHERE state IN ('active','expiring') AND id!=? LIMIT 1").get(scope.allowDisplayId||''))throw new Error('Stop the active utility display before changing setup. Its ownership receipt protects task and location guidance.');
}

export function guardSetupChange(db, scope = {}) {
  guardUtilityDisplays(db,scope);
  if (hasOutstandingWork(db, scope)) {
    const error=new Error("This change affects outstanding warehouse work. Review the blocking tasks before continuing.");
    error.code='OUTSTANDING_WORK';error.statusCode=409;
    error.scope=Object.fromEntries(['cellId','productId'].filter(key=>scope[key]!=null).map(key=>[key,scope[key]]));
    throw error;
  }
}

export function guardLegacyTask(db, taskId) {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(taskId));
  if (task?.workflow_version === 2) throw new Error("Use the task's per-cell actions so recorded and pending work stay intact.");
}
