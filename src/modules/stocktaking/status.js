// Lightweight shell/history data: never load count baselines, product lists or audit JSON.
export function stocktakeStatusRows(db, actor, capabilities, dateInZone, clock) {
 const team=capabilities.team?1:0;
 const rows=db.prepare(`
  WITH item_stats AS (
   SELECT i.run_id,COUNT(*) AS total,SUM(i.state='counted') AS completed,
    SUM(i.display_active=1) AS displayed,
    SUM((i.assignee_id=:actor OR EXISTS(SELECT 1 FROM stocktake_item_counters m WHERE m.item_id=i.id AND m.user_id=:actor))
      AND i.state IN ('pending','counting','skipped','recheck')) AS pending,
    MAX(i.assignee_id=:actor OR EXISTS(SELECT 1 FROM stocktake_item_counters m WHERE m.item_id=i.id AND m.user_id=:actor)
      OR EXISTS(SELECT 1 FROM stocktake_attempts a WHERE a.item_id=i.id AND a.counter_id=:actor)) AS visible
   FROM stocktake_items i GROUP BY i.run_id
  ), review_stats AS (
   SELECT i.run_id,COUNT(*) AS reviews FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id
   WHERE o.status IN ('review','recheck','unverified') AND (:team OR o.counter_id=:actor)
   GROUP BY i.run_id
  )
  SELECT r.id,r.title,r.due_date,r.timezone,r.created_by,r.created_at,r.started_at,r.closed_at,
   r.status,r.paused_at,r.revision,r.close_reason,r.display_enabled,
   COALESCE(s.total,0) AS total,COALESCE(s.completed,0) AS completed,
   COALESCE(s.pending,0) AS pending,COALESCE(v.reviews,0) AS reviews,COALESCE(s.displayed,0) AS displayed,
   COALESCE((SELECT e.created_at FROM stocktake_events e WHERE e.run_id=r.id
    AND e.event_type IN ('created','assigned','restarted') ORDER BY e.id DESC LIMIT 1),r.created_at) AS assigned_at
  FROM stocktake_runs r LEFT JOIN item_stats s ON s.run_id=r.id LEFT JOIN review_stats v ON v.run_id=r.id
  WHERE :team OR r.created_by=:actor OR s.visible ORDER BY r.id DESC
 `).all({actor:actor.id,team});
 const today=new Map();
 return rows.map(({displayed,...r})=>{
  const open=!['completed','closed','stopped'].includes(r.status);
  if(!today.has(r.timezone))today.set(r.timezone,dateInZone(clock(),r.timezone));
  return {...r,display_enabled:r.display_enabled&&displayed?1:0,
   overdue:!!(open&&r.due_date&&r.due_date<today.get(r.timezone)),
   actionable:!!(capabilities.manage&&open||(capabilities.approve||capabilities.recount)&&r.reviews>0||capabilities.count&&r.pending>0&&open)};
 });
}
