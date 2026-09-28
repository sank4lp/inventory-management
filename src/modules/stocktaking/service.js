import {can,assertCan} from "../access/catalog.js";
import {effectiveUser} from "../access/service.js";
import {createHash,randomUUID} from 'node:crypto';
import {withTransaction} from '../../db.js';
import {workQuantity} from '../operations/service.js';
import {describeLocation,validLocationLabel} from '../operations/location-contract.js';
import {postCountCorrection} from '../../services/inventory-balances.js';
import {controlledCell} from './accounting.js';

const json=JSON.stringify,parse=JSON.parse;
const round=n=>Math.round(n*1e6)/1e6;
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const countCapabilities=u=>({view:can(u,'count.view'),count:can(u,'count.perform'),create:can(u,'count.create'),team:can(u,'count.team'),manage:can(u,'count.manage'),schedule:can(u,'count.schedule'),recount:can(u,'count.recount'),approve:can(u,'count.approve'),condition:can(u,'count.condition')});
export function dateInZone(at,timezone) {return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);}
export function nextCountDate(date,frequency,interval,anchor) {
  const [y,m,d]=date.split('-').map(Number);
  if(frequency==='monthly') {const target=new Date(Date.UTC(y,m,1)),last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();target.setUTCDate(Math.min(anchor,last));return target.toISOString().slice(0,10);}
  return new Date(Date.UTC(y,m-1,d+(frequency==='weekly'?7:interval))).toISOString().slice(0,10);
}
function validDate(value) {if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new Error('Choose a valid date.');return value;}

