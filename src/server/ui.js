import {page, escapeHtml} from '../render.js';

// Opt-in presentation. Other product pages keep their current markup and styles
// until they are deliberately migrated to this component set.
export function templatePage({content, ...options}) {
  return page({...options, content: `<link rel="stylesheet" href="/ui-template.css"><div class="ui-template" data-mobile-table="scroll">${content}</div><script type="module" src="/client/ui-template.js"></script>`});
}

export function uiPanel(title, content, {actions = '', id = ''} = {}) {
  return `<section class="ui-panel"${id ? ` id="${escapeHtml(id)}"` : ''}>
    <header class="ui-panel-heading"><h2>${escapeHtml(title)}</h2>${actions}</header>${content}</section>`;
}

// Columns and cell contents stay in the same order on every device. The first
// column remains visible while the remaining information scrolls on a phone.
export function uiTable(columns, rows, {label = 'Records', empty = 'No records yet.', rowLimit = null, rowLabel = 'rows'} = {}) {
  const markup = `<div class="ui-table-scroll${rowLimit ? ' table-wrap' : ''}" data-mobile-table="scroll" role="region" aria-label="${escapeHtml(label)}" tabindex="0">
    <table class="ui-table"><thead><tr>${columns.map(column => `<th scope="col" class="ui-col-${escapeHtml(column.key)}">${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map(row => `<tr>${row.map((value, index) => `<td class="ui-col-${escapeHtml(columns[index].key)}">${value}</td>`).join('')}</tr>`).join('') : `<tr><td class="ui-empty" colspan="${columns.length}">${escapeHtml(empty)}</td></tr>`}</tbody></table></div>`;
  return rowLimit ? `<div data-row-collapser data-row-limit="${Math.max(1,Number(rowLimit)||5)}" data-row-label="${escapeHtml(rowLabel)}">${markup}</div>` : markup;
}

export function uiFacts(items, label = 'Details') {
  return `<dl class="ui-facts" aria-label="${escapeHtml(label)}">${items.map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

export function uiStatus(status) {
  const labels = {active: 'Active', inactive: 'Suspended', revoked: 'Disabled', used: 'Used', expired: 'Expired'};
  const mark = status === 'active' || status === 'used' ? '<path d="m7 12 3 3 7-7"/>' : status === 'inactive' ? '<path d="M9 8v8m6-8v8"/>' : '<path d="m8 8 8 8m0-8-8 8"/>';
  return `<span class="ui-status ui-status-${escapeHtml(status)}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><circle cx="12" cy="12" r="9"/>${mark}</svg>${escapeHtml(labels[status] || status)}</span>`;
}

export function formatUiDate(value) {
  return value ? new Intl.DateTimeFormat('en-IN', {dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Kolkata'}).format(new Date(value)) : '—';
}

export function uiConfirmation(options) {
  return `data-ui-confirm="${escapeHtml(JSON.stringify(options))}"`;
}

// Optional Settings building blocks. Existing pages keep their current markup.
export function uiDisclosure(title, content, {id = '', open = false} = {}) {
  return `<details class="ui-panel ui-disclosure"${id ? ` id="${escapeHtml(id)}"` : ''}${open ? ' open' : ''}><summary>${escapeHtml(title)}</summary><div class="ui-disclosure-body">${content}</div></details>`;
}

export function uiDialogButton(id, label, {secondary = true} = {}) {
  return `<button type="button" class="${secondary ? 'ui-button-secondary' : ''}" data-ui-open-dialog="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
}

export function uiDialog(id, title, content, {dismissible = true} = {}) {
  return `<dialog id="${escapeHtml(id)}" class="task-edit-dialog ui-content-dialog" data-ui-panel-dialog aria-labelledby="${escapeHtml(id)}-title"><header class="review-task-header"><button type="button" class="ui-button-secondary" data-ui-close-dialog>← Back</button><h2 id="${escapeHtml(id)}-title" tabindex="-1">${escapeHtml(title)}</h2>${dismissible ? `<button type="button" class="dialog-dismiss" data-ui-close-dialog aria-label="Close ${escapeHtml(title)}">×</button>` : ''}</header><div class="ui-dialog-body">${content}</div></dialog>`;
}
