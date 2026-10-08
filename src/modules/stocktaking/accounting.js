// Shared count boundary used by stock review and incoming movement evidence.
export function controlledCell(db, cellId) {
  return Boolean(db.prepare("SELECT 1 FROM stocktake_condition_reviews WHERE cell_id=? AND state='open' LIMIT 1").get(cellId));
}

export function countBoundary(db, report, allocation = null) {
  const row=db.prepare(`SELECT o.id,o.counted_at,a.started_at,s.created_at FROM stocktake_settlements s
    JOIN stocktake_observations o ON o.id=s.observation_id JOIN stocktake_attempts a ON a.id=o.attempt_id
    JOIN stocktake_items i ON i.id=o.item_id WHERE i.cell_id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(o.lines_json) l WHERE json_extract(l.value,'$.productId')=?)) ORDER BY s.created_at DESC LIMIT 1`).get(report.cell_id,report.product_id ?? allocation?.product_id ?? null,report.product_id ?? allocation?.product_id ?? null);
  if(!row) return null;
  // A new instruction acquired after correction has a trustworthy server boundary.
  if(allocation?.started_at && allocation.started_at > row.created_at) return null;
  return row;
}
