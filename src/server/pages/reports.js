import { buildReports } from "../../services/reports.js";
import {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
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

export function createReportsPages({ db }) {
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
            <p class="muted">A simple operational summary for ${escapeHtml(range.label.toLowerCase())}, with date and time precision.</p>
          `,
        )}
        ${card(
          "Stock snapshot",
          table(
            ["Item", "Available"],
            reports.stockSnapshot.map((row) => [
              `${escapeHtml(row.name)}<br /><small>${escapeHtml(row.sku)}</small>`,
              escapeHtml(formatQuantity(row.available)),
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
          "Recent activity",
          table(
            ["Task", "Who", "What", "Status", "Started", "Completed"],
            reports.recentTaskActivity.map((row) => [
              `<a href="/tasks/${row.id}">#${row.id}</a>`,
              escapeHtml(row.username),
              `${escapeHtml(row.type.toUpperCase())}<br /><small>${escapeHtml(row.sku_list || row.summary)}</small>`,
              statusBadge(row.status),
              escapeHtml(formatDate(row.started_at)),
              escapeHtml(formatDate(row.completed_at)),
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

  return { renderReports };
}
