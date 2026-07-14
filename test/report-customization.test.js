import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

async function createTestDatabase(prefix) {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(sandbox);
  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const db = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: true,
  });
  const admin = db
    .prepare("SELECT id, name, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    .get();
  const operator = db
    .prepare("SELECT id, name, username, role FROM users WHERE role = 'operator' ORDER BY id LIMIT 1")
    .get();
  return { admin, auth, createDatabase, db, operator };
}

function movementRecipe(overrides = {}) {
  return {
    type: "product_movement",
    metric: "picked_quantity",
    groupBy: "product",
    filters: {
      category: null,
      unitOfMeasure: null,
    },
    dateRange: "last_30_days",
    topN: 10,
    visualization: "bar",
    columns: [
      "product.sku",
      "product.name",
      "picked_quantity",
      "pick_frequency",
      "put_quantity",
    ],
    ...overrides,
  };
}

test("custom report definitions validate recipes, preserve ownership, and persist", async () => {
  const { admin, createDatabase, db, operator } = await createTestDatabase(
    "inventory-report-definitions-",
  );
  const reportDefinitions = await freshImport("../src/services/report-definitions.js");
  const service = reportDefinitions.createReportDefinitionService({ db });

  assert.throws(
    () => service.validate({ ...movementRecipe(), sql: "DROP TABLE products" }),
    /Custom SQL is not accepted/,
  );
  assert.throws(
    () => service.validate(movementRecipe({ metric: "invented_metric" })),
    /supported product movement metric/,
  );
  assert.throws(
    () => service.validate(movementRecipe({ columns: ["product.not_a_column"] })),
    /is not available/,
  );
  assert.throws(
    () => service.validate(movementRecipe({ topN: 51 })),
    /whole number from 1 to 50/,
  );

  const privateReport = service.create({
    actor: operator,
    name: "My movement report",
    description: "A private movement view",
    visibility: "private",
    recipe: movementRecipe(),
  });
  assert.equal(privateReport.owner_user_id, operator.id);
  assert.equal(privateReport.visibility, "private");
  assert.equal(privateReport.validation_status, "ready");
  assert.ok(service.list({ actor: operator }).some((report) => report.id === privateReport.id));
  assert.equal(service.get({ actor: admin, reportId: privateReport.id }), null);
  assert.ok(!service.list({ actor: admin }).some((report) => report.id === privateReport.id));

  assert.throws(
    () => service.update({ actor: admin, reportId: privateReport.id, name: "Admin takeover" }),
    /only reports that you own/,
  );
  assert.throws(
    () => service.delete({ actor: admin, reportId: privateReport.id }),
    /only reports that you own/,
  );
  assert.throws(
    () =>
      service.create({
        actor: operator,
        name: "Operator shared report",
        visibility: "shared",
        recipe: movementRecipe(),
      }),
    /Only an admin can publish/,
  );

  const sharedReport = service.create({
    actor: admin,
    name: "Published movement report",
    visibility: "shared",
    recipe: movementRecipe({ metric: "pick_frequency" }),
  });
  assert.ok(service.list({ actor: operator }).some((report) => report.id === sharedReport.id));

  const builtIn = service
    .list({ actor: operator })
    .find((report) => report.stable_key === "product-movement-demand");
  assert.ok(builtIn);
  assert.equal(builtIn.is_locked, 1);
  assert.throws(
    () => service.delete({ actor: admin, reportId: builtIn.id }),
    /Built-in reports are locked/,
  );
  const duplicate = service.duplicate({ actor: operator, reportId: builtIn.id });
  assert.equal(duplicate.owner_user_id, operator.id);
  assert.equal(duplicate.visibility, "private");
  assert.equal(duplicate.definition_type, "custom");

  db.close();
  const reopenedDb = createDatabase({
    hashPassword: (await freshImport("../src/services/auth.js")).hashPassword,
    allowDemoInventorySeed: true,
  });
  const persisted = reportDefinitions.getReportDefinition(reopenedDb, {
    actor: operator,
    reportId: privateReport.id,
  });
  assert.equal(persisted.name, "My movement report");
  assert.equal(persisted.recipe.metric, "picked_quantity");
  reopenedDb.close();
});

