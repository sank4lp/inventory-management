import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { URL } from "node:url";

import { createDatabase } from "./db.js";
import {
  clearSessionCookie,
  createSessionCookie,
  getSessionUser,
  hashPassword,
  requireRole,
  verifyPassword,
} from "./services/auth.js";
import {
  activateGuidance,
  clearGuidance,
  sendCellTest,
  sendControllerTest,
  simulateButtonPress,
} from "./services/hardware.js";
import {
  applyRecommendedAction,
  allocatePick,
  authenticateUser,
  completeTask,
  correctCompletedTask,
  createAdjustment,
  createProduct,
  dashboardStats,
  getCellDetail,
  getProductDetail,
  getRecommendedActions,
  getTask,
  issueRegistrationKey,
  listCells,
  listControllers,
  listProducts,
  listRecentTasksForUser,
  listRegistrationKeys,
  listUsers,
  markPhysicalConfirmation,
  planPut,
  registerUser,
  searchCells,
  updateCellMapping,
  updateProductItemsPerCell,
} from "./services/inventory.js";
import { buildReports } from "./services/reports.js";
import {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  statsGrid,
  statusBadge,
  table,
} from "./render.js";

const PORT = Number(process.env.PORT || 3000);
const db = createDatabase({ hashPassword });
const publicDir = join(process.cwd(), "public");

function sendHtml(response, html, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(html);
}

function sendText(response, text, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(text);
}

function sendRedirect(response, location, headers = {}) {
  response.writeHead(302, {
    Location: location,
    ...headers,
  });
  response.end();
}

function appendFlash(path, message, tone = "info") {
  const url = new URL(path, "http://localhost");
  url.searchParams.set("flash", message);
  url.searchParams.set("tone", tone);
  return `${url.pathname}${url.search}`;
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfDay(date) {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}

function resolveReportRange(url) {
  const preset = url.searchParams.get("preset") || "";
  const now = new Date();
  let fromAt = null;
  let toAt = null;
  let from = url.searchParams.get("from") || "";
  let to = url.searchParams.get("to") || "";
  let label = "Custom range";

  if (preset === "last-24h") {
    fromAt = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    toAt = now.toISOString();
    from = formatDateInput(new Date(fromAt));
    to = formatDateInput(now);
    label = "Last 24 hours";
  } else if (preset === "previous-day") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    fromAt = startOfDay(yesterday).toISOString();
    toAt = endOfDay(yesterday).toISOString();
    from = formatDateInput(new Date(fromAt));
    to = formatDateInput(new Date(toAt));
    label = "Previous day";
  } else if (preset === "previous-week") {
    const day = now.getDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    const currentWeekStart = startOfDay(new Date(now));
    currentWeekStart.setDate(currentWeekStart.getDate() - mondayOffset);
    const previousWeekStart = new Date(currentWeekStart);
    previousWeekStart.setDate(currentWeekStart.getDate() - 7);
    const previousWeekEnd = new Date(previousWeekStart);
    previousWeekEnd.setDate(previousWeekStart.getDate() + 6);
    fromAt = startOfDay(previousWeekStart).toISOString();
    toAt = endOfDay(previousWeekEnd).toISOString();
    from = formatDateInput(new Date(fromAt));
    to = formatDateInput(new Date(toAt));
    label = "Previous week";
  } else if (preset === "previous-month") {
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    fromAt = startOfDay(previousMonthStart).toISOString();
    toAt = endOfDay(previousMonthEnd).toISOString();
    from = formatDateInput(previousMonthStart);
    to = formatDateInput(previousMonthEnd);
    label = "Previous month";
  } else {
    if (from) {
      fromAt = startOfDay(new Date(from)).toISOString();
    }
    if (to) {
      toAt = endOfDay(new Date(to)).toISOString();
    }
    if (!from && !to) {
      label = "All time";
    }
  }

  return {
    preset,
    from,
    to,
    fromAt,
    toAt,
    label,
  };
}

function presetHref(preset) {
  return `/reports?preset=${preset}`;
}

