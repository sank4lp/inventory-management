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
  return { admin, db, inventory, operator };
}

function trendRecipe(overrides = {}) {
  return {
    type: "movement_over_time",
    metric: "total_handled",
    groupBy: "week",
    filters: {
      category: "Dry Goods",
      unitOfMeasure: "kg",
    },
    dateRange: "last_90_days",
    topN: 12,
    visualization: "table",
    columns: ["period", "product.unit_of_measure", "total_handled"],
    ...overrides,
  };
}

function exceptionsRecipe(overrides = {}) {
  return {
    type: "exceptions",
    metric: "affected_tasks",
    groupBy: "cell",
    filters: {
      category: "Field Supply",
      unitOfMeasure: "crates",
    },
    dateRange: "this_month",
    topN: 15,
    visualization: "bar",
    columns: [
      "group_label",
      "product.unit_of_measure",
      "exception_count",
      "exception_quantity",
      "affected_tasks",
    ],
    ...overrides,
  };
}

function createProduct(inventory, db, { sku, name, category, unit }) {
  return inventory.createProduct(db, {
    sku,
    name,
    brand: "Custom Report Test",
    category,
    unit_of_measure: unit,
    items_per_cell: 1000,
  });
}

function stockProduct({ admin, db, inventory, product, cellId, quantity = 100 }) {
  inventory.createAdjustment(db, {
    cellId,
    userId: admin.id,
    reason: "Custom report expansion fixture",
    lines: [{ productId: product.id, absoluteQuantity: quantity }],
  });
}

function completeWithActual({ db, inventory, operator, task, actual, completedAt }) {
  assert.equal(task.lines.length, 1, "fixture should allocate one task line");
  inventory.completeTask(db, {
    taskId: task.id,
    actualQuantities: { [task.lines[0].id]: actual },
    userId: operator.id,
    note: "Custom report expansion fixture",
  });
  db.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?").run(completedAt, task.id);
  return task;
}

test("movement trend and exception recipes validate and round-trip without opening custom SQL", async () => {
  const { db, operator } = await createTestContext("inventory-custom-report-recipes-");
  const { createReportDefinitionService } = await freshImport(
    "../src/services/report-definitions.js"
  );
  const definitions = createReportDefinitionService({ db });

  assert.deepEqual(definitions.validate(trendRecipe()), {
    version: 1,
    ...trendRecipe(),
  });
  assert.deepEqual(definitions.validate(JSON.stringify(exceptionsRecipe())), {
    version: 1,
    ...exceptionsRecipe(),
  });

  for (const invalid of [
    trendRecipe({ metric: "pick_frequency" }),
    trendRecipe({ groupBy: "product" }),
    trendRecipe({ visualization: "donut" }),
  ]) {
    assert.throws(() => definitions.validate(invalid), /supported|day, week, or month/i);
  }
  for (const invalid of [
    exceptionsRecipe({ metric: "picked_quantity" }),
    exceptionsRecipe({ groupBy: "month" }),
    exceptionsRecipe({ visualization: "donut" }),
  ]) {
    assert.throws(() => definitions.validate(invalid), /supported exception/i);
  }
  assert.throws(
    () => definitions.validate({ ...trendRecipe(), query: "SELECT * FROM tasks" }),
    /Custom SQL is not accepted/,
  );

  const trend = definitions.create({
    actor: operator,
    name: "Weekly handled stock",
    visibility: "private",
    recipe: trendRecipe(),
  });
  const exceptions = definitions.create({
    actor: operator,
    name: "Exceptions by cell",
    visibility: "private",
    recipe: exceptionsRecipe(),
  });

  assert.deepEqual(
    definitions.get({ actor: operator, reportId: trend.id }).recipe,
    { version: 1, ...trendRecipe() },
  );
  assert.deepEqual(
    definitions.get({ actor: operator, reportId: exceptions.id }).recipe,
    { version: 1, ...exceptionsRecipe() },
  );
  assert.equal(trend.validation_status, "ready");
  assert.equal(exceptions.validation_status, "ready");

  db.close();
});

