import {
  dashboardStats,
  getRecommendedActions,
  listProducts,
  listRecentTasksForUser,
  searchCells,
} from "../../services/inventory.js";
import {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  quickActionLinks,
  statsGrid,
  statusBadge,
  table,
  page,
} from "./shared.js";

export function createHomePages({ db }) {
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

  return {
    renderHome,
    renderHomeCellResults,
    renderHomeProductResults,
  };
}
