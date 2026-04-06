import {
  listCells,
  listProducts,
  listRegistrationKeys,
  listUsers,
} from "../../services/inventory.js";
import {
  card,
  cellPickerField,
  escapeHtml,
  page,
  renderAdjustmentLine,
  rolePickerField,
  statusBadge,
  table,
} from "./shared.js";
import { getRuntimeContext } from "../runtime-context.js";

export function createAdminPages({ db }) {
  function renderAdmin(user, flash) {
    const users = listUsers(db);
    const keys = listRegistrationKeys(db);
    const products = listProducts(db);
    const cells = listCells(db);
    const runtime = getRuntimeContext();
    const dashboard = runtime.systemService?.getDashboardData(runtime.startup);

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
        <section class="two-column">
          ${card(
            "Registration keys",
            `
              <form method="post" action="/admin/registration-keys" class="stack-form">
                <label>Key value<input name="key_value" required placeholder="INVITE-OP-2026-2" /></label>
                <label>Role
                  ${rolePickerField()}
                </label>
                <button type="submit">Issue key</button>
              </form>
              ${table(
                ["Key", "Role", "Status"],
                keys.map((key) => [
                  `<code>${escapeHtml(key.key_value)}</code>`,
                  statusBadge(key.role),
                  statusBadge(key.status),
                ]),
              )}
            `,
          )}
          ${card(
            "Users",
            table(
              ["Name", "Role", "Status"],
              users.map((entry) => [
                `${escapeHtml(entry.name)}<br /><small>${escapeHtml(entry.username)}</small>`,
                statusBadge(entry.role),
                statusBadge(entry.status),
              ]),
            ),
          )}
        </section>
        ${card(
          "Adjustment",
          `
            <form method="post" action="/admin/adjustments" class="stack-form" data-adjustment-form>
              <label>Cell
                ${cellPickerField(cells, null, "adjustment-cell")}
              </label>
              <div class="adjustment-lines-header">
                <strong>Products and quantity changes</strong>
                <button type="button" class="ghost-button" data-adjustment-add>Add product line</button>
              </div>
              <div class="stack-form" data-adjustment-lines>
                ${renderAdjustmentLine(products, 0)}
              </div>
              <template data-adjustment-template>
                ${renderAdjustmentLine(products, "__INDEX__")}
              </template>
              <label>Reason<textarea name="reason" rows="3" required placeholder="Short reason"></textarea></label>
              <button type="submit">Create adjustment batch</button>
              <p class="muted">Enter the final counted quantity for each product in this cell. The software will calculate the adjustment automatically.</p>
            </form>
          `,
        )}
      `,
    });
  }

  return { renderAdmin };
}
