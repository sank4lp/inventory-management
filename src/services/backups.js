import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_AUTO_BACKUP_LIMIT = 48;
const DEFAULT_AUTO_BACKUP_INTERVAL_HOURS = 24;
const DEFAULT_BACKUP_RETENTION_DAYS = 30;
const MIN_BACKUP_RETENTION_DAYS = 1;
const MAX_BACKUP_RETENTION_DAYS = 365;
const BACKUP_STORAGE_WARNING_BYTES = 2 * 1024 * 1024 * 1024;
const LAST_AUTO_BACKUP_KEY = "backup_last_auto_at";
const AUTO_BACKUP_SCHEDULE_KEY = "backup_automatic_schedule";
const BACKUP_RETENTION_DAYS_KEY = "backup_retention_days";
const BACKUP_LAST_COMPACTION_KEY = "backup_last_compaction";
const DEFAULT_AUTO_BACKUP_START_TIME = "00:00";
const DEFAULT_AUTO_BACKUP_ANCHOR_DATE = "1970-01-01";
const AUTO_BACKUP_SCHEDULES = {
  every_8_hours: {
    cadence: "every_8_hours",
    label: "Every 8 hours",
    intervalHours: 8,
    type: "fixed",
  },
  every_12_hours: {
    cadence: "every_12_hours",
    label: "Every 12 hours",
    intervalHours: 12,
    type: "fixed",
  },
  daily: {
    cadence: "daily",
    label: "Daily",
    intervalHours: 24,
    type: "fixed",
  },
  weekly: {
    cadence: "weekly",
    label: "Weekly",
    intervalHours: 24 * 7,
    type: "fixed",
  },
  biweekly: {
    cadence: "biweekly",
    label: "Bi Weekly",
    intervalHours: 24 * 14,
    type: "fixed",
  },
  monthly: {
    cadence: "monthly",
    label: "Monthly",
    intervalHours: 24 * 30,
    type: "monthly",
  },
};

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function dataDir() {
  return join(process.cwd(), "data");
}

function dbPath() {
  return join(dataDir(), "inventory.db");
}

function backupDir() {
  return join(dataDir(), "backups");
}

function escapeSqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function validDateString(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeStartTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return DEFAULT_AUTO_BACKUP_START_TIME;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return DEFAULT_AUTO_BACKUP_START_TIME;
  }

  return `${pad2(hours)}:${pad2(minutes)}`;
}

function slugify(value) {
  const slug = String(value || "backup")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "backup";
}

function clampInteger(value, fallback, { min, max }) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function firstColumnValue(row) {
  const values = Object.values(row || {});
  return values[0];
}

function readMetadata(db, key) {
  return db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key)?.value || null;
}