async function parseForm(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function getFlash(url) {
  const message = url.searchParams.get("flash");
  if (!message) {
    return null;
  }

  return {
    message,
    tone: url.searchParams.get("tone") || "info",
  };
}

function ensureAuth(response, user) {
  if (!user) {
    sendRedirect(response, "/login");
    return false;
  }
  return true;
}

function ensureAdmin(response, user) {
  if (!user) {
    sendRedirect(response, "/login");
    return false;
  }

  if (!requireRole(user, "admin")) {
    sendRedirect(response, appendFlash("/", "Admin access is required.", "error"));
    return false;
  }

  return true;
}

function quickActionLinks(productId) {
  return `
    <div class="mini-actions">
      <a class="mini-link" href="/products/${productId}">Open</a>
      <a class="mini-link" href="/pick?product_id=${productId}">Pick</a>
      <a class="mini-link" href="/put?product_id=${productId}">Put</a>
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

function productPickerField(
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

function cellPickerField(
  cells,
  selectedCellId,
  fieldPrefix = "task-cell",
  hiddenName = "cell_id",
  formId = "",
) {
  const selectedCell = cells.find((cell) => cell.id === Number(selectedCellId)) || null;
  const selectedLabel = selectedCell ? selectedCell.logical_code : "";

  return comboBoxField({
    options: cells.map(
      (cell) => {
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
      },
    ),
    selectedValue: selectedCell ? selectedCell.id : "",
    fieldPrefix,
    hiddenName,
    selectedLabel,
    placeholder: "Type cell code",
    toggleLabel: "Find",
    requiredMessage: "Choose a cell from the list.",
    formId,
    compact: true,
  });
}

function rolePickerField(selectedRole = "operator", fieldPrefix = "registration-role") {
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

function renderAdjustmentLine(products, index) {
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

function renderHomeProductResults(products) {
  return products.length
    ? table(
        ["Product", "Stock", "Action"],
        products.map((product) => [
          `${escapeHtml(product.name)}<br /><small>${escapeHtml(product.sku)}</small>`,
          `${escapeHtml(formatQuantity(product.total_available))} ${escapeHtml(product.unit_of_measure)}`,
          quickActionLinks(product.id),
        ]),
      )
    : `<p class="muted">No matching products found.</p>`;
}

function renderCatalogProductResults(products) {
  return table(
    ["SKU", "Name", "Available", "Unit", "Action"],
    products.map((product) => [
      `<a href="/products/${product.id}">${escapeHtml(product.sku)}</a>`,
      `<a href="/products/${product.id}">${escapeHtml(product.name)}</a><br /><small>${escapeHtml(product.brand)}</small>`,
      escapeHtml(formatQuantity(product.total_available)),
      escapeHtml(product.unit_of_measure),
      quickActionLinks(product.id),
    ]),
  );
}

function renderHomeCellResults(cells) {
  return cells.length
    ? table(
        ["Cell", "Stock", "Open"],
        cells.map((cell) => [
          escapeHtml(cell.logical_code),
          escapeHtml(formatQuantity(cell.occupied_quantity)),
          `<a class="mini-link" href="/cells/${cell.id}">View</a>`,
        ]),
      )
    : `<p class="muted">No matching cells found.</p>`;
}

function renderCellSearchResults(cells) {
  return table(
    ["Cell", "Stock", "Open"],
    cells.map((cell) => [
      escapeHtml(cell.logical_code),
      escapeHtml(formatQuantity(cell.occupied_quantity)),
      `<a class="mini-link" href="/cells/${cell.id}">View</a>`,
    ]),
  );
}

function canEditTask(user, task) {
  return Boolean(user && task && (user.role === "admin" || user.id === task.created_by));
}

function renderHome(user, flash, url) {
  const stats = dashboardStats(db);
  const tasks = listRecentTasksForUser(db, user);
  const actions = getRecommendedActions(db).slice(0, 6);
  const productSearch = url.searchParams.get("product_q") || "";
  const cellSearch = url.searchParams.get("cell_q") || "";
  const productResults = productSearch ? listProducts(db, productSearch).slice(0, 8) : [];
  const cellResults = cellSearch ? searchCells(db, cellSearch).slice(0, 8) : [];

  return page({
    title: "Home",
    user,
    flash,
    content: `
      <section class="guide-strip">
        <span class="guide-pill">1. Search</span>
        <span class="guide-pill">2. Pick or Put</span>
        <span class="guide-pill">3. Review and finish</span>
      </section>
      ${statsGrid([
        { label: "Products", value: stats.products },
        { label: "Open tasks", value: stats.openTasks },
        { label: "Controllers", value: stats.controllers },
      ])}
      <section class="hero-grid">
        ${card(
          "What do you want to do?",
          `
            <div class="action-grid">
              <a class="action-tile green" href="/pick">Start Pick</a>
              <a class="action-tile blue" href="/put">Start Put</a>
              <a class="action-tile sand" href="/products">Check Products</a>
              ${
                user.role === "admin"
                  ? `<a class="action-tile dark" href="/reports">View Reports</a>`
                  : ""
              }
            </div>
          `,
        )}
        ${card(
          "Find a product",
          `
            <form
              method="get"
              action="/"
              class="inline-form"
              data-live-search-form
              data-endpoint="/fragments/home-products"
              data-query-param="q"
              data-target="#home-product-results"
              data-empty-html="<p class=&quot;muted&quot;>Search here and jump straight into Pick or Put.</p>"
            >
              <input data-live-input name="product_q" value="${escapeHtml(productSearch)}" placeholder="Search product by SKU or name" />
              <button type="submit">Search</button>
            </form>
            <div id="home-product-results">
              ${
                productSearch
                  ? renderHomeProductResults(productResults)
                  : `<p class="muted">Search here and jump straight into Pick or Put.</p>`
              }
            </div>
          `,
        )}
      </section>
      <section class="hero-grid">
        ${card(
          "Find a cell",
          `
            <form
              method="get"
              action="/"
              class="inline-form"
              data-live-search-form
              data-endpoint="/fragments/home-cells"
              data-query-param="q"
              data-target="#home-cell-results"
              data-empty-html="<p class=&quot;muted&quot;>Search a cell to see which products are stored there.</p>"
            >
              <input data-live-input name="cell_q" value="${escapeHtml(cellSearch)}" placeholder="Search cell like Z1-R1-C01" />
              <button type="submit">Search</button>
            </form>
            <div id="home-cell-results">
              ${
                cellSearch
                  ? renderHomeCellResults(cellResults)
                  : `<p class="muted">Search a cell to see which products are stored there.</p>`
              }
            </div>
          `,
        )}
        ${card(
          "Quick note",
          `
            <p>This version keeps the workflow simple: search, choose the product or cell, and continue from there.</p>
            <p class="muted">Light and controller activity is still simulated through server stdout using the RS485 adapter.</p>
          `,
        )}
      </section>
      ${card(
        "Recommended actions",
        actions.length
          ? table(
              ["Issue", "Why", "Action"],
              actions.map((action) => [
                `<strong>${escapeHtml(action.title)}</strong><br /><small>${escapeHtml(action.logicalCode)}</small>`,
                escapeHtml(action.description),
                `<a class="mini-link" href="/recommended-actions?key=${encodeURIComponent(action.key)}">Adjust</a>`,
              ]),
            )
          : `<p class="muted">No cell anomalies detected right now.</p>`,
      )}
      ${card(
        "Recent tasks",
        table(
          ["Task", "SKU", "Product", "Put/Pick", "Status", "Started", "Make Correction"],
          tasks.map((task) => [
            `Task #${task.id}`,
            escapeHtml(task.first_sku || "—"),
            escapeHtml(task.first_product_name || "—"),
            statusBadge(task.type),
            statusBadge(task.status),
            escapeHtml(formatDate(task.started_at)),
            `<a class="mini-link" href="/tasks/${task.id}?mode=edit">Make Correction</a>`,
          ]),
        ),
      )}
    `,
  });
}

function renderLogin(flash) {
  return page({
    title: "Login",
    flash,
    content: `
      <section class="auth-shell">
        ${card(
          "Warehouse entry station",
          `
            <form method="post" action="/login" class="stack-form">
              <label>Username<input name="username" required /></label>
              <label>Password<input type="password" name="password" required /></label>
              <button type="submit">Login</button>
            </form>
            <p class="muted">Seeded admin: <code>admin / admin123</code></p>
            <p class="muted">Need a new user? <a href="/register">Register with a key</a>.</p>
          `,
        )}
      </section>
    `,
  });
}

function renderRegister(flash) {
  return page({
    title: "Register",
    flash,
    content: `
      <section class="auth-shell">
        ${card(
          "Controlled registration",
          `
            <form method="post" action="/register" class="stack-form">
              <label>Registration key<input name="registration_key" required /></label>
              <label>Full name<input name="name" required /></label>
              <label>Username<input name="username" required /></label>
              <label>Password<input type="password" name="password" required /></label>
              <button type="submit">Create account</button>
            </form>
            <p class="muted">Seeded operator key: <code>INVITE-OP-2026</code></p>
            <p class="muted"><a href="/login">Back to login</a></p>
          `,
        )}
      </section>
    `,
  });
}

function renderProducts(user, flash, search, showAddProduct) {
  const products = listProducts(db, search);

  return page({
    title: "Products",
    user,
    flash,
    content: `
      <section class="page-actions">
        ${
          showAddProduct
            ? `
              <a class="action-cta-button secondary-cta" href="/products">Close</a>
            `
            : `
              <a class="action-cta-button" href="/products?show_add=1">Add Product</a>
            `
        }
      </section>
      <section class="single-column-wide ${showAddProduct ? "catalog-underlay" : ""}">
        ${card(
          "Catalog",
          `
            <form
              method="get"
              action="/products"
              class="inline-form"
              data-live-search-form
              data-endpoint="/fragments/catalog-products"
              data-target="#catalog-product-results"
              data-show-results-when-empty="true"
            >
              <input data-live-input name="q" value="${escapeHtml(search || "")}" placeholder="Search by SKU, name, or brand" />
              ${
                showAddProduct
                  ? `<input type="hidden" name="show_add" value="1" />`
                  : ""
              }
              <button type="submit">Search</button>
            </form>
            <div id="catalog-product-results">
              ${renderCatalogProductResults(products)}
            </div>
          `,
        )}
      </section>
      ${
        showAddProduct
          ? `
            <section class="modal-backdrop">
              <div class="modal-panel">
                <div class="modal-header">
                  <h2>Add product</h2>
                  <a class="mini-link" href="/products">Close</a>
                </div>
                <form method="post" action="/products" class="stack-form">
                  <label>SKU<input name="sku" required /></label>
                  <label>Name<input name="name" required /></label>
                  <label>Brand<input name="brand" required /></label>
                  <label>Category<input name="category" /></label>
                  <label>Variant / Size<input name="variant" /></label>
                  <label>Unit of measure<input name="unit_of_measure" required placeholder="pieces, pairs, boxes" /></label>
                  <label>Items per cell<input type="number" min="1" step="1" name="items_per_cell" value="6" required /></label>
                  <div class="modal-actions">
                    <a class="mini-link" href="/products">Cancel</a>
                    <button type="submit">Save product</button>
                  </div>
                </form>
                <p class="muted">Only the basic fields are shown here to keep the flow quick.</p>
              </div>
            </section>
          `
          : ""
      }
    `,
  });
}

function renderProductDetail(user, flash, product) {
  if (!product) {
    return page({
      title: "Product not found",
      user,
      flash: flash || { message: "Product not found.", tone: "error" },
      content: `<p><a href="/products">Back to products</a></p>`,
    });
  }

  return page({
    title: product.name,
    user,
    flash,
    content: `
      ${card(
        "Product summary",
        `
          <p><strong>${escapeHtml(product.sku)}</strong></p>
          <p>${escapeHtml(product.brand)} · ${escapeHtml(product.unit_of_measure)}</p>
          <p class="muted">Available: ${escapeHtml(formatQuantity(product.total_available))}</p>
          <p class="muted">Items per cell: ${escapeHtml(formatQuantity(product.items_per_cell))}</p>
          <div class="mini-actions">
            <a class="mini-link" href="/pick?product_id=${product.id}">Pick</a>
            <a class="mini-link" href="/put?product_id=${product.id}">Put</a>
          </div>
          ${
            user.role === "admin"
              ? `
                <form method="post" action="/products/${product.id}/items-per-cell" class="inline-form top-gap">
                  <label>Items per cell
                    <input type="number" min="1" step="1" name="items_per_cell" value="${escapeHtml(product.items_per_cell)}" required />
                  </label>
                  <button type="submit">Update</button>
                </form>
                <p class="muted">The next put task will use this value to fill existing cells first and minimize new cells.</p>
              `
              : ""
          }
        `,
      )}
      ${card(
        "Cells holding this product",
        table(
          ["Cell", "Available", "Reserved", "Action"],
          product.locations.map((location) => [
            `<a href="/cells/${location.cell_id}">${escapeHtml(location.logical_code)}</a>`,
            escapeHtml(formatQuantity(location.available_quantity)),
            escapeHtml(formatQuantity(location.reserved_quantity)),
            `
              <div class="mini-actions">
                <a class="mini-link" href="/pick?product_id=${product.id}&cell=${encodeURIComponent(location.logical_code)}">Pick</a>
                <a class="mini-link" href="/put?product_id=${product.id}&cell=${encodeURIComponent(location.logical_code)}">Put</a>
              </div>
            `,
          ]),
        ),
      )}
    `,
  });
}

function renderPick(user, flash, url) {
  const products = listProducts(db);
  const selectedProductId = Number(url.searchParams.get("product_id") || 0);
  const selectedProduct = selectedProductId
    ? products.find((product) => product.id === selectedProductId)
    : null;
  const sourceCell = url.searchParams.get("cell") || "";
  return page({
    title: "Pick",
    user,
    flash,
    content: `
      <section class="single-column">
        <section class="guide-strip">
          <span class="guide-pill active-guide">Step 1: Choose product</span>
          <span class="guide-pill">Step 2: Enter quantity</span>
          <span class="guide-pill">Step 3: Review cells</span>
        </section>
        ${card(
          "Pick items",
          `
            <form method="post" action="/pick" class="stack-form">
              ${productPickerField(products, selectedProductId, "pick-product")}
              <label>Requested quantity<input type="number" min="1" step="1" name="quantity" required /></label>
              <button class="green-button" type="submit">Create pick task</button>
            </form>
            <p class="muted">
              ${
                selectedProduct
                  ? `Selected product: ${escapeHtml(selectedProduct.name)}. `
                  : ""
              }
              ${sourceCell ? `You opened this from cell ${escapeHtml(sourceCell)}. ` : ""}
              The system chooses the cells for you and highlights them in green.
            </p>
          `,
        )}
      </section>
    `,
  });
}

function renderPut(user, flash, url) {
  const products = listProducts(db);
  const selectedProductId = Number(url.searchParams.get("product_id") || 0);
  const selectedProduct = selectedProductId
    ? products.find((product) => product.id === selectedProductId)
    : null;
  const sourceCell = url.searchParams.get("cell") || "";
  return page({
    title: "Put",
    user,
    flash,
    content: `
      <section class="single-column">
        <section class="guide-strip">
          <span class="guide-pill active-guide">Step 1: Choose product</span>
          <span class="guide-pill">Step 2: Enter quantity</span>
          <span class="guide-pill">Step 3: Review cells</span>
        </section>
        ${card(
          "Put items away",
          `
            <form method="post" action="/put" class="stack-form">
              ${productPickerField(products, selectedProductId, "put-product")}
              <label>Quantity to place<input type="number" min="1" step="1" name="quantity" required /></label>
              <button class="blue-button" type="submit">Create put task</button>
            </form>
            <p class="muted">
              ${
                selectedProduct
                  ? `Selected product: ${escapeHtml(selectedProduct.name)}. `
                  : ""
              }
              ${sourceCell ? `You opened this from cell ${escapeHtml(sourceCell)}. ` : ""}
              The system suggests the nearest free cells and lights them in blue.
            </p>
          `,
        )}
      </section>
    `,
  });
}

function renderTask(user, flash, task, mode = "view") {
  if (!task) {
    return page({
      title: "Task not found",
      user,
      flash: flash || { message: "Task not found.", tone: "error" },
      content: `<p><a href="/">Back to dashboard</a></p>`,
    });
  }

  const guidanceSummary =
    task.type === "pick"
      ? "Pick from the green cells below."
      : "Place into the blue cells below.";

  const firstLine = task.lines[0];
  const cells = task.type === "put" ? listCells(db) : [];
  const editMode = mode === "edit";
  const editable = editMode && canEditTask(user, task);
  const taskLabel = task.type === "pick" ? "Pick Task" : "Put Task";
  const actionLabel = task.type === "pick" ? "Finish Pick Action" : "Finish Put Action";
  const editSubmitPath =
    editMode && task.status === "completed" ? "correct" : "confirm";

  return page({
    title: `${editMode ? "Edit" : task.type === "pick" ? "Pick Action Initiated" : "Put Action Initiated"} - Task #${task.id}`,
    user,
    flash,
    content: `
      <section class="page-actions">
        ${
          canEditTask(user, task)
            ? editMode
              ? `<a class="action-cta-button secondary-cta" href="/tasks/${task.id}">Back to task</a>`
              : `<a class="action-cta-button secondary-cta" href="/tasks/${task.id}?mode=edit">Edit</a>`
            : ""
        }
      </section>
      <section class="guide-strip">
        <span class="guide-pill">${escapeHtml(taskLabel)}</span>
        <span class="guide-pill active-guide">Review cells</span>
      </section>
      ${card(
        editMode ? `Edit ${actionLabel}` : "Task",
        `
          <div class="meta-grid compact-meta-grid">
            <div><strong>Status</strong><br />${statusBadge(task.status)}</div>
            <div><strong>Started</strong><br />${escapeHtml(formatDate(task.started_at))}</div>
          </div>
          ${
            firstLine
              ? `<p><strong>${escapeHtml(firstLine.product_name)}</strong> · ${escapeHtml(firstLine.sku)}</p>`
              : ""
          }
          <p><strong>${escapeHtml(task.summary)}</strong></p>
          <p class="muted">${escapeHtml(guidanceSummary)}</p>
        `,
      )}
      ${card(
        editMode ? `Make Changes to ${actionLabel}` : actionLabel,
        `
          ${
            task.type === "put"
              ? `<p class="muted">You may change cell or quantity. If the final placement overfills a cell or mixes products, Home will flag it under Recommended actions.</p>`
              : ""
          }
          ${table(
            task.type === "put"
              ? ["Suggested cell", "Final cell", "Planned", "Actual", "Reached cell", "Signal"]
              : ["Cell", "Planned", "Actual", "Reached cell", "Signal"],
            task.lines.map((line) => [
              ...(task.type === "put"
                ? [
                    escapeHtml(line.logical_code),
                    editable || task.status !== "completed"
                      ? cellPickerField(cells, line.cell_id, `line-${line.id}`, `actual_cell_${line.id}`, "confirm-form")
                      : escapeHtml(line.logical_code),
                  ]
                : [escapeHtml(line.logical_code)]),
              `${escapeHtml(formatQuantity(line.planned_quantity))} ${escapeHtml(line.unit_of_measure)}`,
              editable || task.status !== "completed"
                ? `<input form="confirm-form" class="compact-input" type="number" step="0.01" min="0" ${task.type === "pick" ? `max="${escapeHtml(line.planned_quantity)}"` : ""} name="actual_${line.id}" value="${escapeHtml(line.actual_quantity || line.planned_quantity)}" />`
                : escapeHtml(formatQuantity(line.actual_quantity || line.planned_quantity)),
              line.physical_confirmed_at
                ? `<span class="badge badge-active">Yes</span>`
                : `<span class="badge badge-pending-review">No</span>`,
              task.status !== "completed" && !editMode
                ? `
                    <form method="post" action="/tasks/${task.id}/simulate-button">
                      <input type="hidden" name="line_id" value="${line.id}" />
                      <button type="submit" class="ghost-button">Press button</button>
                    </form>
                  `
                : `<span class="muted">${editMode ? "Editing" : "Done"}</span>`,
            ]),
          )}
          ${
            editable || task.status !== "completed"
              ? `
                  <form id="confirm-form" method="post" action="/tasks/${task.id}/${editSubmitPath}" class="stack-form">
                    <label>Note<textarea name="note" rows="3" placeholder="Optional note"></textarea></label>
                    <button type="submit">${editMode ? "Save Correction" : "Finish task"}</button>
                  </form>
                `
              : `<p class="muted">Only the task owner or an admin can edit this task.</p>`
          }
        `,
      )}
    `,
  });
}

