import {
  getRecommendedActions,
  listRecentTasksForUser,
} from "../../services/inventory.js";
import {
  escapeHtml,
  formatDate,
  formatQuantity,
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
    optimize: `
      <path d="M4 7h6" />
      <path d="M14 7h6" />
      <path d="M4 12h10" />
      <path d="M18 12h2" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="12" cy="7" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="9" cy="17" r="2" />
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
  function recommendationSpaceLabel(action) {
    const count = Math.max(0, Number(action?.freedLocationCount || 0));
    return count > 0
      ? `Frees ${formatQuantity(count)} ${count === 1 ? "location" : "locations"}`
      : "No locations freed";
  }

  function recommendedActionLink(action) {
    return `/recommended-actions?key=${encodeURIComponent(action.key)}`;
  }

  function taskOwnerLink(user, task) {
    const label = task.created_by_name || task.created_by_username || `User #${task.created_by}`;
    const href = user.role === "admin" ? `/admin/users/${task.created_by}` : "/profile";
    return `<a class="mini-link" href="${href}">${escapeHtml(label)}</a>`;
  }

  function renderHome(user, flash, url) {
    const tasks = listRecentTasksForUser(db, user);
    const recommendedActions = getRecommendedActions(db);

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
          <a class="overview-action-tile overview-action-optimize" href="/recommended-actions" aria-label="Optimize Warehouse">
            ${overviewActionIcon("optimize")}
            <span class="overview-action-label">Optimize Warehouse</span>
          </a>
        </section>
        <section class="overview-secondary-grid overview-recent-grid">
          <section id="recent-tasks" class="secondary-panel recent-tasks-panel" data-row-collapser data-row-limit="3" data-row-label="tasks">
            <div class="secondary-panel-header">
              <h2>Recent Tasks</h2>
            </div>
            ${
              tasks.length
                ? table(
                    ["Task", "User", "Product", "Type", "Status", "Started", "Correction"],
                    tasks.map((task) => [
                      `<a href="/tasks/${task.id}">#${task.id}</a>`,
                      taskOwnerLink(user, task),
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
          ${
            recommendedActions.length
              ? `
                <section id="recommended-actions" class="secondary-panel overview-recommendations-panel">
                  <div class="secondary-panel-header">
                    <h2>Recommended Actions</h2>
                    <a class="mini-link" href="/recommended-actions">View All</a>
                  </div>
                  ${table(
                    ["Issue", "Location", "Product", "Next Step", "Space Created", "Action"],
                    recommendedActions.map((action) => [
                      `<strong>${escapeHtml(action.title)}</strong>`,
                      escapeHtml(action.logicalCode),
                      `${escapeHtml(action.productName || "—")}<br /><small>${escapeHtml(action.productSku || "—")}</small>`,
                      escapeHtml(action.actionSummary || `Move ${action.productSku} from ${action.logicalCode}.`),
                      `<span class="recommendation-space-badge ${Number(action.freedLocationCount || 0) > 0 ? "recommendation-space-badge-positive" : ""}">${escapeHtml(recommendationSpaceLabel(action))}</span>`,
                      `<a class="mini-link" href="${recommendedActionLink(action)}">Review</a>`,
                    ]),
                  )}
                </section>
              `
              : ""
          }
        </section>
      `,
    });
  }

  return {
    renderHome,
  };
}
