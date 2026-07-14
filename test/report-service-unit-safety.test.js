import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

async function createContext(prefix) {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(sandbox);
  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const reports = await freshImport("../src/services/reports.js");
  const productFields = await freshImport("../src/services/product-fields.js");
  const unitConversions = await freshImport("../src/services/unit-conversions.js");
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
  const cell = inventory.listCells(db)[0];
  assert.ok(cell);
  return {
    admin,
    cell,
    db,
    inventory,
    operator,
    productFields,
    reports,
    unitConversions,
  };
}

function createProduct(inventory, db, { sku, name, category, unit }) {
  return inventory.createProduct(db, {
    sku,
    name,
    brand: "Report Safety",
    category,
    unit_of_measure: unit,
    items_per_cell: 100,
  });
}

function insertCompletedTask(
  db,
  {
    userId,
    cellId,
    type = "pick",
    completedAt = "2026-07-01T08:00:00.000Z",
    lines,
  },
) {
  const result = db
    .prepare(
      `
        INSERT INTO tasks (
          type, status, summary, created_by, started_at, last_touched_at, completed_at
        )
        VALUES (?, 'completed', ?, ?, ?, ?, ?)
      `,
    )
    .run(type, "Report safety fixture", userId, completedAt, completedAt, completedAt);
  const taskId = Number(result.lastInsertRowid);
  const insertLine = db.prepare(
    `
      INSERT INTO task_lines (
        task_id, product_id, cell_id, planned_quantity, actual_quantity,
        exception_quantity, guidance_color, unit_of_measure
      )
      VALUES (?, ?, ?, ?, ?, ?, 'blue', ?)
    `,
  );
  for (const line of lines) {
    insertLine.run(
      taskId,
      line.product.id,
      cellId,
      line.planned ?? line.actual,
      line.actual,
      line.exception ?? 0,
      line.product.unit_of_measure,
    );
  }
  return taskId;
}

