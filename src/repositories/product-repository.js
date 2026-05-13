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
              COALESCE(SUM(b.available_quantity), 0) AS total_available
            FROM products p
            LEFT JOIN inventory_balances b ON b.product_id = p.id
            WHERE p.sku LIKE ? OR p.name LIKE ? OR p.brand LIKE ?
            GROUP BY p.id
            ORDER BY p.name
          `,
        )
        .all(pattern, pattern, pattern);
    },

    findById(productId) {
      return db.prepare("SELECT * FROM products WHERE id = ?").get(Number(productId)) || null;
    },

    findBySku(sku) {
      return db.prepare("SELECT * FROM products WHERE sku = ?").get(String(sku || "").trim()) || null;
    },

    getDetail(productId) {
      const product = db
        .prepare(
          `
            SELECT
              p.*,
              COALESCE(SUM(b.available_quantity), 0) AS total_available
            FROM products p
            LEFT JOIN inventory_balances b ON b.product_id = p.id
            WHERE p.id = ?
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
            WHERE b.product_id = ? AND b.available_quantity > 0
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
  };
}