export function createStocktakingService({db,operationsService,clock=()=>new Date()}) {
  const now=()=>clock().toISOString(),identity=()=>operationsService.identity();
  const event=(actor,type,payload={},run=null,item=null)=>db.prepare('INSERT INTO stocktake_events(run_id,item_id,actor_id,event_type,payload,created_at) VALUES(?,?,?,?,?,?)').run(run,item,actor?.id||null,type,json(payload),now());
  function actorNow(actor,permission='view') {const current=operationsService.actorNow(actor);if(!countCapabilities(current)[permission])throw new Error('This stocktaking action is not permitted.');return current;}
  const eligible=id=>{const u=db.prepare('SELECT * FROM users WHERE id=?').get(Number(id));if(!countCapabilities(effectiveUser(db,u)).count)throw new Error('Choose an active counter.');return u.id;};
  function scope(input) {
    let cells=db.prepare('SELECT id FROM cells WHERE active=1 ORDER BY id').all().map(c=>c.id);
    if(input.mode==='selected') {const selected=[...new Set((input.cellIds||[]).map(Number))];if(!selected.length||selected.some(id=>!cells.includes(id)))throw new Error('Select existing active locations.');cells=selected;}
    else if(input.mode!=='warehouse')throw new Error('Choose whole warehouse or selected locations.');
    if(!cells.length)throw new Error('Add locations before creating a stocktake.');return cells;
  }
  function createRun(actor,input,{schedule=null}={}) {
    const cellIds=schedule&&input.mode==='selected'?parse(schedule.scope_json).cellIds:scope(input),timezone=schedule?.timezone||input.timezone||db.prepare("SELECT value FROM app_metadata WHERE key='warehouse_timezone'").get()?.value||'Asia/Kolkata';
    dateInZone(clock(),timezone);
    const due=input.dueDate?validDate(input.dueDate):null;
    const assignee=input.assigneeId?eligible(input.assigneeId):actor&&!can(actor,'count.manage')?actor.id:null;
    if(actor&&!can(actor,'count.manage')&&assignee!==actor.id)throw new Error('You may create a count only for yourself.');
    const result=db.prepare(`INSERT INTO stocktake_runs(title,scope_json,due_date,timezone,schedule_revision,occurrence,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(String(input.title||'Warehouse stock check').slice(0,160),json({mode:input.mode,cellIds}),due,timezone,schedule?.revision||null,schedule?`${schedule.revision}:${due}`:null,actor?.id||null,now());
    const runId=Number(result.lastInsertRowid);
    for(const id of cellIds)db.prepare('INSERT INTO stocktake_items(run_id,cell_id,location_json,assignee_id) VALUES(?,?,?,?)').run(runId,id,json(describeLocation(db,id)),assignee);
    event(actor,'created',{cellIds,assigneeId:assignee,due},runId);
    return {status:'recorded',runId,message:'Stocktake created. Counting does not reserve or move stock.'};
  }
  function tick() {
    return withTransaction(db,()=>{
      const s=db.prepare('SELECT * FROM stocktake_schedules WHERE id=1 AND enabled=1').get();
      if(!s||s.next_due>dateInZone(clock(),s.timezone))return;
      if(db.prepare("SELECT 1 FROM stocktake_runs WHERE occurrence IS NOT NULL AND status NOT IN ('completed','closed')").get())return;
      const input={...parse(s.scope_json),dueDate:s.next_due,assigneeId:s.assignee_id,title:'Scheduled stocktake'};
      if(s.assignee_id&&!countCapabilities(effectiveUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(s.assignee_id))).count)input.assigneeId=null;
      const created=createRun(null,input,{schedule:s});
      let next=nextCountDate(s.next_due,s.frequency,s.interval_days,s.anchor_day);while(next<=dateInZone(clock(),s.timezone))next=nextCountDate(next,s.frequency,s.interval_days,s.anchor_day);
      db.prepare('UPDATE stocktake_schedules SET next_due=? WHERE id=1').run(next);
      return created;
    });
  }
  function run(actor,id) {
    const r=db.prepare('SELECT * FROM stocktake_runs WHERE id=?').get(Number(id));if(!r)throw new Error('Stocktake not found.');
    const visible=can(actor,'count.team')||r.created_by===actor.id||db.prepare(`SELECT 1 FROM stocktake_items i WHERE run_id=? AND (assignee_id=? OR EXISTS(SELECT 1 FROM stocktake_attempts a WHERE a.item_id=i.id AND a.counter_id=?))`).get(r.id,actor.id,actor.id);
    if(!visible)throw new Error('This stocktake belongs to another counter.');return r;
  }
  function item(actor,input,{manage=false}={}) {
    const i=db.prepare('SELECT * FROM stocktake_items WHERE id=?').get(Number(input.itemId));if(!i)throw new Error('Count location not found.');const r=run(actor,i.run_id);
    if(manage)actorNow(actor,'manage');else if(i.assignee_id!==actor.id)throw new Error('This location is assigned to another counter or needs assignment.');
    if(Number(input.generation)!==i.generation)throw new Error('The count assignment changed. Refresh before continuing.');
    if(['completed','closed'].includes(r.status))throw new Error('This stocktake is closed. Open a new count.');return i;
  }
  function baseline(cellId) {
    const cell=db.prepare('SELECT * FROM cells WHERE id=?').get(cellId);
    const products=db.prepare(`SELECT b.product_id AS productId,b.available_quantity AS recorded,p.unit_of_measure AS unit,p.name,p.sku
      FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.cell_id=? ORDER BY b.product_id`).all(cellId);
    const pending=db.prepare(`SELECT l.id,l.revision,l.execution_state,r.kind,r.quantity,r.state FROM task_lines l JOIN work_reservations r ON r.line_id=l.id WHERE l.cell_id=? AND r.state='held' ORDER BY l.id`).all(cellId);
    const reports=db.prepare("SELECT id,status FROM work_reports WHERE cell_id=? AND status IN ('received','review') ORDER BY id").all(cellId);
    return {cellId,active:cell?.active,labelId:cell?.label_id,labelRevision:cell?.label_revision,version:db.prepare('SELECT version FROM stocktake_cell_versions WHERE cell_id=?').get(cellId)?.version||0,
      ledgerId:db.prepare('SELECT COALESCE(MAX(id),0) id FROM transactions WHERE cell_id=?').get(cellId).id,products,pending,reports};
  }
  function stable(before,cellId) {
    const current=baseline(cellId);
    // Any outstanding physical instruction can carry late evidence. Observations
    // remain useful, but corrections require a fresh quiet boundary.
    return before.active===1&&current.active===1&&!before.pending.length&&!before.reports.length&&!current.pending.length&&!current.reports.length&&canonical(before)===canonical(current);
  }
  function refreshRun(id) {
    const r=db.prepare('SELECT * FROM stocktake_runs WHERE id=?').get(id);if(r.status==='closed')return;
    const items=db.prepare('SELECT * FROM stocktake_items WHERE run_id=?').all(id);
    const unresolved=db.prepare(`SELECT 1 FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id WHERE i.run_id=? AND o.status IN ('review','recheck','unverified') LIMIT 1`).get(id);
    const completed=items.length&&items.every(i=>i.state==='counted')&&!unresolved;
    const status=completed?'completed':items.every(i=>['counted','review'].includes(i.state))?'review':r.started_at?'in_progress':'pending';
    db.prepare('UPDATE stocktake_runs SET status=?,closed_at=? WHERE id=?').run(status,completed?now():null,id);
  }
  const actions={
    create:(a,i)=>createRun(a,i),
    schedule(a,i) {
      actorNow(a,'schedule');const old=db.prepare('SELECT * FROM stocktake_schedules WHERE id=1').get();
      if(Number(i.revision||0)!==(old?.revision||0))throw new Error('The schedule changed. Refresh it.');
      const cells=scope(i),frequency=i.frequency,interval=Number(i.intervalDays||30);if(!['weekly','monthly','custom'].includes(frequency)||!Number.isInteger(interval)||interval<1||interval>3650)throw new Error('Choose a valid cadence.');
      const due=validDate(i.nextDue),timezone=i.timezone||'Asia/Kolkata';dateInZone(clock(),timezone);
      const assigned=i.assigneeId?eligible(i.assigneeId):null,anchor=Number(due.slice(-2)),revision=(old?.revision||0)+1;
      db.prepare(`INSERT INTO stocktake_schedules VALUES(1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,frequency=excluded.frequency,interval_days=excluded.interval_days,anchor_day=excluded.anchor_day,next_due=excluded.next_due,timezone=excluded.timezone,scope_json=excluded.scope_json,assignee_id=excluded.assignee_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(revision,i.enabled===false?0:1,frequency,interval,anchor,due,timezone,json({mode:i.mode,cellIds:cells}),assigned,a.id,now());
      event(a,'schedule_changed',{...i,revision});return {status:'recorded',message:'Schedule saved. Existing runs and deadlines are unchanged.'};
    },
    assign(a,i) {actorNow(a,'manage');const items=(i.items||[]).map(v=>item(a,v,{manage:true}));if(!items.length||new Set(items.map(v=>v.id)).size!==items.length)throw new Error('Select distinct locations.');const assignee=eligible(i.assigneeId);
      for(const row of items){if(['counted','review','excluded'].includes(row.state))throw new Error('Assign only remaining count locations.');db.prepare("UPDATE stocktake_items SET assignee_id=?,generation=generation+1,state='pending' WHERE id=?").run(assignee,row.id);event(a,'assigned',{previous:row.assignee_id,assignee},row.run_id,row.id);}return {status:'recorded',message:'Remaining locations assigned; previous observations are retained.'};},
    start(a,i){const r=run(a,i.runId);if(['closed','completed'].includes(r.status))throw new Error('This stocktake is closed.');if(!db.prepare('SELECT 1 FROM stocktake_items WHERE run_id=? AND assignee_id=?').get(r.id,a.id))throw new Error('Assign count locations before starting.');db.prepare("UPDATE stocktake_runs SET started_at=COALESCE(started_at,?),status='in_progress' WHERE id=?").run(now(),r.id);event(a,'started',{},r.id);return {status:'recorded',message:'Count started. Choose a location to check.'};},
    decline(a,i){const r=run(a,i.runId);if(['closed','completed'].includes(r.status))throw new Error('This stocktake is closed.');const rows=db.prepare("SELECT * FROM stocktake_items WHERE run_id=? AND assignee_id=? AND state IN ('pending','counting','skipped','recheck')").all(Number(i.runId),a.id);if(!rows.length)throw new Error('No remaining count assignments to return.');for(const row of rows){db.prepare("UPDATE stocktake_items SET assignee_id=NULL,generation=generation+1,state='pending',note=? WHERE id=?").run(String(i.note||''),row.id);event(a,'returned',{previous:a.id,note:i.note||'',reason:i.reason||''},row.run_id,row.id);}return {status:'recorded',message:'Remaining count work returned for assignment. Saved observations remain in history.'};},
    begin(a,i){const row=item(a,i);if(!['pending','counting','skipped','recheck'].includes(row.state))throw new Error('This location already has a submitted count.');const c=db.prepare('SELECT *,id AS cell_id FROM cells WHERE id=? AND active=1').get(row.cell_id);if(!c)throw new Error('This location changed. Ask an administrator to review the scope.');
      if(i.method==='qr'){if(!validLocationLabel(db,identity().site,c,i.label))throw new Error('Wrong, unknown or revoked location QR.');}else if(i.method!=='manual'||![c.logical_code,c.display_name].filter(Boolean).includes(String(i.location||'').trim()))throw new Error('Identify this location by its exact name or code.');
      const existing=db.prepare('SELECT * FROM stocktake_attempts WHERE item_id=? AND counter_id=? AND generation=? AND observation_id IS NULL ORDER BY started_at DESC LIMIT 1').get(row.id,a.id,row.generation);
      const id=existing?.id||randomUUID();if(!existing)db.prepare('INSERT INTO stocktake_attempts(id,item_id,counter_id,generation,baseline_json,started_at,method,identity_evidence) VALUES(?,?,?,?,?,?,?,?)').run(id,row.id,a.id,row.generation,json(baseline(row.cell_id)),now(),i.method,i.label||i.location);
      db.prepare("UPDATE stocktake_items SET state='counting' WHERE id=?").run(row.id);db.prepare("UPDATE stocktake_runs SET started_at=COALESCE(started_at,?),status='in_progress' WHERE id=?").run(now(),row.run_id);
      return {status:'recorded',attemptId:id,message:'Location identified. Enter every actual count; blank does not mean zero.'};},
    observe(a,i){const attempt=db.prepare('SELECT * FROM stocktake_attempts WHERE id=?').get(i.attemptId);if(!attempt||attempt.counter_id!==a.id)throw new Error('Count attempt not found for this account.');
      const row=db.prepare('SELECT * FROM stocktake_items WHERE id=?').get(attempt.item_id),r=run(a,row.run_id),before=parse(attempt.baseline_json);
      const incoming=Array.isArray(i.lines)?i.lines:[],seen=new Set();
      const lines=incoming.map(l=>{const id=Number(l.productId);if(seen.has(id))throw new Error('Count each product once.');seen.add(id);const p=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!p)throw new Error('Choose an existing product, or record unidentified goods.');const b=before.products.find(p=>p.productId===id);const actual=workQuantity(l.actual),condition=workQuantity(l.conditionQuantity??0);if(condition>actual)throw new Error('Affected condition quantity cannot exceed the physical total.');if(condition&&!['expired','damaged','other'].includes(l.condition))throw new Error('Describe the affected condition.');return {productId:id,name:p.name,sku:p.sku,unit:l.unit||b?.unit||p.unit_of_measure,recorded:b?.recorded||0,actual,difference:round(actual-(b?.recorded||0)),conditionQuantity:condition,condition:l.condition||null};});
      if(before.products.some(p=>!seen.has(p.productId)))throw new Error('Enter actuals for every recorded product, including zero.');
      if(!lines.length&&i.emptyConfirmed!==true)throw new Error('Explicitly confirm that this location is empty.');
      const unknown=(i.unknown||[]).map(v=>String(v).trim()).filter(Boolean);if(unknown.some(v=>v.length>1000))throw new Error('Keep unidentified-item descriptions under 1000 characters.');
      if(attempt.observation_id){const old=db.prepare('SELECT * FROM stocktake_observations WHERE id=?').get(attempt.observation_id),compare=list=>list.map(({productId,unit,actual,conditionQuantity,condition})=>({productId,unit,actual,conditionQuantity,condition}));if(canonical(compare(parse(old.lines_json)))!==canonical(compare(lines))||canonical(parse(old.unknown_json))!==canonical(unknown)||String(old.note||'')!==String(i.note||''))throw new Error('A different count was already received for this attempt. Your new evidence remains on this device; request a fresh recount.');return {status:'recorded',observationId:old.id,message:'This count was already received.'};}
      const id=randomUUID(),safe=can(a,'count.perform')&&stable(before,row.cell_id)&&row.generation===attempt.generation&&row.assignee_id===a.id&&!['closed','completed'].includes(r.status)&&(!i.dataset||i.dataset===identity().dataset)&&lines.every(l=>db.prepare('SELECT unit_of_measure FROM products WHERE id=?').get(l.productId).unit_of_measure===l.unit);
      const condition=lines.some(l=>l.conditionQuantity>0)||unknown.length;const status=!safe?'recheck':condition||lines.some(l=>l.difference!==0)?'review':'matched';
      let countedAt=i.countedAt||null;if(countedAt&&(!Number.isFinite(Date.parse(countedAt))||Date.parse(countedAt)>clock().getTime()+60000))throw new Error('Choose a valid actual counting time or leave it unknown.');
      db.prepare(`INSERT INTO stocktake_observations(id,attempt_id,item_id,counter_id,lines_json,unknown_json,reported_reason,note,counted_at,received_at,status,supersedes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,attempt.id,row.id,a.id,json(lines),json(unknown),i.reason||null,i.note||null,countedAt,now(),status,row.latest_observation);
      db.prepare('UPDATE stocktake_attempts SET observation_id=? WHERE id=?').run(id,attempt.id);
      if(row.generation===attempt.generation&&!['closed','completed'].includes(r.status))db.prepare('UPDATE stocktake_items SET latest_observation=?,state=? WHERE id=?').run(id,status==='matched'?'counted':status==='recheck'?'recheck':'review',row.id);
      if(condition)db.prepare('INSERT INTO stocktake_condition_reviews(observation_id,cell_id,details) VALUES(?,?,?)').run(id,row.cell_id,json({lines:lines.filter(l=>l.conditionQuantity),unknown}));
      event(a,'observed',{observationId:id,status},row.run_id,row.id);refreshRun(row.run_id);return {status,observationId:id,message:status==='matched'?'Count saved — matches. No stock movement.':status==='recheck'?'Observation saved — needs a fresh stable count.':'Difference sent for review. Physical stock has not changed.'};},
    skip(a,i){const row=item(a,i);if(!String(i.reason||'').trim())throw new Error('Give a reason for skipping.');db.prepare("UPDATE stocktake_items SET state='skipped',generation=generation+1,note=? WHERE id=?").run(i.reason,row.id);event(a,'skipped',{reason:i.reason},row.run_id,row.id);return {status:'recorded',message:'Skipped, not counted. Return to this location later.'};},
    review(a,i){actorNow(a,i.action==='recount'?'recount':'approve');const o=db.prepare('SELECT * FROM stocktake_observations WHERE id=?').get(i.observationId);if(!o)throw new Error('Count observation not found.');const row=db.prepare('SELECT * FROM stocktake_items WHERE id=?').get(o.item_id);run(a,row.run_id);
      if(['approved','matched','linked','recounted'].includes(o.status))return {status:'recorded',message:'This observation already has a final resolution. No stock was posted again.'};
      if(o.revision!==Number(i.revision))throw new Error('Another reviewer changed this count. Refresh.');
      const evidence=String(i.evidence||'').trim();if(!evidence)throw new Error('Record how this was verified, or why it remains unverified.');
      if(i.action==='recount'){db.prepare("UPDATE stocktake_items SET state='recheck',generation=generation+1 WHERE id=?").run(row.id);db.prepare("UPDATE stocktake_observations SET status='recounted',verification=?,reviewer_id=?,reviewed_at=?,revision=revision+1 WHERE id=?").run(evidence,a.id,now(),o.id);event(a,'recount_requested',{observationId:o.id,evidence},row.run_id,row.id);refreshRun(row.run_id);return {status:'recorded',message:'Recount requested. The original observation is preserved.'};}
      if(i.action==='unverified'){db.prepare("UPDATE stocktake_observations SET status='unverified',verification=?,revision=revision+1 WHERE id=?").run(evidence,o.id);return {status:'review',message:'Kept for review without assuming a quantity or cause.'};}
      const before=parse(db.prepare('SELECT baseline_json FROM stocktake_attempts WHERE id=?').get(o.attempt_id).baseline_json),lines=parse(o.lines_json);
      if(i.action==='link') {
        const ids=[...new Set((i.transactionIds||[]).map(Number))],transactions=ids.map(id=>db.prepare('SELECT * FROM transactions WHERE id=?').get(id));
        if(!ids.length||transactions.some(t=>!t||t.cell_id!==row.cell_id||t.id<=before.ledgerId||t.origin_ref?.startsWith('stocktake:')))throw new Error('Select posted intervening movements for this same location.');
        for(const l of lines){const matches=transactions.filter(t=>t.product_id===l.productId);if(matches.some(t=>t.unit_of_measure!==l.unit)||round(matches.reduce((n,t)=>n+t.quantity_delta,0))!==l.difference)throw new Error('Selected movements do not exactly account for every count difference. Request a recount.');}
        if(transactions.some(t=>!lines.some(l=>l.productId===t.product_id)))throw new Error('Movement product is unrelated to this count.');
        const current=baseline(row.cell_id);if(current.pending.length||current.reports.length||lines.some(l=>(current.products.find(p=>p.productId===l.productId)?.recorded??0)!==l.actual)||controlledCell(db,row.cell_id))throw new Error('Current stock or unresolved work still needs a fresh count.');
        db.prepare("UPDATE stocktake_observations SET status='linked',linked_movements=?,verification=?,reviewer_id=?,reviewed_at=?,revision=revision+1 WHERE id=?").run(json(ids),evidence,a.id,now(),o.id);
      } else if(i.action==='approve') {
        if(!String(i.reason||'').trim())throw new Error('Choose a verified reason, including Unknown when appropriate.');
        if(!stable(before,row.cell_id)||o.status==='recheck'||controlledCell(db,row.cell_id)||lines.some(l=>db.prepare('SELECT unit_of_measure FROM products WHERE id=?').get(l.productId).unit_of_measure!==l.unit))throw new Error('Stock, units, instructions or condition review changed. Request a fresh count after resolving outstanding work.');
        const ids=postCountCorrection(db,{actor:a,cellId:row.cell_id,lines,observationId:o.id,reason:`Stocktake #${row.run_id}: ${i.reason}. ${evidence}`});
        db.prepare('INSERT INTO stocktake_settlements VALUES(?,?,?,?)').run(o.id,json(ids),a.id,now());
        db.prepare("UPDATE stocktake_observations SET status='approved',verified_reason=?,verification=?,reviewer_id=?,reviewed_at=?,revision=revision+1 WHERE id=?").run(i.reason,evidence,a.id,now(),o.id);
      }else throw new Error('Choose a review action.');
      if(row.latest_observation===o.id)db.prepare("UPDATE stocktake_items SET state='counted' WHERE id=?").run(row.id);
      event(a,'reviewed',{observationId:o.id,action:i.action,evidence,reason:i.reason},row.run_id,row.id);refreshRun(row.run_id);return {status:'recorded',message:i.action==='link'?'Existing movements linked. No second stock change.':'Verified correction recorded once in Adjustment Audit.'};},
    condition(a,i){actorNow(a,'condition');const c=db.prepare("SELECT * FROM stocktake_condition_reviews WHERE id=? AND state='open'").get(Number(i.conditionId));if(!c)throw new Error('Condition review is already closed or missing.');if(!String(i.evidence||'').trim()||i.confirmed!==true)throw new Error('Verify the disposition or usability and explain the evidence.');if(baseline(c.cell_id).pending.length||baseline(c.cell_id).reports.length)throw new Error('Resolve already-issued work and pending movement evidence first.');db.prepare("UPDATE stocktake_condition_reviews SET state='resolved',resolved_by=?,resolved_at=?,evidence=? WHERE id=?").run(a.id,now(),i.evidence,c.id);db.prepare("UPDATE stocktake_observations SET status='recheck',revision=revision+1 WHERE id=? AND status NOT IN ('approved','linked','matched')").run(c.observation_id);db.prepare("UPDATE stocktake_items SET state='recheck',generation=generation+1 WHERE latest_observation=?").run(c.observation_id);event(a,'condition_resolved',{conditionId:c.id,evidence:i.evidence});return {status:'recorded',message:'Controlled review released. No goods were subtracted. Request a fresh count; physical removal must have its own verified movement.'};},
    close(a,i){actorNow(a,'manage');const r=run(a,i.runId);if(r.revision!==Number(i.revision))throw new Error('Run changed. Refresh.');if(!String(i.reason||'').trim())throw new Error('Explain why coverage is incomplete.');db.prepare("UPDATE stocktake_runs SET status='closed',closed_at=?,close_reason=?,revision=revision+1 WHERE id=?").run(now(),i.reason,r.id);event(a,'closed_incomplete',{reason:i.reason},r.id);return {status:'recorded',message:'Closed with incomplete coverage. Observations, corrections and pending reviews remain.'};},
    deadline(a,i){actorNow(a,'manage');const r=run(a,i.runId);if(r.revision!==Number(i.revision)||!String(i.reason||'').trim())throw new Error('Refresh this run and supply a reason for the deadline change.');db.prepare('UPDATE stocktake_runs SET due_date=?,revision=revision+1 WHERE id=?').run(validDate(i.dueDate),r.id);event(a,'deadline_changed',{previous:r.due_date,next:i.dueDate,reason:i.reason},r.id);return {status:'recorded',message:'Count deadline updated and audited.'};},
    scope(a,i){actorNow(a,'manage');const r=run(a,i.runId);if(!String(i.reason||'').trim())throw new Error('Explain this scope change.');if(i.addCellId){const id=scope({mode:'selected',cellIds:[i.addCellId]})[0];db.prepare('INSERT INTO stocktake_items(run_id,cell_id,location_json) VALUES(?,?,?)').run(r.id,id,json(describeLocation(db,id)));}else {const row=item(a,i,{manage:true});if(row.latest_observation)throw new Error('Preserve the counted location and its reviews; close incomplete coverage explicitly if needed.');db.prepare("UPDATE stocktake_items SET state='excluded',note=?,generation=generation+1 WHERE id=?").run(i.reason,row.id);}event(a,'scope_changed',i,r.id);return {status:'recorded',message:'Scope change recorded. Excluded locations are not counted as checked.'};}
  };
  function command(actor,action,input) {
    if(!actions[action])throw new Error('Unknown stocktaking action.');
    const result=withTransaction(db,()=>{
      const a=operationsService.actorNow(actor);if(input.actorId!=null&&Number(input.actorId)!==a.id)throw new Error('This saved count belongs to another account.');if(input.site&&input.site!==identity().site)throw new Error('This count belongs to another warehouse.');
      const id=String(input.requestId||'');if(id.length<8||id.length>160)throw new Error('A stable request identity is required.');const fingerprint=createHash('sha256').update(canonical({action,input})).digest('hex');
      const receipt=db.prepare('SELECT * FROM stocktake_receipts WHERE actor_id=? AND request_id=?').get(a.id,id);if(receipt){if(receipt.fingerprint!==fingerprint)throw new Error('This request was already received with different contents.');return {...parse(receipt.result_json),replayed:true};}
      if(input.dataset&&input.dataset!==identity().dataset&&action!=='observe')throw new Error('The warehouse dataset changed. Refresh.');
      const permissions={create:can(a,'count.manage')?'count.manage':'count.create',schedule:'count.schedule',assign:'count.manage',start:'count.perform',decline:'count.perform',begin:'count.perform',observe:'count.perform',skip:'count.perform',review:input.action==='recount'?'count.recount':'count.approve',condition:'count.condition',close:'count.manage',deadline:'count.manage',scope:'count.manage'};
      if(action!=='observe')assertCan(a,permissions[action]);
      const value=actions[action](a,input);db.prepare('INSERT INTO stocktake_receipts VALUES(?,?,?,?,?)').run(a.id,id,fingerprint,json(value),now());return value;
    });return result;
  }
  function snapshot(actor) {
    const a=operationsService.actorNow(actor);
    if(!can(a,'count.view'))return {...identity(),user:a,capabilities:countCapabilities(a),generatedAt:now(),schedule:null,runs:[],badge:0,cells:[],products:[],counters:[],conditions:[],events:[]};
    tick();
    const runs=db.prepare('SELECT * FROM stocktake_runs ORDER BY id DESC').all().filter(r=>{try{run(a,r.id);return true;}catch{return false;}}).map(r=>{
      const items=db.prepare(`SELECT i.*,c.active,c.logical_code,c.display_name,u.name AS counter_name FROM stocktake_items i JOIN cells c ON c.id=i.cell_id LEFT JOIN users u ON u.id=i.assignee_id WHERE i.run_id=?`).all(r.id).filter(i=>can(a,'count.team')||i.assignee_id===a.id||db.prepare('SELECT 1 FROM stocktake_attempts WHERE item_id=? AND counter_id=?').get(i.id,a.id));
      const ids=new Set(items.map(i=>i.id));const observations=db.prepare(`SELECT o.*,u.name AS counter_name,v.name AS reviewer_name,a.baseline_json,a.method,a.started_at FROM stocktake_observations o JOIN stocktake_attempts a ON a.id=o.attempt_id JOIN users u ON u.id=o.counter_id LEFT JOIN users v ON v.id=o.reviewer_id JOIN stocktake_items i ON i.id=o.item_id WHERE i.run_id=? ORDER BY o.received_at`).all(r.id).filter(o=>ids.has(o.item_id)&&(can(a,'count.team')||o.counter_id===a.id));
      const pending=items.filter(i=>i.assignee_id===a.id&&['pending','counting','skipped','recheck'].includes(i.state)).length;
      const reviews=observations.filter(o=>['review','recheck','unverified'].includes(o.status)).length;
      return {...r,items:items.map(i=>({...i,description:describeLocation(db,i.cell_id),originalDescription:parse(i.location_json),controlled:controlledCell(db,i.cell_id)})),observations:observations.map(o=>({...o,lines:parse(o.lines_json),unknown:parse(o.unknown_json),baseline:parse(o.baseline_json),linkedMovements:parse(o.linked_movements),correctionTransactions:parse(db.prepare('SELECT transaction_ids FROM stocktake_settlements WHERE observation_id=?').get(o.id)?.transaction_ids||'[]')})),
        attempts:db.prepare('SELECT a.* FROM stocktake_attempts a JOIN stocktake_items i ON i.id=a.item_id WHERE i.run_id=? AND a.counter_id=? AND a.observation_id IS NULL').all(r.id,a.id).map(v=>({...v,baseline:parse(v.baseline_json)})),
        overdue:Boolean(r.due_date&&r.due_date<dateInZone(clock(),r.timezone)&&!['completed','closed'].includes(r.status)),actionable:(can(a,'count.manage')&&!['completed','closed'].includes(r.status))||((can(a,'count.approve')||can(a,'count.recount'))&&reviews>0)||(can(a,'count.perform')&&pending>0&&!['completed','closed'].includes(r.status)),pending,reviews,
        scopeChanges:can(a,'count.team')?db.prepare('SELECT id,logical_code,display_name FROM cells WHERE active=1 AND id NOT IN (SELECT cell_id FROM stocktake_items WHERE run_id=?)').all(r.id):[]};
    });
    return {...identity(),user:a,capabilities:countCapabilities(a),generatedAt:now(),warehouseTimezone:db.prepare("SELECT value FROM app_metadata WHERE key='warehouse_timezone'").get()?.value||'Asia/Kolkata',schedule:db.prepare('SELECT * FROM stocktake_schedules WHERE id=1').get()||null,runs,badge:runs.filter(r=>r.actionable).length,
      cells:db.prepare('SELECT id,logical_code,display_name FROM cells WHERE active=1 ORDER BY logical_code').all().map(c=>({...c,description:describeLocation(db,c.id)})),products:db.prepare('SELECT id,name,sku,unit_of_measure FROM products WHERE active=1 ORDER BY name').all(),
      counters:can(a,'count.team')?db.prepare("SELECT * FROM users WHERE status='active' ORDER BY name").all().filter(u=>can(effectiveUser(db,u),"count.perform")).map(u=>({id:u.id,name:u.name})):[],
      conditions:can(a,'count.team')?db.prepare("SELECT c.*,i.run_id FROM stocktake_condition_reviews c JOIN stocktake_observations o ON o.id=c.observation_id JOIN stocktake_items i ON i.id=o.item_id WHERE c.state='open'").all():[],
      events:can(a,'count.team')?db.prepare('SELECT * FROM stocktake_events ORDER BY id DESC LIMIT 500').all():[]};
  }
  function movements(actor,observationId,q='') {actorNow(actor,'team');const row=db.prepare('SELECT i.cell_id,a.baseline_json FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id JOIN stocktake_attempts a ON a.id=o.attempt_id WHERE o.id=?').get(observationId);if(!row)throw new Error('Count not found.');return db.prepare(`SELECT tr.*,p.name FROM transactions tr JOIN products p ON p.id=tr.product_id WHERE tr.cell_id=? AND tr.id>? AND (tr.reason LIKE ? OR p.name LIKE ? OR tr.created_at LIKE ?) ORDER BY tr.id DESC LIMIT 100`).all(row.cell_id,parse(row.baseline_json).ledgerId,...Array(3).fill('%'+String(q).slice(0,160)+'%'));}
  return {command,snapshot,tick,baseline,movements};
}
