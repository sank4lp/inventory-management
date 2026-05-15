const REPORT_FORMAT_METADATA_KEY = "report_format_settings";

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

export const DEFAULT_REPORT_FORMAT = Object.freeze({
  companyName: "Inventory Management",
  headerLabel: "Inventory report",
  fontFamily: "system",
  bodyFontSize: 13,
  headingFontSize: 24,
  subheadingFontSize: 13,
  accentColor: "#3158e8",
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
  return {
    companyName: normalizeText(input.companyName, DEFAULT_REPORT_FORMAT.companyName, 80),
    headerLabel: normalizeText(input.headerLabel, DEFAULT_REPORT_FORMAT.headerLabel, 48),
    fontFamily: normalizeFontFamily(input.fontFamily, DEFAULT_REPORT_FORMAT.fontFamily),
    bodyFontSize: clampInteger(
      input.bodyFontSize,
      DEFAULT_REPORT_FORMAT.bodyFontSize,
      10,
      18,
    ),
    headingFontSize: clampInteger(
      input.headingFontSize,
      DEFAULT_REPORT_FORMAT.headingFontSize,
      18,
      34,
    ),
    subheadingFontSize: clampInteger(
      input.subheadingFontSize,
      DEFAULT_REPORT_FORMAT.subheadingFontSize,
      10,
      18,
    ),
    accentColor: normalizeColor(input.accentColor, DEFAULT_REPORT_FORMAT.accentColor),
  };
}

export function reportFormatFromForm(form = {}) {
  return normalizeReportFormatSettings({
    companyName: form.company_name,
    headerLabel: form.header_label,
    fontFamily: form.font_family,
    bodyFontSize: Number(form.body_font_size),
    headingFontSize: Number(form.heading_font_size),
    subheadingFontSize: Number(form.subheading_font_size),
    accentColor: form.accent_color,
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
  return [
    `--report-font-family: ${reportFontCss(format.fontFamily)}`,
    `--report-body-size: ${format.bodyFontSize}px`,
    `--report-heading-size: ${format.headingFontSize}px`,
    `--report-subheading-size: ${format.subheadingFontSize}px`,
    `--report-accent-color: ${format.accentColor}`,
  ].join("; ");
}
