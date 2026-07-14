import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

class MockResponse {
  constructor() {
    this.statusCode = null;
    this.headers = {};
    this.body = "";
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = "") {
    this.body += body;
  }
}

function formRequest({ method = "POST", url, body, cookie, headers = {} }) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = method;
  request.url = url;
  request.headers = {
    host: "localhost",
    cookie,
    "content-type": "application/x-www-form-urlencoded",
    ...headers,
  };
  return request;
}

test("core inventory flows work against a fresh seeded database", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const reports = await freshImport("../src/services/reports.js");
  const reportFormat = await freshImport("../src/services/report-format.js");
  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });

  const products = inventory.listProducts(db);
  assert.ok(products.length >= 3);

  const shoe = products.find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const productDetail = inventory.getProductDetail(db, shoe.id);
  assert.ok(productDetail);
  assert.ok(productDetail.locations.length > 0);
  assert.equal(Number(productDetail.items_per_cell), 3);
  const preferredProductCellId = productDetail.locations[0].cell_id;

  const cells = inventory.searchCells(db, "Z1-R1-C01");
  assert.equal(cells.length, 1);

  const cellDetail = inventory.getCellDetail(db, cells[0].id);
  assert.ok(cellDetail);
  assert.ok(cellDetail.products.length > 0);

  const preferredPickTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
    preferredCellId: preferredProductCellId,
  });
  assert.equal(preferredPickTask.lines[0].cell_id, preferredProductCellId);

  const cancelledPreferredPick = inventory.cancelTask(db, { taskId: preferredPickTask.id });
  assert.equal(cancelledPreferredPick.status, "cancelled");

  const pickTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 5,
  });

  assert.equal(pickTask.type, "pick");
  assert.equal(pickTask.lines.length, 2);

  const cancelledPickTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });
  const cancelledPick = inventory.cancelTask(db, { taskId: cancelledPickTask.id });
  assert.equal(cancelledPick.status, "cancelled");
  assert.throws(
    () =>
      inventory.completeTask(db, {
        taskId: cancelledPickTask.id,
        actualQuantities: Object.fromEntries(
          cancelledPickTask.lines.map((line) => [line.id, line.planned_quantity]),
        ),
        userId: 1,
        note: "Should not complete",
      }),
    /Cancelled tasks cannot be completed\./,
  );

  const completedPick = inventory.completeTask(db, {
    taskId: pickTask.id,
    actualQuantities: Object.fromEntries(
      pickTask.lines.map((line) => [line.id, line.planned_quantity]),
    ),
    userId: 1,
    note: "Smoke test pick",
  });

  assert.equal(completedPick.task.status, "completed");

  const updatedProduct = inventory.updateProductItemsPerCell(db, {
    productId: shoe.id,
    itemsPerCell: 5,
  });
  assert.equal(Number(updatedProduct.items_per_cell), 5);

  const putTask = inventory.planPut(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 16,
  });

  assert.equal(putTask.lines.length, 4);
  assert.equal(
    putTask.lines.reduce((sum, line) => sum + Number(line.planned_quantity), 0),
    16,
  );
  assert.deepEqual(
    putTask.lines.slice(0, 3).map((line) => line.logical_code),
    ["Z1-R1-C01", "Z1-R1-C02", "Z1-R1-C03"],
  );

  const preferredPutTask = inventory.planPut(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
    preferredCellId: preferredProductCellId,
  });
  assert.equal(preferredPutTask.lines[0].cell_id, preferredProductCellId);

  const completedPut = inventory.completeTask(db, {
    taskId: putTask.id,
    actualQuantities: Object.fromEntries(
      putTask.lines.map((line) => [line.id, line.planned_quantity]),
    ),
    userId: 1,
    note: "Smoke test put",
  });

  assert.equal(completedPut.task.status, "completed");

  const correctedPut = inventory.correctCompletedTask(db, {
    taskId: completedPut.task.id,
    actualQuantities: {
      [completedPut.task.lines[0].id]: Math.max(0, Number(completedPut.task.lines[0].actual_quantity) - 1),
    },
    actualCellIds: {
      [completedPut.task.lines[0].id]: completedPut.task.lines[0].cell_id,
    },
    userId: 1,
    note: "Correction test",
  });
  assert.equal(correctedPut.task.status, "completed");

  const secondProduct = products.find((product) => product.id !== shoe.id);
  assert.ok(secondProduct);
  const beforeAdjustmentCell = inventory.getCellDetail(db, putTask.lines[0].cell_id);
  const currentShoeQuantity =
    beforeAdjustmentCell.products.find((product) => product.product_id === shoe.id)?.available_quantity || 0;

  inventory.createAdjustment(db, {
    cellId: putTask.lines[0].cell_id,
    userId: 1,
    reason: "Cycle count correction",
    lines: [
      {
        productId: shoe.id,
        absoluteQuantity: Math.max(0, Number(currentShoeQuantity) - 1),
      },
      {
        productId: secondProduct.id,
        absoluteQuantity: 2,
      },
    ],
  });

  const summary = reports.buildReports(db, {});
  assert.ok(summary.stockSnapshot.length > 0);
  assert.ok(summary.userActivity.length > 0);

  const filteredSummary = reports.buildReports(db, {
    fromAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    toAt: new Date().toISOString(),
  });
  assert.ok(Array.isArray(filteredSummary.movementSummary));
  assert.ok(Array.isArray(filteredSummary.adjustments));
  assert.ok(Array.isArray(filteredSummary.recentTaskActivity));

  const oldTimestamp = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE tasks SET started_at = ?, completed_at = ? WHERE id = ?").run(
    oldTimestamp,
    oldTimestamp,
    completedPut.task.id,
  );
  db.prepare("UPDATE transactions SET created_at = ? WHERE task_id = ?").run(
    oldTimestamp,
    completedPut.task.id,
  );

  const narrowSummary = reports.buildReports(db, {
    fromAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    toAt: new Date().toISOString(),
  });
  assert.ok(
    !narrowSummary.recentTaskActivity.some((row) => row.id === completedPut.task.id),
  );
  assert.ok(
    narrowSummary.userActivity.every((row) => Number(row.transactions_recorded) >= 0),
  );
  assert.ok(
    narrowSummary.adjustments.every(
      (row) => new Date(row.created_at).getTime() >= Date.now() - 24 * 60 * 60 * 1000,
    ),
  );

  const reportHtml = createReportsPages({ db }).renderReports(
    { id: 1, name: "Admin", username: "admin", role: "admin" },
    null,
    new URL("http://localhost/reports"),
  );
  assert.match(reportHtml, /report-overview-grid/);
  assert.match(reportHtml, /data-report-open="stock-snapshot"/);
  assert.match(reportHtml, /data-report-open="movement"/);
  assert.match(reportHtml, /data-report-open="team-activity"/);
  assert.match(reportHtml, /data-report-open="issues"/);
  assert.match(reportHtml, /data-report-open="adjustments"/);
  assert.doesNotMatch(reportHtml, /Open one report at a time/);
  assert.match(reportHtml, /data-report-print-open/);
  assert.match(reportHtml, /data-report-print-option="stock-snapshot"/);
  assert.match(reportHtml, /data-report-inline="movement"/);
  assert.match(reportHtml, /data-report-format-editor/);
  assert.match(reportHtml, /Format Reports/);
  assert.match(reportHtml, /Last 30 Days/);

  const operatorReportHtml = createReportsPages({ db }).renderReports(
    { id: 2, name: "Operator", username: "operator", role: "operator" },
    null,
    new URL("http://localhost/reports"),
  );
  assert.match(operatorReportHtml, /href="\/reports"/);
  assert.match(operatorReportHtml, /report-overview-grid/);
  assert.doesNotMatch(operatorReportHtml, /href="\/devices"/);
  assert.doesNotMatch(operatorReportHtml, /href="\/backups"/);
  assert.doesNotMatch(operatorReportHtml, /href="\/admin"/);
  assert.doesNotMatch(operatorReportHtml, /data-report-format-editor/);

  reportFormat.updateReportFormatSettings(db, {
    companyName: "Rajpoot Warehouse",
    headerLabel: "Stock control report",
    fontFamily: "georgia",
    bodyFontSize: 14,
    headingFontSize: 28,
    subheadingFontSize: 12,
    accentColor: "#0f8f7a",
  });
  const formattedReportHtml = createReportsPages({ db }).renderReports(
    { id: 1, name: "Admin", username: "admin", role: "admin" },
    null,
    new URL("http://localhost/reports?format=1"),
  );
  assert.match(formattedReportHtml, /Rajpoot Warehouse/);
  assert.match(formattedReportHtml, /Stock control report/);
  assert.match(formattedReportHtml, /--report-heading-size: 28px/);
  assert.match(formattedReportHtml, /--report-body-size: 14px/);
  assert.match(formattedReportHtml, /--report-accent-color: #0f8f7a/);

  const actions = inventory.getRecommendedActions(db);
  assert.ok(actions.length > 0);
});

test("demo inventory stock can be disabled and untouched legacy sample stock is cleared", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-empty-stock-seed-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const seededDb = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: true,
  });
  const shoe = inventory.listProducts(seededDb).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);
  assert.ok(inventory.getProductDetail(seededDb, shoe.id).locations.length > 0);
  const battery = inventory.listProducts(seededDb).find((product) => product.sku === "ARMY-BATT-009");
  const batteryCell = inventory.searchCells(seededDb, "Z1-R1-C13")[0];
  assert.ok(battery);
  assert.ok(batteryCell);
  seededDb
    .prepare(
      `
        UPDATE inventory_balances
        SET available_quantity = 8
        WHERE product_id = ? AND cell_id = ?
      `,
    )
    .run(battery.id, batteryCell.id);
  seededDb
    .prepare(
      `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('legacy_demo_inventory_cleanup_at', ?, ?)
      `,
    )
    .run("2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
  seededDb.close();

  const realDb = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: false,
  });
  const cleanedShoe = inventory.listProducts(realDb).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(cleanedShoe);
  assert.equal(inventory.getProductDetail(realDb, cleanedShoe.id).locations.length, 0);
  assert.equal(
    inventory.listCells(realDb).filter((cell) => Number(cell.occupied_quantity || 0) > 0).length,
    0,
  );
  const cleanedBattery = inventory.listProducts(realDb).find((product) => product.sku === "ARMY-BATT-009");
  assert.equal(Number(cleanedBattery.total_available), 0);

  const putTask = inventory.planPut(realDb, {
    userId: 1,
    productId: cleanedShoe.id,
    quantity: 5,
  });
  assert.equal(
    putTask.lines.reduce((sum, line) => sum + Number(line.planned_quantity), 0),
    5,
  );
});

test("product quantities only count stock in active locations", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-active-product-stock-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: false,
  });
  const battery = inventory.listProducts(db).find((product) => product.sku === "ARMY-BATT-009");
  const batteryCell = inventory.searchCells(db, "Z1-R1-C13")[0];
  assert.ok(battery);
  assert.ok(batteryCell);

  db.prepare(
    `
      INSERT INTO inventory_balances (product_id, cell_id, available_quantity, reserved_quantity)
      VALUES (?, ?, 8, 0)
    `,
  ).run(battery.id, batteryCell.id);
  assert.equal(
    Number(inventory.listProducts(db).find((product) => product.id === battery.id).total_available),
    8,
  );

  db.prepare("UPDATE cells SET active = 0 WHERE id = ?").run(batteryCell.id);

  const listedBattery = inventory.listProducts(db).find((product) => product.id === battery.id);
  const batteryDetail = inventory.getProductDetail(db, battery.id);
  assert.equal(Number(listedBattery.total_available), 0);
  assert.equal(Number(batteryDetail.total_available), 0);
  assert.equal(batteryDetail.locations.length, 0);
});

test("product detail shows the latest activity time for each holding cell", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-product-cell-activity-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { formatDate } = await freshImport("../src/render.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");

  const db = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: false,
  });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const battery = inventory.listProducts(db).find((product) => product.sku === "ARMY-BATT-009");
  const batteryCell = inventory.searchCells(db, "Z1-R1-C13")[0];
  assert.ok(battery);
  assert.ok(batteryCell);

  inventory.createAdjustment(db, {
    cellId: batteryCell.id,
    userId: user.id,
    reason: "Seed product cell activity",
    lines: [{ productId: battery.id, absoluteQuantity: 4 }],
  });
  const lastActivityAt = "2026-05-20T09:15:00.000Z";
  db.prepare(
    `
      UPDATE transactions
      SET created_at = ?
      WHERE product_id = ? AND cell_id = ?
    `,
  ).run(lastActivityAt, battery.id, batteryCell.id);

  const detail = inventory.getProductDetail(db, battery.id);
  assert.equal(detail.locations.length, 1);
  assert.equal(detail.locations[0].last_activity_at, lastActivityAt);

  const html = createProductPages({ db }).renderProductDetail(user, null, detail);
  assert.match(html, /Locations Holding This Product/);
  assert.match(html, /Last Activity/);
  assert.match(html, new RegExp(`data-ping-cell[\\s\\S]*data-cell-id="${batteryCell.id}"`));
  assert.match(html, /data-show-label="Show Quantity"/);
  assert.match(html, new RegExp(`data-product-id="${battery.id}"`));
  assert.doesNotMatch(html, /data-location-count-value/);
  assert.match(html, />Show Quantity<\/button>/);
  assert.match(html, new RegExp(formatDate(lastActivityAt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("product find shows yellow quantity guidance on every mapped holding cell", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-product-find-guidance-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const { reloadAppState, getAppState } = await import("../src/server/app-state.js");
  reloadAppState();
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");
  const { requestHandler } = await freshImport("../src/server.js");

  const { db } = getAppState();
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const cookie = auth.createSessionCookie(user).split(";")[0];
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);
  const detail = inventory.getProductDetail(db, shoe.id);
  const mappedLocations = detail.locations.filter(
    (location) => location.hardware_channel && (location.controller_address || location.controller_id),
  );
  assert.ok(mappedLocations.length > 0);

  const catalogHtml = createProductPages({ db }).renderCatalogProductResults(
    inventory.listProducts(db).filter((product) => product.id === shoe.id),
  );
  assert.match(catalogHtml, /data-show-product-quantity/);
  assert.match(catalogHtml, new RegExp(`data-product-id="${shoe.id}"`));
  assert.match(catalogHtml, new RegExp(`data-activate-endpoint="/products/${shoe.id}/find"`));
  assert.match(catalogHtml, new RegExp(`data-clear-endpoint="/products/${shoe.id}/find/clear"`));
  assert.match(catalogHtml, />Show Quantity<\/button>/);

  const activeHtml = createProductPages({ db }).renderProductDetail(
    user,
    null,
    detail,
    new URL(`http://localhost/products/${shoe.id}?find_led=1`),
  );
  assert.match(activeHtml, /data-product-find-led-clear-form/);
  assert.match(activeHtml, new RegExp(`action="/products/${shoe.id}/find"`));

  const response = new MockResponse();
  await requestHandler(
    formRequest({
      url: `/products/${shoe.id}/find`,
      body: "",
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /find_led=1/);

  const payloads = db
    .prepare("SELECT payload FROM device_events WHERE event_type = 'guidance_activated' ORDER BY id")
    .all()
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => payload.taskType === "product_find");
  assert.equal(payloads.length, mappedLocations.length);
  for (const location of mappedLocations) {
    const payload = payloads.find((entry) => entry.cell === location.logical_code);
    assert.ok(payload);
    assert.equal(payload.color, "yellow");
    assert.equal(Number(payload.quantity), Number(location.available_quantity));
  }

  const activeMetadataKey = `active_product_find_guidance:${user.id}:${shoe.id}`;
  assert.ok(db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(activeMetadataKey));
  const clearedBeforeLeave = db
    .prepare("SELECT COUNT(*) AS count FROM device_events WHERE event_type = 'guidance_cleared'")
    .get().count;
  const clearResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: `/products/${shoe.id}/find/clear`,
      body: "",
      cookie,
      headers: {
        "x-requested-with": "fetch",
      },
    }),
    clearResponse,
  );

  assert.equal(clearResponse.statusCode, 204);
  const clearedAfterLeave = db
    .prepare("SELECT COUNT(*) AS count FROM device_events WHERE event_type = 'guidance_cleared'")
    .get().count;
  assert.equal(clearedAfterLeave - clearedBeforeLeave, mappedLocations.length);
  assert.equal(
    db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(activeMetadataKey),
    undefined,
  );

  const catalogFindResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: `/products/${shoe.id}/find`,
      body: new URLSearchParams({ return_to: "/products" }).toString(),
      cookie,
      headers: {
        accept: "application/json",
        "x-requested-with": "fetch",
      },
    }),
    catalogFindResponse,
  );
  assert.equal(catalogFindResponse.statusCode, 200);
  const catalogFindPayload = JSON.parse(catalogFindResponse.body);
  assert.equal(catalogFindPayload.ok, true);
  assert.equal(catalogFindPayload.productId, shoe.id);
  assert.equal(catalogFindPayload.mappedCount, mappedLocations.length);
  assert.match(catalogFindPayload.message, /in yellow/);

  const catalogClearResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: `/products/${shoe.id}/find/clear`,
      body: "",
      cookie,
      headers: {
        "x-requested-with": "fetch",
      },
    }),
    catalogClearResponse,
  );
  assert.equal(catalogClearResponse.statusCode, 204);
  assert.equal(
    db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(activeMetadataKey),
    undefined,
  );

  const movementFindResponse = new MockResponse();
  const movementPreferredCell = detail.locations[1] || detail.locations[0];
  assert.ok(movementPreferredCell);
  const movementFindBody = new URLSearchParams({
    return_to: `/pick?product_id=${shoe.id}&quantity=2`,
    product_id: String(shoe.id),
    quantity: "7",
    [`preferred_cell_${movementPreferredCell.cell_id}`]: String(movementPreferredCell.cell_id),
  });
  await requestHandler(
    formRequest({
      url: `/products/${shoe.id}/find`,
      body: movementFindBody.toString(),
      cookie,
    }),
    movementFindResponse,
  );

  assert.equal(movementFindResponse.statusCode, 302);
  assert.match(movementFindResponse.headers.Location, /^\/pick\?/);
  const movementFindRedirect = new URL(movementFindResponse.headers.Location, "http://localhost");
  assert.equal(movementFindRedirect.searchParams.get("product_id"), String(shoe.id));
  assert.equal(movementFindRedirect.searchParams.get("quantity"), "7");
  assert.equal(
    movementFindRedirect.searchParams.get("preferred_cell_ids"),
    String(movementPreferredCell.cell_id),
  );
  assert.equal(movementFindRedirect.searchParams.get("find_led"), "1");
  assert.ok(db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(activeMetadataKey));

  const movementClearResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: `/products/${shoe.id}/find/clear`,
      body: "",
      cookie,
      headers: {
        "x-requested-with": "fetch",
      },
    }),
    movementClearResponse,
  );
  assert.equal(movementClearResponse.statusCode, 204);
});

