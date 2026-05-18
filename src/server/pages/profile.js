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
  function renderProfile(user, flash) {
    const profile = getUserProfile(db, user.id);
    if (!profile) {
      return page({
        title: "Profile",
        user,
        flash,
        content: `<p class="flash flash-error">Profile not found.</p>`,
      });
    }

    return page({
      title: "Profile",
      user,
      flash,
      content: `
        <section class="single-column-wide profile-page">
          <section class="profile-hero app-panel">
            <div class="profile-hero-mark">${escapeHtml(profile.name.charAt(0).toUpperCase())}</div>
            <div class="profile-hero-copy">
              <p class="profile-kicker">Signed in as</p>
              <h2>${escapeHtml(profile.name)}</h2>
              <p class="muted">${escapeHtml(profile.username)} · ${statusBadge(profile.role)} ${statusBadge(profile.status)}</p>
            </div>
          </section>

          ${statsGrid([
            { label: "Tasks created", value: formatQuantity(profile.activity.tasksCreated) },
            { label: "Tasks completed", value: formatQuantity(profile.activity.tasksCompleted) },
            { label: "Inventory transactions", value: formatQuantity(profile.activity.transactionsRecorded) },
            { label: "Last active", value: formatDate(lastActiveLabel(profile)) },
          ])}

          ${card(
            "Account details",
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
                  <strong>Date joined</strong>
                  <span>${escapeHtml(formatDate(profile.created_at))}</span>
                </div>
                <div>
                  <strong>Last active</strong>
                  <span>${escapeHtml(formatDate(lastActiveLabel(profile)))}</span>
                </div>
              </div>
            `,
          )}

          ${card(
            "Recent activity",
            `
              <div class="meta-grid">
                <div>
                  <strong>Last task activity</strong>
                  <span>${escapeHtml(formatDate(profile.activity.lastTaskAt))}</span>
                </div>
                <div>
                  <strong>Last inventory transaction</strong>
                  <span>${escapeHtml(formatDate(profile.activity.lastTransactionAt))}</span>
                </div>
              </div>
            `,
          )}
        </section>
      `,
    });
  }

  return {
    renderProfile,
  };
}
