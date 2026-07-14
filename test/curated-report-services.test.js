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
  const cells = db.prepare("SELECT id FROM cells WHERE active = 1 ORDER BY id").all();
  assert.ok(cells.length >= 12, "expected enough seeded locations for report fixtures");
  return { admin, cells, db, inventory, operator, reports, unitConversions };
}

function createProduct(inventory, db, {
  sku,
  name,
  unit = "pieces",
  itemsPerCell = 10,
  category = "Report Fixtures",
}) {
  return inventory.createProduct(db, {
    sku,
    name,
    brand: "Curated Reports",
    category,
    unit_of_measure: unit,
    items_per_cell: itemsPerCell,
  });
}

function setStock(db, productId, cellId, quantity) {
  db.prepare(
    `
      INSERT INTO inventory_balances (
        product_id, cell_id, available_quantity, reserved_quantity
      )
      VALUES (?, ?, ?, 0)
      ON CONFLICT(product_id, cell_id) DO UPDATE SET
        available_quantity = excluded.available_quantity,
        reserved_quantity = 0
    `,
  ).run(productId, cellId, quantity);
}

function insertTask(db, {
  userId,
  type = "pick",
  status = "completed",
  startedAt,
  completedAt,
  lines = [],
}) {
  const lastTouchedAt = completedAt || startedAt;
  const result = db
    .prepare(
      `
        INSERT INTO tasks (
          type, status, summary, created_by, started_at, last_touched_at, completed_at
        )
        VALUES (?, ?, 'Curated report fixture', ?, ?, ?, ?)
      `,
    )
    .run(type, status, userId, startedAt, lastTouchedAt, completedAt || null);
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
      line.cellId,
      line.planned ?? line.actual,
      line.actual,
      line.exception ?? 0,
      line.product.unit_of_measure,
    );
  }
  return taskId;
}

test("replenishment watch applies the one-batch rule without combining units", async () => {
  const context = await createContext("inventory-replenishment-watch-");
  const { admin, cells, db, inventory, reports, unitConversions } = context;
  db.prepare("UPDATE products SET active = 0").run();
  const out = createProduct(inventory, db, {
    sku: "WATCH-OUT",
    name: "No Stock",
    unit: "crates",
    itemsPerCell: 12,
  });
  const low = createProduct(inventory, db, {
    sku: "WATCH-LOW",
    name: "Low Stock",
    unit: "kg",
    itemsPerCell: 100,
  });
  const boundary = createProduct(inventory, db, {
    sku: "WATCH-BOUNDARY",
    name: "One Full Batch",
    unit: "pieces",
    itemsPerCell: 10,
  });
  const healthy = createProduct(inventory, db, {
    sku: "WATCH-HEALTHY",
    name: "Above One Batch",
    unit: "boxes",
    itemsPerCell: 10,
  });
  const inactiveCellOnly = createProduct(inventory, db, {
    sku: "WATCH-INACTIVE-CELL",
    name: "Inactive Cell Stock",
    unit: "rolls",
    itemsPerCell: 20,
  });
  const inactiveProduct = createProduct(inventory, db, {
    sku: "WATCH-INACTIVE-PRODUCT",
    name: "Inactive Product",
    unit: "packs",
    itemsPerCell: 20,
  });

  setStock(db, low.id, cells[0].id, 50);
  setStock(db, boundary.id, cells[1].id, 10);
  setStock(db, healthy.id, cells[2].id, 11);
  setStock(db, inactiveCellOnly.id, cells[3].id, 20);
  setStock(db, inactiveProduct.id, cells[4].id, 0);
  db.prepare("UPDATE cells SET active = 0 WHERE id = ?").run(cells[3].id);
  db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(inactiveProduct.id);

  const report = reports.buildReplenishmentWatchReport(db);
  const bySku = Object.fromEntries(report.rows.map((row) => [row.sku, row]));

  assert.deepEqual(report.statusCounts, {
    out_of_stock: 2,
    one_batch_or_less: 2,
    total: 4,
  });
  assert.equal(report.comparison, "dimensionless_status_counts");
  assert.equal(bySku[out.sku].status, "out_of_stock");
  assert.equal(bySku[out.sku].available_quantity, 0);
  assert.equal(bySku[low.sku].status, "one_batch_or_less");
  assert.equal(bySku[low.sku].available_quantity, 50);
  assert.equal(bySku[low.sku].items_per_cell, 100);
  assert.equal(bySku[low.sku].batch_ratio, 0.5);
  assert.equal(bySku[low.sku].unit_of_measure, "kg");
  assert.equal(bySku[boundary.sku].batch_ratio, 1);
  assert.equal(bySku[inactiveCellOnly.sku].status, "out_of_stock");
  assert.equal(bySku[inactiveCellOnly.sku].occupied_locations, 0);
  assert.equal(bySku[healthy.sku], undefined);
  assert.equal(bySku[inactiveProduct.sku], undefined);
  assert.deepEqual(report.units, ["crates", "kg", "pieces", "rolls"]);
  assert.equal(Object.hasOwn(report, "available_quantity"), false);

  const preview = unitConversions.previewProductUnitConversion(db, {
    actor: admin,
    productId: low.id,
    targetUnit: "grams",
    factor: 1000,
    precision: 0,
  });
  unitConversions.applyProductUnitConversion(db, {
    actor: admin,
    productId: low.id,
    targetUnit: "grams",
    factor: 1000,
    precision: 0,
    previewToken: preview.token,
  });
  const afterConversion = reports.buildReplenishmentWatchReport(db);
  const convertedLow = afterConversion.rows.find((row) => row.sku === low.sku);
  assert.equal(convertedLow.status, "one_batch_or_less");
  assert.equal(convertedLow.unit_of_measure, "grams");
  assert.equal(convertedLow.available_quantity, 50_000);
  assert.equal(convertedLow.items_per_cell, 100_000);
  assert.equal(convertedLow.batch_ratio, 0.5);

  db.close();
});

