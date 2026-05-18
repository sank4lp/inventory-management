import {
  backupScheduleForm,
  card,
  escapeHtml,
  formatBytes,
  formatDate,
  page,
  statsGrid,
  table,
} from "./shared.js";

export function createBackupPages({ backupService }) {
  function backupKindLabel(kind) {
    const labels = {
      auto: "Automatic",
      manual: "Manual",
      critical: "Critical",
      compacted: "Compacted",
    };
    return labels[kind] || "Manual";
  }

  function renderRetentionCard(summary) {
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

    return card(
      "Retention And Compaction",
      `
        <div class="content-stack">
          <div class="backup-protection-copy">
            <p>When a new day starts, previous-day backups are compacted to the latest backup from that day. The compacted file is renamed so it is clear that extra same-day backups were removed.</p>
            <p class="muted">The system also compacts whenever it finds multiple backups for older dates, and removes backups older than the retention window. It will not reduce retention days automatically.</p>
          </div>
          ${storageWarning}
          <form method="post" action="/backups/retention" class="backup-schedule-form">
            <input type="hidden" name="return_to" value="/backups" />
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
    );
  }

  function renderBackups(user, flash) {
    const summary = backupService.getSummary();
    const backups = backupService.listBackups();

    return page({
      title: "Backups",
      user,
      flash,
      content: `
        ${statsGrid([
          { label: "All Backups", value: summary.totalBackups },
          { label: "Automatic", value: summary.automaticBackups },
          { label: "Compacted", value: summary.compactedBackups },
          { label: "Critical", value: summary.criticalBackups },
          { label: "Manual", value: summary.manualBackups },
        ])}
        <section class="two-column">
          ${card(
            "Protection",
            `
              <div class="backup-protection-copy">
                <p>The system keeps SQLite in crash-safe WAL mode and checks whether a new automatic snapshot is due.</p>
                <p class="muted">The latest ${escapeHtml(
                  String(summary.autoBackupLimit),
                )} automatic snapshots are kept during the active day. Older days are compacted to one backup per day and retained for ${escapeHtml(
                  String(summary.retentionDays),
                )} day(s).</p>
              </div>
              <div class="meta-grid compact-meta-grid">
                <div><strong>Database File</strong><br /><code class="path-code">${escapeHtml(summary.databasePath)}</code></div>
                <div><strong>Backup Folder</strong><br /><code class="path-code">${escapeHtml(summary.backupDirectory)}</code></div>
                <div><strong>Automatic Cadence</strong><br />${escapeHtml(summary.automaticBackupSchedule.label)}</div>
                <div><strong>Latest Snapshot</strong><br />${summary.latestBackup ? escapeHtml(formatDate(summary.latestBackup.createdAt)) : "No backups yet"}</div>
                <div><strong>Backup Storage</strong><br />${escapeHtml(formatBytes(summary.totalBackupBytes))}</div>
                <div><strong>Free Disk</strong><br />${summary.disk ? escapeHtml(formatBytes(summary.disk.freeBytes)) : "Unknown"}</div>
              </div>
            `,
            `
              <form method="post" action="/backups/create">
                <button type="submit">Create Backup Now</button>
              </form>
            `,
          )}
          ${card(
            "Automatic Schedule",
            `
              <div class="backup-schedule-panel">
                ${backupScheduleForm(summary, { returnTo: "/backups" })}
              </div>
            `,
          )}
          ${renderRetentionCard(summary)}
          ${card(
            "Restore Notes",
            `
              <p>Restoring will replace the live database with the selected snapshot. A fresh manual restore point is created first so you can undo the restore if needed.</p>
              <p class="muted">This protects against bad data changes and software mistakes, but it does not protect you if the Raspberry Pi storage itself is physically destroyed. For that, you still need an off-device copy.</p>
            `,
          )}
        </section>
        ${card(
          "Available Backups",
          backups.length
            ? table(
                ["Created", "Type", "Source", "Size", "Restore"],
                backups.map((backup) => [
                  escapeHtml(formatDate(backup.createdAt)),
                  `<strong>${escapeHtml(backupKindLabel(backup.kind))}</strong>`,
                  escapeHtml(backup.label),
                  escapeHtml(formatBytes(backup.sizeBytes)),
                  `
                    <form method="post" action="/backups/restore" class="inline-form inline-form-wrap">
                      <input type="hidden" name="filename" value="${escapeHtml(backup.filename)}" />
                      <label>Confirm Restore
                        <input
                          name="confirm_restore"
                          placeholder="Type RESTORE"
                          pattern="RESTORE"
                          title="Type RESTORE to confirm"
                          required
                        />
                      </label>
                      <button type="submit" class="ghost-button danger-button">Restore Database</button>
                    </form>
                  `,
                ]),
              )
            : `<p class="muted">No backups have been created yet.</p>`,
          "",
          `data-row-collapser data-row-limit="5" data-row-label="backups"`,
        )}
      `,
    });
  }

  return {
    renderBackups,
  };
}
