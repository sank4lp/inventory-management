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

function nav(user) {
  if (!user) {
    return "";
  }

  const links = [
    ["/", "Home"],
    ["/products", "Products"],
    ["/cells", "Cells"],
    ["/pick", "Pick"],
    ["/put", "Put"],
  ];
  if (user.role === "admin") {
    links.push(["/reports", "Reports"]);
    links.push(["/devices", "Devices"]);
    links.push(["/admin", "Admin"]);
  }

  return `
    <nav class="top-nav">
      <div class="brand">
        <span class="brand-mark">IM</span>
        <div>
          <div class="brand-title">Inventory Management</div>
          <div class="brand-subtitle">Local-first warehouse console</div>
        </div>
      </div>
      <div class="nav-links">
        ${links
          .map(
            ([href, label]) =>
              `<a href="${href}">${escapeHtml(label)}</a>`,
          )
          .join("")}
      </div>
      <div class="session-box">
        <div>${escapeHtml(user.name)}</div>
        <small>${escapeHtml(user.role)}</small>
        <form method="post" action="/logout">
          <button class="ghost-button" type="submit">Logout</button>
        </form>
      </div>
    </nav>
  `;
}

export function page({ title, user, flash, content }) {
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
    ${nav(user)}
    <main class="page-shell">
      <header class="page-header">
        <h1>${escapeHtml(title)}</h1>
      </header>
      ${
        flash
          ? `<div class="flash flash-${escapeHtml(flash.tone || "info")}">${escapeHtml(flash.message)}</div>`
          : ""
      }
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
