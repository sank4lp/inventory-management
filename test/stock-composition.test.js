import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

async function createTestContext(prefix) {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(sandbox);
  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const db = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: false,
  });
  const admin = db
    .prepare("SELECT id, name, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    .get();
  const operator = db
    .prepare("SELECT id, name, username, role FROM users WHERE role = 'operator' ORDER BY id LIMIT 1")
    .get();
  return { admin, auth, createDatabase, db, inventory, operator };
}

function createProduct(inventory, db, {
  sku,
  name,
  category = "",
  unit,
}) {
  return inventory.createProduct(db, {
    sku,
    name,
    brand: "Composition Test",
    category,
    unit_of_measure: unit,
    items_per_cell: 1000,
  });
}

function stockProducts(inventory, db, admin, cellId, entries, reason = "Stock composition fixture") {
  inventory.createAdjustment(db, {
    cellId,
    userId: admin.id,
    reason,
    lines: entries.map(({ product, quantity }) => ({
      productId: product.id,
      absoluteQuantity: quantity,
    })),
  });
}

function unitRanking(report, unit) {
  return report.rankingsByUnit.find(
    (group) => group.unitOfMeasure.toLowerCase() === unit.toLowerCase(),
  );
}

function unitShares(report, unit) {
  return report.sharesByUnit.find(
    (group) => group.unitOfMeasure.toLowerCase() === unit.toLowerCase(),
  );
}

function percentageTenthsTotal(slices) {
  return Math.round(
    slices.reduce((sum, slice) => sum + Number(slice.percentage), 0) * 10,
  );
}

function stockRecipe(overrides = {}) {
  return {
    type: "stock_composition",
    metric: "available_quantity",
    groupBy: "product",
    filters: {
      category: null,
      unitOfMeasure: null,
    },
    dateRange: "all_time",
    topN: 10,
    visualization: "bar",
    columns: ["product.sku", "product.name", "available_quantity"],
    ...overrides,
  };
}

