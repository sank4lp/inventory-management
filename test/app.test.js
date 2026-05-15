import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

function formRequest({ method = "POST", url, body, cookie }) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = method;
  request.url = url;
  request.headers = {
    host: "localhost",
    cookie,
    "content-type": "application/x-www-form-urlencoded",
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
  assert.match(reportHtml, /data-report-print-open/);
  assert.match(reportHtml, /data-report-print-option="stock-snapshot"/);
  assert.match(reportHtml, /data-report-template="movement"/);

  const actions = inventory.getRecommendedActions(db);
  assert.ok(actions.length > 0);
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
      message: "Not enough free cells are available for this product capacity.",
      tone: "error",
    },
    new URL(`http://localhost/put?product_id=${shoe.id}&quantity=99&capacity_help=1`),
  );

  assert.match(html, /Can adjust more in the cell\?/);
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
    "Capacity updated. A recommended inventory action was created; review it now or skip for later.",
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
  assert.match(detailResponse.body, /Recommended action created/);
  assert.match(detailResponse.body, /Review recommendation/);
  assert.match(detailResponse.body, /Skip for now/);
  assert.match(detailResponse.body, /href="\/recommended-actions\?key=overflow-\d+-1&amp;source=capacity&amp;return_to=%2Fproducts%2F1"/);
  assert.match(detailResponse.body, /href="\/products\/1">Skip for now/);
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

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const stockedCell = inventory
    .listCells(db)
    .find((cell) => Number(cell.occupied_quantity || 0) > 0);
  assert.ok(stockedCell);

  const cellDetail = inventory.getCellDetail(db, stockedCell.id);
  assert.ok(cellDetail.products.length > 0);

  const locationPages = createLocationPages({ db });
  const locationsHtml = locationPages.renderCells(user, null, "");
  assert.match(locationsHtml, new RegExp(`href="/pick\\?cell_id=${stockedCell.id}"`));
  assert.match(locationsHtml, new RegExp(`href="/put\\?cell_id=${stockedCell.id}"`));
  assert.doesNotMatch(locationsHtml, /Put item here|Put any item here/);

  const searchHtml = locationPages.renderCells(user, null, stockedCell.logical_code);
  assert.match(searchHtml, /Search locations/);
  assert.match(searchHtml, /location\(s\) match/);
  assert.match(searchHtml, new RegExp(`href="/pick\\?cell_id=${stockedCell.id}"`));
  assert.match(searchHtml, new RegExp(`href="/put\\?cell_id=${stockedCell.id}"`));

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

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createProductPages } = await freshImport("../src/server/pages/products.js");
  const { createTaskPages } = await freshImport("../src/server/pages/tasks.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const user = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const shoe = inventory.listProducts(db).find((product) => product.sku === "SKU-SHOE-001");
  assert.ok(shoe);

  const productDetail = inventory.getProductDetail(db, shoe.id);
  assert.ok(productDetail.locations.length > 0);
  const preferredCellId = productDetail.locations[0].cell_id;

  const productPages = createProductPages({ db });
  const addProductHtml = productPages.renderProducts(user, null, "", true);
  assert.match(addProductHtml, /Save and put stock/);
  assert.match(addProductHtml, /Optional catalog details/);
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
  assert.match(pickHtml, /Quick quantity picker/);
  assert.match(pickHtml, /Pick all in this location/);
  assert.match(pickHtml, /Available to pick/);

  const putHtml = productPages.renderPut(
    user,
    null,
    new URL(`http://localhost/put?product_id=${shoe.id}&quantity=2`),
  );
  assert.match(putHtml, /Quick quantity picker/);
  assert.match(putHtml, /Full location capacity/);
  assert.match(putHtml, /Current stock/);
  assert.match(putHtml, new RegExp(`${productDetail.sku}[\\s\\S]*${productDetail.name}`));
  assert.match(putHtml, new RegExp(`${productDetail.locations[0].logical_code}[\\s\\S]*${productDetail.locations[0].available_quantity}`));
  assert.match(putHtml, /data-put-product-summary-form/);

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
  assert.match(taskHtml, /Mark reached/);
  assert.match(taskHtml, /Complete pick/);
  assert.match(taskHtml, /Cancel task/);
  assert.match(taskHtml, /Cancel this task\?/);
  assert.doesNotMatch(taskHtml, /Simulate button|Finish task|Cancel Task|Pick Action Initiated/);

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
  assert.match(completionHtml, /Go to Overview/);
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
  assert.match(listHtml, /Recommended cleanup/);
  assert.match(listHtml, /Review/);
  assert.doesNotMatch(listHtml, /Apply recommendation/);

  const detailHtml = taskPages.renderRecommendedActions(user, null, actions[0].key, {
    source: "capacity",
    returnTo: "/products/1",
  });
  assert.match(detailHtml, /Apply recommendation/);
  assert.match(detailHtml, /Show PICK\/PUT LEDs/);
  assert.match(detailHtml, /Skip for now/);
  assert.match(detailHtml, /The capacity update created this recommended action/);
  assert.match(detailHtml, /name="return_to" value="\/products\/1"/);

  const homePages = createHomePages({ db });
  const overviewHtml = homePages.renderHome(user, null, new URL("http://localhost/"));
  assert.match(overviewHtml, /Recommended Actions/);
  assert.match(overviewHtml, new RegExp(`/recommended-actions\\?key=${actions[0].key}`));
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

  const { createAdminPages } = await freshImport("../src/server/pages/admin.js");
  const adminHtml = createAdminPages({ db }).renderAdmin(
    { id: 1, name: "Admin", username: "admin", role: "admin" },
    null,
  );
  assert.match(adminHtml, /Generate operator key/);
  assert.match(adminHtml, /Generate admin key/);
  assert.match(adminHtml, /one-time key per person/);
  assert.match(adminHtml, /data-copy-value=/);
  assert.match(adminHtml, /Preview quantity LED/);
  assert.match(adminHtml, /1\. Choose location/);
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

  backupService.createBackup({ kind: "auto", source: "first-auto" });
  backupService.createBackup({ kind: "auto", source: "second-auto" });
  backupService.createBackup({ kind: "auto", source: "third-auto" });

  const automaticBackups = backupService
    .listBackups()
    .filter((backup) => backup.kind === "auto");
  assert.equal(automaticBackups.length, 2);
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
  const [sourceCell, targetCell] = inventory
    .listCells(db)
    .filter((cell) => cell.controller_id === controller.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
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
    moduleCount: 2,
    configuredBy: 1,
  });
  const initialCells = inventory
    .listCells(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.equal(initialCells.length, 2);
  inventory.updateCellMapping(db, {
    cellId: initialCells[0].id,
    hardwareChannel: 1,
    logicalCode: "Z9-R9-C99",
    mappedBy: 1,
  });

  const replacement = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-NEW-000001",
    moduleCount: 2,
    configuredBy: 1,
  });
  const migratedCells = inventory
    .listCells(db)
    .filter((cell) => cell.controller_id === replacement.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.equal(replacement.id, initial.id);
  assert.equal(replacement.address, "CTRL-NEW-000001");
  assert.deepEqual(
    migratedCells.map((cell) => cell.id),
    initialCells.map((cell) => cell.id),
  );
  assert.equal(migratedCells[0].logical_code, "Z9-R9-C99");
  assert.equal(migratedCells[0].controller_address, "CTRL-NEW-000001");
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
  const initialCells = inventory
    .listCells(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  assert.equal(initialCells.length, 3);

  const shrunk = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-SAME-SHRINK",
    deviceIdentity: "usb-same-controller",
    moduleCount: 2,
    configuredBy: 1,
  });
  const shrunkCells = inventory
    .listCells(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const manualCell = inventory.listCells(db).find((cell) => cell.id === initialCells[2].id);

  assert.equal(shrunk.id, initial.id);
  assert.equal(shrunk.address, "CTRL-SAME-SHRINK");
  assert.equal(shrunk.mappingSummary.detached, 1);
  assert.deepEqual(
    shrunkCells.map((cell) => cell.id),
    initialCells.slice(0, 2).map((cell) => cell.id),
  );
  assert.equal(manualCell.controller_id, null);
  assert.equal(manualCell.hardware_channel, null);
  assert.equal(manualCell.mapping_status, "unmapped");
  assert.equal(Number(manualCell.active), 1);

  const expanded = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-01",
    controllerAddress: "CTRL-SAME-EXPAND",
    deviceIdentity: "usb-same-controller",
    moduleCount: 4,
    configuredBy: 1,
  });
  const expandedCells = inventory
    .listCells(db)
    .filter((cell) => cell.controller_id === initial.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.equal(expanded.id, initial.id);
  assert.equal(expanded.address, "CTRL-SAME-EXPAND");
  assert.equal(expandedCells.length, 4);
  assert.deepEqual(
    expandedCells.slice(0, 3).map((cell) => cell.id),
    initialCells.map((cell) => cell.id),
  );
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
    .listCells(db)
    .filter((cell) => cell.controller_id === controllerA.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const bBefore = inventory
    .listCells(db)
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
    .listCells(db)
    .filter((cell) => cell.controller_id === controllerA.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);
  const bAfterCells = inventory
    .listCells(db)
    .filter((cell) => cell.controller_id === controllerB.id)
    .sort((left, right) => left.hardware_channel - right.hardware_channel);

  assert.equal(reflashedA.id, controllerA.id);
  assert.equal(reflashedA.address, "CTRL-A-NEW");
  assert.equal(reflashedA.mappingSummary.detached, 1);
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

  const controllerCells = inventory.listCells(db).filter((cell) => cell.controller_id === controller.id);
  const stockedCell = controllerCells.find((cell) => Number(cell.occupied_quantity) > 0);
  assert.ok(stockedCell);
  const controllerCellIds = controllerCells.map((cell) => cell.id);

  const deleted = inventory.deleteController(db, {
    controllerId: controller.id,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.detachedCellCount, 2);
  assert.ok(!inventory.listControllers(db).some((entry) => entry.id === controller.id));
  assert.ok(!inventory.listCells(db).some((cell) => cell.controller_id === controller.id));

  const manualCells = inventory.listCells(db).filter((cell) => controllerCellIds.includes(cell.id));
  assert.equal(manualCells.length, 2);
  assert.ok(manualCells.every((cell) => cell.controller_id == null));
  assert.ok(manualCells.every((cell) => cell.hardware_channel == null));
  assert.ok(manualCells.every((cell) => cell.mapping_status === "unmapped"));
  assert.ok(manualCells.every((cell) => Number(cell.active) === 1));
  assert.equal(
    Number(manualCells.find((cell) => cell.id === stockedCell.id).occupied_quantity),
    Number(stockedCell.occupied_quantity),
  );

  const storedController = db.prepare("SELECT * FROM controllers WHERE id = ?").get(controller.id);
  const storedCells = db
    .prepare(`SELECT * FROM cells WHERE id IN (${controllerCellIds.map(() => "?").join(", ")})`)
    .all(...controllerCellIds);
  assert.equal(storedController, undefined);
  assert.equal(storedCells.length, 2);

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

test("mapping a new module to an existing cell preserves that cell inventory", async () => {
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
  const existingCell = inventory
    .listCells(db)
    .find((cell) => cell.controller_id === existingController.id && cell.logical_code === "Z1-R1-C01");
  assert.ok(existingCell);
  assert.ok(Number(existingCell.occupied_quantity) > 0);

  const replacementController = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-NEW",
    controllerAddress: "CTRL-NEW-REMAP",
    moduleCount: 1,
    configuredBy: 1,
  });
  const placeholderCell = inventory
    .listCells(db)
    .find((cell) => cell.controller_id === replacementController.id && cell.logical_code !== "Z1-R1-C01");
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
    target_cell_id_1: "2",
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
    "Move stock out of the current mapped cell before replacing it.",
  );
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

test("deleting a cell requires explicit data confirmation when stock or history exists", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-cell-delete-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");

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
    /Confirm deleting associated data/,
  );
  assert.ok(db.prepare("SELECT * FROM cells WHERE id = ?").get(stockedCell.id));

  const deletedWithData = inventory.deleteCell(db, {
    cellId: stockedCell.id,
    deleteDataConfirmed: true,
  });
  assert.equal(deletedWithData.deleted, true);
  assert.equal(deletedWithData.hasData, true);
  assert.ok(deletedWithData.balanceRows > 0);
  assert.ok(deletedWithData.taskLines > 0);
  assert.ok(deletedWithData.deviceEvents > 0);
  assert.equal(db.prepare("SELECT * FROM cells WHERE id = ?").get(stockedCell.id), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inventory_balances WHERE cell_id = ?").get(stockedCell.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_lines WHERE cell_id = ?").get(stockedCell.id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM device_events WHERE cell_id = ?").get(stockedCell.id).count, 0);
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