test("product low stock uses significant drop below thirty-day average", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-low-stock-average-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const product = inventory.createProduct(db, {
    sku: "AVG-LOW-001",
    name: "Average Sensitive Item",
    brand: "Trend",
    unit_of_measure: "pieces",
    items_per_cell: "5",
  });
  const targetCell = inventory.listCells(db).find((cell) => Number(cell.occupied_quantity || 0) === 0);
  assert.ok(targetCell);

  inventory.createAdjustment(db, {
    cellId: targetCell.id,
    userId: 1,
    reason: "Opening average stock",
    lines: [
      {
        productId: product.id,
        absoluteQuantity: 100,
      },
    ],
  });
  db.prepare("UPDATE transactions SET created_at = ? WHERE product_id = ? AND reason = ?").run(
    new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
    product.id,
    "Opening average stock",
  );
  inventory.createAdjustment(db, {
    cellId: targetCell.id,
    userId: 1,
    reason: "Recent demand drop",
    lines: [
      {
        productId: product.id,
        absoluteQuantity: 30,
      },
    ],
  });

  const html = createProductPages({ db }).renderProducts(
    { id: 1, name: "Admin", username: "admin", role: "admin" },
    null,
    "",
    false,
  );
  const lowStockTemplate = html.match(/data-report-template="low-stock"[\s\S]*?<\/template>/)?.[0] || "";

  assert.match(lowStockTemplate, /AVG-LOW-001/);
  assert.match(lowStockTemplate, /30-day avg/);
  assert.match(lowStockTemplate, /below 30-day average/);
  assert.match(lowStockTemplate, /Average Sensitive Item/);
});

test("profile page shows account details and activity summary", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-profile-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createPageRenderer } = await freshImport("../src/server/pages/index.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const activeAt = "2026-01-02T03:04:05.000Z";
  inventory.updateUserLastActive(db, 1, activeAt);
  assert.equal(
    db.prepare("SELECT last_active_at FROM users WHERE id = 1").get().last_active_at,
    activeAt,
  );
  const operator = inventory.listUsers(db).find((entry) => entry.username === "operator");
  assert.ok(operator);
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);
  const operatorTask = inventory.allocatePick(db, {
    userId: operator.id,
    productId: shoe.id,
    quantity: 1,
  });
  const adminTaskCompletedByOperator = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });
  inventory.completeTask(db, {
    taskId: adminTaskCompletedByOperator.id,
    actualQuantities: {
      [adminTaskCompletedByOperator.lines[0].id]: 1,
    },
    actualCellIds: {
      [adminTaskCompletedByOperator.lines[0].id]: adminTaskCompletedByOperator.lines[0].cell_id,
    },
    userId: operator.id,
    note: "Operator completed an admin-created task",
  });

  const pages = createPageRenderer({ db, backupService: null });
  const html = pages.renderProfile(
    { id: 1, name: "System Admin", username: "admin", role: "admin" },
    null,
  );

  assert.match(html, /href="\/profile"/);
  assert.match(html, /data-nav-links/);
  assert.match(html, /data-nav-overflow-toggle/);
  assert.match(html, /data-nav-overflow-menu/);
  assert.match(html, /Signed In As/);
  assert.match(html, /System Admin/);
  assert.match(html, /admin/);
  assert.match(html, /Date Joined/);
  assert.match(html, /Last Active/);
  assert.match(html, /Tasks Created/);
  assert.match(html, /Inventory Transactions/);

  const adminUserHtml = pages.renderAdminUserProfile(
    { id: 1, name: "System Admin", username: "admin", role: "admin" },
    null,
    operator.id,
  );
  assert.match(adminUserHtml, /User Account/);
  assert.match(adminUserHtml, /Warehouse Operator/);
  assert.match(adminUserHtml, /Back To Admin/);
  assert.match(adminUserHtml, /Recent Tasks/);
  assert.match(adminUserHtml, new RegExp(`href="/tasks/${operatorTask.id}"`));
  assert.match(adminUserHtml, new RegExp(`href="/tasks/${adminTaskCompletedByOperator.id}"`));
  assert.match(adminUserHtml, /Created/);
  assert.match(adminUserHtml, /Interacted/);
  assert.match(adminUserHtml, /href="\/admin\/users\/1"/);
});

test("operators can view reports but not admin-only pages by direct URL", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-operator-route-access-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const { getAppState } = await import("../src/server/app-state.js");
  const operator = getAppState().db
    .prepare("SELECT id, role FROM users WHERE username = ?")
    .get("operator");
  assert.ok(operator);
  const operatorCookie = auth.createSessionCookie(operator).split(";")[0];

  const reportsResponse = new MockResponse();
  await requestHandler(
    formRequest({
      method: "GET",
      url: "/reports",
      body: "",
      cookie: operatorCookie,
    }),
    reportsResponse,
  );
  assert.equal(reportsResponse.statusCode, 200);
  assert.match(reportsResponse.body, /href="\/reports"/);
  assert.match(reportsResponse.body, /report-overview-grid/);
  assert.doesNotMatch(reportsResponse.body, /href="\/devices"/);
  assert.doesNotMatch(reportsResponse.body, /href="\/backups"/);
  assert.doesNotMatch(reportsResponse.body, /href="\/admin"/);

  for (const path of ["/devices", "/devices/sections/controller-setup", "/admin", "/admin/users/1", "/backups"]) {
    const response = new MockResponse();
    await requestHandler(
      formRequest({
        method: "GET",
        url: path,
        body: "",
        cookie: operatorCookie,
      }),
      response,
    );
    assert.equal(response.statusCode, 302, path);
    assert.match(response.headers.Location, /^\/\?/, path);
    assert.match(response.headers.Location, /Admin\+access\+is\+required/, path);
  }

  const productDeleteResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/products/1/delete",
      body: "",
      cookie: operatorCookie,
    }),
    productDeleteResponse,
  );
  assert.equal(productDeleteResponse.statusCode, 302);
  assert.match(productDeleteResponse.headers.Location, /^\/\?/);
  assert.match(productDeleteResponse.headers.Location, /Admin\+access\+is\+required/);

  const adminCookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const adminUserResponse = new MockResponse();
  await requestHandler(
    formRequest({
      method: "GET",
      url: `/admin/users/${operator.id}`,
      body: "",
      cookie: adminCookie,
    }),
    adminUserResponse,
  );
  assert.equal(adminUserResponse.statusCode, 200);
  assert.match(adminUserResponse.body, /User Account/);
  assert.match(adminUserResponse.body, /Warehouse Operator/);
});

test("database-backed settings and inventory survive an app restart", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-persist-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  inventory.updateProductItemsPerCell(db, {
    productId: shoe.id,
    itemsPerCell: 9,
  });

  inventory.createAdjustment(db, {
    cellId: 1,
    userId: 1,
    reason: "Persistence check",
    lines: [
      {
        productId: shoe.id,
        absoluteQuantity: 11,
      },
    ],
  });

  const reopenedDb = createDatabase({ hashPassword: auth.hashPassword });
  const reopenedShoe = inventory.getProductDetail(reopenedDb, shoe.id);
  assert.ok(reopenedShoe);
  assert.equal(Number(reopenedShoe.items_per_cell), 9);

  const reopenedCell = inventory.getCellDetail(reopenedDb, 1);
  assert.ok(reopenedCell);
  assert.equal(
    Number(
      reopenedCell.products.find((product) => product.product_id === shoe.id)?.available_quantity || 0,
    ),
    11,
  );
});

test("product removal is admin-safe and SKU re-add restores the same product identity", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-product-remove-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);
  assert.throws(
    () => inventory.removeProduct(db, shoe.id),
    /Product stock must be 0 before it can be removed/,
  );
  const updatedShoe = inventory.updateProductDetails(db, {
    productId: shoe.id,
    name: "Corrected Combat Boots",
    brand: shoe.brand,
    category: "Corrected Footwear",
    variant: shoe.variant,
    unit_of_measure: "pairs",
    description: shoe.description,
  });
  assert.equal(updatedShoe.id, shoe.id);
  assert.equal(updatedShoe.sku, shoe.sku);
  assert.equal(updatedShoe.name, "Corrected Combat Boots");
  assert.equal(updatedShoe.category, "Corrected Footwear");

  const product = inventory.createProduct(db, {
    sku: "restore-me-001",
    name: "Original Product",
    brand: "Original Brand",
    category: "Old Category",
    variant: "Old Variant",
    unit_of_measure: "pieces",
    items_per_cell: 4,
  });
  const originalId = product.id;

  const pages = createProductPages({ db });
  const admin = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const operator = { id: 2, name: "Operator", username: "operator", role: "operator" };
  const stockedProductHtml = pages.renderProductDetail(
    admin,
    null,
    inventory.getProductDetail(db, shoe.id),
    new URL(`http://localhost/products/${shoe.id}`),
  );
  assert.match(stockedProductHtml, /Remove Product/);
  assert.match(stockedProductHtml, /Show All Quantities/);
  assert.match(stockedProductHtml, /product-summary-layout/);
  assert.match(stockedProductHtml, /product-summary-facts/);
  assert.match(stockedProductHtml, /Product Settings/);
  assert.match(stockedProductHtml, /Edit Product Details/);
  assert.match(stockedProductHtml, /SKU is the product identity and cannot be changed\./);
  assert.match(stockedProductHtml, /Create a Pick task to reduce this product&#39;s stock to 0 before removing it\./);
  assert.match(stockedProductHtml, /Remove Product<\/button>/);
  assert.match(stockedProductHtml, /disabled/);

  const operatorHtml = pages.renderProductDetail(
    operator,
    null,
    inventory.getProductDetail(db, product.id),
    new URL(`http://localhost/products/${product.id}`),
  );
  assert.doesNotMatch(operatorHtml, /Remove Product/);
  assert.match(operatorHtml, /Show All Quantities/);
  assert.match(operatorHtml, /href="\/products"[\s\S]*?<span>Products<\/span>/);

  const removed = inventory.removeProduct(db, product.id);
  assert.equal(removed.id, originalId);
  assert.equal(removed.active, 0);
  assert.equal(inventory.getProductDetail(db, originalId), null);
  assert.equal(
    inventory.listProducts(db).some((entry) => Number(entry.id) === Number(originalId)),
    false,
  );

  const restored = inventory.createProduct(db, {
    sku: "restore-me-001",
    name: "Corrected Product",
    brand: "Corrected Brand",
    category: "Corrected Category",
    variant: "Corrected Variant",
    unit_of_measure: "boxes",
    items_per_cell: 7,
  });
  assert.equal(restored.id, originalId);
  assert.equal(restored.sku, "RESTORE-ME-001");
  assert.equal(restored.name, "Corrected Product");
  assert.equal(restored.category, "Corrected Category");
  assert.equal(restored.unit_of_measure, "boxes");
  assert.equal(Number(restored.items_per_cell), 7);

  assert.throws(
    () =>
      inventory.createProduct(db, {
        sku: "restore-me-001",
        name: "Duplicate Active Product",
        brand: "Duplicate Brand",
        unit_of_measure: "pieces",
        items_per_cell: 1,
      }),
    /A product with that SKU already exists\./,
  );
});

test("put capacity error page offers an inline items-per-cell update", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-put-capacity-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const pages = createProductPages({ db });
  const html = pages.renderPut(
    { id: 1, name: "Admin", username: "admin", role: "admin" },
    {
      message: "System is already full for this product. Eligible empty and same-product cells do not have enough remaining room.",
      tone: "error",
    },
    new URL(`http://localhost/put?product_id=${shoe.id}&quantity=99&capacity_help=1`),
  );

  assert.match(html, /No Space Available/);
  assert.match(html, /Review Recommended Actions/);
  assert.match(html, /source=put-capacity&amp;return_to=/);
  assert.match(html, /Retry Put Request/);
  assert.match(html, /Update Capacity/);
  assert.match(html, new RegExp(`action="/products/${shoe.id}/items-per-cell"`));
  assert.match(html, /name="items_per_cell"/);
  assert.match(html, /name="quantity" value="99"/);
  assert.match(html, /name="return_to" value="\/put\?product_id=\d+&amp;quantity=99"/);
});

test("capacity updates show newly-created recommended actions in a same-page prompt", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-capacity-recommendation-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const response = new MockResponse();
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const body = new URLSearchParams({
    items_per_cell: "2",
    return_to: "/products/1",
  }).toString();

  await requestHandler(
    formRequest({
      url: "/products/1/items-per-cell",
      body,
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /^\/products\/1\?/);
  const redirectUrl = new URL(response.headers.Location, "http://localhost");
  assert.match(redirectUrl.searchParams.get("capacity_recommendation_key"), /^overflow-\d+-1$/);
  assert.equal(
    redirectUrl.searchParams.get("flash"),
    "Capacity updated and recommendations recalculated. It improves stock placement but will not completely empty a location.",
  );
  assert.equal(redirectUrl.searchParams.get("tone"), "warning");

  const detailResponse = new MockResponse();
  await requestHandler(
    formRequest({
      method: "GET",
      url: response.headers.Location,
      body: "",
      cookie,
    }),
    detailResponse,
  );

  assert.equal(detailResponse.statusCode, 200);
  assert.match(detailResponse.body, /Recommended Action Created/);
  assert.match(detailResponse.body, /Review Recommendation/);
  assert.match(detailResponse.body, /will not completely empty a location/);
  assert.match(detailResponse.body, /Skip For Now/);
  assert.match(detailResponse.body, /href="\/recommended-actions\?key=overflow-\d+-1&amp;source=capacity&amp;return_to=%2Fproducts%2F1"/);
  assert.match(detailResponse.body, /href="\/products\/1">Skip For Now/);

  const repeatedResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/products/1/items-per-cell",
      body: new URLSearchParams({
        items_per_cell: "2",
        return_to: "/products",
      }).toString(),
      cookie,
    }),
    repeatedResponse,
  );
  assert.equal(repeatedResponse.statusCode, 302);
  assert.match(repeatedResponse.headers.Location, /^\/products\?/);
  assert.match(repeatedResponse.headers.Location, /capacity_recommendation_key=overflow-/);

  const consolidationResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/products/1/items-per-cell",
      body: new URLSearchParams({
        items_per_cell: "20",
        return_to: "/products",
      }).toString(),
      cookie,
    }),
    consolidationResponse,
  );
  assert.equal(consolidationResponse.statusCode, 302);
  assert.match(consolidationResponse.headers.Location, /^\/products\?/);
  assert.match(consolidationResponse.headers.Location, /capacity_recommendation_key=optimize-1/);
  assert.match(
    new URL(consolidationResponse.headers.Location, "http://localhost").searchParams.get("flash"),
    /can free 2 locations/,
  );

  const catalogResponse = new MockResponse();
  await requestHandler(
    formRequest({
      method: "GET",
      url: consolidationResponse.headers.Location,
      body: "",
      cookie,
    }),
    catalogResponse,
  );
  assert.equal(catalogResponse.statusCode, 200);
  assert.match(catalogResponse.body, /catalog-capacity-editor/);
  assert.match(catalogResponse.body, /Recommended Action Created/);
  assert.match(catalogResponse.body, /will free 2 locations/);
});

