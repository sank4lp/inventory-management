// Claims awaiting a quantity check remain visible in the ledger, but may yield
// stock or space to new work. An executing line never yields just because a sibling
// line in the same task needs review.
export const reviewClaim = (l='l',t='t') => `(${t}.review_followup=1 OR EXISTS(SELECT 1 FROM work_reports pr WHERE pr.line_id=${l}.id AND pr.status IN ('review','received')))`;
export const yieldableClaim = (l='l',t='t') => `(${reviewClaim(l,t)} OR (${t}.assignment_state='offered' AND ${l}.execution_state='ready' AND ${l}.started_at IS NULL))`;
export function protectedPicks(db,cellId,productId,excluding=0,excludingTask=0,{protectUnstarted=false}={}){
 return Number(db.prepare(`SELECT COALESCE(SUM(r.quantity),0) n FROM work_reservations r JOIN task_lines l ON l.id=r.line_id JOIN tasks t ON t.id=l.task_id WHERE r.state='held' AND r.kind='pick' AND l.cell_id=? AND l.product_id=? AND l.id!=? AND l.task_id!=? AND NOT ${protectUnstarted?reviewClaim():yieldableClaim()}`).get(cellId,productId,excluding,excludingTask).n);
}
// Unlike raw unit totals, fractions are comparable across different products.
export function usedSpace(db,cellId,{excludingLine=0,excludingTask=0,reservations=true,protectActiveOnly=false,protectUnstarted=false}={}){
 const stock=db.prepare('SELECT b.available_quantity quantity,p.items_per_cell capacity FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.cell_id=? AND b.available_quantity>0').all(cellId);
 const incoming=reservations?db.prepare(`SELECT r.quantity,p.items_per_cell capacity FROM work_reservations r JOIN task_lines l ON l.id=r.line_id JOIN products p ON p.id=l.product_id JOIN tasks t ON t.id=l.task_id WHERE r.state='held' AND r.kind='put' AND l.cell_id=? AND l.id!=? AND l.task_id!=? ${protectActiveOnly?'AND NOT '+(protectUnstarted?reviewClaim():yieldableClaim()):''}`).all(cellId,excludingLine,excludingTask):[];
 return [...stock,...incoming].reduce((n,r)=>n+(r.capacity>0?r.quantity/r.capacity:Infinity),0);
}
export function putRoom(db,cellId,product,options={}){
 // Floor rather than round: never allocate more than the remaining fraction.
 return Math.max(0,Math.floor(((1-usedSpace(db,cellId,{protectActiveOnly:true,...options}))*product.items_per_cell+1e-9)*1e6)/1e6);
}
export const taskPrioritySql=(task='t')=>`CASE WHEN EXISTS(SELECT 1 FROM work_events e JOIN work_reports wr ON wr.id=e.report_id JOIN task_lines wl ON wl.id=e.line_id WHERE wl.task_id=${task}.id AND e.event_type='reservation_displaced' AND wr.status IN ('review','received')) THEN 2 WHEN EXISTS(SELECT 1 FROM work_reports wr JOIN task_lines wl ON wl.id=wr.line_id WHERE wl.task_id=${task}.id AND wr.origin_ref LIKE 'task-closure:%' AND wr.status IN ('review','received')) THEN 2 ELSE COALESCE((SELECT MAX(CASE
 WHEN (SELECT COALESCE(SUM(wr.quantity),0) FROM work_reservations wr JOIN task_lines wl ON wl.id=wr.line_id WHERE wr.kind='pick' AND wr.state='held' AND wl.product_id=l.product_id) > (SELECT COALESCE(SUM(MAX(0,b.available_quantity)),0) FROM inventory_balances b WHERE b.product_id=l.product_id) + 0.000000001 THEN 2
 WHEN (SELECT COALESCE(SUM(wr.quantity),0) FROM work_reservations wr JOIN task_lines wl ON wl.id=wr.line_id WHERE wr.kind='pick' AND wr.state='held' AND wl.product_id=l.product_id) > (SELECT COALESCE(SUM(MAX(0,b.available_quantity)),0) FROM inventory_balances b WHERE b.product_id=l.product_id)*0.5 THEN 1 ELSE 0 END)
 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=${task}.id AND r.state='held' AND r.kind='pick' AND ${reviewClaim('l',task)}),0) END`;
