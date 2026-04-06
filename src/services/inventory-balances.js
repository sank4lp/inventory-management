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