function renderReports(user, flash, url) {
  const range = resolveReportRange(url);
  const reports = buildReports(db, { fromAt: range.fromAt, toAt: range.toAt });

  return page({
    title: "Reports",
    user,
    flash,
    content: `
      <section class="guide-strip">
        <span class="guide-pill active-guide">${escapeHtml(range.label)}</span>
        <span class="guide-pill">Tap a quick range or set dates manually</span>
      </section>
      ${card(
        "Timeframe",
        `
          <div class="preset-row">
            <a class="preset-chip ${range.preset === "last-24h" ? "preset-chip-active" : ""}" href="${presetHref("last-24h")}">Last 24 hours</a>
            <a class="preset-chip ${range.preset === "previous-day" ? "preset-chip-active" : ""}" href="${presetHref("previous-day")}">Previous day</a>
            <a class="preset-chip ${range.preset === "previous-week" ? "preset-chip-active" : ""}" href="${presetHref("previous-week")}">Previous week</a>
            <a class="preset-chip ${range.preset === "previous-month" ? "preset-chip-active" : ""}" href="${presetHref("previous-month")}">Previous month</a>
            <a class="preset-chip ${!range.preset && !range.from && !range.to ? "preset-chip-active" : ""}" href="/reports">All time</a>
          </div>
          <form method="get" action="/reports" class="inline-form">
            <label>From <input type="date" name="from" value="${escapeHtml(range.from)}" /></label>
            <label>To <input type="date" name="to" value="${escapeHtml(range.to)}" /></label>
            <button type="submit">Apply</button>
          </form>
          <p class="muted">A simple operational summary for ${escapeHtml(range.label.toLowerCase())}.</p>
        `,
      )}
      ${card(
        "Stock snapshot",
        table(
          ["Item", "Available", "Reserved"],
          reports.stockSnapshot.map((row) => [
            `${escapeHtml(row.name)}<br /><small>${escapeHtml(row.sku)}</small>`,
            escapeHtml(formatQuantity(row.available)),
            escapeHtml(formatQuantity(row.reserved)),
          ]),
        ),
      )}
      ${card(
        "Movement",
        table(
          ["Date", "Picked", "Put away", "Net change"],
          reports.movementSummary.map((row) => [
            escapeHtml(row.movement_date),
            escapeHtml(formatQuantity(row.picked)),
            escapeHtml(formatQuantity(row.put_away)),
            escapeHtml(formatQuantity(row.net_change)),
          ]),
        ),
      )}
      ${card(
        "Team activity",
        table(
          ["User", "Tasks created", "Transactions recorded"],
          reports.userActivity.map((row) => [
            escapeHtml(row.username),
            escapeHtml(formatQuantity(row.tasks_created)),
            escapeHtml(formatQuantity(row.transactions_recorded)),
          ]),
        ),
      )}
      ${card(
        "Issues",
        `
          ${table(
            ["Task", "Item", "Cell", "Gap"],
            reports.exceptions.map((row) => [
              `<a href="/tasks/${row.task_id}">#${row.task_id}</a>`,
              `${escapeHtml(row.sku)}<br /><small>${escapeHtml(row.product_name)}</small>`,
              escapeHtml(row.logical_code),
              escapeHtml(formatQuantity(row.exception_quantity)),
            ]),
          )}
          <h3>Adjustments</h3>
          ${table(
            ["When", "Item", "Cell", "Delta", "Reason"],
            reports.adjustments.map((row) => [
              escapeHtml(formatDate(row.created_at)),
              escapeHtml(row.sku),
              escapeHtml(row.logical_code),
              escapeHtml(formatQuantity(row.quantity_delta)),
              escapeHtml(row.reason),
            ]),
          )}
        `,
      )}
    `,
  });
}

