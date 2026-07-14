import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

async function createTestDatabase(prefix = "inventory-report-format-") {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(sandbox);
  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const db = createDatabase({
    hashPassword: auth.hashPassword,
    allowDemoInventorySeed: false,
  });
  return { db };
}

test("report format defaults extend legacy settings without changing their meaning", async () => {
  const reportFormat = await freshImport("../src/services/report-format.js");
  const defaults = reportFormat.DEFAULT_REPORT_FORMAT;

  assert.equal(defaults.stylePreset, "clean");
  assert.deepEqual(
    reportFormat.REPORT_FORMAT_PRESET_OPTIONS.map((option) => option.value),
    ["clean", "compact", "formal"],
  );
  assert.equal(reportFormat.REPORT_FORMAT_PRESETS.clean.values.tableDensity, "comfortable");
  assert.equal(reportFormat.REPORT_FORMAT_PRESETS.compact.values.bodyFontSize, 11);
  assert.equal(reportFormat.REPORT_FORMAT_PRESETS.formal.values.fontFamily, "georgia");
  assert.ok(["compact", "comfortable", "spacious"].includes(defaults.tableDensity));
  assert.ok(["white", "soft", "accent"].includes(defaults.tableHeaderShade));
  assert.ok(["none", "subtle"].includes(defaults.rowShading));
  assert.ok(["grid", "horizontal", "minimal"].includes(defaults.tableLines));
  assert.ok(["neutral", "accent", "light"].includes(defaults.sectionRule));

  const legacy = reportFormat.normalizeReportFormatSettings({
    companyName: "Legacy Warehouse",
    headerLabel: "Legacy stock report",
    fontFamily: "georgia",
    bodyFontSize: 14,
    headingFontSize: 28,
    subheadingFontSize: 12,
    accentColor: "#0F8F7A",
  });
  assert.equal(legacy.companyName, "Legacy Warehouse");
  assert.equal(legacy.headerLabel, "Legacy stock report");
  assert.equal(legacy.fontFamily, "georgia");
  assert.equal(legacy.bodyFontSize, 14);
  assert.equal(legacy.headingFontSize, 28);
  assert.equal(legacy.subheadingFontSize, 12);
  assert.equal(legacy.accentColor, "#0f8f7a");
  assert.equal(legacy.stylePreset, defaults.stylePreset);
  assert.equal(legacy.tableDensity, defaults.tableDensity);
  assert.equal(legacy.tableHeaderShade, defaults.tableHeaderShade);
  assert.equal(legacy.rowShading, defaults.rowShading);
  assert.equal(legacy.tableLines, defaults.tableLines);
  assert.equal(legacy.sectionRule, defaults.sectionRule);

  const migratedBrand = reportFormat.normalizeReportFormatSettings({
    companyName: "Inventory Management",
  });
  assert.equal(migratedBrand.companyName, "LytGuide IMS");
});

test("invalid print-control options fall back independently to defaults", async () => {
  const reportFormat = await freshImport("../src/services/report-format.js");
  const defaults = reportFormat.DEFAULT_REPORT_FORMAT;
  const normalized = reportFormat.normalizeReportFormatSettings({
    stylePreset: "neon",
    tableDensity: "tiny",
    tableHeaderShade: "black",
    rowShading: "zebra-heavy",
    tableLines: "dotted",
    sectionRule: "rainbow",
  });

  assert.equal(normalized.stylePreset, defaults.stylePreset);
  assert.equal(normalized.tableDensity, defaults.tableDensity);
  assert.equal(normalized.tableHeaderShade, defaults.tableHeaderShade);
  assert.equal(normalized.rowShading, defaults.rowShading);
  assert.equal(normalized.tableLines, defaults.tableLines);
  assert.equal(normalized.sectionRule, defaults.sectionRule);
});

