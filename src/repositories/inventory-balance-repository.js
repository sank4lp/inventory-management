function normalizeCellIdSet(cellIds) {
  const values = Array.isArray(cellIds) ? cellIds : [cellIds];
  return new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

function activityTime(row) {
  const timestamp = Date.parse(row?.last_activity_at || "");
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function compareByPreferredActivityAndLocation(preferredCellIds) {
  return (left, right) => {
    const leftPreferred = preferredCellIds.has(Number(left.cell_id)) ? 0 : 1;
    const rightPreferred = preferredCellIds.has(Number(right.cell_id)) ? 0 : 1;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred - rightPreferred;
    }

    const activityDelta = activityTime(left) - activityTime(right);
    if (activityDelta !== 0) {
      return activityDelta;
    }

    const rowDelta = Number(left.row_number || 0) - Number(right.row_number || 0);
    if (rowDelta !== 0) {
      return rowDelta;
    }

    const columnDelta = Number(left.column_number || 0) - Number(right.column_number || 0);
    if (columnDelta !== 0) {
      return columnDelta;
    }

    return String(left.logical_code || "").localeCompare(String(right.logical_code || ""), "en", {
      numeric: true,
      sensitivity: "base",
    });
  };
}

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

    listPickCandidates(productId, preferredCellIds = null) {
      const preferred = normalizeCellIdSet(preferredCellIds);
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
              c.column_number,
              (
                SELECT MAX(t.created_at)
                FROM transactions t
                WHERE t.product_id = b.product_id
                  AND t.cell_id = b.cell_id
              ) AS last_activity_at
            FROM inventory_balances b
            JOIN cells c ON c.id = b.cell_id
            WHERE b.product_id = ? AND c.active = 1 AND b.available_quantity > 0
          `,
        )
        .all(Number(productId))
        .sort(compareByPreferredActivityAndLocation(preferred));
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
              COALESCE(SUM(b.available_quantity), 0) AS occupied_quantity,
              (
                SELECT MAX(t.created_at)
                FROM transactions t
                WHERE t.product_id = ?
                  AND t.cell_id = c.id
              ) AS product_last_activity_at,
              (
                SELECT MAX(t.created_at)
                FROM transactions t
                WHERE t.cell_id = c.id
              ) AS cell_last_activity_at
            FROM cells c
            LEFT JOIN inventory_balances b ON b.cell_id = c.id
            WHERE c.id = ? AND c.active = 1
            GROUP BY c.id
          `,
        )
        .get(Number(productId), Number(cellId));

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
        last_activity_at: cell.product_last_activity_at || cell.cell_last_activity_at || null,
        same_product_quantity: sameProduct ? Number(sameProduct.available_quantity) : undefined,
      };
    },

    listSameProductPutCells(productId, excludedCellIds = null) {
      const excluded = normalizeCellIdSet(excludedCellIds);
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
              COALESCE(b.available_quantity, 0) AS available_quantity,
              (
                SELECT MAX(t.created_at)
                FROM transactions t
                WHERE t.product_id = b.product_id
                  AND t.cell_id = b.cell_id
              ) AS last_activity_at
            FROM cells c
            JOIN inventory_balances b ON b.cell_id = c.id
            WHERE b.product_id = ?
              AND b.available_quantity > 0
              AND c.active = 1
              AND NOT EXISTS (
                SELECT 1
                FROM inventory_balances other_balance
                WHERE other_balance.cell_id = c.id
                  AND other_balance.product_id != ?
                  AND other_balance.available_quantity > 0
              )
          `,
        )
        .all(Number(productId), Number(productId))
        .filter((cell) => !excluded.has(Number(cell.cell_id)))
        .sort(compareByPreferredActivityAndLocation(new Set()));
    },

    listEmptyPutCells(productId, excludedCellIds = null) {
      const excluded = normalizeCellIdSet(excludedCellIds);
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
              (
                SELECT MAX(t.created_at)
                FROM transactions t
                WHERE t.cell_id = c.id
              ) AS last_activity_at
            FROM cells c
            LEFT JOIN inventory_balances b
              ON b.cell_id = c.id AND b.available_quantity > 0
            WHERE c.active = 1
              AND b.id IS NULL
          `,
        )
        .all()
        .filter((cell) => !excluded.has(Number(cell.cell_id)))
        .sort(compareByPreferredActivityAndLocation(new Set()));
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
            WHERE b.product_id = ?
              AND b.available_quantity > 0
              AND c.active = 1
              AND c.id != ?
              AND NOT EXISTS (
                SELECT 1
                FROM inventory_balances other_balance
                WHERE other_balance.cell_id = c.id
                  AND other_balance.product_id != ?
                  AND other_balance.available_quantity > 0
              )
            ORDER BY COALESCE(b.available_quantity, 0) DESC,
                     c.row_number,
                     c.column_number
          `,
        )
        .all(Number(productId), Number(sourceCellId), Number(productId));
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