test("active pick and put tasks allow changed quantities on eligible cells", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-flexible-task-confirm-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  const shirt = inventory.listProducts(db).find((product) => product.sku === "SKU-TEE-002");
  assert.ok(shoe);
  assert.ok(shirt);

  const shoeCell = inventory.searchCells(db, "Z1-R1-C01")[0];
  const alternateShoeCell = inventory.searchCells(db, "Z1-R1-C02")[0];
  const shirtCell = inventory.searchCells(db, "Z1-R1-C04")[0];
  const emptyCell = inventory.listCells(db).find((cell) => Number(cell.occupied_quantity || 0) === 0);
  assert.ok(shoeCell);
  assert.ok(alternateShoeCell);
  assert.ok(shirtCell);
  assert.ok(emptyCell);

  assert.throws(
    () =>
      inventory.planPut(db, {
        userId: 1,
        productId: shoe.id,
        quantity: 1,
        preferredCellId: shirtCell.id,
      }),
    /already contains SKU-TEE-002/,
  );

  db.prepare(
    `
      INSERT OR IGNORE INTO inventory_balances (
        product_id, cell_id, available_quantity, reserved_quantity
      )
      VALUES (?, ?, 0, 0)
    `,
  ).run(shoe.id, shirtCell.id);
  db.prepare(
    `
      UPDATE inventory_balances
      SET available_quantity = 0
      WHERE product_id = ? AND cell_id = ?
    `,
  ).run(shoe.id, shirtCell.id);
  inventory.updateProductItemsPerCell(db, {
    productId: shoe.id,
    itemsPerCell: 1,
  });
  const staleBalancePut = inventory.planPut(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });
  assert.ok(!staleBalancePut.lines.some((line) => Number(line.cell_id) === Number(shirtCell.id)));

  const pickTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
    preferredCellId: shoeCell.id,
  });
  const completedPick = inventory.completeTask(db, {
    taskId: pickTask.id,
    actualQuantities: { [pickTask.lines[0].id]: 2 },
    actualCellIds: { [pickTask.lines[0].id]: alternateShoeCell.id },
    userId: 1,
    note: "Pick from alternate eligible cell",
  });
  assert.equal(Number(completedPick.task.lines[0].actual_quantity), 2);
  assert.equal(Number(completedPick.task.lines[0].cell_id), Number(alternateShoeCell.id));

  const invalidPutTask = inventory.planPut(db, {
    userId: 1,
    productId: shirt.id,
    quantity: 1,
  });
  assert.throws(
    () =>
      inventory.completeTask(db, {
        taskId: invalidPutTask.id,
        actualQuantities: { [invalidPutTask.lines[0].id]: 2 },
        actualCellIds: { [invalidPutTask.lines[0].id]: shoeCell.id },
        userId: 1,
        note: "Try invalid mixed put",
      }),
    /already contains SKU-SHOE-001/,
  );

  const shoeQuantityInCell = Number(shoeCell.occupied_quantity || 0);
  const emptyShoeCellTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: shoeQuantityInCell,
    preferredCellId: shoeCell.id,
  });
  inventory.completeTask(db, {
    taskId: emptyShoeCellTask.id,
    actualQuantities: { [emptyShoeCellTask.lines[0].id]: shoeQuantityInCell },
    actualCellIds: { [emptyShoeCellTask.lines[0].id]: shoeCell.id },
    userId: 1,
    note: "Empty the old shoe cell",
  });
  const emptiedFormerShoeCell = inventory
    .listCells(db)
    .find((cell) => Number(cell.id) === Number(shoeCell.id));
  assert.equal(Number(emptiedFormerShoeCell.occupied_quantity), 0);
  const shirtIntoFormerShoeCell = inventory.planPut(db, {
    userId: 1,
    productId: shirt.id,
    quantity: 1,
    preferredCellId: shoeCell.id,
  });
  assert.equal(Number(shirtIntoFormerShoeCell.lines[0].cell_id), Number(shoeCell.id));

  const putTask = inventory.planPut(db, {
    userId: 1,
    productId: shirt.id,
    quantity: 1,
  });
  const completedPut = inventory.completeTask(db, {
    taskId: putTask.id,
    actualQuantities: { [putTask.lines[0].id]: 4 },
    actualCellIds: { [putTask.lines[0].id]: emptyCell.id },
    userId: 1,
    note: "Put into alternate eligible empty cell",
  });
  assert.equal(Number(completedPut.task.lines[0].actual_quantity), 4);
  assert.equal(Number(completedPut.task.lines[0].cell_id), Number(emptyCell.id));

  const adjustablePut = inventory.planPut(db, {
    userId: 1,
    productId: shirt.id,
    quantity: 1,
  });
  const adjustedPut = inventory.updatePendingPutPlan(db, {
    taskId: adjustablePut.id,
    allocations: [{ cellId: emptyCell.id, quantity: 5 }],
    note: "Change quantity before LEDs",
  });
  assert.equal(
    adjustedPut.lines.reduce((sum, line) => sum + Number(line.planned_quantity), 0),
    5,
  );
});

test("locations expose direct pick and put actions", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-location-actions-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createLocationPages } = await freshImport("../src/server/pages/locations.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");
  const { setRuntimeContext } = await import("../src/server/runtime-context.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const stockedCell = inventory
    .listCells(db)
    .find((cell) => Number(cell.occupied_quantity || 0) > 0);
  assert.ok(stockedCell);

  const cellDetail = inventory.getCellDetail(db, stockedCell.id);
  assert.ok(cellDetail.products.length > 0);
  const manualLocation = inventory.createCell(db, {
    logicalCode: "Z9-R8-MANUAL",
    capacity: 12,
    createdBy: user.id,
  });

  const locationPages = createLocationPages({ db });
  const locationsHtml = locationPages.renderCells(user, null, "");
  assert.match(locationsHtml, new RegExp(`href="/pick\\?cell_id=${stockedCell.id}"`));
  assert.match(locationsHtml, new RegExp(`href="/put\\?cell_id=${stockedCell.id}"`));
  assert.match(
    locationsHtml,
    new RegExp(`data-ping-cell[\\s\\S]*data-cell-id="${stockedCell.id}"`),
  );
  assert.match(
    locationsHtml,
    new RegExp(`data-show-location-count[\\s\\S]*data-cell-id="${stockedCell.id}"`),
  );
  assert.doesNotMatch(locationsHtml, /data-location-count-value/);
  assert.match(locationsHtml, />Show Count<\/button>/);
  assert.match(
    locationsHtml,
    new RegExp(`data-cell-id="${manualLocation.id}"[\\s\\S]*disabled[\\s\\S]*>Locate<\\/button>`),
  );
  assert.doesNotMatch(locationsHtml, /Put item here|Put any item here/);

  const searchHtml = locationPages.renderCells(user, null, stockedCell.logical_code);
  assert.match(searchHtml, /Search Locations/);
  assert.match(searchHtml, /location\(s\) match/);
  assert.match(searchHtml, new RegExp(`href="/pick\\?cell_id=${stockedCell.id}"`));
  assert.match(searchHtml, new RegExp(`href="/put\\?cell_id=${stockedCell.id}"`));
  assert.match(searchHtml, new RegExp(`data-ping-cell[\\s\\S]*data-cell-id="${stockedCell.id}"`));
  assert.match(searchHtml, new RegExp(`data-cell-id="${stockedCell.id}"[\\s\\S]*data-locate-cell`));
  assert.match(searchHtml, /data-show-location-count/);
  assert.match(searchHtml, new RegExp(stockedCell.inventory_summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  setRuntimeContext({
    firmwareService: {
      getFlashOptions() {
        return {
          arduinoCli: { available: true },
          defaultFqbn: "esp32:esp32:esp32",
          moduleCount: { min: 1, max: 16 },
          portStatus: "Ready",
          lastConfiguration: null,
        };
      },
    },
  });
  try {
    const controllerSetupHtml = locationPages.renderDeviceConfigSection("controller-setup");
    assert.match(controllerSetupHtml, /data-firmware-wizard/);
    assert.match(controllerSetupHtml, />Disconnect</);
    assert.match(controllerSetupHtml, />Attach</);
    assert.match(controllerSetupHtml, />Configure</);
    assert.match(controllerSetupHtml, />Flash</);
    assert.doesNotMatch(controllerSetupHtml, /<h2>Add Controller<\/h2>/);
    assert.doesNotMatch(controllerSetupHtml, /Sketch/);
    assert.doesNotMatch(controllerSetupHtml, /name="controller_name"[\s\S]{0,220}value=/);
    assert.doesNotMatch(controllerSetupHtml, /name="module_count"[\s\S]{0,220}value=/);
  } finally {
    setRuntimeContext({ firmwareService: null });
  }

  const productPages = createProductPages({ db });
  const pickHtml = productPages.renderPick(
    user,
    null,
    new URL(`http://localhost/pick?cell_id=${stockedCell.id}`),
  );
  assert.ok(pickHtml.includes(`<strong>${cellDetail.products[0].sku}</strong>`));
  assert.match(pickHtml, /only offers products currently stocked there/);

  const outsideProduct = inventory
    .listProducts(db)
    .find(
      (product) =>
        !cellDetail.products.some(
          (cellProduct) => Number(cellProduct.product_id) === Number(product.id),
        ),
    );
  if (outsideProduct) {
    assert.ok(!pickHtml.includes(`data-value="${outsideProduct.id}"`));
    const unavailablePickHtml = productPages.renderPick(
      user,
      null,
      new URL(`http://localhost/pick?cell_id=${stockedCell.id}&product_id=${outsideProduct.id}`),
    );
    assert.match(unavailablePickHtml, /not currently stocked/);
  }
});

test("operator movement screens keep context and use plain task actions", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-operator-ux-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { formatDate } = await freshImport("../src/render.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");
  const { createTaskPages } = await freshImport("../src/server/pages/tasks.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const productDetail = inventory.getProductDetail(db, shoe.id);
  assert.ok(productDetail.locations.length >= 3);

  const productPages = createProductPages({ db });
  const seededCellIds = new Set(productDetail.locations.map((location) => Number(location.cell_id)));
  const movementCells = [
    ...productDetail.locations.slice(0, 3).map((location) => ({
      cell_id: location.cell_id,
      logical_code: location.logical_code,
    })),
    ...inventory
      .listCells(db)
      .filter((cell) => !seededCellIds.has(Number(cell.id)))
      .slice(0, 5)
      .map((cell) => ({
        cell_id: cell.id,
        logical_code: cell.logical_code,
      })),
  ];
  assert.ok(movementCells.length >= 7);
  const activityTimes = [
    "2026-05-20T10:30:00.000Z",
    "2026-05-14T09:15:00.000Z",
    "2026-05-18T07:45:00.000Z",
    "2026-05-16T12:00:00.000Z",
    "2026-05-15T11:30:00.000Z",
    "2026-05-19T08:20:00.000Z",
    "2026-05-17T14:10:00.000Z",
  ];
  const activityPlan = movementCells.slice(0, activityTimes.length).map((location, index) => ({
    location,
    at: activityTimes[index],
  }));
  for (const entry of activityPlan) {
    inventory.createAdjustment(db, {
      cellId: entry.location.cell_id,
      productId: shoe.id,
      quantityDelta: 1,
      userId: user.id,
      reason: "Seed movement screen activity",
    });
    db.prepare(
      `
        UPDATE transactions
        SET created_at = ?
        WHERE product_id = ? AND cell_id = ?
      `,
    ).run(entry.at, shoe.id, entry.location.cell_id);
  }
  const refreshedProductDetail = inventory.getProductDetail(db, shoe.id);
  const refreshedByCellId = new Map(
    refreshedProductDetail.locations.map((location) => [Number(location.cell_id), location]),
  );
  const expectedStockOrder = activityPlan
    .map((entry) => ({
      ...entry,
      location: refreshedByCellId.get(Number(entry.location.cell_id)),
    }))
    .slice()
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const initialStockOrder = expectedStockOrder.slice(0, 5);
  const nextStockOrder = expectedStockOrder.slice(5);
  const preferredCellId = expectedStockOrder[0].location.cell_id;
  const assertMovementStockOrder = (html) => {
    const positions = initialStockOrder.map((entry) => html.indexOf(entry.location.logical_code));
    assert.ok(positions.every((position) => position >= 0));
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index - 1] < positions[index]);
    }
  };
  const addProductHtml = productPages.renderProducts(user, null, "", true);
  assert.match(
    addProductHtml,
    /class="side-nav-direct nav-link-active" href="\/products"[\s\S]*?<span>Products<\/span>/,
  );
  assert.match(addProductHtml, /Save And Put Stock/);
  assert.match(addProductHtml, /Optional Catalog Details/);
  assert.match(addProductHtml, /data-report-open="out-of-stock"/);
  assert.match(addProductHtml, /data-report-template="out-of-stock"/);
  assert.match(addProductHtml, /Open Printable List/);
  assert.match(addProductHtml, /Out Of Stock Products/);
  assert.match(addProductHtml, /data-report-print-current/);
  assert.match(addProductHtml, /Items Per Location/);
  assert.match(addProductHtml, /catalog-capacity-editor/);
  assert.match(addProductHtml, /Edit Capacity/);
  assert.match(addProductHtml, /Save Capacity/);
  const productSearchHtml = productPages.renderCatalogProductResults(
    inventory.listProducts(db, "shoe"),
    "No products match that search.",
    "shoe",
  );
  assert.match(productSearchHtml, /product\(s\) match &quot;shoe&quot;/);
  assert.match(productSearchHtml, /Open/);
  assert.match(productSearchHtml, /Pick/);
  assert.match(productSearchHtml, /Put/);

  const pickHtml = productPages.renderPick(
    user,
    null,
    new URL(`http://localhost/pick?product_id=${shoe.id}&cell_id=${preferredCellId}&quantity=2`),
  );
  assert.match(pickHtml, /name="quantity"[\s\S]*value="2"/);
  assert.match(pickHtml, /Quick Quantity Picker/);
  assert.match(pickHtml, /Pick All In This Location/);
  assert.match(pickHtml, /Available to pick/);
  assert.match(pickHtml, /Current Stock/);
  assert.match(pickHtml, /data-product-summary-form/);
  assert.match(pickHtml, /data-product-summary-path="\/pick"/);
  assert.match(pickHtml, /data-movement-stock-summary/);
  assert.match(pickHtml, /data-movement-stock-load-more/);
  assert.match(pickHtml, /data-movement-stock-offset="5"/);
  assert.match(pickHtml, /name="return_to" value="" data-led-command-return-to/);
  assert.match(pickHtml, /Show All Quantities/);
  assert.match(pickHtml, new RegExp(`formaction="/products/${shoe.id}/find"`));
  assert.match(pickHtml, /formnovalidate/);
  assert.match(pickHtml, /data-product-find-submit/);
  assert.match(pickHtml, /Last Activity/);
  assert.match(pickHtml, /Preferred/);
  assert.match(
    pickHtml,
    new RegExp(`name="preferred_cell_${preferredCellId}"[\\s\\S]{0,300}checked`),
  );
  assert.match(pickHtml, new RegExp(`name="context_cell_id" value="${preferredCellId}"`));
  assert.match(pickHtml, new RegExp(`${refreshedProductDetail.sku}[\\s\\S]*${refreshedProductDetail.name}`));
  assert.match(pickHtml, new RegExp(`${initialStockOrder[0].location.logical_code}[\\s\\S]*${initialStockOrder[0].location.available_quantity}`));
  for (const entry of initialStockOrder) {
    assert.match(pickHtml, new RegExp(formatDate(entry.at).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const entry of nextStockOrder) {
    assert.doesNotMatch(pickHtml, new RegExp(`<td>${entry.location.logical_code}</td>`));
  }
  assertMovementStockOrder(pickHtml);

  const preservedPreferredCellId = nextStockOrder[0].location.cell_id;
  const preservedPickHtml = productPages.renderPick(
    user,
    null,
    new URL(`http://localhost/pick?product_id=${shoe.id}&quantity=9&preferred_cell_ids=${preservedPreferredCellId}&find_led=1`),
  );
  assert.match(preservedPickHtml, /name="quantity"[\s\S]*value="9"/);
  assert.match(
    preservedPickHtml,
    new RegExp(`name="preferred_cell_${preservedPreferredCellId}"[\\s\\S]{0,300}checked`),
  );

  const activePickHtml = productPages.renderPick(
    user,
    null,
    new URL(`http://localhost/pick?product_id=${shoe.id}&cell_id=${preferredCellId}&quantity=2&find_led=1`),
  );
  assert.match(activePickHtml, /data-product-find-led-clear-form/);
  assert.match(
    activePickHtml,
    new RegExp(`data-product-find-led-clear-endpoint="/products/${shoe.id}/find/clear"`),
  );

  const movementStockFragmentHtml = productPages.renderMovementStockRows(
    inventory.getProductMovementStockSummary(db, shoe.id, { offset: 5, limit: 5 }),
  );
  assert.match(movementStockFragmentHtml, /data-stock-cell-row/);
  for (const entry of nextStockOrder) {
    assert.match(movementStockFragmentHtml, new RegExp(`<td>${entry.location.logical_code}</td>`));
  }

  const putHtml = productPages.renderPut(
    user,
    null,
    new URL(`http://localhost/put?product_id=${shoe.id}&cell_id=${preferredCellId}&quantity=2`),
  );
  assert.match(putHtml, /Quick Quantity Picker/);
  assert.match(putHtml, /One Location Batch/);
  assert.doesNotMatch(putHtml, /Full location capacity/);
  assert.match(putHtml, /system will split it across eligible locations/);
  assert.match(putHtml, /Current Stock/);
  assert.match(putHtml, /Last Activity/);
  assert.match(putHtml, new RegExp(`${refreshedProductDetail.sku}[\\s\\S]*${refreshedProductDetail.name}`));
  assert.match(putHtml, new RegExp(`${initialStockOrder[0].location.logical_code}[\\s\\S]*${initialStockOrder[0].location.available_quantity}`));
  for (const entry of initialStockOrder) {
    assert.match(putHtml, new RegExp(formatDate(entry.at).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assertMovementStockOrder(putHtml);
  assert.match(putHtml, /data-put-product-summary-form/);
  assert.match(putHtml, /data-product-summary-form/);
  assert.match(putHtml, /data-product-summary-path="\/put"/);
  assert.match(putHtml, /data-movement-stock-summary/);
  assert.match(putHtml, /data-movement-stock-load-more/);
  assert.match(putHtml, /data-movement-stock-offset="5"/);
  assert.match(putHtml, /name="return_to" value="" data-led-command-return-to/);
  assert.match(putHtml, /Show All Quantities/);
  assert.match(putHtml, new RegExp(`formaction="/products/${shoe.id}/find"`));
  assert.match(putHtml, /formnovalidate/);
  assert.match(putHtml, /data-product-find-submit/);
  assert.match(putHtml, /Preferred/);
  assert.match(
    putHtml,
    new RegExp(`name="preferred_cell_${preferredCellId}"[\\s\\S]{0,300}checked`),
  );
  assert.match(putHtml, new RegExp(`name="context_cell_id" value="${preferredCellId}"`));

  const preservedPutHtml = productPages.renderPut(
    user,
    null,
    new URL(`http://localhost/put?product_id=${shoe.id}&quantity=9&preferred_cell_ids=${preservedPreferredCellId}&find_led=1`),
  );
  assert.match(preservedPutHtml, /name="quantity"[\s\S]*value="9"/);
  assert.match(
    preservedPutHtml,
    new RegExp(`name="preferred_cell_${preservedPreferredCellId}"[\\s\\S]{0,300}checked`),
  );

  const activePutHtml = productPages.renderPut(
    user,
    null,
    new URL(`http://localhost/put?product_id=${shoe.id}&cell_id=${preferredCellId}&quantity=2&find_led=1`),
  );
  assert.match(activePutHtml, /data-product-find-led-clear-form/);
  assert.match(
    activePutHtml,
    new RegExp(`data-product-find-led-clear-endpoint="/products/${shoe.id}/find/clear"`),
  );

  const preferredPickLocation = refreshedProductDetail.locations.find(
    (location) => Number(location.cell_id) === Number(expectedStockOrder[2].location.cell_id),
  );
  assert.ok(preferredPickLocation);
  const preferredFallbackTask = inventory.allocatePick(db, {
    userId: user.id,
    productId: shoe.id,
    quantity: Number(preferredPickLocation.available_quantity) + 1,
    preferredCellIds: [preferredPickLocation.cell_id],
  });
  const preferredFallbackLines = db
    .prepare("SELECT cell_id FROM task_lines WHERE task_id = ? ORDER BY id")
    .all(preferredFallbackTask.id);
  assert.equal(Number(preferredFallbackLines[0].cell_id), Number(preferredPickLocation.cell_id));
  assert.equal(
    Number(preferredFallbackLines[1].cell_id),
    Number(expectedStockOrder[0].location.cell_id),
  );

  const task = inventory.allocatePick(db, {
    userId: user.id,
    productId: shoe.id,
    quantity: 1,
    preferredCellId,
  });
  const taskPages = createTaskPages({ db });
  const taskHtml = taskPages.renderTask(user, null, task, "view", {
    cancel: "cancel-token",
    confirm: "confirm-token",
  });

  assert.match(taskHtml, new RegExp(`Pick Task #${task.id}`));
  assert.doesNotMatch(taskHtml, /Mark reached|Physical/);
  assert.match(taskHtml, /Complete Pick/);
  assert.match(
    taskHtml,
    new RegExp(`step="1"[\\s\\S]*name="actual_${task.lines[0].id}"`),
  );
  assert.match(taskHtml, /Cancel Task/);
  assert.match(taskHtml, /Cancel this task\?/);
  assert.doesNotMatch(taskHtml, /Simulate button|Finish task|Pick Action Initiated|Use the row below/);

  const putTask = inventory.planPut(db, {
    userId: user.id,
    productId: shoe.id,
    quantity: 1,
  });
  const putTaskHtml = taskPages.renderTask(user, null, putTask, "view", {
    cancel: "cancel-token",
    confirm: "confirm-token",
    putPlan: "put-plan-token",
  });
  assert.match(putTaskHtml, /Complete Put/);
  assert.match(
    putTaskHtml,
    new RegExp(`step="1"[\\s\\S]*name="actual_${putTask.lines[0].id}"`),
  );
  assert.match(putTaskHtml, /name="plan_qty_new___INDEX__"/);
  assert.match(putTaskHtml, /step="1"[\s\S]*name="plan_qty_new___INDEX__"/);
  assert.match(putTaskHtml, /Update Cell/);
  assert.match(putTaskHtml, /data-put-task-cell-control/);
  assert.match(putTaskHtml, /data-put-confirm-cell-for=/);
  assert.match(putTaskHtml, /form="put-plan-form"/);
  assert.doesNotMatch(putTaskHtml, /Change put locations|Update LED plan|Physical|Mark reached|Use the row below/);

  const completed = inventory.completeTask(db, {
    taskId: task.id,
    actualQuantities: Object.fromEntries(
      task.lines.map((line) => [line.id, line.planned_quantity]),
    ),
    userId: user.id,
    note: "Completed in UX test",
  });
  const completionHtml = taskPages.renderTask(user, null, completed.task, "view", {}, {
    showCompletionDialog: true,
  });
  assert.match(completionHtml, /id="completion-title">Complete/);
  assert.match(completionHtml, /Task Summary/);
  assert.match(completionHtml, /Redirecting to Overview in 10 seconds/);
  assert.match(completionHtml, /data-completion-redirect/);
  assert.match(completionHtml, /Go To Overview/);
});

test("pick and put product pickers prioritize recently selected movement products", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-recent-product-picker-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  const shirt = inventory.listProducts(db).find((product) => product.sku === "SKU-TEE-002");
  assert.ok(shoe);
  assert.ok(shirt);

  const productPages = createProductPages({ db });
  const productOptionIndex = (html, product) => {
    const index = html.indexOf(`data-value="${product.id}"`);
    assert.notEqual(index, -1, `${product.sku} should be present in the product picker`);
    return index;
  };

  const defaultPutHtml = productPages.renderPut(user, null, new URL("http://localhost/put"));
  assert.ok(productOptionIndex(defaultPutHtml, shoe) < productOptionIndex(defaultPutHtml, shirt));

  inventory.allocatePick(db, {
    userId: user.id,
    productId: shoe.id,
    quantity: 1,
  });
  inventory.planPut(db, {
    userId: user.id,
    productId: shirt.id,
    quantity: 1,
  });

  const putHtml = productPages.renderPut(user, null, new URL("http://localhost/put"));
  const pickHtml = productPages.renderPick(user, null, new URL("http://localhost/pick"));

  assert.ok(productOptionIndex(putHtml, shirt) < productOptionIndex(putHtml, shoe));
  assert.ok(productOptionIndex(pickHtml, shirt) < productOptionIndex(pickHtml, shoe));
  assert.match(putHtml, /data-combo-recency-key="movement-product"/);
  assert.match(pickHtml, /data-combo-recency-key="movement-product"/);
});

test("overview recent tasks show user links and respect operator scope", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-overview-task-scope-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createHomePages } = await freshImport("../src/server/pages/home.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const admin = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const operatorUser = inventory.listUsers(db).find((entry) => entry.username === "operator");
  assert.ok(operatorUser);
  const operator = {
    id: operatorUser.id,
    name: operatorUser.name,
    username: operatorUser.username,
    role: operatorUser.role,
  };
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const adminTask = inventory.allocatePick(db, {
    userId: admin.id,
    productId: shoe.id,
    quantity: 1,
  });
  const operatorTask = inventory.allocatePick(db, {
    userId: operator.id,
    productId: shoe.id,
    quantity: 1,
  });

  const homePages = createHomePages({ db });
  const adminHtml = homePages.renderHome(admin, null, new URL("http://localhost/"));
  const operatorHtml = homePages.renderHome(operator, null, new URL("http://localhost/"));

  assert.match(adminHtml, /<th>User<\/th>/);
  assert.match(adminHtml, new RegExp(`href="/tasks/${adminTask.id}"`));
  assert.match(adminHtml, new RegExp(`href="/tasks/${operatorTask.id}"`));
  assert.match(adminHtml, new RegExp(`href="/admin/users/${admin.id}"`));
  assert.match(adminHtml, new RegExp(`href="/admin/users/${operator.id}"`));
  assert.match(operatorHtml, /<th>User<\/th>/);
  assert.doesNotMatch(operatorHtml, new RegExp(`href="/tasks/${adminTask.id}"`));
  assert.match(operatorHtml, new RegExp(`href="/tasks/${operatorTask.id}"`));
  assert.match(operatorHtml, /href="\/profile"/);
  assert.doesNotMatch(operatorHtml, /href="\/admin\/users\//);
});

test("pending review tasks auto-cancel five minutes after last touch by default", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-stale-pending-review-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createSystemService } = await freshImport("../src/services/system.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const staleTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });
  const recentlyTouchedTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });

  const now = new Date("2026-05-15T10:00:00.000Z");
  const staleTouch = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
  const recentTouch = new Date(now.getTime() - 4 * 60 * 1000).toISOString();
  db.prepare("UPDATE tasks SET started_at = ?, last_touched_at = ? WHERE id = ?").run(
    staleTouch,
    staleTouch,
    staleTask.id,
  );
  db.prepare("UPDATE tasks SET started_at = ?, last_touched_at = ? WHERE id = ?").run(
    staleTouch,
    recentTouch,
    recentlyTouchedTask.id,
  );

  const clearedTaskIds = [];
  const systemService = createSystemService({
    db,
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    hardwareService: {
      adapterName: "test",
      clearGuidance(task) {
        clearedTaskIds.push(task.id);
        return { ok: true, degraded: false, message: "cleared" };
      },
    },
    getTask: inventory.getTask,
  });

  assert.equal(systemService.getPendingReviewTimeoutSettings().timeoutMinutes, 5);
  const cancelledTaskIds = systemService.cancelStalePendingReviewTasks({ now });

  assert.deepEqual(cancelledTaskIds, [staleTask.id]);
  assert.deepEqual(clearedTaskIds, [staleTask.id]);
  assert.equal(inventory.getTask(db, staleTask.id).status, "cancelled");
  assert.equal(inventory.getTask(db, staleTask.id).completed_at, now.toISOString());
  assert.equal(inventory.getTask(db, recentlyTouchedTask.id).status, "pending_review");
});

