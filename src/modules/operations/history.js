import {can} from '../access/catalog.js';

const parse=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const labels={
 reservation_displaced:'Reservation taken over by newer work',reopened:'Remaining work reopened',reopened_from:'Reopened from earlier task',assigned:'Assigned',started:'Work started',resumed:'Work resumed',reassigned:'Reassigned',returned:'Work returned',
 returned_task_updated:'Returned work updated',review_assigned:'Review assigned',review_intent_updated:'Review assignment updated',review_task_updated:'Assignment updated',
 verified_work_resumed:'Remaining work assigned',deadline_changed:'Deadline changed',stop_requested:'Remaining work stopped',return_acknowledged:'Return acknowledged',closure_review_requested:'Closure sent for review',closed_actuals:'Task closed',
 task_reserved:'Stock reserved',unissued_plan_replaced:'Locations replanned',location_ready:'Arrived at location',location_verified:'QR checked',
 uncertainty_reported:'Quantity check requested',review_requested:'Sent for review',review_observation:'Movement checked',verification_deferred:'Review kept open',
 allocation_settled:'Location completed',unstarted_cancelled:'Location cancelled',untouched_inactivity_retired:'Unstarted work cleared',
 actual_location_verified:'Actual location confirmed',remaining_plan_updated:'Remaining quantity updated',allocation_replanned:'Location changed',
 record_corrected:'Movement corrected',task_close_line_reconciled:'Final location quantity confirmed',task_close_evidence_reconciled:'Pending movement resolved',
 task_closed_actuals:'Task closed with actual quantities',task_completed:'Task completed',
 late_report_reconciled:'Late movement resolved',movement_accounted_by_stocktake:'Movement matched to stock count',allocation_accounted_elsewhere:'Movement matched to an existing entry',duplicate_verified:'Duplicate entry confirmed',
};
const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'medium'})+' IST':String(value);
const details=(v,people)=>[
 v.reason,v.note,v.verification,
 v.nextTaskId?`New task: #${v.nextTaskId} · ${v.quantity} ${v.unit}`:null,
 v.sourceTaskId?`Original task: #${v.sourceTaskId}`:null,
 v.previous!=null&&typeof v.previous==='number'&&v.actual!=null?`Previously recorded: ${v.previous}`:null,
 v.remaining!=null?`Remaining: ${v.remaining}`:null,
 v.dueAt?`Deadline: ${time(v.dueAt)}`:null,
 v.linkedReport?'Matched to an existing movement; stock was not changed again.':null,
 v.observationId?'Matched to a stock count; stock was not changed again.':null,
 v.performer!=null?`Performed by: ${people.get(Number(v.performer))||'Unknown'}`:null,
].filter(Boolean).map(String).join(' · ');
const pageOf=(input,total,limit=100)=>{const pages=Math.max(1,Math.ceil(total/limit)),number=Math.min(pages,Math.max(1,Math.floor(Number(input.page)||1)));return {number,pages,total,limit};};

