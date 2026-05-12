import { getRuntimeContext } from "./server/runtime-context.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatDate(value) {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatQuantity(value) {
  const number = Number(value ?? 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function nav(user, currentTitle = "") {
  if (!user) {
    return "";
  }

  const links = [
    ["/", "Overview"],
    ["/pick", "Pick"],
    ["/put", "Put"],
    ["/products", "Products"],
    ["/cells", "Locations"],
  ];
  if (user.role === "admin") {
    links.push(["/reports", "Reporting"]);
    links.push(["/devices", "Configuration"]);
    links.push(["/backups", "Backups"]);
    links.push(["/admin", "Admin"]);
  }

  const activeTitle = String(currentTitle || "").toLowerCase();

  return `
    <nav class="top-nav">
      <div class="top-nav-shell">
        <div class="brand">
          <span class="brand-mark">IM</span>
          <div class="brand-copy">
            <div class="brand-title">Inventory Management</div>
          </div>
        </div>
        <div class="nav-links">
          ${links
            .map(
              ([href, label]) =>
                `<a class="${activeTitle.includes(label.toLowerCase()) || (label === "Overview" && activeTitle === "home") ? "nav-link-active" : ""}" href="${href}"><span>${escapeHtml(label)}</span></a>`,
            )
            .join("")}
        </div>
        <div class="session-box">
          <div class="session-identity">
            <span class="session-avatar">${escapeHtml(user.name.charAt(0).toUpperCase())}</span>
            <div class="session-copy">
              <div class="session-name">${escapeHtml(user.name)}</div>
              <div class="session-role">${escapeHtml(user.role)}</div>
            </div>
          </div>
          <form method="post" action="/logout">
            <button class="ghost-button" type="submit">Logout</button>
          </form>
        </div>
      </div>
    </nav>
  `;
}

export function page({ title, user, flash, content }) {
  const runtime = getRuntimeContext();
  const systemHealth = runtime.systemService?.healthSummary(runtime.startup);
  const systemNotice =
    user && systemHealth?.degraded
      ? `<div class="flash flash-warning">System warning: ${escapeHtml(
          systemHealth.message,
        )} Adapter: ${escapeHtml(runtime.startup?.hardware?.message || runtime.config?.hardwareAdapter || "unknown")}.</div>`
      : "";
  const toast =
    flash
      ? `
        <div class="toast-stack" aria-live="${flash.tone === "error" ? "assertive" : "polite"}" aria-atomic="true">
          <div class="toast toast-${escapeHtml(flash.tone || "info")}" role="${flash.tone === "error" ? "alert" : "status"}" data-toast>
            <span>${escapeHtml(flash.message)}</span>
            <button type="button" class="toast-close" data-toast-close aria-label="Dismiss notification">x</button>
          </div>
        </div>
      `
      : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · Inventory Management</title>
    <link rel="stylesheet" href="/styles.css" />
    <script src="/app.js" defer></script>
  </head>
  <body>
    ${nav(user, title)}
    ${toast}
    <main class="page-shell">
      <header class="page-header">
        <h1>${escapeHtml(title)}</h1>
      </header>
      ${systemNotice}
      ${content}
    </main>
  </body>
</html>`;
}

export function card(title, body, actions = "") {
  return `
    <section class="card">
      <div class="card-header">
        <h2>${escapeHtml(title)}</h2>
        ${actions}
      </div>
      ${body}
    </section>
  `;
}

export function statsGrid(items) {
  return `
    <section class="stats-grid">
      ${items
        .map(
          (item) => `
            <article class="stat-card">
              <div class="stat-label">${escapeHtml(item.label)}</div>
              <div class="stat-value">${escapeHtml(item.value)}</div>
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

export function table(headers, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map(
                    (row) => `
                      <tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>
                    `,
                  )
                  .join("")
              : `<tr><td colspan="${headers.length}" class="empty-cell">No records yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

export function statusBadge(value) {
  const tone = String(value).toLowerCase().replaceAll("_", "-");
  return `<span class="badge badge-${escapeHtml(tone)}">${escapeHtml(value)}</span>`;
}
