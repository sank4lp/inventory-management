import {createHash} from 'node:crypto';
import {can} from '../access/catalog.js';

export function setupWorkScope(input={}) {
  const scope={};
  for(const key of ['cellId','productId'])if(input[key]!=null&&input[key]!==''){
    const value=Number(input[key]);if(!Number.isSafeInteger(value)||value<1)throw Error('Choose a valid location or product.');scope[key]=value;
  }
  return scope;
}
// Linked puts must stay available while picked goods are in transit or a pick is uncertain.
function moveDiscardProtection(db,taskId){
  const dependency=db.prepare('SELECT value FROM app_metadata WHERE key=?').get('led_move_dependency:'+taskId)?.value;if(!dependency)return null;
  const picks=JSON.parse(dependency);let picked=0,put=0;
  for(const id of picks){
    const active=db.prepare("SELECT 1 FROM tasks t JOIN task_lines l ON l.task_id=t.id WHERE t.id=? AND t.completed_at IS NULL AND (l.started_at IS NOT NULL OR l.execution_state='working')").get(id);
    const uncertain=db.prepare("SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received')").get(id);
    if(active||uncertain)return 'Finish or verify the linked picks before discarding their put tasks. Use View / discard move to keep the move accounted for.';
    picked+=db.prepare('SELECT COALESCE(SUM(s.quantity),0) n FROM work_settlements s JOIN task_lines l ON l.id=s.line_id WHERE l.task_id=?').get(id).n;
  }
  for(const r of db.prepare("SELECT key FROM app_metadata WHERE key LIKE 'led_move_dependency:%' AND value=?").all(dependency))put+=db.prepare('SELECT COALESCE(SUM(s.quantity),0) n FROM work_settlements s JOIN task_lines l ON l.id=s.line_id WHERE l.task_id=?').get(Number(r.key.split(':')[1])).n;
  return picked>put+0.000001?'Products already picked still need to be put away. Complete or reconcile this move before discarding its put tasks.':null;
}
// Keep the selector identical to guardSetupChange: reservations AND unverified evidence block setup.
export function setupBlockers(db,actor,input={}) {
  const scope=setupWorkScope(input),cid=scope.cellId??null,pid=scope.productId??null;
  const matches=db.prepare(`SELECT DISTINCT t.* FROM tasks t JOIN task_lines l ON l.task_id=t.id
    WHERE EXISTS(SELECT 1 FROM work_reservations r WHERE r.line_id=l.id AND r.state='held' AND (? IS NULL OR l.cell_id=?) AND (? IS NULL OR l.product_id=?))
    OR EXISTS(SELECT 1 FROM work_reports r WHERE r.line_id=l.id AND r.status IN ('review','received') AND (? IS NULL OR r.cell_id=?) AND (? IS NULL OR r.product_id=?)) ORDER BY t.id`).all(cid,cid,pid,pid,cid,cid,pid,pid);
  let hiddenCount=0;
  const tasks=matches.flatMap(t=>{
    if(t.assignee_id!==actor.id&&!can(actor,'work.team')&&!can(actor,'work.teamStop')&&!can(actor,'review.view')){hiddenCount++;return [];}
    const lines=db.prepare(`SELECT l.id,l.product_id,l.cell_id,l.revision,l.execution_state,l.started_at,l.device_id,l.planned_quantity,l.actual_quantity,l.unit_of_measure,
      p.name product,p.sku,COALESCE(c.display_name,c.logical_code) location,r.state reservation_state,r.quantity reserved
      FROM task_lines l JOIN products p ON p.id=l.product_id JOIN cells c ON c.id=l.cell_id LEFT JOIN work_reservations r ON r.line_id=l.id WHERE l.task_id=? ORDER BY l.id`).all(t.id);
    const reports=db.prepare("SELECT r.id,r.case_revision,r.line_id,r.cell_id,r.product_id,r.quantity,r.quantity_known,r.unit,r.status,r.reason FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? AND r.status IN ('review','received') ORDER BY r.id").all(t.id);
    const token=createHash('sha256').update(JSON.stringify([t,lines,reports])).digest('hex');
    const needsCheck=reports.length>0||lines.some(l=>l.execution_state==='working');
    const moveProtection=moveDiscardProtection(db,t.id);
    const canDiscard=!moveProtection&&t.workflow_version===2&&!t.completed_at&&(t.assignee_id===actor.id?can(actor,'work.stop'):can(actor,'work.teamStop'));
    return [{id:t.id,type:t.type,summary:t.summary,assignee:db.prepare('SELECT name FROM users WHERE id=?').get(t.assignee_id)?.name||'Unassigned',createdAt:t.started_at,generation:t.assignment_generation,token,lines,reports,needsCheck,canDiscard,moveProtected:!!moveProtection,canVerify:can(actor,'review.resolve')&&can(actor,'review.stop'),status:needsCheck?'Needs quantity check':'Reserved',reason:canDiscard?null:moveProtection|| (t.workflow_version!==2?'Open the original task to resolve this older work.':t.completed_at?'Review the pending entry for this closed task.':'You do not have permission to stop this task.')}];
  });
  const manual=db.prepare(`SELECT r.id,r.direction,r.quantity,r.quantity_known,r.unit,r.case_revision,r.reason,r.reporter_id,r.performer_id,p.name product,COALESCE(c.display_name,c.logical_code) location
    FROM work_reports r JOIN products p ON p.id=r.product_id JOIN cells c ON c.id=r.cell_id WHERE r.line_id IS NULL AND r.status IN ('review','received') AND (? IS NULL OR r.cell_id=?) AND (? IS NULL OR r.product_id=?) ORDER BY r.created_at`).all(cid,cid,pid,pid).flatMap(r=>{
      if(!can(actor,'review.view')&&r.reporter_id!==actor.id&&r.performer_id!==actor.id){hiddenCount++;return [];}return [{...r,token:createHash('sha256').update(JSON.stringify(r)).digest('hex'),canDiscard:can(actor,'review.resolve')}];
    });
  return {scope,tasks,manual,hiddenCount,remaining:tasks.length+manual.length+hiddenCount};
}