test("stock composition separates crates and kilograms and derives Other from the full denominator", async () => {
  const { admin, db, inventory } = await createTestContext("inventory-stock-composition-units-");
  const { buildInventoryCompositionReport } = await freshImport("../src/services/reports.js");
  assert.equal(typeof buildInventoryCompositionReport, "function");

  const [activeCell, inactiveCell] = inventory.listCells(db).slice(0, 2);
  assert.ok(activeCell);
  assert.ok(inactiveCell);
  const crateAlpha = createProduct(inventory, db, {
    sku: "COMP-CRATE-A",
    name: "Crate Alpha",
    category: "Equipment",
    unit: "crates",
  });
  const crateBeta = createProduct(inventory, db, {
    sku: "COMP-CRATE-B",
    name: "Crate Beta",
    category: "Equipment",
    unit: "crates",
  });
  const crateGamma = createProduct(inventory, db, {
    sku: "COMP-CRATE-C",
    name: "Crate Gamma",
    category: "Equipment",
    unit: "crates",
  });
  const crateDelta = createProduct(inventory, db, {
    sku: "COMP-CRATE-D",
    name: "Crate Delta",
    category: "Equipment",
    unit: "crates",
  });
  const rice = createProduct(inventory, db, {
    sku: "COMP-KG-RICE",
    name: "Rice Bulk",
    category: "Grain",
    unit: "kg",
  });
  const lentils = createProduct(inventory, db, {
    sku: "COMP-KG-LENTILS",
    name: "Lentils Bulk",
    category: "Pulses",
    unit: "kg",
  });
  const inactiveProduct = createProduct(inventory, db, {
    sku: "COMP-INACTIVE",
    name: "Inactive Product",
    category: "Equipment",
    unit: "crates",
  });
  const inactiveCellProduct = createProduct(inventory, db, {
    sku: "COMP-INACTIVE-CELL",
    name: "Inactive Cell Product",
    category: "Grain",
    unit: "kg",
  });

  stockProducts(inventory, db, admin, activeCell.id, [
    { product: crateAlpha, quantity: 40 },
    { product: crateBeta, quantity: 30 },
    { product: crateGamma, quantity: 20 },
    { product: crateDelta, quantity: 10 },
    { product: rice, quantity: 60 },
    { product: lentils, quantity: 40 },
    { product: inactiveProduct, quantity: 500 },
  ]);
  stockProducts(
    inventory,
    db,
    admin,
    inactiveCell.id,
    [{ product: inactiveCellProduct, quantity: 600 }],
    "Stock in inactive location",
  );
  db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(inactiveProduct.id);
  db.prepare("UPDATE cells SET active = 0 WHERE id = ?").run(inactiveCell.id);

  const report = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: "product",
    topN: 2,
    visualization: "bar",
  });

  assert.equal(report.reportKey, "inventory-stock-composition");
  assert.equal(report.comparison, "separate_by_unit");
  assert.deepEqual(report.units, ["crates", "kg"]);
  assert.deepEqual(report.totalsByUnit, { crates: 100, kg: 100 });
  assert.equal(report.totalMatchingRows, 6);

  const crateRanking = unitRanking(report, "crates");
  assert.deepEqual(
    crateRanking.rows.map((row) => [row.name, row.available_quantity]),
    [
      ["Crate Alpha", 40],
      ["Crate Beta", 30],
    ],
  );
  const crateShares = unitShares(report, "crates");
  assert.equal(crateShares.total, 100);
  assert.equal(crateShares.totalAvailable, 100);
  assert.equal(crateShares.sourceRowCount, 4);
  assert.equal(crateShares.omittedRowCount, 2);
  assert.deepEqual(
    crateShares.slices.map((slice) => [slice.label, slice.value, slice.percentage, slice.isOther]),
    [
      ["Crate Alpha", 40, 40, false],
      ["Crate Beta", 30, 30, false],
      ["Other", 30, 30, true],
    ],
  );
  assert.equal(crateShares.slices.at(-1).key, "other:crates");
  assert.equal(percentageTenthsTotal(crateShares.slices), 1000);

  const kgShares = unitShares(report, "kg");
  assert.equal(kgShares.total, 100);
  assert.equal(kgShares.totalAvailable, 100);
  assert.equal(kgShares.sourceRowCount, 2);
  assert.equal(kgShares.omittedRowCount, 0);
  assert.deepEqual(
    kgShares.slices.map((slice) => [slice.label, slice.value, slice.percentage, slice.isOther]),
    [
      ["Rice Bulk", 60, 60, false],
      ["Lentils Bulk", 40, 40, false],
    ],
  );
  assert.ok(!JSON.stringify(report).includes("Inactive Product"));
  assert.ok(!JSON.stringify(report).includes("Inactive Cell Product"));

  db.close();
});