test("custom product fields use stable keys and become report groupings and columns", async () => {
  const { admin, db, operator } = await createTestDatabase("inventory-product-fields-reporting-");
  const inventory = await freshImport("../src/services/inventory.js");
  const productFields = await freshImport("../src/services/product-fields.js");
  const reportDefinitions = await freshImport("../src/services/report-definitions.js");
  const reports = await freshImport("../src/services/reports.js");
  const fields = productFields.createProductFieldService({ db });
  const definitions = reportDefinitions.createReportDefinitionService({ db });

  assert.throws(
    () =>
      fields.create({
        actor: operator,
        label: "Operator-created field",
        dataType: "text",
      }),
    /Only an admin/,
  );

  const gradeField = fields.create({
    actor: admin,
    label: "Rice Grade",
    dataType: "select",
    options: ["Grade A", "Grade B"],
    reportable: 1,
    filterable: 1,
    visible: 1,
  });
  assert.match(gradeField.field_key, /^custom\./);
  assert.ok(
    fields.list({ reportableOnly: true }).some((field) => field.id === gradeField.id),
  );

  const product = inventory.listProducts(db).find((entry) => entry.sku === "SKU-SHOE-001");
  assert.ok(product);
  fields.setProductValue({
    actor: operator,
    productId: product.id,
    fieldId: gradeField.id,
    value: "Grade A",
  });
  assert.equal(
    fields.getProductValues(product.id).find((field) => field.id === gradeField.id).value,
    "Grade A",
  );
  assert.throws(
    () =>
      fields.setProductValue({
        actor: operator,
        productId: product.id,
        fieldId: gradeField.id,
        value: "Unconfigured grade",
      }),
    /configured options/,
  );

  const pick = inventory.allocatePick(db, {
    userId: operator.id,
    productId: product.id,
    quantity: 1,
  });
  inventory.completeTask(db, {
    taskId: pick.id,
    actualQuantities: Object.fromEntries(pick.lines.map((line) => [line.id, line.planned_quantity])),
    userId: operator.id,
    note: "Custom field report coverage",
  });

  const recipe = movementRecipe({
    groupBy: gradeField.field_key,
    columns: [
      "product.sku",
      "product.name",
      gradeField.field_key,
      "picked_quantity",
    ],
  });
  const definition = definitions.create({
    actor: operator,
    name: "Movement by rice grade",
    visibility: "private",
    recipe,
  });
  assert.equal(definition.validation_status, "ready");

  const grouped = reports.buildProductMovementReport(db, recipe);
  const gradeRow = grouped.rows.find((row) => row.custom_field_value === "Grade A");
  assert.ok(gradeRow);
  assert.equal(gradeRow.picked_quantity, 1);
  assert.equal(grouped.labels[gradeField.field_key], "Rice Grade");

  const renamed = fields.update({
    actor: admin,
    fieldId: gradeField.id,
    label: "Commodity Grade",
  });
  assert.equal(renamed.field_key, gradeField.field_key);
  assert.equal(
    definitions.get({ actor: operator, reportId: definition.id }).recipe.groupBy,
    gradeField.field_key,
  );
  assert.equal(
    reports.buildProductMovementReport(db, recipe).labels[gradeField.field_key],
    "Commodity Grade",
  );

  const skuField = fields.list().find((field) => field.field_key === "product.sku");
  fields.update({ actor: admin, fieldId: skuField.id, label: "NSN" });
  assert.equal(reports.buildProductMovementReport(db, recipe).labels["product.sku"], "NSN");

  assert.throws(
    () => fields.update({ actor: admin, fieldId: gradeField.id, dataType: "number" }),
    /separate previewed data migration/,
  );
  assert.throws(
    () => fields.update({ actor: admin, fieldId: gradeField.id, required: 1 }),
    /Populate this field for every active product/,
  );
  assert.throws(
    () => fields.update({ actor: operator, fieldId: gradeField.id, reportable: 0 }),
    /Only an admin/,
  );

  fields.update({ actor: admin, fieldId: gradeField.id, reportable: 0 });
  assert.ok(
    !fields.list({ reportableOnly: true }).some((field) => field.id === gradeField.id),
  );
  const needsAttention = definitions.get({ actor: operator, reportId: definition.id });
  assert.equal(needsAttention.validation_status, "needs_attention");
  assert.deepEqual(needsAttention.unavailable_fields, [gradeField.field_key]);
  assert.throws(
    () => reports.buildProductMovementReport(db, recipe),
    /supported product movement grouping/,
  );

  db.close();
});