test("pending review task timeout can be configured", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-configurable-task-timeout-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createSystemService } = await freshImport("../src/services/system.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const olderTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });
  const insideWindowTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });

  const now = new Date("2026-05-15T10:00:00.000Z");
  const olderTouch = new Date(now.getTime() - 11 * 60 * 1000).toISOString();
  const insideWindowTouch = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
  db.prepare("UPDATE tasks SET started_at = ?, last_touched_at = ? WHERE id = ?").run(
    olderTouch,
    olderTouch,
    olderTask.id,
  );
  db.prepare("UPDATE tasks SET started_at = ?, last_touched_at = ? WHERE id = ?").run(
    olderTouch,
    insideWindowTouch,
    insideWindowTask.id,
  );

  const clearedTaskIds = [];
  const systemService = createSystemService({
    db,
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    hardwareService: {
      adapterName: "test",
      clearGuidance(task) {
        clearedTaskIds.push(task.id);
        return { ok: true, degraded: false, message: "cleared" };
      },
    },
    getTask: inventory.getTask,
  });

  const settings = systemService.updatePendingReviewTimeout({
    timeoutMinutes: 10,
    updatedBy: 1,
    now,
  });
  const cancelledTaskIds = systemService.cancelStalePendingReviewTasks({ now });

  assert.equal(settings.timeoutMinutes, 10);
  assert.equal(systemService.getPendingReviewTimeoutSettings().timeoutMinutes, 10);
  assert.deepEqual(cancelledTaskIds, [olderTask.id]);
  assert.deepEqual(clearedTaskIds, [olderTask.id]);
  assert.equal(inventory.getTask(db, olderTask.id).status, "cancelled");
  assert.equal(inventory.getTask(db, insideWindowTask.id).status, "pending_review");
  assert.match(
    systemService.listRecentSystemEvents(1, "pending_review_timeout_setting_updated")[0].message,
    /10 minute/,
  );
});

test("admins can update task completion timeout from admin panel", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-task-timeout-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const { reloadAppState, getAppState } = await import("../src/server/app-state.js");
  reloadAppState();
  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const response = new MockResponse();

  await requestHandler(
    formRequest({
      url: "/admin/task-timeout",
      body: new URLSearchParams({
        timeout_minutes: "12",
      }).toString(),
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /^\/admin\?/);
  assert.match(response.headers.Location, /Task\+completion\+timeout\+saved%3A\+12\+minute/);
  assert.equal(getAppState().systemService.getPendingReviewTimeoutSettings().timeoutMinutes, 12);
});

test("recommended actions open as a scan-friendly list before detailed cleanup", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-recommended-actions-ux-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createHomePages } = await freshImport("../src/server/pages/home.js");
  const { createTaskPages } = await freshImport("../src/server/pages/tasks.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);
  const overCapacityCell = inventory.searchCells(db, "Z1-R1-C01")[0];
  assert.ok(overCapacityCell);

  const putTask = inventory.planPut(db, {
    userId: user.id,
    productId: shoe.id,
    quantity: 1,
    preferredCellId: overCapacityCell.id,
  });
  inventory.completeTask(db, {
    taskId: putTask.id,
    actualQuantities: { [putTask.lines[0].id]: 2 },
    actualCellIds: { [putTask.lines[0].id]: overCapacityCell.id },
    userId: user.id,
    note: "Create recommended action for UX test",
  });

  const actions = inventory.getRecommendedActions(db);
  assert.ok(actions.length > 0);

  const taskPages = createTaskPages({ db });
  const listHtml = taskPages.renderRecommendedActions(user, null, "");
  assert.match(listHtml, /Recommended Cleanup/);
  assert.match(listHtml, /Review/);
  assert.match(listHtml, /Space Created/);
  assert.match(listHtml, /No locations freed/);
  assert.doesNotMatch(listHtml, /Apply Recommendation/);

  const detailHtml = taskPages.renderRecommendedActions(user, null, actions[0].key, {
    source: "capacity",
    returnTo: "/products/1",
  });
  assert.match(detailHtml, /Apply Recommendation/);
  assert.match(detailHtml, /Show Pick\/Put LEDs/);
  assert.match(detailHtml, /Skip For Now/);
  assert.match(detailHtml, /The capacity update created this recommended action/);
  assert.match(detailHtml, /name="return_to" value="\/products\/1"/);

  const recoveryListHtml = taskPages.renderRecommendedActions(user, null, "", {
    source: "put-capacity",
    returnTo: "/put?product_id=1&quantity=99",
  });
  assert.match(recoveryListHtml, /Review space-saving actions/);
  assert.match(recoveryListHtml, /Return To Put/);
  assert.match(recoveryListHtml, /source=put-capacity/);
  assert.match(recoveryListHtml, /return_to=%2Fput%3Fproduct_id%3D1%26quantity%3D99/);

  const homePages = createHomePages({ db });
  const overviewHtml = homePages.renderHome(user, null, new URL("http://localhost/"));
  assert.match(overviewHtml, /Recommended Actions/);
  assert.match(overviewHtml, new RegExp(`/recommended-actions\\?key=${actions[0].key}`));
});

