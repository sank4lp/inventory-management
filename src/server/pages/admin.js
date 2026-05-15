import {
  listCells,
  listProducts,
  listRegistrationKeys,
  listUsers,
} from "../../services/inventory.js";
import {
  card,
  cellPickerField,
  copyIcon,
  escapeHtml,
  formatBytes,
  formatDate,
  formatQuantity,
  page,
  renderAdjustmentLine,
  rolePickerField,
  statusBadge,
  table,
  trashIcon,
} from "./shared.js";
import { getRuntimeContext } from "../runtime-context.js";

export function createAdminPages({ db }) {
  function renderDatabaseHealth(health) {
    const lastMaintenance = health.lastMaintenance;
    const archive = health.archiveSummary;
    const backupSummary = health.backupSummary;

    return card(
      "Database health",
      `
        <div class="meta-grid compact-meta-grid">
          <div><strong>Database</strong><br />${escapeHtml(formatBytes(health.databaseBytes))}</div>
          <div><strong>WAL file</strong><br />${escapeHtml(formatBytes(health.walBytes))}</div>
          <div><strong>Backups</strong><br />${escapeHtml(formatBytes(health.backupBytes))}</div>
          <div><strong>Archives</strong><br />${escapeHtml(formatBytes(archive.totalBytes))}</div>
          <div><strong>Free pages</strong><br />${escapeHtml(formatBytes(health.freeBytes))}</div>
          <div><strong>Auto backup</strong><br />Every ${escapeHtml(
            String(health.settings.automaticBackupIntervalHours),
          )} hour(s)</div>
        </div>
        <h3>Maintenance policy</h3>
        <div class="meta-grid compact-meta-grid">
          <div><strong>Reports default</strong><br />Last ${escapeHtml(
            String(health.settings.reportDefaultDays),
          )} day(s)</div>
          <div><strong>Device logs</strong><br />${escapeHtml(
            String(health.settings.deviceEventRetentionDays),
          )} day(s)</div>
          <div><strong>System logs</strong><br />${escapeHtml(
            String(health.settings.systemEventRetentionDays),
          )} day(s)</div>
          <div><strong>Business archive</strong><br />After ${escapeHtml(
            String(health.settings.businessArchiveAfterDays),
          )} day(s)</div>
        </div>
        <h3>Storage paths</h3>
        <div class="meta-grid compact-meta-grid">
          <div><strong>Database file</strong><br /><code class="path-code">${escapeHtml(health.databasePath)}</code></div>
          <div><strong>Archive folder</strong><br /><code class="path-code">${escapeHtml(health.archiveDirectory)}</code></div>
          <div><strong>Latest auto backup</strong><br />${
            backupSummary?.latestAutomaticBackup
              ? escapeHtml(formatDate(backupSummary.latestAutomaticBackup.createdAt))
              : "No automatic backup yet"
          }</div>
          <div><strong>Latest archive</strong><br />${
            archive.latestFile ? escapeHtml(formatDate(archive.latestFile.createdAt)) : "No archive files yet"
          }</div>
          <div><strong>Last maintenance</strong><br />${
            lastMaintenance?.completedAt ? escapeHtml(formatDate(lastMaintenance.completedAt)) : "Not recorded yet"
          }</div>
          <div><strong>Maintenance errors</strong><br />${escapeHtml(
            formatQuantity(lastMaintenance?.errors?.length || 0),
          )}</div>
        </div>
        <h3>Rows by table</h3>
        ${table(
          ["Table", "Rows"],
          health.rowCounts.map((row) => [
            escapeHtml(row.tableName),
            escapeHtml(formatQuantity(row.count)),
          ]),
        )}
      `,
    );
  }

  function renderRegistrationKeyActions(key) {
    if (key.status !== "active") {
      return `<span class="muted">No action</span>`;
    }

    const confirmText = "Delete this registration key? New users will no longer be able to register with it.";
    const label = `Delete registration key ${key.key_value}`;

    return `
      <div class="mini-actions">
        <button
          type="button"
          class="icon-button ghost-button"
          data-copy-value="${escapeHtml(key.key_value)}"
          aria-label="Copy registration key ${escapeHtml(key.key_value)}"
          title="Copy registration key"
        >${copyIcon()}</button>
        <form method="post" action="/admin/registration-keys/revoke" class="inline-form">
          <input type="hidden" name="key_id" value="${key.id}" />
          <button
            type="submit"
            class="icon-button danger-button"
            aria-label="${escapeHtml(label)}"
            title="${escapeHtml(label)}"
            onclick="return confirm(${escapeHtml(JSON.stringify(confirmText))});"
          >${trashIcon()}</button>
        </form>
      </div>
    `;
  }

  function renderUserActions(currentUser, entry) {
    if (Number(entry.id) === Number(currentUser.id)) {
      return `<span class="muted">Signed in</span>`;
    }

    const nextStatus = entry.status === "active" ? "inactive" : "active";
    const label = entry.status === "active" ? "Suspend" : "Restore";
    const buttonClass = entry.status === "active" ? "ghost-button danger-button" : "green-button";
    const confirmText =
      entry.status === "active"
        ? `Suspend access for ${entry.username}?`
        : `Restore access for ${entry.username}?`;

    return `
      <form method="post" action="/admin/users/status" class="inline-form">
        <input type="hidden" name="user_id" value="${entry.id}" />
        <input type="hidden" name="status" value="${nextStatus}" />
        <button
          type="submit"
          class="${buttonClass}"
          onclick="return confirm(${escapeHtml(JSON.stringify(confirmText))});"
        >${escapeHtml(label)}</button>
      </form>
    `;
  }

  function renderAdmin(user, flash) {
    const users = listUsers(db);
    const keys = listRegistrationKeys(db);
    const products = listProducts(db);
    const cells = listCells(db);
    const runtime = getRuntimeContext();
    const dashboard = runtime.systemService?.getDashboardData(runtime.startup);
    const databaseHealth = runtime.databaseMaintenanceService?.getDatabaseHealth();

    return page({
      title: "Admin",
      user,
      flash,
      content: `
        ${
          dashboard
            ? card(
                "System",
                `
                  <div class="meta-grid compact-meta-grid">
                    <div><strong>Site</strong><br />${escapeHtml(dashboard.siteId)}</div>
                    <div><strong>Adapter</strong><br />${statusBadge(dashboard.adapterName)}</div>
                    <div><strong>Overall</strong><br />${statusBadge(
                      dashboard.health.overallStatus,
                    )}</div>
                    <div><strong>Recovery</strong><br />${escapeHtml(
                      dashboard.health.startup.recovery.message,
                    )}</div>
                  </div>
                  <h3>Recent recovery actions</h3>
                  ${
                    dashboard.recentRecoveryEvents.length
                      ? table(
                          ["When", "Status", "Message"],
                          dashboard.recentRecoveryEvents.map((event) => [
                            escapeHtml(event.created_at),
                            statusBadge(event.status),
                            escapeHtml(event.message),
                          ]),
                        )
                      : `<p class="muted">No recent recovery actions recorded.</p>`
                  }
                  <h3>Recent hardware warnings</h3>
                  ${
                    dashboard.recentHardwareFailures.length
                      ? table(
                          ["When", "Event", "Details"],
                          dashboard.recentHardwareFailures.map((event) => {
                            let details = "Hardware warning";
                            try {
                              const payload = JSON.parse(event.payload);
                              details =
                                payload.error ||
                                payload.mode ||
                                payload.type ||
                                payload.message ||
                                details;
                            } catch {}
                            return [
                              escapeHtml(event.created_at),
                              escapeHtml(event.event_type),
                              escapeHtml(details),
                            ];
                          }),
                        )
                      : `<p class="muted">No hardware warnings recorded.</p>`
                  }
                `,
              )
            : ""
        }
        ${databaseHealth ? renderDatabaseHealth(databaseHealth) : ""}
        <section class="two-column">
          ${card(
            "Registration keys",
            `
              <p class="muted">Create one one-time key per person. The key sets the account role during registration and becomes used after that person creates an account.</p>
              <div class="key-quick-actions">
                <form method="post" action="/admin/registration-keys" class="inline-form">
                  <input type="hidden" name="role" value="operator" />
                  <button type="submit" class="blue-button">Generate operator key</button>
                </form>
                <form method="post" action="/admin/registration-keys" class="inline-form">
                  <input type="hidden" name="role" value="admin" />
                  <button type="submit" class="ghost-button">Generate admin key</button>
                </form>
              </div>
              <details class="form-disclosure">
                <summary>Use a custom key value</summary>
                <form method="post" action="/admin/registration-keys" class="stack-form">
                  <label>Key value<input name="key_value" placeholder="INVITE-AKSHAY-2026" /></label>
                  <label>Role
                    ${rolePickerField()}
                  </label>
                  <button type="submit">Issue custom key</button>
                </form>
              </details>
              <div class="copy-status" data-copy-status role="status" aria-live="polite"></div>
              ${table(
                ["Key", "Role", "Status", "Action"],
                keys.map((key) => [
                  `<code>${escapeHtml(key.key_value)}</code>`,
                  statusBadge(key.role),
                  statusBadge(key.status),
                  renderRegistrationKeyActions(key),
                ]),
              )}
            `,
            "",
            `data-row-collapser data-row-limit="4" data-row-label="keys"`,
          )}
          ${card(
            "Users",
            table(
              ["Name", "Role", "Status", "Action"],
              users.map((entry) => [
                `${escapeHtml(entry.name)}<br /><small>${escapeHtml(entry.username)}</small>`,
                statusBadge(entry.role),
                statusBadge(entry.status),
                renderUserActions(user, entry),
              ]),
            ),
            "",
            `data-row-collapser data-row-limit="4" data-row-label="users"`,
          )}
        </section>
        ${card(
          "Count adjustment",
          `
            <form method="post" action="/admin/adjustments" class="stack-form" data-adjustment-form>
              <section class="guide-strip">
                <span class="guide-pill active-guide">1. Choose location</span>
                <span class="guide-pill">2. Enter counted quantity</span>
                <span class="guide-pill">3. Preview LED, then save</span>
              </section>
              <label>Cell
                ${cellPickerField(cells, null, "adjustment-cell")}
              </label>
              <div class="mini-actions">
                <button type="button" class="ghost-button" data-adjustment-locate-cell disabled>Locate cell</button>
              </div>
              <div class="adjustment-lines-header">
                <strong>Products counted in this cell</strong>
                <button type="button" class="ghost-button" data-adjustment-add>Add product line</button>
              </div>
              <div class="stack-form" data-adjustment-lines>
                ${renderAdjustmentLine(products, 0)}
              </div>
              <template data-adjustment-template>
                ${renderAdjustmentLine(products, "__INDEX__")}
              </template>
              <label>Reason<textarea name="reason" rows="3" required placeholder="Cycle count, damaged stock, or correction note"></textarea></label>
              <div class="adjustment-guidance-actions">
                <button type="button" class="ghost-button" data-adjustment-light-quantity disabled>Preview quantity LED</button>
                <button type="submit">Save count</button>
              </div>
              <div class="adjustment-guidance-status" data-adjustment-led-status role="status" aria-live="polite"></div>
              <p class="muted">Use this after a physical count. Enter the final quantity now in the location; the software records only the difference from the current balance.</p>
            </form>
          `,
        )}
      `,
    });
  }

  return { renderAdmin };
}
