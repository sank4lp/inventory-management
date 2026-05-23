import { nowIso } from "../shared/time.js";

const MOVEMENT_STOCK_DEFAULT_LIMIT = 5;

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function stockLocationSort(left, right) {
  const leftTime = Date.parse(left?.last_activity_at || "");
  const rightTime = Date.parse(right?.last_activity_at || "");
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY;

  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft - normalizedRight;
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
}

export function createProductRepository(db) {
  function productSummary(productId) {
    return db
      .prepare(
        `
          SELECT
            p.*,
            COALESCE(
              SUM(CASE WHEN stock_cell.active = 1 THEN b.available_quantity ELSE 0 END),
              0
            ) AS total_available,
            COALESCE(
              SUM(CASE WHEN stock_cell.active = 1 THEN b.reserved_quantity ELSE 0 END),
              0
            ) AS total_reserved
          FROM products p
          LEFT JOIN inventory_balances b ON b.product_id = p.id
          LEFT JOIN cells stock_cell ON stock_cell.id = b.cell_id
          WHERE p.id = ? AND p.active = 1
          GROUP BY p.id
        `,
      )
      .get(Number(productId));
  }

  function stockLocationBaseQuery(extraWhere = "", order = "activity") {
    const orderClause = order === "row"
      ? "c.row_number, c.column_number"
      : `
        CASE WHEN last_activity_at IS NULL THEN 1 ELSE 0 END,
        last_activity_at,
        c.row_number,
        c.column_number
      `;

    return `
      SELECT
        c.id AS cell_id,
        c.logical_code,
        CASE WHEN ctrl.active = 1 THEN c.controller_id ELSE NULL END AS controller_id,
        CASE WHEN ctrl.active = 1 THEN ctrl.address ELSE NULL END AS controller_address,
        CASE WHEN ctrl.active = 1 THEN c.hardware_channel ELSE NULL END AS hardware_channel,
        c.row_number,
        c.column_number,
        COALESCE(b.available_quantity, 0) AS available_quantity,
        (
          SELECT MAX(t.created_at)
          FROM transactions t
          WHERE t.product_id = b.product_id
            AND t.cell_id = b.cell_id
        ) AS last_activity_at
      FROM inventory_balances b
      JOIN cells c ON c.id = b.cell_id
      LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
      WHERE b.product_id = ? AND b.available_quantity > 0 AND c.active = 1
      ${extraWhere}
      ORDER BY ${orderClause}
    `;
  }

  return {
    list(search = "") {
      const pattern = `%${search.trim()}%`;
      return db
        .prepare(
          `
            SELECT
              p.*,
              COALESCE(
                SUM(CASE WHEN stock_cell.active = 1 THEN b.available_quantity ELSE 0 END),
                0
              ) AS total_available,
              COALESCE(
                SUM(CASE WHEN stock_cell.active = 1 THEN b.reserved_quantity ELSE 0 END),
                0
              ) AS total_reserved
            FROM products p
            LEFT JOIN inventory_balances b ON b.product_id = p.id
            LEFT JOIN cells stock_cell ON stock_cell.id = b.cell_id
            WHERE p.active = 1
              AND (p.sku LIKE ? OR p.name LIKE ? OR p.brand LIKE ?)
            GROUP BY p.id
            ORDER BY p.name
          `,
        )
        .all(pattern, pattern, pattern);
    },

    findById(productId) {
      return db
        .prepare("SELECT * FROM products WHERE id = ? AND active = 1")
        .get(Number(productId)) || null;
    },

    findBySku(sku) {
      return db
        .prepare("SELECT * FROM products WHERE LOWER(sku) = LOWER(?) AND active = 1")
        .get(String(sku || "").trim()) || null;
    },

    findAnyBySku(sku) {
      return db
        .prepare("SELECT * FROM products WHERE LOWER(sku) = LOWER(?)")
        .get(String(sku || "").trim()) || null;
    },

    getDetail(productId) {
      const product = productSummary(productId);

      if (!product) {
        return null;
      }

      const locations = db
        .prepare(stockLocationBaseQuery("", "row"))
        .all(Number(productId));

      return {
        ...product,
        locations,
      };
    },

    getMovementStockSummary(productId, { limit = MOVEMENT_STOCK_DEFAULT_LIMIT, offset = 0, includeCellIds = [] } = {}) {
      const product = productSummary(productId);

      if (!product) {
        return null;
      }

      const normalizedLimit = normalizePositiveInteger(limit, MOVEMENT_STOCK_DEFAULT_LIMIT);
      const normalizedOffset = Math.max(0, Number(offset) || 0);
      const locations = db
        .prepare(`${stockLocationBaseQuery()} LIMIT ? OFFSET ?`)
        .all(Number(productId), normalizedLimit, normalizedOffset);

      const includedIds = Array.isArray(includeCellIds)
        ? includeCellIds
            .map((cellId) => Number(cellId))
            .filter((cellId) => Number.isInteger(cellId) && cellId > 0)
        : [];
      if (normalizedOffset === 0 && includedIds.length) {
        const seenCellIds = new Set(locations.map((location) => Number(location.cell_id)));
        for (const cellId of includedIds) {
          if (seenCellIds.has(cellId)) {
            continue;
          }
          const includedLocation = db
            .prepare(`${stockLocationBaseQuery("AND c.id = ?")} LIMIT 1`)
            .get(Number(productId), cellId);
          if (includedLocation) {
            locations.push(includedLocation);
            seenCellIds.add(cellId);
          }
        }
        locations.sort(stockLocationSort);
      }

      const countRow = db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM inventory_balances b
            JOIN cells c ON c.id = b.cell_id
            WHERE b.product_id = ? AND b.available_quantity > 0 AND c.active = 1
          `,
        )
        .get(Number(productId));

      return {
        ...product,
        locations,
        stock_location_count: Number(countRow?.count || 0),
        stock_location_offset: normalizedOffset,
        stock_location_limit: normalizedLimit,
      };
    },

    create(input) {
      const result = db
        .prepare(
          `
            INSERT INTO products (
              sku, name, brand, category, variant, unit_of_measure, description,
              preferred_storage_strategy, items_per_cell, active, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.sku,
          input.name,
          input.brand,
          input.category || null,
          input.variant || null,
          input.unit_of_measure,
          input.description || null,
          input.preferred_storage_strategy || "closest-cell-first",
          input.items_per_cell,
          input.active === 0 ? 0 : 1,
          nowIso(),
        );

      return this.findById(Number(result.lastInsertRowid));
    },

    updateItemsPerCell(productId, itemsPerCell) {
      return db
        .prepare(
          `
            UPDATE products
            SET items_per_cell = ?
            WHERE id = ?
          `,
        )
        .run(itemsPerCell, Number(productId));
    },

    updateDetails(productId, input) {
      db
        .prepare(
          `
            UPDATE products
            SET
              name = ?,
              brand = ?,
              category = ?,
              variant = ?,
              unit_of_measure = ?,
              description = ?,
              preferred_storage_strategy = ?
            WHERE id = ? AND active = 1
          `,
        )
        .run(
          input.name,
          input.brand,
          input.category || null,
          input.variant || null,
          input.unit_of_measure,
          input.description || null,
          input.preferred_storage_strategy || "closest-cell-first",
          Number(productId),
        );

      return this.findById(Number(productId));
    },

    restore(productId, input) {
      db
        .prepare(
          `
            UPDATE products
            SET
              name = ?,
              brand = ?,
              category = ?,
              variant = ?,
              unit_of_measure = ?,
              description = ?,
              preferred_storage_strategy = ?,
              items_per_cell = ?,
              active = 1
            WHERE id = ?
          `,
        )
        .run(
          input.name,
          input.brand,
          input.category || null,
          input.variant || null,
          input.unit_of_measure,
          input.description || null,
          input.preferred_storage_strategy || "closest-cell-first",
          input.items_per_cell,
          Number(productId),
        );

      return this.findById(Number(productId));
    },

    stockTotals(productId) {
      return db
        .prepare(
          `
            SELECT
              COALESCE(SUM(CASE WHEN c.active = 1 THEN b.available_quantity ELSE 0 END), 0) AS active_available,
              COALESCE(SUM(CASE WHEN c.active = 1 THEN b.reserved_quantity ELSE 0 END), 0) AS active_reserved,
              COALESCE(SUM(b.available_quantity), 0) AS total_available,
              COALESCE(SUM(b.reserved_quantity), 0) AS total_reserved
            FROM inventory_balances b
            LEFT JOIN cells c ON c.id = b.cell_id
            WHERE b.product_id = ?
          `,
        )
        .get(Number(productId));
    },

    deactivate(productId) {
      return db
        .prepare(
          `
            UPDATE products
            SET active = 0
            WHERE id = ? AND active = 1
          `,
        )
        .run(Number(productId));
    },
  };
}
