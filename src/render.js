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
    profile: `
      <circle cx="12" cy="8" r="4" />
      <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
    `,
    chevronDown: `
      <path d="m6 9 6 6 6-6" />
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

  const activeTitle = String(currentTitle || "").toLowerCase();
  const navItems = [
    {label:"My work",icon:"pick",href:"/work",active:["my work"],links:[["/record-movement","Record completed movement"],["/movement-history","Movement history"],["/labels","Location labels"]]},
    {label:"Pending confirmations",icon:"reports",href:"/pending-confirmations",adminOnly:true,active:["pending confirmations"]},
    {
      label: "Overview",
      icon: "overview",
      href: "/",
      active: ["overview", "recommended actions"],
      links: [
        ["/#recent-tasks", "Recent Tasks"],
        ["/recommended-actions", "Recommended Actions"],
      ],
    },
    {
      label: "Pick",
      icon: "pick",
      href: "/pick",
      active: ["pick"],
    },
    {
      label: "Put",
      icon: "put",
      href: "/put",
      active: ["put"],
    },
    {
      label: "Products",
      icon: "products",
      href: "/products",
      active: ["products"],
    },
    {
      label: "Locations",
      icon: "locations",
      href: "/cells",
      active: ["locations", "cell"],
      links: [
        ["/cells#find-location", "Find A Location"],
        ["/cells#all-locations", "All Locations"],
      ],
    },
    {
      label: "Reporting",
      icon: "reports",
      href: "/reports",
      active: ["reports"],
      links: [
        ["/reports#product-movement", "Product Movement"],
        ["/reports#stock-snapshot", "Stock Snapshot"],
        ["/reports#replenishment-watch", "Replenishment Watch"],
        ["/reports#slow-moving-stock", "Slow-Moving Stock"],
        ["/reports#movement", "Stock Change Over Time"],
        ["/reports#team-activity", "Team Throughput"],
        ["/reports#issues", "Exception Hotspots"],
        ["/reports#adjustments", "Adjustment Audit"],
      ],
    },
    {
      label: "Configuration",
      icon: "devices",
      href: "/devices",
      adminOnly: true,
      active: ["configuration"],
      links: [
        ["/devices#configuration-status", "System Status"],
        ["/devices#controller-health", "Controller Health"],
        ["/devices#controller-setup", "Add Controller"],
        ["/devices#cell-management", "Manage Locations"],
        ["/devices#cell-mapping", "Cell Mapping"],
      ],
    },
    {
      label: "Backups",
      icon: "backups",
      href: "/backups",
      adminOnly: true,
      active: ["backups"],
      links: [
        ["/backups#create-backup", "Create Backup Now"],
        ["/backups#backup-schedule", "Backup Schedule"],
        ["/backups#available-backups", "Available Backups"],
      ],
    },
    {
      label: "Admin",
      icon: "admin",
      href: "/admin",
      adminOnly: true,
      active: ["admin"],
      links: [
        ["/admin#registration-keys", "Registration Keys"],
        ["/admin#users", "Users"],
        ["/admin/product-fields", "Product Fields"],
        ["/admin#count-adjustment", "Count Adjustment"],
        ["/admin#settings", "Settings"],
        ["/admin#report-format", "Report Format"],
        ["/admin#database-health", "Database Health"],
      ],
    },
    {
      label: "Profile",
      icon: "profile",
      href: "/profile",
      active: ["profile"],
      links: [
        ["/profile#account-details", "Account Details"],
        ["/profile#recent-activity", "Recent Activity"],
        ["/profile#profile-recent-tasks", "Recent Tasks"],
      ],
    },
  ];

  const isItemActive = (item) =>
    (item.active || [item.label]).some((label) => activeTitle.includes(label.toLowerCase()));

  const renderItem = (item) => {
    const active = isItemActive(item);
    const link = `<a class="side-nav-direct ${active ? "nav-link-active" : ""}" href="${item.href}" ${active ? 'aria-current="page"' : ''}>
      ${iconSvg(item.icon, "nav-icon")}<span>${escapeHtml(item.label)}</span></a>`;
    if (!item.links) return link;
    return `<div class="side-nav-item">${link}
      <details class="side-nav-group">
        <summary class="side-nav-summary" aria-label="${escapeHtml(item.label)} shortcuts">${iconSvg("chevronDown", "nav-icon side-nav-chevron")}</summary>
        <div class="side-nav-sublist">${item.links.map(([href, label]) => `<a class="side-nav-link" href="${href}">${escapeHtml(label)}</a>`).join("")}</div>
      </details></div>`;
  };
  const allowed = navItems.filter((item) => !item.adminOnly || user.role === "admin");
  const primary = allowed.filter((item) => ["/work", "/pick", "/put"].includes(item.href));
  const secondary = allowed.filter((item) => !primary.includes(item));
  const workTools = [
    {href:'/record-movement', label:'Record completed movement', icon:'pick'},
    {href:'/movement-history', label:'Movement history', icon:'reports'},
    {href:'/labels', label:'Location labels', icon:'locations'},
  ];
  const operator = user.role !== "admin";
  const navigation = operator
    ? `${primary.map((item) => renderItem({...item, links: null})).join("")}
      <details class="side-nav-more" ${[...secondary, ...workTools].some(isItemActive) ? "open" : ""}>
        <summary class="side-nav-summary">More tools ${iconSvg("chevronDown", "nav-icon")}</summary>
        <div class="side-nav-more-content">${secondary.map(renderItem).join("")}
          ${workTools.map(renderItem).join("")}
        </div>
      </details>`
    : allowed.map(renderItem).join("");

  return `
    <aside class="dashboard-sidebar" aria-label="Dashboard navigation">
      <div class="dashboard-sidebar-inner">
        <a class="brand dashboard-brand" href="${operator ? "/work" : "/"}" aria-label="LytGuide IMS ${operator ? "My work" : "overview"}">
          <img class="brand-logo brand-logo-horizontal" src="/brand/lytguide-logo-horizontal.svg" alt="LytGuide IMS" width="420" height="112" />
        </a>
        <button type="button" class="mobile-nav-toggle" aria-expanded="false" aria-controls="warehouse-main-nav" hidden>Menu</button>
        <div class="session-box sidebar-session-box">
          <a class="session-identity sidebar-session-identity" href="/profile" aria-label="Open profile for ${escapeHtml(user.name)}">
            <span class="session-avatar">${escapeHtml(user.name.charAt(0).toUpperCase())}</span>
            <div class="session-copy"><div class="session-name">${escapeHtml(user.name)}</div><div class="session-role">${escapeHtml(user.role)}</div></div>
          </a>
        </div>
        <nav id="warehouse-main-nav" class="side-nav" aria-label="Dashboard sections" data-nav-links>${navigation}</nav>
        <div class="sidebar-footer"><form method="post" action="/logout"><button class="ghost-button sidebar-logout" type="submit">Logout</button></form></div>
      </div>
    </aside>
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
  const hasDashboardShell = Boolean(user);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · LytGuide IMS</title>
    <link rel="icon" type="image/svg+xml" href="/brand/lytguide-icon.svg" />
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="/styles.css" />
    <link rel="stylesheet" href="/work.css" />
    <script type="module" src="/app.js"></script>
    <script type="module" src="/client/mobile-nav.js"></script>
  </head>
  <body class="${hasDashboardShell ? "dashboard-body" : "auth-body"}">
    ${toast}
    <div class="dashboard-shell ${hasDashboardShell ? "" : "dashboard-shell-public"}">
      ${nav(user, title)}
      <div class="dashboard-content">
        <main class="page-shell">
          <header class="page-header">
            <h1>${escapeHtml(title)}</h1>
          </header>
          ${systemNotice}
          ${content}
        </main>
      </div>
    </div>
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
