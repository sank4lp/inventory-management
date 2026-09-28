// Called inside the review command's immediate transaction, after validating its
// immutable baseline. This posts deltas into the existing inventory ledger.
export function postCountCorrection(db, { actor, cellId, lines, observationId, reason }) {
  const ids=[];
  for(const line of lines) {
    const delta=Math.round((line.actual-line.recorded)*1e6)/1e6;
    if(!delta) continue;
    db.prepare('INSERT OR IGNORE INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,0,0)').run(line.productId,cellId);
    const changed=db.prepare('UPDATE inventory_balances SET available_quantity=ROUND(available_quantity+?,6) WHERE product_id=? AND cell_id=? AND available_quantity=?').run(delta,line.productId,cellId,line.recorded);
    if(changed.changes!==1)throw new Error('Stock changed. Request a fresh count.');
    const result=db.prepare(`INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,origin_ref,reason,unit_of_measure,created_at)
      VALUES('adjustment',?,?,?,?,?,?,?,?)`).run(line.productId,cellId,delta,actor.id,'stocktake:'+observationId,reason,line.unit,new Date().toISOString());
    ids.push(Number(result.lastInsertRowid));
  }
  return ids;
}

export function createInventoryBalanceService({ db }) {
  return {
    getProductBalance(productId, cellId) {
      return (
        db
          .prepare(
            `
              SELECT *
              FROM inventory_balances
              WHERE product_id = ? AND cell_id = ?
            `,
          )
          .get(Number(productId), Number(cellId)) || null
      );
    },
    listBalancesForCell(cellId) {
      return db
        .prepare(
          `
            SELECT *
            FROM inventory_balances
            WHERE cell_id = ?
            ORDER BY product_id
          `,
        )
        .all(Number(cellId));
    },
  };
}
