import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

async function createTestContext() {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-report-view-controls-"));
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

function createProduct(inventory, db, { sku, name, unit }) {
  return inventory.createProduct(db, {
    sku,
    name,
    brand: "View Controls Test",
    category: "Report Fixtures",
    unit_of_measure: unit,
    items_per_cell: 1000,
  });
}

function stockProducts(inventory, db, admin, cellId, entries) {
  inventory.createAdjustment(db, {
    cellId,
    userId: admin.id,
    reason: "Report view controls fixture",
    lines: entries.map(({ product, quantity }) => ({
      productId: product.id,
      absoluteQuantity: quantity,
    })),
  });
}

function extractInlineReport(html, key) {
  const marker = `data-report-inline="${key}"`;
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected inline report ${key}`);
  const start = html.lastIndexOf("<article", markerIndex);
  assert.notEqual(start, -1, `expected opening article for ${key}`);

  const tagPattern = /<\/?article\b[^>]*>/gi;
  tagPattern.lastIndex = start;
  let depth = 0;
  for (const match of html.matchAll(tagPattern)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return html.slice(start, match.index + match[0].length);
    }
  }
  assert.fail(`expected closing article for ${key}`);
}

function tagsWithAttribute(html, tagName, attribute) {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*\\b${attribute}(?:=(?:"[^"]*"|'[^']*'|[^\\s>]+))?[^>]*>`, "gi"))]
    .map((match) => match[0]);
}

function attributeValue(tag, attribute) {
  const match = tag.match(new RegExp(`\\b${attribute}="([^"]*)"`, "i"));
  return match?.[1] ?? null;
}

function occurrences(html, pattern) {
  return [...html.matchAll(pattern)].length;
}

function elementWithAttribute(html, tagName, attribute) {
  const match = html.match(
    new RegExp(`<${tagName}\\b[^>]*\\b${attribute}(?:=(?:"[^"]*"|'[^']*'|[^\\s>]+))?[^>]*>[\\s\\S]*?<\\/${tagName}>`, "i"),
  );
  assert.ok(match, `expected <${tagName}> with ${attribute}`);
  return match[0];
}

