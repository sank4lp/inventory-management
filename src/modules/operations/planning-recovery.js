import {createHash,randomUUID} from 'node:crypto';
import {assertCan,can} from '../access/catalog.js';
import {controlledCell} from '../stocktaking/accounting.js';
import {describeLocation} from './location-contract.js';
import {protectedPicks,putRoom} from './planning-policy.js';
import {postMovement} from '../inventory/ledger.js';

export function createPlanningRecovery({db,workQuantity,event}){
 const stamp=()=>new Date().toISOString();
 const product=id=>db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(id));
 const balance=(pid,cid)=>Number(db.prepare('SELECT available_quantity n FROM inventory_balances WHERE product_id=? AND cell_id=?').get(pid,cid)?.n||0);
 function token(p,c){return createHash('sha256').update(JSON.stringify([p.id,p.unit_of_measure,p.items_per_cell,c.id,c.active,c.binding_revision,db.prepare('SELECT version FROM stocktake_cell_versions WHERE cell_id=?').get(c.id)?.version||0,db.prepare("SELECT r.* FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE l.cell_id=? AND r.state='held' ORDER BY l.id").all(c.id)])).digest('hex');}
 function options(actor,input){
  assertCan(actor,input.direction==='put'?'work.put':'work.pick');const p=product(input.productId);if(!p)throw new Error('Choose an active product.');
  const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY logical_code').all().map(c=>{
   const contents=db.prepare('SELECT b.available_quantity quantity,p.name,p.id productId,p.items_per_cell capacity FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE cell_id=? AND available_quantity>0').all(c.id);
   const mixed=contents.some(x=>x.productId!==p.id)||!!db.prepare("SELECT 1 FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE r.state='held' AND r.kind='put' AND l.cell_id=? AND l.product_id!=?").get(c.id,p.id);
   const blocked=controlledCell(db,c.id)||!!db.prepare('SELECT 1 FROM work_discrepancies WHERE cell_id=? AND product_id=?').get(c.id,p.id);
   return {id:c.id,name:c.display_name||c.logical_code,code:c.logical_code,recorded:balance(p.id,c.id),protected:protectedPicks(db,c.id,p.id),space:blocked?0:putRoom(db,c.id,p),mixed,blocked,contents,token:token(p,c)};
  });
  return {productId:p.id,name:p.name,unit:p.unit_of_measure,itemsPerCell:p.items_per_cell,canEditCapacity:can(actor,'products.capacity'),recorded:cells.reduce((n,c)=>n+c.recorded,0),cells};
 }
 function makeRun(actor,p,ids,title,status='pending'){
  const at=stamp(),timezone=db.prepare("SELECT value FROM app_metadata WHERE key='warehouse_timezone'").get()?.value||'Asia/Kolkata';
  const due=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const runId=Number(db.prepare('INSERT INTO stocktake_runs(title,scope_json,due_date,timezone,created_by,created_at,status,closed_at) VALUES(?,?,?,?,?,?,?,?)').run(title,JSON.stringify({mode:'selected',cellIds:ids,productId:p.id,urgent:true}),due,timezone,actor.id,at,status,status==='completed'?at:null).lastInsertRowid);
  for(const id of ids)db.prepare('INSERT INTO stocktake_items(run_id,cell_id,location_json,assignee_id,state) VALUES(?,?,?,?,?)').run(runId,id,JSON.stringify(describeLocation(db,id)),status==='completed'?actor.id:null,status==='completed'?'counted':'pending');
  db.prepare('INSERT INTO stocktake_events(run_id,actor_id,event_type,payload,created_at) VALUES(?,?,?,?,?)').run(runId,actor.id,'created',JSON.stringify({productId:p.id,urgent:true,reason:'Pick exceeded recorded stock'}),at);
  return runId;
 }
 function prepare(actor,input,p){
  if(!input.recovery)return {};
  const r=input.recovery;if(typeof r!=='object'||Array.isArray(r))throw new Error('Choose a recovery option again.');
  if(r.unit!=null&&r.unit!==p.unit_of_measure)throw new Error('The product unit changed. Go back and enter the quantity in the current unit.');
  if(input.direction==='put'){
   if(!['capacity','location','mixed'].includes(r.mode))throw new Error('Choose how to store these items.');
   if(r.mode==='capacity'){
    assertCan(actor,'products.capacity');
    const n=workQuantity(r.itemsPerCell,true);if(r.confirmed!==true||Number(r.previousCapacity)!==p.items_per_cell||n<=p.items_per_cell)throw new Error('Confirm a larger items-per-cell value after checking the space. Reopen this choice if capacity changed.');
    db.prepare('UPDATE products SET items_per_cell=? WHERE id=?').run(n,p.id);event('product_capacity_changed',actor,null,{productId:p.id,previous:p.items_per_cell,itemsPerCell:n,reason:'Capacity checked during put planning'});p.items_per_cell=n;
   }else{
    const cell=db.prepare('SELECT * FROM cells WHERE id=? AND active=1').get(Number(r.cellId));if(!cell)throw new Error('Choose an active location.');
    if(r.mode==='mixed'&&r.confirmed!==true)throw new Error('Confirm these products can be stored together.');
   }
   return {};
  }
  if(r.mode!=='count'||r.confirmed!==true||!Array.isArray(r.counts)||!r.counts.length||r.counts.length>200)throw new Error('Enter and confirm the actual stock in each chosen cell.');
  const total=Number(db.prepare('SELECT COALESCE(SUM(MAX(0,available_quantity)),0) n FROM inventory_balances WHERE product_id=?').get(p.id).n);
  if(Number(input.quantity)<=total)throw new Error('Recorded stock now covers this quantity. Go back and try the pick again without a stock override.');
  const seen=new Set(),rows=r.counts.map(row=>{
   const c=db.prepare('SELECT * FROM cells WHERE id=? AND active=1').get(Number(row.cellId));if(!c||seen.has(c.id))throw new Error('Choose each active cell once.');seen.add(c.id);
   if(row.token!==token(p,c))throw new Error('Stock or reservations changed while counting. Go back and count again.');
   if(controlledCell(db,c.id)||db.prepare('SELECT 1 FROM work_discrepancies WHERE cell_id=? AND product_id=?').get(c.id,p.id))throw new Error(`${c.logical_code}: resolve the existing stock check first.`);
   if(db.prepare('SELECT 1 FROM cell_turns WHERE cell_id=? AND uncertain=0').get(c.id)||db.prepare('SELECT 1 FROM stocktake_display_claims cl JOIN stocktake_items i ON i.id=cl.item_id WHERE i.cell_id=?').get(c.id))throw new Error(`${c.logical_code}: someone is working here. Count after they finish.`);
   const actual=workQuantity(row.quantity),before=balance(p.id,c.id);if(actual<protectedPicks(db,c.id,p.id))throw new Error(`${c.logical_code}: this count cannot cover active picks. Finish those tasks or ask an admin to check them first.`);
   return {c,actual,before};
  });
  const correction=makeRun(actor,p,[...seen],`Stock confirmed before pick · ${p.name}`,'completed');
  for(const {c,actual,before} of rows){
   const at=stamp(),item=db.prepare('SELECT id FROM stocktake_items WHERE run_id=? AND cell_id=?').get(correction,c.id),attempt=randomUUID(),observation=randomUUID();
   const observed={productId:p.id,name:p.name,sku:p.sku,unit:p.unit_of_measure,recorded:before,actual,difference:Math.round((actual-before)*1e6)/1e6,conditionQuantity:0,condition:null};
   const baseline={products:[observed],ledgerId:db.prepare('SELECT COALESCE(MAX(id),0) n FROM transactions').get().n};
   db.prepare('INSERT INTO stocktake_attempts(id,item_id,counter_id,generation,baseline_json,started_at,method,identity_evidence,observation_id) VALUES(?,?,?,1,?,?,?,?,?)').run(attempt,item.id,actor.id,JSON.stringify(baseline),at,'manual',c.logical_code,observation);
   const tx=postMovement(db,{actor,performer:actor.id,productId:p.id,cellId:c.id,quantity:observed.difference,type:'adjustment',origin:'pick-count:'+input.requestId+':'+c.id,reason:'Actual stock confirmed before pick; urgent follow-up stocktake required',unit:p.unit_of_measure,expectedBalance:before});
   db.prepare("INSERT INTO stocktake_observations(id,attempt_id,item_id,counter_id,lines_json,unknown_json,reported_reason,note,counted_at,received_at,status,verification,reviewer_id,reviewed_at) VALUES(?,?,?,?,?,'[]',?,?,?,?, 'approved',?,?,?)").run(observation,attempt,item.id,actor.id,JSON.stringify([observed]),'Stock mismatch','Actual cell count confirmed before pick',at,at,'Operator explicitly confirmed actual stock before pick',actor.id,at);
   db.prepare('INSERT INTO stocktake_settlements(observation_id,transaction_ids,actor_id,created_at) VALUES(?,?,?,?)').run(observation,JSON.stringify(tx?[tx]:[]),actor.id,at);
   db.prepare('UPDATE stocktake_items SET latest_observation=? WHERE id=?').run(observation,item.id);
  }
  const ids=db.prepare('SELECT DISTINCT c.id FROM cells c LEFT JOIN inventory_balances b ON b.cell_id=c.id WHERE c.active=1 AND (b.product_id=? OR c.id IN ('+[...seen].map(()=>'?').join(',')+'))').all(p.id,...seen).map(c=>c.id);
  // A separate follow-up verifies the whole product; the pre-pick count is immutable.
  const urgentRunId=makeRun(actor,p,ids,`Urgent: check ${p.name}`);
  event('pick_stock_confirmed',actor,null,{productId:p.id,counts:rows.map(({c,actual,before})=>({cellId:c.id,actual,before})),correctionRunId:correction,urgentRunId});
  return {urgentRunId};
 }
 return {options,prepare};
}
