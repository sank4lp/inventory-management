const REPORT_FORMAT_METADATA_KEY = "report_format_settings";
const APP_BRAND_NAME = "LytGuide IMS";
const LEGACY_DEFAULT_COMPANY_NAME = "Inventory Management";

export const REPORT_FONT_OPTIONS = [
  {
    value: "system",
    label: "System Sans",
    css: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  },
  {
    value: "arial",
    label: "Arial",
    css: "Arial, Helvetica, sans-serif",
  },
  {
    value: "georgia",
    label: "Georgia",
    css: "Georgia, Times New Roman, serif",
  },
  {
    value: "verdana",
    label: "Verdana",
    css: "Verdana, Geneva, sans-serif",
  },
];

export const REPORT_FORMAT_PRESETS = Object.freeze({
  clean: Object.freeze({
    label: "Clean",
    description: "Balanced spacing with light table structure and a restrained accent.",
    values: Object.freeze({
      stylePreset: "clean",
      fontFamily: "system",
      bodyFontSize: 13,
      headingFontSize: 24,
      subheadingFontSize: 13,
      tableDensity: "comfortable",
      tableHeaderShade: "soft",
      rowShading: "none",
      tableLines: "horizontal",
      sectionRule: "accent",
    }),
  }),
  compact: Object.freeze({
    label: "Compact",
    description: "Smaller type and tighter tables for data-heavy printed reports.",
    values: Object.freeze({
      stylePreset: "compact",
      fontFamily: "system",
      bodyFontSize: 11,
      headingFontSize: 21,
      subheadingFontSize: 11,
      tableDensity: "compact",
      tableHeaderShade: "white",
      rowShading: "subtle",
      tableLines: "horizontal",
      sectionRule: "neutral",
    }),
  }),
  formal: Object.freeze({
    label: "Formal",
    description: "A serif-led document style with spacious, clearly ruled tables.",
    values: Object.freeze({
      stylePreset: "formal",
      fontFamily: "georgia",
      bodyFontSize: 13,
      headingFontSize: 26,
      subheadingFontSize: 12,
      tableDensity: "spacious",
      tableHeaderShade: "soft",
      rowShading: "none",
      tableLines: "grid",
      sectionRule: "neutral",
    }),
  }),
});

export const REPORT_FORMAT_PRESET_OPTIONS = Object.freeze(
  Object.entries(REPORT_FORMAT_PRESETS).map(([value, preset]) =>
    Object.freeze({
      value,
      label: preset.label,
      description: preset.description,
    }),
  ),
);

const STYLE_PRESET_VALUES = new Set(["clean", "compact", "formal", "custom"]);
const TABLE_DENSITY_VALUES = new Set(["compact", "comfortable", "spacious"]);
const TABLE_HEADER_SHADE_VALUES = new Set(["white", "soft", "accent"]);
const ROW_SHADING_VALUES = new Set(["none", "subtle"]);
const TABLE_LINES_VALUES = new Set(["grid", "horizontal", "minimal"]);
const SECTION_RULE_VALUES = new Set(["neutral", "accent", "light"]);