function renderCells(user, flash, search) {
  const cells = search ? searchCells(db, search) : [];

  return page({
    title: "Cells",
    user,
    flash,
    content: `
      ${card(
        "Find a cell",
        `
          <form
            method="get"
            action="/cells"
            class="inline-form"
            data-live-search-form
            data-endpoint="/fragments/cell-search"
            data-target="#cell-search-results"
            data-empty-html="<p class=&quot;muted&quot;>Search a cell to see what products are inside it.</p>"
          >
            <input data-live-input name="q" value="${escapeHtml(search || "")}" placeholder="Search by logical code" />
            <button type="submit">Search</button>
          </form>
          <div id="cell-search-results">
            ${
              search
                ? renderCellSearchResults(cells)
                : `<p class="muted">Search a cell to see what products are inside it.</p>`
            }
          </div>
        `,
      )}
    `,
  });
}

function renderRecommendedActions(user, flash, selectedKey = "") {
  const allActions = getRecommendedActions(db);
  const actions = selectedKey
    ? allActions.filter((action) => action.key === selectedKey)
    : allActions;
  const cells = listCells(db);

  return page({
    title: selectedKey ? "Recommended Action" : "Recommended Actions",
    user,
    flash,
    content: `
      ${
        selectedKey
          ? `
            <section class="page-actions page-actions-left">
              <a class="action-cta-button secondary-cta" href="/recommended-actions">All Recommendations</a>
            </section>
          `
          : ""
      }
      ${actions.length
        ? actions
            .map((action) =>
              card(
                action.title,
                `
                  <p>${escapeHtml(action.description)}</p>
                  ${
                    action.unresolvedQuantity > 0
                      ? `<p class="flash flash-error">The system could not find room for ${escapeHtml(formatQuantity(action.unresolvedQuantity))} item(s). Please review manually.</p>`
                      : ""
                  }
                  <form method="post" action="/recommended-actions/apply" class="stack-form">
                    <input type="hidden" name="source_cell_id" value="${action.cellId}" />
                    <input type="hidden" name="product_id" value="${action.productId}" />
                    <input type="hidden" name="reason" value="${escapeHtml(action.title)}" />
                    ${action.recommendedMoves
                      .map(
                        (move, index) => `
                          <div class="recommendation-row">
                            <label>Move quantity
                              <input type="number" min="0" step="0.01" name="move_qty_${index}" value="${escapeHtml(move.quantity)}" />
                            </label>
                            <label>Target cell
                              ${cellPickerField(
                                cells,
                                move.targetCellId,
                                `recommendation-${action.key}-${index}`,
                                `move_cell_${index}`,
                              )}
                            </label>
                          </div>
                        `,
                      )
                      .join("")}
                    <button type="submit">Apply recommendation</button>
                  </form>
                `,
              ),
            )
            .join("")
        : card(
            selectedKey ? "Recommended Action" : "Recommended Actions",
            `<p class="muted">${
              selectedKey
                ? "That recommendation no longer needs action."
                : "No recommended actions right now."
            }</p>`,
          )}
    `,
  });
}

