import {enableStocktakeProgress} from './workflow.js';

// Each browser owns a short lease. Late heartbeats cannot restart a left session;
// a stale page cannot release a count taken over by another page.
export function createStocktakePresence({db,clock,run,event}) {
 const now=()=>clock().toISOString(),expiry=()=>new Date(clock().getTime()+45000).toISOString();
 const sessionId=input=>{const id=String(input.sessionId||'');if(id.length<8||id.length>160)throw new Error('Reopen this stocktake to start a counting session.');return id;};
 function session(actor,input){const row=db.prepare('SELECT * FROM stocktake_sessions WHERE id=? AND actor_id=? AND run_id=?').get(sessionId(input),actor.id,Number(input.runId));if(!row)throw new Error('This stocktake session belongs to another counter or has ended.');return row;}
 function stopDisplay(runId){db.prepare('UPDATE stocktake_runs SET display_enabled=0 WHERE id=?').run(runId);db.prepare('UPDATE stocktake_items SET display_active=0 WHERE run_id=?').run(runId);}
 function pauseIfEmpty(runId){
  const people=db.prepare("SELECT 1 FROM stocktake_sessions WHERE run_id=? AND state='active' AND expires_at>? LIMIT 1").get(runId,now());
  const claims=db.prepare('SELECT 1 FROM stocktake_display_claims cl JOIN stocktake_items i ON i.id=cl.item_id WHERE i.run_id=? AND i.generation=cl.generation LIMIT 1').get(runId);
  if(people||claims)return false;
  stopDisplay(runId);db.prepare("UPDATE stocktake_runs SET paused_at=? WHERE id=? AND status NOT IN ('closed','completed')").run(now(),runId);return true;
 }
 function release(row){
  if(row.state!=='active')return;
  db.prepare("UPDATE stocktake_sessions SET state='left',expires_at=? WHERE id=?").run(now(),row.id);
  if(row.item_id){
   const claim=db.prepare('SELECT cl.* FROM stocktake_display_claims cl JOIN stocktake_items i ON i.id=cl.item_id WHERE cl.item_id=? AND cl.actor_id=? AND cl.generation=? AND i.generation=cl.generation').get(row.item_id,row.actor_id,row.generation);
   if(claim){db.prepare('DELETE FROM stocktake_display_claims WHERE item_id=?').run(row.item_id);db.prepare("UPDATE stocktake_items SET state='pending',generation=generation+1,display_active=0 WHERE id=? AND state IN ('pending','counting','skipped','recheck')").run(row.item_id);}
  }
  const paused=pauseIfEmpty(row.run_id);event({id:row.actor_id},'counter_left',{paused},row.run_id,row.item_id);return paused;
 }
 function attach(actor,input,item){
  const row=session(actor,{...input,runId:item.run_id});if(row.state!=='active'||row.expires_at<=now())throw new Error('Counting paused. Reopen this stocktake before continuing.');
  db.prepare('UPDATE stocktake_sessions SET item_id=NULL,generation=NULL WHERE actor_id=? AND run_id=?').run(actor.id,item.run_id);
  db.prepare('UPDATE stocktake_sessions SET item_id=?,generation=?,expires_at=? WHERE id=?').run(item.id,item.generation,expiry(),row.id);
 }
 return {
  join(actor,input){
   const current=run(actor,input.runId),id=sessionId(input),old=db.prepare('SELECT * FROM stocktake_sessions WHERE id=?').get(id);
   if(old&&(old.actor_id!==actor.id||old.run_id!==current.id||old.state!=='active'))throw new Error('Start a new counting session for this stocktake.');
   if(['closed','completed'].includes(current.status))return {status:'recorded',active:false};
   const assigned=db.prepare(`SELECT 1 FROM stocktake_items i WHERE i.run_id=? AND i.state IN ('pending','counting','skipped','recheck')
     AND (i.assignee_id=? OR EXISTS(SELECT 1 FROM stocktake_item_counters m WHERE m.item_id=i.id AND m.user_id=?)) LIMIT 1`).get(current.id,actor.id,actor.id);
   if(!assigned)throw new Error('No remaining count locations are assigned to you.');
   db.prepare("INSERT INTO stocktake_sessions(id,run_id,actor_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at").run(id,current.id,actor.id,expiry());
   if(current.paused_at){enableStocktakeProgress(db,current.id,db.prepare("SELECT cell_id FROM stocktake_items WHERE run_id=? AND state!='excluded'").all(current.id).map(i=>i.cell_id));db.prepare('UPDATE stocktake_runs SET paused_at=NULL WHERE id=?').run(current.id);}
   db.prepare("UPDATE stocktake_runs SET started_at=COALESCE(started_at,?),status=CASE WHEN status='pending' THEN 'in_progress' ELSE status END WHERE id=?").run(now(),current.id);
   if(!old||current.paused_at)event(actor,current.paused_at?'resumed':current.started_at?'counter_joined':'started',{},current.id);
   const item=db.prepare('SELECT i.* FROM stocktake_items i JOIN stocktake_display_claims cl ON cl.item_id=i.id WHERE i.run_id=? AND cl.actor_id=? AND i.generation=cl.generation LIMIT 1').get(current.id,actor.id);
   if(item)attach(actor,input,item);return {status:'recorded',active:true};
  },
  heartbeat(actor,input){run(actor,input.runId);const row=session(actor,input);if(row.state!=='active'||row.expires_at<=now())throw new Error('Counting paused. Reopen this stocktake before continuing.');db.prepare('UPDATE stocktake_sessions SET expires_at=? WHERE id=?').run(expiry(),row.id);return {status:'recorded'};},
  leave(actor,input){run(actor,input.runId);const row=session(actor,input);return {status:'recorded',paused:release(row)||false,message:'Progress saved. You can continue later.'};},
  attach,
  expire(){const rows=db.prepare("SELECT * FROM stocktake_sessions WHERE state='active' AND expires_at<=?").all(now());for(const row of rows)release(row);return rows.length;},
  complete(runId){stopDisplay(runId);db.prepare("UPDATE stocktake_sessions SET state='left',item_id=NULL,generation=NULL,expires_at=? WHERE run_id=?").run(now(),runId);db.prepare('UPDATE stocktake_runs SET paused_at=NULL WHERE id=?').run(runId);}
 };
}
