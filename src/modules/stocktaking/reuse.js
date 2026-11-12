import {guidanceBinding} from '../operations/guidance.js';
import {randomUUID} from 'node:crypto';

// Keep the original counter and observation even when several runs share a count.
export function countProvenance(db,item){
  const reused=db.prepare(`SELECT e.product_id,p.name AS product_name,o.id AS observation_id,
    o.counter_id,u.name AS counter_name,o.counted_at,o.received_at,i.run_id
    FROM stocktake_reused_counts e JOIN stocktake_observations o ON o.id=e.observation_id
    JOIN stocktake_items i ON i.id=o.item_id JOIN users u ON u.id=o.counter_id
    LEFT JOIN products p ON p.id=e.product_id WHERE e.item_id=? ORDER BY e.product_id`).all(item.id);
  if(reused.length)return reused.map(r=>({...r,kind:'reused'}));
  if(!item.latest_observation)return [];
  const direct=db.prepare(`SELECT o.id AS observation_id,o.counter_id,u.name AS counter_name,
    o.counted_at,o.received_at,i.run_id FROM stocktake_observations o
    JOIN stocktake_items i ON i.id=o.item_id JOIN users u ON u.id=o.counter_id WHERE o.id=?`).get(item.latest_observation);
  return direct?[{...direct,kind:'direct'}]:[];
}