function writeMetadata(db, key, value, updatedAt = new Date()) {
  db.prepare(
    `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(key, value, updatedAt.toISOString());
}

function scheduleOptionFromIntervalHours(intervalHours) {
  const hours = Number(intervalHours || DEFAULT_AUTO_BACKUP_INTERVAL_HOURS);
  return (
    Object.values(AUTO_BACKUP_SCHEDULES).find(
      (option) => option.intervalHours === hours,
    ) || AUTO_BACKUP_SCHEDULES.daily
  );
}

function parseScheduleRecord(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSchedule(record = null, fallbackIntervalHours = DEFAULT_AUTO_BACKUP_INTERVAL_HOURS) {
  const fallbackOption = scheduleOptionFromIntervalHours(fallbackIntervalHours);
  const option = AUTO_BACKUP_SCHEDULES[record?.cadence] || fallbackOption;
  const startTime = normalizeStartTime(record?.startTime);
  const anchorDate =
    validDateString(record?.anchorDate) ||
    (record?.cadence ? localDateString(new Date()) : DEFAULT_AUTO_BACKUP_ANCHOR_DATE);

  return {
    cadence: option.cadence,
    label: option.label,
    intervalHours: option.intervalHours,
    type: option.type,
    startTime,
    anchorDate,
    updatedAt: record?.updatedAt || null,
  };
}

function dateAtLocal(dateString, startTime) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hours, minutes] = startTime.split(":").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function monthlySlot(schedule, offsetMonths) {
  const [year, month, day] = schedule.anchorDate.split("-").map(Number);
  const [hours, minutes] = schedule.startTime.split(":").map(Number);
  const monthIndex = month - 1 + offsetMonths;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonthIndex));
  return new Date(targetYear, targetMonthIndex, targetDay, hours, minutes, 0, 0);
}

function latestScheduledSlot(schedule, currentTime) {
  const anchor = dateAtLocal(schedule.anchorDate, schedule.startTime);
  if (currentTime.getTime() < anchor.getTime()) {
    return null;
  }

  if (schedule.type === "monthly") {
    let offset = Math.max(
      0,
      (currentTime.getFullYear() - anchor.getFullYear()) * 12 +
        (currentTime.getMonth() - anchor.getMonth()) -
        1,
    );
    while (monthlySlot(schedule, offset + 1).getTime() <= currentTime.getTime()) {
      offset += 1;
    }
    return monthlySlot(schedule, offset);
  }

  const intervalMs = Number(schedule.intervalHours) * 60 * 60 * 1000;
  const elapsedMs = currentTime.getTime() - anchor.getTime();
  const intervalsElapsed = Math.floor(elapsedMs / intervalMs);
  return new Date(anchor.getTime() + intervalsElapsed * intervalMs);
}

function nextScheduledSlot(schedule, currentTime) {
  const anchor = dateAtLocal(schedule.anchorDate, schedule.startTime);
  if (currentTime.getTime() < anchor.getTime()) {
    return anchor;
  }

  if (schedule.type === "monthly") {
    let offset = Math.max(
      0,
      (currentTime.getFullYear() - anchor.getFullYear()) * 12 +
        (currentTime.getMonth() - anchor.getMonth()),
    );
    while (monthlySlot(schedule, offset).getTime() <= currentTime.getTime()) {
      offset += 1;
    }
    return monthlySlot(schedule, offset);
  }

  const intervalMs = Number(schedule.intervalHours) * 60 * 60 * 1000;
  const elapsedMs = currentTime.getTime() - anchor.getTime();
  const nextInterval = Math.floor(elapsedMs / intervalMs) + 1;
  return new Date(anchor.getTime() + nextInterval * intervalMs);
}

function parseBackupFilename(filename) {
  const match = String(filename).match(
    /^(auto|manual|critical|compacted)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([a-f0-9]+)-(.+)\.sqlite$/,
  );

  if (!match) {
    return null;
  }

  const [, kind, timestamp, token, source] = match;
  return {
    kind,
    timestamp,
    token,
    source,
  };
}

function backupLabel(kind, source, filename) {
  if (kind === "compacted") {
    const match = String(source || "").match(/^compacted-backup-(\d{4}-\d{2}-\d{2})$/);
    if (match) {
      return `Compacted Backup For ${match[1]}`;
    }
    return "Compacted Daily Backup";
  }

  return source ? source.replaceAll("-", " ") : filename;
}

function backupInfoFromPath(path) {
  const filename = basename(path);
  const stats = statSync(path);
  const parsed = parseBackupFilename(filename);
  const kind = parsed?.kind || "manual";
  const source = parsed?.source || "backup";
  return {
    filename,
    path,
    sizeBytes: stats.size,
    createdAt: new Date(stats.mtimeMs).toISOString(),
    kind,
    source,
    label: backupLabel(kind, source, filename),
  };
}

function validateDatabaseFile(path) {
  const db = new DatabaseSync(path);

  try {
    const integrityRow = db.prepare("PRAGMA integrity_check").get();
    const integrityValue = String(firstColumnValue(integrityRow) || "").toLowerCase();
    if (integrityValue !== "ok") {
      throw new Error(`Backup integrity check failed: ${integrityValue}`);
    }

    return {
      schemaVersion:
        db.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get()?.value || null,
    };
  } finally {
    db.close();
  }
}

function getDiskUsage() {
  try {
    ensureDirectory(backupDir());
    const stats = statfsSync(backupDir());
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

export function createBackupService({
  getDb,
  reloadAppState,
  logger,
  autoBackupLimit = DEFAULT_AUTO_BACKUP_LIMIT,
  automaticBackupIntervalHours = DEFAULT_AUTO_BACKUP_INTERVAL_HOURS,
}) {
  function readBackupRetentionDays() {
    const db = getDb();
    if (!db) {
      return DEFAULT_BACKUP_RETENTION_DAYS;
    }

    return clampInteger(readMetadata(db, BACKUP_RETENTION_DAYS_KEY), DEFAULT_BACKUP_RETENTION_DAYS, {
      min: MIN_BACKUP_RETENTION_DAYS,
      max: MAX_BACKUP_RETENTION_DAYS,
    });
  }

  function getLastCompactionSummary() {
    const db = getDb();
    const value = db ? readMetadata(db, BACKUP_LAST_COMPACTION_KEY) : null;
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function getAutomaticBackupSchedule() {
    const db = getDb();
    if (!db) {
      return normalizeSchedule(null, automaticBackupIntervalHours);
    }

    return normalizeSchedule(
      parseScheduleRecord(readMetadata(db, AUTO_BACKUP_SCHEDULE_KEY)),
      automaticBackupIntervalHours,
    );
  }

  function updateAutomaticBackupSchedule({ cadence, startTime, now = new Date() }) {
    const db = getDb();
    if (!db) {
      throw new Error("Database is not available for backup schedule changes.");
    }

    if (!AUTO_BACKUP_SCHEDULES[cadence]) {
      throw new Error("Choose a valid automatic backup schedule.");
    }

    const updatedAt = now instanceof Date ? now : new Date(now);
    const option = AUTO_BACKUP_SCHEDULES[cadence];
    const schedule = normalizeSchedule(
      {
        cadence: option.cadence,
        startTime,
        anchorDate: localDateString(updatedAt),
        updatedAt: updatedAt.toISOString(),
      },
      automaticBackupIntervalHours,
    );

    writeMetadata(db, AUTO_BACKUP_SCHEDULE_KEY, JSON.stringify(schedule), updatedAt);
    logger?.info?.("backup.schedule.updated", {
      cadence: schedule.cadence,
      startTime: schedule.startTime,
      anchorDate: schedule.anchorDate,
    });
    return schedule;
  }

  function getAutomaticBackupState({ now = new Date() } = {}) {
    const db = getDb();
    const currentTime = now instanceof Date ? now : new Date(now);
    const schedule = getAutomaticBackupSchedule();
    const latestBackup = latestAutomaticBackup();
    const lastBackupAt = db
      ? readMetadata(db, LAST_AUTO_BACKUP_KEY) || latestBackup?.createdAt || null
      : latestBackup?.createdAt || null;
    const lastBackupTime = lastBackupAt ? new Date(lastBackupAt).getTime() : 0;
    const latestSlot = latestScheduledSlot(schedule, currentTime);
    const due =
      Boolean(latestSlot) &&
      (!lastBackupAt || Number.isNaN(lastBackupTime) || lastBackupTime < latestSlot.getTime());

    return {
      schedule,
      latestBackup,
      lastBackupAt,
      due,
      nextBackupAt: due
        ? latestSlot.toISOString()
        : nextScheduledSlot(schedule, currentTime).toISOString(),
    };
  }

  function ensureBackupDirectory() {
    ensureDirectory(backupDir());
  }

  function rawListBackups() {
    ensureBackupDirectory();

    return readdirSync(backupDir())
      .filter((entry) => entry.endsWith(".sqlite"))
      .map((entry) => backupInfoFromPath(join(backupDir(), entry)))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  function listBackups() {
    return rawListBackups();
  }

  function backupDateKey(backup) {
    return localDateString(new Date(backup.createdAt));
  }

  function compactedFilenameFor(dateKey, retainedBackup) {
    const token = randomBytes(3).toString("hex");
    const timestamp = safeTimestamp(new Date(retainedBackup.createdAt));
    return `compacted-${timestamp}-${token}-compacted-backup-${dateKey}.sqlite`;
  }

  function retentionCutoffDateKey(retentionDays, currentTime) {
    const cutoffDate = addLocalDays(startOfLocalDay(currentTime), -retentionDays);
    return localDateString(cutoffDate);
  }

  function totalBackupSlotLimit(retentionDays) {
    return Math.max(Number(autoBackupLimit || DEFAULT_AUTO_BACKUP_LIMIT), retentionDays + 1);
  }

  function writeLastCompactionSummary(summary, now) {
    const db = getDb();
    if (!db) {
      return;
    }

    writeMetadata(db, BACKUP_LAST_COMPACTION_KEY, JSON.stringify(summary), now);
  }

  function runBackupMaintenance({ now = new Date(), reason = "maintenance" } = {}) {
    ensureBackupDirectory();

    const currentTime = now instanceof Date ? now : new Date(now);
    const retentionDays = readBackupRetentionDays();
    const backupSlotLimit = totalBackupSlotLimit(retentionDays);
    const cutoffDateKey = retentionCutoffDateKey(retentionDays, currentTime);
    const todayDateKey = localDateString(currentTime);
    let backups = rawListBackups();
    const retentionDeleted = [];
    const activeDayDeleted = [];

    for (const backup of backups) {
      if (backupDateKey(backup) < cutoffDateKey) {
        unlinkSync(backup.path);
        retentionDeleted.push(backup.filename);
      }
    }

    backups = rawListBackups();
    const byDate = new Map();
    for (const backup of backups) {
      const dateKey = backupDateKey(backup);
      if (dateKey >= todayDateKey) {
        continue;
      }
      const entries = byDate.get(dateKey) || [];
      entries.push(backup);
      byDate.set(dateKey, entries);
    }

    const compactedDays = [];
    for (const [dateKey, entries] of byDate.entries()) {
      if (entries.length < 1) {
        continue;
      }

      const sorted = [...entries].sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      );
      const retained = sorted[0];
      const removed = sorted.slice(1);
      let retainedPath = retained.path;
      let retainedFilename = retained.filename;
      const expectedCompactedSource = `compacted-backup-${dateKey}`;
      const alreadyCompacted =
        retained.kind === "compacted" && retained.source === expectedCompactedSource;

      if (!alreadyCompacted) {
        retainedFilename = compactedFilenameFor(dateKey, retained);
        retainedPath = join(backupDir(), retainedFilename);
        renameSync(retained.path, retainedPath);
      }
      const retainedTime = new Date(retained.createdAt);
      utimesSync(retainedPath, retainedTime, retainedTime);

      for (const backup of removed) {
        unlinkSync(backup.path);
      }

      if (!alreadyCompacted || removed.length > 0) {
        compactedDays.push({
          date: dateKey,
          retainedFilename,
          removedFilenames: removed.map((backup) => backup.filename),
        });
      }
    }

    backups = rawListBackups();
    const completedDayBackupCount = backups.filter(
      (backup) => backupDateKey(backup) < todayDateKey,
    ).length;
    const activeDayBackupLimit = Math.max(1, backupSlotLimit - completedDayBackupCount);
    const activeDayBackups = backups
      .filter((backup) => backupDateKey(backup) === todayDateKey)
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      );
    const staleActiveDayBackups = activeDayBackups.slice(activeDayBackupLimit);

    for (const backup of staleActiveDayBackups) {
      unlinkSync(backup.path);
      activeDayDeleted.push(backup.filename);
    }

    const removedCount =
      activeDayDeleted.length +
      retentionDeleted.length +
      compactedDays.reduce((sum, day) => sum + day.removedFilenames.length, 0);

    const summary = {
      completedAt: currentTime.toISOString(),
      reason,
      retentionDays,
      backupSlotLimit,
      activeDayBackupLimit,
      cutoffDate: cutoffDateKey,
      compactedDays,
      retentionDeleted,
      activeDayDeleted,
      removedCount,
    };

    if (removedCount > 0 || compactedDays.length > 0) {
      writeLastCompactionSummary(summary, currentTime);
      logger?.info?.("backup.maintenance.completed", {
        reason,
        retentionDays,
        activeDayDeleted: activeDayDeleted.length,
        compactedDays: compactedDays.length,
        removedCount,
        retentionDeleted: retentionDeleted.length,
      });
    }

    return summary;
  }

  function pruneAutomaticBackups() {
    const autoBackups = rawListBackups().filter((backup) => backup.kind === "auto");
    const staleBackups = autoBackups.slice(autoBackupLimit);

    for (const backup of staleBackups) {
      unlinkSync(backup.path);
    }
  }

  function pruneCriticalBackups() {
    const criticalBackups = rawListBackups().filter((backup) => backup.kind === "critical");

    for (const backup of criticalBackups) {
      unlinkSync(backup.path);
    }

    return criticalBackups.length;
  }

  function checkpoint(db) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  function createBackup({ kind = "manual", source = "manual", now = new Date() } = {}) {
    const db = getDb();
    if (!db) {
      throw new Error("Database is not available for backup.");
    }

    ensureDirectory(dataDir());
    ensureBackupDirectory();

    const currentTime = now instanceof Date ? now : new Date(now);
    const token = randomBytes(3).toString("hex");
    const filename = `${kind}-${safeTimestamp(currentTime)}-${token}-${slugify(source)}.sqlite`;
    const tempPath = join(backupDir(), `${filename}.tmp`);
    const finalPath = join(backupDir(), filename);

    try {
      checkpoint(db);
      db.exec(`VACUUM INTO ${escapeSqliteString(tempPath)}`);
      validateDatabaseFile(tempPath);
      renameSync(tempPath, finalPath);
      utimesSync(finalPath, currentTime, currentTime);
    } catch (error) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
      throw error;
    }

    if (kind === "auto") {
      runBackupMaintenance({ now: currentTime, reason: `after-${kind}-backup` });
      pruneAutomaticBackups();
      pruneCriticalBackups();
    } else {
      runBackupMaintenance({ now: currentTime, reason: `after-${kind}-backup` });
    }

    const backup = backupInfoFromPath(finalPath);
    logger?.info?.("backup.created", {
      kind: backup.kind,
      filename: backup.filename,
      source: backup.source,
      sizeBytes: backup.sizeBytes,
    });
    return backup;
  }

  function createCriticalBackup({ source = "critical-change" } = {}) {
    const backup = createBackup({ kind: "critical", source });
    return {
      created: true,
      backup,
    };
  }

  function latestAutomaticBackup() {
    return rawListBackups().find((backup) => backup.kind === "auto") || null;
  }

  function createAutomaticBackupIfDue({
    source = "scheduled",
    now = new Date(),
    intervalHours = null,
    force = false,
  } = {}) {
    const db = getDb();
    if (!db) {
      throw new Error("Database is not available for backup.");
    }

    const currentTime = now instanceof Date ? now : new Date(now);
    const schedule =
      intervalHours === null || intervalHours === undefined
        ? getAutomaticBackupSchedule()
        : normalizeSchedule(null, intervalHours);
    const metadataAt = readMetadata(db, LAST_AUTO_BACKUP_KEY);
    const latestBackup = latestAutomaticBackup();
    const lastBackupAt = metadataAt || latestBackup?.createdAt || null;
    const lastBackupTime = lastBackupAt ? new Date(lastBackupAt).getTime() : 0;
    const latestSlot = latestScheduledSlot(schedule, currentTime);
    const nextSlot = nextScheduledSlot(schedule, currentTime);
    const backupDue =
      force ||
      (Boolean(latestSlot) &&
        (!lastBackupAt ||
          Number.isNaN(lastBackupTime) ||
          lastBackupTime < latestSlot.getTime()));

    if (!backupDue) {
      return {
        created: false,
        reason: "not_due",
        lastBackupAt,
        nextBackupAt: nextSlot.toISOString(),
        latestBackup,
        schedule,
      };
    }

    const backup = createBackup({ kind: "auto", source, now: currentTime });
    writeMetadata(db, LAST_AUTO_BACKUP_KEY, currentTime.toISOString(), currentTime);
    return {
      created: true,
      reason: "due",
      backup,
      lastBackupAt: currentTime.toISOString(),
      nextBackupAt: nextScheduledSlot(schedule, currentTime).toISOString(),
      schedule,
    };
  }

  function getBackupByFilename(filename) {
    const safeName = String(filename || "").trim();
    if (!safeName || safeName.includes("/") || safeName.includes("\\")) {
      throw new Error("Backup file was not recognised.");
    }

    const path = join(backupDir(), safeName);
    if (!existsSync(path)) {
      throw new Error("Selected backup was not found.");
    }

    return backupInfoFromPath(path);
  }

  function updateBackupRetention({ retentionDays, now = new Date() } = {}) {
    const db = getDb();
    if (!db) {
      throw new Error("Database is not available for backup retention changes.");
    }

    const normalizedDays = clampInteger(retentionDays, DEFAULT_BACKUP_RETENTION_DAYS, {
      min: MIN_BACKUP_RETENTION_DAYS,
      max: MAX_BACKUP_RETENTION_DAYS,
    });
    const currentTime = now instanceof Date ? now : new Date(now);
    writeMetadata(db, BACKUP_RETENTION_DAYS_KEY, String(normalizedDays), currentTime);
    const maintenance = runBackupMaintenance({
      now: currentTime,
      reason: "retention-update",
    });
    logger?.info?.("backup.retention.updated", {
      retentionDays: normalizedDays,
    });
    return {
      retentionDays: normalizedDays,
      maintenance,
    };
  }

  function removeLiveWalArtifacts() {
    const liveDbPath = dbPath();
    const walPath = `${liveDbPath}-wal`;
    const shmPath = `${liveDbPath}-shm`;

    if (existsSync(walPath)) {
      unlinkSync(walPath);
    }
    if (existsSync(shmPath)) {
      unlinkSync(shmPath);
    }
  }

  function restoreBackup(filename) {
    const selectedBackup = getBackupByFilename(filename);
    validateDatabaseFile(selectedBackup.path);

    const restorePoint = createBackup({
      kind: "manual",
      source: `pre-restore-${selectedBackup.source}`,
    });

    const db = getDb();
    if (!db) {
      throw new Error("Database is not available for restore.");
    }

    const tempRestorePath = `${dbPath()}.restore-${randomBytes(4).toString("hex")}.tmp`;

    checkpoint(db);
    db.close();

    try {
      removeLiveWalArtifacts();
      copyFileSync(selectedBackup.path, tempRestorePath);
      validateDatabaseFile(tempRestorePath);
      renameSync(tempRestorePath, dbPath());
      removeLiveWalArtifacts();
      reloadAppState({ closeCurrentDb: false });
    } catch (error) {
      if (existsSync(tempRestorePath)) {
        unlinkSync(tempRestorePath);
      }
      throw error;
    }

    logger?.warn?.("backup.restored", {
      filename: selectedBackup.filename,
      restorePoint: restorePoint.filename,
    });

    return {
      restoredBackup: selectedBackup,
      restorePoint,
    };
  }

  function getSummary() {
    runBackupMaintenance({ reason: "summary" });
    const backups = rawListBackups();
    const latestAuto = backups.find((backup) => backup.kind === "auto") || null;
    const automaticBackupState = getAutomaticBackupState();
    const schedule = automaticBackupState.schedule;
    const totalBackupBytes = backups.reduce((sum, backup) => sum + Number(backup.sizeBytes || 0), 0);
    const latestBackupSizeBytes = Number(backups[0]?.sizeBytes || 0);
    const retentionDays = readBackupRetentionDays();
    const backupSlotLimit = totalBackupSlotLimit(retentionDays);
    const completedDayBackups = backups.filter(
      (backup) => backupDateKey(backup) < localDateString(new Date()),
    ).length;
    const activeDayBackupLimit = Math.max(1, backupSlotLimit - completedDayBackups);
    const estimatedRetentionBytes = latestBackupSizeBytes * (retentionDays + activeDayBackupLimit);
    const disk = getDiskUsage();
    const targetBytes = Math.min(
      BACKUP_STORAGE_WARNING_BYTES,
      disk?.freeBytes ? Math.floor(disk.freeBytes * 0.25) : BACKUP_STORAGE_WARNING_BYTES,
    );
    const suggestedRetentionDays =
      latestBackupSizeBytes > 0
        ? Math.max(1, Math.min(retentionDays, Math.floor(targetBytes / latestBackupSizeBytes)))
        : retentionDays;
    const storageWarning =
      latestBackupSizeBytes > 0 &&
      suggestedRetentionDays < retentionDays &&
      (estimatedRetentionBytes > BACKUP_STORAGE_WARNING_BYTES ||
        (disk?.freeBytes ? estimatedRetentionBytes > disk.freeBytes * 0.25 : false));
    return {
      databasePath: dbPath(),
      backupDirectory: backupDir(),
      totalBackups: backups.length,
      automaticBackups: backups.filter((backup) => backup.kind === "auto").length,
      criticalBackups: backups.filter((backup) => backup.kind === "critical").length,
      compactedBackups: backups.filter((backup) => backup.kind === "compacted").length,
      manualBackups: backups.filter((backup) => backup.kind === "manual").length,
      latestBackup: backups[0] || null,
      latestAutomaticBackup: latestAuto,
      autoBackupLimit,
      retentionDays,
      backupSlotLimit,
      activeDayBackupLimit,
      minBackupRetentionDays: MIN_BACKUP_RETENTION_DAYS,
      maxBackupRetentionDays: MAX_BACKUP_RETENTION_DAYS,
      totalBackupBytes,
      latestBackupSizeBytes,
      estimatedRetentionBytes,
      disk,
      storageWarning,
      suggestedRetentionDays,
      lastCompaction: getLastCompactionSummary(),
      automaticBackupIntervalHours: schedule.intervalHours,
      automaticBackupSchedule: schedule,
      automaticBackupScheduleOptions: Object.values(AUTO_BACKUP_SCHEDULES),
      automaticBackupState,
    };
  }

  return {
    createAutomaticBackupIfDue,
    createBackup,
    createCriticalBackup,
    getBackupByFilename,
    getAutomaticBackupSchedule,
    getAutomaticBackupState,
    getSummary,
    listBackups,
    runBackupMaintenance,
    restoreBackup,
    updateBackupRetention,
    updateAutomaticBackupSchedule,
  };
}
