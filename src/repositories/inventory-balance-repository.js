export function createInventoryBalanceRepository(db) {
  return {
    sumCellOccupancy(cellId) {
      const row = db
        .prepare(
          `
            SELECT COALESCE(SUM(available_quantity), 0) AS total_quantity
            FROM inventory_balances
            WHERE cell_id = ?
          `,
        )
        .get(Number(cellId));
      return Number(row?.total_quantity || 0);
    },

    getOrCreate(productId, cellId) {
      const existing = db
        .prepare("SELECT * FROM inventory_balances WHERE product_id = ? AND cell_id = ?")
        .get(Number(productId), Number(cellId));

      if (existing) {
        return existing;
      }

      const result = db
        .prepare(
          `
            INSERT INTO inventory_balances (product_id, cell_id, available_quantity, reserved_quantity)
            VALUES (?, ?, 0, 0)
          `,
        )
        .run(Number(productId), Number(cellId));

      return db
        .prepare("SELECT * FROM inventory_balances WHERE id = ?")
        .get(Number(result.lastInsertRowid));
    },

    listPickCandidates(productId, preferredCellId = null) {
      return db
        .prepare(
          `
            SELECT
              b.product_id,
              b.cell_id,
              b.available_quantity,
              c.logical_code,
              c.hardware_channel,
              c.controller_id,
              c.row_number,
              c.column_number
            FROM inventory_balances b
            JOIN cells c ON c.id = b.cell_id
            WHERE b.product_id = ? AND c.active = 1 AND b.available_quantity > 0
            ORDER BY
              CASE WHEN c.id = ? THEN 0 ELSE 1 END,
              c.row_number,
              c.column_number
          `,
        )
        .all(Number(productId), preferredCellId ? Number(preferredCellId) : -1);
    },

    getPreferredPutCell(cellId, productId) {
      if (!cellId) {
        return null;
      }

      const cell = db
        .prepare(
          `
            SELECT
              c.id AS cell_id,
              c.logical_code,
              c.hardware_channel,
              c.controller_id,
              c.row_number,
              c.column_number,
              COALESCE(SUM(b.available_quantity), 0) AS occupied_quantity
            FROM cells c
            LEFT JOIN inventory_balances b ON b.cell_id = c.id
            WHERE c.id = ? AND c.active = 1
            GROUP BY c.id
          `,
        )
        .get(Number(cellId));

      if (!cell) {
        return null;
      }

      const sameProduct = db
        .prepare(
          `
            SELECT COALESCE(available_quantity, 0) AS available_quantity
            FROM inventory_balances
            WHERE product_id = ? AND cell_id = ?
          `,
        )
        .get(Number(productId), cell.cell_id);

      return {
        ...cell,
        same_product_quantity: sameProduct ? Number(sameProduct.available_quantity) : undefined,
      };
    },

    listSameProductPutCells(productId, excludedCellId = null) {
      return db
        .prepare(
          `
            SELECT
              c.id AS cell_id,
              c.logical_code,
              c.hardware_channel,
              c.controller_id,
              c.row_number,
              c.column_number,
              COALESCE(b.available_quantity, 0) AS available_quantity
            FROM cells c
            JOIN inventory_balances b ON b.cell_id = c.id
            WHERE b.product_id = ? AND c.active = 1
            ORDER BY COALESCE(b.available_quantity, 0) DESC,
                     c.row_number,
                     c.column_number
          `,
        )
        .all(Number(productId))
        .filter((cell) => cell.cell_id !== Number(excludedCellId || 0));
    },

    listEmptyPutCells(productId, excludedCellId = null) {
      return db
        .prepare(
          `
            SELECT
              c.id AS cell_id,
              c.logical_code,
              c.hardware_channel,
              c.controller_id,
              c.row_number,
              c.column_number
            FROM cells c
            LEFT JOIN inventory_balances b
              ON b.cell_id = c.id AND b.available_quantity > 0
            WHERE c.active = 1
              AND b.id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM inventory_balances existing_product_balance
                WHERE existing_product_balance.cell_id = c.id
                  AND existing_product_balance.product_id = ?
              )
            ORDER BY c.row_number, c.column_number
          `,
        )
        .all(Number(productId))
        .filter((cell) => cell.cell_id !== Number(excludedCellId || 0));
    },

    listSameProductMoveTargets(productId, sourceCellId) {
      return db
        .prepare(
          `
            SELECT
              c.id AS cell_id,
              c.logical_code,
              COALESCE(b.available_quantity, 0) AS available_quantity
            FROM cells c
            JOIN inventory_balances b ON b.cell_id = c.id
            WHERE b.product_id = ? AND c.active = 1 AND c.id != ?
            ORDER BY COALESCE(b.available_quantity, 0) DESC,
                     c.row_number,
                     c.column_number
          `,
        )
        .all(Number(productId), Number(sourceCellId));
    },

    listEmptyMoveTargets(sourceCellId) {
      return db
        .prepare(
          `
            SELECT
              c.id AS cell_id,
              c.logical_code
            FROM cells c
            LEFT JOIN inventory_balances b
              ON b.cell_id = c.id AND b.available_quantity > 0
            WHERE c.active = 1
              AND b.id IS NULL
              AND c.id != ?
            ORDER BY c.row_number, c.column_number
          `,
        )
        .all(Number(sourceCellId));
    },

    increase(balanceId, quantity) {
      db.prepare(
        `
          UPDATE inventory_balances
          SET available_quantity = available_quantity + ?
          WHERE id = ?
        `,
      ).run(Number(quantity), Number(balanceId));
    },

    decrease(balanceId, quantity) {
      db.prepare(
        `
          UPDATE inventory_balances
          SET available_quantity = available_quantity - ?
          WHERE id = ?
        `,
      ).run(Number(quantity), Number(balanceId));
    },
  };
}
