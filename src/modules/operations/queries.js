import {can,assertCan} from '../access/catalog.js';
const pageNumber=value=>Math.max(1,Math.min(1000000,Math.floor(Number(value)||1)));
const closed="t.outcome IN ('completed','stopped','cancelled')";
const overdue="t.completed_at IS NULL AND t.due_at IS NOT NULL AND julianday(t.due_at)<julianday('now')";
export function taskSelection(db,user,input={}) {
  const view=input.view||'accessible',where=['t.workflow_version=2'],params=[];
  if(view==='assign'){assertCan(user,'work.assign');return {priority:null,ids:[],page:{number:1,pages:1,total:0,limit:100,view,state:'open'},counts:{}};}
  if(view==='team'||view==='history'&&input.scope==='team')assertCan(user,'work.team');
  if(view==='mine'){where.push('t.assignee_id=?');params.push(user.id);}
  else if(!can(user,'work.team')||view==='history'&&input.scope!=='team'){
    where.push('(t.assignee_id=? OR t.created_by=? OR EXISTS(SELECT 1 FROM task_assignment_events e WHERE e.task_id=t.id AND (e.assignee_id=? OR e.previous_assignee=?)))');params.push(user.id,user.id,user.id,user.id);
  }
  const base=where.join(' AND ');
  const counts=db.prepare(`SELECT COUNT(*) total,SUM(NOT (${closed})) active,SUM(t.outcome='needs_assignment') needsAssignment,SUM(t.attention=1) review,SUM(${overdue}) overdue,SUM(${closed}) closed FROM tasks t WHERE ${base}`).get(...params);
  const state=input.state||(view==='mine'||view==='team'?'open':'all');
  if(state==='open')where.push(`NOT (${closed})`);
  else if(state==='closed')where.push(closed);
  else if(state==='overdue')where.push(overdue);
  else if(['needs_assignment','needs_review','completed','stopped','cancelled'].includes(state)){where.push('t.outcome=?');params.push(state);}
  for(const [key,column] of [['operator','assignee_id'],['action','type'],['source','assignment_source']])if(input[key]){where.push('t.'+column+'=?');params.push(input[key]);}
  if(input.date){where.push('date(t.started_at)>=date(?)');params.push(input.date);}
  const total=db.prepare(`SELECT COUNT(*) n FROM tasks t WHERE ${where.join(' AND ')}`).get(...params).n;
  const pages=Math.max(1,Math.ceil(total/100)),page=Math.min(pageNumber(input.page),pages);
  // My work displays new assignments first; execution priority uses original creation time.
  // tasks.started_at is the immutable creation timestamp, unlike assigned_at on reassignment.
  const order=view==='mine'?"COALESCE(julianday(t.assigned_at),julianday(t.started_at)) DESC,t.id DESC":`CASE WHEN ${closed} THEN 1 ELSE 0 END,CASE WHEN ${overdue} THEN 0 ELSE 1 END,t.id DESC`;
  const rows=db.prepare(`SELECT t.id FROM tasks t WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 100 OFFSET ?`).all(...params,(page-1)*100);
  const priority=view==='mine'&&can(user,'work.execute')?db.prepare(`SELECT t.id,t.started_at AS createdAt,(SELECT p.name FROM task_lines l JOIN products p ON p.id=l.product_id WHERE l.task_id=t.id ORDER BY l.id LIMIT 1) AS productName FROM tasks t WHERE t.workflow_version=2 AND t.assignee_id=? AND t.completed_at IS NULL AND t.attention=0 AND t.outcome='open' AND t.assignment_state IN ('offered','started','legacy') AND EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=t.id AND l.execution_state IN ('ready','working')) AND NOT EXISTS(SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=t.id AND r.status IN ('review','received')) ORDER BY julianday(t.started_at),t.id LIMIT 1`).get(user.id)||null:null;
  return {priority,ids:rows.map(r=>r.id),page:{number:page,pages,total,limit:100,view,state},counts};
}
export function reviewSelection(db,user,input={}) {
  if(!can(user,'review.view'))return {rows:[],page:{number:1,pages:1,total:0,limit:100},total:0};
  const where=["r.status IN ('review','received')"],params=[];
  const joins='FROM work_reports r JOIN products p ON p.id=r.product_id JOIN cells c ON c.id=r.cell_id LEFT JOIN users u ON u.id=r.performer_id JOIN users reporter ON reporter.id=r.reporter_id LEFT JOIN task_lines l ON l.id=r.line_id LEFT JOIN tasks t ON t.id=l.task_id LEFT JOIN users a ON a.id=t.assignee_id';
  const total=db.prepare("SELECT COUNT(*) n FROM work_reports WHERE status IN ('review','received')").get().n;
  for(const [key,column] of [['assigned','t.assignee_id'],['performed','r.performer_id']])if(input[key]){if(input[key]==='unknown')where.push(column+' IS NULL');else{where.push(column+'=?');params.push(Number(input[key]));}}
  const filtered=db.prepare(`SELECT COUNT(*) n ${joins} WHERE ${where.join(' AND ')}`).get(...params).n;
  const pages=Math.max(1,Math.ceil(filtered/100)),page=Math.min(pageNumber(input.reviewPage),pages);
  const order=input.group==='assigned'?"COALESCE(a.name,'Unassigned'),t.assignee_id,":input.group==='performed'?"COALESCE(u.name,'Unknown'),r.performer_id,":'';
  const rows=db.prepare(`SELECT r.*,p.name product_name,p.sku,c.logical_code,u.name operator_name,u.username performer_username,reporter.name reporter_name,reporter.username reporter_username,l.planned_quantity,l.actual_quantity,l.execution_state,l.revision,l.task_id,t.assignee_id,a.name assignee_name,a.username assignee_username ${joins} WHERE ${where.join(' AND ')} ORDER BY ${order}r.created_at,r.id LIMIT 100 OFFSET ?`).all(...params,(page-1)*100);
  const groupColumn=input.group==='assigned'?'t.assignee_id':'r.performer_id';
  const groups=input.group?db.prepare(`SELECT ${groupColumn} person,COUNT(*) total ${joins} WHERE ${where.join(' AND ')} GROUP BY ${groupColumn}`).all(...params):[];
  return {rows,page:{number:page,pages,total:filtered,limit:100},total,groups};
}
export function workloads(db) {
  return db.prepare(`SELECT u.id,COUNT(t.id) open,SUM(EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=t.id AND l.execution_state='working')) inProgress,SUM(${overdue}) overdue,SUM(t.attention=1) review FROM users u LEFT JOIN tasks t ON t.assignee_id=u.id AND t.workflow_version=2 AND NOT (${closed}) GROUP BY u.id`).all();
}
