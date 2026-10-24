import {templatePage,uiPanel,uiFacts,uiTable,uiDisclosure,uiDialog,uiDialogButton} from "../ui.js";
import {can} from "../../modules/access/catalog.js";
import {
  backupScheduleForm,
  escapeHtml,
  formatBytes,
  formatDate,
} from "./shared.js";

export function renderRetentionCard(summary, { returnTo = "/backups", attributes = "" } = {}) {
  const lastCompaction = summary.lastCompaction;
  const compactedDays = lastCompaction?.compactedDays || [];
  const retentionDeleted = lastCompaction?.retentionDeleted || [];
  const storageWarning = summary.storageWarning
    ? `
        <p class="flash flash-warning">
          Retention Days Need To Be Reduced: at the latest backup size, ${escapeHtml(
            String(summary.retentionDays),
          )} retained day(s) plus active-day backups may use about ${escapeHtml(formatBytes(summary.estimatedRetentionBytes))}.
          Reduce retention to about ${escapeHtml(
            String(summary.suggestedRetentionDays),
          )} day(s) to avoid filling Raspberry Pi storage and risking backup loss.
        </p>
      `
    : "";

  return uiDisclosure(
    "Retention And Compaction",
    `
      <div class="content-stack">
        <details class="ui-help"><summary>How retention works</summary>
          <p>When a new day starts, previous-day backups are compacted to the latest backup from that day. The compacted file is renamed so it is clear that extra same-day backups were removed.</p>
          <p class="muted">The system also compacts whenever it finds multiple backups for older dates, and removes backups older than the retention window. It will not reduce retention days automatically.</p>
        </details>
        ${storageWarning}
        <form method="post" action="/backups/retention" class="backup-schedule-form">
          <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
          <label>Retention Days
            <input
              type="number"
              name="retention_days"
              min="${escapeHtml(String(summary.minBackupRetentionDays))}"
              max="${escapeHtml(String(summary.maxBackupRetentionDays))}"
              step="1"
              value="${escapeHtml(String(summary.retentionDays))}"
              required
            />
          </label>
          <button type="submit">Save Retention</button>
          <div class="backup-schedule-summary">
            <strong>${escapeHtml(String(summary.retentionDays))} Day(s)</strong>
            <span>Current backups use ${escapeHtml(formatBytes(summary.totalBackupBytes))}</span>
            <span>Daily estimate ${escapeHtml(formatBytes(summary.estimatedRetentionBytes))}</span>
            <span>Active day limit ${escapeHtml(String(summary.activeDayBackupLimit))}</span>
          </div>
        </form>
        <div class="meta-grid compact-meta-grid">
          <div><strong>Last Compaction</strong><br />${
            lastCompaction?.completedAt ? escapeHtml(formatDate(lastCompaction.completedAt)) : "Not recorded yet"
          }</div>
          <div><strong>Compacted Days</strong><br />${
            compactedDays.length
              ? escapeHtml(compactedDays.map((day) => day.date).join(", "))
              : "No previous days compacted yet"
          }</div>
          <div><strong>Removed Backups</strong><br />${escapeHtml(
            String(lastCompaction?.removedCount || 0),
          )}</div>
          <div><strong>Retention Deletes</strong><br />${escapeHtml(
            String(retentionDeleted.length),
          )}</div>
        </div>
      </div>
    `,
    {id: attributes.match(/id="([^"]+)"/)?.[1] || 'retention-compaction', open: Boolean(summary.storageWarning)},
  );
}

export function createBackupPages({backupService}) {
  const kindLabel=kind=>({auto:'Automatic',manual:'Manual',critical:'Critical',compacted:'Compacted'}[kind]||'Manual');
  function renderBackups(user,flash) {
    const summary=backupService.getSummary(),backups=backupService.listBackups();
    const configure=can(user,'backups.configure'),restore=can(user,'backups.restore');
    const restoreDialogs=restore?backups.map((backup,index)=>uiDialog('restore-backup-'+index,'Restore database',`
      ${uiFacts([['Snapshot',escapeHtml(formatDate(backup.createdAt))],['Type',escapeHtml(kindLabel(backup.kind))],['Source',escapeHtml(backup.label)]])}
      <p>Restoring replaces the live database. A fresh manual restore point is created first so you can undo the restore.</p>
      <form method="post" action="/backups/restore" class="ui-form"><input type="hidden" name="filename" value="${escapeHtml(backup.filename)}"><label>Confirm Restore<input name="confirm_restore" placeholder="Type RESTORE" pattern="RESTORE" title="Type RESTORE to confirm" required></label><button type="submit" class="danger-button">Restore Database</button></form>`,{dismissible:false})).join(''):'';
    const schedule=configure?uiDialog('backup-schedule','Automatic Schedule',backupScheduleForm(summary,{returnTo:'/backups'})):'';
    return templatePage({title:'Backups & recovery',user,flash,content:`<div class="ui-settings-page">
      <nav class="ui-toolbar"><a href="/settings">← Settings</a></nav>
      ${uiPanel('Backup status',`${uiFacts([['All Backups',summary.totalBackups],['Automatic',summary.automaticBackups],['Compacted',summary.compactedBackups],['Critical',summary.criticalBackups],['Manual',summary.manualBackups],['Latest Snapshot',summary.latestBackup?escapeHtml(formatDate(summary.latestBackup.createdAt)):'No backups yet'],['Automatic Cadence',escapeHtml(summary.automaticBackupSchedule.label)],['Backup Storage',escapeHtml(formatBytes(summary.totalBackupBytes))],['Free Disk',summary.disk?escapeHtml(formatBytes(summary.disk.freeBytes)):'Unknown']])}`,{actions:`<div class="ui-actions">${can(user,'backups.create')?'<form method="post" action="/backups/create" id="create-backup"><button type="submit">Create Backup Now</button></form>':''}${configure?uiDialogButton('backup-schedule','Automatic Schedule'):''}</div>`})}
      ${uiPanel('Available Backups',uiTable([{key:'date',label:'Created'},{key:'type',label:'Type'},{key:'detail',label:'Source'},{key:'size',label:'Size'},{key:'action',label:'Restore'}],backups.map((backup,index)=>[escapeHtml(formatDate(backup.createdAt)),escapeHtml(kindLabel(backup.kind)),escapeHtml(backup.label),escapeHtml(formatBytes(backup.sizeBytes)),restore?uiDialogButton('restore-backup-'+index,'Restore'):'—']),{label:'Available backups',empty:'No backups have been created yet.',rowLimit:5,rowLabel:'backups'}),{id:'available-backups'})}
      ${configure?renderRetentionCard(summary):''}
      ${uiDisclosure('Storage details & protection',`${uiFacts([['Database File',`<code class="path-code">${escapeHtml(summary.databasePath)}</code>`],['Backup Folder',`<code class="path-code">${escapeHtml(summary.backupDirectory)}</code>`]])}<p>The database uses crash-safe WAL mode. The latest ${escapeHtml(String(summary.autoBackupLimit))} automatic snapshots are kept during the active day. Older days keep one backup per day for ${escapeHtml(String(summary.retentionDays))} days.</p><p>Keep an off-device copy to protect against damaged Raspberry Pi storage.</p>`)}
      ${schedule}${restoreDialogs}
    </div>`});
  }
  return {renderBackups};
}