test("warehouse optimization recommendations consolidate product into closer cells", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-warehouse-optimize-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const recommendationGuidance = await freshImport("../src/server/guidance/recommended-actions.js");
  const { createHomePages } = await freshImport("../src/server/pages/home.js");
  const { createTaskPages } = await freshImport("../src/server/pages/tasks.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const product = inventory.createProduct(db, {
    sku: "OPT-A",
    name: "Optimization Product A",
    brand: "Warehouse",
    unit_of_measure: "items",
    items_per_cell: 5,
  });
  const cells = [1, 2, 3, 4, 5].map((index) =>
    inventory.createCell(db, {
      logicalCode: `OPT-R1-C0${index}`,
      createdBy: user.id,
    }),
  );
  [2, 3, 1, 2, 1].forEach((quantity, index) => {
    inventory.createAdjustment(db, {
      cellId: cells[index].id,
      userId: user.id,
      reason: "Seed optimization layout",
      lines: [{ productId: product.id, absoluteQuantity: quantity }],
    });
  });

  const action = inventory
    .getRecommendedActions(db)
    .find((entry) => entry.type === "warehouse_optimization" && entry.productId === product.id);
  assert.ok(action);
  assert.equal(action.optimizationPlan.currentCellCount, 5);
  assert.equal(action.optimizationPlan.idealCellCount, 2);
  assert.equal(action.freedLocationCount, 3);
  assert.deepEqual(
    action.freedLocations.map((location) => location.logicalCode),
    ["OPT-R1-C03", "OPT-R1-C04", "OPT-R1-C05"],
  );
  assert.deepEqual(
    action.optimizationPlan.targets.map((target) => [
      target.logicalCode,
      target.finalQuantity,
      target.putQuantity,
    ]),
    [
      ["OPT-R1-C01", 5, 3],
      ["OPT-R1-C02", 4, 1],
    ],
  );
  assert.deepEqual(
    action.optimizationPlan.sources.map((source) => [
      source.logicalCode,
      source.pickQuantity,
    ]),
    [
      ["OPT-R1-C03", 1],
      ["OPT-R1-C04", 2],
      ["OPT-R1-C05", 1],
    ],
  );

  const overviewHtml = createHomePages({ db }).renderHome(user, null, new URL("http://localhost/"));
  assert.match(overviewHtml, /Optimize Warehouse/);
  assert.match(overviewHtml, /href="\/recommended-actions"/);

  const detailHtml = createTaskPages({ db }).renderRecommendedActions(user, null, action.key);
  assert.match(detailHtml, /Frees 3 locations/);
  assert.match(detailHtml, /Show Full Optimization LEDs/);
  assert.match(detailHtml, /Put Into cell OPT-R1-C01[\s\S]*Quantity: 3/);
  assert.match(detailHtml, /Pick From cell OPT-R1-C04[\s\S]*Quantity: 2/);
  assert.equal((detailHtml.match(/Pick From cell OPT-R1-C04/g) || []).length, 1);
  assert.match(detailHtml, /name="move_source_0"/);
  assert.match(detailHtml, /disabled title="Show full optimization LEDs before applying this recommendation\."/);
  assert.doesNotMatch(detailHtml, /name="led_ready" value="1"/);
  assert.doesNotMatch(detailHtml, /data-recommendation-led-clear-form/);
  const ledReadyHtml = createTaskPages({ db }).renderRecommendedActions(user, null, action.key, {
    ledReady: true,
  });
  assert.match(ledReadyHtml, /Full optimization LEDs are active/);
  assert.match(ledReadyHtml, /name="led_ready" value="1"/);
  assert.match(ledReadyHtml, /data-recommendation-led-clear-form/);
  assert.match(ledReadyHtml, /name="active_light_move_index" value="all"/);
  assert.doesNotMatch(ledReadyHtml, /disabled title="Show full optimization LEDs before applying this recommendation\."/);
  const guidanceLines = recommendationGuidance.uniqueGuidanceLines(
    action.recommendedMoves.flatMap((move) =>
      recommendationGuidance.recommendationGuidanceLines(inventory.listCells(db), {
        sourceCellId: move.sourceCellId,
        targetCellId: move.targetCellId,
        quantity: move.quantity,
      }),
    ),
  );
  const guidanceByCell = new Map(
    guidanceLines.map((line) => [
      `${line.logical_code}:${line.guidance_color}`,
      Number(line.planned_quantity),
    ]),
  );
  assert.equal(guidanceByCell.get("OPT-R1-C01:red"), 3);
  assert.equal(guidanceByCell.get("OPT-R1-C02:red"), 1);
  assert.equal(guidanceByCell.get("OPT-R1-C04:green"), 2);

  inventory.applyRecommendedAction(db, {
    sourceCellId: action.cellId,
    productId: product.id,
    moves: action.recommendedMoves,
    userId: user.id,
    reason: "Apply optimization",
  });

  const finalQuantities = cells.map((cell) => {
    const detail = inventory.getCellDetail(db, cell.id);
    return Number(
      detail.products.find((entry) => Number(entry.product_id) === Number(product.id))
        ?.available_quantity || 0,
    );
  });
  assert.deepEqual(finalQuantities, [5, 4, 0, 0, 0]);
});

test("recommended action LEDs clear when the operator leaves without applying", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-recommendation-led-clear-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const { reloadAppState, getAppState } = await import("../src/server/app-state.js");
  reloadAppState();
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { requestHandler } = await freshImport("../src/server.js");

  const { db } = getAppState();
  const user = { id: 1, role: "admin" };
  const cookie = auth.createSessionCookie(user).split(";")[0];
  const product = inventory.createProduct(db, {
    sku: "OPT-CLEAR",
    name: "Optimization Clear Product",
    brand: "Warehouse",
    unit_of_measure: "items",
    items_per_cell: 5,
  });
  const cells = [1, 2, 3].map((index) =>
    inventory.createCell(db, {
      logicalCode: `CLR-R1-C0${index}`,
      createdBy: user.id,
    }),
  );
  [1, 1, 1].forEach((quantity, index) => {
    inventory.createAdjustment(db, {
      cellId: cells[index].id,
      userId: user.id,
      reason: "Seed recommendation LED clear",
      lines: [{ productId: product.id, absoluteQuantity: quantity }],
    });
  });

  const action = inventory
    .getRecommendedActions(db)
    .find((entry) => entry.type === "warehouse_optimization" && entry.productId === product.id);
  assert.ok(action);

  const invalidLightResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/recommended-actions/light-cell",
      body: new URLSearchParams({
        source_cell_id: String(action.cellId),
        product_id: String(action.productId),
        reason: action.title,
        recommendation_key: action.key,
        light_move_index: "all",
        move_source_0: String(action.recommendedMoves[0].sourceCellId || action.cellId),
        move_qty_0: "0",
        move_cell_0: String(action.recommendedMoves[0].targetCellId),
      }).toString(),
      cookie,
    }),
    invalidLightResponse,
  );
  assert.equal(invalidLightResponse.statusCode, 302);
  assert.doesNotMatch(invalidLightResponse.headers.Location, /led_ready=1/);
  assert.doesNotMatch(invalidLightResponse.headers.Location, /led_move_index=/);

  const lightBody = new URLSearchParams({
    source_cell_id: String(action.cellId),
    product_id: String(action.productId),
    reason: action.title,
    recommendation_key: action.key,
    light_move_index: "all",
  });
  action.recommendedMoves.forEach((move, index) => {
    lightBody.set(`move_source_${index}`, String(move.sourceCellId || action.cellId));
    lightBody.set(`move_qty_${index}`, String(move.quantity));
    lightBody.set(`move_cell_${index}`, String(move.targetCellId));
  });

  const lightResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/recommended-actions/light-cell",
      body: lightBody.toString(),
      cookie,
    }),
    lightResponse,
  );

  assert.equal(lightResponse.statusCode, 302);
  assert.match(lightResponse.headers.Location, /led_move_index=all/);

  const activeMetadataKey = `active_recommendation_guidance:${user.id}:${action.key}`;
  const activeMetadata = db
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get(activeMetadataKey);
  assert.ok(activeMetadata);
  const expectedClearCount = JSON.parse(activeMetadata.value).lines.length;
  assert.ok(expectedClearCount > 0);
  const clearedBeforeLeave = db
    .prepare(
      "SELECT COUNT(*) AS count FROM device_events WHERE event_type IN ('guidance_cleared', 'guidance_manual_clear')",
    )
    .get().count;

  const clearResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/recommended-actions/clear-leds",
      body: new URLSearchParams({
        recommendation_key: action.key,
        reason: action.title,
        active_light_move_index: "all",
      }).toString(),
      cookie,
      headers: {
        "x-requested-with": "fetch",
      },
    }),
    clearResponse,
  );

  assert.equal(clearResponse.statusCode, 204);
  const clearedEvents = db
    .prepare(
      "SELECT event_type FROM device_events WHERE event_type IN ('guidance_cleared', 'guidance_manual_clear')",
    )
    .all();
  assert.equal(clearedEvents.length - clearedBeforeLeave, expectedClearCount);
  assert.equal(
    db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(activeMetadataKey),
    undefined,
  );
});

test("admins can revoke registration keys and suspend user access", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-admin-access-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const generatedKey = inventory.issueRegistrationKey(db, {
    role: "operator",
    userId: 1,
  });
  assert.match(generatedKey.key_value, /^OP-/);
  assert.equal(generatedKey.status, "active");
  assert.equal(generatedKey.usage_policy, "single_use");

  const singleUseKey = inventory.issueRegistrationKey(db, {
    keyValue: "SINGLE-OP-KEY",
    role: "operator",
    userId: 1,
  });
  inventory.registerUser(db, {
    registrationKey: singleUseKey.key_value,
    name: "Single Use Operator",
    username: "single-use-operator",
    password: "operator123",
    hashPassword: auth.hashPassword,
  });
  const usedSingleUseKey = inventory
    .listRegistrationKeys(db)
    .find((entry) => entry.key_value === singleUseKey.key_value);
  assert.equal(usedSingleUseKey.status, "used");
  assert.equal(usedSingleUseKey.usage_count, 1);
  assert.throws(
    () =>
      inventory.registerUser(db, {
        registrationKey: singleUseKey.key_value,
        name: "Second Single Use Operator",
        username: "second-single-use-operator",
        password: "operator123",
        hashPassword: auth.hashPassword,
      }),
    /Registration key is not active\./,
  );

  const teamKey = inventory.issueRegistrationKey(db, {
    keyValue: "TEAM-OPS-KEY",
    role: "operator",
    usagePolicy: "global",
    userId: 1,
  });
  assert.equal(teamKey.usage_policy, "global");
  assert.equal(teamKey.expires_at, null);
  for (const username of ["team-operator-a", "team-operator-b"]) {
    inventory.registerUser(db, {
      registrationKey: teamKey.key_value,
      name: username.replaceAll("-", " "),
      username,
      password: "operator123",
      hashPassword: auth.hashPassword,
    });
  }
  const usedTeamKey = inventory
    .listRegistrationKeys(db)
    .find((entry) => entry.key_value === teamKey.key_value);
  assert.equal(usedTeamKey.status, "active");
  assert.equal(usedTeamKey.usage_count, 2);
  const suspendedTeamKey = inventory.revokeRegistrationKey(db, { keyId: teamKey.id });
  assert.equal(suspendedTeamKey.status, "revoked");
  assert.throws(
    () =>
      inventory.registerUser(db, {
        registrationKey: teamKey.key_value,
        name: "Late Team Operator",
        username: "late-team-operator",
        password: "operator123",
        hashPassword: auth.hashPassword,
      }),
    /Registration key is not active\./,
  );

  inventory.issueRegistrationKey(db, {
    keyValue: "TEMP-OP-KEY",
    role: "operator",
    userId: 1,
  });
  const key = inventory
    .listRegistrationKeys(db)
    .find((entry) => entry.key_value === "TEMP-OP-KEY");
  assert.ok(key);

  const revokedKey = inventory.revokeRegistrationKey(db, { keyId: key.id });
  assert.equal(revokedKey.status, "revoked");
  assert.throws(
    () =>
      inventory.registerUser(db, {
        registrationKey: "TEMP-OP-KEY",
        name: "Temporary Operator",
        username: "temp-operator",
        password: "operator123",
        hashPassword: auth.hashPassword,
      }),
    /Registration key is not active\./,
  );

  const operator = inventory.listUsers(db).find((entry) => entry.username === "operator");
  assert.ok(operator);
  const suspended = inventory.setUserStatus(db, {
    userId: operator.id,
    status: "inactive",
    actingUserId: 1,
  });
  assert.equal(suspended.status, "inactive");
  assert.throws(
    () =>
      inventory.authenticateUser(db, {
        username: "operator",
        password: "operator123",
        verifyPassword: auth.verifyPassword,
      }),
    /Invalid username or password\./,
  );

  const restored = inventory.setUserStatus(db, {
    userId: operator.id,
    status: "active",
    actingUserId: 1,
  });
  assert.equal(restored.status, "active");
  assert.equal(
    inventory.authenticateUser(db, {
      username: "operator",
      password: "operator123",
      verifyPassword: auth.verifyPassword,
    }).status,
    "active",
  );
  assert.throws(
    () =>
      inventory.setUserStatus(db, {
        userId: 1,
        status: "inactive",
        actingUserId: 1,
      }),
    /You cannot suspend your own account\./,
  );
  const activeTeamKey = inventory.issueRegistrationKey(db, {
    keyValue: "ACTIVE-TEAM-KEY",
    role: "operator",
    usagePolicy: "global",
    userId: 1,
  });

  const { createAdminPages } = await freshImport("../src/server/pages/admin.js");
  const adminHtml = createAdminPages({ db }).renderAdmin(
    { id: 1, name: "Admin", username: "admin", role: "admin" },
    null,
  );
  assert.match(adminHtml, /Generate Operator Key/);
  assert.match(adminHtml, /Generate Global Operator Key/);
  assert.match(adminHtml, /Generate Admin Key/);
  assert.match(adminHtml, /Global Operator Team Key/);
  assert.match(adminHtml, /Global Operator/);
  assert.match(adminHtml, /Task Completion Timeout/);
  assert.match(adminHtml, /action="\/admin\/task-timeout"/);
  assert.match(adminHtml, /name="timeout_minutes"/);
  assert.match(adminHtml, /value="5"/);
  assert.match(adminHtml, /2 Registered/);
  assert.match(adminHtml, /one-time key per person/);
  assert.match(adminHtml, /data-copy-value=/);
  assert.match(adminHtml, new RegExp(`aria-label="Suspend registration key ${activeTeamKey.key_value}"[\\s\\S]*suspend-icon`));
  assert.match(adminHtml, new RegExp(`aria-label="Delete registration key ${generatedKey.key_value}"[\\s\\S]*M3 6h18`));
  assert.match(adminHtml, new RegExp(`href="/admin/users/${operator.id}"`));
  const registrationKeysIndex = adminHtml.indexOf("<h2>Registration Keys</h2>");
  const usersIndex = adminHtml.indexOf("<h2>Users</h2>");
  const countAdjustmentIndex = adminHtml.indexOf("<h2>Count Adjustment</h2>");
  const taskTimeoutIndex = adminHtml.indexOf("<h2>Task Completion Timeout</h2>");
  assert.ok(registrationKeysIndex !== -1);
  assert.ok(usersIndex !== -1);
  assert.ok(countAdjustmentIndex !== -1);
  assert.ok(taskTimeoutIndex !== -1);
  assert.ok(registrationKeysIndex < countAdjustmentIndex);
  assert.ok(usersIndex < countAdjustmentIndex);
  assert.ok(countAdjustmentIndex < taskTimeoutIndex);
  assert.doesNotMatch(adminHtml, /<h2>Backup Schedule<\/h2>/);
  assert.match(adminHtml, /Preview Quantity LED/);
  assert.match(adminHtml, /Products Counted In This Cell/);
  assert.match(adminHtml, /Select a cell to load saved product counts\./);
  assert.match(adminHtml, /data-adjustment-empty/);
});

test("adjustment preview guidance targets selected cell with entered quantity total", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-adjustment-preview-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { adjustmentQuantityGuidance } = await freshImport("../src/server/guidance/adjustments.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const cell = inventory.listCells(db)[0];
  const preview = adjustmentQuantityGuidance(inventory.listCells(db), {
    cellId: cell.id,
    lines: [
      { absoluteQuantity: "2" },
      { absoluteQuantity: "3.5" },
    ],
  });

  assert.equal(preview.displayQuantity, "5.5");
  assert.equal(preview.lines[0].cell_id, cell.id);
  assert.equal(preview.lines[0].guidance_color, "amber");
  assert.equal(preview.lines[0].planned_quantity, "5.5");
  assert.throws(
    () =>
      adjustmentQuantityGuidance(inventory.listCells(db), {
        cellId: cell.id,
        lines: [{ absoluteQuantity: "" }],
      }),
    /Enter at least one adjustment quantity/,
  );
});

