import {templatePage,uiPanel,uiFacts,uiTable,uiDisclosure} from "../ui.js";
import {renderPeopleAccess} from "./people.js";
import {
  listCells,
  listProducts,
} from "../../services/inventory.js";
import { getReportFormatSettings } from "../../services/report-format.js";
import { readPendingReviewTimeoutSettings } from "../../services/task-timeout-settings.js";
import {
  card,
  cellPickerField,
  escapeHtml,
  formatBytes,
  formatDate,
  formatQuantity,
  renderAdjustmentLine,
  statusBadge,
  table,
} from "./shared.js";
import { getRuntimeContext } from "../runtime-context.js";
import { renderRetentionCard } from "./backups.js";
import { renderReportFormatEditor } from "./report-format-editor.js";

export function createAdminPages({ db, backupService = null }) {
  function renderDatabaseHealth(health) {
    const last=health.lastMaintenance,archive=health.archiveSummary,backup=health.backupSummary;
    return uiPanel('Database Health',`<div class="content-stack">
      ${uiFacts([['Database',escapeHtml(formatBytes(health.databaseBytes))],['WAL File',escapeHtml(formatBytes(health.walBytes))],['Backups',escapeHtml(formatBytes(health.backupBytes))],['Archives',escapeHtml(formatBytes(archive.totalBytes))],['Free Pages',escapeHtml(formatBytes(health.freeBytes))],['Auto Backup',escapeHtml(health.settings.automaticBackupSchedule?.label||`Every ${health.settings.automaticBackupIntervalHours} hour(s)`)],['Last Maintenance',last?.completedAt?escapeHtml(formatDate(last.completedAt)):'Not recorded yet'],['Maintenance Errors',escapeHtml(formatQuantity(last?.errors?.length||0))]])}
      ${uiDisclosure('Maintenance policy',uiFacts([['Reports Default',`Last ${escapeHtml(String(health.settings.reportDefaultDays))} day(s)`],['Device Logs',`${escapeHtml(String(health.settings.deviceEventRetentionDays))} day(s)`],['System Logs',`${escapeHtml(String(health.settings.systemEventRetentionDays))} day(s)`],['Business Archive',`After ${escapeHtml(String(health.settings.businessArchiveAfterDays))} day(s)`]]))}
      ${uiDisclosure('Storage paths & latest files',uiFacts([['Database File',`<code class="path-code">${escapeHtml(health.databasePath)}</code>`],['Archive Folder',`<code class="path-code">${escapeHtml(health.archiveDirectory)}</code>`],['Latest Auto Backup',backup?.latestAutomaticBackup?escapeHtml(formatDate(backup.latestAutomaticBackup.createdAt)):'No automatic backup yet'],['Latest Archive',archive.latestFile?escapeHtml(formatDate(archive.latestFile.createdAt)):'No archive files yet']]))}
      ${uiDisclosure('Rows by table',uiTable([{key:'table',label:'Table'},{key:'rows',label:'Rows'}],health.rowCounts.map(row=>[escapeHtml(row.tableName),escapeHtml(formatQuantity(row.count))]),{label:'Database rows'}))}
    </div>`,{id:'database-health'});
  }
  function renderSystemOverview(dashboard) {
    const recovery=uiTable([{key:'date',label:'When'},{key:'status',label:'Status'},{key:'detail',label:'Message'}],dashboard.recentRecoveryEvents.map(event=>[escapeHtml(formatDate(event.created_at)),statusBadge(event.status),escapeHtml(event.message)]),{label:'Recent recovery actions',empty:'No recent recovery actions recorded.'});
    const warnings=uiTable([{key:'date',label:'When'},{key:'event',label:'Event'},{key:'detail',label:'Details'}],dashboard.recentHardwareFailures.map(event=>{let details='Hardware warning';try{const v=JSON.parse(event.payload);details=v.error||v.mode||v.type||v.message||details;}catch{}return [escapeHtml(formatDate(event.created_at)),escapeHtml(event.event_type),escapeHtml(details)];}),{label:'Recent hardware warnings',empty:'No hardware warnings recorded.'});
    return uiPanel('System',`<div class="content-stack">${uiFacts([['Site',escapeHtml(dashboard.siteId)],['Adapter',statusBadge(dashboard.adapterName)],['Overall',statusBadge(dashboard.health.overallStatus)],['Recovery',escapeHtml(dashboard.health.startup.recovery.message)]])}
      ${uiDisclosure('Recent recovery actions',recovery)}
      ${uiDisclosure('Recent hardware warnings',`<p class="muted">Past command warnings. Check Hardware for current controller health.</p>${warnings}`)}
    </div>`);
  }

  function renderTaskTimeoutSettings() {
    const settings = readPendingReviewTimeoutSettings(db);
    return card(
      "Task Completion Timeout",
      `
        <form method="post" action="/admin/task-timeout" class="stack-form">
          <div class="meta-grid compact-meta-grid">
            <div><strong>Current Wait</strong><br />${escapeHtml(String(settings.timeoutMinutes))} Minute(s)</div>
            <div><strong>Default</strong><br />${escapeHtml(String(settings.defaultMinutes))} Minute(s)</div>
            <div><strong>Range</strong><br />${escapeHtml(String(settings.minMinutes))}-${escapeHtml(String(settings.maxMinutes))} Minute(s)</div>
            <div><strong>Last Updated</strong><br />${
              settings.updatedAt ? escapeHtml(formatDate(settings.updatedAt)) : "Default Setting"
            }</div>
          </div>
          <label>Complete Task Wait Time
            <input
              type="number"
              name="timeout_minutes"
              min="${escapeHtml(String(settings.minMinutes))}"
              max="${escapeHtml(String(settings.maxMinutes))}"
              step="1"
              value="${escapeHtml(String(settings.timeoutMinutes))}"
              required
            />
          </label>
          <p class="muted">Pick and Put allocations that are inactive for this many minutes are flagged in Pending confirmations. Reservations remain held until the actual work is verified.</p>
          <button type="submit" class="blue-button">Save Timeout</button>
        </form>
      `,
      "",
      `id="task-completion-timeout"`,
    );
  }

  function renderAdmin(user, flash, section = "all") {
    const products = listProducts(db);
    const cells = listCells(db);
    const runtime = getRuntimeContext();
    const dashboard = runtime.systemService?.getDashboardData(runtime.startup);
    const databaseHealth = runtime.databaseMaintenanceService?.getDatabaseHealth();
    const backupSummary = backupService?.getSummary();
    const reportFormat = getReportFormatSettings(db);
    const countAdjustmentCard = card(
      "Count Adjustment",
      `
        <form method="post" action="/admin/adjustments" class="stack-form" data-adjustment-form>
          <div class="adjustment-cell-selector">
            <label>Cell
              ${cellPickerField(cells, null, "adjustment-cell")}
            </label>
            <button type="button" class="ghost-button" data-adjustment-locate-cell disabled>Locate Cell</button>
          </div>
          <div class="adjustment-lines-shell">
            <div class="adjustment-lines-header">
              <strong>Products Counted In This Cell</strong>
              <button type="button" class="ghost-button" data-adjustment-add disabled>Add Product Line</button>
            </div>
            <div class="stack-form adjustment-lines" data-adjustment-lines>
              <div class="adjustment-empty-state" data-adjustment-empty>
                Select a cell to load saved product counts.
              </div>
            </div>
          </div>
          <template data-adjustment-template>
            ${renderAdjustmentLine(products, "__INDEX__")}
          </template>
          <label>Reason<textarea name="reason" rows="3" required placeholder="Cycle count, damaged stock, or correction note"></textarea></label>
          <div class="adjustment-guidance-actions">
            <button type="button" class="ghost-button" data-adjustment-light-quantity disabled>Preview Quantity LED</button>
            <button type="submit">Save Count</button>
          </div>
          <div class="adjustment-guidance-status" data-adjustment-led-status role="status" aria-live="polite"></div>
        </form>
      `,
      "",
      `id="count-adjustment"`,
    );
    const accessManagementSection = renderPeopleAccess({db, user});
    const settingsSection = `
      <section id="settings" class="two-column admin-settings-grid">
        ${renderTaskTimeoutSettings()}
        ${
          backupSummary
            ? renderRetentionCard(backupSummary, {
                returnTo: "/admin#settings",
                attributes: `id="retention-compaction"`,
              })
            : ""
        }
      </section>
    `;
    const reportFormatSection = renderReportFormatEditor(reportFormat, {
      user,
      returnTo: "/admin#report-format",
      collapsible: false,
      attributes: `id="report-format"`,
    });

    return templatePage({
      title: section === "people" ? "Settings · People & access" : section === "system" ? "Settings · System" : "Settings",
      user,
      flash,
      currentPath: section === "people" ? "/settings/people" : "/settings/system",
      content: `
        ${section === "people" || section === "all" ? accessManagementSection : ""}
        ${section === "all" ? `<p id="count-adjustment"><a href="/stocktaking">Stocktaking — count, review and correct</a></p><p id="report-format"><a href="/reports?format=1">Report appearance</a></p>` : ""}
        ${section !== "people" ? `<nav class="ui-toolbar"><a href="/settings">← Settings</a><a href="/work/timing">Timing settings</a><a href="/backups">Backups & recovery</a></nav><div class="ui-settings-page">` : ""}
        ${dashboard && section !== "people" ? renderSystemOverview(dashboard) : ""}
        ${databaseHealth && section !== "people" ? renderDatabaseHealth(databaseHealth) : ""}
        ${section !== "people" ? '</div>' : ''}
      `,
    });
  }

  return { renderAdmin };
}