function renderCellDetail(user, flash, cell) {
  if (!cell) {
    return page({
      title: "Cell not found",
      user,
      flash: flash || { message: "Cell not found.", tone: "error" },
      content: `<p><a href="/cells">Back to cells</a></p>`,
    });
  }

  return page({
    title: cell.logical_code,
    user,
    flash,
    content: `
      ${card(
        "Cell summary",
        `
          <p><strong>${escapeHtml(cell.logical_code)}</strong></p>
          <p>${escapeHtml(cell.controller_code || "No controller")} · Channel ${escapeHtml(cell.hardware_channel)}</p>
        `,
      )}
      ${card(
        "Products in this cell",
        table(
          ["Product", "Available", "Reserved", "Action"],
          cell.products.map((product) => [
            `<a href="/products/${product.product_id}">${escapeHtml(product.name)}</a><br /><small>${escapeHtml(product.sku)}</small>`,
            escapeHtml(formatQuantity(product.available_quantity)),
            escapeHtml(formatQuantity(product.reserved_quantity)),
            quickActionLinks(product.product_id),
          ]),
        ),
      )}
    `,
  });
}

function renderDevices(user, flash) {
  const controllers = listControllers(db);
  const cells = listCells(db);

  return page({
    title: "Devices and Mapping",
    user,
    flash,
    content: `
      ${card(
        "Controllers",
        table(
          ["Controller", "Health", "Cells", "Test"],
          controllers.map((controller) => [
            escapeHtml(controller.controller_code),
            statusBadge(controller.heartbeat_status),
            escapeHtml(formatQuantity(controller.mapped_cells)),
            `
              <form method="post" action="/devices/controller-test">
                <input type="hidden" name="controller_id" value="${controller.id}" />
                <button type="submit" class="ghost-button">Send test</button>
              </form>
            `,
          ]),
        ),
      )}
      ${card(
        "Cell mapping",
        table(
          ["Cell", "Channel", "Stock", "Save", "Light"],
          cells.map((cell) => [
            escapeHtml(cell.logical_code),
            escapeHtml(cell.hardware_channel),
            escapeHtml(formatQuantity(cell.occupied_quantity)),
            `
              <form method="post" action="/mapping" class="inline-form">
                <input type="hidden" name="cell_id" value="${cell.id}" />
                <input class="compact-input" type="number" min="1" name="hardware_channel" value="${escapeHtml(cell.hardware_channel)}" />
                <button type="submit" class="ghost-button">Save</button>
              </form>
            `,
            `
              <form method="post" action="/devices/cell-test">
                <input type="hidden" name="cell_id" value="${cell.id}" />
                <button type="submit" class="ghost-button">Blink</button>
              </form>
            `,
          ]),
        ),
      )}
    `,
  });
}

