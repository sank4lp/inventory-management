import {buttonLabels, measureControlText} from './stable-buttons.js';

// Only presentation changes: controls remain in their original forms and order.
// Flex wrapping packs a row by its contents, then shares the leftover row space.
const groups = [
  '.work-actions', '.mini-actions', '.action-buttons', '.product-settings-actions',
  '.task-bottom-actions', '.task-cell-tools', '.task-cell-next-actions',
  '.task-title-actions', '.task-editor-actions', '.task-primary-actions',
  '.check-observation-actions', '.bulk-row-actions', '.closure-actions', '.review-choices', '.review-discard-footer',
  '.form-actions', '.modal-actions', '.page-actions', '.product-primary-actions', '.put-stock-summary-actions',
  '.adjustment-guidance-actions', '.key-quick-actions', '.firmware-detect-actions',
  '.reports-hero-actions', '.report-stage-actions', '.report-stage-context-actions', '.report-toolbar-popover-actions',
  '.location-detail-actions', '.location-detail-toolbar', '.location-detail-settings-actions',
  '.location-page-tools', '.location-group-actions', '.active-assignments-toolbar',
  '.inline-form', '.inline-form > span:has(> button)', '.stack-form', '.form-grid', '.report-format-form-grid', '.report-time-custom-fields', '.cell-confirmation-fields', '.assignment-duration',
  '[data-review-duration]', '.stocktake-scope-buttons', '.stocktake-scope-fields',
  '.stocktake-create-options', '.stocktake-start-actions', '.stocktake-save-actions',
  '.stocktake-add-product', '.stocktake-manual-select',
  'form[data-work-action]', 'form.count-form', 'form[data-product-settings-form]',
].join(',');
const fieldSelector = 'select,input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),textarea';
const actionSelector = 'button,a.mini-link,a.ghost-button,a.green-button,a.action-cta-button,a.work-primary,a.work-secondary';
const excluded = '.report-document,.report-format-preview,.mobile-task-table,.qr-dialog-header,.review-task-header,.task-cell-navigation,.global-toast-host,.global-notification-panel';
const managed = new Set();

export function mobileFieldWidth(type, textWidth, chrome = 26) {
  // Long catalogue/user names stay fully available in the dropdown. Do not let
  // one long option force every other control below it on a narrow phone.
  const limits = type === 'number' ? [88, 120]
    : type === 'date' ? [164, 180]
    : type === 'datetime-local' ? [220, 260]
    : type === 'select' ? [128, 224] : [144, 240];
  return Math.ceil(Math.max(limits[0], Math.min(limits[1], textWidth + chrome)));
}

function visible(element) {
  if (element.closest('[hidden]') || !element.getClientRects().length) return false;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.matches('details:not([open])') && !ancestor.querySelector(':scope > summary')?.contains(element)) return false;
  }
  return true;
}
function textWidth(element, text) {
  return measureControlText(element.ownerDocument, element.ownerDocument.defaultView.getComputedStyle(element), text).width;
}
function actionWidth(action) {
  const flags = {
    ping: action.matches('[data-ping-cell],[data-ping-controller]'),
    locate: action.matches('[data-locate-cell],[data-adjustment-locate-cell]'),
    quantity: action.matches('[data-show-product-quantity],[data-show-location-count]'),
  };
  const labels = buttonLabels(action.textContent.trim(), action.dataset, flags);
  const icon = action.querySelector('svg,.button-icon');
  const iconWidth = icon ? icon.getBoundingClientRect().width + 8 : 0;
  const reserve = parseFloat(action.style.getPropertyValue('--stable-button-width')) || 0;
  return Math.ceil(Math.max(44, reserve, ...labels.map(label => textWidth(action, label) + 22 + iconWidth)));
}
function fieldWidth(field) {
  const displayed = field.matches('select') ? field.parentElement.querySelector('.searchable-input') || field : field;
  const values = field.matches('select')
    ? [...field.options].filter(option => !option.hidden).map(option => option.textContent)
    : field.type === 'number' ? [field.value || '00000'] : [field.value, field.placeholder].filter(Boolean);
  const width = Math.max(0, ...values.map(value => textWidth(displayed, value)));
  return mobileFieldWidth(field.matches('select') ? 'select' : field.type, width, field.matches('select') ? 52 : 26);
}
function itemWidth(item) {
  if (item.matches(actionSelector + ',a')) return actionWidth(item);
  if (item.matches(fieldSelector)) return fieldWidth(item);
  if (item.matches('label,.inline-form-wrap,.searchable-select,.work-product-field')) {
    if (item.matches('.work-product-field') && item.querySelector('[data-product-stock]:not([hidden])')) return null;
    const field = item.querySelector(fieldSelector);
    if (!field || field.matches('textarea')) return null;
    return fieldWidth(field) + (item.querySelector('.work-quantity-input > span')?.getBoundingClientRect().width || 0);
  }
  if (item.matches('.stocktake-counter-picker:not([open])')) {
    return Math.max(164, textWidth(item.querySelector('summary'), item.querySelector('summary').textContent.trim()) + 40);
  }
  // A small submit form belongs beside the other actions, with its receipt and
  // hidden fields intact. Larger forms keep their own independently packed row.
  if (item.matches('form')) {
    const children = [...item.children].filter(child => visible(child) && !child.matches('input[type=hidden],.form-feedback:empty'));
    if (children.length === 1 && children[0].matches(actionSelector)) return actionWidth(children[0]);
  }
  return null;
}
function mark(element, attribute, value = '') {
  if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
  managed.add(element);
}

export function arrangeMobileControls(doc, compact) {
  for (const element of managed) {
    if (compact && element.isConnected) continue;
    element.removeAttribute('data-mobile-control-grid');
    element.removeAttribute('data-mobile-control-item');
    element.style.removeProperty('--mobile-control-width');
    managed.delete(element);
  }
  if (!compact) return;
  for (const group of doc.querySelectorAll(groups)) {
    if (!group.closest('.page-body,dialog,.offline-shell') || group.closest(excluded)) continue;
    if (group.matches('form') && group.closest('table')) continue;
    const items = [...group.children].filter(child => visible(child) && !child.matches('input[type=hidden]'));
    if (!items.length) continue;
    mark(group, 'data-mobile-control-grid');
    for (const item of items) {
      const width = itemWidth(item);
      mark(item, 'data-mobile-control-item', width === null ? 'full' : 'fit');
      if (width !== null) {
        const value = width + 'px';
        if (item.style.getPropertyValue('--mobile-control-width') !== value) item.style.setProperty('--mobile-control-width', value);
      }
    }
  }
}
