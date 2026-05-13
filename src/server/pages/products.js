import { getCellDetail, listCells, listProducts } from "../../services/inventory.js";
import {
  card,
  cellPickerField,
  escapeHtml,
  formatQuantity,
  page,
  productPickerField,
  quickActionLinks,
  statsGrid,
  table,
} from "./shared.js";

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

  function renderQuantityShortcuts(values) {
    const quantities = uniquePositiveQuantities(values);
    if (!quantities.length) {
      return "";
    }

    return `
      <div class="quantity-shortcuts" aria-label="Quick quantities">
        <span>Quick quantity</span>
        ${quantities
          .map(
            (value) => `
              <button type="button" class="ghost-button quantity-chip" data-fill-quantity="${escapeHtml(value)}">
                ${escapeHtml(formatQuantity(value))}
              </button>
            `,
          )
          .join("")}
      </div>
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

  function renderProducts(user, flash, search, showAddProduct) {
    const allProducts = listProducts(db);
    const products = listProducts(db, search);
    const stockedCount = allProducts.filter((product) => Number(product.total_available || 0) > 0).length;
    const outOfStockCount = allProducts.filter((product) => Number(product.total_available || 0) <= 0).length;
    const lowStockCount = allProducts.filter(
      (product) =>
        Number(product.total_available || 0) > 0 &&
        Number(product.total_available || 0) <= Number(product.items_per_cell || 0),
    ).length;

    return page({
      title: "Products",
      user,
      flash,
      content: `
        ${statsGrid([
          { label: "Catalog items", value: formatQuantity(allProducts.length) },
          { label: "In stock", value: formatQuantity(stockedCount) },
          { label: "Low stock", value: formatQuantity(lowStockCount) },
          { label: "Out of stock", value: formatQuantity(outOfStockCount) },
        ])}
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
      `,
    });
  }

  function renderPick(user, flash, url) {
    const allProducts = listProducts(db);
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
                ${renderQuantityShortcuts([1, availableToPick])}
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

  function renderPut(user, flash, url) {
    const products = listProducts(db);
    const selectedProductId = Number(url.searchParams.get("product_id") || 0);
    const selectedProduct = selectedProductId
      ? products.find((product) => product.id === selectedProductId)
      : null;
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
              <form method="post" action="/put" class="stack-form" data-led-command-form data-led-loading-label="Creating">
                ${productPickerField(products, selectedProductId, "put-product")}
                ${selectedCell ? `<input type="hidden" name="preferred_cell_id" value="${selectedCell.id}" />` : ""}
                <label>Quantity to place<input type="number" min="1" step="1" inputmode="numeric" name="quantity" value="${escapeHtml(requestedQuantity)}" required /></label>
                ${renderQuantityShortcuts([
                  1,
                  selectedProduct?.items_per_cell,
                ])}
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