function selectOptions(html, attribute) {
  const select = elementWithAttribute(html, "select", attribute);
  return [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((match) => ({
    value: match[1].match(/\bvalue="([^"]*)"/i)?.[1] ?? "",
    label: match[2].replace(/<[^>]+>/g, "").trim(),
  }));
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function seedMixedUnitStock({ admin, db, inventory }) {
  const cell = inventory.listCells(db)[0];
  assert.ok(cell, "expected a seeded active location");
  const crates = createProduct(inventory, db, {
    sku: "VIEW-CRATES",
    name: "Crated Parts",
    unit: "crates",
  });
  const kilograms = createProduct(inventory, db, {
    sku: "VIEW-KG",
    name: "Bulk Rice",
    unit: "kg",
  });
  stockProducts(inventory, db, admin, cell.id, [
    { product: crates, quantity: 40 },
    { product: kilograms, quantity: 60 },
  ]);
  return { cell, crates, kilograms };
}

function completePlannedTask(inventory, db, task, userId, note) {
  return inventory.completeTask(db, {
    taskId: task.id,
    actualQuantities: Object.fromEntries(
      task.lines.map((line) => [line.id, line.planned_quantity]),
    ),
    userId,
    note,
  });
}

test("operator stock reports keep controls in the stage toolbar and print only report content", async () => {
  const context = await createTestContext();
  seedMixedUnitStock(context);
  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");
  const html = createReportsPages({ db: context.db }).renderReports(
    context.operator,
    null,
    new URL("http://localhost/reports#stock-snapshot"),
  );
  const report = extractInlineReport(html, "stock-snapshot");

  assert.doesNotMatch(html, /class="[^"]*\breport-filter-panel\b/);
  assert.doesNotMatch(html, /class="[^"]*\bpreset-chip\b/);
  assert.match(html, /data-report-visuals-control/);
  assert.match(html, /data-report-visuals-panel/);
  assert.match(html, /data-report-visuals-options/);
  assert.doesNotMatch(html, /data-report-visuals-all/);
  assert.match(html, /data-report-visuals-none[^>]*>Table only<\/button>/);
  assert.match(html, /data-report-filters-control/);
  assert.match(html, /data-report-filters-panel/);
  assert.match(html, /data-report-filters-options/);
  assert.match(html, /Select one or more units to include\./);
  assert.doesNotMatch(html, /data-report-filters-all/);
  assert.match(html, /data-report-filters-none[^>]*>Clear<\/button>/);
  assert.doesNotMatch(html, /data-report-builder|data-custom-report-form|data-report-delete-form/);
  assert.doesNotMatch(html, /Create (?:A )?(?:Custom|Private) Report/i);
  assert.doesNotMatch(html, /Duplicate Report|Edit Report|Delete Report/);
  assert.doesNotMatch(html, /action="\/reports\/custom/);
  assert.match(html, />Choose Report To Print<\/button>/);
  assert.doesNotMatch(html, /report-template-library|data-report-template=/);

  const visualsButton = elementWithAttribute(html, "button", "data-report-visuals-toggle");
  assert.match(visualsButton, /title="Choose report visuals"/);
  assert.match(visualsButton, />Visuals<\/button>$/);
  assert.doesNotMatch(visualsButton, /\d+\s+visual/i);
  const filtersButton = elementWithAttribute(html, "button", "data-report-filters-toggle");
  assert.match(filtersButton, />Filters<\/button>$/);

  assert.match(report, /data-stock-composition-report/);
  const stockArticle = tagsWithAttribute(report, "article", "data-report-inline")[0];
  assert.equal(attributeValue(stockArticle, "data-report-uses-global-range"), "false");
  assert.equal(attributeValue(stockArticle, "data-report-recipe"), null);
  assert.equal(attributeValue(stockArticle, "data-report-visibility"), null);
  assert.equal(attributeValue(stockArticle, "data-report-edit-action"), null);
  assert.equal(attributeValue(stockArticle, "data-report-delete-action"), null);
  assert.match(report, /<dt>Selected Range<\/dt>\s*<dd>Current Snapshot<\/dd>/);
  assert.doesNotMatch(report, /data-report-screen-only/);
  assert.doesNotMatch(report, /data-report-view-controls/);
  assert.doesNotMatch(report, /data-report-visuals-control/);
  assert.doesNotMatch(report, /data-report-filters-control/);
  assert.doesNotMatch(report, /data-report-time-control/);
  assert.doesNotMatch(report, /data-report-(?:visuals|filters)-option/);

  const visualGrid = tagsWithAttribute(report, "div", "data-report-visual-grid");
  assert.equal(visualGrid.length, 1);
  assert.match(visualGrid[0], /class="[^"]*\breport-visual-grid\b/);
  const visuals = tagsWithAttribute(report, "(?:figure|section)", "data-report-visual-unit");
  assert.deepEqual(
    visuals.map((tag) => attributeValue(tag, "data-report-visual-unit")).sort(),
    ["crates", "kg"],
  );
  assert.ok(visuals.every((tag) => /class="[^"]*\breport-chart-compact\b/.test(tag)));

  const stockRows = tagsWithAttribute(report, "tr", "data-report-stock-row");
  assert.deepEqual(
    stockRows.map((tag) => attributeValue(tag, "data-report-stock-unit")).sort(),
    ["crates", "kg"],
  );
  assert.equal(occurrences(report, /\bdata-report-visual-note\b/g), 1);
  assert.match(
    report,
    /Each visual compares stock only within its shown unit\. Quantities from different units are never combined\./,
  );
  assert.doesNotMatch(report, /class="report-chart-description"/);

  const compositionRoot = tagsWithAttribute(
    report,
    "section",
    "data-stock-composition-report",
  )[0];
  assert.ok(compositionRoot);
  assert.equal(attributeValue(compositionRoot, "data-report-has-visuals"), "true");
  const units = JSON.parse(
    decodeHtmlAttribute(attributeValue(compositionRoot, "data-report-units")),
  );
  assert.deepEqual(units, [
    { token: "crates", label: "crates" },
    { token: "kg", label: "kg" },
  ]);
  const summaries = JSON.parse(
    decodeHtmlAttribute(attributeValue(compositionRoot, "data-report-unit-summaries")),
  );
  assert.deepEqual(Object.keys(summaries).sort(), ["all", "crates", "kg"]);
  assert.equal(summaries.all.units.value, "crates, kg");
  assert.equal(summaries.all.units.detail, "2 units selected");
  assert.equal(summaries.crates.onHand.value, "40 crates");
  assert.equal(summaries.crates.meta.stockGroupCount, 1);
  assert.equal(summaries.kg.onHand.value, "60 kg");
  assert.equal(summaries.kg.meta.total, 60);
  for (const summary of Object.values(summaries)) {
    for (const key of ["stockGroups", "units", "largest", "onHand"]) {
      assert.equal(typeof summary[key]?.value, "string");
      assert.equal(typeof summary[key]?.detail, "string");
    }
  }
  assert.match(report, /<table class="report-summary-table" aria-label="Report summary">/);
  assert.deepEqual(
    tagsWithAttribute(report, "tr", "data-report-summary-item")
      .map((tag) => attributeValue(tag, "data-report-summary-item")),
    ["stockGroups", "units", "largest", "onHand"],
  );
  assert.match(report, /class="report-document-context" aria-label="Report context"/);
  assert.match(report, /data-report-context-item="generatedBy"/);
  assert.ok(report.includes(`${context.operator.name} (${context.operator.username})`));
  assert.match(report, /data-report-context-item="reportingUnit"/);
  assert.match(report, /<dd>LytGuide IMS<\/dd>/);

  context.db.close();
});