test("frequency rankings aggregate category and custom groups across units without summing quantities", async () => {
  const context = await createContext("inventory-report-frequency-safety-");
  const { admin, cell, db, inventory, operator, productFields, reports } = context;
  const booksCrates = createProduct(inventory, db, {
    sku: "FREQ-BOOK-CRATE",
    name: "Crated Books",
    category: "Books",
    unit: "Crates",
  });
  const booksKg = createProduct(inventory, db, {
    sku: "FREQ-BOOK-KG",
    name: "Books By Weight",
    category: "books",
    unit: "kg",
  });
  const other = createProduct(inventory, db, {
    sku: "FREQ-OTHER",
    name: "Other Product",
    category: "Other",
    unit: "pieces",
  });
  const caseUpper = createProduct(inventory, db, {
    sku: "FREQ-CASE-UPPER",
    name: "Upper Case Unit",
    category: "Case Goods",
    unit: "Cases",
  });
  const caseLower = createProduct(inventory, db, {
    sku: "FREQ-CASE-LOWER",
    name: "Lower Case Unit",
    category: "case goods",
    unit: "cases",
  });
  const grade = productFields.createCustomProductField(db, {
    actor: admin,
    label: "Demand Band",
    dataType: "text",
    reportable: 1,
  });
  productFields.setProductAttributeValue(db, {
    actor: operator,
    productId: booksCrates.id,
    fieldId: grade.id,
    value: "High Demand",
  });
  productFields.setProductAttributeValue(db, {
    actor: operator,
    productId: booksKg.id,
    fieldId: grade.id,
    value: "high demand",
  });

  const picks = [
    ...Array(3).fill(booksCrates),
    ...Array(3).fill(booksKg),
    ...Array(4).fill(other),
    caseUpper,
    caseLower,
  ];
  picks.forEach((product, index) => {
    insertCompletedTask(db, {
      userId: operator.id,
      cellId: cell.id,
      completedAt: `2026-07-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      lines: [{ product, actual: 1 }],
    });
  });

  const categoryFrequency = reports.buildProductMovementReport(db, {
    metric: "pick_frequency",
    groupBy: "category",
    topN: 10,
  });
  assert.equal(categoryFrequency.rankingMode, "dimensionless_across_units");
  assert.equal(categoryFrequency.rows[0].name.toLowerCase(), "books");
  assert.equal(categoryFrequency.rows[0].pick_frequency, 6);
  assert.equal(categoryFrequency.rows[0].unit_of_measure, null);
  assert.equal(categoryFrequency.rows[0].picked_quantity, null);
  assert.equal(categoryFrequency.rows[0].quantity_comparison, "separate_by_unit");
  assert.deepEqual(
    categoryFrequency.rows[0].units.map((unit) => unit.toLowerCase()),
    ["crates", "kg"],
  );
  assert.equal(categoryFrequency.leaders.mostFrequentlyPicked.pick_frequency, 6);

  const customFrequency = reports.buildProductMovementReport(db, {
    metric: "pick_frequency",
    groupBy: grade.field_key,
    topN: 10,
  });
  const highDemand = customFrequency.rows.find(
    (row) => row.name.toLowerCase() === "high demand",
  );
  assert.ok(highDemand);
  assert.equal(highDemand.pick_frequency, 6);
  assert.equal(highDemand.unit_of_measure, null);
  assert.equal(highDemand.picked_quantity, null);

  const quantityByCategory = reports.buildProductMovementReport(db, {
    metric: "picked_quantity",
    groupBy: "category",
    topN: 20,
  });
  const bookQuantityRows = quantityByCategory.rows.filter(
    (row) => row.name.toLowerCase() === "books",
  );
  assert.equal(bookQuantityRows.length, 2);
  assert.deepEqual(
    bookQuantityRows
      .map((row) => [row.unit_of_measure.toLowerCase(), row.picked_quantity])
      .sort(),
    [
      ["crates", 3],
      ["kg", 3],
    ],
  );
  const caseRows = quantityByCategory.rows.filter(
    (row) => row.name.toLowerCase() === "case goods",
  );
  assert.equal(caseRows.length, 1);
  assert.equal(caseRows[0].picked_quantity, 2);
  assert.equal(caseRows[0].unit_of_measure.toLowerCase(), "cases");

  db.close();
});

test("dimensionless exception rankings combine units and count affected tasks distinctly", async () => {
  const context = await createContext("inventory-report-exception-safety-");
  const { cell, db, inventory, operator, reports } = context;
  const booksCrates = createProduct(inventory, db, {
    sku: "EXC-BOOK-CRATE",
    name: "Crated Books",
    category: "Books",
    unit: "crates",
  });
  const booksKg = createProduct(inventory, db, {
    sku: "EXC-BOOK-KG",
    name: "Books By Weight",
    category: "books",
    unit: "kg",
  });
  const other = createProduct(inventory, db, {
    sku: "EXC-OTHER",
    name: "Other Product",
    category: "Other",
    unit: "pieces",
  });

  insertCompletedTask(db, {
    userId: operator.id,
    cellId: cell.id,
    lines: [
      { product: booksCrates, planned: 3, actual: 1, exception: 2 },
      { product: booksKg, planned: 4, actual: 1, exception: 3 },
    ],
  });
  insertCompletedTask(db, {
    userId: operator.id,
    cellId: cell.id,
    completedAt: "2026-07-02T08:00:00.000Z",
    lines: [{ product: booksCrates, planned: 2, actual: 1, exception: 1 }],
  });
  insertCompletedTask(db, {
    userId: operator.id,
    cellId: cell.id,
    completedAt: "2026-07-03T08:00:00.000Z",
    lines: [{ product: other, planned: 11, actual: 1, exception: 10 }],
  });

  const countReport = reports.buildExceptionsReport(db, {
    metric: "exception_count",
    groupBy: "category",
    topN: 10,
  });
  assert.equal(countReport.comparison, "comparable");
  assert.equal(countReport.rankingMode, "dimensionless_across_units");
  assert.equal(countReport.rankingsByUnit.length, 1);
  assert.equal(countReport.rankingsByUnit[0].unitOfMeasure, null);
  assert.equal(countReport.rows[0].name.toLowerCase(), "books");
  assert.equal(countReport.rows[0].exception_count, 3);
  assert.equal(countReport.rows[0].affected_tasks, 2);
  assert.equal(countReport.rows[0].exception_quantity, null);
  assert.equal(countReport.rows[0].unit_of_measure, null);
  assert.deepEqual(countReport.rows[0].units, ["crates", "kg"]);
  assert.deepEqual(countReport.totals, {
    exception_quantity: null,
    exception_count: 4,
    affected_tasks: 3,
  });

  const taskReport = reports.buildExceptionsReport(db, {
    metric: "affected_tasks",
    groupBy: "category",
    topN: 10,
  });
  assert.equal(taskReport.rows[0].name.toLowerCase(), "books");
  assert.equal(taskReport.rows[0].affected_tasks, 2);

  const quantityReport = reports.buildExceptionsReport(db, {
    metric: "exception_quantity",
    groupBy: "category",
    topN: 10,
  });
  assert.equal(quantityReport.comparison, "separate_by_unit");
  assert.equal(quantityReport.rankingMode, "by_unit");
  const bookQuantityRows = quantityReport.rows.filter(
    (row) => row.name.toLowerCase() === "books",
  );
  assert.deepEqual(
    bookQuantityRows
      .map((row) => [row.unit_of_measure, row.exception_quantity])
      .sort(),
    [
      ["crates", 3],
      ["kg", 3],
    ],
  );

  db.close();
});

test("built-in movement and issue rows follow chained product unit conversions", async () => {
  const context = await createContext("inventory-report-built-in-conversion-");
  const { admin, cell, db, inventory, operator, reports, unitConversions } = context;
  const product = createProduct(inventory, db, {
    sku: "CHAINED-RICE",
    name: "Rice Sack",
    category: "Rice",
    unit: "sacks",
  });
  insertCompletedTask(db, {
    userId: operator.id,
    cellId: cell.id,
    completedAt: "2026-07-01T08:00:00.000Z",
    lines: [{ product, planned: 3, actual: 2, exception: 1 }],
  });

  const conversionService = unitConversions.createUnitConversionService({ db });
  const kilograms = conversionService.preview({
    actor: admin,
    productId: product.id,
    targetUnit: "kg",
    factor: 25,
    precision: 2,
  });
  conversionService.apply({
    actor: admin,
    productId: product.id,
    targetUnit: "kg",
    factor: 25,
    precision: 2,
    previewToken: kilograms.token,
  });
  const grams = conversionService.preview({
    actor: admin,
    productId: product.id,
    targetUnit: "g",
    factor: 1000,
    precision: 0,
  });
  conversionService.apply({
    actor: admin,
    productId: product.id,
    targetUnit: "g",
    factor: 1000,
    precision: 0,
    previewToken: grams.token,
  });

  const builtIns = reports.buildReports(db, {});
  assert.deepEqual(builtIns.movementSummary, [
    {
      movement_date: "2026-07-01",
      unit_of_measure: "g",
      picked: 50000,
      put_away: 0,
      net_change: -50000,
    },
  ]);
  assert.equal(builtIns.exceptions.length, 1);
  assert.equal(builtIns.exceptions[0].unit_of_measure, "g");
  assert.equal(builtIns.exceptions[0].planned_quantity, 75000);
  assert.equal(builtIns.exceptions[0].actual_quantity, 50000);
  assert.equal(builtIns.exceptions[0].exception_quantity, 25000);

  const movement = reports.buildProductMovementReport(db, {
    metric: "picked_quantity",
    groupBy: "product",
    topN: 10,
  });
  const row = movement.rows.find((candidate) => candidate.product_id === product.id);
  assert.ok(row);
  assert.equal(row.unit_of_measure, "g");
  assert.equal(row.picked_quantity, 50000);

  db.close();
});
