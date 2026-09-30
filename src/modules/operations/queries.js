import {can,assertCan} from '../access/catalog.js';
const pageNumber=value=>Math.max(1,Math.min(1000000,Math.floor(Number(value)||1)));
const closed="t.outcome IN ('completed','stopped','cancelled')";
const created="COALESCE((SELECT MIN(e.created_at) FROM task_assignment_events e WHERE e.task_id=t.id AND e.event_type='assigned'),t.started_at)";
const overdue="t.completed_at IS NULL AND t.due_at IS NOT NULL AND julianday(t.due_at)<julianday('now')";
function legacyTaskSelection(db,user,input={}) {
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
  // The original assigned event survives explicit Start and later reassignment.
  const order=view==='mine'?"COALESCE(julianday(t.assigned_at),julianday(t.started_at)) DESC,t.id DESC":`CASE WHEN ${closed} THEN 1 ELSE 0 END,CASE WHEN ${overdue} THEN 0 ELSE 1 END,t.id DESC`;
  const rows=db.prepare(`SELECT t.id FROM tasks t WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 100 OFFSET ?`).all(...params,(page-1)*100);
  const priority=view==='mine'&&can(user,'work.execute')?db.prepare(`SELECT t.id,${created} AS createdAt,(SELECT p.name FROM task_lines l JOIN products p ON p.id=l.product_id WHERE l.task_id=t.id ORDER BY l.id LIMIT 1) AS productName FROM tasks t WHERE t.workflow_version=2 AND t.assignee_id=? AND t.completed_at IS NULL AND t.attention=0 AND t.outcome='open' AND t.assignment_state IN ('offered','started','legacy') AND EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=t.id AND l.execution_state IN ('ready','working')) AND NOT EXISTS(SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=t.id AND r.status IN ('review','received')) ORDER BY julianday(${created}),t.id LIMIT 1`).get(user.id)||null:null;
  return {priority,ids:rows.map(r=>r.id),page:{number:page,pages,total,limit:100,view,state},counts};
}
export function taskSelection(db,user,input={}) {
  const history=input.view==='history';
  if(input.view!=='mine'&&!history)return legacyTaskSelection(db,user,input);
  const own='t.assignee_id=?',params=[user.id];
  const returnedScope=can(user,'work.team')?'1':can(user,'work.assign')?'(t.created_by=? OR EXISTS(SELECT 1 FROM task_assignment_events e WHERE e.task_id=t.id AND (e.assignee_id=? OR e.previous_assignee=?)))':'0';
  if(returnedScope.includes('?'))params.push(user.id,user.id,user.id);
  const supervisor=can(user,'review.view')?`EXISTS(SELECT 1 FROM work_reports wr JOIN task_lines wl ON wl.id=wr.line_id WHERE wl.task_id=t.id AND wr.status IN ('review','received'))`:'0';
  let scope=`(${own} OR ((t.assignment_state='returned' OR t.attention=1) AND ${returnedScope}) OR ${supervisor})`;
  if(history){params.length=0;if(input.scope==='team'){assertCan(user,'work.team');scope='1';}else{scope='(t.assignee_id=? OR t.created_by=? OR EXISTS(SELECT 1 FROM task_assignment_events e WHERE e.task_id=t.id AND (e.assignee_id=? OR e.previous_assignee=?)))';params.push(user.id,user.id,user.id,user.id);}}
  const cte=`WITH base AS (SELECT t.*, (SELECT p.name FROM task_lines l JOIN products p ON p.id=l.product_id WHERE l.task_id=t.id ORDER BY l.id LIMIT 1) product, (SELECT l.unit_of_measure FROM task_lines l WHERE l.task_id=t.id ORDER BY l.id LIMIT 1) unit,
    ROUND(COALESCE((SELECT SUM(l.actual_quantity) FROM task_lines l WHERE l.task_id=t.id AND l.execution_state='settled'),0),6) completed,
    (t.attention=1 OR (t.completed_at IS NULL AND (t.review_followup=1 OR t.assignment_state='returned')) OR EXISTS(SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=t.id AND r.status IN ('review','received'))) needs_review,
    EXISTS(SELECT 1 FROM task_lines l JOIN work_guidance g ON g.cell_id=l.cell_id WHERE l.task_id=t.id AND l.execution_state IN ('ready','working') AND json_extract(g.desired,'$.action') IN ('count','quantity','locate') AND COALESCE(json_extract(g.desired,'$.lineId'),-1)!=l.id) waiting
    FROM tasks t WHERE t.workflow_version=2 AND ${scope}),
    rows AS (SELECT *,CASE WHEN needs_review THEN 'review' WHEN completed_at IS NOT NULL OR outcome IN ('completed','stopped','cancelled') THEN 'completed' WHEN assignment_state IN ('offered','returned','legacy') THEN 'not_started' ELSE 'in_progress' END lifecycle,
    CASE WHEN completed_at IS NULL AND review_remaining_quantity IS NOT NULL THEN review_remaining_quantity ELSE ROUND(MAX(0,requested_quantity-completed),6) END remaining,
    CASE WHEN requested_quantity>0 THEN ROUND(completed*100.0/requested_quantity,1) ELSE 0 END progress,
    CASE WHEN needs_review THEN CASE WHEN attention=1 OR review_followup=1 OR assignment_state!='returned' THEN 'Quantity check' ELSE 'Needs assignment' END WHEN completed_at IS NOT NULL OR outcome IN ('completed','stopped','cancelled') THEN outcome WHEN waiting AND assignment_state='started' THEN 'Waiting for location' WHEN due_at IS NOT NULL AND julianday(due_at)<julianday('now') THEN 'Overdue' WHEN assignment_state='offered' THEN 'Not started' ELSE 'In progress' END display_status FROM base)`;
  const where=['1'],filtered=[...params],state=input.workState||(history?'all':'current');
  if(state==='current')where.push("lifecycle!='completed'");else if(['review','not_started','in_progress','completed'].includes(state)){where.push('lifecycle=?');filtered.push(state);}
  if(history){
    if(input.state==='closed')where.push("outcome IN ('completed','stopped','cancelled')");
    else if(input.state==='open')where.push("completed_at IS NULL");
    else if(input.state==='overdue')where.push("completed_at IS NULL AND due_at IS NOT NULL AND julianday(due_at)<julianday('now')");
    else if(['needs_assignment','needs_review','completed','stopped','cancelled'].includes(input.state)){where.push('outcome=?');filtered.push(input.state);}
    for(const [key,column] of [['operator','assignee_id'],['action','type'],['source','assignment_source']])if(input[key]){where.push(column+'=?');filtered.push(input[key]);}
    if(input.date){where.push('date(started_at)>=date(?)');filtered.push(input.date);}
  }
  if(['1','true',true].includes(input.reviewOnly))where.push('needs_review=1');
  for(const [key,col] of [['taskSearch',"CAST(id AS TEXT)||' '||type"],['productSearch',"COALESCE(product,'')"],['statusSearch','display_status']])if(String(input[key]||'').trim()){where.push(input[key+'Exact']==='1'?`lower(${col})=lower(?)`:`instr(lower(${col}),lower(?))>0`);filtered.push(String(input[key]).trim().slice(0,160));}
  if(input.progressRange){
    const ranges={'0-25':[0,25],'25-50':[25,50],'50-75':[50,75],'75-100':[75,100]};
    if(!Object.hasOwn(ranges,input.progressRange))throw new Error('Choose a listed progress range.');
    const [min,max]=ranges[input.progressRange];
    // Adjacent ranges do not overlap; exactly 100% belongs to the final range.
    where.push(`progress>=? AND progress${max===100?'<=':'<'}?`);filtered.push(min,max);
  }
  for(const col of ['requested','completed','remaining','progress'])for(const [suffix,op] of [['Min','>='],['Max','<=']])if(input[col+suffix]!=null&&String(input[col+suffix]).trim()!==''){
    const n=Number(input[col+suffix]);if(!Number.isFinite(n)||n<0)throw new Error('Quantity and progress filters must be non-negative numbers.');where.push(`${col==='requested'?'requested_quantity':col}${op}?`);filtered.push(n);
  }
  const columns={task:'id',product:'product COLLATE NOCASE',unit:'unit COLLATE NOCASE',requested:'requested_quantity',completed:'completed',remaining:'remaining',status:'display_status COLLATE NOCASE',progress:'progress',state:"CASE lifecycle WHEN 'review' THEN 'Needs Review' WHEN 'completed' THEN 'Task Completed' WHEN 'in_progress' THEN 'Task In Progress' ELSE 'Task Not Started' END COLLATE NOCASE"};
  const sort=Object.hasOwn(columns,input.sort)?input.sort:'task',direction=input.order==='asc'?'ASC':'DESC';
  const limit=[20,50,100].includes(Number(input.pageSize))?Number(input.pageSize):50;
  const total=db.prepare(`${cte} SELECT COUNT(*) n FROM rows WHERE ${where.join(' AND ')}`).get(...filtered).n,pages=Math.max(1,Math.ceil(total/limit)),number=Math.min(pageNumber(input.page),pages);
  const ids=db.prepare(`${cte} SELECT id,lifecycle,display_status,progress FROM rows WHERE ${where.join(' AND ')} ORDER BY ${columns[sort]} ${direction},id ${direction} LIMIT ? OFFSET ?`).all(...filtered,limit,(number-1)*limit);
  const legacy=history?{priority:null,counts:{}}:legacyTaskSelection(db,user,{view:'mine',state:'open'});
  return {ids:ids.map(r=>r.id),metrics:new Map(ids.map(r=>[r.id,{work_state:r.lifecycle,work_status:r.display_status,work_progress:r.progress}])),priority:legacy.priority,counts:legacy.counts,page:{number,pages,total,limit,view:history?'history':'mine',state,sort,order:direction.toLowerCase(),unified:true}};
}
export function reviewSelection(db,user,input={}) {
  if(!can(user,'review.view'))return {rows:[],page:{number:1,pages:1,total:0,limit:100},total:0};
  const where=["r.status IN ('review','received')"],params=[];
  const joins='FROM work_reports r JOIN products p ON p.id=r.product_id JOIN cells c ON c.id=r.cell_id LEFT JOIN users u ON u.id=r.performer_id JOIN users reporter ON reporter.id=r.reporter_id LEFT JOIN task_lines l ON l.id=r.line_id LEFT JOIN tasks t ON t.id=l.task_id LEFT JOIN users a ON a.id=t.assignee_id';
  const total=db.prepare("SELECT COUNT(*) n FROM work_reports WHERE status IN ('review','received')").get().n;
  for(const [key,column] of [['assigned','t.assignee_id'],['performed','r.performer_id']])if(input[key]){if(input[key]==='unknown')where.push(column+' IS NULL');else{where.push(column+'=?');params.push(Number(input[key]));}}
  if(input.reportId){where.push('r.id=?');params.push(String(input.reportId));}
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

// Assignment-only delegates see their existing task scope; team access is explicit.
export function returnedSelection(db,user,input={}) {
  if(!can(user,'work.assign')&&!can(user,'work.team'))return {ids:[],page:{number:1,pages:1,total:0,limit:100}};
  const where=["t.workflow_version=2","((t.assignment_state='returned' AND t.stop_requested=0 AND t.completed_at IS NULL) OR t.attention=1)"],params=[];
  if(!can(user,'work.team')){where.push('(t.created_by=? OR EXISTS(SELECT 1 FROM task_assignment_events e WHERE e.task_id=t.id AND (e.assignee_id=? OR e.previous_assignee=?)))');params.push(user.id,user.id,user.id);}
  const total=db.prepare(`SELECT COUNT(*) n FROM tasks t WHERE ${where.join(' AND ')}`).get(...params).n;
  const pages=Math.max(1,Math.ceil(total/100)),number=Math.min(pageNumber(input.returnedPage),pages);
  return {ids:db.prepare(`SELECT t.id FROM tasks t WHERE ${where.join(' AND ')} ORDER BY (SELECT MAX(e.id) FROM task_assignment_events e WHERE e.task_id=t.id AND e.event_type='returned') DESC,t.id DESC LIMIT 100 OFFSET ?`).all(...params,(number-1)*100).map(r=>r.id),page:{number,pages,total,limit:100}};
}