test("curated report library exposes one clear question and print target per report", async () => {
  const context = await createTestContext();
  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");
  const html = createReportsPages({ db: context.db }).renderReports(
    context.operator,
    null,
    new URL("http://localhost/reports#replenishment-watch"),
  );
  const expectedReports = [
    ["product-movement", "Product Movement & Demand", "Which products were picked most in the selected timeframe?", true],
    ["stock-snapshot", "Stock Snapshot", "What stock can we pick right now?", false],
    ["replenishment-watch", "Replenishment Watch", "Which products are out of stock or down to one normal location batch?", false],
    ["slow-moving-stock", "Slow-Moving Stock", "Which stocked products were not picked in the selected timeframe?", true],
    ["movement", "Stock Change Over Time", "Did inventory increase or decrease during the selected timeframe?", true],
    ["team-activity", "Team Throughput", "What pick and put-away work did each team member complete?", true],
    ["issues", "Exception Hotspots", "Where did completed warehouse work fall short of plan?", true],
    ["adjustments", "Adjustment Audit", "Who manually changed stock, when, and why?", true],
  ];

  assert.match(html, /Curated Questions/);
  assert.match(html, /Choose the warehouse question you want answered\./);
  assert.match(html, /<span>8<\/span>/);
  const libraryItems = tagsWithAttribute(html, "a", "data-report-open");
  const inlineReports = tagsWithAttribute(html, "article", "data-report-inline");
  const printOptions = tagsWithAttribute(html, "button", "data-report-print-option");
  assert.equal(libraryItems.length, expectedReports.length);
  assert.equal(inlineReports.length, expectedReports.length);
  assert.equal(printOptions.length, expectedReports.length);

  for (const [key, title, question, usesGlobalRange] of expectedReports) {
    const libraryItem = libraryItems.find(
      (tag) => attributeValue(tag, "data-report-open") === key,
    );
    const inlineTag = inlineReports.find(
      (tag) => attributeValue(tag, "data-report-inline") === key,
    );
    const printOption = printOptions.find(
      (tag) => attributeValue(tag, "data-report-print-option") === key,
    );
    assert.ok(libraryItem, `expected library item ${key}`);
    assert.ok(inlineTag, `expected inline report ${key}`);
    assert.ok(printOption, `expected print option ${key}`);
    assert.equal(attributeValue(libraryItem, "href"), `#${key}`);
    assert.equal(
      decodeHtmlAttribute(attributeValue(libraryItem, "data-report-title")),
      title,
    );
    assert.equal(attributeValue(libraryItem, "aria-controls"), key);
    assert.equal(
      attributeValue(inlineTag, "data-report-uses-global-range"),
      String(usesGlobalRange),
    );
    const decodedReport = decodeHtmlAttribute(extractInlineReport(html, key));
    assert.ok(decodedReport.includes(`<h3>${title}</h3>`));
    assert.ok(decodedReport.includes(question));
  }

  assert.doesNotMatch(html, /My Reports|Shared Reports|Saved Definition|saved-report-/);
  assert.doesNotMatch(html, /data-report-recipe|data-report-edit-action|data-report-delete-action/);
  context.db.close();
});