test("stock composition aggregates categories and reportable custom fields within the selected unit", async () => {
  const { admin, db, inventory } = await createTestContext("inventory-stock-composition-groups-");
  const { buildInventoryCompositionReport } = await freshImport("../src/services/reports.js");
  const { createProductFieldService } = await freshImport("../src/services/product-fields.js");
  const fields = createProductFieldService({ db });
  const cell = inventory.listCells(db)[0];

  const rice = createProduct(inventory, db, {
    sku: "COMP-GRAIN-RICE",
    name: "Rice",
    category: "Grain",
    unit: "kg",
  });
  const wheat = createProduct(inventory, db, {
    sku: "COMP-GRAIN-WHEAT",
    name: "Wheat",
    category: "Grain",
    unit: "kg",
  });
  const pulses = createProduct(inventory, db, {
    sku: "COMP-PULSES",
    name: "Pulses",
    category: "Pulses",
    unit: "kg",
  });
  const uncategorized = createProduct(inventory, db, {
    sku: "COMP-UNCATEGORIZED",
    name: "Uncategorized Stock",
    unit: "kg",
  });
  const grainPieces = createProduct(inventory, db, {
    sku: "COMP-GRAIN-PIECES",
    name: "Grain Sample Packs",
    category: "Grain",
    unit: "pieces",
  });
  stockProducts(inventory, db, admin, cell.id, [
    { product: rice, quantity: 60 },
    { product: wheat, quantity: 40 },
    { product: pulses, quantity: 50 },
    { product: uncategorized, quantity: 25 },
    { product: grainPieces, quantity: 999 },
  ]);

  const categoryReport = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: "category",
    unitOfMeasure: "kg",
    topN: 8,
    visualization: "donut",
  });
  assert.equal(categoryReport.comparison, "comparable");
  assert.deepEqual(categoryReport.units, ["kg"]);
  assert.equal(categoryReport.totalsByUnit.kg, 175);
  const categoryRows = unitRanking(categoryReport, "kg").rows;
  assert.deepEqual(
    categoryRows.map((row) => [row.name, row.available_quantity, row.product_count]),
    [
      ["Grain", 100, 2],
      ["Pulses", 50, 1],
      ["Uncategorized", 25, 1],
    ],
  );
  const categoryShares = unitShares(categoryReport, "kg");
  assert.deepEqual(
    categoryShares.slices.map((slice) => [slice.label, slice.value, slice.percentage]),
    [
      ["Grain", 100, 57.1],
      ["Pulses", 50, 28.6],
      ["Uncategorized", 25, 14.3],
    ],
  );
  assert.equal(percentageTenthsTotal(categoryShares.slices), 1000);

  const grainProducts = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: "product",
    category: "grain",
    unitOfMeasure: "KG",
    topN: 8,
    visualization: "donut",
  });
  assert.deepEqual(
    unitRanking(grainProducts, "kg").rows.map((row) => [row.name, row.available_quantity]),
    [
      ["Rice", 60],
      ["Wheat", 40],
    ],
  );

  const storageClass = fields.create({
    actor: admin,
    label: "Storage Class",
    dataType: "select",
    options: ["Ambient", "Chilled"],
    reportable: 1,
    visible: 1,
  });
  for (const product of [rice, wheat]) {
    fields.setProductValue({
      actor: admin,
      productId: product.id,
      fieldId: storageClass.id,
      value: "Ambient",
    });
  }
  fields.setProductValue({
    actor: admin,
    productId: pulses.id,
    fieldId: storageClass.id,
    value: "Chilled",
  });

  const customReport = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: storageClass.field_key,
    unitOfMeasure: "kg",
    topN: 8,
    visualization: "bar",
  });
  assert.deepEqual(
    unitRanking(customReport, "kg").rows.map((row) => [
      row.custom_field_value,
      row.available_quantity,
      row.product_count,
    ]),
    [
      ["Ambient", 100, 2],
      ["Chilled", 50, 1],
      ["Not set", 25, 1],
    ],
  );
  assert.equal(customReport.labels[storageClass.field_key], "Storage Class");

  db.close();
});

test("stock composition allocates exact tenths and handles empty and zero-stock results", async () => {
  const { admin, db, inventory } = await createTestContext("inventory-stock-composition-rounding-");
  const { buildInventoryCompositionReport } = await freshImport("../src/services/reports.js");
  const cell = inventory.listCells(db)[0];
  const alpha = createProduct(inventory, db, {
    sku: "COMP-ROUND-A",
    name: "Alpha",
    category: "Equal",
    unit: "crates",
  });
  const beta = createProduct(inventory, db, {
    sku: "COMP-ROUND-B",
    name: "Beta",
    category: "Equal",
    unit: "crates",
  });
  const gamma = createProduct(inventory, db, {
    sku: "COMP-ROUND-C",
    name: "Gamma",
    category: "Equal",
    unit: "crates",
  });
  const empty = createProduct(inventory, db, {
    sku: "COMP-ZERO",
    name: "Zero Stock",
    category: "Empty",
    unit: "crates",
  });
  stockProducts(inventory, db, admin, cell.id, [
    { product: alpha, quantity: 1 },
    { product: beta, quantity: 1 },
    { product: gamma, quantity: 1 },
  ]);

  const equalShares = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: "product",
    category: "Equal",
    unitOfMeasure: "crates",
    topN: 3,
    visualization: "donut",
  });
  const equalGroup = unitShares(equalShares, "crates");
  assert.equal(equalGroup.totalAvailable, 3);
  assert.equal(equalGroup.sourceRowCount, 3);
  assert.equal(equalGroup.omittedRowCount, 0);
  assert.deepEqual(
    equalGroup.slices.map((slice) => slice.percentage).sort((left, right) => left - right),
    [33.3, 33.3, 33.4],
  );
  assert.equal(percentageTenthsTotal(equalGroup.slices), 1000);
  const repeated = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: "product",
    category: "Equal",
    unitOfMeasure: "crates",
    topN: 3,
    visualization: "donut",
  });
  assert.deepEqual(unitShares(repeated, "crates").slices, equalGroup.slices);

  const noMatches = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: "product",
    unitOfMeasure: "litres",
    topN: 3,
    visualization: "donut",
  });
  assert.deepEqual(noMatches.rows, []);
  assert.deepEqual(noMatches.units, []);
  assert.deepEqual(noMatches.sharesByUnit, []);
  assert.equal(noMatches.totalMatchingRows, 0);

  const zeroStock = buildInventoryCompositionReport(db, {
    metric: "available_quantity",
    groupBy: "product",
    category: "Empty",
    unitOfMeasure: "crates",
    topN: 3,
    visualization: "donut",
  });
  assert.ok(empty);
  assert.equal(zeroStock.totalMatchingRows, 0);
  assert.deepEqual(zeroStock.rows, []);
  assert.deepEqual(zeroStock.units, []);
  assert.deepEqual(zeroStock.totalsByUnit, {});
  assert.deepEqual(zeroStock.sharesByUnit, []);
  assert.doesNotMatch(JSON.stringify(zeroStock), /NaN|Infinity/);

  db.close();
});

