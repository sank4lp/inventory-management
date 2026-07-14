import * as reportServices from "../../services/reports.js";
import {
  getReportFormatSettings,
  reportFormatStyle,
} from "../../services/report-format.js";
import {
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  table,
} from "./shared.js";
import { getRuntimeContext } from "../runtime-context.js";
import { renderReportFormatEditor } from "./report-format-editor.js";

const {
  buildExceptionsReport,
  buildMovementOverTimeReport,
  buildProductMovementReport,
  buildReports,
} = reportServices;

const REPORT_TIME_OPTIONS = [
  ["last-1h", "Last 1 Hour"],
  ["last-3h", "Last 3 Hours"],
  ["last-6h", "Last 6 Hours"],
  ["last-12h", "Last 12 Hours"],
  ["last-24h", "Last 24 Hours"],
  ["last-7d", "Last 7 Days"],
  ["last-30d", "Last 30 Days"],
  ["last-90d", "Last 90 Days"],
  ["previous-day", "Previous Day"],
  ["previous-week", "Previous Week"],
  ["previous-month", "Previous Month"],
  ["all-time", "All Time"],
  ["custom", "Custom"],
];

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

function daysAgo(days, now) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
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

function resolveReportRange(url, defaultDays = 30) {
  const hasExplicitRange =
    url.searchParams.has("preset") || url.searchParams.has("from") || url.searchParams.has("to");
  const preset = url.searchParams.get("preset") || (hasExplicitRange ? "" : `last-${defaultDays}d`);
  const now = new Date();
  let fromAt = null;
  let toAt = null;
  let from = url.searchParams.get("from") || "";
  let to = url.searchParams.get("to") || "";
  let label = "Custom Range";
  let error = "";

  if (preset === "last-1h") {
    fromAt = hoursAgo(1, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 1 Hour";
  } else if (preset === "last-3h") {
    fromAt = hoursAgo(3, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 3 Hours";
  } else if (preset === "last-6h") {
    fromAt = hoursAgo(6, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 6 Hours";
  } else if (preset === "last-12h") {
    fromAt = hoursAgo(12, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 12 Hours";
  } else if (preset === "last-24h") {
    fromAt = hoursAgo(24, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 24 Hours";
  } else if (preset === "last-7d") {
    fromAt = daysAgo(7, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 7 Days";
  } else if (preset === "last-30d") {
    fromAt = daysAgo(30, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 30 Days";
  } else if (preset === "last-90d") {
    fromAt = daysAgo(90, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = "Last 90 Days";
  } else if (/^last-\d+d$/.test(preset)) {
    const days = Number(preset.match(/^last-(\d+)d$/)?.[1] || defaultDays);
    fromAt = daysAgo(days, now).toISOString();
    toAt = now.toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(now);
    label = `Last ${days} Days`;
  } else if (preset === "previous-day") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    fromAt = startOfDay(yesterday).toISOString();
    toAt = endOfDay(yesterday).toISOString();
    from = formatDateTimeInput(new Date(fromAt));
    to = formatDateTimeInput(new Date(toAt));
    label = "Previous Day";
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
    label = "Previous Week";
  } else if (preset === "previous-month") {
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    fromAt = startOfDay(previousMonthStart).toISOString();
    toAt = endOfDay(previousMonthEnd).toISOString();
    from = formatDateTimeInput(previousMonthStart);
    to = formatDateTimeInput(endOfDay(previousMonthEnd));
    label = "Previous Month";
  } else if (preset === "all-time") {
    label = "All Time";
  } else {
    fromAt = toIsoOrNull(from);
    toAt = toIsoOrNull(to);
    if (from && !fromAt) {
      error = "The start time was not valid, so the report starts from the beginning.";
      from = "";
    }
    if (to && !toAt) {
      error = error || "The end time was not valid, so the report runs through now.";
      to = "";
    }
    if (fromAt && toAt && new Date(fromAt).getTime() > new Date(toAt).getTime()) {
      [fromAt, toAt] = [toAt, fromAt];
      [from, to] = [to, from];
      error = "The start was after the end, so the dates were corrected automatically.";
    }
    if (!from && !to) {
      label = "All Time";
    }
  }

  return {
    preset,
    from,
    to,
    fromAt,
    toAt,
    label,
    error,
  };
}

function selectedTimePreset(range) {
  if (REPORT_TIME_OPTIONS.some(([value]) => value === range?.preset)) {
    return range.preset;
  }
  if (range?.from || range?.to || range?.label === "Custom Range") {
    return "custom";
  }
  return range?.label === "All Time" ? "all-time" : "custom";
}

function reportTimeButtonLabel(range) {
  return range?.label === "Custom Range" ? "Custom" : range?.label || "Select Time";
}

function reportRangeLabel(range) {
  if (range?.label !== "Custom Range") {
    return range?.label || "All Time";
  }
  const from = range.fromAt ? formatDate(range.fromAt) : "Beginning";
  const to = range.toAt ? formatDate(range.toAt) : "Now";
  return `Custom · ${from} – ${to}`;
}

function renderReportToolbarControls(range) {
  const selectedPreset = selectedTimePreset(range);
  return `
    <div class="report-stage-context-actions" data-report-stage-context-actions>
      <div class="report-toolbar-control" data-report-visuals-control hidden>
        <button
          type="button"
          class="ghost-button"
          data-report-visuals-toggle
          aria-expanded="false"
          aria-haspopup="true"
          title="Choose report visuals"
        >Visuals</button>
        <div class="report-toolbar-popover" data-report-visuals-panel hidden>
          <header>
            <strong>Visuals</strong>
            <span>Choose which charts appear and print.</span>
          </header>
          <div class="report-toolbar-options" data-report-visuals-options></div>
          <div class="report-toolbar-popover-actions">
            <button type="button" class="ghost-button" data-report-visuals-none>Table only</button>
          </div>
        </div>
      </div>
      <div class="report-toolbar-control" data-report-filters-control hidden>
        <button
          type="button"
          class="ghost-button"
          data-report-filters-toggle
          aria-expanded="false"
          aria-haspopup="true"
          title="Filter report units"
        >Filters</button>
        <div class="report-toolbar-popover" data-report-filters-panel hidden>
          <header>
            <strong>Unit Filters</strong>
            <span>Select one or more units to include.</span>
          </header>
          <div class="report-toolbar-options" data-report-filters-options></div>
          <div class="report-toolbar-popover-actions">
            <button type="button" class="ghost-button" data-report-filters-none>Clear</button>
          </div>
        </div>
      </div>
      <div class="report-toolbar-control report-time-control" data-report-time-control>
        <button
          type="button"
          class="ghost-button report-time-toggle"
          data-report-time-toggle
          aria-expanded="false"
          aria-haspopup="true"
          title="Change selected time range"
        >${escapeHtml(reportTimeButtonLabel(range))}</button>
        <div class="report-toolbar-popover report-time-panel" data-report-time-panel hidden>
          <header>
            <strong>Select Time</strong>
            <span>Built-in activity reports use this range.</span>
          </header>
          <form method="get" action="/reports" data-report-time-form>
            <label>
              <span>Time range</span>
              <select name="preset" data-report-time-preset>
                ${REPORT_TIME_OPTIONS.map(
                  ([value, label]) => `<option value="${value}" ${selectedPreset === value ? "selected" : ""}>${label}</option>`,
                ).join("")}
              </select>
            </label>
            <div class="report-time-custom-fields" data-report-custom-time-fields ${selectedPreset === "custom" ? "" : "hidden"}>
              <label>From
                <input type="datetime-local" name="from" value="${escapeHtml(range.from)}" required />
              </label>
              <label>To
                <input type="datetime-local" name="to" value="${escapeHtml(range.to)}" required />
              </label>
            </div>
            ${range.error ? `<p class="report-time-error" role="status" data-report-time-error>${escapeHtml(range.error)}</p>` : ""}
            <p>The selected timeframe appears on the report and in print.</p>
            <button type="submit" class="blue-button">Apply</button>
          </form>
        </div>
      </div>
    </div>
  `;
}

function formatEditorReturnTo(url) {
  const next = new URL(url.pathname + url.search, "http://localhost");
  next.searchParams.set("format", "1");
  next.searchParams.delete("flash");
  next.searchParams.delete("tone");
  return `${next.pathname}${next.search}`;
}

function sumRows(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return 0;
}

function normalizeProductMovement(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.rows)
      ? value.rows
      : Array.isArray(value?.products)
        ? value.products
        : [];

  return source.filter((row) => row && typeof row === "object").map((row) => {
    const quantityUnavailable = row.quantity_comparison === "separate_by_unit";
    const picked = quantityUnavailable
      ? null
      : firstFiniteNumber(
          row.picked_quantity,
          row.quantity_picked,
          row.picked,
          row.total_picked,
        );
    const putAway = quantityUnavailable
      ? null
      : firstFiniteNumber(
          row.put_quantity,
          row.put_away_quantity,
          row.quantity_put,
          row.put_away,
          row.total_put,
        );
    const pickFrequency = firstFiniteNumber(
      row.pick_frequency,
      row.pick_task_count,
      row.pick_count,
      row.times_picked,
    );
    const putFrequency = firstFiniteNumber(
      row.put_frequency,
      row.put_task_count,
      row.put_count,
      row.times_put,
    );

    return {
      sku: String(row.sku || row.product_sku || "").trim(),
      name: String(row.name || row.product_name || row.sku || "Unnamed product").trim(),
      category: String(row.category || "Uncategorized").trim(),
      customFieldValue: String(row.custom_field_value || "").trim(),
      unit: String(row.unit_of_measure || row.unit || row.uom || "").trim(),
      units: Array.isArray(row.units) ? row.units.map((unit) => String(unit)) : [],
      quantityComparison: row.quantity_comparison || "comparable",
      picked,
      putAway,
      pickFrequency,
      putFrequency,
      available: quantityUnavailable
        ? null
        : firstFiniteNumber(row.available_quantity, row.available, row.current_stock),
      totalHandled: quantityUnavailable
        ? null
        : firstFiniteNumber(row.total_handled, picked + putAway),
      netOutflow: quantityUnavailable
        ? null
        : firstFiniteNumber(row.net_outflow, picked - putAway),
    };
  });
}

function highestRow(rows, field) {
  return rows.reduce(
    (highest, row) => (!highest || Number(row[field] || 0) > Number(highest[field] || 0) ? row : highest),
    null,
  );
}

function quantityWithUnit(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }
  return `${formatQuantity(value)}${unit ? ` ${unit}` : ""}`;
}

function movementQuantityValue(row, value) {
  return row?.quantityComparison === "separate_by_unit"
    ? "Separated by unit"
    : quantityWithUnit(value, row?.unit);
}

function compositionUnitToken(value) {
  return String(value || "").trim().toLocaleLowerCase("en");
}

function reportKpiGrid(items) {
  return `
    <section class="report-kpi-grid" aria-label="Report highlights">
      ${items
        .map(
          (item) => `
            <article
              class="report-kpi"
              ${item.key ? `data-report-summary-item="${escapeHtml(item.key)}"` : ""}
            >
              <span>${escapeHtml(item.label)}</span>
              <strong ${item.key ? "data-report-summary-value" : ""}>${escapeHtml(item.value)}</strong>
              ${item.detail ? `<small ${item.key ? "data-report-summary-detail" : ""}>${escapeHtml(item.detail)}</small>` : ""}
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

function reportSummaryTable(items) {
  return `
    <div class="report-summary-table-wrap">
      <table class="report-summary-table" aria-label="Report summary">
        <thead>
          <tr>
            <th>Measure</th>
            <th>Value</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (item) => `
                <tr data-report-summary-item="${escapeHtml(item.key)}">
                  <th scope="row">${escapeHtml(item.label)}</th>
                  <td data-report-summary-value>${escapeHtml(item.value)}</td>
                  <td data-report-summary-detail>${escapeHtml(item.detail || "")}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function horizontalBarChart(
  rows,
  {
    key,
    title,
    description,
    valueField,
    valueLabel,
    compact = false,
    unitToken = "",
    preserveOrder = false,
    emptyText = "No matching values are available for this report.",
  },
) {
  const availableRows = [...rows].filter((row) => Number.isFinite(Number(row[valueField] ?? 0)));
  const rankedRows = preserveOrder
    ? availableRows
    : availableRows
        .sort((left, right) => Number(right[valueField] || 0) - Number(left[valueField] || 0));

  if (!rankedRows.length) {
    return `
      <section
        class="report-chart report-chart-empty ${compact ? "report-chart-compact" : ""}"
        aria-label="${escapeHtml(title)}"
        ${unitToken ? `data-report-visual-unit="${escapeHtml(unitToken)}"` : ""}
      >
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(emptyText)}</p>
      </section>
    `;
  }

  const chartWidth = compact ? 560 : 760;
  const plotStart = compact ? 145 : 220;
  const plotWidth = compact ? 280 : 410;
  const rowHeight = compact ? 30 : 44;
  const chartTop = compact ? 18 : 42;
  const chartHeight = chartTop + rankedRows.length * rowHeight + (compact ? 10 : 20);
  const barHeight = compact ? 12 : 20;
  const maximum = Math.max(
    ...rankedRows.map((row) => Math.abs(Number(row[valueField] || 0))),
    1,
  );
  const titleId = `${key}-chart-title`;
  const descriptionId = `${key}-chart-description`;

  return `
    <figure
      class="report-chart ${compact ? "report-chart-compact" : ""}"
      ${unitToken ? `data-report-visual-unit="${escapeHtml(unitToken)}"` : ""}
    >
      <h4 id="${escapeHtml(titleId)}">${escapeHtml(title)}</h4>
      <p id="${escapeHtml(descriptionId)}" class="${compact ? "sr-only" : "report-chart-description"}">${escapeHtml(description)}</p>
      <svg
        class="report-bar-chart"
        viewBox="0 0 ${chartWidth} ${chartHeight}"
        role="img"
        aria-labelledby="${escapeHtml(titleId)} ${escapeHtml(descriptionId)}"
      >
        ${rankedRows
          .map((row, index) => {
            const value = Number(row[valueField] || 0);
            const barWidth = Math.max(2, Math.round((Math.abs(value) / maximum) * plotWidth));
            const y = chartTop + index * rowHeight;
            const nameLimit = compact ? 19 : 27;
            const shortName = row.name.length > nameLimit
              ? `${row.name.slice(0, nameLimit - 3).trimEnd()}...`
              : row.name;
            return `
              <g class="report-bar-row">
                <text class="report-bar-label" x="0" y="${y + (compact ? 12 : 18)}">${escapeHtml(shortName)}</text>
                <line class="report-bar-guide" x1="${plotStart}" x2="${plotStart + plotWidth}" y1="${y + (compact ? 8 : 13)}" y2="${y + (compact ? 8 : 13)}" />
                <rect class="report-bar${value < 0 ? " report-bar-negative" : ""}" x="${plotStart}" y="${y + (compact ? 2 : 3)}" width="${barWidth}" height="${barHeight}" rx="${compact ? 2 : 3}" />
                <text class="report-bar-value" x="${Math.min(plotStart + barWidth + 8, compact ? 455 : 650)}" y="${y + (compact ? 12 : 18)}">${escapeHtml(
                  valueLabel(row),
                )}</text>
              </g>
            `;
          })
          .join("")}
      </svg>
    </figure>
  `;
}

const DONUT_COLORS = ["#3158e8", "#0f8f7a", "#b45309", "#7c3aed", "#b42318", "#667085", "#0891b2", "#475467", "#98a2b3"];

function svgSafeId(value) {
  return String(value || "chart").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function percentageLabel(value, sourceValue = null) {
  const number = Number(value || 0);
  if (number === 0 && Number(sourceValue || 0) > 0) {
    return "<0.1%";
  }
  return `${number.toFixed(1).replace(/\.0$/, "")}%`;
}

function donutPattern(id, index, color) {
  const pattern = index % 6;
  const overlay = pattern === 0
    ? ""
    : pattern === 1
      ? `<path d="M-2 8 8-2M2 12 12 2" stroke="#ffffff" stroke-width="1.4" opacity="0.8" />`
      : pattern === 2
        ? `<path d="M0 3h10M0 8h10" stroke="#ffffff" stroke-width="1.2" opacity="0.78" />`
        : pattern === 3
          ? `<path d="M-2 8 8-2M2 12 12 2M-2 2 8 12M2-2 12 8" stroke="#ffffff" stroke-width="1" opacity="0.72" />`
          : pattern === 4
            ? `<circle cx="2.5" cy="2.5" r="1.2" fill="#ffffff" opacity="0.82" /><circle cx="7.5" cy="7.5" r="1.2" fill="#ffffff" opacity="0.82" />`
            : `<path d="M-2 8 8-2M0 10 10 0M2 12 12 2" stroke="#ffffff" stroke-width="1.8" opacity="0.8" />`;
  return `
    <pattern id="${escapeHtml(id)}" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="${color}" />
      ${overlay}
    </pattern>
  `;
}

function donutChart(
  share,
  { key, title, description, compact = false, unitToken = "" },
) {
  const slices = Array.isArray(share?.slices)
    ? share.slices.filter((slice) => Number(slice.value || 0) > 0)
    : [];
  if (!slices.length || Number(share?.total || 0) <= 0) {
    return `
      <section
        class="report-chart report-chart-empty ${compact ? "report-chart-compact" : ""}"
        aria-label="${escapeHtml(title)}"
        ${unitToken ? `data-report-visual-unit="${escapeHtml(unitToken)}"` : ""}
      >
        <h4>${escapeHtml(title)}</h4>
        <p>No on-hand stock is available for this composition.</p>
      </section>
    `;
  }

  const safeKey = svgSafeId(key);
  const titleId = `${safeKey}-donut-title`;
  const descriptionId = `${safeKey}-donut-description`;
  const center = 110;
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const largest = slices.reduce(
    (current, slice) => Number(slice.value || 0) > Number(current?.value || 0) ? slice : current,
    null,
  );
  const unit = String(share.unitOfMeasure || "").trim();
  const accessibleDescription = largest
    ? `${largest.label} is the largest share at ${percentageLabel(largest.percentage)}, or ${quantityWithUnit(largest.value, unit)}.`
    : description;

  return `
    <figure
      class="report-chart report-donut-chart ${compact ? "report-chart-compact" : ""}"
      ${unitToken ? `data-report-visual-unit="${escapeHtml(unitToken)}"` : ""}
    >
      <figcaption>
        <h4 id="${escapeHtml(titleId)}">${escapeHtml(title)}</h4>
        <p id="${escapeHtml(descriptionId)}" class="${compact ? "sr-only" : "report-chart-description"}">${escapeHtml(description)}</p>
      </figcaption>
      <div class="report-donut-layout">
        <svg
          class="report-donut-svg"
          viewBox="0 0 220 220"
          role="img"
          aria-labelledby="${escapeHtml(titleId)} ${escapeHtml(descriptionId)}"
        >
          <title>${escapeHtml(title)}</title>
          <desc>${escapeHtml(accessibleDescription)}</desc>
          <defs>
            ${slices
              .map((slice, index) => donutPattern(`${safeKey}-pattern-${index}`, index, DONUT_COLORS[index % DONUT_COLORS.length]))
              .join("")}
          </defs>
          <circle class="report-donut-track" cx="${center}" cy="${center}" r="${radius}" />
          ${slices
            .map((slice, index) => {
              const segment = Math.max(
                0,
                Math.min(
                  circumference,
                  (Number(slice.value || 0) / Number(share.total || 1)) * circumference,
                ),
              );
              const visibleSegment = Math.max(0, segment - Math.min(1.6, segment * 0.08));
              const dashOffset = -offset;
              offset += segment;
              return `
                <circle
                  class="report-donut-slice"
                  cx="${center}"
                  cy="${center}"
                  r="${radius}"
                  stroke="url(#${escapeHtml(`${safeKey}-pattern-${index}`)})"
                  stroke-dasharray="${visibleSegment.toFixed(3)} ${(circumference - visibleSegment).toFixed(3)}"
                  stroke-dashoffset="${dashOffset.toFixed(3)}"
                  transform="rotate(-90 ${center} ${center})"
                />
              `;
            })
            .join("")}
          <text class="report-donut-center-label" x="${center}" y="${center - 5}" text-anchor="middle">On hand</text>
          <text class="report-donut-center-value" x="${center}" y="${center + 17}" text-anchor="middle">${escapeHtml(formatQuantity(share.total))}</text>
          ${unit ? `<text class="report-donut-center-unit" x="${center}" y="${center + 34}" text-anchor="middle">${escapeHtml(unit)}</text>` : ""}
        </svg>
        <ol class="report-donut-legend" aria-label="Composition values">
          ${slices
            .map(
              (slice, index) => `
                <li>
                  <span class="report-donut-swatch report-donut-tone-${index % DONUT_COLORS.length}" aria-hidden="true"></span>
                  <span class="report-donut-legend-copy">
                    <strong>${escapeHtml(slice.label || "Unnamed group")}</strong>
                    <small>${escapeHtml(quantityWithUnit(slice.value, unit))}</small>
                  </span>
                  <span class="report-donut-percentage">${escapeHtml(percentageLabel(slice.percentage, slice.value))}</span>
                </li>
              `,
            )
            .join("")}
        </ol>
      </div>
    </figure>
  `;
}

function normalizeCompositionRows(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.rows)
      ? value.rows
      : [];
  return source.filter((row) => row && typeof row === "object").map((row) => ({
    key: String(row.key || row.product_id || row.label || row.name || ""),
    productId: Number(row.product_id ?? row.productId ?? 0) || null,
    sku: String(row.sku || "").trim(),
    name: String(row.label || row.name || row.custom_field_value || row.category || row.sku || "Unnamed group").trim(),
    brand: String(row.brand || "").trim(),
    category: String(row.category || "Uncategorized").trim(),
    variant: String(row.variant || "").trim(),
    description: String(row.description || "").trim(),
    itemsPerCell: row.items_per_cell ?? row.itemsPerCell,
    customFieldKey: String(row.custom_field_key || row.customFieldKey || "").trim(),
    customFieldValue: String(row.custom_field_value || row.customFieldValue || "").trim(),
    fields:
      row.fields && typeof row.fields === "object" && !Array.isArray(row.fields)
        ? { ...row.fields }
        : {},
    unit: String(row.unit_of_measure || row.unit || row.uom || "").trim(),
    available: firstFiniteNumber(row.available_quantity, row.available, row.value, row.quantity),
    productCount: firstFiniteNumber(
      row.product_count,
      row.products_count,
      row.productCount,
      row.product_id || row.productId ? 1 : 0,
    ),
  }));
}

function fallbackInventoryComposition(stockRows, labels = {}, topN = 10) {
  const rows = normalizeCompositionRows(stockRows);
  const units = [...new Set(rows.map((row) => row.unit).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const rankingsByUnit = units.map((unit) => ({
    unitOfMeasure: unit,
    rows: rows.filter((row) => row.unit === unit).sort((left, right) => right.available - left.available).slice(0, topN),
  }));
  const sharesByUnit = rankingsByUnit.map((group) => {
    const allRows = rows.filter((row) => row.unit === group.unitOfMeasure).sort((left, right) => right.available - left.available);
    const total = allRows.reduce((sum, row) => sum + row.available, 0);
    const visibleRows = allRows.slice(0, Math.min(topN, 8));
    const otherValue = allRows.slice(visibleRows.length).reduce((sum, row) => sum + row.available, 0);
    const slices = visibleRows.map((row) => ({
      key: row.key,
      label: row.name,
      value: row.available,
      percentage: total > 0 ? (row.available / total) * 100 : 0,
      isOther: false,
    }));
    if (otherValue > 0) {
      slices.push({
        key: `other:${group.unitOfMeasure}`,
        label: "Other",
        value: otherValue,
        percentage: total > 0 ? (otherValue / total) * 100 : 0,
        isOther: true,
      });
    }
    return { unitOfMeasure: group.unitOfMeasure, total, sourceGroupCount: allRows.length, slices };
  });
  return {
    labels,
    units,
    comparison: units.length > 1 ? "separate_by_unit" : "comparable",
    rows,
    rankingsByUnit,
    sharesByUnit,
  };
}

function stockDetailColumnLabel(column, { groupLabel, unitLabel, labels }) {
  const fallbackLabels = {
    "product.sku": "SKU",
    "product.name": "Product",
    "product.brand": "Brand",
    "product.category": "Category",
    "product.variant": "Variant",
    "product.unit_of_measure": unitLabel,
    "product.description": "Description",
    "product.items_per_cell": "Items Per Location",
  };
  if (column === "group_label") {
    return groupLabel;
  }
  if (column === "product_count") {
    return "Products";
  }
  if (column === "available_quantity") {
    return "Available";
  }
  return labels[column] || fallbackLabels[column] || column.replace(/^custom\./, "").replaceAll("_", " ");
}

function stockDetailValue(row, column, groupBy) {
  if (column === "group_label") {
    return row.name;
  }
  if (column === "product_count") {
    return formatQuantity(row.productCount);
  }
  if (column === "available_quantity") {
    return formatQuantity(row.available);
  }

  const directValues = {
    "product.sku": row.sku,
    "product.name": row.name,
    "product.brand": row.brand,
    "product.category": row.category,
    "product.variant": row.variant,
    "product.unit_of_measure": row.unit,
    "product.description": row.description,
    "product.items_per_cell": row.itemsPerCell,
  };
  const requestedFieldValue = Object.hasOwn(row.fields, column) ? row.fields[column] : undefined;
  let value = requestedFieldValue === null || requestedFieldValue === undefined || requestedFieldValue === ""
    ? directValues[column]
    : requestedFieldValue;
  if (column === groupBy && row.customFieldKey === groupBy) {
    value = row.customFieldValue;
  }
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return typeof value === "number" ? formatQuantity(value) : String(value);
}

function stockCompositionTable(
  groupLabel,
  unitLabel,
  rows,
  { columns = [], labels = {}, groupBy = "product" } = {},
) {
  const selectedColumns = Array.from(
    new Set(
      (Array.isArray(columns) && columns.length
        ? columns
        : ["group_label", "product_count", "available_quantity", "product.unit_of_measure"])
        .map((column) => String(column || "").trim())
        .filter(Boolean),
    ),
  ).slice(0, 20);
  const headers = selectedColumns.map((column) => ({
    key: column,
    label: stockDetailColumnLabel(column, { groupLabel, unitLabel, labels }),
  }));
  return `
    <div class="table-wrap" data-report-stock-table>
      <table class="report-stock-detail-table" aria-label="Current stock detail">
        <thead>
          <tr>${headers
            .map(
              (header) =>
                `<th data-report-stock-column="${escapeHtml(header.key)}">${escapeHtml(header.label)}</th>`,
            )
            .join("")}</tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? `
                ${rows
                  .map(
                    (row) => `
                      <tr
                        data-report-stock-row
                        data-report-stock-unit="${escapeHtml(compositionUnitToken(row.unit))}"
                      >
                        ${selectedColumns
                          .map(
                            (column) =>
                              `<td data-report-stock-column="${escapeHtml(column)}">${escapeHtml(
                                stockDetailValue(row, column, groupBy),
                              )}</td>`,
                          )
                          .join("")}
                      </tr>
                    `,
                  )
                  .join("")}
                <tr data-report-stock-filter-empty hidden>
                  <td colspan="${headers.length}" class="empty-cell">No stock matches this unit filter.</td>
                </tr>
              `
              : `<tr><td colspan="${headers.length}" class="empty-cell">No stock is recorded for this composition.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function stockCompositionBody(
  report = {},
  {
    visualization = "bar",
    chartKey = "stock-composition",
  } = {},
) {
  const rows = normalizeCompositionRows(report);
  const labels = report.labels && typeof report.labels === "object" ? report.labels : {};
  const groupLabel = report.groupBy?.startsWith("custom.")
    ? labels[report.groupBy] || "Custom Field"
    : report.groupBy === "category"
      ? labels["product.category"] || "Category"
      : labels["product.name"] || "Product";
  const unitLabel = labels["product.unit_of_measure"] || "Unit";
  const units = Array.isArray(report.units)
    ? report.units.filter(Boolean)
    : [...new Set(rows.map((row) => row.unit).filter(Boolean))];
  const rankingGroups = Array.isArray(report.rankingsByUnit)
    ? report.rankingsByUnit.map((group) => ({
        unit: String(group.unitOfMeasure || "Recorded unit"),
        rows: normalizeCompositionRows(group.rows),
      }))
    : units.map((unit) => ({
        unit,
        rows: rows.filter((row) => row.unit === unit).sort((left, right) => right.available - left.available),
      }));
  const shares = Array.isArray(report.sharesByUnit) ? report.sharesByUnit : [];
  const detailRows = rankingGroups.length ? rankingGroups.flatMap((group) => group.rows) : rows;
  const groupsByUnit = new Map(
    rankingGroups.map((group) => [compositionUnitToken(group.unit), group]),
  );
  const sharesByUnit = new Map(
    shares.map((share) => [compositionUnitToken(share.unitOfMeasure), share]),
  );
  const totalsByUnit = new Map(
    Object.entries(report.totalsByUnit || {}).map(([unit, total]) => [
      compositionUnitToken(unit),
      Number(total || 0),
    ]),
  );
  const charts = visualization === "table"
    ? ""
    : visualization === "donut"
      ? shares
          .map((share, index) =>
            donutChart(share, {
              key: `${chartKey}-unit-${index + 1}`,
              title: `Share Of On-hand Stock · ${share.unitOfMeasure || "Recorded unit"}`,
              description: `Each slice shows its percentage and exact on-hand quantity in ${share.unitOfMeasure || "the recorded unit"}.`,
              compact: true,
              unitToken: compositionUnitToken(share.unitOfMeasure),
            }),
          )
          .join("")
      : rankingGroups
          .map((group, index) =>
            horizontalBarChart(group.rows, {
              key: `${chartKey}-unit-${index + 1}`,
              title: `On-hand Stock By ${groupLabel} · ${group.unit}`,
              description: `Current stock is ranked within ${group.unit}; quantities from different units are never combined.`,
              valueField: "available",
              valueLabel: (row) => quantityWithUnit(row.available, row.unit || group.unit),
              compact: true,
              unitToken: compositionUnitToken(group.unit),
              emptyText: "No on-hand stock matches this report.",
            }),
          )
          .join("");
  const summaryForUnit = (unit) => {
    const token = compositionUnitToken(unit);
    const group = groupsByUnit.get(token);
    const share = sharesByUnit.get(token);
    const leader = group?.rows?.[0] || highestRow(
      rows.filter((row) => compositionUnitToken(row.unit) === token),
      "available",
    );
    const total = totalsByUnit.has(token)
      ? totalsByUnit.get(token)
      : Number(share?.total || 0);
    const groupCount = Number(
      share?.sourceRowCount || share?.sourceGroupCount || group?.rows?.length || 0,
    );
    const leaderShare = leader && total > 0 ? (Number(leader.available || 0) / total) * 100 : 0;
    return {
      takeaway: leader && leader.available > 0
        ? `${leader.name} leads ${unit} stock at ${quantityWithUnit(leader.available, unit)}.`
        : `No on-hand stock is recorded in ${unit}.`,
      stockGroups: {
        value: formatQuantity(groupCount),
        detail: `Grouped by ${groupLabel.toLowerCase()}`,
      },
      units: { value: unit, detail: "1 unit selected" },
      largest: {
        value: leader?.name || "No stock",
        detail: leader
          ? `${quantityWithUnit(leader.available, unit)} · ${percentageLabel(leaderShare, leader.available)}`
          : "Current snapshot",
      },
      onHand: {
        value: quantityWithUnit(total, unit),
        detail: "As of report generation",
      },
      meta: {
        unitLabel: unit,
        stockGroupCount: groupCount,
        total,
      },
    };
  };
  const allSummary = units.length === 1
    ? summaryForUnit(units[0])
    : {
        takeaway: units.length
          ? `Current stock spans ${formatQuantity(units.length)} units of measure; values remain separated by unit.`
          : "No on-hand stock is recorded for this composition.",
        stockGroups: {
          value: formatQuantity(report.totalMatchingRows ?? rows.length),
          detail: `Grouped by ${groupLabel.toLowerCase()}`,
        },
        units: {
          value: units.join(", ") || "None",
          detail: `${formatQuantity(units.length)} units selected`,
        },
        largest: {
          value: units.length ? "Separated by unit" : "No stock",
          detail: units.length ? "Use the unit filter to compare" : "Current snapshot",
        },
        onHand: {
          value: units.length ? "Separated by unit" : "0",
          detail: units.length ? "Totals stay unit-safe" : "As of report generation",
        },
      };
  const unitSummaries = {
    all: allSummary,
    ...Object.fromEntries(
      units.map((unit) => [compositionUnitToken(unit), summaryForUnit(unit)]),
    ),
  };
  const visualOutput = charts
    ? `
      <section class="report-visuals" aria-label="Selected report visuals">
        <div class="report-visual-grid" data-report-visual-grid>
          ${charts}
        </div>
        <p class="report-visual-note" data-report-visual-note>
          <sup>*</sup> Each visual compares stock only within its shown unit. Quantities from different units are never combined.
        </p>
      </section>
    `
    : visualization === "donut"
      ? `<section class="report-chart report-chart-empty"><h4>Stock Composition</h4><p>Choose a single unit with on-hand stock to render a donut chart.</p></section>`
      : "";

  return `
    <section
      class="stock-composition-report-body"
      data-stock-composition-report
      data-report-unit-summaries="${escapeHtml(JSON.stringify(unitSummaries))}"
      data-report-units="${escapeHtml(JSON.stringify(units.map((unit) => ({ token: compositionUnitToken(unit), label: unit }))))}"
      data-report-has-visuals="${charts ? "true" : "false"}"
    >
      ${reportSummaryTable([
        { key: "stockGroups", label: "Stock Groups", ...allSummary.stockGroups },
        { key: "units", label: "Units Of Measure", ...allSummary.units },
        { key: "largest", label: "Largest Group", ...allSummary.largest },
        { key: "onHand", label: "On Hand", ...allSummary.onHand },
      ])}
      ${visualOutput}
      <section class="report-document-section">
        <h4>Current Stock Detail</h4>
        ${stockCompositionTable(groupLabel, unitLabel, detailRows, {
          columns: report.columns,
          labels,
          groupBy: report.groupBy,
        })}
      </section>
      <footer class="report-notes">
        <strong>Calculation note</strong>
        <span>Stock composition is a current snapshot. Percentages use the complete total for each compatible unit, including the “Other” slice.</span>
      </footer>
    </section>
  `;
}

function movementMetricPresentation(metric = "picked_quantity") {
  const presentations = {
    picked_quantity: {
      field: "picked",
      label: "Picked Quantity",
      title: "Top Products By Picked Quantity",
      description: "Products are ranked by corrected quantity from completed pick tasks.",
      value: (row) => quantityWithUnit(row.picked, row.unit),
    },
    pick_frequency: {
      field: "pickFrequency",
      label: "Pick Frequency",
      title: "Most Frequently Picked Products",
      description: "Products are ranked by distinct completed pick tasks.",
      value: (row) => `${formatQuantity(row.pickFrequency)} task(s)`,
    },
    put_quantity: {
      field: "putAway",
      label: "Put-away Quantity",
      title: "Top Products By Put-away Quantity",
      description: "Products are ranked by corrected quantity from completed put tasks.",
      value: (row) => quantityWithUnit(row.putAway, row.unit),
    },
    put_frequency: {
      field: "putFrequency",
      label: "Put Frequency",
      title: "Most Frequently Put-away Products",
      description: "Products are ranked by distinct completed put tasks.",
      value: (row) => `${formatQuantity(row.putFrequency)} task(s)`,
    },
    total_handled: {
      field: "totalHandled",
      label: "Total Handled",
      title: "Top Products By Total Handling",
      description: "Picked and put-away quantities are combined within each recorded unit.",
      value: (row) => quantityWithUnit(row.totalHandled, row.unit),
    },
    net_outflow: {
      field: "netOutflow",
      label: "Net Outflow",
      title: "Products With The Highest Net Outflow",
      description: "Net outflow is corrected picked quantity minus corrected put-away quantity.",
      value: (row) => quantityWithUnit(row.netOutflow, row.unit),
    },
  };
  return presentations[metric] || presentations.picked_quantity;
}

function productMovementBody(rows, report = {}) {
  const presentation = movementMetricPresentation(report.metric);
  const documentKey = String(report.chartKey || report.reportKey || "product-movement");
  const rankedRows = [...rows].sort(
    (left, right) => Number(right[presentation.field] || 0) - Number(left[presentation.field] || 0),
  );
  const units = Array.isArray(report.units)
    ? report.units.filter(Boolean)
    : [...new Set(rows.map((row) => row.unit).filter(Boolean))];
  const separateByUnit = report.comparison === "separate_by_unit" && units.length > 1;
  const labels = report.labels && typeof report.labels === "object" ? report.labels : {};
  const groupBy = String(report.groupBy || "product");
  const productNameLabel = labels["product.name"] || "Product";
  const productSkuLabel = labels["product.sku"] || "SKU";
  const unitLabel = labels["product.unit_of_measure"] || "Unit";
  const groupLabel = groupBy === "product"
    ? productNameLabel
    : groupBy === "category"
      ? labels["product.category"] || "Category"
      : groupBy === "unit_of_measure"
        ? unitLabel
        : labels[groupBy] || "Custom Field";
  const isProductGrouping = groupBy === "product";
  const isUnitGrouping = groupBy === "unit_of_measure";
  const selectedLeader = separateByUnit ? null : highestRow(rows, presentation.field);
  const takeaway = separateByUnit
    ? `${presentation.label} spans ${formatQuantity(units.length)} units of measure, so leaders are shown separately for each unit.`
    : selectedLeader
      ? `${selectedLeader.name} ranked first for ${presentation.label.toLowerCase()}, at ${presentation.value(selectedLeader)}.`
      : "No completed movement matching this report was recorded in the selected timeframe.";
  const rankedUnitGroups = Array.isArray(report.rankingsByUnit)
    ? report.rankingsByUnit
        .map((group) => ({
          unit: String(group.unitOfMeasure || "Recorded unit"),
          rows: normalizeProductMovement(group.rows),
        }))
        .filter((group) => group.rows.length)
    : [];
  const charts = report.visualization === "table"
    ? ""
    : separateByUnit && rankedUnitGroups.length
      ? rankedUnitGroups
          .map((group, index) =>
            horizontalBarChart(group.rows, {
              key: `${documentKey}-metric-unit-${index + 1}`,
              title: `${presentation.label} By ${groupLabel} · ${group.unit}`,
              description: `${groupLabel} groups are ranked by ${presentation.label.toLowerCase()}. Values in this chart use ${group.unit}.`,
              valueField: presentation.field,
              valueLabel: presentation.value,
              emptyText: "No completed movement matches this report.",
            }),
          )
          .join("")
      : horizontalBarChart(rankedRows, {
          key: `${documentKey}-metric`,
          title: `${presentation.label} By ${groupLabel}`,
          description: `${groupLabel} groups are ranked by ${presentation.label.toLowerCase()}.`,
          valueField: presentation.field,
          valueLabel: presentation.value,
          emptyText: "No completed movement matches this report.",
        });
  const detailRows = separateByUnit && rankedUnitGroups.length
    ? rankedUnitGroups.flatMap((group) => group.rows)
    : rankedRows;
  const supportingColumns = {
    picked_quantity: [
      { label: "Pick Tasks", value: (row) => formatQuantity(row.pickFrequency) },
      { label: "Put Away", value: (row) => movementQuantityValue(row, row.putAway) },
      { label: "On Hand", value: (row) => movementQuantityValue(row, row.available) },
    ],
    pick_frequency: [
      { label: "Picked", value: (row) => movementQuantityValue(row, row.picked) },
      { label: "Put Away", value: (row) => movementQuantityValue(row, row.putAway) },
      { label: "On Hand", value: (row) => movementQuantityValue(row, row.available) },
    ],
    put_quantity: [
      { label: "Put Tasks", value: (row) => formatQuantity(row.putFrequency) },
      { label: "Picked", value: (row) => movementQuantityValue(row, row.picked) },
      { label: "On Hand", value: (row) => movementQuantityValue(row, row.available) },
    ],
    put_frequency: [
      { label: "Put Away", value: (row) => movementQuantityValue(row, row.putAway) },
      { label: "Picked", value: (row) => movementQuantityValue(row, row.picked) },
      { label: "On Hand", value: (row) => movementQuantityValue(row, row.available) },
    ],
    total_handled: [
      { label: "Picked", value: (row) => movementQuantityValue(row, row.picked) },
      { label: "Put Away", value: (row) => movementQuantityValue(row, row.putAway) },
      { label: "On Hand", value: (row) => movementQuantityValue(row, row.available) },
    ],
    net_outflow: [
      { label: "Picked", value: (row) => movementQuantityValue(row, row.picked) },
      { label: "Put Away", value: (row) => movementQuantityValue(row, row.putAway) },
      { label: "On Hand", value: (row) => movementQuantityValue(row, row.available) },
    ],
  }[report.metric] || [];
  const groupHeading = isProductGrouping ? `${productNameLabel} / ${productSkuLabel}` : groupLabel;
  const detailHeaders = [
    groupHeading,
    ...(!isUnitGrouping ? [unitLabel] : []),
    presentation.label,
    ...supportingColumns.map((column) => column.label),
  ];
  const groupCell = (row) => isProductGrouping
    ? `${escapeHtml(row.name)}${row.sku ? `<br /><small>${escapeHtml(productSkuLabel)}: ${escapeHtml(row.sku)}</small>` : ""}`
    : escapeHtml(row.name);
  const matchingGroupCount = Number(report.totalMatchingRows ?? rows.length);

  return `
    <p class="report-summary-line">
      <strong>Summary:</strong>
      <span>${escapeHtml(takeaway)}</span>
    </p>
    ${reportKpiGrid([
      {
        label: `Top ${groupLabel}`,
        value: separateByUnit
          ? "Separated By Unit"
          : selectedLeader?.name || "No activity",
        detail: separateByUnit
          ? `${formatQuantity(units.length)} units shown independently`
          : selectedLeader
            ? presentation.value(selectedLeader)
            : presentation.label,
      },
      {
        label: "Selected Measure",
        value: presentation.label,
        detail: `Grouped by ${groupLabel.toLowerCase()}`,
      },
      {
        label: `${groupLabel} Groups`,
        value: formatQuantity(matchingGroupCount),
        detail: `${formatQuantity(detailRows.length)} row(s) shown`,
      },
      {
        label: "Units Of Measure",
        value: units.join(", ") || "None",
        detail: units.length > 1 ? "Quantities remain separated" : "Comparable values",
      },
    ])}
    ${charts}
    <section class="report-document-section">
      <h4>${escapeHtml(groupLabel)} Detail</h4>
      ${table(
        detailHeaders,
        detailRows.map((row) => [
          groupCell(row),
          ...(!isUnitGrouping
            ? [escapeHtml(row.unit || (row.units.length ? row.units.join(", ") : "—"))]
            : []),
          escapeHtml(presentation.value(row)),
          ...supportingColumns.map((column) => escapeHtml(column.value(row))),
        ]),
        `No ${groupLabel.toLowerCase()} movement was recorded in this timeframe.`,
      )}
    </section>
    <footer class="report-notes">
      <strong>Calculation note</strong>
      <span>${escapeHtml(report.note || `${presentation.label} is calculated from corrected completed tasks. Current stock is an as-of-now value, and incompatible units are never combined.`)}</span>
    </footer>
  `;
}

function movementTrendPresentation(metric = "picked_quantity") {
  return {
    picked_quantity: { field: "picked_quantity", label: "Picked Quantity" },
    put_quantity: { field: "put_quantity", label: "Put-away Quantity" },
    total_handled: { field: "total_handled", label: "Total Handled" },
    net_change: { field: "net_change", label: "Net Stock Change" },
  }[metric] || { field: "picked_quantity", label: "Picked Quantity" };
}

function movementPeriodLabel(period, grain = "day") {
  const date = new Date(`${period}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return String(period || "Unknown period");
  }
  if (grain === "month") {
    return new Intl.DateTimeFormat("en-IN", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }
  const label = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return grain === "week" ? `Week of ${label}` : label;
}

function movementOverTimeBody(report = {}, { chartKey = "movement-over-time" } = {}) {
  const presentation = movementTrendPresentation(report.metric);
  const units = Array.isArray(report.units) ? report.units : [];
  const series = Array.isArray(report.seriesByUnit) ? report.seriesByUnit : [];
  const rows = series.length ? series.flatMap((group) => group.rows || []) : report.rows || [];
  const visiblePeriods = new Set(rows.map((row) => row.period)).size;
  const latest = [...rows].sort((left, right) => String(right.period).localeCompare(String(left.period)))[0];
  const largest = units.length <= 1
    ? rows.reduce((current, row) =>
        !current || Math.abs(Number(row[presentation.field] || 0)) > Math.abs(Number(current[presentation.field] || 0))
          ? row
          : current,
      null)
    : null;
  const charts = report.visualization === "table"
    ? ""
    : series
        .map((group, index) => {
          const unit = String(group.unitOfMeasure || "Recorded unit");
          const chartRows = (group.rows || []).map((row) => ({
            ...row,
            name: movementPeriodLabel(row.period, report.groupBy),
            chartValue: Number(row[presentation.field] || 0),
          }));
          return horizontalBarChart(chartRows, {
            key: `${chartKey}-unit-${index + 1}`,
            title: `${presentation.label} Over Time · ${unit}`,
            description: `Periods are shown chronologically and values use ${unit}.`,
            valueField: "chartValue",
            valueLabel: (row) => quantityWithUnit(row[presentation.field], unit),
            compact: true,
            preserveOrder: true,
            emptyText: `No ${presentation.label.toLowerCase()} values match this report.`,
          });
        })
        .join("");

  return `
    ${reportSummaryTable([
      {
        key: "periods",
        label: "Periods Shown",
        value: formatQuantity(visiblePeriods),
        detail: `${String(report.groupBy || "day").replace(/^./, (letter) => letter.toUpperCase())} buckets · UTC`,
      },
      {
        key: "units",
        label: "Units Of Measure",
        value: units.join(", ") || "None",
        detail: units.length > 1 ? "Quantities remain separated" : "Comparable values",
      },
      {
        key: "latest",
        label: "Latest Period",
        value: latest ? movementPeriodLabel(latest.period, report.groupBy) : "No activity",
        detail: latest
          ? units.length > 1
            ? `${formatQuantity(units.length)} unit groups shown separately`
            : quantityWithUnit(latest[presentation.field], latest.unit_of_measure)
          : "No completed movement",
      },
      {
        key: "largest",
        label: "Largest Change",
        value: units.length > 1
          ? "Compared Separately"
          : largest
            ? movementPeriodLabel(largest.period, report.groupBy)
            : "No activity",
        detail: units.length > 1
          ? "See each unit chart"
          : largest
            ? quantityWithUnit(largest[presentation.field], largest.unit_of_measure)
            : presentation.label,
      },
    ])}
    ${charts ? `
      <section class="report-visuals" aria-label="Movement trend visuals">
        <div class="report-visual-grid">${charts}</div>
        <p class="report-visual-note"><sup>*</sup> Trend quantities are calculated from corrected completed tasks and never combine incompatible units.</p>
      </section>
    ` : ""}
    <section class="report-document-section">
      <h4>Period Detail</h4>
      ${table(
        ["Period", "Unit", "Picked", "Put Away", "Total Handled", "Net Change"],
        rows.map((row) => [
          escapeHtml(movementPeriodLabel(row.period, report.groupBy)),
          escapeHtml(row.unit_of_measure || "Recorded unit"),
          escapeHtml(formatQuantity(row.picked_quantity)),
          escapeHtml(formatQuantity(row.put_quantity)),
          escapeHtml(formatQuantity(row.total_handled)),
          escapeHtml(formatQuantity(row.net_change)),
        ]),
        "No completed movement was recorded in this timeframe.",
      )}
    </section>
    <footer class="report-notes">
      <strong>Calculation note</strong>
      <span>Net stock change is put-away quantity minus picked quantity. Period boundaries use UTC.</span>
    </footer>
  `;
}

function exceptionMetricPresentation(metric = "exception_quantity") {
  return {
    exception_quantity: { field: "exception_quantity", label: "Exception Quantity" },
    exception_count: { field: "exception_count", label: "Exception Occurrences" },
    affected_tasks: { field: "affected_tasks", label: "Affected Tasks" },
  }[metric] || { field: "exception_quantity", label: "Exception Quantity" };
}

function exceptionsReportBody(report = {}, { chartKey = "exceptions" } = {}) {
  const presentation = exceptionMetricPresentation(report.metric);
  const units = Array.isArray(report.units) ? report.units : [];
  const rankings = Array.isArray(report.rankingsByUnit) ? report.rankingsByUnit : [];
  const rows = rankings.length ? rankings.flatMap((group) => group.rows || []) : report.rows || [];
  const dimensionlessRanking = report.rankingMode === "dimensionless_across_units";
  const comparable = report.comparison === "comparable";
  const leader = comparable
    ? rows.reduce((current, row) =>
        !current || Number(row[presentation.field] || 0) > Number(current[presentation.field] || 0)
          ? row
          : current,
      null)
    : null;
  const totalQuantity = Object.values(report.totalsByUnit || {}).reduce(
    (sum, totals) => sum + Number(totals.exception_quantity || 0),
    0,
  );
  const totalOccurrences = Object.values(report.totalsByUnit || {}).reduce(
    (sum, totals) => sum + Number(totals.exception_count || 0),
    0,
  );
  const charts = report.visualization === "table"
    ? ""
    : rankings
        .map((group, index) => {
          const unit = group.unitOfMeasure ? String(group.unitOfMeasure) : "";
          const unitSuffix = unit ? ` · ${unit}` : "";
          return horizontalBarChart(group.rows || [], {
            key: `${chartKey}-unit-${index + 1}`,
            title: `${presentation.label} By Group${unitSuffix}`,
            description: dimensionlessRanking
              ? `Groups are ranked by ${presentation.label.toLowerCase()} across all matching units.`
              : `Groups are ranked within ${unit || "their recorded unit"}; different units are not combined.`,
            valueField: presentation.field,
            valueLabel: (row) =>
              presentation.field === "exception_quantity"
                ? quantityWithUnit(row[presentation.field], unit)
                : formatQuantity(row[presentation.field]),
            compact: true,
            emptyText: "No completed task exceptions match this report.",
          });
        })
        .join("");

  return `
    ${reportSummaryTable([
      {
        key: "groups",
        label: "Affected Groups",
        value: formatQuantity(rows.length),
        detail: `Grouped by ${String(report.groupBy || "product").replaceAll("_", " ")}`,
      },
      {
        key: "occurrences",
        label: "Occurrences",
        value: formatQuantity(totalOccurrences),
        detail: "Completed task lines with a shortage",
      },
      {
        key: "quantity",
        label: "Exception Quantity",
        value: units.length <= 1 ? quantityWithUnit(totalQuantity, units[0]) : "Separated by unit",
        detail: units.join(", ") || "No exceptions",
      },
      {
        key: "leader",
        label: "Most Affected",
        value: !comparable ? "Compared Separately" : leader?.name || "No exceptions",
        detail: !comparable
          ? "See each unit ranking"
          : leader
            ? presentation.field === "exception_quantity"
              ? quantityWithUnit(leader[presentation.field], leader.unit_of_measure)
              : `${formatQuantity(leader[presentation.field])} ${presentation.label.toLowerCase()}`
            : "No completed task exceptions",
      },
    ])}
    ${charts ? `
      <section class="report-visuals" aria-label="Exception visuals">
        <div class="report-visual-grid">${charts}</div>
        <p class="report-visual-note"><sup>*</sup> ${dimensionlessRanking ? "Counts and affected-task totals can be compared across units; quantities remain separated." : "Exception quantities are compared only within the recorded unit."}</p>
      </section>
    ` : ""}
    <section class="report-document-section">
      <h4>Exception Detail</h4>
      ${table(
        ["Group", "Unit", "Exception Quantity", "Occurrences", "Affected Tasks"],
        rows.map((row) => [
          escapeHtml(row.name || "Not set"),
          escapeHtml(
            row.unit_of_measure ||
              (Array.isArray(row.units) && row.units.length ? row.units.join(", ") : "—"),
          ),
          escapeHtml(
            row.quantity_comparison === "separate_by_unit"
              ? "Separated by unit"
              : formatQuantity(row.exception_quantity),
          ),
          escapeHtml(formatQuantity(row.exception_count)),
          escapeHtml(formatQuantity(row.affected_tasks)),
        ]),
        "No completed task exceptions were recorded in this timeframe.",
      )}
    </section>
    <footer class="report-notes">
      <strong>Calculation note</strong>
      <span>An exception is the recorded shortage between planned and completed quantity on a task line.</span>
    </footer>
  `;
}

function replenishmentWatchBody(report = {}, labels = {}) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const counts = report.statusCounts || {};
  const statusRows = [
    { name: "Out of stock", product_count: Number(counts.out_of_stock || 0) },
    { name: "One batch or less", product_count: Number(counts.one_batch_or_less || 0) },
  ];
  const skuLabel = labels["product.sku"] || "SKU";
  const productLabel = labels["product.name"] || "Product";
  const categoryLabel = labels["product.category"] || "Category";
  const batchLabel = labels["product.items_per_cell"] || "Normal Location Batch";

  return `
    ${reportSummaryTable([
      {
        key: "attention",
        label: "Products Needing Attention",
        value: formatQuantity(counts.total || rows.length),
        detail: "Active products at one normal location batch or less",
      },
      {
        key: "empty",
        label: "Out Of Stock",
        value: formatQuantity(counts.out_of_stock || 0),
        detail: "No stock in active locations",
      },
      {
        key: "low",
        label: "One Batch Or Less",
        value: formatQuantity(counts.one_batch_or_less || 0),
        detail: "Stock remains, but only up to the normal batch",
      },
      {
        key: "units",
        label: "Units Of Measure",
        value: Array.isArray(report.units) && report.units.length
          ? report.units.join(", ")
          : "None",
        detail: "Every quantity stays in its product's own unit",
      },
    ])}
    <section class="report-visuals" aria-label="Replenishment status visual">
      <div class="report-visual-grid report-visual-grid-single">
        ${horizontalBarChart(statusRows, {
          key: "replenishment-status",
          title: "Products By Replenishment Status",
          description: "Product counts can be compared safely because this visual does not combine stock quantities.",
          valueField: "product_count",
          valueLabel: (row) => `${formatQuantity(row.product_count)} product(s)`,
          compact: true,
          preserveOrder: true,
          emptyText: "No active products currently need replenishment attention.",
        })}
      </div>
    </section>
    <section class="report-document-section">
      <h4>Products To Review</h4>
      ${table(
        [`${productLabel} / ${skuLabel}`, categoryLabel, "Status", "Available", batchLabel, "Locations"],
        rows.map((row) => [
          `${escapeHtml(row.name)}<br /><small>${escapeHtml(skuLabel)}: ${escapeHtml(row.sku)}</small>`,
          escapeHtml(row.category || "Uncategorized"),
          escapeHtml(row.status === "out_of_stock" ? "Out of stock" : "One batch or less"),
          escapeHtml(quantityWithUnit(row.available_quantity, row.unit_of_measure)),
          escapeHtml(quantityWithUnit(row.items_per_cell, row.unit_of_measure)),
          escapeHtml(formatQuantity(row.occupied_locations)),
        ]),
        "No active products are at or below one normal location batch.",
      )}
    </section>
    <footer class="report-notes">
      <strong>Calculation note</strong>
      <span>“Low” means one normal location batch or less. This is a practical replenishment watch, not a demand forecast or supplier reorder point.</span>
    </footer>
  `;
}

function idleDurationLabel(lastPickedAt, rangeEnd) {
  if (!lastPickedAt) {
    return "Never picked";
  }
  const start = new Date(lastPickedAt).getTime();
  const end = rangeEnd ? new Date(rangeEnd).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return "Less than 1 day";
  }
  const days = Math.floor((end - start) / (24 * 60 * 60 * 1000));
  return days < 1 ? "Less than 1 day" : `${formatQuantity(days)} day${days === 1 ? "" : "s"}`;
}

function slowMovingStockBody(report = {}, labels = {}) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const neverPicked = Number(report.neverPickedCount || 0);
  const previouslyPicked = Number(report.previouslyPickedCount || 0);
  const statusRows = [
    { name: "Never picked", product_count: neverPicked },
    { name: "No picks in range", product_count: previouslyPicked },
  ];
  const skuLabel = labels["product.sku"] || "SKU";
  const productLabel = labels["product.name"] || "Product";
  const categoryLabel = labels["product.category"] || "Category";

  return `
    ${reportSummaryTable([
      {
        key: "slow",
        label: "Stocked Products Without Picks",
        value: formatQuantity(rows.length),
        detail: "No positive completed pick in the selected timeframe",
      },
      {
        key: "never",
        label: "Never Picked",
        value: formatQuantity(neverPicked),
        detail: "No positive completed pick on record",
      },
      {
        key: "older",
        label: "Picked Before The Range",
        value: formatQuantity(previouslyPicked),
        detail: "Last usage predates the selected timeframe",
      },
    ])}
    <section class="report-visuals" aria-label="Slow-moving stock visual">
      <div class="report-visual-grid report-visual-grid-single">
        ${horizontalBarChart(statusRows, {
          key: "slow-moving-status",
          title: "Why These Products Are Listed",
          description: "Counts distinguish products that were never picked from products last picked before the selected timeframe.",
          valueField: "product_count",
          valueLabel: (row) => `${formatQuantity(row.product_count)} product(s)`,
          compact: true,
          preserveOrder: true,
          emptyText: "Every stocked product was picked in the selected timeframe.",
        })}
      </div>
    </section>
    <section class="report-document-section">
      <h4>Stock Without Recent Picks</h4>
      ${table(
        [`${productLabel} / ${skuLabel}`, categoryLabel, "On Hand", "Last Pick", "Idle For", "Locations"],
        rows.map((row) => [
          `${escapeHtml(row.name)}<br /><small>${escapeHtml(skuLabel)}: ${escapeHtml(row.sku)}</small>`,
          escapeHtml(row.category || "Uncategorized"),
          escapeHtml(quantityWithUnit(row.available_quantity, row.unit_of_measure)),
          escapeHtml(row.last_picked_at ? formatDate(row.last_picked_at) : "Never picked"),
          escapeHtml(idleDurationLabel(row.last_picked_at, report.range?.toAt)),
          escapeHtml(formatQuantity(row.occupied_locations)),
        ]),
        "Every stocked product had a positive completed pick in this timeframe.",
      )}
    </section>
    <footer class="report-notes">
      <strong>Calculation note</strong>
      <span>Only positive quantities on completed pick tasks count as usage. Put-away activity and zero-quantity picks do not hide slow-moving stock.</span>
    </footer>
  `;
}

function teamThroughputBody(report = {}) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const totals = report.totals || {};
  const chartRows = rows.map((row) => ({
    ...row,
    name: row.name || row.username || "Unknown user",
  }));

  return `
    ${reportSummaryTable([
      {
        key: "completed",
        label: "Completed Tasks",
        value: formatQuantity(totals.completed_tasks || 0),
        detail: "Completed pick and put-away tasks",
      },
      {
        key: "picks",
        label: "Pick Tasks",
        value: formatQuantity(totals.completed_pick_tasks || 0),
        detail: "Counted once per completed task",
      },
      {
        key: "puts",
        label: "Put-away Tasks",
        value: formatQuantity(totals.completed_put_tasks || 0),
        detail: "Counted once per completed task",
      },
      {
        key: "clean",
        label: "Exception-free",
        value: `${formatQuantity(totals.exception_free_percent || 0)}%`,
        detail: `${formatQuantity(totals.exception_tasks || 0)} task(s) had a shortage`,
      },
    ])}
    <section class="report-visuals" aria-label="Team throughput visual">
      <div class="report-visual-grid report-visual-grid-single">
        ${horizontalBarChart(chartRows, {
          key: "team-throughput",
          title: "Completed Tasks By Team Member",
          description: "Each completed pick or put-away task is counted once, even when it has several product or location lines.",
          valueField: "completed_tasks",
          valueLabel: (row) => `${formatQuantity(row.completed_tasks)} task(s)`,
          compact: true,
          emptyText: "No pick or put-away tasks were completed in this timeframe.",
        })}
      </div>
    </section>
    <section class="report-document-section">
      <h4>Completed Work By User</h4>
      ${table(
        ["Team Member", "Completed Work", "Exception Tasks", "Exception-free", "Avg. Completion"],
        rows.map((row) => [
          `${escapeHtml(row.name || row.username || "Unknown user")}${row.username && row.name !== row.username ? `<br /><small>${escapeHtml(row.username)}</small>` : ""}`,
          `${escapeHtml(formatQuantity(row.completed_tasks))}<br /><small>${escapeHtml(formatQuantity(row.completed_pick_tasks))} picks · ${escapeHtml(formatQuantity(row.completed_put_tasks))} put-aways</small>`,
          escapeHtml(formatQuantity(row.exception_tasks)),
          escapeHtml(`${formatQuantity(row.exception_free_percent)}%`),
          escapeHtml(`${formatQuantity(row.average_completion_minutes)} min`),
        ]),
        "No pick or put-away tasks were completed in this timeframe.",
      )}
    </section>
    <footer class="report-notes">
      <strong>Calculation note</strong>
      <span>Throughput uses completed task counts, not mixed-unit item totals. Multi-line tasks count once.</span>
    </footer>
  `;
}

function reportLibraryItem(report) {
  return `
    <a
      class="report-library-item report-library-item-${escapeHtml(report.key)}"
      href="#${escapeHtml(report.key)}"
      data-report-open="${escapeHtml(report.key)}"
      data-report-title="${escapeHtml(report.title)}"
      data-report-search-text="${escapeHtml(`${report.title} ${report.description} ${report.metricLabel}`.toLowerCase())}"
      aria-controls="${escapeHtml(report.key)}"
    >
      <span class="report-library-item-copy">
        <strong>${escapeHtml(report.title)}</strong>
        <small>${escapeHtml(report.description)}</small>
      </span>
      <span class="report-library-item-metric">
        <strong>${escapeHtml(report.metric)}</strong>
        <small>${escapeHtml(report.metricLabel)}</small>
      </span>
    </a>
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

function reportDocumentContext(report, user, reportFormat) {
  const generatedBy = user?.name || user?.username || "Unknown user";
  const generatedByValue = user?.username && user.username !== generatedBy
    ? `${generatedBy} (${user.username})`
    : generatedBy;
  const items = [
    { key: "generatedBy", label: "Generated By", value: generatedByValue },
    {
      key: "reportingUnit",
      label: "Reporting Unit",
      value: reportFormat.companyName || "Not specified",
    },
  ];
  return `
    <dl class="report-document-context" aria-label="Report context">
      ${items
        .map(
          (item) => `
            <div data-report-context-item="${escapeHtml(item.key)}">
              <dt>${escapeHtml(item.label)}</dt>
              <dd>${escapeHtml(item.value)}</dd>
            </div>
          `,
        )
        .join("")}
    </dl>
  `;
}

function reportInlineDocument(report, range, generatedAt, reportFormat, user, active = false) {
  const effectiveRange = report.range || range;
  return `
    <article
      id="${escapeHtml(report.key)}"
      class="report-document report-inline-document"
      data-report-inline="${escapeHtml(report.key)}"
      data-report-document="${escapeHtml(report.key)}"
      data-report-uses-global-range="${report.usesGlobalRange ? "true" : "false"}"
      aria-label="${escapeHtml(report.title)}"
      tabindex="-1"
      style="${escapeHtml(reportFormatStyle(reportFormat))}"
      ${active ? "" : "hidden"}
    >
      <header class="report-document-header">
        <div class="report-document-title-block">
          <p class="report-document-company">${escapeHtml(reportFormat.companyName)}</p>
          <p class="report-document-kicker">${escapeHtml(reportFormat.headerLabel)}</p>
          <h3>${escapeHtml(report.title)}</h3>
          <p class="report-document-subheading">${escapeHtml(report.description)}</p>
        </div>
        <dl class="report-document-meta">
          <div>
            <dt>Selected Range</dt>
            <dd>${escapeHtml(reportRangeLabel(effectiveRange))}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>${escapeHtml(formatDate(generatedAt))}</dd>
          </div>
        </dl>
      </header>
      ${reportDocumentContext(report, user, reportFormat)}
      ${report.body}
    </article>
  `;
}

export function createReportsPages({ db }) {
  function renderReports(user, flash, url) {
    const runtime = getRuntimeContext();
    const range = resolveReportRange(url, runtime.config?.reportDefaultDays || 30);
    const generatedAt = new Date().toISOString();
    const reportFormat = getReportFormatSettings(db);
    const reports = buildReports(db, { fromAt: range.fromAt, toAt: range.toAt });
    const productMovementReport = reports.productMovement || {};
    const productMovement = normalizeProductMovement(productMovementReport);
    const productLabels = productMovementReport.labels || {};
    const skuLabel = productLabels["product.sku"] || "SKU";
    const productNameLabel = productLabels["product.name"] || "Product";
    const unitLabel = productLabels["product.unit_of_measure"] || "Unit";
    const productMovementUnits = Array.isArray(productMovementReport.units)
      ? productMovementReport.units.filter(Boolean)
      : [...new Set(productMovement.map((row) => row.unit).filter(Boolean))];
    const productMovementComparable = productMovementReport.comparison
      ? productMovementReport.comparison === "comparable"
      : productMovementUnits.length <= 1;
    const mostPicked = productMovementComparable
      ? normalizeProductMovement([productMovementReport.leaders?.mostPicked])[0] || highestRow(productMovement, "picked")
      : null;
    const stockCompositionReport = typeof reportServices.buildInventoryCompositionReport === "function"
      ? reportServices.buildInventoryCompositionReport(db, { groupBy: "product", topN: 10 })
      : fallbackInventoryComposition(reports.stockSnapshot, productLabels, 10);
    const stockCompositionRows = normalizeCompositionRows(stockCompositionReport);
    const movementTrendReport = buildMovementOverTimeReport(db, {
      fromAt: range.fromAt,
      toAt: range.toAt,
      metric: "net_change",
      groupBy: "day",
      topN: 14,
      visualization: "bar",
    });
    const exceptionHotspotsReport = buildExceptionsReport(db, {
      fromAt: range.fromAt,
      toAt: range.toAt,
      metric: "affected_tasks",
      groupBy: "cell",
      topN: 10,
      visualization: "bar",
    });
    const builtInReportSections = [
      {
        key: "product-movement",
        title: "Product Movement & Demand",
        description: "Which products were picked most in the selected timeframe?",
        metric: productMovementComparable
          ? mostPicked && mostPicked.picked > 0
            ? mostPicked.name
            : "No activity"
          : `${formatQuantity(productMovementUnits.length)} unit groups`,
        metricLabel: productMovementComparable ? "Most Used (Picked)" : "Compared Separately",
        usesGlobalRange: true,
        body: productMovementBody(productMovement, productMovementReport),
      },
      {
        key: "stock-snapshot",
        title: "Stock Snapshot",
        description: "What stock can we pick right now?",
        metric: formatQuantity(stockCompositionReport.totalMatchingRows ?? stockCompositionRows.length),
        metricLabel: "Products With Stock",
        usesGlobalRange: false,
        range: { fromAt: null, toAt: null, label: "Current Snapshot" },
        body: stockCompositionBody(
          { ...stockCompositionReport, groupBy: "product", labels: stockCompositionReport.labels || productLabels },
          { visualization: "bar", chartKey: "stock-snapshot" },
        ),
      },
      {
        key: "replenishment-watch",
        title: "Replenishment Watch",
        description: "Which products are out of stock or down to one normal location batch?",
        metric: formatQuantity(reports.replenishmentWatch.statusCounts.total),
        metricLabel: "Products To Review",
        usesGlobalRange: false,
        range: { fromAt: null, toAt: null, label: "Current Snapshot" },
        body: replenishmentWatchBody(reports.replenishmentWatch, productLabels),
      },
      {
        key: "slow-moving-stock",
        title: "Slow-Moving Stock",
        description: "Which stocked products were not picked in the selected timeframe?",
        metric: formatQuantity(reports.slowMovingStock.totalMatchingRows),
        metricLabel: "Products Without Picks",
        usesGlobalRange: true,
        body: slowMovingStockBody(reports.slowMovingStock, productLabels),
      },
      {
        key: "movement",
        title: "Stock Change Over Time",
        description: "Did inventory increase or decrease during the selected timeframe?",
        metric: formatQuantity(movementTrendReport.totalPeriods || 0),
        metricLabel: "Periods With Movement",
        usesGlobalRange: true,
        body: movementOverTimeBody(movementTrendReport, { chartKey: "stock-change-over-time" }),
      },
      {
        key: "team-activity",
        title: "Team Throughput",
        description: "What pick and put-away work did each team member complete?",
        metric: formatQuantity(reports.teamThroughput.totals.completed_tasks),
        metricLabel: "Completed Tasks",
        usesGlobalRange: true,
        body: teamThroughputBody(reports.teamThroughput),
      },
      {
        key: "issues",
        title: "Exception Hotspots",
        description: "Where did completed warehouse work fall short of plan?",
        metric: formatQuantity(exceptionHotspotsReport.totals?.affected_tasks || 0),
        metricLabel: "Affected Tasks",
        usesGlobalRange: true,
        body: exceptionsReportBody(exceptionHotspotsReport, { chartKey: "exception-hotspots" }),
      },
      {
        key: "adjustments",
        title: "Adjustment Audit",
        description: "Who manually changed stock, when, and why?",
        metric: formatQuantity(reports.adjustments.length),
        metricLabel: "Count Changes",
        usesGlobalRange: true,
        body: table(
          ["When", `${productNameLabel} / ${skuLabel}`, "Cell", "Delta", unitLabel, "Reason", "Recorded By"],
          reports.adjustments.map((row) => [
            escapeHtml(formatDate(row.created_at)),
            `${escapeHtml(row.product_name)}<br /><small>${escapeHtml(skuLabel)}: ${escapeHtml(row.sku)}</small>`,
            escapeHtml(row.logical_code),
            escapeHtml(formatQuantity(row.quantity_delta)),
            escapeHtml(row.unit_of_measure),
            escapeHtml(row.reason),
            escapeHtml(row.username),
          ]),
          "No adjustments were recorded in this timeframe.",
        ),
      },
    ];
    const reportSections = builtInReportSections;

    return page({
      title: "Reports",
      user,
      flash,
      content: `
        <section class="reports-workspace" data-reports-workspace>
          <header class="reports-hero app-panel" data-report-screen-only>
            <div>
              <p class="report-eyebrow">Warehouse Intelligence</p>
              <h2>Report Library</h2>
              <p>Choose the warehouse question you want answered.</p>
            </div>
            <div class="reports-hero-actions">
              ${
                user.role === "admin"
                  ? `<button
                      type="button"
                      class="ghost-button"
                      data-report-format-open
                      aria-haspopup="dialog"
                      aria-controls="report-format-modal"
                      aria-expanded="${url.searchParams.get("format") === "1" ? "true" : "false"}"
                    >Format Reports</button>`
                  : ""
              }
            </div>
          </header>
          ${renderReportFormatEditor(reportFormat, {
            user,
            returnTo: formatEditorReturnTo(url),
            mode: "modal",
            open: url.searchParams.get("format") === "1",
            attributes: `id="report-format-modal" data-report-screen-only`,
          })}
          <div class="report-studio">
            <aside class="report-library app-panel" aria-labelledby="report-library-title" data-report-screen-only>
              <div class="report-library-header">
                <div>
                  <p class="report-eyebrow">Curated Questions</p>
                  <h2 id="report-library-title">Choose A Report</h2>
                </div>
                <span>${escapeHtml(formatQuantity(reportSections.length))}</span>
              </div>
              <label class="report-library-search">
                <span>Search reports</span>
                <input type="search" placeholder="Name or purpose" autocomplete="off" data-report-library-search />
              </label>
              <nav class="report-library-list report-overview-grid" aria-label="Curated warehouse reports">
                <p class="report-library-group-label">Warehouse Questions</p>
                ${builtInReportSections.map(reportLibraryItem).join("")}
                <p class="report-library-empty" data-report-library-empty hidden>No reports match that search.</p>
              </nav>
            </aside>
            <section class="report-stage" aria-label="Selected report">
              <div class="report-stage-toolbar app-panel" data-report-screen-only>
                <div>
                  <span>Viewing</span>
                  <strong data-report-stage-title>${escapeHtml(reportSections[0].title)}</strong>
                </div>
                <div class="report-stage-actions">
                  ${renderReportToolbarControls(range)}
                  <button type="button" class="ghost-button" data-report-print-open>Choose Report To Print</button>
                  <button type="button" class="blue-button report-print-button" data-report-print-current>Print Current</button>
                </div>
              </div>
              <p class="sr-only" aria-live="polite" data-report-announcer></p>
              <section class="report-inline-stack" data-report-inline-stack>
                ${reportSections
                  .map((report, index) => reportInlineDocument(report, range, generatedAt, reportFormat, user, index === 0))
                  .join("")}
              </section>
            </section>
          </div>
          <section
            class="modal-backdrop app-alert-modal report-print-menu"
            data-report-print-menu
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-print-title"
            data-report-screen-only
            hidden
          >
            <div class="modal-panel report-print-panel">
              <div class="modal-header">
                <div>
                  <p class="report-eyebrow">Print Report</p>
                  <h2 id="report-print-title">Choose A Report To Print</h2>
                  <p class="muted">The selected report will open in the browser print menu with its configured timeframe.</p>
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
