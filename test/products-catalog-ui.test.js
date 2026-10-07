import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDatabase } from "../src/db.js";
import { hashPassword } from "../src/services/auth.js";
import { createProductPages } from "../src/server/pages/products.js";

test("Products summary and out-of-stock checkbox preserve catalog actions", () => {
  const previousDirectory = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "lightguide-products-ui-")));
  const db = createDatabase({ hashPassword, allowDemoInventorySeed: true });
  try {
    const user = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
    const add = db.prepare("INSERT INTO products(sku, name, brand, unit_of_measure, items_per_cell, created_at) VALUES (?, ?, 'Test', 'pieces', 8, '2026-10-07T00:00:00.000Z')");
    const emptyId = add.run("ZERO-TEST", "Empty Test Product").lastInsertRowid;
    const stockedId = add.run("STOCK-TEST", "Stocked Test Product").lastInsertRowid;
    const cell = db.prepare("SELECT id FROM cells LIMIT 1").get();
    db.prepare("INSERT INTO inventory_balances(product_id, cell_id, available_quantity, reserved_quantity) VALUES (?, ?, 4, 0)").run(stockedId, cell.id);

    const pages = createProductPages({ db });
    const html = pages.renderProducts(user, null, "", false, new URL("http://localhost/products?outOfStock=1"));
    const catalog = html.split('id="catalog-product-results">')[1].split("</tbody>")[0];
    assert.match(html, /class="product-status-summary"/);
    assert.match(html, /data-report-open="catalog-items"/);
    assert.match(html, /title="Print this list"/);
    assert.match(html, /name="outOfStock" value="1" checked/);
    assert.match(catalog, /Empty Test Product/);
    assert.doesNotMatch(catalog, /Stocked Test Product/);
    assert.match(catalog, /<th>SKU<\/th><th>Name<\/th><th>Items Per Location<\/th><th>On shelf<\/th><th>Unit of measure<\/th><th>Action<\/th>/);
    assert.match(catalog, new RegExp(`href="/products/${emptyId}"`));
    assert.match(catalog, /Show Quantity/);
    assert.match(catalog, /href="\/pick\?product_id=/);
    assert.match(catalog, /href="\/put\?product_id=/);
  } finally {
    db.close();
    process.chdir(previousDirectory);
  }
});
