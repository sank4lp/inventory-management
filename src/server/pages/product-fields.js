import { createProductFieldService } from "../../services/product-fields.js";
import { createUnitConversionService } from "../../services/unit-conversions.js";
import { card, escapeHtml, formatDate, formatQuantity, page, statusBadge, table } from "./shared.js";

function checked(value) {
  return Number(value) === 1 ? "checked" : "";
}

function fieldTypeLabel(type) {
  return {
    text: "Text",
    number: "Number",
    date: "Date",
    boolean: "Yes / No",
    select: "Selection list",
  }[type] || type;
}

function fieldEditor(field) {
  const protectedField = field.field_kind === "core" && [
    "identifier",
    "display_name",
    "unit_of_measure",
    "location_capacity",
  ].includes(field.system_role);
  const reportRequiredField = field.field_kind === "core" && [
    "identifier",
    "display_name",
    "unit_of_measure",
  ].includes(field.system_role);

  return `
    <article class="product-field-definition ${field.active ? "" : "product-field-definition-disabled"}">
      <div class="product-field-definition-heading">
        <div>
          <span class="report-eyebrow">${escapeHtml(field.field_kind === "core" ? "System field" : "Custom field")}</span>
          <h3>${escapeHtml(field.label)}</h3>
          <code>${escapeHtml(field.field_key)}</code>
        </div>
        <div class="mini-actions">
          ${statusBadge(field.active ? "active" : "inactive")}
          <span class="badge">${escapeHtml(fieldTypeLabel(field.data_type))}</span>
        </div>
      </div>
      <form method="post" action="/admin/product-fields/${escapeHtml(field.id)}" class="stack-form product-field-definition-form">
        <div class="form-grid">
          <label>Display Label
            <input name="label" value="${escapeHtml(field.label)}" maxlength="80" required />
          </label>
          <label>Display Order
            <input type="number" name="sort_order" value="${escapeHtml(field.sort_order)}" step="1" />
          </label>
        </div>
        <div class="product-field-flags">
          <label class="checkbox-line"><input type="checkbox" name="visible" value="1" ${checked(field.visible)} /> Show on product screens</label>
          <label class="checkbox-line"><input type="checkbox" name="searchable" value="1" ${checked(field.searchable)} /> Include in product search</label>
          <label class="checkbox-line"><input type="checkbox" name="filterable" value="1" ${checked(field.filterable)} /> Allow as a report filter</label>
          <label class="checkbox-line"><input type="checkbox" name="reportable" value="1" ${checked(field.reportable)} ${reportRequiredField ? "disabled" : ""} /> Available for reports</label>
          <label class="checkbox-line"><input type="checkbox" name="required" value="1" ${checked(field.required)} ${protectedField ? "disabled" : ""} /> Required product value</label>
          <label class="checkbox-line"><input type="checkbox" name="active" value="1" ${checked(field.active)} ${protectedField ? "disabled" : ""} /> Field enabled</label>
        </div>
        ${protectedField ? `<input type="hidden" name="required" value="1" /><input type="hidden" name="active" value="1" />${reportRequiredField ? `<input type="hidden" name="reportable" value="1" />` : ""}<p class="muted">This field supports an operational workflow. You can rename or hide it, but disabling it${reportRequiredField ? " or removing it from reports" : ""} requires a compatible replacement migration.</p>` : ""}
        ${field.data_type === "select" ? `<label>Selection Options<textarea name="options" rows="3">${escapeHtml((field.options || []).join("\n"))}</textarea></label>` : ""}
        <div class="form-actions">
          <button type="submit" class="blue-button">Save Field</button>
        </div>
      </form>
    </article>
  `;
}

function unitConversionPreview(preview) {
  if (!preview) {
    return "";
  }
  return `
    <section class="unit-conversion-preview" aria-labelledby="unit-conversion-preview-title">
      <div>
        <p class="report-eyebrow">Migration Preview</p>
        <h3 id="unit-conversion-preview-title">${escapeHtml(preview.product.sku)} · ${escapeHtml(preview.explanation)}</h3>
        <p>No inventory has been changed yet. Review the converted values before applying.</p>
      </div>
      <div class="report-kpi-grid">
        <article class="report-kpi"><span>Available</span><strong>${escapeHtml(formatQuantity(preview.before.available))} ${escapeHtml(preview.sourceUnit)}</strong><small>${escapeHtml(formatQuantity(preview.after.available))} ${escapeHtml(preview.targetUnit)}</small></article>
        <article class="report-kpi"><span>Reserved</span><strong>${escapeHtml(formatQuantity(preview.before.reserved))} ${escapeHtml(preview.sourceUnit)}</strong><small>${escapeHtml(formatQuantity(preview.after.reserved))} ${escapeHtml(preview.targetUnit)}</small></article>
        <article class="report-kpi"><span>Items Per Location</span><strong>${escapeHtml(formatQuantity(preview.before.itemsPerLocation))} ${escapeHtml(preview.sourceUnit)}</strong><small>${escapeHtml(formatQuantity(preview.after.itemsPerLocation))} ${escapeHtml(preview.targetUnit)}</small></article>
        <article class="report-kpi"><span>Open Task Lines</span><strong>${escapeHtml(formatQuantity(preview.before.openTaskLines))}</strong><small>Converted atomically</small></article>
      </div>
      <p class="muted">${escapeHtml(formatQuantity(preview.history.taskLineCount))} completed/cancelled task line(s) and ${escapeHtml(formatQuantity(preview.history.transactionCount))} transaction(s) retain their original recorded unit. Reports can distinguish those historical units.</p>
      <form method="post" action="/admin/product-unit-conversions/apply" class="stack-form">
        <input type="hidden" name="product_id" value="${escapeHtml(preview.product.id)}" />
        <input type="hidden" name="target_unit" value="${escapeHtml(preview.targetUnit)}" />
        <input type="hidden" name="factor" value="${escapeHtml(preview.factor)}" />
        <input type="hidden" name="precision" value="${escapeHtml(preview.precision)}" />
        <input type="hidden" name="preview_token" value="${escapeHtml(preview.token)}" />
        <label class="checkbox-line"><input type="checkbox" name="confirmed" value="1" required /> I reviewed the conversion and understand that current stock, capacity, reservations, and open tasks will change units.</label>
        <button type="submit" class="blue-button">Apply Unit Migration</button>
      </form>
    </section>
  `;
}

