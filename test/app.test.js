import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

test("core inventory flows work against a fresh seeded database", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const reports = await freshImport("../src/services/reports.js");

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

  const mixedCell = inventory.searchCells(db, "Z1-R1-C04")[0];

  const mixedPutTask = inventory.planPut(db, {
    userId: 1,
    productId: shoe.id,
    quantity: 1,
  });
  const mixedPutCompletion = inventory.completeTask(db, {
    taskId: mixedPutTask.id,
    actualQuantities: { [mixedPutTask.lines[0].id]: 1 },
    actualCellIds: { [mixedPutTask.lines[0].id]: mixedCell.id },
    userId: 1,
    note: "Intentional mixed cell",
  });
  assert.ok(mixedPutCompletion.anomalies.length > 0);

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