test("movement trend and exception queries use completed actuals and never combine units", async () => {
  const context = await createTestContext("inventory-custom-report-query-");
  const { admin, db, inventory, operator } = context;
  const { buildExceptionsReport, buildMovementOverTimeReport } = await freshImport(
    "../src/services/reports.js"
  );
  const [crateCell, kilogramCell] = inventory.listCells(db).slice(0, 2);
  assert.ok(crateCell);
  assert.ok(kilogramCell);

  const crateProduct = createProduct(inventory, db, {
    sku: "REPORT-CRATE",
    name: "Field Crate",
    category: "Field Supply",
    unit: "crates",
  });
  const kilogramProduct = createProduct(inventory, db, {
    sku: "REPORT-RICE",
    name: "Bulk Rice",
    category: "Dry Goods",
    unit: "kg",
  });
  stockProduct({ admin, db, inventory, product: crateProduct, cellId: crateCell.id });
  stockProduct({ admin, db, inventory, product: kilogramProduct, cellId: kilogramCell.id });

  completeWithActual({
    db,
    inventory,
    operator,
    task: inventory.allocatePick(db, {
      userId: operator.id,
      productId: crateProduct.id,
      quantity: 6,
      preferredCellId: crateCell.id,
    }),
    actual: 4,
    completedAt: "2026-07-01T08:00:00.000Z",
  });
  completeWithActual({
    db,
    inventory,
    operator,
    task: inventory.planPut(db, {
      userId: operator.id,
      productId: crateProduct.id,
      quantity: 5,
      preferredCellId: crateCell.id,
    }),
    actual: 3,
    completedAt: "2026-07-02T08:00:00.000Z",
  });
  completeWithActual({
    db,
    inventory,
    operator,
    task: inventory.allocatePick(db, {
      userId: operator.id,
      productId: kilogramProduct.id,
      quantity: 10,
      preferredCellId: kilogramCell.id,
    }),
    actual: 7,
    completedAt: "2026-07-01T09:00:00.000Z",
  });
  completeWithActual({
    db,
    inventory,
    operator,
    task: inventory.planPut(db, {
      userId: operator.id,
      productId: kilogramProduct.id,
      quantity: 5,
      preferredCellId: kilogramCell.id,
    }),
    actual: 5,
    completedAt: "2026-07-02T09:00:00.000Z",
  });

  const trend = buildMovementOverTimeReport(db, {
    metric: "total_handled",
    groupBy: "day",
    topN: 10,
    visualization: "bar",
  });
  assert.equal(trend.comparison, "separate_by_unit");
  assert.deepEqual(trend.units, ["crates", "kg"]);
  assert.equal(trend.totals, null);
  assert.deepEqual(trend.totalsByUnit, {
    crates: {
      picked_quantity: 4,
      put_quantity: 3,
      total_handled: 7,
      net_change: -1,
    },
    kg: {
      picked_quantity: 7,
      put_quantity: 5,
      total_handled: 12,
      net_change: -2,
    },
  });
  assert.deepEqual(
    trend.seriesByUnit.map((series) => ({
      unit: series.unitOfMeasure,
      values: series.rows.map((row) => [
        row.period,
        row.picked_quantity,
        row.put_quantity,
        row.total_handled,
        row.net_change,
      ]),
    })),
    [
      {
        unit: "crates",
        values: [
          ["2026-07-01", 4, 0, 4, -4],
          ["2026-07-02", 0, 3, 3, 3],
        ],
      },
      {
        unit: "kg",
        values: [
          ["2026-07-01", 7, 0, 7, -7],
          ["2026-07-02", 0, 5, 5, 5],
        ],
      },
    ],
  );

  const exceptions = buildExceptionsReport(db, {
    metric: "exception_quantity",
    groupBy: "product",
    topN: 10,
    visualization: "table",
  });
  assert.equal(exceptions.comparison, "separate_by_unit");
  assert.deepEqual(exceptions.units, ["crates", "kg"]);
  assert.equal(exceptions.totals, null);
  assert.equal(exceptions.totalMatchingRows, 3);
  assert.deepEqual(exceptions.totalsByUnit, {
    crates: {
      exception_quantity: 4,
      exception_count: 2,
      affected_tasks: 2,
    },
    kg: {
      exception_quantity: 3,
      exception_count: 1,
      affected_tasks: 1,
    },
  });
  assert.deepEqual(
    exceptions.rankingsByUnit.map((ranking) => ({
      unit: ranking.unitOfMeasure,
      rows: ranking.rows.map((row) => [
        row.name,
        row.exception_quantity,
        row.exception_count,
        row.affected_tasks,
      ]),
    })),
    [
      { unit: "crates", rows: [["Field Crate", 4, 2, 2]] },
      { unit: "kg", rows: [["Bulk Rice", 3, 1, 1]] },
    ],
  );

  const kilogramOnly = buildExceptionsReport(db, {
    metric: "exception_count",
    groupBy: "category",
    unitOfMeasure: "kg",
    topN: 10,
  });
  assert.deepEqual(kilogramOnly.units, ["kg"]);
  assert.equal(kilogramOnly.comparison, "comparable");
  assert.deepEqual(kilogramOnly.rows.map((row) => row.name), ["Dry Goods"]);

  db.close();
});