export function reuseStocktakeCount({db,observationId,now,refreshRun}){
  const source=db.prepare(`SELECT o.*,i.cell_id,i.run_id,a.baseline_json,a.started_at,a.method
    FROM stocktake_observations o JOIN stocktake_items i ON i.id=o.item_id
    JOIN stocktake_attempts a ON a.id=o.attempt_id WHERE o.id=?`).get(observationId);
  if(!source||source.method==='reuse'||!['matched','approved'].includes(source.status)||JSON.parse(source.unknown_json).length)return;
  const before=JSON.parse(source.baseline_json),lines=JSON.parse(source.lines_json);
  const whole=!before.productScope&&!before.productScopes;
  const ledgerId=db.prepare('SELECT COALESCE(MAX(id),0) id FROM transactions WHERE cell_id=?').get(source.cell_id).id;
  const targets=db.prepare(`SELECT i.*,r.created_at,r.scope_json FROM stocktake_items i JOIN stocktake_runs r ON r.id=i.run_id
    WHERE i.cell_id=? AND i.run_id!=? AND i.state IN ('pending','skipped')
    AND r.status NOT IN ('completed','closed','stopped') AND r.created_at<=?`).all(source.cell_id,source.run_id,source.started_at);
  for(const item of targets){
    // Backdated/offline evidence predating the requested check must not fulfil it.
    if(source.counted_at&&source.counted_at<item.created_at)continue;
    const legacyProduct=JSON.parse(item.scope_json).productId;
    const wholeBin=!!item.whole_bin&&!legacyProduct;
    let required=item.required_products_json?JSON.parse(item.required_products_json):legacyProduct?[legacyProduct]:[];
    if(wholeBin)required=[...new Set([...required,...db.prepare('SELECT product_id FROM inventory_balances WHERE cell_id=? AND available_quantity>0').all(item.cell_id).map(p=>p.product_id)])];
    // Empty bins require a full-bin check, not an unrelated zero product count.
    if(!required.length)required=[0];
    const put=db.prepare(`INSERT INTO stocktake_reused_counts(item_id,product_id,observation_id,ledger_id) VALUES(?,?,?,?)
      ON CONFLICT(item_id,product_id) DO UPDATE SET observation_id=excluded.observation_id,ledger_id=excluded.ledger_id`);
    for(const id of required)if(lines.some(l=>l.productId===id)||whole)put.run(item.id,id,source.id,ledgerId);
    const evidence=db.prepare(`SELECT e.*,o.lines_json,o.counter_id,o.received_at,o.counted_at,o.status,a.baseline_json,
      i.run_id AS source_run FROM stocktake_reused_counts e JOIN stocktake_observations o ON o.id=e.observation_id
      JOIN stocktake_attempts a ON a.id=o.attempt_id JOIN stocktake_items i ON i.id=o.item_id WHERE e.item_id=?`).all(item.id);
    const valid=new Map();
    for(const e of evidence){
      const line=JSON.parse(e.lines_json).find(l=>l.productId===e.product_id);
      const evidenceBaseline=JSON.parse(e.baseline_json);
      const mappingChanged=evidenceBaseline.guidanceBinding&&evidenceBaseline.guidanceBinding!==guidanceBinding(db,item.cell_id);
      const changed=db.prepare(`SELECT 1 FROM transactions WHERE cell_id=? AND id>? AND (?=0 OR product_id=?) LIMIT 1`).get(item.cell_id,e.ledger_id,e.product_id,e.product_id);
      const product=e.product_id?db.prepare('SELECT * FROM products WHERE id=?').get(e.product_id):null;
      const current=e.product_id?db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=? AND product_id=?').get(item.cell_id,e.product_id)?.available_quantity||0:0;
      if(mappingChanged||changed||!['matched','approved'].includes(e.status)||(e.product_id&&(!product||current!==(line?.actual||0)||line&&(product.unit_of_measure!==line.unit||line.catalogSnapshot&&['cos_sec','part_no','mpi_status'].some(key=>(product[key]??null)!==(line.catalogSnapshot[key]??null)))))){
        db.prepare('DELETE FROM stocktake_reused_counts WHERE item_id=? AND product_id=?').run(item.id,e.product_id);continue;
      }
      valid.set(e.product_id,{...e,line:line||product&&{productId:product.id,name:product.name,sku:product.sku,unit:product.unit_of_measure,actual:0,recorded:0,difference:0,conditionQuantity:0,catalogSnapshot:{cos_sec:product.cos_sec,part_no:product.part_no,mpi_status:product.mpi_status}}});
    }
    if(!required.every(id=>valid.has(id)))continue;
    const selected=required.map(id=>valid.get(id));
    const sources=selected.map(e=>({productId:e.product_id||null,observationId:e.observation_id,runId:e.source_run,counterId:e.counter_id,countedAt:e.counted_at||e.received_at}));
    const id=randomUUID(),attemptId=randomUUID();
    // This is a coverage record, not a second correction or an invented physical count.
    const combined=selected.filter(e=>e.line).map(e=>({...e.line,recorded:e.line.actual,difference:0,reusedFrom:e.observation_id}));
    db.prepare(`INSERT INTO stocktake_attempts(id,item_id,counter_id,generation,baseline_json,started_at,method,identity_evidence,observation_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(attemptId,item.id,source.counter_id,item.generation,JSON.stringify({cellId:item.cell_id,products:combined.map(l=>({...l,recorded:l.actual})),ledgerId,pending:[],reports:[],reused:true}),now,'reuse',JSON.stringify(sources),id);
    db.prepare(`INSERT INTO stocktake_observations(id,attempt_id,item_id,counter_id,lines_json,unknown_json,note,counted_at,received_at,status,supersedes)
      VALUES(?,?,?,?,?,'[]',?,?,?,'matched',?)`).run(id,attemptId,item.id,source.counter_id,JSON.stringify(combined),'Covered by verified counts in other stocktakes.',source.counted_at||source.received_at,now,item.latest_observation);
    db.prepare("UPDATE stocktake_items SET state='counted',latest_observation=?,generation=generation+1 WHERE id=?").run(id,item.id);
    db.prepare('DELETE FROM stocktake_display_claims WHERE item_id=?').run(item.id);
    db.prepare(`INSERT INTO stocktake_events(run_id,item_id,actor_id,event_type,payload,created_at) VALUES(?,?,?,'count_reused',?,?)`).run(item.run_id,item.id,source.counter_id,JSON.stringify({observationId:id,sources}),now);
    refreshRun(item.run_id);
  }
}