test("admin adjustment product rows load from the selected cell", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-adjustment-cell-products-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const adjustmentResponse = new MockResponse();

  await requestHandler(
    formRequest({
      url: "/admin/adjustments",
      body: new URLSearchParams({
        cell_id: "1",
        product_id_0: "2",
        absolute_quantity_0: "2",
        reason: "Add second counted item",
      }).toString(),
      cookie,
    }),
    adjustmentResponse,
  );

  assert.equal(adjustmentResponse.statusCode, 302);

  const response = new MockResponse();
  await requestHandler(
    formRequest({
      method: "GET",
      url: "/api/admin/adjustments/cell-products?cell_id=1",
      body: "",
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.cell.id, 1);
  assert.ok(payload.products.some((product) => product.productId === 1));
  assert.ok(
    payload.products.some(
      (product) => product.productId === 2 && Number(product.availableQuantity) === 2,
    ),
  );
  assert.equal(payload.nextIndex, payload.products.length);
  assert.match(payload.linesHtml, /adjustment-line-saved/);
  assert.match(payload.linesHtml, /data-original-product-id="1"/);
  assert.match(payload.linesHtml, /data-original-product-id="2"/);
  assert.match(payload.linesHtml, /name="absolute_quantity_0"/);
});

test("backups can restore previous data and prune old automatic snapshots", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-backups-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createBackupService } = await freshImport("../src/services/backups.js");

  let currentDb = createDatabase({ hashPassword: auth.hashPassword });
  const backupService = createBackupService({
    getDb: () => currentDb,
    reloadAppState: ({ closeCurrentDb = true } = {}) => {
      if (closeCurrentDb && currentDb) {
        currentDb.close();
      }
      currentDb = createDatabase({ hashPassword: auth.hashPassword });
      return { db: currentDb };
    },
    logger: {
      info() {},
      warn() {},
    },
    autoBackupLimit: 2,
  });

  const shoe = inventory.listProducts(currentDb).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const originalQuantity =
    inventory
      .getCellDetail(currentDb, 1)
      .products.find((product) => product.product_id === shoe.id)?.available_quantity || 0;

  const manualBackup = backupService.createBackup({
    kind: "manual",
    source: "before-adjustment",
  });

  inventory.createAdjustment(currentDb, {
    cellId: 1,
    userId: 1,
    reason: "Backup restore test",
    lines: [
      {
        productId: shoe.id,
        absoluteQuantity: 99,
      },
    ],
  });

  const changedQuantity =
    inventory
      .getCellDetail(currentDb, 1)
      .products.find((product) => product.product_id === shoe.id)?.available_quantity || 0;
  assert.equal(Number(changedQuantity), 99);

  const restore = backupService.restoreBackup(manualBackup.filename);
  assert.equal(restore.restoredBackup.filename, manualBackup.filename);
  assert.match(restore.restorePoint.filename, /^manual-.*-pre-restore-before-adjustment\.sqlite$/);

  const restoredQuantity =
    inventory
      .getCellDetail(currentDb, 1)
      .products.find((product) => product.product_id === shoe.id)?.available_quantity || 0;
  assert.equal(Number(restoredQuantity), Number(originalQuantity));

  const firstAuto = backupService.createAutomaticBackupIfDue({
    source: "daily-auto",
    now: new Date("2026-05-15T00:00:00.000Z"),
  });
  assert.equal(firstAuto.created, true);
  const skippedAuto = backupService.createAutomaticBackupIfDue({
    source: "same-day-auto",
    now: new Date("2026-05-15T12:00:00.000Z"),
  });
  assert.equal(skippedAuto.created, false);
  assert.equal(skippedAuto.reason, "not_due");
  const nextDayAuto = backupService.createAutomaticBackupIfDue({
    source: "next-day-auto",
    now: new Date("2026-05-16T00:01:00.000Z"),
  });
  assert.equal(nextDayAuto.created, true);

  backupService.createBackup({ kind: "auto", source: "first-auto" });
  backupService.createBackup({ kind: "auto", source: "second-auto" });
  backupService.createBackup({ kind: "auto", source: "third-auto" });

  const automaticBackups = backupService
    .listBackups()
    .filter((backup) => backup.kind === "auto");
  assert.equal(automaticBackups.length, 2);

  backupService.createCriticalBackup({ source: "controller-added" });
  backupService.createCriticalBackup({ source: "cell-mapping-updated" });
  assert.equal(
    backupService.listBackups().filter((backup) => backup.kind === "critical").length,
    2,
  );
  backupService.createBackup({ kind: "auto", source: "scheduled-rollup" });
  assert.equal(
    backupService.listBackups().filter((backup) => backup.kind === "critical").length,
    0,
  );

  const schedule = backupService.updateAutomaticBackupSchedule({
    cadence: "weekly",
    startTime: "03:15",
    now: new Date("2026-05-17T00:00:00.000Z"),
  });
  assert.equal(schedule.label, "Weekly");
  assert.equal(schedule.startTime, "03:15");
  assert.equal(backupService.getSummary().automaticBackupSchedule.cadence, "weekly");
});

test("backup maintenance compacts previous days and enforces retention days", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-backup-compaction-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const { createBackupService } = await freshImport("../src/services/backups.js");

  let currentDb = createDatabase({ hashPassword: auth.hashPassword });
  const backupService = createBackupService({
    getDb: () => currentDb,
    reloadAppState: () => ({ db: currentDb }),
    logger: {
      info() {},
      warn() {},
    },
    autoBackupLimit: 20,
  });

  const olderMorning = backupService.createBackup({
    kind: "manual",
    source: "older-morning",
    now: new Date("2026-05-16T08:00:00.000Z"),
  });
  const olderEvening = backupService.createBackup({
    kind: "manual",
    source: "older-evening",
    now: new Date("2026-05-16T18:00:00.000Z"),
  });
  assert.equal(
    backupService.listBackups().filter((backup) => backup.createdAt.startsWith("2026-05-16"))
      .length,
    2,
  );

  backupService.createBackup({
    kind: "auto",
    source: "new-day-rollover",
    now: new Date("2026-05-17T00:05:00.000Z"),
  });

  const compactedDayBackups = backupService
    .listBackups()
    .filter((backup) => backup.createdAt.startsWith("2026-05-16"));
  assert.equal(compactedDayBackups.length, 1);
  assert.equal(compactedDayBackups[0].kind, "compacted");
  assert.match(compactedDayBackups[0].filename, /^compacted-.*-compacted-backup-2026-05-16\.sqlite$/);
  assert.equal(compactedDayBackups[0].label, "Compacted Backup For 2026-05-16");
  assert.equal(existsSync(olderMorning.path), false);
  assert.equal(existsSync(olderEvening.path), false);

  const retention = backupService.updateBackupRetention({
    retentionDays: 1,
    now: new Date("2026-05-18T01:00:00.000Z"),
  });
  assert.equal(retention.retentionDays, 1);
  assert.equal(
    backupService.listBackups().some((backup) => backup.createdAt.startsWith("2026-05-16")),
    false,
  );
  assert.equal(backupService.getSummary().retentionDays, 1);
});

test("backup maintenance keeps retained days and prunes excess active-day backups", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-backup-active-day-prune-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const { createBackupService } = await freshImport("../src/services/backups.js");

  let currentDb = createDatabase({ hashPassword: auth.hashPassword });
  const backupService = createBackupService({
    getDb: () => currentDb,
    reloadAppState: () => ({ db: currentDb }),
    logger: {
      info() {},
      warn() {},
    },
    autoBackupLimit: 15,
  });

  backupService.updateBackupRetention({
    retentionDays: 10,
    now: new Date("2026-05-01T00:00:00.000Z"),
  });

  for (let day = 8; day <= 17; day += 1) {
    backupService.createBackup({
      kind: "manual",
      source: `retained-day-${day}`,
      now: new Date(`2026-05-${String(day).padStart(2, "0")}T12:00:00.000Z`),
    });
  }

  for (let index = 0; index <= 50; index += 1) {
    backupService.createBackup({
      kind: "manual",
      source: `t-${index}`,
      now: new Date(`2026-05-18T12:${String(index).padStart(2, "0")}:00.000Z`),
    });
  }

  const backups = backupService.listBackups();
  const retainedDays = backups.filter((backup) => backup.createdAt < "2026-05-18T00:00:00.000Z");
  const todayBackups = backups.filter((backup) => backup.createdAt.startsWith("2026-05-18"));

  assert.equal(retainedDays.length, 10);
  assert.ok(
    retainedDays.every((backup) => backup.kind === "compacted"),
    "previous days should be compacted to one backup per day",
  );
  assert.equal(todayBackups.length, 5);
  assert.deepEqual(
    todayBackups.map((backup) => backup.source),
    ["t-50", "t-49", "t-48", "t-47", "t-46"],
  );
  assert.equal(backups.length, 15);
  assert.equal(
    backupService.getSummary({ now: new Date("2026-05-18T12:50:00.000Z") })
      .activeDayBackupLimit,
    5,
  );
});

test("admins can update automatic backup schedule from the backup panel", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-backup-schedule-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const response = new MockResponse();

  await requestHandler(
    formRequest({
      url: "/backups/schedule",
      body: new URLSearchParams({
        cadence: "biweekly",
        start_time: "04:45",
        return_to: "/admin",
      }).toString(),
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /^\/admin\?/);
  assert.match(response.headers.Location, /tone=success/);

  const retentionResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/backups/retention",
      body: new URLSearchParams({
        retention_days: "20",
        return_to: "/backups",
      }).toString(),
      cookie,
    }),
    retentionResponse,
  );

  assert.equal(retentionResponse.statusCode, 302);
  assert.match(retentionResponse.headers.Location, /^\/backups\?/);
  assert.match(retentionResponse.headers.Location, /tone=success/);

  const pageResponse = new MockResponse();
  await requestHandler(
    formRequest({
      method: "GET",
      url: "/backups",
      body: "",
      cookie,
    }),
    pageResponse,
  );

  assert.equal(pageResponse.statusCode, 200);
  assert.match(pageResponse.body, /Bi Weekly/);
  assert.match(pageResponse.body, /04:45/);
  assert.match(pageResponse.body, /Save Schedule/);
  assert.match(pageResponse.body, /Retention And Compaction/);
  assert.match(pageResponse.body, /20 Day\(s\)/);
  assert.match(pageResponse.body, /Save Retention/);
});

test("critical device changes create interim critical backups", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-critical-backup-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const { getAppState } = await import("../src/server/app-state.js");
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const response = new MockResponse();

  await requestHandler(
    formRequest({
      url: "/devices/cells",
      body: new URLSearchParams({
        logical_code: "Z1-R9-C99",
        capacity: "12",
      }).toString(),
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /Cell\+Z1-R9-C99\+added/);

  const createdCell = getAppState()
    .locationService.listCells()
    .find((cell) => cell.logical_code === "Z1-R9-C99");
  assert.ok(createdCell);

  const renameResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/devices/cells/rename",
      body: new URLSearchParams({
        cell_id: String(createdCell.id),
        logical_code: "Z1-R9-C98",
      }).toString(),
      cookie,
    }),
    renameResponse,
  );

  assert.equal(renameResponse.statusCode, 302);
  assert.match(renameResponse.headers.Location, /Cell\+renamed\+to\+Z1-R9-C98/);
  assert.equal(
    getAppState()
      .locationService.listCells()
      .find((cell) => cell.id === createdCell.id).logical_code,
    "Z1-R9-C98",
  );

  const deleteResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/devices/cells/delete",
      body: new URLSearchParams({
        cell_id: String(createdCell.id),
      }).toString(),
      cookie,
    }),
    deleteResponse,
  );

  assert.equal(deleteResponse.statusCode, 302);
  assert.match(deleteResponse.headers.Location, /Cell\+Z1-R9-C98\+deleted/);

  const backupNames = readdirSync(join(sandbox, "data", "backups"));
  assert.ok(
    backupNames.some(
      (name) => name.startsWith("critical-") && name.includes("cell-created"),
    ),
  );
  assert.ok(
    backupNames.some(
      (name) => name.startsWith("critical-") && name.includes("cell-delete-before"),
    ),
  );
  assert.ok(
    backupNames.some(
      (name) => name.startsWith("critical-") && name.includes("cell-renamed"),
    ),
  );
  assert.ok(
    backupNames.some(
      (name) => name.startsWith("critical-") && /-cell-delete\.sqlite$/.test(name),
    ),
  );
});

test("database maintenance prunes operational logs and archives old business history", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-db-maintenance-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createDatabaseMaintenanceService } = await freshImport(
    "../src/services/database-maintenance.js",
  );

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const oldTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });
  inventory.cancelTask(db, { taskId: oldTask.id });
  const recentTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });

  const oldTimestamp = "2023-01-15T10:00:00.000Z";
  db.prepare(
    `
      UPDATE tasks
      SET started_at = ?, completed_at = ?, last_touched_at = ?
      WHERE id = ?
    `,
  ).run(oldTimestamp, oldTimestamp, oldTimestamp, oldTask.id);
  db.prepare(
    `
      INSERT INTO transactions (
        type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
      )
      VALUES ('pick', ?, ?, -1, 1, ?, 'Old pick archive test', ?)
    `,
  ).run(shoe.id, oldTask.lines[0].cell_id, oldTask.id, oldTimestamp);
  db.prepare(
    `
      INSERT INTO device_events (controller_id, cell_id, task_id, event_type, payload, created_at)
      VALUES (NULL, ?, ?, 'guidance_activated', '{}', ?)
    `,
  ).run(oldTask.lines[0].cell_id, oldTask.id, oldTimestamp);
  db.prepare(
    `
      INSERT INTO system_events (event_type, status, message, payload, created_at)
      VALUES ('old-health-check', 'info', 'Old system event', NULL, ?)
    `,
  ).run(oldTimestamp);

  const safetyBackups = [];
  const maintenance = createDatabaseMaintenanceService({
    db,
    backupService: {
      createBackup(options) {
        safetyBackups.push(options);
        return { filename: "pre-maintenance-archive.sqlite" };
      },
      getSummary() {
        return {
          latestAutomaticBackup: null,
        };
      },
      listBackups() {
        return [];
      },
    },
    config: {
      automaticBackupIntervalHours: 24,
      businessArchiveAfterDays: 730,
      deviceEventRetentionDays: 90,
      reportDefaultDays: 30,
      systemEventRetentionDays: 90,
    },
    logger: {
      info() {},
      warn() {},
    },
  });

  const summary = maintenance.runStartupMaintenance({
    now: new Date("2026-05-15T00:00:00.000Z"),
  });

  assert.equal(summary.errors.length, 0);
  assert.equal(summary.businessArchive.archived, true);
  assert.deepEqual(safetyBackups, [{ kind: "manual", source: "pre-maintenance-archive" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").get(oldTask.id).count, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM task_lines WHERE task_id = ?").get(oldTask.id).count,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE task_id = ?").get(oldTask.id).count,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM device_events WHERE task_id = ?").get(oldTask.id).count,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM system_events WHERE event_type = 'old-health-check'").get()
      .count,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").get(recentTask.id).count,
    1,
  );

  const archiveDir = join(sandbox, "data", "archives");
  assert.equal(existsSync(archiveDir), true);
  const archiveFiles = readdirSync(archiveDir).filter((entry) => entry.endsWith(".json"));
  assert.equal(archiveFiles.length, 1);
  const archive = JSON.parse(readFileSync(join(archiveDir, archiveFiles[0]), "utf8"));
  assert.equal(archive.month, "2023-01");
  assert.equal(archive.tasks.length, 1);
  assert.equal(archive.taskLines.length, oldTask.lines.length);
  assert.equal(archive.transactions.length, 1);

  const health = maintenance.getDatabaseHealth();
  assert.ok(health.rowCounts.some((row) => row.tableName === "transactions"));
  assert.equal(health.archiveSummary.fileCount, 1);
  assert.equal(health.settings.businessArchiveAfterDays, 730);
});

test("recommended move guidance displays quantity on source and target with pick and put colors", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-recommended-guidance-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createHardwareService } = await freshImport("../src/services/hardware.js");
  const { createLogger } = await freshImport("../src/logger.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const controller = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-REC",
    controllerAddress: "CTRL-REC",
    moduleCount: 2,
    configuredBy: 1,
  });
  const [sourceModule, targetModule] = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === controller.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const sourceLocation = inventory.searchCells(db, "Z1-R1-C01")[0];
  const targetLocation = inventory.searchCells(db, "Z1-R1-C02")[0];
  inventory.updateCellMapping(db, {
    cellId: sourceModule.id,
    hardwareChannel: 1,
    targetCellId: sourceLocation.id,
    mappedBy: 1,
  });
  inventory.updateCellMapping(db, {
    cellId: targetModule.id,
    hardwareChannel: 2,
    targetCellId: targetLocation.id,
    mappedBy: 1,
  });
  const sourceCell = inventory.listCells(db).find((cell) => cell.id === sourceLocation.id);
  const targetCell = inventory.listCells(db).find((cell) => cell.id === targetLocation.id);
  const hardwareService = createHardwareService({
    db,
    config: {
      hardwareAdapter: "simulator",
    },
    logger: createLogger({ level: "error", siteId: "test-site" }),
  });

  const guidance = hardwareService.activateGuidance(
    {
      id: null,
      type: "recommended_move",
    },
    [
      {
        ...sourceCell,
        cell_id: sourceCell.id,
        planned_quantity: 10,
        guidance_color: "green",
      },
      {
        ...targetCell,
        cell_id: targetCell.id,
        planned_quantity: 10,
        guidance_color: "red",
      },
    ],
    {
      source: "recommended_action_light",
    },
  );

  assert.equal(guidance.degraded, false);
  const payloads = db
    .prepare("SELECT payload FROM device_events WHERE event_type = 'guidance_activated' ORDER BY id")
    .all()
    .map((row) => JSON.parse(row.payload));
  assert.deepEqual(
    payloads.map((payload) => payload.color),
    ["green", "red"],
  );
  assert.deepEqual(
    payloads.map((payload) => Number(payload.quantity)),
    [10, 10],
  );
  assert.deepEqual(
    payloads.map((payload) => payload.taskType),
    ["recommended_move", "recommended_move"],
  );
});