test("reports page presents a finite curated question library without custom creation controls", async () => {
  const { db, operator } = await createTestContext(
    "inventory-curated-report-library-",
  );
  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");
  const html = createReportsPages({ db }).renderReports(
    operator,
    null,
    new URL("http://localhost/reports"),
  );

  assert.match(html, /Curated Questions/);
  assert.match(html, /Choose A Report/);
  assert.match(html, /Choose the warehouse question you want answered\./);
  assert.match(html, /aria-label="Curated warehouse reports"/);
  assert.match(html, /Warehouse Questions/);

  const questions = [
    [
      "product-movement",
      "Product Movement & Demand",
      "Which products were picked most in the selected timeframe?",
    ],
    ["stock-snapshot", "Stock Snapshot", "What stock can we pick right now?"],
    [
      "replenishment-watch",
      "Replenishment Watch",
      "Which products are out of stock or down to one normal location batch?",
    ],
    [
      "slow-moving-stock",
      "Slow-Moving Stock",
      "Which stocked products were not picked in the selected timeframe?",
    ],
    [
      "movement",
      "Stock Change Over Time",
      "Did inventory increase or decrease during the selected timeframe?",
    ],
    [
      "team-activity",
      "Team Throughput",
      "What pick and put-away work did each team member complete?",
    ],
    [
      "issues",
      "Exception Hotspots",
      "Where did completed warehouse work fall short of plan?",
    ],
    [
      "adjustments",
      "Adjustment Audit",
      "Who manually changed stock, when, and why?",
    ],
  ];
  for (const [key, title, question] of questions) {
    assert.match(html, new RegExp(`data-report-open="${key}"`));
    assert.match(html, new RegExp(`data-report-inline="${key}"`));
    assert.match(html, new RegExp(`data-report-print-option="${key}"`));
    assert.ok(html.includes(title.replaceAll("&", "&amp;")), `expected report title ${title}`);
    assert.ok(
      html.includes(question.replaceAll("&", "&amp;")),
      `expected report question ${question}`,
    );
  }
  assert.equal([...html.matchAll(/\bdata-report-open="/g)].length, questions.length);
  assert.equal([...html.matchAll(/\bdata-report-inline="/g)].length, questions.length);

  assert.doesNotMatch(html, /data-report-builder/);
  assert.doesNotMatch(html, /Create a private report/i);
  assert.doesNotMatch(html, /My Reports|Shared Reports/);
  assert.doesNotMatch(html, /custom-report-preview/i);

  db.close();
});