function renderAdmin(user, flash) {
  const users = listUsers(db);
  const keys = listRegistrationKeys(db);
  const products = listProducts(db);
  const cells = listCells(db);

  return page({
    title: "Admin",
    user,
    flash,
    content: `
      <section class="two-column">
        ${card(
          "Registration keys",
          `
            <form method="post" action="/admin/registration-keys" class="stack-form">
              <label>Key value<input name="key_value" required placeholder="INVITE-OP-2026-2" /></label>
              <label>Role
                ${rolePickerField()}
              </label>
              <button type="submit">Issue key</button>
            </form>
            ${table(
              ["Key", "Role", "Status"],
              keys.map((key) => [
                `<code>${escapeHtml(key.key_value)}</code>`,
                statusBadge(key.role),
                statusBadge(key.status),
              ]),
            )}
          `,
        )}
        ${card(
          "Users",
          table(
            ["Name", "Role", "Status"],
            users.map((entry) => [
              `${escapeHtml(entry.name)}<br /><small>${escapeHtml(entry.username)}</small>`,
              statusBadge(entry.role),
              statusBadge(entry.status),
            ]),
          ),
        )}
      </section>
      ${card(
        "Adjustment",
        `
          <form method="post" action="/admin/adjustments" class="stack-form" data-adjustment-form>
            <label>Cell
              ${cellPickerField(cells, null, "adjustment-cell")}
            </label>
            <div class="adjustment-lines-header">
              <strong>Products and quantity changes</strong>
              <button type="button" class="ghost-button" data-adjustment-add>Add product line</button>
            </div>
            <div class="stack-form" data-adjustment-lines>
              ${renderAdjustmentLine(products, 0)}
            </div>
            <template data-adjustment-template>
              ${renderAdjustmentLine(products, "__INDEX__")}
            </template>
            <label>Reason<textarea name="reason" rows="3" required placeholder="Short reason"></textarea></label>
            <button type="submit">Create adjustment batch</button>
            <p class="muted">Enter the final counted quantity for each product in this cell. The software will calculate the adjustment automatically.</p>
          </form>
        `,
      )}
    `,
  });
}

