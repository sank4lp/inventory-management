import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_AUTO_BACKUP_LIMIT = 48;
const DEFAULT_AUTO_BACKUP_INTERVAL_HOURS = 24;
const LAST_AUTO_BACKUP_KEY = "backup_last_auto_at";
const AUTO_BACKUP_SCHEDULE_KEY = "backup_automatic_schedule";
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
    /^(auto|manual|critical)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([a-f0-9]+)-(.+)\.sqlite$/,
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

function backupInfoFromPath(path) {
  const filename = basename(path);
  const stats = statSync(path);
  const parsed = parseBackupFilename(filename);
  return {
    filename,
    path,
    sizeBytes: stats.size,
    createdAt: new Date(stats.mtimeMs).toISOString(),
    kind: parsed?.kind || "manual",
    source: parsed?.source || "backup",
    label: parsed?.source ? parsed.source.replaceAll("-", " ") : filename,
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

export function createBackupService({
  getDb,
  reloadAppState,
  logger,
  autoBackupLimit = DEFAULT_AUTO_BACKUP_LIMIT,
  automaticBackupIntervalHours = DEFAULT_AUTO_BACKUP_INTERVAL_HOURS,
}) {
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

  function listBackups() {
    ensureBackupDirectory();

    return readdirSync(backupDir())
      .filter((entry) => entry.endsWith(".sqlite"))
      .map((entry) => backupInfoFromPath(join(backupDir(), entry)))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  function pruneAutomaticBackups() {
    const autoBackups = listBackups().filter((backup) => backup.kind === "auto");
    const staleBackups = autoBackups.slice(autoBackupLimit);

    for (const backup of staleBackups) {
      unlinkSync(backup.path);
    }
  }

  function pruneCriticalBackups() {
    const criticalBackups = listBackups().filter((backup) => backup.kind === "critical");

    for (const backup of criticalBackups) {
      unlinkSync(backup.path);
    }

    return criticalBackups.length;
  }

  function checkpoint(db) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  function createBackup({ kind = "manual", source = "manual" } = {}) {
    const db = getDb();
    if (!db) {
      throw new Error("Database is not available for backup.");
    }

    ensureDirectory(dataDir());
    ensureBackupDirectory();

    const token = randomBytes(3).toString("hex");
    const filename = `${kind}-${safeTimestamp()}-${token}-${slugify(source)}.sqlite`;
    const tempPath = join(backupDir(), `${filename}.tmp`);
    const finalPath = join(backupDir(), filename);

    try {
      checkpoint(db);
      db.exec(`VACUUM INTO ${escapeSqliteString(tempPath)}`);
      validateDatabaseFile(tempPath);
      renameSync(tempPath, finalPath);
    } catch (error) {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
      throw error;
    }

    if (kind === "auto") {
      pruneAutomaticBackups();
      pruneCriticalBackups();
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
    return listBackups().find((backup) => backup.kind === "auto") || null;
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

    const backup = createBackup({ kind: "auto", source });
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
    const backups = listBackups();
    const latestAuto = backups.find((backup) => backup.kind === "auto") || null;
    const automaticBackupState = getAutomaticBackupState();
    const schedule = automaticBackupState.schedule;
    return {
      databasePath: dbPath(),
      backupDirectory: backupDir(),
      totalBackups: backups.length,
      automaticBackups: backups.filter((backup) => backup.kind === "auto").length,
      criticalBackups: backups.filter((backup) => backup.kind === "critical").length,
      manualBackups: backups.filter((backup) => backup.kind === "manual").length,
      latestBackup: backups[0] || null,
      latestAutomaticBackup: latestAuto,
      autoBackupLimit,
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
    restoreBackup,
    updateAutomaticBackupSchedule,
  };
}