test("slow-moving stock treats only positive completed picks in the inclusive range as usage", async () => {
  const context = await createContext("inventory-slow-moving-stock-");
  const { cells, db, inventory, operator, reports } = context;
  const products = [
    ["SLOW-NEVER", "Never Picked", "crates"],
    ["SLOW-RANGE", "Picked In Range", "kg"],
    ["SLOW-PUT", "Put Only", "pieces"],
    ["SLOW-ZERO", "Zero Quantity Pick", "boxes"],
    ["SLOW-BEFORE", "Picked Before Range", "rolls"],
    ["SLOW-AFTER", "Picked After Range", "packs"],
    ["SLOW-FROM", "Picked At Range Start", "bottles"],
    ["SLOW-TO", "Picked At Range End", "cases"],
    ["SLOW-EMPTY", "No Current Stock", "bags"],
  ].map(([sku, name, unit]) => createProduct(inventory, db, { sku, name, unit }));
  const [never, inRange, putOnly, zeroPick, beforeRange, afterRange, atFrom, atTo, empty] = products;
  products.slice(0, -1).forEach((product, index) => {
    setStock(db, product.id, cells[index].id, 5 + index);
  });
  const line = (product, index, actual, exception = 0) => ({
    product,
    cellId: cells[index].id,
    actual,
    exception,
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-07-10T08:00:00.000Z",
    completedAt: "2026-07-10T08:05:00.000Z",
    lines: [line(inRange, 1, 2)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "put",
    startedAt: "2026-07-11T08:00:00.000Z",
    completedAt: "2026-07-11T08:05:00.000Z",
    lines: [line(putOnly, 2, 3)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-07-12T08:00:00.000Z",
    completedAt: "2026-07-12T08:05:00.000Z",
    lines: [line(zeroPick, 3, 0, 2)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-06-15T08:00:00.000Z",
    completedAt: "2026-06-15T08:05:00.000Z",
    lines: [line(beforeRange, 4, 1)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-08-05T08:00:00.000Z",
    completedAt: "2026-08-05T08:05:00.000Z",
    lines: [line(afterRange, 5, 1)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:00:00.000Z",
    lines: [line(atFrom, 6, 1)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-07-31T23:59:59.999Z",
    completedAt: "2026-07-31T23:59:59.999Z",
    lines: [line(atTo, 7, 1)],
  });

  const fromAt = "2026-07-01T00:00:00.000Z";
  const toAt = "2026-07-31T23:59:59.999Z";
  const report = reports.buildSlowMovingStockReport(db, { fromAt, toAt });
  const bySku = Object.fromEntries(report.rows.map((row) => [row.sku, row]));

  assert.deepEqual(new Set(Object.keys(bySku)), new Set([
    never.sku,
    putOnly.sku,
    zeroPick.sku,
    beforeRange.sku,
    afterRange.sku,
  ]));
  assert.equal(bySku[never.sku].last_picked_at, null);
  assert.equal(bySku[putOnly.sku].last_picked_at, null);
  assert.equal(bySku[zeroPick.sku].last_picked_at, null);
  assert.equal(bySku[beforeRange.sku].last_picked_at, "2026-06-15T08:05:00.000Z");
  assert.equal(bySku[afterRange.sku].last_picked_at, null);
  assert.equal(bySku[inRange.sku], undefined);
  assert.equal(bySku[atFrom.sku], undefined);
  assert.equal(bySku[atTo.sku], undefined);
  assert.equal(bySku[empty.sku], undefined);
  assert.equal(report.neverPickedCount, 4);
  assert.equal(report.previouslyPickedCount, 1);
  assert.equal(report.totalMatchingRows, 5);
  assert.deepEqual(report.range, { fromAt, toAt });
  assert.equal(bySku[putOnly.sku].unit_of_measure, "pieces");

  const combined = reports.buildReports(db, { fromAt, toAt });
  assert.equal(combined.slowMovingStock.totalMatchingRows, 5);
  assert.ok(combined.replenishmentWatch);
  assert.ok(combined.teamThroughput);

  db.close();
});

test("team throughput counts completed tasks once regardless of lines or units", async () => {
  const context = await createContext("inventory-team-throughput-");
  const { admin, cells, db, inventory, operator, reports } = context;
  const crates = createProduct(inventory, db, {
    sku: "TEAM-CRATES",
    name: "Team Crates",
    unit: "crates",
  });
  const kilograms = createProduct(inventory, db, {
    sku: "TEAM-KG",
    name: "Team Kilograms",
    unit: "kg",
  });
  const line = (product, cellIndex, actual, exception = 0) => ({
    product,
    cellId: cells[cellIndex].id,
    actual,
    exception,
  });

  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-07-10T08:00:00.000Z",
    completedAt: "2026-07-10T08:10:00.000Z",
    lines: [line(crates, 0, 2, 1), line(kilograms, 1, 20)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "put",
    startedAt: "2026-07-10T09:00:00.000Z",
    completedAt: "2026-07-10T09:30:00.000Z",
    lines: [line(crates, 0, 4)],
  });
  insertTask(db, {
    userId: admin.id,
    type: "pick",
    startedAt: "2026-06-30T23:50:00.000Z",
    completedAt: "2026-07-01T00:05:00.000Z",
    lines: [line(kilograms, 1, 5)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "adjustment",
    startedAt: "2026-07-11T10:00:00.000Z",
    completedAt: "2026-07-11T10:20:00.000Z",
    lines: [line(crates, 0, 1)],
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    status: "planned",
    startedAt: "2026-07-12T10:00:00.000Z",
    completedAt: null,
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    status: "cancelled",
    startedAt: "2026-07-13T10:00:00.000Z",
    completedAt: "2026-07-13T10:05:00.000Z",
  });
  insertTask(db, {
    userId: operator.id,
    type: "pick",
    startedAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:05:00.000Z",
    lines: [line(crates, 0, 1)],
  });

  const report = reports.buildTeamThroughputReport(db, {
    fromAt: "2026-07-01T00:00:00.000Z",
    toAt: "2026-07-31T23:59:59.999Z",
  });

  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].username, operator.username);
  assert.deepEqual(report.rows[0], {
    user_id: operator.id,
    name: operator.name,
    username: operator.username,
    completed_tasks: 2,
    completed_pick_tasks: 1,
    completed_put_tasks: 1,
    exception_tasks: 1,
    exception_free_tasks: 1,
    exception_free_percent: 50,
    average_completion_minutes: 20,
  });
  assert.equal(report.rows[1].username, admin.username);
  assert.equal(report.rows[1].completed_tasks, 1);
  assert.equal(report.rows[1].completed_pick_tasks, 1);
  assert.equal(report.rows[1].average_completion_minutes, 15);
  assert.deepEqual(report.totals, {
    completed_tasks: 3,
    completed_pick_tasks: 2,
    completed_put_tasks: 1,
    exception_tasks: 1,
    exception_free_tasks: 2,
    exception_free_percent: 66.7,
    average_completion_minutes: 18.3,
  });
  assert.equal(report.totalMatchingRows, 3);
  assert.equal(Object.hasOwn(report.rows[0], "quantity"), false);
  assert.equal(Object.hasOwn(report.rows[0], "total_duration_minutes"), false);

  db.close();
});
