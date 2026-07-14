import {
  getUserProfile,
  listRecentTasksForProfileUser,
} from "../../services/inventory.js";
import {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  statsGrid,
  statusBadge,
  table,
} from "./shared.js";

function lastActiveLabel(profile) {
  return profile.last_active_at || profile.activity.lastTransactionAt || profile.activity.lastTaskAt || profile.created_at;
}

export function createProfilePages({ db }) {
  function taskOwnerLink(viewer, task) {
    const label = task.created_by_name || task.created_by_username || `User #${task.created_by}`;
    if (viewer.role === "admin") {
      return `<a class="mini-link" href="/admin/users/${task.created_by}">${escapeHtml(label)}</a>`;
    }
    if (Number(viewer.id) === Number(task.created_by)) {
      return `<a class="mini-link" href="/profile">${escapeHtml(label)}</a>`;
    }
    return escapeHtml(label);
  }

  function taskRelationshipLabel(task) {
    const created = Number(task.created_by_profile_user || 0) === 1;
    const interacted = Number(task.interaction_count || 0) > 0;
    if (created && interacted) {
      return "Created + Interacted";
    }
    return created ? "Created" : "Interacted";
  }

  function taskActivityDate(task) {
    return task.last_interaction_at || task.completed_at || task.last_touched_at || task.started_at;
  }

  function renderProfilePage({ user, flash, profile, title = "Profile", kicker = "Signed In As", backLink = "" }) {
    if (!profile) {
      return page({
        title,
        user,
        flash,
        content: `
          <section class="single-column-wide profile-page">
            <p class="flash flash-error">Profile Not Found.</p>
            ${backLink}
          </section>
        `,
      });
    }

    const recentTasks = listRecentTasksForProfileUser(db, profile.id, 10);

    return page({
      title,
      user,
      flash,
      content: `
        <section class="single-column-wide profile-page">
          ${backLink}
          <section class="profile-hero app-panel">
            <div class="profile-hero-mark">${escapeHtml(profile.name.charAt(0).toUpperCase())}</div>
            <div class="profile-hero-copy">
              <p class="profile-kicker">${escapeHtml(kicker)}</p>
              <h2>${escapeHtml(profile.name)}</h2>
              <p class="muted">${escapeHtml(profile.username)} · ${statusBadge(profile.role)} ${statusBadge(profile.status)}</p>
            </div>
          </section>

          ${statsGrid([
            { label: "Tasks Created", value: formatQuantity(profile.activity.tasksCreated) },
            { label: "Tasks Completed", value: formatQuantity(profile.activity.tasksCompleted) },
            { label: "Inventory Transactions", value: formatQuantity(profile.activity.transactionsRecorded) },
            { label: "Last Active", value: formatDate(lastActiveLabel(profile)) },
          ])}

          ${card(
            "Account Details",
            `
              <div class="meta-grid">
                <div>
                  <strong>Name</strong>
                  <span>${escapeHtml(profile.name)}</span>
                </div>
                <div>
                  <strong>Username</strong>
                  <span>${escapeHtml(profile.username)}</span>
                </div>
                <div>
                  <strong>Role</strong>
                  <span>${statusBadge(profile.role)}</span>
                </div>
                <div>
                  <strong>Status</strong>
                  <span>${statusBadge(profile.status)}</span>
                </div>
                <div>
                  <strong>Date Joined</strong>
                  <span>${escapeHtml(formatDate(profile.created_at))}</span>
                </div>
                <div>
                  <strong>Last Active</strong>
                  <span>${escapeHtml(formatDate(lastActiveLabel(profile)))}</span>
                </div>
              </div>
            `,
            "",
            `id="account-details"`,
          )}

          ${card(
            "Recent Activity",
            `
              <div class="meta-grid">
                <div>
                  <strong>Last Task Activity</strong>
                  <span>${escapeHtml(formatDate(profile.activity.lastTaskAt))}</span>
                </div>
                <div>
                  <strong>Last Inventory Transaction</strong>
                  <span>${escapeHtml(formatDate(profile.activity.lastTransactionAt))}</span>
                </div>
              </div>
            `,
            "",
            `id="recent-activity"`,
          )}

          ${card(
            "Recent Tasks",
            recentTasks.length
              ? table(
                  ["Task", "User", "Product", "Type", "Status", "Activity", "Relationship"],
                  recentTasks.map((task) => [
                    `<a href="/tasks/${task.id}">#${task.id}</a>`,
                    taskOwnerLink(user, task),
                    `${escapeHtml(task.first_product_name || "—")}<br /><small>${escapeHtml(task.first_sku || "—")}</small>`,
                    statusBadge(task.type),
                    statusBadge(task.status),
                    escapeHtml(formatDate(taskActivityDate(task))),
                    escapeHtml(taskRelationshipLabel(task)),
                  ]),
                )
              : `<p class="muted">No recent tasks for this user.</p>`,
            "",
            `id="profile-recent-tasks"`,
          )}
        </section>
      `,
    });
  }

  function renderProfile(user, flash) {
    return renderProfilePage({
      user,
      flash,
      profile: getUserProfile(db, user.id),
    });
  }

  function renderAdminUserProfile(user, flash, targetUserId) {
    return renderProfilePage({
      user,
      flash,
      profile: getUserProfile(db, targetUserId),
      title: "Admin User Profile",
      kicker: "User Account",
      backLink: `<p><a class="mini-link" href="/admin">Back To Admin</a></p>`,
    });
  }

  return {
    renderAdminUserProfile,
    renderProfile,
  };
}