test("stock composition recipes validate donut constraints and persist unchanged", async () => {
  const { createDatabase, db, operator } = await createTestContext(
    "inventory-stock-composition-recipes-",
  );
  const auth = await freshImport("../src/services/auth.js");
  const reportDefinitions = await freshImport("../src/services/report-definitions.js");
  const { buildInventoryCompositionReport } = await freshImport("../src/services/reports.js");
  const service = reportDefinitions.createReportDefinitionService({ db });

  const donutRecipe = stockRecipe({
    filters: { category: null, unitOfMeasure: "crates" },
    topN: 8,
    visualization: "donut",
  });
  const validated = service.validate(donutRecipe);
  assert.equal(validated.type, "stock_composition");
  assert.equal(validated.metric, "available_quantity");
  assert.equal(validated.groupBy, "product");
  assert.equal(validated.filters.unitOfMeasure, "crates");
  assert.equal(validated.topN, 8);
  assert.equal(validated.visualization, "donut");

  assert.throws(
    () => service.validate(stockRecipe({ metric: "picked_quantity" })),
    /Stock composition reports use available quantity/,
  );
  assert.throws(
    () => service.validate(stockRecipe({ groupBy: "unit_of_measure" })),
    /Stock composition cannot be grouped by unit of measure/,
  );
  assert.throws(
    () => service.validate(stockRecipe({ groupBy: "custom.missing" })),
    /Choose product, category, or a reportable custom field/,
  );
  assert.throws(
    () =>
      service.validate(
        stockRecipe({
          filters: { category: null, unitOfMeasure: null },
          visualization: "donut",
          topN: 8,
        }),
      ),
    /Choose a unit of measure before using a donut chart/,
  );
  assert.throws(
    () =>
      service.validate(
        stockRecipe({
          filters: { category: null, unitOfMeasure: "crates" },
          visualization: "donut",
          topN: 9,
        }),
      ),
    /Donut charts support at most 8 named slices/,
  );
  assert.throws(
    () =>
      service.validate(
        stockRecipe({
          groupBy: "category",
          filters: { category: "Equipment", unitOfMeasure: "crates" },
          visualization: "donut",
          topN: 8,
        }),
      ),
    /Remove the category filter when grouping a donut chart by category/,
  );

  assert.throws(
    () =>
      buildInventoryCompositionReport(db, {
        groupBy: "product",
        visualization: "donut",
        topN: 8,
      }),
    /Choose a unit of measure before using a donut chart/,
  );
  assert.throws(
    () =>
      buildInventoryCompositionReport(db, {
        groupBy: "product",
        unitOfMeasure: "crates",
        visualization: "donut",
        topN: 9,
      }),
    /Donut charts support at most 8 named slices/,
  );
  assert.throws(
    () => buildInventoryCompositionReport(db, { groupBy: "unit_of_measure" }),
    /Stock composition cannot be grouped by unit of measure/,
  );

  const mixedUnitBar = service.validate(
    stockRecipe({
      filters: { category: null, unitOfMeasure: null },
      topN: 20,
      visualization: "bar",
    }),
  );
  assert.equal(mixedUnitBar.filters.unitOfMeasure, null);
  assert.equal(mixedUnitBar.topN, 20);
  const tableRecipe = service.validate(stockRecipe({ visualization: "table" }));
  assert.equal(tableRecipe.visualization, "table");

  const saved = service.create({
    actor: operator,
    name: "Crate stock share",
    description: "Current crate stock composition",
    visibility: "private",
    recipe: donutRecipe,
  });
  assert.equal(saved.validation_status, "ready");
  assert.deepEqual(saved.recipe, validated);

  db.close();
  const reopened = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: false,
  });
  const persisted = reportDefinitions.getReportDefinition(reopened, {
    actor: operator,
    reportId: saved.id,
  });
  assert.equal(persisted.validation_status, "ready");
  assert.deepEqual(persisted.recipe, validated);
  reopened.close();
});

