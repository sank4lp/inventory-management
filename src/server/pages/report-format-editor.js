import * as reportFormatServices from "../../services/report-format.js";
import { escapeHtml } from "./shared.js";

const { REPORT_FONT_OPTIONS = [], reportFormatStyle } = reportFormatServices;

const PRESET_CHOICES = [
  ...(reportFormatServices.REPORT_FORMAT_PRESET_OPTIONS || [
    { value: "clean", label: "Clean", description: "Balanced spacing with a light, modern hierarchy." },
    { value: "compact", label: "Compact", description: "Fits longer stock lists onto fewer printed pages." },
    { value: "formal", label: "Formal", description: "Stronger rules and a traditional document structure." },
  ]),
  {
    value: "custom",
    label: "Custom",
    description: "Keeps your individually tuned typography and table choices.",
  },
];

const PRESET_SETTING_KEYS = [
  "fontFamily",
  "bodyFontSize",
  "headingFontSize",
  "subheadingFontSize",
  "accentColor",
  "tableDensity",
  "tableHeaderShade",
  "rowShading",
  "tableLines",
  "sectionRule",
];

function selectedOption(value, currentValue) {
  return value === currentValue ? "selected" : "";
}

function reportFormatOption(option, currentValue) {
  return `
    <option
      value="${escapeHtml(option.value)}"
      data-font-css="${escapeHtml(option.css)}"
      ${selectedOption(option.value, currentValue)}
    >${escapeHtml(option.label)}</option>
  `;
}

