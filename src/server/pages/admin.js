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

export function createAdminPages({ db }) {
  function renderAdmin(user, flash) {
    const users = listUsers(db);
    const keys = listRegistrationKeys(db);
    const products = listProducts(db);
    const cells = listCells(db);

    return page({
      title: "Admin",
      user,
      flash,
      content: `
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
