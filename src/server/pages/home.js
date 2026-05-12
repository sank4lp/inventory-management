import {
  getRecommendedActions,
  listProducts,
  listRecentTasksForUser,
  searchCells,
} from "../../services/inventory.js";
import {
  escapeHtml,
  formatDate,
  formatQuantity,
  quickActionLinks,
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
    const tasks = listRecentTasksForUser(db, user);
    const actions = getRecommendedActions(db).slice(0, 6);

    return page({
      title: "Home",
      user,
      flash,
      content: `
        <section class="overview-action-grid" aria-label="Primary workflows">
          <a class="overview-action-tile overview-action-pick" href="/pick" aria-label="Pick">
            <span>PICK</span>
          </a>
          <a class="overview-action-tile overview-action-put" href="/put" aria-label="Put">
            <span>PUT</span>
          </a>
          <a class="overview-action-tile overview-action-inventory" href="/products" aria-label="Inventory">
            <span>INVENTORY</span>
          </a>
          <a class="overview-action-tile overview-action-reports" href="/reports" aria-label="Reports">
            <span>REPORTS</span>
          </a>
        </section>
        <section class="overview-secondary-grid">
          <section class="secondary-panel" data-row-collapser data-row-limit="3" data-row-label="actions">
            <div class="secondary-panel-header">
              <h2>Recommended actions</h2>
              <a class="mini-link" href="/recommended-actions">Open all</a>
            </div>
            ${
              actions.length
                ? table(
                    ["Issue", "Why", "Action"],
                    actions.map((action) => [
                      `<strong>${escapeHtml(action.title)}</strong><br /><small>${escapeHtml(action.logicalCode)}</small>`,
                      escapeHtml(action.description),
                      `<a class="mini-link" href="/recommended-actions?key=${encodeURIComponent(action.key)}">Adjust</a>`,
                    ]),
                  )
                : `<p class="muted">No cell anomalies detected right now.</p>`
            }
          </section>
          <section class="secondary-panel recent-tasks-panel" data-row-collapser data-row-limit="3" data-row-label="tasks" data-row-toggle-style="glow">
            <div class="secondary-panel-header">
              <h2>Recent tasks</h2>
            </div>
            ${
              tasks.length
                ? table(
                    ["Task", "Product", "Type", "Status", "Started", "Correction"],
                    tasks.map((task) => [
                      `<a href="/tasks/${task.id}">#${task.id}</a>`,
                      `${escapeHtml(task.first_product_name || "—")}<br /><small>${escapeHtml(task.first_sku || "—")}</small>`,
                      statusBadge(task.type),
                      statusBadge(task.status),
                      escapeHtml(formatDate(task.started_at)),
                      `<a class="mini-link" href="/tasks/${task.id}?mode=edit">Correct</a>`,
                    ]),
                  )
                : `<p class="muted">No recent tasks yet.</p>`
            }
          </section>
        </section>
      `,
    });
  }

  return {
    renderHome,
    renderHomeCellResults,
    renderHomeProductResults,
  };
}
