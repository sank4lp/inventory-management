export function hasOutstandingWork(db, { cellId = null, productId = null } = {}) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='work_reservations'").get()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id
    WHERE r.state='held' AND (? IS NULL OR l.cell_id=?) AND (? IS NULL OR l.product_id=?) LIMIT 1`)
    .get(cellId, cellId, productId, productId)) || Boolean(db.prepare(`SELECT 1 FROM work_reports
    WHERE status IN ('review','received') AND (? IS NULL OR cell_id=?) AND (? IS NULL OR product_id=?) LIMIT 1`)
    .get(cellId, cellId, productId, productId));
}

export function guardSetupChange(db, scope = {}) {
  if (hasOutstandingWork(db, scope)) {
    throw new Error("This change affects outstanding warehouse work. Resolve Pending confirmations first. Physical work can continue using Record completed movement.");
  }
}

export function guardLegacyTask(db, taskId) {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(taskId));
  if (task?.workflow_version === 2) throw new Error("Use the task's per-cell actions so recorded and pending work stay intact.");
}
