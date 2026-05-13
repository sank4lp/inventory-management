import {
  listRecentTasksForUser,
} from "../../services/inventory.js";
import {
  escapeHtml,
  formatDate,
  statusBadge,
  table,
  page,
} from "./shared.js";

function overviewActionIcon(type) {
  const icons = {
    pick: `
      <path d="M7 7h10" />
      <path d="M9 3h6l1 4H8l1-4Z" />
      <path d="M7 7l-1 13h12L17 7" />
      <path d="m14 12-4 4" />
      <path d="M10 12h4v4" />
    `,
    put: `
      <path d="M4 17h16" />
      <path d="M7 17V7h10v10" />
      <path d="M9 7l3-3 3 3" />
      <path d="M12 4v9" />
    `,
    inventory: `
      <path d="M4 7.5 12 3l8 4.5-8 4.5L4 7.5Z" />
      <path d="M4 7.5v9L12 21l8-4.5v-9" />
      <path d="M12 12v9" />
    `,
    reports: `
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 15v-4" />
      <path d="M12 15V8" />
      <path d="M16 15v-6" />
    `,
  };

  return `
    <span class="overview-action-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        ${icons[type] || icons.inventory}
      </svg>
    </span>
  `;
}

export function createHomePages({ db }) {
  function renderHome(user, flash, url) {
    const tasks = listRecentTasksForUser(db, user);

    return page({
      title: "Overview",
      user,
      flash,
      content: `
        <section class="overview-action-grid" aria-label="Primary workflows">
          <a class="overview-action-tile overview-action-pick" href="/pick" aria-label="Pick">
            ${overviewActionIcon("pick")}
            <span class="overview-action-label">Pick</span>
          </a>
          <a class="overview-action-tile overview-action-put" href="/put" aria-label="Put">
            ${overviewActionIcon("put")}
            <span class="overview-action-label">Put</span>
          </a>
          <a class="overview-action-tile overview-action-inventory" href="/products" aria-label="Inventory">
            ${overviewActionIcon("inventory")}
            <span class="overview-action-label">Inventory</span>
          </a>
          <a class="overview-action-tile overview-action-reports" href="/reports" aria-label="Reports">
            ${overviewActionIcon("reports")}
            <span class="overview-action-label">Reports</span>
          </a>
        </section>
        <section class="overview-secondary-grid overview-recent-grid">
          <section class="secondary-panel recent-tasks-panel" data-row-collapser data-row-limit="3" data-row-label="tasks">
            <div class="secondary-panel-header">
              <h2>Recent Tasks</h2>
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
                      task.status === "completed"
                        ? `<a class="mini-link" href="/tasks/${task.id}?mode=edit">Correct</a>`
                        : `<span class="muted">—</span>`,
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
  };
}
