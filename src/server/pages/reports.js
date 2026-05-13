import { buildReports } from "../../services/reports.js";
import {
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  statsGrid,
  statusBadge,
  table,
} from "./shared.js";

function formatDateTimeInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
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

function hoursAgo(hours, now) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function resolveReportRange(url) {
  const preset = url.searchParams.get("preset") || "";
  const now = new Date();
  let fromAt = null;
  let toAt = null;
  let from = url.searchParams.get("from") || "";
  let to = url.searchParams.get("to") || "";
  let label = "Custom range";

  if (preset === "last-1h") {
    fromAt = hoursAgo(1, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 1 hour";
  } else if (preset === "last-3h") {
    fromAt = hoursAgo(3, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 3 hours";
  } else if (preset === "last-6h") {
    fromAt = hoursAgo(6, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 6 hours";
  } else if (preset === "last-12h") {
    fromAt = hoursAgo(12, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 12 hours";
  } else if (preset === "last-24h") {
    fromAt = hoursAgo(24, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 24 hours";
  } else if (preset === "previous-day") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    fromAt = startOfDay(yesterday).toISOString();
    toAt = endOfDay(yesterday).toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(new Date(toAt));
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
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(new Date(toAt));
    label = "Previous week";
  } else if (preset === "previous-month") {
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    fromAt = startOfDay(previousMonthStart).toISOString();
    toAt = endOfDay(previousMonthEnd).toISOString();
    from = formatDateTimeInput(previousMonthStart);
    to = formatDateTimeInput(endOfDay(previousMonthEnd));
    label = "Previous month";
  } else {
    fromAt = toIsoOrNull(from);
    toAt = toIsoOrNull(to);
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

function sumRows(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

function reportCard(report) {
  return `
    <button
      type="button"
      class="report-overview-card report-overview-card-${escapeHtml(report.key)}"
      data-report-open="${escapeHtml(report.key)}"
      aria-haspopup="dialog"
      aria-controls="report-modal"
    >
      <span>${escapeHtml(report.title)}</span>
      <strong>${escapeHtml(report.metric)}</strong>
      <small>${escapeHtml(report.metricLabel)}</small>
      <em>Open report</em>
    </button>
  `;
}

function reportPrintOption(report) {
  return `
    <button type="button" class="report-print-option" data-report-print-option="${escapeHtml(report.key)}">
      <span>${escapeHtml(report.title)}</span>
      <small>${escapeHtml(report.metric)} ${escapeHtml(report.metricLabel)}</small>
    </button>
  `;
}

function reportTemplate(report, range, generatedAt) {
  return `
    <template
      data-report-template="${escapeHtml(report.key)}"
      data-report-title="${escapeHtml(report.title)}"
      data-report-description="${escapeHtml(report.description)}"
    >
      <article class="report-document" data-report-document="${escapeHtml(report.key)}">
        <header class="report-document-header">
          <div>
            <p class="report-document-kicker">Inventory report</p>
            <h3>${escapeHtml(report.title)}</h3>
            <p>${escapeHtml(report.description)}</p>
          </div>
          <dl class="report-document-meta">
            <div>
              <dt>Timeframe</dt>
              <dd>${escapeHtml(range.label)}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>${escapeHtml(formatDate(generatedAt))}</dd>
            </div>
          </dl>
        </header>
        ${report.body}
      </article>
    </template>
  `;
}

export function createReportsPages({ db }) {
  function renderReports(user, flash, url) {
    const range = resolveReportRange(url);
    const generatedAt = new Date().toISOString();
    const reports = buildReports(db, { fromAt: range.fromAt, toAt: range.toAt });
    const totalStock = sumRows(reports.stockSnapshot, "available");
    const netMovement = sumRows(reports.movementSummary, "net_change");
    const tasksInView = reports.recentTaskActivity.length;
    const issueCount = reports.exceptions.length + reports.adjustments.length;
    const reportSections = [
      {
        key: "stock-snapshot",
        title: "Stock snapshot",
        description: "Current available stock by product, printed with the selected timeframe for context.",
        metric: formatQuantity(reports.stockSnapshot.length),
        metricLabel: "products in view",
        body: table(
          ["Item", "Available"],
          reports.stockSnapshot.map((row) => [
            `${escapeHtml(row.name)}<br /><small>${escapeHtml(row.sku)}</small>`,
            escapeHtml(formatQuantity(row.available)),
          ]),
          "No stock is recorded yet.",
        ),
      },
      {
        key: "movement",
        title: "Movement",
        description: "Picked, put away, and net quantity changes in the selected timeframe.",
        metric: formatQuantity(netMovement),
        metricLabel: "net quantity change",
        body: table(
          ["Date", "Picked", "Put away", "Net change"],
          reports.movementSummary.map((row) => [
            escapeHtml(row.movement_date),
            escapeHtml(formatQuantity(row.picked)),
            escapeHtml(formatQuantity(row.put_away)),
            escapeHtml(formatQuantity(row.net_change)),
          ]),
          "No movements were recorded in this timeframe.",
        ),
      },
      {
        key: "team-activity",
        title: "Team activity",
        description: "Operator task creation, inventory transactions, and recent task activity.",
        metric: formatQuantity(reports.userActivity.length),
        metricLabel: "users listed",
        body: `
          <section class="report-document-section">
            <h4>Activity by user</h4>
            ${table(
              ["User", "Tasks created", "Transactions recorded"],
              reports.userActivity.map((row) => [
                escapeHtml(row.username),
                escapeHtml(formatQuantity(row.tasks_created)),
                escapeHtml(formatQuantity(row.transactions_recorded)),
              ]),
              "No user activity was recorded in this timeframe.",
            )}
          </section>
          <section class="report-document-section">
            <h4>Recent tasks</h4>
            ${table(
              ["Task", "Who", "What", "Status", "Started", "Completed"],
              reports.recentTaskActivity.map((row) => [
                `<a href="/tasks/${row.id}">#${row.id}</a>`,
                escapeHtml(row.username),
                `${escapeHtml(row.type.toUpperCase())}<br /><small>${escapeHtml(row.sku_list || row.summary)}</small>`,
                statusBadge(row.status),
                escapeHtml(formatDate(row.started_at)),
                escapeHtml(formatDate(row.completed_at)),
              ]),
              "No tasks were recorded in this timeframe.",
            )}
          </section>
        `,
      },
      {
        key: "issues",
        title: "Issues",
        description: "Task exceptions that may need follow-up before the stock record can be trusted.",
        metric: formatQuantity(reports.exceptions.length),
        metricLabel: "task exceptions",
        body: table(
          ["Task", "Item", "Cell", "Gap"],
          reports.exceptions.map((row) => [
            `<a href="/tasks/${row.task_id}">#${row.task_id}</a>`,
            `${escapeHtml(row.sku)}<br /><small>${escapeHtml(row.product_name)}</small>`,
            escapeHtml(row.logical_code),
            escapeHtml(formatQuantity(row.exception_quantity)),
          ]),
          "No task exceptions were recorded in this timeframe.",
        ),
      },
      {
        key: "adjustments",
        title: "Adjustments",
        description: "Manual count changes, including when they happened and why.",
        metric: formatQuantity(reports.adjustments.length),
        metricLabel: "count changes",
        body: table(
          ["When", "Item", "Cell", "Delta", "Reason"],
          reports.adjustments.map((row) => [
            escapeHtml(formatDate(row.created_at)),
            escapeHtml(row.sku),
            escapeHtml(row.logical_code),
            escapeHtml(formatQuantity(row.quantity_delta)),
            escapeHtml(row.reason),
          ]),
          "No adjustments were recorded in this timeframe.",
        ),
      },
    ];

    return page({
      title: "Reports",
      user,
      flash,
      content: `
        <section class="reports-workspace" data-reports-workspace>
          ${statsGrid([
            { label: "Available units", value: formatQuantity(totalStock) },
            { label: "Net movement", value: formatQuantity(netMovement) },
            { label: "Recent tasks", value: formatQuantity(tasksInView) },
            { label: "Issues + adjustments", value: formatQuantity(issueCount) },
          ])}
          <section class="report-command-panel app-panel">
            <div>
              <p class="report-eyebrow">Report center</p>
              <h2>Open one report at a time</h2>
              <p class="muted">Each card opens a focused report popup for ${escapeHtml(
                range.label.toLowerCase(),
              )} where the report uses time filtering. Use PRINT to choose a report and open the browser print menu.</p>
            </div>
            <button type="button" class="blue-button report-print-button" data-report-print-open>PRINT</button>
          </section>
          <section class="report-filter-panel app-panel" aria-label="Report timeframe">
            <div class="report-filter-header">
              <div>
                <p class="report-eyebrow">Selected time</p>
                <h2>${escapeHtml(range.label)}</h2>
              </div>
            </div>
            <div class="preset-row">
              <a class="preset-chip ${range.preset === "last-1h" ? "preset-chip-active" : ""}" href="${presetHref("last-1h")}">Last 1 hour</a>
              <a class="preset-chip ${range.preset === "last-3h" ? "preset-chip-active" : ""}" href="${presetHref("last-3h")}">Last 3 hours</a>
              <a class="preset-chip ${range.preset === "last-6h" ? "preset-chip-active" : ""}" href="${presetHref("last-6h")}">Last 6 hours</a>
              <a class="preset-chip ${range.preset === "last-12h" ? "preset-chip-active" : ""}" href="${presetHref("last-12h")}">Last 12 hours</a>
              <a class="preset-chip ${range.preset === "last-24h" ? "preset-chip-active" : ""}" href="${presetHref("last-24h")}">Last 24 hours</a>
              <a class="preset-chip ${range.preset === "previous-day" ? "preset-chip-active" : ""}" href="${presetHref("previous-day")}">Previous day</a>
              <a class="preset-chip ${range.preset === "previous-week" ? "preset-chip-active" : ""}" href="${presetHref("previous-week")}">Previous week</a>
              <a class="preset-chip ${range.preset === "previous-month" ? "preset-chip-active" : ""}" href="${presetHref("previous-month")}">Previous month</a>
              <a class="preset-chip ${!range.preset && !range.from && !range.to ? "preset-chip-active" : ""}" href="/reports">All time</a>
            </div>
            <form method="get" action="/reports" class="inline-form">
              <label>From <input type="datetime-local" name="from" value="${escapeHtml(range.from)}" /></label>
              <label>To <input type="datetime-local" name="to" value="${escapeHtml(range.to)}" /></label>
              <button type="submit">Apply</button>
            </form>
          </section>
          <section class="report-overview-grid" aria-label="Report sections">
            ${reportSections.map(reportCard).join("")}
          </section>
          <section class="report-template-library" hidden>
            ${reportSections.map((report) => reportTemplate(report, range, generatedAt)).join("")}
          </section>
          <section
            id="report-modal"
            class="modal-backdrop app-alert-modal report-modal"
            data-report-modal
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-modal-title"
            hidden
          >
            <div class="modal-panel report-modal-panel">
              <div class="modal-header">
                <div>
                  <p class="report-eyebrow">Report preview</p>
                  <h2 id="report-modal-title" data-report-modal-title>Report</h2>
                  <p class="muted" data-report-modal-description></p>
                </div>
                <button type="button" class="icon-button ghost-button" data-report-close aria-label="Close report" title="Close">x</button>
              </div>
              <div class="report-modal-meta">
                <span>Timeframe: ${escapeHtml(range.label)}</span>
                <span>Generated: ${escapeHtml(formatDate(generatedAt))}</span>
              </div>
              <div class="report-modal-content" data-report-modal-content></div>
              <div class="modal-actions report-modal-actions">
                <button type="button" class="blue-button" data-report-print-current>PRINT</button>
                <button type="button" class="ghost-button" data-report-close>Close</button>
              </div>
            </div>
          </section>
          <section
            class="modal-backdrop app-alert-modal report-print-menu"
            data-report-print-menu
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-print-title"
            hidden
          >
            <div class="modal-panel report-print-panel">
              <div class="modal-header">
                <div>
                  <p class="report-eyebrow">Print report</p>
                  <h2 id="report-print-title">Choose a report to print</h2>
                  <p class="muted">The selected report will open in the browser print menu for ${escapeHtml(
                    range.label.toLowerCase(),
                  )}.</p>
                </div>
                <button type="button" class="icon-button ghost-button" data-report-print-close aria-label="Close print menu" title="Close">x</button>
              </div>
              <div class="report-print-option-grid">
                ${reportSections.map(reportPrintOption).join("")}
              </div>
            </div>
          </section>
        </section>
      `,
    });
  }

  return { renderReports };
}
