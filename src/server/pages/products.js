import {
  getCellDetail,
  getProductDetail,
  getProductMovementStockSummary,
  getRecommendedActions,
  listCells,
  listProducts,
} from "../../services/inventory.js";
import {
  getReportFormatSettings,
  reportFormatStyle,
} from "../../services/report-format.js";
import {
  card,
  cellPickerField,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  productPickerField,
  quickActionLinks,
  table,
} from "./shared.js";

const CAPACITY_RECOMMENDATION_KEY_PARAM = "capacity_recommendation_key";
const LOW_STOCK_HISTORY_DAYS = 30;
const LOW_STOCK_SIGNIFICANT_RATIO = 0.6;
const LOW_STOCK_MIN_AVERAGE = 5;
const MOVEMENT_STOCK_INITIAL_LIMIT = 5;

export function createProductPages({ db }) {
  function uniquePositiveQuantities(values) {
    const seen = new Set();
    return values
      .map((value) => Number(value || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .filter((value) => {
        const key = formatQuantity(value);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  }

  function renderQuantityShortcuts({ shortcuts, tone = "" }) {
    const quantities = uniquePositiveQuantities(
      shortcuts.map((shortcut) => shortcut?.value),
    ).map((value) => {
      const shortcut = shortcuts.find(
        (item) => formatQuantity(item?.value) === formatQuantity(value),
      );
      return {
        value,
        label: shortcut?.label || formatQuantity(value),
      };
    });
    if (!quantities.length) {
      return "";
    }

    return `
      <fieldset class="quantity-shortcuts ${tone ? `quantity-shortcuts-${escapeHtml(tone)}` : ""}" aria-label="Quick Quantity Picker">
        <legend class="quantity-shortcuts-label">Quick Quantity Picker</legend>
        <div class="quantity-shortcut-buttons">
        ${quantities
          .map(
            ({ value, label }) => `
              <button
                type="button"
                class="ghost-button quantity-chip"
                data-fill-quantity="${escapeHtml(value)}"
                aria-label="${escapeHtml(`${label}: set quantity to ${formatQuantity(value)}`)}"
                aria-pressed="false"
              >
                <span class="quantity-chip-label">${escapeHtml(label)}</span>
                <span class="quantity-chip-value">${escapeHtml(formatQuantity(value))}</span>
              </button>
            `,
          )
          .join("")}
        </div>
      </fieldset>
    `;
  }

  function renderCatalogProductResults(
    products,
    emptyMessage = "No products match the current search.",
    search = "",
  ) {
    const searchLabel = String(search || "").trim();
    return `
      <p class="muted">${escapeHtml(
        searchLabel
          ? `${formatQuantity(products.length)} product(s) match "${searchLabel}".`
          : "Browse all products, or search by SKU/name when an operator has an item in hand.",
      )}</p>
      ${table(
        ["SKU", "Name", "Available", "Unit", "Action"],
        products.map((product) => [
          `<a href="/products/${product.id}">${escapeHtml(product.sku)}</a>`,
          `<a href="/products/${product.id}">${escapeHtml(product.name)}</a><br /><small>${escapeHtml(product.brand)}</small>`,
          escapeHtml(formatQuantity(product.total_available)),
          escapeHtml(product.unit_of_measure),
          quickActionLinks(product.id),
        ]),
        emptyMessage,
      )}
    `;
  }

  function orderProductsByRecentTaskSelection(products) {
    if (!products.length) {
      return products;
    }

    const recentRows = db
      .prepare(
        `
          SELECT
            tl.product_id,
            MAX(t.id) AS recent_task_id
          FROM task_lines tl
          JOIN tasks t ON t.id = tl.task_id
          WHERE t.type IN ('pick', 'put')
          GROUP BY tl.product_id
          ORDER BY recent_task_id DESC
        `,
      )
      .all();
    if (!recentRows.length) {
      return products;
    }

    const recentRankByProduct = new Map(
      recentRows.map((row, index) => [Number(row.product_id), index]),
    );
    const originalRankByProduct = new Map(
      products.map((product, index) => [Number(product.id), index]),
    );

    return [...products].sort((left, right) => {
      const leftRecentRank = recentRankByProduct.get(Number(left.id));
      const rightRecentRank = recentRankByProduct.get(Number(right.id));
      const leftHasRecentRank = leftRecentRank !== undefined;
      const rightHasRecentRank = rightRecentRank !== undefined;

      if (leftHasRecentRank && rightHasRecentRank) {
        return leftRecentRank - rightRecentRank;
      }
      if (leftHasRecentRank) {
        return -1;
      }
      if (rightHasRecentRank) {
        return 1;
      }
      return originalRankByProduct.get(Number(left.id)) - originalRankByProduct.get(Number(right.id));
    });
  }

  function capacityRecommendationDismissPath(url) {
    const nextUrl = new URL(url?.toString() || "http://localhost/");
    nextUrl.searchParams.delete(CAPACITY_RECOMMENDATION_KEY_PARAM);
    nextUrl.searchParams.delete("flash");
    nextUrl.searchParams.delete("tone");
    return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  }

  function renderCapacityRecommendationPrompt(url) {
    const recommendationKey = String(
      url?.searchParams?.get(CAPACITY_RECOMMENDATION_KEY_PARAM) || "",
    ).trim();
    if (!recommendationKey) {
      return "";
    }

    const action = getRecommendedActions(db).find(
      (entry) => entry.key === recommendationKey,
    );
    if (!action) {
      return "";
    }

    const skipPath = capacityRecommendationDismissPath(url);
    const reviewPath = `/recommended-actions?key=${encodeURIComponent(action.key)}&source=capacity&return_to=${encodeURIComponent(skipPath)}`;

    return `
      <section class="modal-backdrop app-alert-modal" role="dialog" aria-modal="true" aria-labelledby="capacity-recommendation-title">
        <div class="modal-panel">
          <div class="modal-header">
            <div>
              <h2 id="capacity-recommendation-title">Recommended Action Created</h2>
              <p class="muted">The capacity update created an inventory action you can review now or leave for later.</p>
            </div>
            <a class="mini-link" href="${escapeHtml(skipPath)}">Close</a>
          </div>
          <p><strong>${escapeHtml(action.title)}</strong></p>
          <p class="muted">${escapeHtml(action.actionSummary || `Move ${action.productSku} from ${action.logicalCode}.`)}</p>
          <div class="modal-actions">
            <a class="action-cta-button" href="${escapeHtml(reviewPath)}">Review Recommendation</a>
            <a class="action-cta-button secondary-cta" href="${escapeHtml(skipPath)}">Skip For Now</a>
          </div>
        </div>
      </section>
    `;
  }

  function renderAdminProductRemoval(product) {
    const remainingStock =
      Number(product.total_available || 0) + Number(product.total_reserved || 0);
    const disabled = remainingStock > 0;
    const disabledTitle =
      "Create a Pick task to reduce this product's stock to 0 before removing it.";
    const enabledTitle =
      "Remove this product from the active catalog. Existing task history stays intact.";
    const title = disabled ? disabledTitle : enabledTitle;

    return `
      <form
        method="post"
        action="/products/${product.id}/delete"
        class="inline-form top-gap"
        onsubmit="return confirm('Remove this product from the active catalog? Existing task history will stay intact.');"
      >
        <span title="${escapeHtml(title)}">
          <button
            type="submit"
            class="ghost-button danger-button"
            title="${escapeHtml(title)}"
            ${disabled ? "disabled" : ""}
          >Remove Product</button>
        </span>
      </form>
    `;
  }

  function renderProductFindForm(product, active = false) {
    const disabled = !product.locations.length;
    const title = disabled
      ? "Put stock into a mapped location before finding this product."
      : "Show this product's available quantity on each mapped LED module.";
    const clearAttrs = active
      ? ` data-product-find-led-clear-form data-product-find-led-clear-endpoint="/products/${product.id}/find/clear"`
      : "";

    return `
      <form
        method="post"
        action="/products/${product.id}/find"
        class="inline-form top-gap"
        data-led-command-form
        data-led-loading-label="Finding"
        ${clearAttrs}
      >
        <span title="${escapeHtml(title)}">
          <button
            type="submit"
            class="ghost-button led-action-button"
            data-led-command-submit
            data-product-find-submit
            data-led-loading-label="Finding"
            title="${escapeHtml(title)}"
            ${disabled ? "disabled" : ""}
          >Find Products</button>
        </span>
      </form>
    `;
  }

  function renderAdminProductDetailsForm(product) {
    return `
      <details class="form-disclosure top-gap">
        <summary>Edit Product Details</summary>
        <form method="post" action="/products/${product.id}/details" class="stack-form">
          <div class="form-grid">
            <label>SKU
              <input value="${escapeHtml(product.sku)}" disabled title="SKU is the product identity and cannot be changed." />
            </label>
            <label>Name
              <input name="name" value="${escapeHtml(product.name)}" required />
            </label>
            <label>Brand
              <input name="brand" value="${escapeHtml(product.brand)}" required />
            </label>
            <label>Unit Of Measure
              <input name="unit_of_measure" value="${escapeHtml(product.unit_of_measure)}" required />
            </label>
            <label>Category
              <input name="category" value="${escapeHtml(product.category || "")}" />
            </label>
            <label>Variant / Size
              <input name="variant" value="${escapeHtml(product.variant || "")}" />
            </label>
          </div>
          <label>Description
            <textarea name="description" rows="3">${escapeHtml(product.description || "")}</textarea>
          </label>
          <button type="submit" class="blue-button">Save Details</button>
        </form>
      </details>
    `;
  }

  function productStatusRows(products) {
    return products.map((product) => [
      `<a href="/products/${product.id}">${escapeHtml(product.sku)}</a>`,
      `${escapeHtml(product.name)}<br /><small>${escapeHtml(product.brand)}</small>`,
      escapeHtml(formatQuantity(product.total_available)),
      escapeHtml(product.unit_of_measure),
      escapeHtml(formatQuantity(product.stock_30_day_average || 0)),
      escapeHtml(productStockStatusLabel(product)),
    ]);
  }

  function productStockStatusLabel(product) {
    const currentStock = Number(product.total_available || 0);
    if (currentStock <= 0) {
      return "Out Of Stock";
    }
    if (product.is_low_stock) {
      return `Low (${formatQuantity(product.stock_shortfall_percent)}% below 30-day average)`;
    }
    if (Number(product.stock_30_day_transaction_count || 0) > 0) {
      return "Within 30-day range";
    }
    return "No 30-Day Movement";
  }

  function productReportTemplate(report, generatedAt, reportFormat) {
    return `
      <template
        data-report-template="${escapeHtml(report.key)}"
        data-report-title="${escapeHtml(report.title)}"
        data-report-description="${escapeHtml(report.description)}"
      >
        <article class="report-document" data-report-document="${escapeHtml(report.key)}" style="${escapeHtml(reportFormatStyle(reportFormat))}">
          <header class="report-document-header">
            <div class="report-document-title-block">
              <p class="report-document-company">${escapeHtml(reportFormat.companyName)}</p>
              <p class="report-document-kicker">${escapeHtml(reportFormat.headerLabel)}</p>
              <h3>${escapeHtml(report.title)}</h3>
              <p class="report-document-subheading">${escapeHtml(report.description)}</p>
            </div>
            <dl class="report-document-meta">
              <div>
                <dt>Products</dt>
                <dd>${escapeHtml(formatQuantity(report.products.length))}</dd>
              </div>
              <div>
                <dt>Generated</dt>
                <dd>${escapeHtml(formatDate(generatedAt))}</dd>
              </div>
            </dl>
          </header>
          ${table(
            ["SKU", "Name", "Available", "Unit", "30-day avg", "Status"],
            productStatusRows(report.products),
            report.emptyMessage,
          )}
        </article>
      </template>
    `;
  }

  function productStatButton(report) {
    return `
      <button
        type="button"
        class="stat-card stat-card-action"
        data-report-open="${escapeHtml(report.key)}"
        aria-haspopup="dialog"
        aria-controls="product-status-report-modal"
      >
        <span class="stat-label">${escapeHtml(report.label)}</span>
        <span class="stat-value">${escapeHtml(formatQuantity(report.products.length))}</span>
        <span class="stat-action-hint">Open Printable List</span>
      </button>
    `;
  }

  function renderProductStatusReports(reports, generatedAt, reportFormat) {
    return `
      <section class="stats-grid product-status-grid" aria-label="Product status lists">
        ${reports.map(productStatButton).join("")}
      </section>
      <section class="report-template-library" hidden>
        ${reports.map((report) => productReportTemplate(report, generatedAt, reportFormat)).join("")}
      </section>
      <section
        id="product-status-report-modal"
        class="modal-backdrop app-alert-modal report-modal"
        data-report-modal
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-status-report-title"
        hidden
      >
        <div class="modal-panel report-modal-panel">
          <div class="modal-header">
            <div>
              <p class="report-eyebrow">Product List</p>
              <h2 id="product-status-report-title" data-report-modal-title>Products</h2>
              <p class="muted" data-report-modal-description></p>
            </div>
            <button type="button" class="icon-button ghost-button" data-report-close aria-label="Close product list" title="Close">x</button>
          </div>
          <div class="report-modal-meta">
            <span>Generated: ${escapeHtml(formatDate(generatedAt))}</span>
          </div>
          <div class="report-modal-content" data-report-modal-content></div>
          <div class="modal-actions report-modal-actions">
            <button type="button" class="blue-button" data-report-print-current>Print</button>
            <button type="button" class="ghost-button" data-report-close>Close</button>
          </div>
        </div>
      </section>
    `;
  }

  function enrichProductsWithStockTrends(products) {
    if (!products.length) {
      return products;
    }

    const now = new Date();
    const windowMs = LOW_STOCK_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const windowStart = new Date(now.getTime() - windowMs);
    const transactionRows = db
      .prepare(
        `
          SELECT product_id, quantity_delta, created_at
          FROM transactions
          WHERE created_at >= ? AND created_at <= ?
          ORDER BY product_id, created_at, id
        `,
      )
      .all(windowStart.toISOString(), now.toISOString());

    const transactionsByProduct = new Map();
    for (const row of transactionRows) {
      const productId = Number(row.product_id);
      const rows = transactionsByProduct.get(productId) || [];
      rows.push(row);
      transactionsByProduct.set(productId, rows);
    }

    return products.map((product) => {
      const currentStock = Number(product.total_available || 0);
      const transactions = transactionsByProduct.get(Number(product.id)) || [];
      const windowDelta = transactions.reduce(
        (sum, row) => sum + Number(row.quantity_delta || 0),
        0,
      );
      let stockLevel = currentStock - windowDelta;
      let lastTime = windowStart.getTime();
      let weightedStockTotal = 0;

      for (const row of transactions) {
        const eventTime = new Date(row.created_at).getTime();
        if (!Number.isFinite(eventTime)) {
          continue;
        }
        const boundedEventTime = Math.min(Math.max(eventTime, windowStart.getTime()), now.getTime());
        weightedStockTotal += Math.max(0, stockLevel) * Math.max(0, boundedEventTime - lastTime);
        stockLevel += Number(row.quantity_delta || 0);
        lastTime = Math.max(lastTime, boundedEventTime);
      }

      weightedStockTotal += Math.max(0, stockLevel) * Math.max(0, now.getTime() - lastTime);
      const averageStock = windowMs > 0 ? weightedStockTotal / windowMs : currentStock;
      const lowStockThreshold = averageStock * LOW_STOCK_SIGNIFICANT_RATIO;
      const isLowStock =
        currentStock > 0 &&
        averageStock >= LOW_STOCK_MIN_AVERAGE &&
        currentStock < lowStockThreshold;

      return {
        ...product,
        stock_30_day_average: averageStock,
        stock_30_day_transaction_count: transactions.length,
        stock_low_stock_threshold: lowStockThreshold,
        stock_shortfall_percent: averageStock > 0
          ? Math.max(0, ((averageStock - currentStock) / averageStock) * 100)
          : 0,
        is_low_stock: isLowStock,
      };
    });
  }

  function productMatchesSearch(product, search) {
    const searchLabel = String(search || "").trim().toLowerCase();
    if (!searchLabel) {
      return true;
    }

    return [product.sku, product.name, product.brand].some((value) =>
      String(value || "").toLowerCase().includes(searchLabel),
    );
  }

  function renderProducts(user, flash, search, showAddProduct) {
    const allProducts = enrichProductsWithStockTrends(listProducts(db));
    const products = allProducts.filter((product) => productMatchesSearch(product, search));
    const stockedProducts = allProducts.filter((product) => Number(product.total_available || 0) > 0);
    const outOfStockProducts = allProducts.filter((product) => Number(product.total_available || 0) <= 0);
    const lowStockProducts = allProducts.filter((product) => product.is_low_stock);
    const reportFormat = getReportFormatSettings(db);
    const generatedAt = new Date().toISOString();
    const productStatusReports = [
      {
        key: "catalog-items",
        label: "Catalog Items",
        title: "Catalog Items",
        description: "All products currently registered in the catalog.",
        products: allProducts,
        emptyMessage: "No products have been added yet.",
      },
      {
        key: "in-stock",
        label: "In Stock",
        title: "Products In Stock",
        description: "Products with available quantity greater than zero.",
        products: stockedProducts,
        emptyMessage: "No products currently have stock.",
      },
      {
        key: "low-stock",
        label: "Low Stock",
        title: "Low Stock Products",
        description: `Products currently below ${formatQuantity(LOW_STOCK_SIGNIFICANT_RATIO * 100)}% of their ${formatQuantity(LOW_STOCK_HISTORY_DAYS)}-day average stock.`,
        products: lowStockProducts,
        emptyMessage: "No products are currently low on stock.",
      },
      {
        key: "out-of-stock",
        label: "Out Of Stock",
        title: "Out Of Stock Products",
        description: "Products with no available quantity in inventory.",
        products: outOfStockProducts,
        emptyMessage: "No products are currently out of stock.",
      },
    ];

    return page({
      title: "Products",
      user,
      flash,
      content: `
        <section class="reports-workspace" data-reports-workspace>
          ${renderProductStatusReports(productStatusReports, generatedAt, reportFormat)}
          <section class="page-actions">
            ${
              showAddProduct
                ? `<a class="action-cta-button secondary-cta" href="/products">Close</a>`
                : `<a class="action-cta-button" href="/products?show_add=1">Add Product</a>`
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
                  <label class="inline-form-wrap">Search products
                    <input data-live-input name="q" value="${escapeHtml(search || "")}" placeholder="Search by SKU, name, or brand" />
                  </label>
                  ${showAddProduct ? `<input type="hidden" name="show_add" value="1" />` : ""}
                  <button type="submit">Search</button>
                </form>
                <div id="catalog-product-results">
                  ${renderCatalogProductResults(
                    products,
                    search ? "No products match that search." : "No products have been added yet.",
                    search,
                  )}
                </div>
              `,
              "",
              `data-row-collapser data-row-limit="8" data-row-label="products"`,
            )}
          </section>
        </section>
        ${
          showAddProduct
            ? `
              <section class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="add-product-title">
                <div class="modal-panel">
                  <div class="modal-header">
                    <div>
                      <h2 id="add-product-title">Add Product</h2>
                      <p class="muted">Enter the fields operators need during pick and put. Optional catalog details can wait.</p>
                    </div>
                    <a class="mini-link" href="/products">Close</a>
                  </div>
                  <form method="post" action="/products" class="stack-form">
                    <div class="form-grid">
                      <label>SKU<input name="sku" autocomplete="off" autofocus required placeholder="ARMY-BOOT-001" /></label>
                      <label>Name<input name="name" required placeholder="Combat Boots" /></label>
                      <label>Brand<input name="brand" required placeholder="Supplier or brand" /></label>
                      <label>Unit Of Measure<input name="unit_of_measure" required placeholder="pieces, pairs, boxes" /></label>
                      <label>Items Per Location<input type="number" min="1" step="1" inputmode="numeric" name="items_per_cell" value="6" required /></label>
                    </div>
                    <details class="form-disclosure">
                      <summary>Optional Catalog Details</summary>
                      <div class="form-grid">
                        <label>Category<input name="category" placeholder="Footwear, medical, tools" /></label>
                        <label>Variant / Size<input name="variant" placeholder="Size 10, XL, red" /></label>
                      </div>
                    </details>
                    <div class="modal-actions">
                      <a class="mini-link" href="/products">Cancel</a>
                      <button type="submit" class="ghost-button" name="next_action" value="detail">Save Product</button>
                      <button type="submit" class="blue-button" name="next_action" value="put">Save And Put Stock</button>
                    </div>
                  </form>
                  <p class="muted">Use one product record per SKU. After saving, Put is usually the next step to place starting stock.</p>
                </div>
              </section>
            `
            : ""
        }
      `,
    });
  }

  function renderProductDetail(user, flash, product, url = new URL("http://localhost/")) {
    if (!product) {
      return page({
        title: "Product Not Found",
        user,
        flash: flash || { message: "Product not found.", tone: "error" },
        content: `<p><a href="/products">Back To Products</a></p>`,
      });
    }

    const productFindLedActive = url.searchParams.get("find_led") === "1";

    return page({
      title: product.name,
      user,
      flash,
      content: `
        ${card(
          "Product Summary",
          `
            <p><strong>${escapeHtml(product.sku)}</strong></p>
            <p>${escapeHtml(product.brand)} · ${escapeHtml(product.unit_of_measure)}</p>
            <p class="muted">Available: ${escapeHtml(formatQuantity(product.total_available))} ${escapeHtml(product.unit_of_measure)}</p>
            <p class="muted">Ideal items per cell: ${escapeHtml(formatQuantity(product.items_per_cell))}</p>
            <div class="mini-actions">
              <a class="mini-link" href="/pick?product_id=${product.id}">Pick</a>
              <a class="mini-link" href="/put?product_id=${product.id}">Put</a>
            </div>
            ${user.role === "admin" ? "" : renderProductFindForm(product, productFindLedActive)}
            ${
              user.role === "admin"
                ? `
                  <form method="post" action="/products/${product.id}/items-per-cell" class="inline-form top-gap">
                    <label>Items Per Cell
                      <input type="number" min="1" step="1" inputmode="numeric" name="items_per_cell" value="${escapeHtml(product.items_per_cell)}" required />
                    </label>
                    <button type="submit">Update Capacity</button>
                  </form>
                  <p class="muted">The next put task will use this value to fill existing cells first and minimize new cells.</p>
                  ${renderAdminProductDetailsForm(product)}
                  <div class="mini-actions product-management-actions">
                    ${renderProductFindForm(product, productFindLedActive)}
                    ${renderAdminProductRemoval(product)}
                  </div>
                `
                : ""
            }
          `,
        )}
        ${card(
          "Locations Holding This Product",
          table(
            ["Cell", "Available", "Last Activity", "Action"],
            product.locations.map((location) => [
              `<a href="/cells/${location.cell_id}">${escapeHtml(location.logical_code)}</a>`,
              escapeHtml(formatQuantity(location.available_quantity)),
              escapeHtml(formatDate(location.last_activity_at)),
              `
                <div class="mini-actions">
                  <a class="mini-link" href="/pick?product_id=${product.id}&cell_id=${location.cell_id}">Pick</a>
                  <a class="mini-link" href="/put?product_id=${product.id}&cell_id=${location.cell_id}">Put</a>
                </div>
              `,
            ]),
            "This product is not stored in any location yet. Use Put to place stock.",
          ),
          "",
          `data-row-collapser data-row-limit="4" data-row-label="cells"`,
        )}
        ${renderCapacityRecommendationPrompt(url)}
      `,
    });
  }

  function renderPick(user, flash, url) {
    const allProducts = orderProductsByRecentTaskSelection(listProducts(db));
    const requestedProductId = Number(url.searchParams.get("product_id") || 0);
    const selectedCellId = Number(url.searchParams.get("cell_id") || 0);
    const requestedQuantity = url.searchParams.get("quantity") || "";
    const selectedCell = selectedCellId
      ? listCells(db).find((cell) => cell.id === selectedCellId)
      : null;
    const selectedCellDetail = selectedCell ? getCellDetail(db, selectedCell.id) : null;
    const selectedCellProductIds = new Set(
      selectedCellDetail?.products.map((product) => Number(product.product_id)) || [],
    );
    const products = selectedCell
      ? allProducts.filter((product) => selectedCellProductIds.has(Number(product.id)))
      : allProducts;
    const selectedProductId =
      requestedProductId ||
      (!requestedProductId && selectedCell && products.length === 1 ? products[0].id : 0);
    const selectedProduct = selectedProductId
      ? products.find((product) => product.id === selectedProductId)
      : null;
    const selectedProductDetail = selectedProduct
      ? getProductMovementStockSummary(db, selectedProduct.id, {
          limit: MOVEMENT_STOCK_INITIAL_LIMIT,
          includeCellIds: selectedCell ? [selectedCell.id] : [],
        })
      : null;
    const selectedCellProduct = selectedProductId
      ? selectedCellDetail?.products.find(
          (product) => Number(product.product_id) === Number(selectedProductId),
        )
      : null;
    const availableToPick = Number(
      selectedCell ? selectedCellProduct?.available_quantity || 0 : selectedProduct?.total_available || 0,
    );
    const selectedProductUnavailableInCell = Boolean(
      selectedCell && requestedProductId && !selectedProduct,
    );
    const hasPickableProducts = products.length > 0;
    const preferredCellIds = selectedCell ? [selectedCell.id] : [];
    const productFindLedActive = url.searchParams.get("find_led") === "1" && selectedProduct;
    const productFindClearAttrs = productFindLedActive
      ? ` data-product-find-led-clear-form data-product-find-led-clear-endpoint="/products/${escapeHtml(selectedProduct.id)}/find/clear"`
      : "";

    return page({
      title: "Pick",
      user,
      flash,
      content: `
        <section class="single-column">
          <section class="guide-strip">
            <span class="guide-pill active-guide">Step 1: Choose Product</span>
            <span class="guide-pill">Step 2: Enter Quantity</span>
            <span class="guide-pill">Step 3: Review Cells</span>
          </section>
          ${card(
            "Pick Items",
            `
              <form method="post" action="/pick" class="stack-form" data-led-command-form data-led-loading-label="Creating" data-product-summary-form data-product-summary-path="/pick"${productFindClearAttrs}>
                <input type="hidden" name="return_to" value="" data-led-command-return-to />
                ${productPickerField(
                  products,
                  selectedProductId,
                  "pick-product",
                  "product_id",
                  "",
                  hasPickableProducts,
                  { recencyKey: "movement-product" },
                )}
                ${renderMovementProductStockSummary(selectedProductDetail, "pick", preferredCellIds)}
                ${renderMovementContextCellInputs(selectedCell, selectedProductDetail)}
                <label>Requested Quantity
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputmode="numeric"
                    name="quantity"
                    value="${escapeHtml(requestedQuantity)}"
                    ${hasPickableProducts ? "required" : "disabled"}
                  />
                </label>
                ${renderQuantityShortcuts({
                  tone: "pick",
                  shortcuts: [
                    { value: 1, label: "Pick One" },
                    {
                      value: availableToPick,
                      label: selectedCell ? "Pick All In This Location" : "Pick All Available",
                    },
                  ],
                })}
                <button
                  class="green-button"
                  type="submit"
                  data-led-command-submit
                  data-led-loading-label="Creating"
                  ${hasPickableProducts ? "" : "disabled"}
                >Create Pick Task</button>
              </form>
              ${
                selectedProductUnavailableInCell
                  ? `<p class="flash flash-warning">That product is not currently stocked in ${escapeHtml(selectedCell.logical_code)}. Choose a product available in this location.</p>`
                  : ""
              }
              ${
                selectedCell && !hasPickableProducts
                  ? `<p class="flash flash-info">${escapeHtml(selectedCell.logical_code)} has no pickable stock right now. Use Put to store inventory in this location.</p>`
                  : ""
              }
              <p class="muted">
                ${selectedProduct ? `Selected product: ${escapeHtml(selectedProduct.name)}. ` : ""}
                ${selectedProduct ? `Available to pick: ${escapeHtml(formatQuantity(availableToPick))} ${escapeHtml(selectedProduct.unit_of_measure)}. ` : ""}
                ${selectedCell ? `This pick starts from ${escapeHtml(selectedCell.logical_code)} and only offers products currently stocked there. ` : ""}
                After the task is created, follow the GREEN LED instructions and confirm the final quantity.
              </p>
            `,
          )}
        </section>
      `,
    });
  }

  function putRetryReturnPath({ selectedProductId, selectedCellId, requestedQuantity }) {
    const params = new URLSearchParams();
    if (selectedProductId) {
      params.set("product_id", selectedProductId);
    }
    if (requestedQuantity) {
      params.set("quantity", requestedQuantity);
    }
    if (selectedCellId) {
      params.set("cell_id", selectedCellId);
    }
    return `/put${params.toString() ? `?${params.toString()}` : ""}`;
  }

  function renderPutCapacityRecovery(user, product, returnTo, flash) {
    if (!product) {
      return "";
    }

    const message = `
      <p><strong>System Is Already Full For This Product.</strong> The planner can split larger put quantities across eligible empty locations and locations already holding ${escapeHtml(product.sku)}, but there is not enough eligible room for this request.</p>
      <p class="muted">Current planning batch for ${escapeHtml(product.sku)} is ${escapeHtml(formatQuantity(product.items_per_cell))} ${escapeHtml(product.unit_of_measure)} per location.</p>
    `;

    if (user.role !== "admin") {
      return `
        <section class="modal-backdrop app-alert-modal" role="dialog" aria-modal="true" aria-labelledby="put-capacity-title">
          <div class="modal-panel">
            <div class="modal-header">
              <div>
                <h2 id="put-capacity-title">System Already Full</h2>
                <p class="muted">${escapeHtml(flash?.message || "No eligible location has enough room for this put quantity.")}</p>
              </div>
              <a class="mini-link" href="${escapeHtml(returnTo)}">Close</a>
            </div>
            ${message}
            <p class="flash flash-warning">Ask an admin to add or map more locations, or adjust this product's items-per-location setting if each location can physically hold more.</p>
          </div>
        </section>
      `;
    }

    return `
      <section class="modal-backdrop app-alert-modal" role="dialog" aria-modal="true" aria-labelledby="put-capacity-title">
        <div class="modal-panel">
          <div class="modal-header">
            <div>
              <h2 id="put-capacity-title">System Already Full</h2>
              <p class="muted">${escapeHtml(flash?.message || "No eligible location has enough room for this put quantity.")}</p>
            </div>
            <a class="mini-link" href="${escapeHtml(returnTo)}">Close</a>
          </div>
          ${message}
          <p class="muted">Only increase this value if each location can physically hold more of this product.</p>
          <form method="post" action="/products/${product.id}/items-per-cell" class="inline-form">
            <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
            <label>Items Per Location
              <input type="number" min="1" step="1" name="items_per_cell" value="${escapeHtml(product.items_per_cell)}" required />
            </label>
            <button type="submit">Update Items Per Location</button>
          </form>
        </div>
      </section>
    `;
  }

  function stockLocationActivityTime(location) {
    const timestamp = Date.parse(location?.last_activity_at || "");
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }

  function sortedStockLocationsByActivity(locations) {
    return [...(locations || [])].sort((left, right) => {
      const activityDelta = stockLocationActivityTime(left) - stockLocationActivityTime(right);
      if (activityDelta !== 0) {
        return activityDelta;
      }
      return String(left.logical_code || "").localeCompare(String(right.logical_code || ""), "en", {
        numeric: true,
        sensitivity: "base",
      });
    });
  }

  function renderMovementContextCellInputs(selectedCell, selectedProductDetail) {
    if (!selectedCell) {
      return "";
    }
    const selectedCellId = Number(selectedCell.id);
    const listedCellIds = new Set(
      (selectedProductDetail?.locations || []).map((location) => Number(location.cell_id)),
    );
    const preferredInput = selectedProductDetail && listedCellIds.has(selectedCellId)
      ? ""
      : `<input type="hidden" name="preferred_cell_id" value="${selectedCellId}" />`;

    return `
      <input type="hidden" name="context_cell_id" value="${selectedCellId}" />
      ${preferredInput}
    `;
  }

  function movementStockShowMoreIcon() {
    return `
      <svg class="row-collapse-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none">
        <path d="M6 9l6 6 6-6" />
      </svg>
    `;
  }

  function renderMovementStockRows(product, preferredCellIds = []) {
    const preferredIds = new Set(preferredCellIds.map((cellId) => Number(cellId)));
    return (product?.locations || [])
      .map(
        (location) => `
          <tr data-stock-cell-row data-cell-id="${escapeHtml(location.cell_id)}">
            <td>
              <label class="preferred-cell-check" title="Prefer ${escapeHtml(location.logical_code)} for this task">
                <input
                  type="checkbox"
                  name="preferred_cell_${escapeHtml(location.cell_id)}"
                  value="${escapeHtml(location.cell_id)}"
                  ${preferredIds.has(Number(location.cell_id)) ? "checked" : ""}
                />
                <span aria-hidden="true">&#10003;</span>
                <span class="sr-only">Prefer ${escapeHtml(location.logical_code)}</span>
              </label>
            </td>
            <td>${escapeHtml(location.logical_code)}</td>
            <td>${escapeHtml(formatQuantity(location.available_quantity))} ${escapeHtml(product.unit_of_measure)}</td>
            <td>${escapeHtml(formatDate(location.last_activity_at))}</td>
          </tr>
        `,
      )
      .join("");
  }

  function renderMovementStockTable(product, preferredCellIds = []) {
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Preferred</th><th>Cell</th><th>Quantity</th><th>Last Activity</th></tr>
          </thead>
          <tbody data-movement-stock-rows>
            ${renderMovementStockRows(product, preferredCellIds)}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderMovementStockFooter(product, loadedCount) {
    const totalCount = Number(product.stock_location_count ?? loadedCount);
    if (totalCount <= loadedCount) {
      return "";
    }

    return `
      <div class="row-collapse-footer row-collapse-footer-glow" data-movement-stock-footer>
        <span class="muted row-collapse-status" data-movement-stock-status>Showing ${escapeHtml(loadedCount)} Of ${escapeHtml(totalCount)} Locations</span>
        <button
          type="button"
          class="row-collapse-icon-button"
          data-movement-stock-load-more
          aria-label="Show More Locations"
          aria-expanded="false"
        >
          ${movementStockShowMoreIcon()}
        </button>
      </div>
    `;
  }

  function renderMovementProductStockSummary(product, tone = "put", preferredCellIds = []) {
    if (!product) {
      return "";
    }

    const totalAvailable = Number(product.total_available || 0);
    const locations = sortedStockLocationsByActivity(product.locations);
    const stockProduct = { ...product, locations };
    const loadedCount = locations.length;
    const totalCount = Number(product.stock_location_count ?? loadedCount);
    const findTitle = locations.length
      ? "Show this product's available quantity on each mapped LED module."
      : "Put stock into a mapped location before finding this product.";
    return `
      <section
        class="put-stock-summary put-stock-summary-${escapeHtml(tone)}"
        aria-label="Selected product stock summary"
        data-movement-stock-summary
        data-movement-stock-endpoint="/fragments/movement-stock-locations?product_id=${escapeHtml(product.id)}"
        data-movement-stock-offset="${escapeHtml(product.stock_location_limit || MOVEMENT_STOCK_INITIAL_LIMIT)}"
        data-movement-stock-limit="${escapeHtml(product.stock_location_limit || MOVEMENT_STOCK_INITIAL_LIMIT)}"
        data-movement-stock-total="${escapeHtml(totalCount)}"
      >
        <div class="put-stock-summary-header">
          <div>
            <strong>Current Stock</strong>
            <span>${escapeHtml(product.sku)} · ${escapeHtml(product.name)}</span>
          </div>
          <div class="put-stock-summary-actions">
            <button
              type="submit"
              class="ghost-button led-action-button"
              formaction="/products/${escapeHtml(product.id)}/find"
              formmethod="post"
              formnovalidate
              data-led-command-submit
              data-product-find-submit
              data-led-loading-label="Finding"
              title="${escapeHtml(findTitle)}"
              ${locations.length ? "" : "disabled"}
            >Find Products</button>
            <div class="put-stock-total">
              ${escapeHtml(formatQuantity(totalAvailable))}
              <span>${escapeHtml(product.unit_of_measure)}</span>
            </div>
          </div>
        </div>
        ${
          locations.length
            ? `${renderMovementStockTable(stockProduct, preferredCellIds)}${renderMovementStockFooter(stockProduct, loadedCount)}`
            : `<p class="muted">This product is not currently stored in any cell.</p>`
        }
      </section>
    `;
  }

  function renderPut(user, flash, url) {
    const products = orderProductsByRecentTaskSelection(listProducts(db));
    const selectedProductId = Number(url.searchParams.get("product_id") || 0);
    const selectedProduct = selectedProductId
      ? products.find((product) => product.id === selectedProductId)
      : null;
    const selectedCellId = Number(url.searchParams.get("cell_id") || 0);
    const selectedCell = selectedCellId
      ? listCells(db).find((cell) => cell.id === selectedCellId)
      : null;
    const selectedProductDetail = selectedProduct
      ? getProductMovementStockSummary(db, selectedProduct.id, {
          limit: MOVEMENT_STOCK_INITIAL_LIMIT,
          includeCellIds: selectedCell ? [selectedCell.id] : [],
        })
      : null;
    const requestedQuantity = url.searchParams.get("quantity") || "";
    const showCapacityRecovery = url.searchParams.get("capacity_help") === "1" && selectedProduct;
    const returnTo = putRetryReturnPath({ selectedProductId, selectedCellId, requestedQuantity });
    const preferredCellIds = selectedCell ? [selectedCell.id] : [];
    const productFindLedActive = url.searchParams.get("find_led") === "1" && selectedProduct;
    const productFindClearAttrs = productFindLedActive
      ? ` data-product-find-led-clear-form data-product-find-led-clear-endpoint="/products/${escapeHtml(selectedProduct.id)}/find/clear"`
      : "";

    return page({
      title: "Put",
      user,
      flash: showCapacityRecovery ? null : flash,
      content: `
        <section class="single-column">
          <section class="guide-strip">
            <span class="guide-pill active-guide">Step 1: Choose Product</span>
            <span class="guide-pill">Step 2: Enter Quantity</span>
            <span class="guide-pill">Step 3: Review Cells</span>
          </section>
          ${card(
            "Put Items Away",
            `
              <form method="post" action="/put" class="stack-form" data-led-command-form data-led-loading-label="Creating" data-put-product-summary-form data-product-summary-form data-product-summary-path="/put"${productFindClearAttrs}>
                <input type="hidden" name="return_to" value="" data-led-command-return-to />
                ${productPickerField(products, selectedProductId, "put-product", "product_id", "", true, {
                  recencyKey: "movement-product",
                })}
                ${renderMovementProductStockSummary(selectedProductDetail, "put", preferredCellIds)}
                ${renderMovementContextCellInputs(selectedCell, selectedProductDetail)}
                <label>Quantity To Place<input type="number" min="1" step="1" inputmode="numeric" name="quantity" value="${escapeHtml(requestedQuantity)}" required /></label>
                ${renderQuantityShortcuts({
                  tone: "put",
                  shortcuts: [
                    { value: 1, label: "Put One" },
                    { value: selectedProduct?.items_per_cell, label: "One Location Batch" },
                  ],
                })}
                <button class="blue-button" type="submit" data-led-command-submit data-led-loading-label="Creating">Create Put Task</button>
              </form>
              <p class="muted">Can't find the item? <a href="/products?show_add=1">Add it to Products first</a>, then return to Put.</p>
              <p class="muted">
                ${selectedProduct ? `Selected product: ${escapeHtml(selectedProduct.name)}. ` : ""}
                ${selectedProduct ? `The planning batch is ${escapeHtml(formatQuantity(selectedProduct.items_per_cell))} ${escapeHtml(selectedProduct.unit_of_measure)} per location. You can enter a larger quantity; the system will split it across eligible locations when space is available. ` : ""}
                ${selectedCell ? `The system will try ${escapeHtml(selectedCell.logical_code)} first, then add more cells only if needed. ` : ""}
                After the task is created, follow the RED LED instructions and confirm where the items were placed.
              </p>
            `,
          )}
        </section>
        ${showCapacityRecovery ? renderPutCapacityRecovery(user, selectedProduct, returnTo, flash) : ""}
        ${renderCapacityRecommendationPrompt(url)}
      `,
    });
  }

  return {
    renderCatalogProductResults,
    renderMovementStockRows,
    renderPick,
    renderProductDetail,
    renderProducts,
    renderPut,
  };
}