test("replenishment, slow-moving stock, and team throughput answer their questions directly", async () => {
  const context = await createTestContext();
  const { crates, kilograms } = seedMixedUnitStock(context);
  const pick = context.inventory.allocatePick(context.db, {
    userId: context.operator.id,
    productId: crates.id,
    quantity: 5,
  });
  completePlannedTask(
    context.inventory,
    context.db,
    pick,
    context.operator.id,
    "Curated report pick fixture",
  );
  const put = context.inventory.planPut(context.db, {
    userId: context.operator.id,
    productId: kilograms.id,
    quantity: 10,
  });
  completePlannedTask(
    context.inventory,
    context.db,
    put,
    context.operator.id,
    "Curated report put fixture",
  );

  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");
  const html = createReportsPages({ db: context.db }).renderReports(
    context.operator,
    null,
    new URL("http://localhost/reports?preset=last-30d#replenishment-watch"),
  );

  const replenishment = extractInlineReport(html, "replenishment-watch");
  assert.match(replenishment, /<h3>Replenishment Watch<\/h3>/);
  assert.match(replenishment, /<dd>Current Snapshot<\/dd>/);
  assert.deepEqual(
    tagsWithAttribute(replenishment, "tr", "data-report-summary-item")
      .map((tag) => attributeValue(tag, "data-report-summary-item")),
    ["attention", "empty", "low", "units"],
  );
  assert.match(replenishment, /Products By Replenishment Status/);
  assert.match(replenishment, /Products To Review/);
  assert.match(replenishment, /Crated Parts/);
  assert.match(replenishment, /Bulk Rice/);
  assert.match(replenishment, /One batch or less/);
  assert.match(replenishment, /practical replenishment watch, not a demand forecast/i);

  const slowMoving = extractInlineReport(html, "slow-moving-stock");
  assert.match(slowMoving, /<h3>Slow-Moving Stock<\/h3>/);
  assert.deepEqual(
    tagsWithAttribute(slowMoving, "tr", "data-report-summary-item")
      .map((tag) => attributeValue(tag, "data-report-summary-item")),
    ["slow", "never", "older"],
  );
  assert.match(slowMoving, /Why These Products Are Listed/);
  assert.match(slowMoving, /Stock Without Recent Picks/);
  assert.match(slowMoving, /Bulk Rice/);
  assert.doesNotMatch(slowMoving, /Crated Parts/);
  assert.match(slowMoving, /Never picked/);
  assert.match(slowMoving, /Only positive quantities on completed pick tasks count as usage/);

  const throughput = extractInlineReport(html, "team-activity");
  assert.match(throughput, /<h3>Team Throughput<\/h3>/);
  assert.deepEqual(
    tagsWithAttribute(throughput, "tr", "data-report-summary-item")
      .map((tag) => attributeValue(tag, "data-report-summary-item")),
    ["completed", "picks", "puts", "clean"],
  );
  assert.match(
    throughput,
    /data-report-summary-item="completed"[\s\S]*?<td data-report-summary-value>2<\/td>/,
  );
  assert.match(
    throughput,
    /data-report-summary-item="picks"[\s\S]*?<td data-report-summary-value>1<\/td>/,
  );
  assert.match(
    throughput,
    /data-report-summary-item="puts"[\s\S]*?<td data-report-summary-value>1<\/td>/,
  );
  assert.match(throughput, /Completed Tasks By Team Member/);
  assert.match(throughput, /Completed Work By User/);
  assert.ok(throughput.includes(context.operator.name));
  assert.match(throughput, /Multi-line tasks count once/);

  context.db.close();
});