// On-demand read models: list pages never fetch whole task timelines.
// Inventory deltas and reported quantities are distinct rows, never summed together.
export function createWorkHistory({db,actorNow,task,identity}){
 function taskHistory(actor,input={}){
  const current=actorNow(actor,'work.view'),t=task(current,Number(input.taskId));
  if(!t)throw new Error('Task not found.');
  const people=new Map(db.prepare('SELECT id,name FROM users').all().map(u=>[u.id,u.name]));
  const cells=new Map(db.prepare('SELECT id,logical_code,display_name FROM cells').all().map(c=>[c.id,c.display_name||c.logical_code]));
  const lines=new Map(t.lines.map(l=>[l.id,l]));
  const assignments=t.assignment_history||[],entries=[];
  const add=(id,time,step,more={})=>entries.push({id,time,step,actor:null,assignee:null,location:null,quantity:null,unit:null,details:'',...more});
  const created=assignments.find(e=>e.event_type==='assigned');
  add('created',created?.created_at||t.started_at,'Task created',{actor:t.created_by_name||people.get(t.created_by),details:created?'':'Earliest task timestamp available.'});
  for(const e of assignments){const v=parse(e.payload);add('assignment:'+e.id,e.created_at,labels[e.event_type]||'Assignment updated',{actor:e.actor_name,assignee:e.assignee_name,details:[e.previous_name&&e.previous_assignee!==e.assignee_id?`Previously assigned to: ${e.previous_name}`:null,details(v,people)].filter(Boolean).join(' · ')});}
  const reports=db.prepare('SELECT r.* FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=? ORDER BY r.created_at,r.id').all(t.id),byReport=new Map(reports.map(r=>[r.id,r]));
  const events=db.prepare(`SELECT e.* FROM work_events e LEFT JOIN task_lines l ON l.id=e.line_id LEFT JOIN work_reports r ON r.id=e.report_id LEFT JOIN task_lines rl ON rl.id=r.line_id
   WHERE l.task_id=? OR rl.task_id=? OR (e.line_id IS NULL AND json_valid(e.payload) AND json_extract(e.payload,'$.taskId')=?) ORDER BY e.created_at,e.id`).all(t.id,t.id,t.id);
  const snapshots=db.prepare('SELECT h.* FROM work_instruction_history h JOIN task_lines l ON l.id=h.line_id WHERE l.task_id=? ORDER BY h.created_at,h.revision').all(t.id);
  for(const e of events){
   if(e.event_type==='task_closed_actuals'&&assignments.some(a=>a.event_type==='closed_actuals'))continue;
   const v=parse(e.payload),l=lines.get(e.line_id),r=byReport.get(e.report_id);
   const instruction=parse(snapshots.filter(h=>h.line_id===e.line_id&&h.created_at<=e.created_at).at(-1)?.snapshot);
   const cellId=v.actualCell??v.cellId??r?.cell_id??instruction.cellId??l?.cell_id;
   const quantity=v.actual??v.quantity??null;
   add('event:'+e.id,e.created_at,(e.event_type==='task_completed'&&v.outcome!=='completed'?'Task closed':labels[e.event_type])||'Task updated',{actor:people.get(e.actor_id)||'System',location:cellId===instruction.cellId?(instruction.name||instruction.code||cells.get(cellId)):cells.get(Number(cellId)),quantity,unit:r?.unit||instruction.unit||l?.unit_of_measure||t.lines[0]?.unit_of_measure,details:details(v,people)});
  }
  for(const r of reports){
   const v=parse(r.payload),automatic=/^(task-close:|closure-count:|attention:)/.test(r.origin_ref);
   if(!automatic)add('entry:'+r.id,r.created_at,'Movement entered',{actor:people.get(r.reporter_id),location:cells.get(r.cell_id),quantity:r.quantity_known===0?null:r.quantity,unit:r.unit,details:[r.quantity_known===0?'Quantity not confirmed':r.direction==='pick'?'Pick reported':r.direction==='put'?'Put reported':'Count entered',v.reason,r.occurred_at?`Movement time supplied by operator: ${time(r.occurred_at)}`:null].filter(Boolean).join(' · ')});
   // Older records did not append a review event. Retain their recorded creation
   // time, but explicitly mark the missing transition time instead of inventing it.
   if(!automatic&&r.reason&&!events.some(e=>e.report_id===r.id&&e.event_type==='review_requested')&&(r.status==='review'||r.resolver_id))add('review:'+r.id,r.created_at,'Review recorded',{actor:people.get(r.reporter_id),location:cells.get(r.cell_id),details:r.reason+' · Exact review-start time was not recorded.'});
   if(r.resolved_at&&r.resolver_id&&(r.status==='resolved'||events.some(e=>e.report_id===r.id&&e.event_type==='review_requested')||!automatic&&r.reason))add('resolved:'+r.id,r.resolved_at,'Review resolved',{actor:people.get(r.resolver_id),location:cells.get(r.cell_id),details:r.verification||''});
  }
  const movements=db.prepare(`SELECT tr.*,p.name product_name,c.logical_code,COALESCE(c.display_name,c.logical_code) location,u.name recorder,a.name performer FROM transactions tr LEFT JOIN products p ON p.id=tr.product_id LEFT JOIN cells c ON c.id=tr.cell_id LEFT JOIN users u ON u.id=tr.user_id LEFT JOIN users a ON a.id=tr.performed_by WHERE tr.task_id=? ORDER BY tr.created_at,tr.id`).all(t.id);
  for(const m of movements)add('movement:'+m.id,m.created_at,m.type==='pick'?'Pick recorded':m.type==='put'?'Put recorded':'Stock corrected',{actor:m.recorder,location:m.location,quantity:m.quantity_delta,unit:m.unit_of_measure,before:m.quantity_before,after:m.quantity_after,product:m.product_name,inventoryMovement:true,details:[m.product_name,m.performer?`Performed by: ${m.performer}`:'Performer not recorded',m.reason].filter(Boolean).join(' · ')});
  if(t.completed_at&&!events.some(e=>e.event_type==='task_completed'))add('completed',t.completed_at,t.outcome==='completed'?'Task completed':'Task closed',{details:'Recorded completion time.'});
  // Stable ordering keeps all events navigable even when their timestamps match.
  const order=new Map(entries.map((e,i)=>[e.id,i]));
  const rank=e=>e.id==='created'?0:/Task (completed|closed)/.test(e.step)?9:e.step==='Location completed'?8:e.id.startsWith('movement:')?7:e.id.startsWith('entry:')?5:3;
  entries.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||rank(a)-rank(b)||order.get(a.id)-order.get(b.id));
  for(const e of entries){const assignment=assignmentAt(t.id,e.time,e.id.startsWith('assignment:')?Number(e.id.slice(11)):null);e.taskId=t.id;e.product||=t.lines[0]?.product_name;e.assignedBy=assignment.assignedBy;e.assignedTo=e.assignee||assignment.assignedTo;}
  const page=pageOf(input,entries.length),offset=(page.number-1)*page.limit;
  return {...identity(),actorId:current.id,task:t,entries:entries.slice(offset,offset+page.limit),page};
 }
 function assignmentAt(taskId,at,eventId=null){
  if(!taskId)return {assignedBy:null,assignedTo:null};
  const before=eventId==null?'e.created_at<=?':'(e.created_at<? OR (e.created_at=? AND e.id<=?))',args=eventId==null?[taskId,at]:[taskId,at,at,eventId];
  const owner=db.prepare(`SELECT u.name FROM task_assignment_events e LEFT JOIN users u ON u.id=e.assignee_id WHERE e.task_id=? AND ${before} ORDER BY e.created_at DESC,e.id DESC LIMIT 1`).get(...args);
  const issuer=db.prepare(`SELECT u.name FROM task_assignment_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.task_id=? AND ${before} AND e.event_type IN ('assigned','reassigned','returned_task_updated','review_assigned','review_task_updated','verified_work_resumed') ORDER BY e.created_at DESC,e.id DESC LIMIT 1`).get(...args);
  return {assignedBy:issuer?.name||null,assignedTo:owner?.name||null};
 }
 function activityHistory(actor,input={}){
  const current=actorNow(actor,'work.view');
  const taskSearch=String(input.taskId??'').trim().replace(/^#\s*/, '');
  if(taskSearch&&!/^\d+$/.test(taskSearch))throw new Error('Enter a valid Task ID.');
  const team=can(current,'work.team'),scope=team?'1':'(t.assignee_id=? OR t.created_by=? OR EXISTS(SELECT 1 FROM task_assignment_events a WHERE a.task_id=t.id AND (a.assignee_id=? OR a.previous_assignee=?)))';
  const args=team?[]:[current.id,current.id,current.id,current.id],candidates=`WITH allowed_tasks AS (SELECT t.id FROM tasks t WHERE ${scope}),
  activity AS (
   SELECT 'movement' source,CAST(tr.id AS TEXT) id,tr.created_at time,tr.task_id taskId FROM transactions tr WHERE tr.task_id IN (SELECT id FROM allowed_tasks) OR (tr.task_id IS NULL AND ${team?'1':'(tr.user_id=? OR tr.performed_by=?)'})
   UNION ALL SELECT 'assignment',CAST(a.id AS TEXT),a.created_at,a.task_id FROM task_assignment_events a WHERE a.task_id IN (SELECT id FROM allowed_tasks)
   UNION ALL SELECT 'event',CAST(e.id AS TEXT),e.created_at,COALESCE(l.task_id,rl.task_id,CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.taskId') END) FROM work_events e LEFT JOIN task_lines l ON l.id=e.line_id LEFT JOIN work_reports r ON r.id=e.report_id LEFT JOIN task_lines rl ON rl.id=r.line_id WHERE COALESCE(l.task_id,rl.task_id,CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.taskId') END) IN (SELECT id FROM allowed_tasks)
   UNION ALL SELECT 'entry',r.id,r.created_at,l.task_id FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id IN (SELECT id FROM allowed_tasks) AND r.origin_ref NOT LIKE 'task-close:%' AND r.origin_ref NOT LIKE 'closure-count:%' AND r.origin_ref NOT LIKE 'attention:%'
   UNION ALL SELECT 'created',CAST(t.id AS TEXT),t.started_at,t.id FROM tasks t WHERE t.id IN (SELECT id FROM allowed_tasks)
  )`;
  if(!team)args.push(current.id,current.id);
  const filter=taskSearch?' WHERE CAST(taskId AS TEXT) LIKE ?':'';
  if(taskSearch)args.push('%'+taskSearch+'%');
  const total=db.prepare(candidates+' SELECT COUNT(*) n FROM activity'+filter).get(...args).n,page=pageOf(input,total),raw=db.prepare(candidates+' SELECT * FROM activity'+filter+' ORDER BY time DESC,source,CAST(id AS INTEGER) DESC,id DESC LIMIT ? OFFSET ?').all(...args,page.limit,(page.number-1)*page.limit);
  const people=new Map(db.prepare('SELECT id,name FROM users').all().map(u=>[u.id,u.name]));
  const entries=raw.map(item=>{
   let row={id:item.source+':'+item.id,time:item.time,taskId:item.taskId,quantity:null,unit:null,location:null,actor:null,product:null,before:null,after:null,inventoryMovement:false};
   if(item.source==='movement'){
    const m=db.prepare(`SELECT tr.*,p.name product,u.name recorder,c.logical_code FROM transactions tr LEFT JOIN products p ON p.id=tr.product_id LEFT JOIN users u ON u.id=tr.user_id LEFT JOIN cells c ON c.id=tr.cell_id WHERE tr.id=?`).get(item.id);
    row={...row,step:m.type==='pick'?'Pick recorded':m.type==='put'?'Put recorded':'Stock corrected',product:m.product,location:m.logical_code,quantity:m.quantity_delta,unit:m.unit_of_measure,actor:m.recorder,before:m.quantity_before,after:m.quantity_after,inventoryMovement:true,details:m.reason||''};
   }else{
    const t=db.prepare(`SELECT p.name product,l.unit_of_measure FROM task_lines l LEFT JOIN products p ON p.id=l.product_id WHERE l.task_id=? ORDER BY l.id LIMIT 1`).get(item.taskId);row.product=t?.product;row.unit=t?.unit_of_measure;
    if(item.source==='assignment'){const a=db.prepare('SELECT a.*,u.name actor,v.name assignee FROM task_assignment_events a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users v ON v.id=a.assignee_id WHERE a.id=?').get(item.id);row.step=labels[a.event_type]||'Assignment updated';row.actor=a.actor;row.assignee=a.assignee;row.details=details(parse(a.payload),people);}
    else if(item.source==='event'){const e=db.prepare('SELECT e.*,u.name actor,c.logical_code location FROM work_events e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN task_lines l ON l.id=e.line_id LEFT JOIN cells c ON c.id=l.cell_id WHERE e.id=?').get(item.id);const v=parse(e.payload),cellId=v.actualCell??v.cellId;row.step=e.event_type==='task_completed'&&v.outcome!=='completed'?'Task closed':labels[e.event_type]||e.event_type.replaceAll('_',' ');row.actor=e.actor;row.location=cellId?db.prepare('SELECT COALESCE(display_name,logical_code) name FROM cells WHERE id=?').get(cellId)?.name:e.location;row.details=details(v,people);}
    else if(item.source==='entry'){const r=db.prepare('SELECT r.*,u.name actor,c.logical_code FROM work_reports r LEFT JOIN users u ON u.id=r.reporter_id LEFT JOIN cells c ON c.id=r.cell_id WHERE r.id=?').get(item.id);row.step='Movement entered';row.actor=r.actor;row.location=r.logical_code;row.quantity=r.quantity_known===0?null:r.quantity;row.unit=r.unit;row.details=[r.direction==='pick'?'Pick reported':'Put reported',parse(r.payload).reason,r.quantity_known===0?'Quantity not confirmed':null].filter(Boolean).join(' · ');}
    else{row.step='Task created';row.actor=db.prepare('SELECT u.name FROM tasks t LEFT JOIN users u ON u.id=t.created_by WHERE t.id=?').get(item.taskId)?.name;}
   }
   const assignment=assignmentAt(item.taskId,item.time,item.source==='assignment'?Number(item.id):null);return {...row,...assignment,assignedTo:row.assignee||assignment.assignedTo};
  });
  return {...identity(),actorId:current.id,entries,page};
 }
 function cellHistory(actor,input={}){
  const current=actorNow(actor,'locations.view'),cell=db.prepare('SELECT id,logical_code,display_name FROM cells WHERE id=?').get(Number(input.cellId));
  if(!cell)throw new Error('Location not found.');
  const team=can(current,'work.team'),where='tr.cell_id=?'+(team?'':' AND (tr.user_id=? OR tr.performed_by=?)'),args=team?[cell.id]:[cell.id,current.id,current.id];
  const total=db.prepare('SELECT COUNT(*) n FROM transactions tr WHERE '+where).get(...args).n,page=pageOf(input,total,50);
  const entries=db.prepare(`SELECT tr.id,tr.created_at time,tr.type,tr.task_id taskId,tr.quantity_delta quantity,tr.unit_of_measure unit,tr.reason,p.name product,u.name recorder,a.name performer FROM transactions tr LEFT JOIN products p ON p.id=tr.product_id LEFT JOIN users u ON u.id=tr.user_id LEFT JOIN users a ON a.id=tr.performed_by WHERE ${where} ORDER BY tr.created_at DESC,tr.id DESC LIMIT ? OFFSET ?`).all(...args,page.limit,(page.number-1)*page.limit);
  return {...identity(),actorId:current.id,cell,scope:team?'team':'own',entries,page};
 }
 return {taskHistory,activityHistory,cellHistory};
}
