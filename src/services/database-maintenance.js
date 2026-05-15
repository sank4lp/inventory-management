import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { withTransaction } from "../db.js";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "inventory.db");
const ARCHIVE_DIR = join(DATA_DIR, "archives");
const LAST_MAINTENANCE_KEY = "database_maintenance_last_run";

const ROW_COUNT_TABLES = [
  "products",
  "cells",
  "inventory_balances",
  "tasks",
  "task_lines",
  "transactions",
  "device_events",
  "system_events",
  "submission_tokens",
];

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function daysBefore(now, days) {
  return new Date(now.getTime() - Number(days) * 24 * 60 * 60 * 1000);
}

function firstColumnValue(row) {
  const values = Object.values(row || {});
  return values[0];
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function directorySummary(path) {
  if (!existsSync(path)) {
    return {
      path,
      fileCount: 0,
      totalBytes: 0,
      latestFile: null,
    };
  }

  const files = readdirSync(path)
    .map((entry) => {
      const filePath = join(path, entry);
      const stats = statSync(filePath);
      if (!stats.isFile()) {
        return null;
      }
      return {
        filename: entry,
        path: filePath,
        sizeBytes: stats.size,
        createdAt: new Date(stats.mtimeMs).toISOString(),
      };
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  return {
    path,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    latestFile: files[0] || null,
  };
}

function readJsonMetadata(db, key) {
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key);
  if (!row?.value) {
    return null;
  }

  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function writeMetadata(db, key, value, now = new Date()) {
  db.prepare(
    `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(key, value, now.toISOString());
}

function taskArchivePredicate() {
  return `
    t.status IN ('completed', 'cancelled')
    AND COALESCE(t.completed_at, t.started_at) < ?
    AND NOT EXISTS (
      SELECT 1
      FROM transactions tr_recent
      WHERE tr_recent.task_id = t.id
        AND tr_recent.created_at >= ?
    )
  `;
}

function archiveMonth(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : "unknown";
}

function createArchiveBuckets({ tasks, taskLines, transactions, cutoffAt, generatedAt }) {
  const buckets = new Map();

  const getBucket = (month) => {
    if (!buckets.has(month)) {
      buckets.set(month, {
        archiveVersion: 1,
        month,
        generatedAt,
        cutoffAt,
        tasks: [],
        taskLines: [],
        transactions: [],
      });
    }
    return buckets.get(month);
  };

  for (const task of tasks) {
    const archiveDate = task.completed_at || task.started_at;
    getBucket(archiveMonth(archiveDate)).tasks.push(task);
  }

  for (const line of taskLines) {
    getBucket(archiveMonth(line.archive_date)).taskLines.push(line);
  }

  for (const transaction of transactions) {
    getBucket(archiveMonth(transaction.created_at)).transactions.push(transaction);
  }

  return [...buckets.values()].sort((left, right) => left.month.localeCompare(right.month));
}

function writeArchiveFiles(archives, now) {
  ensureDirectory(ARCHIVE_DIR);
  const writtenFiles = [];

  for (const archive of archives) {
    const token = randomBytes(3).toString("hex");
    const filename = `business-history-${archive.month}-${safeTimestamp(now)}-${token}.json`;
    const tempPath = join(ARCHIVE_DIR, `${filename}.tmp`);
    const finalPath = join(ARCHIVE_DIR, filename);
    writeFileSync(tempPath, `${JSON.stringify(archive, null, 2)}\n`);
    renameSync(tempPath, finalPath);
    writtenFiles.push(finalPath);
  }

  return writtenFiles;
}

export function createDatabaseMaintenanceService({
  db,
  backupService = null,
  config = {},
  logger = null,
}) {
  const deviceEventRetentionDays = Number(config.deviceEventRetentionDays || 90);
  const systemEventRetentionDays = Number(config.systemEventRetentionDays || 90);
  const businessArchiveAfterDays = Number(config.businessArchiveAfterDays || 730);

  function pruneOperationalEvents({ now = new Date() } = {}) {
    const currentTime = now instanceof Date ? now : new Date(now);
    const deviceCutoff = daysBefore(currentTime, deviceEventRetentionDays).toISOString();
    const systemCutoff = daysBefore(currentTime, systemEventRetentionDays).toISOString();

    const deviceEventsDeleted = db
      .prepare("DELETE FROM device_events WHERE created_at < ?")
      .run(deviceCutoff).changes;
    const systemEventsDeleted = db
      .prepare("DELETE FROM system_events WHERE created_at < ?")
      .run(systemCutoff).changes;

    return {
      deviceEventRetentionDays,
      systemEventRetentionDays,
      deviceCutoff,
      systemCutoff,
      deviceEventsDeleted,
      systemEventsDeleted,
    };
  }

  function archiveOldBusinessHistory({ now = new Date() } = {}) {
    const currentTime = now instanceof Date ? now : new Date(now);
    const cutoffAt = daysBefore(currentTime, businessArchiveAfterDays).toISOString();
    const predicate = taskArchivePredicate();
    const tasks = db
      .prepare(
        `
          SELECT t.*
          FROM tasks t
          WHERE ${predicate}
          ORDER BY COALESCE(t.completed_at, t.started_at), t.id
        `,
      )
      .all(cutoffAt, cutoffAt);
    const taskLines = db
      .prepare(
        `
          SELECT
            tl.*,
            COALESCE(t.completed_at, t.started_at) AS archive_date
          FROM task_lines tl
          JOIN tasks t ON t.id = tl.task_id
          WHERE ${predicate}
          ORDER BY archive_date, tl.id
        `,
      )
      .all(cutoffAt, cutoffAt);
    const transactions = db
      .prepare(
        `
          SELECT *
          FROM transactions
          WHERE created_at < ?
          ORDER BY created_at, id
        `,
      )
      .all(cutoffAt);

    if (!tasks.length && !taskLines.length && !transactions.length) {
      return {
        businessArchiveAfterDays,
        cutoffAt,
        archived: false,
        archiveFiles: [],
        safetyBackup: null,
        tasksArchived: 0,
        taskLinesArchived: 0,
        transactionsArchived: 0,
        deviceEventsDeleted: 0,
      };
    }

    const safetyBackup = backupService?.createBackup
      ? backupService.createBackup({
          kind: "manual",
          source: "pre-maintenance-archive",
        })
      : null;
    const archives = createArchiveBuckets({
      tasks,
      taskLines,
      transactions,
      cutoffAt,
      generatedAt: currentTime.toISOString(),
    });
    const archiveFiles = writeArchiveFiles(archives, currentTime);

    const deleted = withTransaction(db, () => {
      const deviceEventsDeleted = db
        .prepare(
          `
            DELETE FROM device_events
            WHERE task_id IN (
              SELECT t.id
              FROM tasks t
              WHERE ${predicate}
            )
          `,
        )
        .run(cutoffAt, cutoffAt).changes;
      const transactionsDeleted = db
        .prepare("DELETE FROM transactions WHERE created_at < ?")
        .run(cutoffAt).changes;
      const taskLinesDeleted = db
        .prepare(
          `
            DELETE FROM task_lines
            WHERE task_id IN (
              SELECT t.id
              FROM tasks t
              WHERE ${predicate}
            )
          `,
        )
        .run(cutoffAt, cutoffAt).changes;
      const tasksDeleted = db
        .prepare(
          `
            DELETE FROM tasks
            WHERE id IN (
              SELECT t.id
              FROM tasks t
              WHERE ${predicate}
            )
          `,
        )
        .run(cutoffAt, cutoffAt).changes;

      return {
        tasksDeleted,
        taskLinesDeleted,
        transactionsDeleted,
        deviceEventsDeleted,
      };
    });

    return {
      businessArchiveAfterDays,
      cutoffAt,
      archived: true,
      archiveFiles,
      safetyBackup,
      tasksArchived: tasks.length,
      taskLinesArchived: taskLines.length,
      transactionsArchived: transactions.length,
      ...deleted,
    };
  }

  function optimizeDatabase() {
    db.exec("PRAGMA optimize;");
    return { optimized: true };
  }

  function runStartupMaintenance({ now = new Date() } = {}) {
    const currentTime = now instanceof Date ? now : new Date(now);
    const summary = {
      startedAt: currentTime.toISOString(),
      completedAt: null,
      operationalPrune: null,
      businessArchive: null,
      optimize: null,
      errors: [],
    };

    try {
      summary.operationalPrune = pruneOperationalEvents({ now: currentTime });
    } catch (error) {
      summary.errors.push({ step: "operational-prune", message: error.message });
      logger?.warn?.("database.maintenance.operational_prune.failed", { error: error.message });
    }

    try {
      summary.businessArchive = archiveOldBusinessHistory({ now: currentTime });
    } catch (error) {
      summary.errors.push({ step: "business-archive", message: error.message });
      logger?.warn?.("database.maintenance.business_archive.failed", { error: error.message });
    }

    try {
      summary.optimize = optimizeDatabase();
    } catch (error) {
      summary.errors.push({ step: "optimize", message: error.message });
      logger?.warn?.("database.maintenance.optimize.failed", { error: error.message });
    }

    summary.completedAt = new Date().toISOString();
    writeMetadata(db, LAST_MAINTENANCE_KEY, JSON.stringify(summary), new Date(summary.completedAt));
    logger?.info?.("database.maintenance.completed", summary);
    return summary;
  }

  function getRowCounts() {
    return ROW_COUNT_TABLES.map((tableName) => ({
      tableName,
      count: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count || 0),
    }));
  }

  function getDatabaseHealth() {
    const pageCount = Number(firstColumnValue(db.prepare("PRAGMA page_count").get()) || 0);
    const pageSize = Number(firstColumnValue(db.prepare("PRAGMA page_size").get()) || 0);
    const freeListCount = Number(firstColumnValue(db.prepare("PRAGMA freelist_count").get()) || 0);
    const backupSummary = backupService?.getSummary ? backupService.getSummary() : null;
    const backups = backupService?.listBackups ? backupService.listBackups() : [];
    const archiveSummary = directorySummary(ARCHIVE_DIR);

    return {
      databasePath: DB_PATH,
      archiveDirectory: ARCHIVE_DIR,
      databaseBytes: fileSize(DB_PATH),
      walBytes: fileSize(`${DB_PATH}-wal`),
      shmBytes: fileSize(`${DB_PATH}-shm`),
      estimatedPageBytes: pageCount * pageSize,
      freeBytes: freeListCount * pageSize,
      rowCounts: getRowCounts(),
      backupSummary,
      backupBytes: backups.reduce((sum, backup) => sum + Number(backup.sizeBytes || 0), 0),
      archiveSummary,
      lastMaintenance: readJsonMetadata(db, LAST_MAINTENANCE_KEY),
      settings: {
        deviceEventRetentionDays,
        systemEventRetentionDays,
        businessArchiveAfterDays,
        automaticBackupIntervalHours: Number(
          backupSummary?.automaticBackupIntervalHours || config.automaticBackupIntervalHours || 24,
        ),
        automaticBackupSchedule: backupSummary?.automaticBackupSchedule || null,
        reportDefaultDays: Number(config.reportDefaultDays || 30),
      },
    };
  }

  return {
    archiveOldBusinessHistory,
    getDatabaseHealth,
    pruneOperationalEvents,
    runStartupMaintenance,
  };
}