function renderNotFound(user) {
  return page({
    title: "Not found",
    user,
    content: `<p>The requested page does not exist.</p><p><a href="/">Back to dashboard</a></p>`,
  });
}

function serveStatic(request, response, pathname) {
  const filename =
    pathname === "/styles.css"
      ? "styles.css"
      : pathname === "/app.js"
        ? "app.js"
        : null;
  if (!filename) {
    return false;
  }

  const filePath = join(publicDir, filename);
  if (!existsSync(filePath)) {
    return false;
  }

  const extension = extname(filePath);
  const contentType =
    extension === ".css"
      ? "text/css; charset=utf-8"
      : extension === ".js"
        ? "application/javascript; charset=utf-8"
        : "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(response);
  return true;
}

export const requestHandler = async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const user = getSessionUser(request, db);
  const flash = getFlash(url);

  if (serveStatic(request, response, url.pathname)) {
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/fragments/home-products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      const products = q ? listProducts(db, q).slice(0, 8) : [];
      sendText(
        response,
        q
          ? renderHomeProductResults(products)
          : `<p class="muted">Search here and jump straight into Pick or Put.</p>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/home-cells") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      const cells = q ? searchCells(db, q).slice(0, 8) : [];
      sendText(
        response,
        q
          ? renderHomeCellResults(cells)
          : `<p class="muted">Search a cell to see which products are stored there.</p>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/catalog-products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      sendText(response, renderCatalogProductResults(listProducts(db, q)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/cell-search") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      sendText(
        response,
        q
          ? renderCellSearchResults(searchCells(db, q))
          : `<p class="muted">Search a cell to see what products are inside it.</p>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/login") {
      sendHtml(response, renderLogin(flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/login") {
      const form = await parseForm(request);
      const signedInUser = authenticateUser(db, {
        username: form.username || "",
        password: form.password || "",
        verifyPassword,
      });
      sendRedirect(response, appendFlash("/", "Signed in successfully.", "success"), {
        "Set-Cookie": createSessionCookie(signedInUser),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/register") {
      sendHtml(response, renderRegister(flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/register") {
      const form = await parseForm(request);
      const newUser = registerUser(db, {
        registrationKey: form.registration_key,
        name: form.name,
        username: form.username,
        password: form.password,
        hashPassword,
      });
      sendRedirect(response, appendFlash("/", "Registration completed.", "success"), {
        "Set-Cookie": createSessionCookie(newUser),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/logout") {
      sendRedirect(response, "/login", {
        "Set-Cookie": clearSessionCookie(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, renderHome(user, flash, url));
      return;
    }

    if (request.method === "GET" && url.pathname === "/products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(
        response,
        renderProducts(
          user,
          flash,
          url.searchParams.get("q") || "",
          url.searchParams.get("show_add") === "1",
        ),
      );
      return;
    }

    const productMatch = url.pathname.match(/^\/products\/(\d+)$/);
    if (request.method === "GET" && productMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const product = getProductDetail(db, Number(productMatch[1]));
      sendHtml(response, renderProductDetail(user, flash, product));
      return;
    }

    const productCapacityMatch = url.pathname.match(/^\/products\/(\d+)\/items-per-cell$/);
    if (request.method === "POST" && productCapacityMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      updateProductItemsPerCell(db, {
        productId: Number(productCapacityMatch[1]),
        itemsPerCell: form.items_per_cell,
      });
      sendRedirect(
        response,
        appendFlash(`/products/${productCapacityMatch[1]}`, "Items per cell updated.", "success"),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      createProduct(db, form);
      sendRedirect(response, appendFlash("/products", "Product saved.", "success"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/pick") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, renderPick(user, flash, url));
      return;
    }

    if (request.method === "POST" && url.pathname === "/pick") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const task = allocatePick(db, {
        userId: user.id,
        productId: form.product_id,
        quantity: form.quantity,
      });
      activateGuidance(db, task, task.lines);
      sendRedirect(
        response,
        appendFlash(`/tasks/${task.id}`, "Pick task created and guidance activated.", "success"),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/put") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, renderPut(user, flash, url));
      return;
    }

    if (request.method === "GET" && url.pathname === "/cells") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, renderCells(user, flash, url.searchParams.get("q") || ""));
      return;
    }

    const cellMatch = url.pathname.match(/^\/cells\/(\d+)$/);
    if (request.method === "GET" && cellMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const cell = getCellDetail(db, Number(cellMatch[1]));
      sendHtml(response, renderCellDetail(user, flash, cell));
      return;
    }

    if (request.method === "POST" && url.pathname === "/put") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const task = planPut(db, {
        userId: user.id,
        productId: form.product_id,
        quantity: form.quantity,
      });
      activateGuidance(db, task, task.lines);
      sendRedirect(
        response,
        appendFlash(`/tasks/${task.id}`, "Put task created and guidance activated.", "success"),
      );
      return;
    }

    const taskMatch = url.pathname.match(/^\/tasks\/(\d+)$/);
    if (request.method === "GET" && taskMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = getTask(db, Number(taskMatch[1]));
      const mode = url.searchParams.get("mode") === "edit" ? "edit" : "view";
      if (mode === "edit" && task && !canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${task.id}`, "You can edit only your own tasks unless you are an admin.", "error"));
        return;
      }
      sendHtml(response, renderTask(user, flash, task, mode));
      return;
    }

    const confirmMatch = url.pathname.match(/^\/tasks\/(\d+)\/confirm$/);
    if (request.method === "POST" && confirmMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const actualQuantities = Object.fromEntries(
        Object.entries(form)
          .filter(([key]) => key.startsWith("actual_") && !key.startsWith("actual_cell_"))
          .map(([key, value]) => [Number(key.slice(7)), value]),
      );
      const actualCellIds = Object.fromEntries(
        Object.entries(form)
          .filter(([key]) => key.startsWith("actual_cell_"))
          .map(([key, value]) => [Number(key.slice(12)), value]),
      );
      const completion = completeTask(db, {
        taskId: Number(confirmMatch[1]),
        actualQuantities,
        actualCellIds,
        userId: user.id,
        note: form.note,
      });
      clearGuidance(db, completion.task, completion.task.lines);
      sendRedirect(
        response,
        appendFlash(
          `/tasks/${completion.task.id}`,
          completion.anomalies.length
            ? `Action completed. ${completion.anomalies.length} recommended action warning(s) were created.`
            : "Action completed successfully.",
          completion.anomalies.length ? "error" : "success",
        ),
      );
      return;
    }

    const correctMatch = url.pathname.match(/^\/tasks\/(\d+)\/correct$/);
    if (request.method === "POST" && correctMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = getTask(db, Number(correctMatch[1]));
      if (!task || !canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${correctMatch[1]}`, "You can edit only your own tasks unless you are an admin.", "error"));
        return;
      }
      const form = await parseForm(request);
      const actualQuantities = Object.fromEntries(
        Object.entries(form)
          .filter(([key]) => key.startsWith("actual_") && !key.startsWith("actual_cell_"))
          .map(([key, value]) => [Number(key.slice(7)), value]),
      );
      const actualCellIds = Object.fromEntries(
        Object.entries(form)
          .filter(([key]) => key.startsWith("actual_cell_"))
          .map(([key, value]) => [Number(key.slice(12)), value]),
      );
      const correction = correctCompletedTask(db, {
        taskId: Number(correctMatch[1]),
        actualQuantities,
        actualCellIds,
        userId: user.id,
        note: form.note,
      });
      sendRedirect(
        response,
        appendFlash(
          `/tasks/${correction.task.id}`,
          correction.anomalies.length
            ? `Correction saved. ${correction.anomalies.length} recommended action warning(s) remain.`
            : "Correction saved successfully.",
          correction.anomalies.length ? "error" : "success",
        ),
      );
      return;
    }

    const buttonMatch = url.pathname.match(/^\/tasks\/(\d+)\/simulate-button$/);
    if (request.method === "POST" && buttonMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const line = markPhysicalConfirmation(db, Number(form.line_id));
      simulateButtonPress(db, { ...line, task_id: Number(buttonMatch[1]) });
      sendRedirect(
        response,
        appendFlash(`/tasks/${buttonMatch[1]}`, `Simulated button press for ${line.logical_code}.`, "success"),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/reports") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, renderReports(user, flash, url));
      return;
    }

    if (request.method === "GET" && url.pathname === "/recommended-actions") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(
        response,
        renderRecommendedActions(user, flash, url.searchParams.get("key") || ""),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/recommended-actions/apply") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const moves = Object.entries(form)
        .filter(([key, value]) => key.startsWith("move_qty_") && String(value).trim())
        .map(([key, value]) => {
          const suffix = key.slice("move_qty_".length);
          return {
            quantity: value,
            targetCellId: form[`move_cell_${suffix}`],
          };
        });
      applyRecommendedAction(db, {
        sourceCellId: form.source_cell_id,
        productId: form.product_id,
        moves,
        userId: user.id,
        reason: form.reason,
      });
      sendRedirect(
        response,
        appendFlash("/recommended-actions", "Recommended action applied.", "success"),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, renderDevices(user, flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/controller-test") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const controller = listControllers(db).find((entry) => entry.id === Number(form.controller_id));
      if (!controller) {
        throw new Error("Controller not found.");
      }
      sendControllerTest(db, controller);
      sendRedirect(response, appendFlash("/devices", `Sent test to ${controller.controller_code}.`, "success"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cell-test") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = listCells(db).find((entry) => entry.id === Number(form.cell_id));
      if (!cell) {
        throw new Error("Cell not found.");
      }
      sendCellTest(db, cell);
      sendRedirect(response, appendFlash("/devices", `Light test sent for ${cell.logical_code}.`, "success"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/mapping") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      updateCellMapping(db, {
        cellId: form.cell_id,
        hardwareChannel: form.hardware_channel,
        mappedBy: user.id,
      });
      sendRedirect(response, appendFlash("/devices", "Cell mapping updated.", "success"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      sendHtml(response, renderAdmin(user, flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/registration-keys") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      issueRegistrationKey(db, {
        keyValue: form.key_value,
        role: form.role,
        userId: user.id,
      });
      sendRedirect(response, appendFlash("/admin", "Registration key issued.", "success"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/adjustments") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const lineIndexes = Array.from(
        new Set(
          Object.keys(form)
            .map(
              (key) =>
                key.match(/^product_id_(.+)$/)?.[1] ||
                key.match(/^absolute_quantity_(.+)$/)?.[1] ||
                null,
            )
            .filter(Boolean),
        ),
      ).sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
      const lines = lineIndexes
        .map((index) => ({
          productId: form[`product_id_${index}`],
          absoluteQuantity: form[`absolute_quantity_${index}`],
        }))
        .filter(
          (line) =>
            String(line.productId || "").trim() || String(line.absoluteQuantity || "").trim(),
        );
      createAdjustment(db, {
        cellId: form.cell_id,
        userId: user.id,
        reason: form.reason,
        lines,
      });
      sendRedirect(response, appendFlash("/admin", "Adjustment batch recorded.", "success"));
      return;
    }

    sendHtml(response, renderNotFound(user), 404);
  } catch (error) {
    let target = user ? url.pathname : "/login";
    const confirmMatch = url.pathname.match(/^\/tasks\/(\d+)\/confirm$/);
    const buttonMatch = url.pathname.match(/^\/tasks\/(\d+)\/simulate-button$/);
    if (confirmMatch || buttonMatch) {
      const taskId = confirmMatch?.[1] || buttonMatch?.[1];
      target = `/tasks/${taskId}`;
    }
    sendRedirect(response, appendFlash(target, error.message, "error"));
  }
};

export const server = createServer(requestHandler);

if (process.env.NO_SERVER_LISTEN !== "1") {
  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`Inventory app running on http://localhost:${PORT}\n`);
  });
}
