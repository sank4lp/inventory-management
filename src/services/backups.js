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

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "inventory.db");
const BACKUP_DIR = join(DATA_DIR, "backups");
const DEFAULT_AUTO_BACKUP_LIMIT = 48;

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function escapeSqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
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

function parseBackupFilename(filename) {
  const match = String(filename).match(
    /^(auto|manual)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([a-f0-9]+)-(.+)\.sqlite$/,
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
}) {
  function ensureBackupDirectory() {
    ensureDirectory(BACKUP_DIR);
  }

  function listBackups() {
    ensureBackupDirectory();

    return readdirSync(BACKUP_DIR)
      .filter((entry) => entry.endsWith(".sqlite"))
      .map((entry) => backupInfoFromPath(join(BACKUP_DIR, entry)))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  function pruneAutomaticBackups() {
    const autoBackups = listBackups().filter((backup) => backup.kind === "auto");
    const staleBackups = autoBackups.slice(autoBackupLimit);

    for (const backup of staleBackups) {
      unlinkSync(backup.path);
    }
  }

  function checkpoint(db) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  function createBackup({ kind = "manual", source = "manual" } = {}) {
    const db = getDb();
    if (!db) {
      throw new Error("Database is not available for backup.");
    }

    ensureDirectory(DATA_DIR);
    ensureBackupDirectory();

    const token = randomBytes(3).toString("hex");
    const filename = `${kind}-${safeTimestamp()}-${token}-${slugify(source)}.sqlite`;
    const tempPath = join(BACKUP_DIR, `${filename}.tmp`);
    const finalPath = join(BACKUP_DIR, filename);

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

  function getBackupByFilename(filename) {
    const safeName = String(filename || "").trim();
    if (!safeName || safeName.includes("/") || safeName.includes("\\")) {
      throw new Error("Backup file was not recognised.");
    }

    const path = join(BACKUP_DIR, safeName);
    if (!existsSync(path)) {
      throw new Error("Selected backup was not found.");
    }

    return backupInfoFromPath(path);
  }

  function removeLiveWalArtifacts() {
    const walPath = `${DB_PATH}-wal`;
    const shmPath = `${DB_PATH}-shm`;

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

    const tempRestorePath = `${DB_PATH}.restore-${randomBytes(4).toString("hex")}.tmp`;

    checkpoint(db);
    db.close();

    try {
      removeLiveWalArtifacts();
      copyFileSync(selectedBackup.path, tempRestorePath);
      validateDatabaseFile(tempRestorePath);
      renameSync(tempRestorePath, DB_PATH);
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
    return {
      databasePath: DB_PATH,
      backupDirectory: BACKUP_DIR,
      totalBackups: backups.length,
      automaticBackups: backups.filter((backup) => backup.kind === "auto").length,
      manualBackups: backups.filter((backup) => backup.kind === "manual").length,
      latestBackup: backups[0] || null,
      autoBackupLimit,
    };
  }

  return {
    createBackup,
    getBackupByFilename,
    getSummary,
    listBackups,
    restoreBackup,
  };
}