test("time control renders every preset and custom date-time details", async () => {
  const context = await createTestContext();
  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");
  const pages = createReportsPages({ db: context.db });
  const defaultHtml = pages.renderReports(
    context.operator,
    null,
    new URL("http://localhost/reports"),
  );

  assert.match(defaultHtml, /data-report-time-control/);
  assert.match(defaultHtml, /class="[^"]*\breport-time-toggle\b[^\"]*"/);
  assert.match(
    elementWithAttribute(defaultHtml, "button", "data-report-time-toggle"),
    />Last 30 Days<\/button>$/,
  );
  assert.match(defaultHtml, /data-report-time-panel[^>]*hidden/);
  assert.match(defaultHtml, /<form[^>]*method="get"[^>]*action="\/reports"[^>]*data-report-time-form/);
  assert.deepEqual(selectOptions(defaultHtml, "data-report-time-preset"), [
    { value: "last-1h", label: "Last 1 Hour" },
    { value: "last-3h", label: "Last 3 Hours" },
    { value: "last-6h", label: "Last 6 Hours" },
    { value: "last-12h", label: "Last 12 Hours" },
    { value: "last-24h", label: "Last 24 Hours" },
    { value: "last-7d", label: "Last 7 Days" },
    { value: "last-30d", label: "Last 30 Days" },
    { value: "last-90d", label: "Last 90 Days" },
    { value: "previous-day", label: "Previous Day" },
    { value: "previous-week", label: "Previous Week" },
    { value: "previous-month", label: "Previous Month" },
    { value: "all-time", label: "All Time" },
    { value: "custom", label: "Custom" },
  ]);
  assert.match(defaultHtml, /<option value="last-30d" selected>Last 30 Days<\/option>/);
  assert.match(
    tagsWithAttribute(defaultHtml, "div", "data-report-custom-time-fields")[0],
    /\shidden(?:\s|>)/,
  );
  assert.doesNotMatch(defaultHtml, /class="[^"]*\breport-filter-panel\b/);
  assert.doesNotMatch(defaultHtml, /class="[^"]*\bpreset-chip\b/);

  const customHtml = pages.renderReports(
    context.operator,
    null,
    new URL(
      "http://localhost/reports?from=2026-07-01T08%3A30&to=2026-07-02T17%3A45#product-movement",
    ),
  );
  assert.match(
    elementWithAttribute(customHtml, "button", "data-report-time-toggle"),
    />Custom<\/button>$/,
  );
  assert.match(customHtml, /<option value="custom" selected>Custom<\/option>/);
  const customFieldsTag = tagsWithAttribute(
    customHtml,
    "div",
    "data-report-custom-time-fields",
  )[0];
  assert.doesNotMatch(customFieldsTag, /\shidden(?:\s|>)/);
  const timeForm = elementWithAttribute(customHtml, "form", "data-report-time-form");
  assert.match(timeForm, /name="from" value="2026-07-01T08:30"/);
  assert.match(timeForm, /name="to" value="2026-07-02T17:45"/);

  const movement = extractInlineReport(customHtml, "product-movement");
  assert.match(movement, /<dt>Selected Range<\/dt>/);
  assert.match(
    movement,
    /<dd>Custom · [^<]*1 Jul 2026[^<]*8:30[^<]*2 Jul 2026[^<]*5:45[^<]*<\/dd>/,
  );
  assert.doesNotMatch(customHtml, /data-report-recipe/);

  const hourlyHtml = pages.renderReports(
    context.operator,
    null,
    new URL("http://localhost/reports?preset=last-1h#product-movement"),
  );
  const hourlyMovement = extractInlineReport(hourlyHtml, "product-movement");
  assert.match(
    elementWithAttribute(hourlyHtml, "button", "data-report-time-toggle"),
    />Last 1 Hour<\/button>$/,
  );
  assert.match(hourlyMovement, /<dt>Selected Range<\/dt>\s*<dd>Last 1 Hour<\/dd>/);

  const reversedHtml = pages.renderReports(
    context.operator,
    null,
    new URL(
      "http://localhost/reports?from=2026-07-03T17%3A45&to=2026-07-01T08%3A30#movement",
    ),
  );
  assert.match(
    reversedHtml,
    /data-report-time-error[^>]*>The start was after the end, so the dates were corrected automatically\.<\/p>/,
  );
  const reversedForm = elementWithAttribute(reversedHtml, "form", "data-report-time-form");
  assert.match(reversedForm, /name="from" value="2026-07-01T08:30"/);
  assert.match(reversedForm, /name="to" value="2026-07-03T17:45"/);

  context.db.close();
});

