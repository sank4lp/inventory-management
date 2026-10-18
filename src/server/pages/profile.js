import {templatePage,uiPanel,uiTable,uiFacts,uiStatus,formatUiDate} from "../ui.js";
import {effectiveUser} from "../../modules/access/service.js";
import {can} from "../../modules/access/catalog.js";
import {
  getUserProfile,
  listRecentTasksForProfileUser,
} from "../../services/inventory.js";
import {
  escapeHtml,
  formatQuantity,
  statusBadge,
} from "./shared.js";

function lastActiveLabel(profile) {
  return profile.last_active_at || profile.activity.lastTransactionAt || profile.activity.lastTaskAt;
}

export function createProfilePages({ db }) {
  function taskOwnerLink(viewer, task) {
    const label = task.created_by_name || task.created_by_username || `User #${task.created_by}`;
    if (can(viewer,"people.view")) {
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
    if (!profile) return templatePage({title, user, flash, content: `<p>Profile Not Found.</p>${backLink}`});
    const recentTasks = listRecentTasksForProfileUser(db, profile.id, 10);
    const account = effectiveUser(db, profile);
    const accountDetails = uiFacts([
      ['Name', escapeHtml(profile.name)], ['Username', escapeHtml(profile.username)],
      ['Role', escapeHtml(account.role_name)], ['Status', uiStatus(profile.status)],
      ['Date Joined', escapeHtml(formatUiDate(profile.created_at))],
      ['Last Active', escapeHtml(formatUiDate(lastActiveLabel(profile)))],
      ['Key issued', escapeHtml(formatUiDate(profile.key_issued_at))],
      ['Invited by', escapeHtml(profile.invited_by_name || '—')],
    ], 'Account details');
    const activity = uiFacts([
      ['Tasks Created', escapeHtml(formatQuantity(profile.activity.tasksCreated))],
      ['Tasks Completed', escapeHtml(formatQuantity(profile.activity.tasksCompleted))],
      ['Inventory Transactions', escapeHtml(formatQuantity(profile.activity.transactionsRecorded))],
      ['Last Task Activity', escapeHtml(formatUiDate(profile.activity.lastTaskAt))],
      ['Last Inventory Transaction', escapeHtml(formatUiDate(profile.activity.lastTransactionAt))],
    ], 'Activity summary');
    const tasks = uiTable([
      {key:'task',label:'Task'}, {key:'product',label:'Product'}, {key:'type',label:'Type'},
      {key:'status',label:'Status'}, {key:'date',label:'Activity (IST)'},
      {key:'user',label:'User'}, {key:'relationship',label:'Relationship'},
    ], recentTasks.map(task => [
      `<a href="/tasks/${task.id}">#${task.id}</a>`,
      `${escapeHtml(task.first_product_name || '—')}<small>${escapeHtml(task.first_sku || '—')}</small>`,
      statusBadge(task.type), statusBadge(task.status), escapeHtml(formatUiDate(taskActivityDate(task))),
      taskOwnerLink(user, task), escapeHtml(taskRelationshipLabel(task)),
    ]), {label:'Recent tasks',empty:'No recent tasks for this user.'});
    return templatePage({title, user, flash, currentPath:'/profile', content: `
      ${backLink}
      <div class="ui-profile-heading"><span class="ui-avatar" aria-hidden="true">${escapeHtml(profile.name.charAt(0).toUpperCase())}</span><div><small>${escapeHtml(kicker)}</small><h2>${escapeHtml(profile.name)}</h2></div></div>
      ${uiPanel('Account Details', accountDetails, {id:'account-details'})}
      ${uiPanel('Recent Activity', activity, {id:'recent-activity'})}
      ${uiPanel('Recent Tasks', tasks, {id:'profile-recent-tasks'})}
    `});
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
      backLink: `<p><a class="mini-link" href="/settings/people">Back To People &amp; Access</a></p>`,
    });
  }

  return {
    renderAdminUserProfile,
    renderProfile,
  };
}
