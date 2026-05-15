import {
  getCellDetail,
  getProductDetail,
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
      <fieldset class="quantity-shortcuts ${tone ? `quantity-shortcuts-${escapeHtml(tone)}` : ""}" aria-label="Quick quantity picker">
        <legend class="quantity-shortcuts-label">Quick quantity picker</legend>
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
              <h2 id="capacity-recommendation-title">Recommended action created</h2>
              <p class="muted">The capacity update created an inventory action you can review now or leave for later.</p>
            </div>
            <a class="mini-link" href="${escapeHtml(skipPath)}">Close</a>
          </div>
          <p><strong>${escapeHtml(action.title)}</strong></p>
          <p class="muted">${escapeHtml(action.actionSummary || `Move ${action.productSku} from ${action.logicalCode}.`)}</p>
          <div class="modal-actions">
            <a class="action-cta-button" href="${escapeHtml(reviewPath)}">Review recommendation</a>
            <a class="action-cta-button secondary-cta" href="${escapeHtml(skipPath)}">Skip for now</a>
          </div>
        </div>
      </section>
    `;
  }

  function productStatusRows(products) {
    return products.map((product) => [
      `<a href="/products/${product.id}">${escapeHtml(product.sku)}</a>`,
      `${escapeHtml(product.name)}<br /><small>${escapeHtml(product.brand)}</small>`,
      escapeHtml(formatQuantity(product.total_available)),
      escapeHtml(product.unit_of_measure),
      escapeHtml(formatQuantity(product.items_per_cell)),
    ]);
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
            ["SKU", "Name", "Available", "Unit", "Items/cell"],
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
        <span class="stat-action-hint">Open printable list</span>
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
              <p class="report-eyebrow">Product list</p>
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
            <button type="button" class="blue-button" data-report-print-current>PRINT</button>
            <button type="button" class="ghost-button" data-report-close>Close</button>
          </div>
        </div>
      </section>
    `;
  }

  function renderProducts(user, flash, search, showAddProduct) {
    const allProducts = listProducts(db);
    const products = listProducts(db, search);
    const stockedProducts = allProducts.filter((product) => Number(product.total_available || 0) > 0);
    const outOfStockProducts = allProducts.filter((product) => Number(product.total_available || 0) <= 0);
    const lowStockProducts = allProducts.filter(
      (product) =>
        Number(product.total_available || 0) > 0 &&
        Number(product.total_available || 0) <= Number(product.items_per_cell || 0),
    );
    const reportFormat = getReportFormatSettings(db);
    const generatedAt = new Date().toISOString();
    const productStatusReports = [
      {
        key: "catalog-items",
        label: "Catalog items",
        title: "Catalog Items",
        description: "All products currently registered in the catalog.",
        products: allProducts,
        emptyMessage: "No products have been added yet.",
      },
      {
        key: "in-stock",
        label: "In stock",
        title: "Products In Stock",
        description: "Products with available quantity greater than zero.",
        products: stockedProducts,
        emptyMessage: "No products currently have stock.",
      },
      {
        key: "low-stock",
        label: "Low stock",
        title: "Low Stock Products",
        description: "Products with stock at or below their ideal items-per-cell quantity.",
        products: lowStockProducts,
        emptyMessage: "No products are currently low on stock.",
      },
      {
        key: "out-of-stock",
        label: "Out of stock",
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
                      <h2 id="add-product-title">Add product</h2>
                      <p class="muted">Enter the fields operators need during pick and put. Optional catalog details can wait.</p>
                    </div>
                    <a class="mini-link" href="/products">Close</a>
                  </div>
                  <form method="post" action="/products" class="stack-form">
                    <div class="form-grid">
                      <label>SKU<input name="sku" autocomplete="off" autofocus required placeholder="ARMY-BOOT-001" /></label>
                      <label>Name<input name="name" required placeholder="Combat Boots" /></label>
                      <label>Brand<input name="brand" required placeholder="Supplier or brand" /></label>
                      <label>Unit of measure<input name="unit_of_measure" required placeholder="pieces, pairs, boxes" /></label>
                      <label>Items per location<input type="number" min="1" step="1" inputmode="numeric" name="items_per_cell" value="6" required /></label>
                    </div>
                    <details class="form-disclosure">
                      <summary>Optional catalog details</summary>
                      <div class="form-grid">
                        <label>Category<input name="category" placeholder="Footwear, medical, tools" /></label>
                        <label>Variant / Size<input name="variant" placeholder="Size 10, XL, red" /></label>
                      </div>
                    </details>
                    <div class="modal-actions">
                      <a class="mini-link" href="/products">Cancel</a>
                      <button type="submit" class="ghost-button" name="next_action" value="detail">Save product</button>
                      <button type="submit" class="blue-button" name="next_action" value="put">Save and put stock</button>
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
            <p class="muted">Available: ${escapeHtml(formatQuantity(product.total_available))} ${escapeHtml(product.unit_of_measure)}</p>
            <p class="muted">Ideal items per cell: ${escapeHtml(formatQuantity(product.items_per_cell))}</p>
            <div class="mini-actions">
              <a class="mini-link" href="/pick?product_id=${product.id}">Pick</a>
              <a class="mini-link" href="/put?product_id=${product.id}">Put</a>
            </div>
            ${
              user.role === "admin"
                ? `
                  <form method="post" action="/products/${product.id}/items-per-cell" class="inline-form top-gap">
                    <label>Items per cell
                      <input type="number" min="1" step="1" inputmode="numeric" name="items_per_cell" value="${escapeHtml(product.items_per_cell)}" required />
                    </label>
                    <button type="submit">Update capacity</button>
                  </form>
                  <p class="muted">The next put task will use this value to fill existing cells first and minimize new cells.</p>
                `
                : ""
            }
          `,
        )}
        ${card(
          "Locations holding this product",
          table(
            ["Cell", "Available", "Action"],
            product.locations.map((location) => [
              `<a href="/cells/${location.cell_id}">${escapeHtml(location.logical_code)}</a>`,
              escapeHtml(formatQuantity(location.available_quantity)),
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
              <form method="post" action="/pick" class="stack-form" data-led-command-form data-led-loading-label="Creating">
                ${productPickerField(
                  products,
                  selectedProductId,
                  "pick-product",
                  "product_id",
                  "",
                  hasPickableProducts,
                  { recencyKey: "movement-product" },
                )}
                ${selectedCell ? `<input type="hidden" name="preferred_cell_id" value="${selectedCell.id}" />` : ""}
                <label>Requested quantity
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
                    { value: 1, label: "Pick one" },
                    {
                      value: availableToPick,
                      label: selectedCell ? "Pick all in this location" : "Pick all available",
                    },
                  ],
                })}
                <button
                  class="green-button"
                  type="submit"
                  data-led-command-submit
                  data-led-loading-label="Creating"
                  ${hasPickableProducts ? "" : "disabled"}
                >Create pick task</button>
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
      <p><strong>Can adjust more in the cell?</strong> Update the items per cell for this product.</p>
      <p class="muted">Current capacity for ${escapeHtml(product.sku)} is ${escapeHtml(formatQuantity(product.items_per_cell))} item(s) per cell.</p>
    `;

    if (user.role !== "admin") {
      return `
        <section class="modal-backdrop app-alert-modal" role="dialog" aria-modal="true" aria-labelledby="put-capacity-title">
          <div class="modal-panel">
            <div class="modal-header">
              <div>
                <h2 id="put-capacity-title">Not enough cell capacity</h2>
                <p class="muted">${escapeHtml(flash?.message || "The requested quantity cannot fit in the available cells.")}</p>
              </div>
              <a class="mini-link" href="${escapeHtml(returnTo)}">Close</a>
            </div>
            ${message}
            <p class="flash flash-warning">Admin access is required to update product capacity.</p>
          </div>
        </section>
      `;
    }

    return `
      <section class="modal-backdrop app-alert-modal" role="dialog" aria-modal="true" aria-labelledby="put-capacity-title">
        <div class="modal-panel">
          <div class="modal-header">
            <div>
              <h2 id="put-capacity-title">Not enough cell capacity</h2>
              <p class="muted">${escapeHtml(flash?.message || "The requested quantity cannot fit in the available cells.")}</p>
            </div>
            <a class="mini-link" href="${escapeHtml(returnTo)}">Close</a>
          </div>
          ${message}
          <form method="post" action="/products/${product.id}/items-per-cell" class="inline-form">
            <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
            <label>Items per cell
              <input type="number" min="1" step="1" name="items_per_cell" value="${escapeHtml(product.items_per_cell)}" required />
            </label>
            <button type="submit">Update items per cell</button>
          </form>
        </div>
      </section>
    `;
  }

  function renderPutProductStockSummary(product) {
    if (!product) {
      return "";
    }

    const totalAvailable = Number(product.total_available || 0);
    return `
      <section class="put-stock-summary" aria-label="Selected product stock summary">
        <div class="put-stock-summary-header">
          <div>
            <strong>Current stock</strong>
            <span>${escapeHtml(product.sku)} · ${escapeHtml(product.name)}</span>
          </div>
          <div class="put-stock-total">
            ${escapeHtml(formatQuantity(totalAvailable))}
            <span>${escapeHtml(product.unit_of_measure)}</span>
          </div>
        </div>
        ${
          product.locations.length
            ? table(
                ["Cell", "Quantity"],
                product.locations.map((location) => [
                  escapeHtml(location.logical_code),
                  `${escapeHtml(formatQuantity(location.available_quantity))} ${escapeHtml(product.unit_of_measure)}`,
                ]),
              )
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
    const selectedProductDetail = selectedProductId ? getProductDetail(db, selectedProductId) : null;
    const selectedCellId = Number(url.searchParams.get("cell_id") || 0);
    const selectedCell = selectedCellId
      ? listCells(db).find((cell) => cell.id === selectedCellId)
      : null;
    const requestedQuantity = url.searchParams.get("quantity") || "";
    const showCapacityRecovery = url.searchParams.get("capacity_help") === "1" && selectedProduct;
    const returnTo = putRetryReturnPath({ selectedProductId, selectedCellId, requestedQuantity });

    return page({
      title: "Put",
      user,
      flash: showCapacityRecovery ? null : flash,
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
              <form method="post" action="/put" class="stack-form" data-led-command-form data-led-loading-label="Creating" data-put-product-summary-form>
                ${productPickerField(products, selectedProductId, "put-product", "product_id", "", true, {
                  recencyKey: "movement-product",
                })}
                ${renderPutProductStockSummary(selectedProductDetail)}
                ${selectedCell ? `<input type="hidden" name="preferred_cell_id" value="${selectedCell.id}" />` : ""}
                <label>Quantity to place<input type="number" min="1" step="1" inputmode="numeric" name="quantity" value="${escapeHtml(requestedQuantity)}" required /></label>
                ${renderQuantityShortcuts({
                  tone: "put",
                  shortcuts: [
                    { value: 1, label: "Put one" },
                    { value: selectedProduct?.items_per_cell, label: "Full location capacity" },
                  ],
                })}
                <button class="blue-button" type="submit" data-led-command-submit data-led-loading-label="Creating">Create put task</button>
              </form>
              <p class="muted">Can't find the item? <a href="/products?show_add=1">Add it to Products first</a>, then return to Put.</p>
              <p class="muted">
                ${selectedProduct ? `Selected product: ${escapeHtml(selectedProduct.name)}. ` : ""}
                ${selectedProduct ? `Usual capacity is ${escapeHtml(formatQuantity(selectedProduct.items_per_cell))} ${escapeHtml(selectedProduct.unit_of_measure)} per location. ` : ""}
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
    renderPick,
    renderProductDetail,
    renderProducts,
    renderPut,
  };
}