test("client controller binds multi-select stock controls, curated hashes, and report-only printing", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(appSource, /data-report-builder|data-custom-report-form|\/reports\/custom/);
  assert.doesNotMatch(appSource, /data-report-visuals-all/);
  assert.doesNotMatch(appSource, /data-report-filters-all/);
  assert.match(appSource, /input\.type = "checkbox"/);
  assert.match(
    appSource,
    /renderUnitOptions\(\s*visualsOptions,\s*activeStockState,\s*"visualSelections",\s*"data-report-visuals-option",\s*"data-report-visuals-select-all"/,
  );
  assert.match(
    appSource,
    /renderUnitOptions\(\s*filtersOptions,\s*activeStockState,\s*"filterSelections",\s*"data-report-filters-option",\s*"data-report-filters-select-all"/,
  );
  assert.match(
    appSource,
    /selectAllInput\.checked = state\.units\.length > 0 && selected\.size === state\.units\.length/,
  );
  assert.match(
    appSource,
    /selectAllInput\.indeterminate = selected\.size > 0 && selected\.size < state\.units\.length/,
  );
  assert.match(
    appSource,
    /fragment\.append\(selectAllLabel\);\s*state\.units\.forEach/,
  );
  assert.match(appSource, /event\.target\.closest\?\.\("\[data-report-visuals-select-all\]"\)/);
  assert.match(appSource, /event\.target\.closest\?\.\("\[data-report-filters-select-all\]"\)/);
  assert.equal(
    occurrences(
      appSource,
      /selectAll\.checked\s*\? new Set\(activeStockState\.units\.map\(\(unit\) => unit\.token\)\)\s*: new Set\(\)/g,
    ),
    2,
    "expected both visuals and filters Select all checkboxes to toggle the complete unit set",
  );
  assert.match(appSource, /visualsControl\.hidden = !activeStockState\.hasVisuals/);
  assert.match(appSource, /filtersControl\.hidden = false/);
  assert.match(appSource, /visualsToggle\.textContent = "Visuals"/);
  assert.match(appSource, /visualsToggle\.title = `Choose report visuals; \$\{status\}`/);
  assert.match(
    appSource,
    /const custom = timePreset\?\.value === "custom"[\s\S]*?customTimeFields\.hidden = !custom/,
  );
  assert.match(appSource, /const reportKeys = new Set\(\[\.\.\.reportTemplates\.keys\(\), \.\.\.inlinePanelMap\.keys\(\)\]\)/);
  assert.match(appSource, /button\.classList\.toggle\("report-library-item-active", active\)/);
  assert.match(appSource, /button\.setAttribute\("aria-current", "page"\)/);
  assert.match(appSource, /stageTitle\.textContent = title/);
  assert.match(
    appSource,
    /window\.history\.pushState\(null, "", `\$\{window\.location\.pathname\}\$\{window\.location\.search\}#\$\{key\}`\)/,
  );
  assert.match(appSource, /const syncReportFromLocation = \(\) =>/);
  assert.match(appSource, /window\.addEventListener\("hashchange", syncReportFromLocation\)/);
  assert.match(
    appSource,
    /window\.history\.replaceState\([\s\S]*?#\$\{defaultReportKey\}`/,
  );
  assert.match(appSource, /button\.dataset\.reportPrintOption/);
  assert.match(appSource, /openReport\(key, \{ updateHash: true, focus: false, scroll: false \}\)/);
  assert.match(appSource, /document\.body\.classList\.add\("report-printing"\)/);
  assert.match(appSource, /window\.requestAnimationFrame\(\(\) => window\.print\(\)\)/);
  assert.match(appSource, /window\.addEventListener\("beforeprint"/);
  assert.match(appSource, /window\.addEventListener\("afterprint"/);
});

test("report tables fit without internal scrolling and share compact stock typography", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /\.report-document \.table-wrap\s*\{[^}]*overflow:\s*visible;/,
  );
  assert.match(
    styles,
    /\.report-document table\s*\{[^}]*min-width:\s*0;[^}]*table-layout:\s*fixed;/,
  );
  assert.match(
    styles,
    /\.report-summary-table-wrap\s*\{[^}]*overflow:\s*visible;/,
  );
  assert.match(
    styles,
    /table\.report-summary-table,[\s\S]{0,180}\[data-report-stock-table\] table\s*\{[^}]*font-size:\s*9\.5px;[^}]*line-height:\s*1\.22;/,
  );
  assert.match(
    styles,
    /body\.report-printing table\.report-summary-table,[\s\S]{0,260}body\.report-printing \[data-report-stock-table\] table\s*\{[^}]*font-size:\s*7\.25pt;[^}]*line-height:\s*1\.18;/,
  );
  assert.match(
    styles,
    /body\.report-printing \[data-report-screen-only\],[\s\S]{0,500}\{\s*display:\s*none\s*!important;/,
  );
  assert.match(
    styles,
    /body\.report-printing \.report-inline-stack > \[data-report-inline\]\[hidden\]\s*\{\s*display:\s*none\s*!important;/,
  );
  assert.match(
    styles,
    /body\.report-printing \.report-inline-stack > \[data-report-inline\]:not\(\[hidden\]\)\s*\{[^}]*display:\s*block\s*!important;/,
  );
});