test("startup recovery records stale guidance cleanup in degraded mode", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-recovery-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createLogger } = await freshImport("../src/logger.js");
  const { createHardwareService } = await freshImport("../src/services/hardware.js");
  const { createSystemService } = await freshImport("../src/services/system.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const task = inventory.allocatePick(db, {
    userId: 1,
    productId: 1,
    quantity: 1,
  });
  assert.equal(task.status, "pending_review");

  const logger = createLogger({ level: "error", siteId: "test-site" });
  const hardwareService = createHardwareService({
    db,
    config: {
      hardwareAdapter: "degraded",
    },
    logger,
  });
  const systemService = createSystemService({
    db,
    config: {
      siteId: "test-site",
    },
    logger,
    hardwareService,
    getTask: inventory.getTask,
  });

  const startup = systemService.runStartupChecks();
  assert.equal(startup.hardware.status, "degraded");
  const recoveredTaskIds = systemService.recoverPendingGuidance();
  assert.deepEqual(recoveredTaskIds, [task.id]);

  const recoveryEvents = systemService.listRecentSystemEvents(5, "startup_recovery");
  assert.ok(recoveryEvents.some((event) => event.message.includes(`task #${task.id}`)));
  const hardwareEvents = db.prepare("SELECT * FROM device_events WHERE event_type = 'guidance_clear_skipped'").all();
  assert.ok(hardwareEvents.length >= 1);
});

test("system health summary reflects current controller health after startup warning", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-live-controller-health-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createLogger } = await freshImport("../src/logger.js");
  const { createSystemService } = await freshImport("../src/services/system.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE status = 'pending_review'").run();
  const logger = createLogger({ level: "error", siteId: "test-site" });
  let controllerStatus = "offline";
  const hardwareService = {
    adapterName: "test-rs485",
    healthCheck() {
      return {
        status: "healthy",
        message: "Test RS485 adapter active.",
      };
    },
    checkControllerHealth(controller) {
      return {
        ok: controllerStatus === "online",
        degraded: controllerStatus !== "online",
        status: controllerStatus,
        message: `${controller.controller_code} is ${controllerStatus}.`,
      };
    },
  };
  const systemService = createSystemService({
    db,
    config: {
      siteId: "test-site",
    },
    logger,
    hardwareService,
    getTask: inventory.getTask,
  });

  const startup = systemService.runStartupChecks();
  assert.equal(startup.controllers.status, "warning");
  assert.equal(systemService.healthSummary(startup).overallStatus, "warning");

  controllerStatus = "online";
  assert.ok(systemService.refreshControllerHealths().every((result) => result.status === "online"));

  const summary = systemService.healthSummary(startup);
  assert.equal(startup.controllers.status, "warning");
  assert.equal(summary.startup.controllers.status, "healthy");
  assert.equal(summary.overallStatus, "healthy");
  assert.match(summary.startup.controllers.message, /controllers online/);
});

test("offline controllers retry three times at thirty seconds before five minute backoff", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-controller-retry-cadence-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createLogger } = await freshImport("../src/logger.js");
  const { createSystemService } = await freshImport("../src/services/system.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE status = 'pending_review'").run();
  const controllers = inventory.listControllers(db);
  const offlineController = controllers[0];
  const attempts = new Map();
  const logger = createLogger({ level: "error", siteId: "test-site" });
  const hardwareService = {
    adapterName: "test-rs485",
    healthCheck() {
      return {
        status: "healthy",
        message: "Test RS485 adapter active.",
      };
    },
    checkControllerHealth(controller) {
      attempts.set(controller.id, Number(attempts.get(controller.id) || 0) + 1);
      const isOffline = controller.id === offlineController.id;
      return {
        ok: !isOffline,
        degraded: isOffline,
        status: isOffline ? "offline" : "online",
        message: `${controller.controller_code} ${isOffline ? "did not respond" : "responded"}.`,
      };
    },
  };
  const systemService = createSystemService({
    db,
    config: {
      siteId: "test-site",
    },
    logger,
    hardwareService,
    getTask: inventory.getTask,
  });

  const startedAt = new Date("2026-05-18T10:00:00.000Z");
  const startup = systemService.runStartupChecks({ now: startedAt });
  assert.equal(attempts.get(offlineController.id), 1);
  assert.match(
    systemService.healthSummary(startup).message,
    new RegExp(`Controller ${offlineController.controller_code} offline\\. Retrying after 30 seconds\\.`),
  );

  assert.deepEqual(
    systemService.refreshDueControllerHealths({ now: new Date(startedAt.getTime() + 29_000) }),
    [],
  );
  assert.equal(attempts.get(offlineController.id), 1);

  for (const elapsedMs of [30_000, 60_000]) {
    const results = systemService.refreshDueControllerHealths({
      now: new Date(startedAt.getTime() + elapsedMs),
    });
    assert.equal(results.length, controllers.length);
    assert.ok(
      results.some(
        (result) => result.controllerId === offlineController.id && result.status === "offline",
      ),
    );
    assert.equal(
      results.filter((result) => result.controllerId !== offlineController.id).length,
      controllers.length - 1,
    );
    assert.match(
      systemService.healthSummary(startup).message,
      new RegExp(`Controller ${offlineController.controller_code} offline\\. Retrying after 30 seconds\\.`),
    );
  }

  const thirdRetry = systemService.refreshDueControllerHealths({
    now: new Date(startedAt.getTime() + 90_000),
  });
  assert.equal(thirdRetry.length, controllers.length);
  assert.ok(
    thirdRetry.some(
      (result) => result.controllerId === offlineController.id && result.status === "offline",
    ),
  );
  assert.match(
    systemService.healthSummary(startup).message,
    new RegExp(`Controller ${offlineController.controller_code} offline\\. Retrying after 5 minutes\\.`),
  );
  assert.equal(attempts.get(offlineController.id), 4);

  const onlineRefresh = systemService.refreshDueControllerHealths({
    now: new Date(startedAt.getTime() + 300_000),
  });
  assert.equal(onlineRefresh.length, controllers.length - 1);
  assert.ok(onlineRefresh.every((result) => result.controllerId !== offlineController.id));
  assert.ok(onlineRefresh.every((result) => result.status === "online"));

  assert.deepEqual(
    systemService.refreshDueControllerHealths({ now: new Date(startedAt.getTime() + 329_000) }),
    [],
  );
  assert.equal(attempts.get(offlineController.id), 4);

  const recurringOnlineRefresh = systemService.refreshDueControllerHealths({
    now: new Date(startedAt.getTime() + 330_000),
  });
  assert.equal(recurringOnlineRefresh.length, controllers.length - 1);
  assert.ok(recurringOnlineRefresh.every((result) => result.controllerId !== offlineController.id));
  assert.ok(recurringOnlineRefresh.every((result) => result.status === "online"));

  const beforeBackoffRetry = systemService.refreshDueControllerHealths({
    now: new Date(startedAt.getTime() + 389_000),
  });
  assert.equal(attempts.get(offlineController.id), 4);
  assert.ok(beforeBackoffRetry.every((result) => result.controllerId !== offlineController.id));

  const backedOffRetry = systemService.refreshDueControllerHealths({
    now: new Date(startedAt.getTime() + 390_000),
  });
  assert.equal(backedOffRetry.length, 1);
  assert.equal(backedOffRetry[0].controllerId, offlineController.id);
  assert.equal(attempts.get(offlineController.id), 5);
});

test("system health warning clears when startup recovery tasks are resolved", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-recovery-health-clear-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createLogger } = await freshImport("../src/logger.js");
  const { createSystemService } = await freshImport("../src/services/system.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const task = inventory.allocatePick(db, {
    userId: 1,
    productId: 1,
    quantity: 1,
  });
  const logger = createLogger({ level: "error", siteId: "test-site" });
  const hardwareService = {
    adapterName: "test-rs485",
    healthCheck() {
      return {
        status: "healthy",
        message: "Test RS485 adapter active.",
      };
    },
    checkControllerHealth(controller) {
      return {
        ok: true,
        degraded: false,
        status: "online",
        message: `${controller.controller_code} responded.`,
      };
    },
    clearGuidance() {
      return {
        ok: true,
        degraded: false,
      };
    },
  };
  const systemService = createSystemService({
    db,
    config: {
      siteId: "test-site",
    },
    logger,
    hardwareService,
    getTask: inventory.getTask,
  });

  const startup = systemService.runStartupChecks();
  assert.equal(systemService.healthSummary(startup).overallStatus, "warning");
  assert.match(systemService.healthSummary(startup).message, /Recovery:/);

  inventory.cancelTask(db, { taskId: task.id });
  const summary = systemService.healthSummary(startup);
  assert.equal(summary.overallStatus, "healthy");
  assert.equal(summary.message, "System is healthy.");
  assert.deepEqual(summary.startup.recovery.pendingTaskIds, []);
});

test("reflashing an existing controller migrates mappings to the new RS485 id", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-controller-migration-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const initial = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-OLD-000001",
    moduleCount: 28,
    configuredBy: 1,
  });
  const initialModules = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.equal(initialModules.length, 28);
  assert.ok(initialModules.every((cell) => Number(cell.active) === 0));
  assert.equal(inventory.listCells(db).filter((cell) => cell.controller_id === initial.id).length, 0);
  const customCell = inventory.createCell(db, {
    logicalCode: "Z9-R9-C99",
    capacity: 12,
    createdBy: 1,
  });
  inventory.updateCellMapping(db, {
    cellId: initialModules[27].id,
    hardwareChannel: 28,
    targetCellId: customCell.id,
    mappedBy: 1,
  });

  const replacement = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-NEW-000001",
    moduleCount: 28,
    configuredBy: 1,
  });
  const migratedModules = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === replacement.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const migratedCell = inventory.listCells(db).find((cell) => cell.id === customCell.id);

  assert.equal(replacement.id, initial.id);
  assert.equal(replacement.address, "CTRL-NEW-000001");
  assert.equal(migratedModules.length, 28);
  assert.equal(migratedCell.logical_code, "Z9-R9-C99");
  assert.equal(migratedCell.hardware_channel, 28);
  assert.equal(migratedCell.controller_address, "CTRL-NEW-000001");
  assert.equal(
    migratedModules.filter((cell) => Number(cell.active) === 0).length,
    27,
  );
});

test("reflashing the same physical controller preserves what it can when module count changes", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-controller-reflash-modules-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const initial = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-SAME-OLD",
    deviceIdentity: "usb-same-controller",
    moduleCount: 3,
    configuredBy: 1,
  });
  const initialModules = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  assert.equal(initialModules.length, 3);
  const mappedLocation = inventory.searchCells(db, "Z1-R1-C01")[0];
  inventory.updateCellMapping(db, {
    cellId: initialModules[0].id,
    hardwareChannel: 1,
    targetCellId: mappedLocation.id,
    mappedBy: 1,
  });

  const shrunk = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-SAME-SHRINK",
    deviceIdentity: "usb-same-controller",
    moduleCount: 2,
    configuredBy: 1,
  });
  const shrunkModules = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const preservedLocation = inventory.listCells(db).find((cell) => cell.id === mappedLocation.id);

  assert.equal(shrunk.id, initial.id);
  assert.equal(shrunk.address, "CTRL-SAME-SHRINK");
  assert.equal(shrunk.mappingSummary.detached, 0);
  assert.equal(shrunk.mappingSummary.removed, 1);
  assert.deepEqual(
    shrunkModules.map((cell) => Number(cell.hardware_channel)),
    [1, 2],
  );
  assert.equal(preservedLocation.controller_id, initial.id);
  assert.equal(preservedLocation.hardware_channel, 1);
  assert.equal(preservedLocation.mapping_status, "mapped");

  const expanded = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-SAME-EXPAND",
    deviceIdentity: "usb-same-controller",
    moduleCount: 4,
    configuredBy: 1,
  });
  const expandedModules = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.equal(expanded.id, initial.id);
  assert.equal(expanded.address, "CTRL-SAME-EXPAND");
  assert.equal(expandedModules.length, 4);
  assert.deepEqual(
    expandedModules.map((cell) => Number(cell.hardware_channel)),
    [1, 2, 3, 4],
  );
  assert.equal(expandedModules.filter((cell) => Number(cell.active) === 1).length, 1);
});

test("controllers with the same USB adapter identity stay separate unless the same controller name is selected", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-shared-usb-identity-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const sharedIdentity = "by-id:usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0";
  const controllerA = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-A",
    controllerAddress: "CTRL-A-OLD",
    deviceIdentity: sharedIdentity,
    moduleCount: 2,
    configuredBy: 1,
  });
  const controllerB = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-B",
    controllerAddress: "CTRL-B-KEEP",
    deviceIdentity: sharedIdentity,
    moduleCount: 2,
    configuredBy: 1,
  });

  assert.notEqual(controllerA.id, controllerB.id);

  const aBefore = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === controllerA.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const bBefore = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === controllerB.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  assert.equal(aBefore.length, 2);
  assert.equal(bBefore.length, 2);

  const reflashedA = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-A",
    controllerAddress: "CTRL-A-NEW",
    deviceIdentity: sharedIdentity,
    moduleCount: 1,
    configuredBy: 1,
  });
  const controllers = inventory.listControllers(db);
  const bAfter = controllers.find((controller) => controller.id === controllerB.id);
  const aAfterCells = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === controllerA.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const bAfterCells = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === controllerB.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.equal(reflashedA.id, controllerA.id);
  assert.equal(reflashedA.address, "CTRL-A-NEW");
  assert.equal(reflashedA.mappingSummary.detached, 0);
  assert.equal(reflashedA.mappingSummary.removed, 1);
  assert.equal(bAfter.address, "CTRL-B-KEEP");
  assert.equal(Number(bAfter.module_count), 2);
  assert.deepEqual(
    aAfterCells.map((cell) => cell.id),
    [aBefore[0].id],
  );
  assert.deepEqual(
    bAfterCells.map((cell) => cell.id),
    bBefore.map((cell) => cell.id),
  );
});

test("controllers can be health-checked and deleted by an admin", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-controller-delete-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const controller = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-STALE",
    controllerAddress: "CTRL-STALE-0001",
    moduleCount: 2,
    configuredBy: 1,
  });

  inventory.updateControllerHealth(db, {
    controllerId: controller.id,
    status: "offline",
  });
  assert.equal(
    inventory.listControllers(db).find((entry) => entry.id === controller.id).heartbeat_status,
    "offline",
  );

  const controllerModules = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === controller.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const stockedLocation = inventory.searchCells(db, "Z1-R1-C01")[0];
  inventory.updateCellMapping(db, {
    cellId: controllerModules[0].id,
    hardwareChannel: 1,
    targetCellId: stockedLocation.id,
    mappedBy: 1,
  });
  const stockedCell = inventory.listCells(db).find((cell) => cell.id === stockedLocation.id);
  assert.ok(stockedCell);
  const placeholderModuleId = controllerModules[1].id;

  const deleted = inventory.deleteController(db, {
    controllerId: controller.id,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.detachedCellCount, 1);
  assert.equal(deleted.removedModuleCount, 1);
  assert.ok(!inventory.listControllers(db).some((entry) => entry.id === controller.id));
  assert.ok(!inventory.listCells(db).some((cell) => cell.controller_id === controller.id));
  assert.ok(!inventory.listCellCatalog(db).some((cell) => cell.controller_id === controller.id));

  const manualCell = inventory.listCells(db).find((cell) => cell.id === stockedCell.id);
  assert.equal(manualCell.controller_id, null);
  assert.equal(manualCell.hardware_channel, null);
  assert.equal(manualCell.mapping_status, "unmapped");
  assert.equal(Number(manualCell.active), 1);
  assert.equal(Number(manualCell.occupied_quantity), Number(stockedCell.occupied_quantity));

  const storedController = db.prepare("SELECT * FROM controllers WHERE id = ?").get(controller.id);
  const storedPlaceholder = db.prepare("SELECT * FROM cells WHERE id = ?").get(placeholderModuleId);
  assert.equal(storedController, undefined);
  assert.equal(storedPlaceholder, undefined);

  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  const manualPickTask = inventory.allocatePick(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
    preferredCellId: stockedCell.id,
  });
  assert.equal(manualPickTask.lines[0].cell_id, stockedCell.id);
  assert.equal(manualPickTask.lines[0].controller_id, null);
});

