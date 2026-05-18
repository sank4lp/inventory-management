const PENDING_REVIEW_TIMEOUT_KEY = "pending_review_timeout_minutes";

export const DEFAULT_PENDING_REVIEW_TIMEOUT_MINUTES = 5;
export const MIN_PENDING_REVIEW_TIMEOUT_MINUTES = 1;
export const MAX_PENDING_REVIEW_TIMEOUT_MINUTES = 24 * 60;

function readMetadataRow(db, key) {
  return db.prepare("SELECT value, updated_at FROM app_metadata WHERE key = ?").get(key) || null;
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

function clampTimeoutMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_PENDING_REVIEW_TIMEOUT_MINUTES;
  }
  return Math.max(
    MIN_PENDING_REVIEW_TIMEOUT_MINUTES,
    Math.min(MAX_PENDING_REVIEW_TIMEOUT_MINUTES, Math.trunc(number)),
  );
}

function validateTimeoutMinutes(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(
      `Task completion timeout must be between ${MIN_PENDING_REVIEW_TIMEOUT_MINUTES} and ${MAX_PENDING_REVIEW_TIMEOUT_MINUTES} minutes.`,
    );
  }
  if (
    number < MIN_PENDING_REVIEW_TIMEOUT_MINUTES ||
    number > MAX_PENDING_REVIEW_TIMEOUT_MINUTES
  ) {
    throw new Error(
      `Task completion timeout must be between ${MIN_PENDING_REVIEW_TIMEOUT_MINUTES} and ${MAX_PENDING_REVIEW_TIMEOUT_MINUTES} minutes.`,
    );
  }
  return number;
}

export function readPendingReviewTimeoutSettings(db) {
  const row = readMetadataRow(db, PENDING_REVIEW_TIMEOUT_KEY);
  const timeoutMinutes = clampTimeoutMinutes(row?.value);
  return {
    timeoutMinutes,
    timeoutMs: timeoutMinutes * 60 * 1000,
    defaultMinutes: DEFAULT_PENDING_REVIEW_TIMEOUT_MINUTES,
    minMinutes: MIN_PENDING_REVIEW_TIMEOUT_MINUTES,
    maxMinutes: MAX_PENDING_REVIEW_TIMEOUT_MINUTES,
    updatedAt: row?.updated_at || null,
  };
}

export function savePendingReviewTimeoutSettings(db, { timeoutMinutes, now = new Date() } = {}) {
  const normalizedMinutes = validateTimeoutMinutes(Number(timeoutMinutes));
  writeMetadata(db, PENDING_REVIEW_TIMEOUT_KEY, String(normalizedMinutes), now);
  return readPendingReviewTimeoutSettings(db);
}
