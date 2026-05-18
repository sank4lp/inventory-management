import { getUserProfile } from "../../services/inventory.js";
import {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  statsGrid,
  statusBadge,
} from "./shared.js";

function lastActiveLabel(profile) {
  return profile.last_active_at || profile.activity.lastTransactionAt || profile.activity.lastTaskAt || profile.created_at;
}

export function createProfilePages({ db }) {
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