test("mapping a new module to an existing cell preserves inventory and unassigns displaced LED", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-cell-remap-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const existingController = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-OLD",
    controllerAddress: "CTRL-OLD-REMAP",
    moduleCount: 1,
    configuredBy: 1,
  });
  const existingModule = inventory
    .listCellCatalog(db)
    .find((cell) => cell.controller_id === existingController.id && Number(cell.hardware_channel) === 1);
  const existingLocation = inventory.searchCells(db, "Z1-R1-C01")[0];
  inventory.updateCellMapping(db, {
    cellId: existingModule.id,
    targetCellId: existingLocation.id,
    hardwareChannel: 1,
    mappedBy: 1,
  });
  const existingCell = inventory.listCells(db).find((cell) => cell.id === existingLocation.id);
  assert.ok(existingCell);
  assert.ok(Number(existingCell.occupied_quantity) > 0);

  const replacementController = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-NEW",
    controllerAddress: "CTRL-NEW-REMAP",
    moduleCount: 1,
    configuredBy: 1,
  });
  const placeholderCell = inventory
    .listCellCatalog(db)
    .find((cell) => cell.controller_id === replacementController.id && Number(cell.active) === 0);
  assert.ok(placeholderCell);

  const remapped = inventory.updateCellMapping(db, {
    cellId: placeholderCell.id,
    targetCellId: existingCell.id,
    hardwareChannel: 1,
    mappedBy: 1,
  });
  assert.equal(remapped.id, existingCell.id);

  const afterRemap = inventory
    .listCells(db)
    .find((cell) => cell.id === existingCell.id);
  assert.equal(afterRemap.logical_code, "Z1-R1-C01");
  assert.equal(afterRemap.controller_id, replacementController.id);
  assert.equal(afterRemap.controller_address, "CTRL-NEW-REMAP");
  assert.equal(Number(afterRemap.occupied_quantity), Number(existingCell.occupied_quantity));
  assert.ok(!inventory.listCells(db).some((cell) => cell.id === placeholderCell.id));
  const displacedModule = inventory
    .listCellCatalog(db)
    .find(
      (cell) =>
        cell.controller_id === existingController.id &&
        Number(cell.hardware_channel) === 1 &&
        Number(cell.active) === 0,
    );
  assert.ok(displacedModule);

  const added = inventory.createCell(db, {
    logicalCode: "Z1-R1-C99",
    capacity: 8,
    createdBy: 1,
  });
  assert.equal(added.logical_code, "Z1-R1-C99");
  assert.equal(Number(added.capacity), 8);
  assert.ok(inventory.listCellCatalog(db).some((cell) => cell.id === added.id));
});

test("mapping form errors return to the mapping workflow", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-mapping-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const response = new MockResponse();
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const body = new URLSearchParams({
    return_to: "/devices#cell-mapping",
    hardware_channel_1: "1",
    original_target_cell_id_1: "1",
    target_cell_id_1: "999999",
  }).toString();

  await requestHandler(
    formRequest({
      url: "/mapping/bulk",
      body,
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /^\/devices\?/);
  assert.match(response.headers.Location, /tone=error/);
  assert.match(response.headers.Location, /#cell-mapping$/);
  const redirectUrl = new URL(response.headers.Location, "http://localhost");
  assert.equal(
    redirectUrl.searchParams.get("flash"),
    "Selected cell was not found.",
  );
});

test("cell mapping ping supports async JSON without redirecting", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-cell-test-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const response = new MockResponse();
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const body = new URLSearchParams({
    cell_id: "1",
    color: "green",
    return_to: "/devices#cell-mapping",
  }).toString();

  await requestHandler(
    formRequest({
      url: "/devices/cell-test",
      body,
      cookie,
      headers: {
        accept: "application/json",
        "x-requested-with": "fetch",
      },
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /application\/json/);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.degraded, false);
  assert.equal(payload.cell.id, 1);
  assert.match(payload.message, /Light test sent/);
});

test("location ping is available to authenticated operators", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-location-ping-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const response = new MockResponse();
  const cookie = auth
    .createSessionCookie({ id: 2, role: "operator" })
    .split(";")[0];

  await requestHandler(
    formRequest({
      url: "/api/cells/1/ping",
      body: "",
      cookie,
      headers: {
        accept: "application/json",
        "x-requested-with": "fetch",
      },
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /application\/json/);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.degraded, false);
  assert.equal(payload.cell.id, 1);
  assert.match(payload.message, /Ping sent/);
});

test("show count sends the current server-side quantity to the LED in yellow", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-location-count-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const { reloadAppState, getAppState } = await import("../src/server/app-state.js");
  reloadAppState();
  const auth = await freshImport("../src/services/auth.js");
  const expectedQuantity = Number(
    getAppState().db
      .prepare("SELECT available_quantity FROM inventory_balances WHERE cell_id = 1 AND product_id = 1")
      .get()?.available_quantity || 0,
  );
  const { requestHandler } = await freshImport("../src/server.js");
  const response = new MockResponse();
  const cookie = auth
    .createSessionCookie({ id: 2, role: "operator" })
    .split(";")[0];

  await requestHandler(
    formRequest({
      url: "/api/cells/1/count",
      body: new URLSearchParams({ product_id: "1" }).toString(),
      cookie,
      headers: {
        accept: "application/json",
        "x-requested-with": "fetch",
      },
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.degraded, false);
  assert.equal(payload.color, "yellow");
  assert.equal(payload.displayQuantity, expectedQuantity);
  assert.deepEqual(payload.product, { id: 1, sku: "SKU-SHOE-001" });

  const storedEvent = getAppState().db
    .prepare(
      `
        SELECT payload
        FROM device_events
        WHERE event_type = 'cell_quantity_displayed' AND cell_id = 1
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .get();
  assert.ok(storedEvent);
  const ledPayload = JSON.parse(storedEvent.payload);
  assert.equal(ledPayload.type, "cell-quantity-display");
  assert.equal(ledPayload.color, "yellow");
  assert.equal(Number(ledPayload.quantity), expectedQuantity);

  const clearResponse = new MockResponse();
  await requestHandler(
    formRequest({
      url: "/api/cells/1/count/clear",
      body: "active=0",
      cookie,
      headers: {
        accept: "application/json",
        "x-requested-with": "fetch",
      },
    }),
    clearResponse,
  );

  assert.equal(clearResponse.statusCode, 200);
  const clearPayload = JSON.parse(clearResponse.body);
  assert.equal(clearPayload.ok, true);
  assert.equal(clearPayload.degraded, false);
  assert.equal(clearPayload.cell.id, 1);
  const clearedEvent = getAppState().db
    .prepare(
      `
        SELECT payload
        FROM device_events
        WHERE event_type = 'cell_quantity_cleared' AND cell_id = 1
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .get();
  assert.ok(clearedEvent);
  assert.equal(JSON.parse(clearedEvent.payload).type, "cell-quantity-clear");
});

test("cell mapping shows every online controller module and hides offline modules", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-module-backfill-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createLocationPages } = await freshImport("../src/server/pages/locations.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const controller = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-VISIBLE",
    controllerAddress: "CTRL-VISIBLE",
    moduleCount: 3,
    configuredBy: 1,
  });

  db.prepare("DELETE FROM cells WHERE controller_id = ?").run(controller.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM cells WHERE controller_id = ?").get(controller.id).count,
    0,
  );

  const onlineHtml = createLocationPages({ db }).renderDeviceConfigSection("cell-mapping");
  const restoredModules = inventory
    .listCellCatalog(db)
    .filter((cell) => cell.controller_id === controller.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.deepEqual(
    restoredModules.map((cell) => Number(cell.hardware_channel)),
    [1, 2, 3],
  );
  assert.ok(restoredModules.every((cell) => Number(cell.active) === 0));
  assert.match(onlineHtml, /ESP32-VISIBLE/);
  assert.match(onlineHtml, /data-module-name="1"/);
  assert.match(onlineHtml, /data-module-name="2"/);
  assert.match(onlineHtml, /data-module-name="3"/);
  assert.match(onlineHtml, /data-led-command-async/);
  assert.match(onlineHtml, /data-show-location-count/);
  assert.match(onlineHtml, />Show Count<\/button>/);

  inventory.updateControllerHealth(db, {
    controllerId: controller.id,
    status: "offline",
  });
  const offlineHtml = createLocationPages({ db }).renderDeviceConfigSection("cell-mapping");
  assert.doesNotMatch(offlineHtml, /ESP32-VISIBLE/);
});

test("no-op adjustments return to admin with informational feedback", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-adjustment-http-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";

  const auth = await freshImport("../src/services/auth.js");
  const { requestHandler } = await freshImport("../src/server.js");
  const response = new MockResponse();
  const cookie = auth.createSessionCookie({ id: 1, role: "admin" }).split(";")[0];
  const body = new URLSearchParams({
    cell_id: "1",
    product_id_0: "1",
    absolute_quantity_0: "3",
    reason: "No-op count check",
  }).toString();

  await requestHandler(
    formRequest({
      url: "/admin/adjustments",
      body,
      cookie,
    }),
    response,
  );

  assert.equal(response.statusCode, 302);
  assert.match(response.headers.Location, /^\/admin\?/);
  assert.match(response.headers.Location, /tone=info/);
  const redirectUrl = new URL(response.headers.Location, "http://localhost");
  assert.equal(
    redirectUrl.searchParams.get("flash"),
    "No adjustment was needed because the entered quantities already match the current values.",
  );
});

test("deleting a cell requires it to be empty and preserves mapped LED modules", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-cell-delete-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createLocationPages } = await freshImport("../src/server/pages/locations.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const emptyCell = inventory.createCell(db, {
    logicalCode: "Z9-R9-C01",
    capacity: 5,
    createdBy: 1,
  });
  const deletedEmpty = inventory.deleteCell(db, {
    cellId: emptyCell.id,
  });
  assert.equal(deletedEmpty.deleted, true);
  assert.equal(db.prepare("SELECT * FROM cells WHERE id = ?").get(emptyCell.id), undefined);

  const controller = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-DELETE",
    controllerAddress: "CTRL-DELETE-0001",
    moduleCount: 1,
    configuredBy: 1,
  });
  const moduleToMap = inventory
    .listCellCatalog(db)
    .find((cell) => cell.controller_id === controller.id && Number(cell.hardware_channel) === 1);
  const mappedEmptyLocation = inventory.createCell(db, {
    logicalCode: "Z9-R9-MAPPED",
    capacity: 5,
    createdBy: 1,
  });
  inventory.updateCellMapping(db, {
    cellId: moduleToMap.id,
    hardwareChannel: 1,
    targetCellId: mappedEmptyLocation.id,
    mappedBy: 1,
  });
  const mappedEmptyCell = inventory.listCells(db).find((cell) => cell.id === mappedEmptyLocation.id);
  assert.ok(mappedEmptyCell);

  const deletedMapped = inventory.deleteCell(db, {
    cellId: mappedEmptyCell.id,
    deletedBy: 1,
  });
  assert.equal(deletedMapped.deleted, true);
  assert.equal(deletedMapped.modulePlaceholder.controller_id, mappedEmptyCell.controller_id);
  assert.equal(deletedMapped.modulePlaceholder.hardware_channel, mappedEmptyCell.hardware_channel);
  assert.equal(Number(deletedMapped.modulePlaceholder.active), 0);
  const storedDeletedCell = db.prepare("SELECT * FROM cells WHERE id = ?").get(mappedEmptyCell.id);
  if (deletedMapped.preservedHistory) {
    assert.equal(Number(storedDeletedCell.active), 0);
    assert.equal(storedDeletedCell.controller_id, null);
    assert.equal(storedDeletedCell.hardware_channel, null);
  } else {
    assert.equal(storedDeletedCell, undefined);
  }
  assert.ok(!inventory.listCells(db).some((cell) => cell.id === deletedMapped.modulePlaceholder.id));

  const mappingHtml = createLocationPages({ db }).renderDeviceConfigSection("cell-mapping");
  assert.match(mappingHtml, />Empty</);
  assert.match(mappingHtml, /label="Z1-R1-C01 · stock 3 · recommended · unmapped"/);
  assert.match(mappingHtml, /placeholder="Suggested: Z1-R1-C01"/);
  assert.match(
    mappingHtml,
    new RegExp(`name="target_cell_id_${deletedMapped.modulePlaceholder.id}"\\s+value=""`),
  );
  assert.match(
    mappingHtml,
    new RegExp(`data-locate-cell[\\s\\S]*data-cell-id="${deletedMapped.modulePlaceholder.id}"`),
  );
  assert.doesNotMatch(
    mappingHtml,
    new RegExp(`<option[\\s\\S]*value="${mappedEmptyCell.logical_code}"`),
  );
  assert.throws(
    () =>
      inventory.updateCellMapping(db, {
        cellId: deletedMapped.modulePlaceholder.id,
        hardwareChannel: deletedMapped.modulePlaceholder.hardware_channel,
        logicalCode: mappedEmptyCell.logical_code,
        mappedBy: 1,
      }),
    /Add this location before assigning/,
  );

  const remapTarget = inventory.createCell(db, {
    logicalCode: "Z9-R9-REMAP",
    capacity: 4,
    createdBy: 1,
  });
  const managementHtml = createLocationPages({ db }).renderDeviceConfigSection("cell-management");
  assert.match(managementHtml, /Add Location/);
  assert.match(managementHtml, /action="\/devices\/cells"/);
  assert.match(managementHtml, /action="\/devices\/cells\/rename"/);
  assert.match(managementHtml, /Z9-R9-REMAP/);
  assert.match(managementHtml, /<span class="muted">Unmapped<\/span>/);
  assert.match(managementHtml, /data-ping-cell/);
  assert.match(managementHtml, /data-show-location-count/);
  assert.match(managementHtml, />Show Count<\/button>/);
  assert.match(
    managementHtml,
    new RegExp(`data-cell-id="${remapTarget.id}"[\\s\\S]*disabled[\\s\\S]*>Ping<\\/button>`),
  );
  const renamedCell = inventory.renameCell(db, {
    cellId: remapTarget.id,
    logicalCode: "Z9-R9-RENAMED",
    renamedBy: 1,
  });
  assert.equal(renamedCell.logical_code, "Z9-R9-RENAMED");
  assert.throws(
    () =>
      inventory.renameCell(db, {
        cellId: remapTarget.id,
        logicalCode: "Z1-R1-C01",
        renamedBy: 1,
      }),
    /already exists/,
  );
  const statusHtml = createLocationPages({ db }).renderDevices(
    { id: 1, name: "Admin", username: "admin", role: "admin" },
    null,
  );
  assert.match(
    statusHtml,
    /<span class="muted">Mapped Cells<\/span>\s*<strong>0<\/strong>/,
  );
  assert.match(
    statusHtml,
    /<span class="muted">Manual Cells<\/span>\s*<strong>82<\/strong>/,
  );
  const remapped = inventory.updateCellMapping(db, {
    cellId: deletedMapped.modulePlaceholder.id,
    hardwareChannel: deletedMapped.modulePlaceholder.hardware_channel,
    targetCellId: remapTarget.id,
    mappedBy: 1,
  });
  assert.equal(remapped.id, remapTarget.id);
  assert.equal(remapped.controller_id, deletedMapped.modulePlaceholder.controller_id);
  assert.equal(remapped.hardware_channel, deletedMapped.modulePlaceholder.hardware_channel);
  assert.equal(db.prepare("SELECT * FROM cells WHERE id = ?").get(deletedMapped.modulePlaceholder.id), undefined);

  const product = inventory.listProducts(db).find((entry) => entry.sku === "SKU-SHOE-001");
  const stockedCell = inventory
    .listCells(db)
    .find((cell) => String(cell.inventory_summary || "").includes(product.sku));
  assert.ok(stockedCell);
  const task = inventory.allocatePick(db, {
    userId: 1,
    productId: product.id,
    quantity: 1,
    preferredCellId: stockedCell.id,
  });
  db.prepare(
    `
      INSERT INTO device_events (controller_id, cell_id, task_id, event_type, payload, created_at)
      VALUES (NULL, ?, ?, 'cell_delete_test', '{}', ?)
    `,
  ).run(stockedCell.id, task.id, new Date().toISOString());

  assert.throws(
    () =>
      inventory.deleteCell(db, {
        cellId: stockedCell.id,
      }),
    /Move all stock out/,
  );
  assert.ok(db.prepare("SELECT * FROM cells WHERE id = ?").get(stockedCell.id));
});

test("submission tokens are one-time use and production config requires a session secret", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-token-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const { createLogger } = await freshImport("../src/logger.js");
  const { createHardwareService } = await freshImport("../src/services/hardware.js");
  const { createSystemService } = await freshImport("../src/services/system.js");
  const { resolveConfig } = await freshImport("../src/config.js");
  const inventory = await freshImport("../src/services/inventory.js");

  assert.throws(() => resolveConfig({ NODE_ENV: "production" }), /SESSION_SECRET must be set/);
  assert.equal(resolveConfig({}).allowDemoInventorySeed, false);
  assert.equal(resolveConfig({ DEMO_INVENTORY_SEED: "1" }).allowDemoInventorySeed, true);

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const logger = createLogger({ level: "error", siteId: "test-site" });
  const hardwareService = createHardwareService({
    db,
    config: {
      hardwareAdapter: "simulator",
    },
    logger,
  });
  const systemService = createSystemService({
    db,
    config: {
      siteId: "test-site",
    },
    logger,
    hardwareService,
    getTask: inventory.getTask,
  });

  const task = inventory.allocatePick(db, {
    userId: 1,
    productId: 1,
    quantity: 1,
  });
  const token = systemService.issueSubmissionToken({
    scope: "task-confirm",
    taskId: task.id,
    userId: 1,
  });

  systemService.consumeSubmissionToken({
    token,
    scope: "task-confirm",
    taskId: task.id,
    userId: 1,
  });

  assert.throws(
    () =>
      systemService.consumeSubmissionToken({
        token,
        scope: "task-confirm",
        taskId: task.id,
        userId: 1,
      }),
    /already been submitted/,
  );
});