export function createProductFieldPages({
  db,
  productFieldService = null,
  unitConversionService = null,
}) {
  const fields = productFieldService || createProductFieldService({ db });
  const unitConversions = unitConversionService || createUnitConversionService({ db });

  function renderProductFields(user, flash, conversionPreview = null) {
    const definitions = fields.list({ includeInactive: true });
    const products = db
      .prepare("SELECT id, sku, name, unit_of_measure FROM products WHERE active = 1 ORDER BY name")
      .all();
    const conversionHistory = unitConversions.list();
    return page({
      title: "Admin Product Fields",
      user,
      flash,
      content: `
        <section class="product-field-workspace">
          ${card(
            "Product Field Registry",
            `
              <p>Rename the terminology shown throughout the product catalog and reports, or add structured product properties. Stable internal field IDs let labels change without changing stored product data.</p>
              <details class="form-disclosure" ${definitions.length ? "" : "open"}>
                <summary>Add A Custom Product Field</summary>
                <form method="post" action="/admin/product-fields" class="stack-form product-field-create-form">
                  <div class="form-grid">
                    <label>Field Label<input name="label" maxlength="80" required placeholder="Rice grade" /></label>
                    <label>Data Type
                      <select name="data_type">
                        <option value="text">Text</option>
                        <option value="number">Number</option>
                        <option value="date">Date</option>
                        <option value="boolean">Yes / No</option>
                        <option value="select">Selection list</option>
                      </select>
                    </label>
                    <label>Display Order<input type="number" name="sort_order" value="100" step="1" /></label>
                  </div>
                  <label>Selection Options <small>Only used for a selection-list field; enter one option per line.</small>
                    <textarea name="options" rows="4" placeholder="Grade A\nGrade B"></textarea>
                  </label>
                  <div class="product-field-flags">
                    <label class="checkbox-line"><input type="checkbox" name="visible" value="1" checked /> Show on product screens</label>
                    <label class="checkbox-line"><input type="checkbox" name="searchable" value="1" /> Include in product search</label>
                    <label class="checkbox-line"><input type="checkbox" name="filterable" value="1" checked /> Allow as a report filter</label>
                    <label class="checkbox-line"><input type="checkbox" name="reportable" value="1" checked /> Available for reports</label>
                  </div>
                  <button type="submit" class="blue-button">Add Field</button>
                </form>
              </details>
            `,
          )}
          ${card(
            "Unit Migration",
            `
              <div id="unit-migration" class="section-anchor" aria-hidden="true"></div>
              <p>Convert one product from its current unit into a compatible target unit. The factor is product-specific—for example, one rice sack may equal 25 kg.</p>
              <form method="post" action="/admin/product-unit-conversions/preview" class="stack-form unit-conversion-form">
                <div class="form-grid">
                  <label>Product
                    <select name="product_id" required>
                      <option value="">Choose a product</option>
                      ${products
                        .map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.sku)} · ${escapeHtml(product.name)} (${escapeHtml(product.unit_of_measure)})</option>`)
                        .join("")}
                    </select>
                  </label>
                  <label>Target Unit<input name="target_unit" maxlength="48" required placeholder="kg" /></label>
                  <label>Conversion Factor<input type="number" name="factor" min="0.00000001" step="any" required placeholder="25" /></label>
                  <label>Decimal Precision<input type="number" name="precision" min="0" max="8" step="1" value="3" required /></label>
                </div>
                <p class="muted">The factor means: 1 current unit equals this many target units. Previewing is read-only.</p>
                <button type="submit" class="ghost-button">Preview Migration</button>
              </form>
              ${unitConversionPreview(conversionPreview)}
              ${
                conversionHistory.length
                  ? `<details class="form-disclosure"><summary>Previous Unit Migrations</summary>${table(
                      ["When", "Product", "Conversion", "Admin"],
                      conversionHistory.map((entry) => [
                        escapeHtml(formatDate(entry.created_at)),
                        `${escapeHtml(entry.name)}<br /><small>${escapeHtml(entry.sku)}</small>`,
                        `1 ${escapeHtml(entry.from_unit)} = ${escapeHtml(formatQuantity(entry.factor))} ${escapeHtml(entry.to_unit)}`,
                        escapeHtml(entry.created_by_username),
                      ]),
                    )}</details>`
                  : ""
              }
            `,
          )}
          <section class="product-field-definition-list" aria-label="Configured product fields">
            ${definitions.map(fieldEditor).join("")}
          </section>
        </section>
      `,
    });
  }

  return { renderProductFields };
}