test("built-in Stock Snapshot renders accessible visuals and hides retained custom donuts", async () => {
  const { admin, db, inventory, operator } = await createTestContext(
    "inventory-stock-composition-render-",
  );
  const { createReportDefinitionService } = await freshImport(
    "../src/services/report-definitions.js"
  );
  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");
  const definitions = createReportDefinitionService({ db });
  const cell = inventory.listCells(db)[0];
  const alpha = createProduct(inventory, db, {
    sku: "COMP-RENDER-A",
    name: "Render Alpha",
    category: "Equipment",
    unit: "crates",
  });
  const beta = createProduct(inventory, db, {
    sku: "COMP-RENDER-B",
    name: "Render Beta",
    category: "Equipment",
    unit: "crates",
  });
  const gamma = createProduct(inventory, db, {
    sku: "COMP-RENDER-C",
    name: "Render Gamma",
    category: "Equipment",
    unit: "crates",
  });
  stockProducts(inventory, db, admin, cell.id, [
    { product: alpha, quantity: 40 },
    { product: beta, quantity: 30 },
    { product: gamma, quantity: 20 },
  ]);
  const definition = definitions.create({
    actor: operator,
    name: "Printable crate composition",
    description: "Share of current crate stock",
    visibility: "private",
    recipe: stockRecipe({
      filters: { category: null, unitOfMeasure: "crates" },
      topN: 2,
      visualization: "donut",
    }),
  });

  const html = createReportsPages({ db }).renderReports(
    operator,
    null,
    new URL(`http://localhost/reports#saved-report-${definition.id}`),
  );
  const stockSnapshot = html.match(
    /<article\b[^>]*data-report-inline="stock-snapshot"[\s\S]*?<\/article>/,
  )?.[0];
  const chartKey = "stock-snapshot-unit-1";

  assert.ok(stockSnapshot, "expected the built-in Stock Snapshot report");
  assert.match(stockSnapshot, /aria-label="Stock Snapshot"/);
  assert.match(stockSnapshot, /data-stock-composition-report/);
  assert.match(stockSnapshot, /data-report-has-visuals="true"/);
  assert.match(stockSnapshot, /data-report-visual-unit="crates"/);
  assert.match(stockSnapshot, /class="report-bar-chart"/);
  assert.match(
    stockSnapshot,
    new RegExp(
      `role="img"[\\s\\S]*aria-labelledby="${chartKey}-chart-title ${chartKey}-chart-description"`,
    ),
  );
  assert.match(stockSnapshot, /On-hand Stock By Name · crates/);
  assert.match(stockSnapshot, /Render Alpha[\s\S]*40 crates/);
  assert.match(stockSnapshot, /Render Beta[\s\S]*30 crates/);
  assert.match(stockSnapshot, /Render Gamma[\s\S]*20 crates/);
  assert.match(stockSnapshot, /Render Alpha[\s\S]*40 crates · 44\.4%/);
  assert.match(
    stockSnapshot,
    /Percentages use the complete total for each compatible unit, including the “Other” slice\./,
  );
  assert.doesNotMatch(html, new RegExp(`data-report-inline="saved-report-${definition.id}"`));
  assert.doesNotMatch(html, /Printable crate composition|Share of current crate stock/);
  assert.doesNotMatch(html, /class="report-donut-svg"/);
  assert.doesNotMatch(html, /<canvas/i);

  db.close();
});
