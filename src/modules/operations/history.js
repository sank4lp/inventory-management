import {can} from '../access/catalog.js';

const parse=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const labels={
 reopened:'Remaining work reopened',reopened_from:'Reopened from earlier task',assigned:'Assigned',started:'Work started',resumed:'Work resumed',reassigned:'Reassigned',returned:'Work returned',
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
  for(const m of movements)add('movement:'+m.id,m.created_at,m.type==='pick'?'Pick recorded':m.type==='put'?'Put recorded':'Stock corrected',{actor:m.recorder,location:m.location,quantity:m.quantity_delta,unit:m.unit_of_measure,details:[m.product_name,m.performer?`Performed by: ${m.performer}`:'Performer not recorded',m.reason].filter(Boolean).join(' · ')});
  if(t.completed_at&&!events.some(e=>e.event_type==='task_completed'))add('completed',t.completed_at,t.outcome==='completed'?'Task completed':'Task closed',{details:'Recorded completion time.'});
  // Stable ordering keeps all events navigable even when their timestamps match.
  const order=new Map(entries.map((e,i)=>[e.id,i]));
  const rank=e=>e.id==='created'?0:/Task (completed|closed)/.test(e.step)?9:e.step==='Location completed'?8:e.id.startsWith('movement:')?7:e.id.startsWith('entry:')?5:3;
  entries.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||rank(a)-rank(b)||order.get(a.id)-order.get(b.id));
  const page=pageOf(input,entries.length),offset=(page.number-1)*page.limit;
  return {...identity(),actorId:current.id,task:t,entries:entries.slice(offset,offset+page.limit),page};
 }
 function cellHistory(actor,input={}){
  const current=actorNow(actor,'locations.view'),cell=db.prepare('SELECT id,logical_code,display_name FROM cells WHERE id=?').get(Number(input.cellId));
  if(!cell)throw new Error('Location not found.');
  const team=can(current,'work.team'),where='tr.cell_id=?'+(team?'':' AND (tr.user_id=? OR tr.performed_by=?)'),args=team?[cell.id]:[cell.id,current.id,current.id];
  const total=db.prepare('SELECT COUNT(*) n FROM transactions tr WHERE '+where).get(...args).n,page=pageOf(input,total,50);
  const entries=db.prepare(`SELECT tr.id,tr.created_at time,tr.type,tr.task_id taskId,tr.quantity_delta quantity,tr.unit_of_measure unit,tr.reason,p.name product,u.name recorder,a.name performer FROM transactions tr LEFT JOIN products p ON p.id=tr.product_id LEFT JOIN users u ON u.id=tr.user_id LEFT JOIN users a ON a.id=tr.performed_by WHERE ${where} ORDER BY tr.created_at DESC,tr.id DESC LIMIT ? OFFSET ?`).all(...args,page.limit,(page.number-1)*page.limit);
  return {...identity(),actorId:current.id,cell,scope:team?'team':'own',entries,page};
 }
 return {taskHistory,cellHistory};
}
