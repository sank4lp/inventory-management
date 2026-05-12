import { card, escapeHtml, formatDate, page, statsGrid, table } from "./shared.js";

function formatBytes(bytes) {
  const value = Number(bytes || 0);

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function createBackupPages({ backupService }) {
  function renderBackups(user, flash) {
    const backups = backupService.listBackups();
    const summary = backupService.getSummary();

    return page({
      title: "Backups",
      user,
      flash,
      content: `
        ${statsGrid([
          { label: "All backups", value: summary.totalBackups },
          { label: "Automatic", value: summary.automaticBackups },
          { label: "Manual", value: summary.manualBackups },
        ])}
        <section class="two-column">
          ${card(
            "Protection",
            `
              <p>The system keeps SQLite in crash-safe WAL mode and also creates an automatic backup after every important data-changing action.</p>
              <p class="muted">Automatic backups are rotated locally. The latest ${escapeHtml(
                String(summary.autoBackupLimit),
              )} automatic snapshots are kept, while manual backups stay until you delete them from the Raspberry Pi storage.</p>
              <div class="meta-grid compact-meta-grid">
                <div><strong>Database file</strong><br /><code class="path-code">${escapeHtml(summary.databasePath)}</code></div>
                <div><strong>Backup folder</strong><br /><code class="path-code">${escapeHtml(summary.backupDirectory)}</code></div>
                <div><strong>Latest snapshot</strong><br />${summary.latestBackup ? escapeHtml(formatDate(summary.latestBackup.createdAt)) : "No backups yet"}</div>
              </div>
            `,
            `
              <form method="post" action="/backups/create">
                <button type="submit">Create backup now</button>
              </form>
            `,
          )}
          ${card(
            "Restore notes",
            `
              <p>Restoring will replace the live database with the selected snapshot. A fresh manual restore point is created first so you can undo the restore if needed.</p>
              <p class="muted">This protects against bad data changes and software mistakes, but it does not protect you if the Raspberry Pi storage itself is physically destroyed. For that, you still need an off-device copy.</p>
            `,
          )}
        </section>
        ${card(
          "Available backups",
          backups.length
            ? table(
                ["Created", "Type", "Source", "Size", "Restore"],
                backups.map((backup) => [
                  escapeHtml(formatDate(backup.createdAt)),
                  `<strong>${escapeHtml(backup.kind)}</strong>`,
                  escapeHtml(backup.label),
                  escapeHtml(formatBytes(backup.sizeBytes)),
                  `
                    <form method="post" action="/backups/restore" class="inline-form inline-form-wrap">
                      <input type="hidden" name="filename" value="${escapeHtml(backup.filename)}" />
                      <input
                        name="confirm_restore"
                        placeholder="Type RESTORE"
                        pattern="RESTORE"
                        title="Type RESTORE to confirm"
                        required
                      />
                      <button type="submit" class="ghost-button">Restore</button>
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
