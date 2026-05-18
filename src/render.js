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

export function formatBytes(bytes) {
  const value = Number(bytes || 0);

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function iconSvg(name, className = "ui-icon") {
  const icons = {
    overview: `
      <path d="M4 13.5 12 6l8 7.5" />
      <path d="M6.5 12.5V20h11v-7.5" />
      <path d="M10 20v-5h4v5" />
    `,
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
    products: `
      <path d="M4 7.5 12 3l8 4.5-8 4.5L4 7.5Z" />
      <path d="M4 7.5v9L12 21l8-4.5v-9" />
      <path d="M12 12v9" />
    `,
    locations: `
      <path d="M12 21s7-5.1 7-11a7 7 0 0 0-14 0c0 5.9 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    `,
    reports: `
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 15v-4" />
      <path d="M12 15V8" />
      <path d="M16 15v-6" />
    `,
    devices: `
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M9 2v3" />
      <path d="M15 2v3" />
      <path d="M9 19v3" />
      <path d="M15 19v3" />
      <path d="M2 9h3" />
      <path d="M2 15h3" />
      <path d="M19 9h3" />
      <path d="M19 15h3" />
      <path d="M9 12h6" />
    `,
    backups: `
      <path d="M5 7a8 8 0 1 1 1.6 4.8" />
      <path d="M5 7V3" />
      <path d="M5 7h4" />
      <path d="M12 8v5l3 2" />
    `,
    admin: `
      <path d="M12 3 5 6v5c0 4.4 2.8 8.3 7 10 4.2-1.7 7-5.6 7-10V6l-7-3Z" />
      <path d="M9.5 12.2 11.2 14l3.6-4" />
    `,
  };

  return `
    <svg class="${escapeHtml(className)}" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      ${icons[name] || icons.overview}
    </svg>
  `;
}

function nav(user, currentTitle = "") {
  if (!user) {
    return "";
  }

  const links = [
    ["/", "Overview", "overview"],
    ["/pick", "Pick", "pick"],
    ["/put", "Put", "put"],
    ["/products", "Products", "products"],
    ["/cells", "Locations", "locations"],
    ["/reports", "Reporting", "reports"],
  ];
  if (user.role === "admin") {
    links.push(["/devices", "Configuration", "devices"]);
    links.push(["/backups", "Backups", "backups"]);
    links.push(["/admin", "Admin", "admin"]);
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
              ([href, label, icon]) =>
                `<a class="${activeTitle.includes(label.toLowerCase()) || (label === "Overview" && activeTitle === "home") ? "nav-link-active" : ""}" href="${href}">${iconSvg(icon, "nav-icon")}<span>${escapeHtml(label)}</span></a>`,
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
    user
      ? `<div class="flash flash-warning" data-system-notice aria-live="polite" ${
          systemHealth?.degraded ? "" : "hidden"
        }>System warning: ${escapeHtml(systemHealth?.degraded ? systemHealth.message : "")}</div>`
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
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="/styles.css" />
    <script type="module" src="/app.js"></script>
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

export function card(title, body, actions = "", attributes = "") {
  return `
    <section class="card"${attributes ? ` ${attributes}` : ""}>
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

export function table(headers, rows, emptyMessage = "No records yet.") {
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
              : `<tr><td colspan="${headers.length}" class="empty-cell">${escapeHtml(emptyMessage)}</td></tr>`
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