test("new print controls parse from forms, generate CSS variables, persist, and reset", async () => {
  const { db } = await createTestDatabase();
  const reportFormat = await freshImport("../src/services/report-format.js");
  const fromForm = reportFormat.reportFormatFromForm({
    company_name: "Field Warehouse",
    header_label: "Stock readiness",
    font_family: "arial",
    body_font_size: "15",
    heading_font_size: "30",
    subheading_font_size: "14",
    accent_color: "#123ABC",
    style_preset: "custom",
    table_density: "spacious",
    table_header_shade: "accent",
    row_shading: "subtle",
    table_lines: "minimal",
    section_rule: "accent",
  });

  assert.equal(fromForm.stylePreset, "custom");
  assert.equal(fromForm.tableDensity, "spacious");
  assert.equal(fromForm.tableHeaderShade, "accent");
  assert.equal(fromForm.rowShading, "subtle");
  assert.equal(fromForm.tableLines, "minimal");
  assert.equal(fromForm.sectionRule, "accent");

  const style = reportFormat.reportFormatStyle(fromForm);
  assert.match(style, /--report-style-preset: custom/);
  assert.match(style, /--report-body-line-height: 1\.5/);
  assert.match(style, /--report-table-density: spacious/);
  assert.match(style, /--report-table-cell-padding-y: 12px/);
  assert.match(style, /--report-table-cell-padding-x: 16px/);
  assert.match(style, /--report-table-header-shade: accent/);
  assert.match(
    style,
    /--report-table-header-background: color-mix\(in srgb, var\(--report-accent-color\) 12%, #ffffff\)/,
  );
  assert.match(style, /--report-row-shading: subtle/);
  assert.match(style, /--report-row-alt-background: #f8f9fa/);
  assert.match(style, /--report-table-lines: minimal/);
  assert.match(style, /--report-table-row-border-width: 0px/);
  assert.match(style, /--report-table-cell-border-width: 0px/);
  assert.match(style, /--report-table-border-color: #d7dde3/);
  assert.match(style, /--report-section-rule: accent/);
  assert.match(style, /--report-section-rule-color: var\(--report-accent-color\)/);
  assert.match(style, /--report-section-rule-width: 2px/);
  assert.match(style, /--report-accent-color: #123abc/);

  const saved = reportFormat.updateReportFormatSettings(db, fromForm);
  assert.deepEqual(reportFormat.getReportFormatSettings(db), saved);
  const raw = JSON.parse(
    db.prepare("SELECT value FROM app_metadata WHERE key = 'report_format_settings'").get().value,
  );
  assert.equal(raw.stylePreset, "custom");
  assert.equal(raw.tableDensity, "spacious");
  assert.equal(raw.tableHeaderShade, "accent");
  assert.equal(raw.rowShading, "subtle");
  assert.equal(raw.tableLines, "minimal");
  assert.equal(raw.sectionRule, "accent");

  const reset = reportFormat.resetReportFormatSettings(db);
  assert.deepEqual(reset, reportFormat.DEFAULT_REPORT_FORMAT);
  assert.deepEqual(reportFormat.getReportFormatSettings(db), reportFormat.DEFAULT_REPORT_FORMAT);
  db.close();
});

test("report format controls are admin-only and support a server-opened reports modal", async () => {
  const { db } = await createTestDatabase();
  const { createReportsPages } = await freshImport("../src/server/pages/reports.js");
  const { createAdminPages } = await freshImport("../src/server/pages/admin.js");
  const reportsPages = createReportsPages({ db });
  const admin = { id: 1, name: "Admin", username: "admin", role: "admin" };
  const operator = { id: 2, name: "Operator", username: "operator", role: "operator" };

  const defaultAdminHtml = reportsPages.renderReports(
    admin,
    null,
    new URL("http://localhost/reports"),
  );
  const defaultModalTag = defaultAdminHtml.match(
    /<div\s+[^>]*data-report-format-modal[^>]*>/,
  )?.[0];
  assert.match(defaultAdminHtml, /data-report-format-open/);
  assert.match(defaultAdminHtml, />Format Reports<\/button>/);
  assert.ok(defaultModalTag, "expected the reports page to render the format modal");
  assert.match(defaultModalTag, /id="report-format-modal"/);
  assert.match(defaultModalTag, /data-report-format-initial-open="false"/);
  assert.match(defaultModalTag, /\shidden(?:\s|>)/);

  const openAdminHtml = reportsPages.renderReports(
    admin,
    null,
    new URL("http://localhost/reports?format=1"),
  );
  const openModalTag = openAdminHtml.match(/<div\s+[^>]*data-report-format-modal[^>]*>/)?.[0];
  assert.ok(openModalTag, "expected the query parameter to retain the format modal");
  assert.match(openAdminHtml, /data-report-format-open[\s\S]*?aria-expanded="true"/);
  assert.match(openModalTag, /data-report-format-initial-open="true"/);
  assert.doesNotMatch(openModalTag, /\shidden(?:\s|>)/);

  const operatorHtml = reportsPages.renderReports(
    operator,
    null,
    new URL("http://localhost/reports?format=1"),
  );
  assert.doesNotMatch(operatorHtml, /data-report-format-open/);
  assert.doesNotMatch(operatorHtml, />Format Reports<\/button>/);
  assert.doesNotMatch(operatorHtml, /data-report-format-modal/);
  assert.doesNotMatch(operatorHtml, /data-report-format-editor/);

  const adminHtml = createAdminPages({ db }).renderAdmin(admin, null);
  assert.match(
    adminHtml,
    /<section class="report-format-panel report-format-panel-embedded app-panel"[^>]*data-report-format-editor[^>]*id="report-format"/,
  );
  assert.match(adminHtml, /<h2 id="report-format-section-title">Report Format<\/h2>/);
  assert.doesNotMatch(adminHtml, /data-report-format-modal/);

  db.close();
});
