import {randomUUID} from 'node:crypto';
import {createOperationsService} from '../../src/modules/operations/service.js';

// Runs only on a checked, staged copy, never on the live database. Durable stock,
// mappings, completed work and replay receipts survive; device leases do not.
export function prepareRecoveredDatabase(db,{createdAt}) {
  const actor=db.prepare("SELECT * FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1").get();
  if(!actor)throw new Error('The backup needs an active administrator before it can be restored.');
  const now=new Date().toISOString(),dataset=randomUUID();
  const stock=JSON.stringify(db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id,product_id').all());
  const tasks=db.prepare("SELECT id FROM tasks WHERE workflow_version=2 AND completed_at IS NULL AND outcome NOT IN ('completed','cancelled')").all();
  const operations=createOperationsService({db});
  try {
    for(const task of tasks) {
      for(const line of db.prepare("SELECT id FROM task_lines WHERE task_id=? AND execution_state IN ('ready','working')").all(task.id)) {
        operations.command(actor,'askReview',{lineId:line.id,requestId:`recovery:${dataset}:${line.id}`,reason:'Pi replaced. Check physical stock and unfinished work against the backup before continuing.'});
      }
      db.prepare("UPDATE tasks SET attention=1,outcome='needs_review',review_followup=1,guidance_paused=1,guidance_session=NULL,assignment_generation=assignment_generation+1 WHERE id=?").run(task.id);
      db.prepare('UPDATE task_lines SET device_id=NULL,revision=revision+1 WHERE task_id=?').run(task.id);
    }
    db.exec(`DELETE FROM cell_turns; DELETE FROM work_guidance; DELETE FROM stocktake_display_claims;
      UPDATE display_requests SET state='ended' WHERE state='active';
      UPDATE location_setup_sessions SET status='closed' WHERE status='active';
      UPDATE stocktake_sessions SET state='paused' WHERE state='active';
      UPDATE stocktake_runs SET display_enabled=0;
      UPDATE stocktake_items SET display_active=0,generation=generation+1,state=CASE WHEN state='counting' THEN 'pending' ELSE state END;
      UPDATE users SET session_version=session_version+1;
      DELETE FROM submission_tokens;`);
    db.prepare("UPDATE stocktake_runs SET paused_at=COALESCE(paused_at,?),revision=revision+1 WHERE status NOT IN ('completed','closed','stopped')").run(now);
    db.prepare("DELETE FROM app_metadata WHERE key='firmware_busy'").run();
    db.prepare("UPDATE app_metadata SET value=?,updated_at=? WHERE key='dataset_generation'").run(dataset,now);
    db.prepare('INSERT INTO work_events(line_id,actor_id,event_type,payload,created_at) VALUES(NULL,?,?,?,?)')
      .run(actor.id,'warehouse_recovered',JSON.stringify({backupCreatedAt:createdAt,unfinishedTaskIds:tasks.map(t=>t.id),dataset}),now);
    if(JSON.stringify(db.prepare('SELECT * FROM inventory_balances ORDER BY cell_id,product_id').all())!==stock)throw new Error('Recovery changed recorded stock; refusing to activate it.');
    return {unfinishedTasks:tasks.length,dataset};
  } finally {operations.dispose();}
}
