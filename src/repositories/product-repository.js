import { nowIso } from "../shared/time.js";

export function createProductRepository(db) {
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
      const product = db
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

      if (!product) {
        return null;
      }

      const locations = db
        .prepare(
          `
            SELECT
              c.id AS cell_id,
              c.logical_code,
              c.hardware_channel,
              COALESCE(b.available_quantity, 0) AS available_quantity
            FROM inventory_balances b
            JOIN cells c ON c.id = b.cell_id
            WHERE b.product_id = ? AND b.available_quantity > 0 AND c.active = 1
            ORDER BY c.row_number, c.column_number
          `,
        )
        .all(Number(productId));

      return {
        ...product,
        locations,
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