export const DEFAULT_REPORT_FORMAT = Object.freeze({
  companyName: APP_BRAND_NAME,
  headerLabel: "Inventory report",
  stylePreset: "clean",
  fontFamily: "system",
  bodyFontSize: 13,
  headingFontSize: 24,
  subheadingFontSize: 13,
  accentColor: "#3158e8",
  tableDensity: "comfortable",
  tableHeaderShade: "soft",
  rowShading: "none",
  tableLines: "horizontal",
  sectionRule: "accent",
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, fallback, maxLength) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return fallback;
  }
  return text.slice(0, maxLength);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeColor(value, fallback) {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

function normalizeFontFamily(value, fallback) {
  const text = String(value || "").trim();
  return REPORT_FONT_OPTIONS.some((option) => option.value === text) ? text : fallback;
}

function normalizeChoice(value, allowedValues, fallback) {
  const text = String(value || "").trim();
  return allowedValues.has(text) ? text : fallback;
}

function parseSettings(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeReportFormatSettings(input = {}) {
  const companyName = normalizeText(input.companyName, DEFAULT_REPORT_FORMAT.companyName, 80);
  const stylePreset = normalizeChoice(
    input.stylePreset,
    STYLE_PRESET_VALUES,
    DEFAULT_REPORT_FORMAT.stylePreset,
  );
  const presetValues =
    REPORT_FORMAT_PRESETS[stylePreset]?.values || REPORT_FORMAT_PRESETS.clean.values;
  return {
    companyName: companyName === LEGACY_DEFAULT_COMPANY_NAME ? DEFAULT_REPORT_FORMAT.companyName : companyName,
    headerLabel: normalizeText(input.headerLabel, DEFAULT_REPORT_FORMAT.headerLabel, 48),
    stylePreset,
    fontFamily: normalizeFontFamily(input.fontFamily, presetValues.fontFamily),
    bodyFontSize: clampInteger(
      input.bodyFontSize,
      presetValues.bodyFontSize,
      10,
      18,
    ),
    headingFontSize: clampInteger(
      input.headingFontSize,
      presetValues.headingFontSize,
      18,
      34,
    ),
    subheadingFontSize: clampInteger(
      input.subheadingFontSize,
      presetValues.subheadingFontSize,
      10,
      18,
    ),
    accentColor: normalizeColor(input.accentColor, DEFAULT_REPORT_FORMAT.accentColor),
    tableDensity: normalizeChoice(
      input.tableDensity,
      TABLE_DENSITY_VALUES,
      presetValues.tableDensity,
    ),
    tableHeaderShade: normalizeChoice(
      input.tableHeaderShade,
      TABLE_HEADER_SHADE_VALUES,
      presetValues.tableHeaderShade,
    ),
    rowShading: normalizeChoice(
      input.rowShading,
      ROW_SHADING_VALUES,
      presetValues.rowShading,
    ),
    tableLines: normalizeChoice(
      input.tableLines,
      TABLE_LINES_VALUES,
      presetValues.tableLines,
    ),
    sectionRule: normalizeChoice(
      input.sectionRule,
      SECTION_RULE_VALUES,
      presetValues.sectionRule,
    ),
  };
}

export function reportFormatFromForm(form = {}) {
  return normalizeReportFormatSettings({
    companyName: form.company_name,
    headerLabel: form.header_label,
    stylePreset: form.style_preset,
    fontFamily: form.font_family,
    bodyFontSize: Number(form.body_font_size),
    headingFontSize: Number(form.heading_font_size),
    subheadingFontSize: Number(form.subheading_font_size),
    accentColor: form.accent_color,
    tableDensity: form.table_density,
    tableHeaderShade: form.table_header_shade,
    rowShading: form.row_shading,
    tableLines: form.table_lines,
    sectionRule: form.section_rule,
  });
}

export function getReportFormatSettings(db) {
  const row = db
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get(REPORT_FORMAT_METADATA_KEY);
  return normalizeReportFormatSettings(parseSettings(row?.value) || DEFAULT_REPORT_FORMAT);
}

export function updateReportFormatSettings(db, input) {
  const settings = normalizeReportFormatSettings(input);
  db.prepare(
    `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(REPORT_FORMAT_METADATA_KEY, JSON.stringify(settings), nowIso());
  return settings;
}

export function resetReportFormatSettings(db) {
  return updateReportFormatSettings(db, DEFAULT_REPORT_FORMAT);
}

export function reportFontCss(fontFamily) {
  return (
    REPORT_FONT_OPTIONS.find((option) => option.value === fontFamily)?.css ||
    REPORT_FONT_OPTIONS[0].css
  );
}

export function reportFormatStyle(settings = DEFAULT_REPORT_FORMAT) {
  const format = normalizeReportFormatSettings(settings);
  const densityTokens = {
    compact: { paddingY: "5px", paddingX: "8px" },
    comfortable: { paddingY: "8px", paddingX: "12px" },
    spacious: { paddingY: "12px", paddingX: "16px" },
  }[format.tableDensity];
  const headerBackground = {
    white: "#ffffff",
    soft: "#f2f4f6",
    accent: "color-mix(in srgb, var(--report-accent-color) 12%, #ffffff)",
  }[format.tableHeaderShade];
  const rowBackground = format.rowShading === "subtle" ? "#f8f9fa" : "#ffffff";
  const lineTokens = {
    grid: { rowWidth: "1px", cellWidth: "1px" },
    horizontal: { rowWidth: "1px", cellWidth: "0px" },
    minimal: { rowWidth: "0px", cellWidth: "0px" },
  }[format.tableLines];
  const sectionRuleTokens = {
    neutral: { color: "#bcc5ce", width: "1px" },
    accent: { color: "var(--report-accent-color)", width: "2px" },
    light: { color: "#e5e7eb", width: "1px" },
  }[format.sectionRule];
  const bodyLineHeight = {
    clean: "1.5",
    compact: "1.35",
    formal: "1.55",
    custom: "1.5",
  }[format.stylePreset];
  return [
    `--report-style-preset: ${format.stylePreset}`,
    `--report-font-family: ${reportFontCss(format.fontFamily)}`,
    `--report-body-size: ${format.bodyFontSize}px`,
    `--report-body-line-height: ${bodyLineHeight}`,
    `--report-heading-size: ${format.headingFontSize}px`,
    `--report-subheading-size: ${format.subheadingFontSize}px`,
    `--report-accent-color: ${format.accentColor}`,
    `--report-table-density: ${format.tableDensity}`,
    `--report-table-cell-padding-y: ${densityTokens.paddingY}`,
    `--report-table-cell-padding-x: ${densityTokens.paddingX}`,
    `--report-table-header-shade: ${format.tableHeaderShade}`,
    `--report-table-header-background: ${headerBackground}`,
    `--report-row-shading: ${format.rowShading}`,
    `--report-row-alt-background: ${rowBackground}`,
    `--report-table-lines: ${format.tableLines}`,
    `--report-table-row-border-width: ${lineTokens.rowWidth}`,
    `--report-table-cell-border-width: ${lineTokens.cellWidth}`,
    "--report-table-border-color: #d7dde3",
    `--report-section-rule: ${format.sectionRule}`,
    `--report-section-rule-color: ${sectionRuleTokens.color}`,
    `--report-section-rule-width: ${sectionRuleTokens.width}`,
  ].join("; ");
}