test("unit conversion preview is guarded and apply normalizes current state while preserving history", async () => {
  const { admin, db, operator } = await createTestDatabase("inventory-unit-conversion-");
  const inventory = await freshImport("../src/services/inventory.js");
  const reports = await freshImport("../src/services/reports.js");
  const unitConversions = await freshImport("../src/services/unit-conversions.js");
  const service = unitConversions.createUnitConversionService({ db });

  const product = inventory.createProduct(db, {
    sku: "RICE-SACK-25",
    name: "Rice Sack",
    brand: "Warehouse",
    category: "Rice",
    unit_of_measure: "sacks",
    items_per_cell: 4,
  });
  const emptyCell = inventory
    .listCells(db)
    .find((cell) => Number(cell.occupied_quantity || 0) === 0);
  assert.ok(emptyCell);
  inventory.createAdjustment(db, {
    cellId: emptyCell.id,
    userId: admin.id,
    reason: "Opening rice stock",
    lines: [{ productId: product.id, absoluteQuantity: 10 }],
  });
  assert.throws(
    () =>
      inventory.updateProductDetails(db, {
        productId: product.id,
        name: product.name,
        brand: product.brand,
        category: product.category,
        variant: product.variant,
        unit_of_measure: "kg",
        description: product.description,
      }),
    /Use the product unit migration preview/,
  );

  const completedPick = inventory.allocatePick(db, {
    userId: operator.id,
    productId: product.id,
    quantity: 2,
    preferredCellId: emptyCell.id,
  });
  inventory.completeTask(db, {
    taskId: completedPick.id,
    actualQuantities: Object.fromEntries(
      completedPick.lines.map((line) => [line.id, line.planned_quantity]),
    ),
    userId: operator.id,
    note: "Historical sacks pick",
  });
  const openPick = inventory.allocatePick(db, {
    userId: operator.id,
    productId: product.id,
    quantity: 1,
    preferredCellId: emptyCell.id,
  });

  assert.throws(
    () =>
      service.preview({
        actor: operator,
        productId: product.id,
        targetUnit: "kg",
        factor: 25,
      }),
    /Only an admin/,
  );
  assert.throws(
    () =>
      service.preview({
        actor: admin,
        productId: product.id,
        targetUnit: "kg",
        factor: 0,
      }),
    /greater than zero/,
  );

  const stalePreview = service.preview({
    actor: admin,
    productId: product.id,
    targetUnit: "kg",
    factor: 25,
    precision: 2,
  });
  assert.equal(stalePreview.before.available, 8);
  assert.equal(stalePreview.after.available, 200);
  assert.equal(stalePreview.after.itemsPerLocation, 100);
  assert.equal(stalePreview.before.openTaskLines, openPick.lines.length);
  assert.equal(inventory.getProductDetail(db, product.id).unit_of_measure, "sacks");
  assert.equal(service.list(product.id).length, 0);

  inventory.createAdjustment(db, {
    cellId: emptyCell.id,
    userId: admin.id,
    reason: "Stock changed after preview",
    lines: [{ productId: product.id, absoluteQuantity: 9 }],
  });
  assert.throws(
    () =>
      service.apply({
        actor: admin,
        productId: product.id,
        targetUnit: "kg",
        factor: 25,
        precision: 2,
        previewToken: stalePreview.token,
      }),
    /Inventory changed after the preview/,
  );
  assert.equal(inventory.getProductDetail(db, product.id).unit_of_measure, "sacks");
  assert.equal(service.list(product.id).length, 0);

  const preview = service.preview({
    actor: admin,
    productId: product.id,
    targetUnit: "kg",
    factor: 25,
    precision: 2,
  });
  assert.equal(preview.before.available, 9);
  assert.equal(preview.after.available, 225);
  const applied = service.apply({
    actor: admin,
    productId: product.id,
    targetUnit: "kg",
    factor: 25,
    precision: 2,
    previewToken: preview.token,
  });
  assert.equal(applied.applied, true);

  const convertedProduct = inventory.getProductDetail(db, product.id);
  assert.equal(convertedProduct.unit_of_measure, "kg");
  assert.equal(Number(convertedProduct.items_per_cell), 100);
  assert.equal(Number(convertedProduct.total_available), 225);

  const convertedOpenLines = db
    .prepare("SELECT planned_quantity, unit_of_measure FROM task_lines WHERE task_id = ? ORDER BY id")
    .all(openPick.id);
  assert.ok(convertedOpenLines.length > 0);
  assert.ok(convertedOpenLines.every((line) => line.unit_of_measure === "kg"));
  assert.equal(
    convertedOpenLines.reduce((sum, line) => sum + Number(line.planned_quantity), 0),
    25,
  );

  const historicalLines = db
    .prepare("SELECT actual_quantity, unit_of_measure FROM task_lines WHERE task_id = ? ORDER BY id")
    .all(completedPick.id);
  assert.ok(historicalLines.every((line) => line.unit_of_measure === "sacks"));
  assert.equal(
    historicalLines.reduce((sum, line) => sum + Number(line.actual_quantity), 0),
    2,
  );
  const historicalTransaction = db
    .prepare("SELECT quantity_delta, unit_of_measure FROM transactions WHERE task_id = ? AND type = 'pick'")
    .get(completedPick.id);
  assert.equal(historicalTransaction.unit_of_measure, "sacks");
  assert.equal(Number(historicalTransaction.quantity_delta), -2);

  const history = service.list(product.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].from_unit, "sacks");
  assert.equal(history[0].to_unit, "kg");
  assert.equal(Number(history[0].factor), 25);

  const movement = reports.buildProductMovementReport(db, {
    metric: "picked_quantity",
    groupBy: "product",
    topN: 10,
  });
  const movementRow = movement.rows.find((row) => row.product_id === product.id);
  assert.ok(movementRow);
  assert.equal(movementRow.unit_of_measure, "kg");
  assert.equal(movementRow.picked_quantity, 50);
  assert.equal(movementRow.available_quantity, 225);
  const kilogramTrend = reports.buildMovementOverTimeReport(db, {
    metric: "picked_quantity",
    groupBy: "day",
    unitOfMeasure: "kg",
    topN: 10,
  });
  assert.deepEqual(kilogramTrend.units, ["kg"]);
  assert.equal(kilogramTrend.totals.picked_quantity, 50);

  const gramsPreview = service.preview({
    actor: admin,
    productId: product.id,
    targetUnit: "g",
    factor: 1000,
    precision: 0,
  });
  service.apply({
    actor: admin,
    productId: product.id,
    targetUnit: "g",
    factor: 1000,
    precision: 0,
    previewToken: gramsPreview.token,
  });
  const gramsMovement = reports.buildProductMovementReport(db, {
    metric: "picked_quantity",
    groupBy: "product",
    topN: 10,
  });
  const gramsMovementRow = gramsMovement.rows.find((row) => row.product_id === product.id);
  assert.equal(gramsMovementRow.unit_of_measure, "g");
  assert.equal(gramsMovementRow.picked_quantity, 50000);
  assert.equal(gramsMovementRow.available_quantity, 225000);
  const gramsTrend = reports.buildMovementOverTimeReport(db, {
    metric: "picked_quantity",
    groupBy: "day",
    unitOfMeasure: "g",
    topN: 10,
  });
  assert.deepEqual(gramsTrend.units, ["g"]);
  assert.equal(gramsTrend.totals.picked_quantity, 50000);
  assert.equal(service.list(product.id).length, 2);

  db.close();
});
