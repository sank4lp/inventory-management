import {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  statsGrid,
  statusBadge,
  table,
} from "../../render.js";

export {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  statsGrid,
  statusBadge,
  table,
};

export function hiddenSubmissionToken(token) {
  return token
    ? `<input type="hidden" name="submission_token" value="${escapeHtml(token)}" />`
    : "";
}

export function quickActionLinks(productId, cellId = "") {
  return `
    <div class="mini-actions">
      <a class="mini-link" href="/products/${productId}">Open</a>
      <a class="mini-link" href="/pick?product_id=${productId}${cellId ? `&cell_id=${cellId}` : ""}">Pick</a>
      <a class="mini-link" href="/put?product_id=${productId}${cellId ? `&cell_id=${cellId}` : ""}">Put</a>
    </div>
  `;
}

function truncateText(value, limit = 46) {
  const text = String(value || "").trim();
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function comboBoxField({
  options,
  selectedValue,
  fieldPrefix,
  hiddenName,
  selectedLabel = "",
  placeholder,
  toggleLabel,
  requiredMessage,
  formId = "",
  compact = false,
  inputRequired = true,
  hiddenRequired = true,
}) {
  const comboClassName = compact ? "combo-box combo-box-compact" : "combo-box";

  return `
    <div
      class="${comboClassName}"
      data-combo-box
      data-required-message="${escapeHtml(requiredMessage)}"
    >
      <input
        class="combo-input"
        data-combo-input
        name="${fieldPrefix}_label"
        value="${escapeHtml(selectedLabel)}"
        placeholder="${escapeHtml(placeholder)}"
        autocomplete="off"
        ${formId ? `form="${formId}"` : ""}
        ${inputRequired ? "required" : ""}
      />
      <input
        id="${fieldPrefix}-id"
        data-combo-hidden
        type="hidden"
        name="${hiddenName}"
        value="${selectedValue ?? ""}"
        ${formId ? `form="${formId}"` : ""}
        ${hiddenRequired ? "required" : ""}
      />
      <button class="combo-toggle" type="button" data-combo-toggle aria-label="${escapeHtml(toggleLabel)}">
        ${escapeHtml(toggleLabel)}
      </button>
      <div class="combo-panel" data-combo-panel hidden>
        ${options.join("")}
        <div class="combo-empty" data-combo-empty hidden>No matching options found.</div>
      </div>
    </div>
  `;
}

export function productPickerField(
  products,
  selectedProductId,
  fieldPrefix = "task-product",
  hiddenName = "product_id",
  formId = "",
  required = true,
) {
  const selectedProduct = products.find((product) => product.id === selectedProductId) || null;
  const selectedLabel = selectedProduct
    ? `${selectedProduct.sku} · ${selectedProduct.name}`
    : "";

  return `
    <label>Product
      ${comboBoxField({
        options: products.map((product) => {
          const label = `${product.sku} · ${product.name}`;
          return `
            <button
              class="combo-option"
              type="button"
              data-combo-option
              data-value="${product.id}"
              data-label="${escapeHtml(label)}"
              data-search-text="${escapeHtml(`${product.sku} ${product.name} ${product.brand}`.toLowerCase())}"
            >
              <strong>${escapeHtml(product.sku)}</strong>
              <span>${escapeHtml(product.name)}</span>
            </button>
          `;
        }),
        selectedValue: selectedProduct ? selectedProduct.id : "",
        fieldPrefix,
        hiddenName,
        selectedLabel,
        placeholder: "Type SKU or product name",
        toggleLabel: "Search",
        requiredMessage: "Choose a product from the list.",
        formId,
        inputRequired: required,
        hiddenRequired: required,
      })}
    </label>
  `;
}

export function cellPickerField(
  cells,
  selectedCellId,
  fieldPrefix = "task-cell",
  hiddenName = "cell_id",
  formId = "",
) {
  const selectedCell = cells.find((cell) => cell.id === Number(selectedCellId)) || null;
  const selectedLabel = selectedCell ? selectedCell.logical_code : "";

  return comboBoxField({
    options: cells.map((cell) => {
      const contents = cell.inventory_summary
        ? truncateText(cell.inventory_summary, 54)
        : "Empty cell";
      const occupiedLabel = `${formatQuantity(cell.occupied_quantity)} occupied`;
      const searchText = `${cell.logical_code} ${cell.inventory_summary || ""}`.toLowerCase();

      return `
        <button
          class="combo-option"
          type="button"
          data-combo-option
          data-value="${cell.id}"
          data-label="${escapeHtml(cell.logical_code)}"
          data-search-text="${escapeHtml(searchText)}"
        >
          <strong>${escapeHtml(cell.logical_code)}</strong>
          <span>${escapeHtml(occupiedLabel)}</span>
          <small>${escapeHtml(contents)}</small>
        </button>
      `;
    }),
    selectedValue: selectedCell ? selectedCell.id : "",
    fieldPrefix,
    hiddenName,
    selectedLabel,
    placeholder: "Type cell code",
    toggleLabel: "Search",
    requiredMessage: "Choose a cell from the list.",
    formId,
    compact: true,
  });
}

export function rolePickerField(selectedRole = "operator", fieldPrefix = "registration-role") {
  const roles = [
    {
      value: "operator",
      label: "operator",
      detail: "Pick, put, and correction of own tasks",
    },
    {
      value: "admin",
      label: "admin",
      detail: "Full console access and correction rights",
    },
  ];
  const selected = roles.find((role) => role.value === selectedRole) || roles[0];

  return comboBoxField({
    options: roles.map(
      (role) => `
        <button
          class="combo-option"
          type="button"
          data-combo-option
          data-value="${role.value}"
          data-label="${escapeHtml(role.label)}"
          data-search-text="${escapeHtml(`${role.label} ${role.detail}`.toLowerCase())}"
        >
          <strong>${escapeHtml(role.label)}</strong>
          <span>${escapeHtml(role.detail)}</span>
        </button>
      `,
    ),
    selectedValue: selected.value,
    fieldPrefix,
    hiddenName: "role",
    selectedLabel: selected.label,
    placeholder: "Type role name",
    toggleLabel: "Roles",
    requiredMessage: "Choose a role from the list.",
    compact: true,
  });
}

export function renderAdjustmentLine(products, index) {
  return `
    <div class="adjustment-line" data-adjustment-line>
      <div class="adjustment-line-grid">
        ${productPickerField(
          products,
          null,
          `adjustment-product-${index}`,
          `product_id_${index}`,
          "",
          false,
        )}
        <label>Final quantity in cell
          <input type="number" min="0" step="0.01" name="absolute_quantity_${index}" placeholder="0, 3, 12" />
        </label>
      </div>
      <div class="mini-actions">
        <button type="button" class="ghost-button" data-adjustment-remove>Remove line</button>
      </div>
    </div>
  `;
}

export function canEditTask(user, task) {
  return Boolean(user && task && (user.role === "admin" || user.id === task.created_by));
}