function presetSettings(value) {
  const presets = reportFormatServices.REPORT_FORMAT_PRESETS;
  const entry = Array.isArray(presets)
    ? presets.find((preset) => [preset?.value, preset?.key, preset?.id].includes(value))
    : presets?.[value];
  const source = entry?.settings || entry?.values || entry || {};

  return Object.fromEntries(
    PRESET_SETTING_KEYS
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function presetChoice(choice, currentValue) {
  const settings = choice.value === "custom" ? {} : presetSettings(choice.value);
  return `
    <label class="report-format-preset report-format-preset-${escapeHtml(choice.value)}">
      <input
        type="radio"
        name="_style_preset_choice"
        value="${escapeHtml(choice.value)}"
        data-report-format-preset-option
        data-report-format-preset-settings="${escapeHtml(JSON.stringify(settings))}"
        ${choice.value === currentValue ? "checked" : ""}
      />
      <span class="report-format-preset-visual" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>
      <span class="report-format-preset-copy">
        <strong>${escapeHtml(choice.label)}</strong>
        <small>${escapeHtml(choice.description)}</small>
      </span>
      <span class="report-format-preset-check" aria-hidden="true">✓</span>
    </label>
  `;
}

function selectControl({ label, name, field, value, options, hint = "" }) {
  return `
    <label class="report-format-control">
      <span>${escapeHtml(label)}</span>
      <select name="${escapeHtml(name)}" data-report-format-field="${escapeHtml(field)}">
        ${options
          .map(
            (option) => `
              <option value="${escapeHtml(option.value)}" ${selectedOption(option.value, value)}>
                ${escapeHtml(option.label)}
              </option>
            `,
          )
          .join("")}
      </select>
      ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
    </label>
  `;
}

function editorContents(reportFormat, returnTo) {
  const stylePreset = reportFormat.stylePreset || "clean";
  const tableDensity = reportFormat.tableDensity || "comfortable";
  const tableHeaderShade = reportFormat.tableHeaderShade || "soft";
  const rowShading = reportFormat.rowShading || "none";
  const tableLines = reportFormat.tableLines || "horizontal";
  const sectionRule = reportFormat.sectionRule || "accent";

  return `
    <div class="report-format-editor-grid">
      <form method="post" action="/reports/format" class="report-format-form" data-report-format-form>
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
        <input
          type="hidden"
          name="style_preset"
          value="${escapeHtml(stylePreset)}"
          data-report-format-field="stylePreset"
        />

        <fieldset class="report-format-group report-format-presets-group">
          <legend>Presets</legend>
          <p>Start with a print-ready style, then adjust any detail below.</p>
          <div class="report-format-preset-grid" role="radiogroup" aria-label="Report style preset">
            ${PRESET_CHOICES.map((choice) => presetChoice(choice, stylePreset)).join("")}
          </div>
        </fieldset>

        <fieldset class="report-format-group">
          <legend>Branding &amp; Typography</legend>
          <p>These details appear on every generated and printed report.</p>
          <div class="report-format-form-grid">
            <label class="report-format-control report-format-control-wide">
              <span>Company Name</span>
              <input
                name="company_name"
                value="${escapeHtml(reportFormat.companyName)}"
                maxlength="80"
                data-report-format-field="companyName"
              />
            </label>
            <label class="report-format-control report-format-control-wide">
              <span>Header Label</span>
              <input
                name="header_label"
                value="${escapeHtml(reportFormat.headerLabel)}"
                maxlength="48"
                data-report-format-field="headerLabel"
              />
            </label>
            <label class="report-format-control report-format-control-wide">
              <span>Font</span>
              <select name="font_family" data-report-format-field="fontFamily">
                ${REPORT_FONT_OPTIONS.map((option) => reportFormatOption(option, reportFormat.fontFamily)).join("")}
              </select>
            </label>
            <label class="report-format-control report-format-color-control">
              <span>Accent</span>
              <input
                type="color"
                name="accent_color"
                value="${escapeHtml(reportFormat.accentColor)}"
                data-report-format-field="accentColor"
              />
            </label>
            <label class="report-format-control">
              <span>Body Size</span>
              <span class="report-format-number-control">
                <input
                  type="number"
                  name="body_font_size"
                  value="${escapeHtml(reportFormat.bodyFontSize)}"
                  min="10"
                  max="18"
                  step="1"
                  data-report-format-field="bodyFontSize"
                />
                <small>px</small>
              </span>
            </label>
            <label class="report-format-control">
              <span>Heading Size</span>
              <span class="report-format-number-control">
                <input
                  type="number"
                  name="heading_font_size"
                  value="${escapeHtml(reportFormat.headingFontSize)}"
                  min="18"
                  max="34"
                  step="1"
                  data-report-format-field="headingFontSize"
                />
                <small>px</small>
              </span>
            </label>
            <label class="report-format-control">
              <span>Subheading Size</span>
              <span class="report-format-number-control">
                <input
                  type="number"
                  name="subheading_font_size"
                  value="${escapeHtml(reportFormat.subheadingFontSize)}"
                  min="10"
                  max="18"
                  step="1"
                  data-report-format-field="subheadingFontSize"
                />
                <small>px</small>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset class="report-format-group">
          <legend>Table &amp; Lines</legend>
          <p>Control information density and how strongly rows and sections are separated.</p>
          <div class="report-format-form-grid">
            ${selectControl({
              label: "Table Density",
              name: "table_density",
              field: "tableDensity",
              value: tableDensity,
              options: [
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
                { value: "spacious", label: "Spacious" },
              ],
            })}
            ${selectControl({
              label: "Header Shade",
              name: "table_header_shade",
              field: "tableHeaderShade",
              value: tableHeaderShade,
              options: [
                { value: "white", label: "White" },
                { value: "soft", label: "Soft Gray" },
                { value: "accent", label: "Accent Tint" },
              ],
            })}
            ${selectControl({
              label: "Row Shading",
              name: "row_shading",
              field: "rowShading",
              value: rowShading,
              options: [
                { value: "none", label: "None" },
                { value: "subtle", label: "Alternating Subtle" },
              ],
            })}
            ${selectControl({
              label: "Table Lines",
              name: "table_lines",
              field: "tableLines",
              value: tableLines,
              options: [
                { value: "grid", label: "Full Grid" },
                { value: "horizontal", label: "Horizontal Only" },
                { value: "minimal", label: "Minimal" },
              ],
            })}
            ${selectControl({
              label: "Section Rule",
              name: "section_rule",
              field: "sectionRule",
              value: sectionRule,
              options: [
                { value: "neutral", label: "Neutral" },
                { value: "accent", label: "Accent" },
                { value: "light", label: "Light" },
              ],
            })}
          </div>
        </fieldset>

        <div class="report-format-actions">
          <button type="submit" class="blue-button">Save Report Format</button>
          <button
            type="submit"
            formaction="/reports/format/reset"
            formnovalidate
            class="ghost-button"
            onclick="return confirm('Restore the default report format? Your current formatting choices will be replaced.')"
          >Restore Defaults</button>
          <span class="report-format-save-note">Applies to all on-screen reports and printed copies.</span>
        </div>
      </form>

      <aside class="report-format-preview-shell" aria-label="Live report format preview">
        <div class="report-format-preview-toolbar">
          <span>
            <strong>Live Preview</strong>
            <small>Changes appear before you save</small>
          </span>
          <span class="report-format-paper-label">A4 · print safe</span>
        </div>
        <div class="report-format-paper-stage">
          <article
            class="report-document report-format-preview"
            data-report-format-preview
            data-report-style-preset="${escapeHtml(stylePreset)}"
            data-report-table-density="${escapeHtml(tableDensity)}"
            data-report-table-header-shade="${escapeHtml(tableHeaderShade)}"
            data-report-row-shading="${escapeHtml(rowShading)}"
            data-report-table-lines="${escapeHtml(tableLines)}"
            data-report-section-rule="${escapeHtml(sectionRule)}"
            style="${escapeHtml(reportFormatStyle(reportFormat))}"
          >
            <header class="report-document-header">
              <div class="report-document-title-block">
                <p class="report-document-company" data-report-format-preview-company>${escapeHtml(reportFormat.companyName)}</p>
                <p class="report-document-kicker" data-report-format-preview-label>${escapeHtml(reportFormat.headerLabel)}</p>
                <h3>Stock Snapshot</h3>
                <p class="report-document-subheading">A clear view of current inventory across the warehouse.</p>
              </div>
              <dl class="report-document-meta">
                <div><dt>Timeframe</dt><dd>Current</dd></div>
                <div><dt>Generated</dt><dd>Today</dd></div>
              </dl>
            </header>

            <section class="report-kpi-grid report-format-preview-kpis" aria-label="Summary values">
              <div class="report-kpi"><span>Products</span><strong>184</strong><small>12 categories</small></div>
              <div class="report-kpi"><span>Most Stocked</span><strong>Basmati Rice</strong><small>1,240 kg</small></div>
              <div class="report-kpi"><span>Low Stock</span><strong>7</strong><small>Needs attention</small></div>
            </section>

            <figure class="report-chart report-format-preview-chart">
              <figcaption>
                <h4>Top Picked Products</h4>
                <p>Picked quantity in the selected period</p>
              </figcaption>
              <div class="report-format-mini-bars" aria-hidden="true">
                <span style="--preview-value: 86%"><i>Basmati Rice</i><b>860 kg</b></span>
                <span style="--preview-value: 64%"><i>Brown Rice</i><b>640 kg</b></span>
                <span style="--preview-value: 42%"><i>Rice Flour</i><b>420 kg</b></span>
              </div>
            </figure>

            <section class="report-document-section">
              <h4>Inventory Detail</h4>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>Category</th><th>Available</th></tr></thead>
                  <tbody>
                    <tr><td>Basmati Rice</td><td>Rice</td><td>1,240 kg</td></tr>
                    <tr><td>Brown Rice</td><td>Rice</td><td>880 kg</td></tr>
                    <tr><td>Rice Flour</td><td>Flour</td><td>460 kg</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          </article>
        </div>
      </aside>
    </div>
  `;
}

export function renderReportFormatEditor(
  reportFormat,
  {
    user,
    returnTo = "/reports?format=1",
    mode = "section",
    open = false,
    attributes = "",
  } = {},
) {
  if (user?.role !== "admin") {
    return "";
  }

  const modal = mode === "modal";
  const titleId = modal ? "report-format-modal-title" : "report-format-section-title";
  const heading = `
    <div class="report-format-heading-copy">
      <p class="report-eyebrow">Report Format</p>
      <h2 id="${titleId}">${modal ? "Format Every Report" : "Report Format"}</h2>
      <p>Set one consistent, low-ink document style for on-screen reports and printing.</p>
    </div>
  `;
  const contents = editorContents(reportFormat, returnTo);

  if (modal) {
    return `
      <div
        class="modal-backdrop report-format-modal"
        data-report-format-editor
        data-report-format-modal
        data-report-format-initial-open="${open ? "true" : "false"}"
        ${open ? "" : "hidden"}
        ${attributes}
      >
        <section
          class="modal-panel report-format-modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="${titleId}"
          tabindex="-1"
        >
          <header class="report-format-modal-header">
            ${heading}
            <button type="button" class="icon-button ghost-button" data-report-format-close aria-label="Close report format editor" title="Close">×</button>
          </header>
          ${contents}
        </section>
      </div>
    `;
  }

  return `
    <section class="report-format-panel report-format-panel-embedded app-panel" data-report-format-editor ${attributes}>
      <header class="report-format-embedded-header">${heading}</header>
      ${contents}
    </section>
  `;
}
