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
  const productFields = await freshImport("../src/services/product-fields.js");
  const reportDefinitions = await freshImport("../src/services/report-definitions.js");
  const reportsPages = await freshImport("../src/server/pages/reports.js");
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
  return { admin, db, operator, productFields, reportDefinitions, reportsPages };
}

test("report-required system product fields cannot be made non-reportable", async () => {
  const { admin, db, productFields } = await createContext(
    "inventory-report-required-fields-",
  );
  const fields = productFields.createProductFieldService({ db });

  for (const systemRole of ["identifier", "display_name", "unit_of_measure"]) {
    const field = fields.list({ includeInactive: true }).find(
      (candidate) => candidate.system_role === systemRole,
    );
    assert.ok(field, `expected a core field for ${systemRole}`);
    assert.equal(field.reportable, 1);
    assert.throws(
      () => fields.update({ actor: admin, fieldId: field.id, reportable: 0 }),
      /required by reports|reporting cannot be disabled/i,
    );
    const persisted = fields.list({ includeInactive: true }).find(
      (candidate) => candidate.id === field.id,
    );
    assert.equal(persisted.reportable, 1);
  }

  db.close();
});

test("retired corrupt and legacy definitions remain stored but never render or execute", async () => {
  const { db, operator, reportDefinitions, reportsPages } = await createContext(
    "inventory-report-definition-resilience-",
  );
  const definitions = reportDefinitions.createReportDefinitionService({ db });
  const createdAt = "2026-07-05T08:00:00.000Z";
  const insert = db.prepare(
    `
      INSERT INTO report_definitions (
        stable_key, name, description, definition_type, recipe_json,
        owner_user_id, visibility, is_locked, active, created_by, created_at, updated_at
      )
      VALUES (NULL, ?, ?, 'custom', ?, ?, 'private', 0, 1, ?, ?, ?)
    `,
  );
  const corruptId = Number(
    insert.run(
      "Corrupt saved report",
      "A deliberately malformed persisted recipe",
      "{ definitely not json",
      operator.id,
      operator.id,
      createdAt,
      createdAt,
    ).lastInsertRowid,
  );
  const legacyId = Number(
    insert.run(
      "Legacy saved report",
      "A recipe from an unsupported older report type",
      JSON.stringify({
        version: 0,
        type: "legacy_inventory_report",
        metric: "legacy_total",
        groupBy: "warehouse_zone",
        columns: ["legacy.value"],
      }),
      operator.id,
      operator.id,
      createdAt,
      createdAt,
    ).lastInsertRowid,
  );

  let listed;
  assert.doesNotThrow(() => {
    listed = definitions.list({ actor: operator });
  });
  const corrupt = listed.find((definition) => Number(definition.id) === corruptId);
  const legacy = listed.find((definition) => Number(definition.id) === legacyId);
  assert.ok(corrupt);
  assert.ok(legacy);
  assert.equal(corrupt.recipe, null);
  assert.equal(corrupt.validation_status, "needs_attention");
  assert.equal(legacy.validation_status, "needs_attention");
  assert.deepEqual(legacy.unavailable_fields, ["legacy.value"]);

  const persistedBeforeRender = db
    .prepare(
      `
        SELECT id, name, recipe_json, active, updated_at
        FROM report_definitions
        WHERE id IN (?, ?)
        ORDER BY id
      `,
    )
    .all(corruptId, legacyId);
  assert.deepEqual(
    persistedBeforeRender.map((row) => ({
      id: Number(row.id),
      name: row.name,
      recipe_json: row.recipe_json,
      active: Number(row.active),
      updated_at: row.updated_at,
    })),
    [
      {
        id: corruptId,
        name: "Corrupt saved report",
        recipe_json: "{ definitely not json",
        active: 1,
        updated_at: createdAt,
      },
      {
        id: legacyId,
        name: "Legacy saved report",
        recipe_json: JSON.stringify({
          version: 0,
          type: "legacy_inventory_report",
          metric: "legacy_total",
          groupBy: "warehouse_zone",
          columns: ["legacy.value"],
        }),
        active: 1,
        updated_at: createdAt,
      },
    ],
  );

  let html;
  assert.doesNotThrow(() => {
    html = reportsPages.createReportsPages({ db }).renderReports(
      operator,
      null,
      new URL("http://localhost/reports"),
    );
  });
  assert.match(html, /Curated Questions/);
  assert.match(html, /Replenishment Watch/);
  assert.match(html, /Slow-Moving Stock/);
  assert.match(html, /Team Throughput/);
  assert.match(html, /Exception Hotspots/);
  assert.doesNotMatch(html, /Corrupt saved report/);
  assert.doesNotMatch(html, /Legacy saved report/);
  assert.doesNotMatch(html, /Report Needs Attention/);
  assert.doesNotMatch(html, /data-report-inline="saved-report-/);
  assert.doesNotMatch(html, /data-report-builder/);

  const persistedAfterRender = db
    .prepare(
      `
        SELECT id, name, recipe_json, active, updated_at
        FROM report_definitions
        WHERE id IN (?, ?)
        ORDER BY id
      `,
    )
    .all(corruptId, legacyId);
  assert.deepEqual(persistedAfterRender, persistedBeforeRender);

  db.close();
});

test("stock aggregate groupings reject product-only detail columns", async () => {
  const { admin, db, productFields, reportDefinitions } = await createContext(
    "inventory-report-stock-column-validation-",
  );
  const fields = productFields.createProductFieldService({ db });
  const definitions = reportDefinitions.createReportDefinitionService({ db });
  const customGroup = fields.create({
    actor: admin,
    label: "Storage Class",
    dataType: "text",
    reportable: 1,
  });
  const stockRecipe = (overrides = {}) => ({
    type: "stock_composition",
    metric: "available_quantity",
    groupBy: "category",
    filters: { category: null, unitOfMeasure: null },
    topN: 10,
    visualization: "table",
    columns: [
      "group_label",
      "product_count",
      "available_quantity",
      "product.unit_of_measure",
    ],
    ...overrides,
  });

  assert.throws(
    () =>
      definitions.validate(
        stockRecipe({
          groupBy: "category",
          columns: ["group_label", "product.brand", "available_quantity"],
        }),
      ),
    /Product-only detail columns require grouping current stock by product/i,
  );
  assert.throws(
    () =>
      definitions.validate(
        stockRecipe({
          groupBy: customGroup.field_key,
          columns: ["group_label", "product.sku", "available_quantity"],
        }),
      ),
    /Product-only detail columns require grouping current stock by product/i,
  );

  const aggregate = definitions.validate(stockRecipe());
  assert.deepEqual(aggregate.columns, [
    "group_label",
    "product_count",
    "available_quantity",
    "product.unit_of_measure",
  ]);
  const productDetail = definitions.validate(
    stockRecipe({
      groupBy: "product",
      columns: ["product.name", "product.brand", "available_quantity"],
    }),
  );
  assert.deepEqual(productDetail.columns, [
    "product.name",
    "product.brand",
    "available_quantity",
  ]);

  db.close();
});
