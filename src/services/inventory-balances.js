import {postMovement} from "../modules/inventory/ledger.js";
// Called inside the review command's immediate transaction, after validating its
// immutable baseline. This posts deltas into the existing inventory ledger.
export function postCountCorrection(db, { actor, cellId, lines, observationId, reason }) {
  return lines.flatMap(line=>{const quantity=Math.round((line.actual-line.recorded)*1e6)/1e6;if(!quantity)return [];return [postMovement(db,{actor,cellId,productId:line.productId,quantity,type:'adjustment',origin:'stocktake:'+observationId,reason,unit:line.unit,expectedBalance:line.recorded})];});
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
