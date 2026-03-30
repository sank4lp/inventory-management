import { listCells, listProducts } from "../../services/inventory.js";
import {
  card,
  cellPickerField,
  escapeHtml,
  formatQuantity,
  page,
  productPickerField,
  quickActionLinks,
  table,
} from "./shared.js";

export function createProductPages({ db }) {
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
                <input data-live-input name="q" value="${escapeHtml(search || "")}" placeholder="Search by SKU, name, or brand" />
                ${showAddProduct ? `<input type="hidden" name="show_add" value="1" />` : ""}
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
    const selectedCellId = Number(url.searchParams.get("cell_id") || 0);
    const selectedCell = selectedCellId
      ? listCells(db).find((cell) => cell.id === selectedCellId)
      : null;

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
                ${selectedCell ? `<input type="hidden" name="preferred_cell_id" value="${selectedCell.id}" />` : ""}
                <label>Requested quantity<input type="number" min="1" step="1" name="quantity" required /></label>
                <button class="green-button" type="submit">Create pick task</button>
              </form>
              <p class="muted">
                ${selectedProduct ? `Selected product: ${escapeHtml(selectedProduct.name)}. ` : ""}
                ${selectedCell ? `The system will try ${escapeHtml(selectedCell.logical_code)} first, then add more cells only if needed. ` : ""}
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
    const selectedCellId = Number(url.searchParams.get("cell_id") || 0);
    const selectedCell = selectedCellId
      ? listCells(db).find((cell) => cell.id === selectedCellId)
      : null;

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
                ${selectedCell ? `<input type="hidden" name="preferred_cell_id" value="${selectedCell.id}" />` : ""}
                <label>Quantity to place<input type="number" min="1" step="1" name="quantity" required /></label>
                <button class="blue-button" type="submit">Create put task</button>
              </form>
              <p class="muted">
                ${selectedProduct ? `Selected product: ${escapeHtml(selectedProduct.name)}. ` : ""}
                ${selectedCell ? `The system will try ${escapeHtml(selectedCell.logical_code)} first, then add more cells only if needed. ` : ""}
                The system suggests the nearest free cells and lights them in blue.
              </p>
            `,
          )}
        </section>
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
