import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

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

function formRequest({ url, body = {}, cookie = "" }) {
  const encoded = new URLSearchParams(body).toString();
  const request = Readable.from([Buffer.from(encoded)]);
  request.method = "POST";
  request.url = url;
  request.headers = {
    host: "localhost",
    cookie,
    "content-type": "application/x-www-form-urlencoded",
  };
  return request;
}

function getRequest({ url, cookie = "" }) {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = url;
  request.headers = { host: "localhost", cookie };
  return request;
}

test("custom report endpoints stay removed while retained definitions remain hidden", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-retired-custom-report-routes-"));
  process.chdir(sandbox);
  process.env.NO_SERVER_LISTEN = "1";
  process.env.DEMO_INVENTORY_SEED = "0";

  const auth = await import(`../src/services/auth.js?t=${Date.now()}-${Math.random()}`);
  const serverModule = await import(`../src/server.js?t=${Date.now()}-${Math.random()}`);
  const { getAppState } = await import("../src/server/app-state.js");
  const state = getAppState();
  const operator = state.db
    .prepare("SELECT id, name, username, role FROM users WHERE role = 'operator' ORDER BY id LIMIT 1")
    .get();
  const operatorCookie = auth.createSessionCookie(operator).split(";")[0];

  assert.equal("reportDefinitionService" in state, false);

  const createdAt = new Date().toISOString();
  const recipe = JSON.stringify({
    version: 1,
    type: "product_movement",
    metric: "picked_quantity",
    groupBy: "product",
    filters: { category: null, unitOfMeasure: null },
    dateRange: "last_30_days",
    topN: 10,
    visualization: "bar",
    columns: ["product.sku", "product.name", "picked_quantity"],
  });
  const insert = state.db.prepare(`
    INSERT INTO report_definitions (
      stable_key, name, description, definition_type, recipe_json,
      owner_user_id, visibility, is_locked, active, created_by, created_at, updated_at
    )
    VALUES (NULL, ?, ?, 'custom', ?, ?, 'private', 0, 1, ?, ?, ?)
  `).run(
    "Retained private report",
    "Created before custom report creation was retired.",
    recipe,
    operator.id,
    operator.id,
    createdAt,
    createdAt,
  );
  const retainedId = Number(insert.lastInsertRowid);
  const countBefore = Number(
    state.db.prepare("SELECT COUNT(*) AS count FROM report_definitions").get().count,
  );

  const reportsPage = new MockResponse();
  await serverModule.requestHandler(
    getRequest({ url: `/reports#saved-report-${retainedId}`, cookie: operatorCookie }),
    reportsPage,
  );
  assert.equal(reportsPage.statusCode, 200);
  assert.doesNotMatch(reportsPage.body, /Retained private report/);
  assert.doesNotMatch(reportsPage.body, /saved-report-/);
  assert.doesNotMatch(reportsPage.body, /Create (?:A )?(?:Custom|Private) Report/i);
  assert.doesNotMatch(reportsPage.body, /Duplicate Report|Edit Report|Delete Report/);
  assert.doesNotMatch(reportsPage.body, /action="\/reports\/custom/);

  const retiredEndpoints = [
    "/reports/custom",
    `/reports/custom/${retainedId}/update`,
    `/reports/custom/${retainedId}/delete`,
  ];
  for (const url of retiredEndpoints) {
    const response = new MockResponse();
    await serverModule.requestHandler(
      formRequest({
        url,
        cookie: operatorCookie,
        body: {
          report_name: "Attempted mutation",
          metric: "put_quantity",
          group_by: "category",
          date_range: "all_time",
          limit: "1",
          visualization: "table",
          visibility: "private",
        },
      }),
      response,
    );
    assert.equal(response.statusCode, 404, url);
  }

  assert.equal(
    Number(state.db.prepare("SELECT COUNT(*) AS count FROM report_definitions").get().count),
    countBefore,
  );
  assert.deepEqual(
    {
      ...state.db
        .prepare("SELECT name, recipe_json, active FROM report_definitions WHERE id = ?")
        .get(retainedId),
    },
    {
      name: "Retained private report",
      recipe_json: recipe,
      active: 1,
    },
  );
});

test("product field administration remains protected and uses report-oriented wording", async () => {
  const { getAppState } = await import("../src/server/app-state.js");
  const state = getAppState();
  const auth = await import(`../src/services/auth.js?t=${Date.now()}-${Math.random()}`);
  const serverModule = await import(`../src/server.js?t=${Date.now()}-${Math.random()}`);
  const admin = state.db
    .prepare("SELECT id, name, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    .get();
  const operator = state.db
    .prepare("SELECT id, name, username, role FROM users WHERE role = 'operator' ORDER BY id LIMIT 1")
    .get();
  const adminCookie = auth.createSessionCookie(admin).split(";")[0];
  const operatorCookie = auth.createSessionCookie(operator).split(";")[0];
  const fieldCountBefore = Number(
    state.db.prepare("SELECT COUNT(*) AS count FROM product_field_definitions").get().count,
  );

  const operatorFieldCreate = new MockResponse();
  await serverModule.requestHandler(
    formRequest({
      url: "/admin/product-fields",
      cookie: operatorCookie,
      body: { label: "Forbidden field", data_type: "text", reportable: "1" },
    }),
    operatorFieldCreate,
  );
  assert.equal(operatorFieldCreate.statusCode, 302);
  assert.match(operatorFieldCreate.headers.Location, /Admin\+access\+is\+required/);
  assert.equal(
    Number(state.db.prepare("SELECT COUNT(*) AS count FROM product_field_definitions").get().count),
    fieldCountBefore,
  );

  const adminFieldsPage = new MockResponse();
  await serverModule.requestHandler(
    getRequest({ url: "/admin/product-fields", cookie: adminCookie }),
    adminFieldsPage,
  );
  assert.equal(adminFieldsPage.statusCode, 200);
  assert.match(adminFieldsPage.body, /Product Fields/);
  assert.match(adminFieldsPage.body, /Available for reports/);
  assert.doesNotMatch(adminFieldsPage.body, /Available in report builder/);
  assert.doesNotMatch(adminFieldsPage.body, /saved reports/i);
});
