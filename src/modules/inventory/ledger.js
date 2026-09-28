// Private inventory write primitive. Only transactional domain commands call this.
// Authorization, reservations and physical evidence are validated by the command owner.
export function postMovement(db,{actor,performer=null,productId,cellId,quantity,type,taskId=null,lineId=null,origin,reason,unit,expectedBalance}) {
  if(!db.isTransaction)throw new Error('Inventory posting requires the domain transaction.');
  if(!Number.isFinite(quantity)||!actor?.id||!origin||!unit)throw new Error('Incomplete inventory movement identity.');
  db.prepare('INSERT OR IGNORE INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,0,0)').run(productId,cellId);
  const result=expectedBalance===undefined
    ?db.prepare('UPDATE inventory_balances SET available_quantity=ROUND(available_quantity+?,6) WHERE product_id=? AND cell_id=?').run(quantity,productId,cellId)
    :db.prepare('UPDATE inventory_balances SET available_quantity=ROUND(available_quantity+?,6) WHERE product_id=? AND cell_id=? AND available_quantity=?').run(quantity,productId,cellId,expectedBalance);
  if(result.changes!==1)throw new Error('Stock changed. Request a fresh count.');
  if(quantity===0)return null;
  return Number(db.prepare(`INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,task_id,task_line_id,origin_ref,performed_by,reason,unit_of_measure,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(type,productId,cellId,quantity,actor.id,taskId,lineId,origin,performer||null,reason||null,unit,new Date().toISOString()).lastInsertRowid);
}
