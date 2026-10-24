import {templatePage, uiPanel, uiTable, uiDisclosure, uiDialog, uiDialogButton} from "../ui.js";
import { createProductFieldService } from "../../services/product-fields.js";
import { createUnitConversionService } from "../../services/unit-conversions.js";
import { escapeHtml, formatDate, formatQuantity, statusBadge } from "./shared.js";

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
  const protectedField=field.field_kind==='core'&&['identifier','display_name','unit_of_measure','location_capacity'].includes(field.system_role);
  const reportRequired=field.field_kind==='core'&&['identifier','display_name','unit_of_measure'].includes(field.system_role);
  const id='product-field-'+field.id;
  const flags=[['visible','Show on product screens',false],['searchable','Include in product search',false],['filterable','Allow as a report filter',false],['reportable','Available for reports',reportRequired],['required','Required product value',protectedField],['active','Field enabled',protectedField]];
  return [
    `<strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.field_kind==='core'?'System field':'Custom field')} · ${escapeHtml(fieldTypeLabel(field.data_type))}</small><small>${escapeHtml(field.field_key)}</small>${statusBadge(field.active?'active':'inactive')}`,
    `<form id="${id}" method="post" action="/admin/product-fields/${escapeHtml(field.id)}" class="ui-field-form"><label>Display label<input name="label" value="${escapeHtml(field.label)}" maxlength="80" required></label><label>Display order<input type="number" name="sort_order" value="${escapeHtml(field.sort_order)}" step="1"></label>${protectedField?'<input type="hidden" name="required" value="1"><input type="hidden" name="active" value="1">':''}${reportRequired?'<input type="hidden" name="reportable" value="1">':''}${field.data_type==='select'?`<label>Selection options<textarea name="options" rows="3">${escapeHtml((field.options||[]).join('\n'))}</textarea></label>`:''}</form>`,
    `<div class="ui-field-flags">${flags.map(([name,label,disabled])=>`<label class="ui-check"><input form="${id}" type="checkbox" name="${name}" value="1" ${checked(field[name])} ${disabled?'disabled':''}>${label}</label>`).join('')}</div>${protectedField?'<p class="ui-field-note">Required for warehouse work. Its label and visibility can still change.</p>':''}`,
    `<button type="submit" form="${id}">Save Field</button>`,
  ];
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
      ${uiTable([{key:'field',label:'Quantity'},{key:'before',label:'Before'},{key:'after',label:'After'}],[
        ['Available',`${escapeHtml(formatQuantity(preview.before.available))} ${escapeHtml(preview.sourceUnit)}`,`${escapeHtml(formatQuantity(preview.after.available))} ${escapeHtml(preview.targetUnit)}`],
        ['Reserved',`${escapeHtml(formatQuantity(preview.before.reserved))} ${escapeHtml(preview.sourceUnit)}`,`${escapeHtml(formatQuantity(preview.after.reserved))} ${escapeHtml(preview.targetUnit)}`],
        ['Items Per Location',`${escapeHtml(formatQuantity(preview.before.itemsPerLocation))} ${escapeHtml(preview.sourceUnit)}`,`${escapeHtml(formatQuantity(preview.after.itemsPerLocation))} ${escapeHtml(preview.targetUnit)}`],
        ['Open Task Lines',escapeHtml(formatQuantity(preview.before.openTaskLines)),'Converted atomically'],
      ],{label:'Unit conversion preview'})}
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
    const createForm = `<form method="post" action="/admin/product-fields" class="ui-form product-field-create-form">
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
                  <div class="ui-field-flags">
                    <label class="ui-check"><input type="checkbox" name="visible" value="1" checked /> Show on product screens</label>
                    <label class="ui-check"><input type="checkbox" name="searchable" value="1" /> Include in product search</label>
                    <label class="ui-check"><input type="checkbox" name="filterable" value="1" checked /> Allow as a report filter</label>
                    <label class="ui-check"><input type="checkbox" name="reportable" value="1" checked /> Available for reports</label>
                  </div>
                  <button type="submit" class="blue-button">Add Field</button>
                </form>`;
    const migrationForm = `<form method="post" action="/admin/product-unit-conversions/preview" class="stack-form unit-conversion-form">
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
              </form>`;
    const history=conversionHistory.length ? uiDisclosure('Previous Unit Migrations',uiTable([{key:'date',label:'When'},{key:'product',label:'Product'},{key:'detail',label:'Conversion'},{key:'person',label:'Admin'}],conversionHistory.map(entry=>[escapeHtml(formatDate(entry.created_at)),`${escapeHtml(entry.name)}<small>${escapeHtml(entry.sku)}</small>`,`1 ${escapeHtml(entry.from_unit)} = ${escapeHtml(formatQuantity(entry.factor))} ${escapeHtml(entry.to_unit)}`,escapeHtml(entry.created_by_username)]),{label:'Previous unit migrations'})) : '';
    return templatePage({title:'Product Fields & Units',user,flash,content:`<div class="ui-settings-page">
      <nav class="ui-toolbar"><a href="/settings">← Settings</a></nav>
      ${uiPanel('Product fields', uiTable([{key:'field',label:'Field'},{key:'edit',label:'Label & order'},{key:'behavior',label:'Where it is used'},{key:'action',label:'Action'}],definitions.map(fieldEditor),{label:'Configured product fields'}),{actions:uiDialogButton('add-product-field','Add Field',{secondary:false})})}
      ${uiDialog('add-product-field','Add a product field',createForm)}
      ${uiDisclosure('Unit Migration',`<p>Convert a product to a compatible unit. Preview the values before applying.</p>${migrationForm}${unitConversionPreview(conversionPreview)}${history}`,{id:'unit-migration',open:Boolean(conversionPreview)})}
      ${uiDisclosure('Help', '<p>Rename fields without changing stored product data. Use the checkboxes to choose where each field appears.</p><p>The conversion factor means one current unit equals that many target units. Historical movements keep their original units.</p>')}
    </div>`});
  }

  return { renderProductFields };
}
