import { randomBytes } from "node:crypto";

import { updateControllerHealth } from "./inventory.js";
import {
  readPendingReviewTimeoutSettings,
  savePendingReviewTimeoutSettings,
} from "./task-timeout-settings.js";

const CONTROLLER_QUICK_RETRY_MS = 30 * 1000;
const CONTROLLER_QUICK_RETRY_LIMIT = 3;
const CONTROLLER_SLOW_RETRY_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function firstColumnValue(row) {
  const values = Object.values(row || {});
  return values[0];
}

function finiteIds(ids = []) {
  return ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms).toISOString();
}

function retryDelayLabel(delayMs) {
  if (delayMs === CONTROLLER_QUICK_RETRY_MS) {
    return "30 seconds";
  }
  if (delayMs === CONTROLLER_SLOW_RETRY_MS) {
    return "5 minutes";
  }
  return `${Math.max(1, Math.round(delayMs / 1000))} seconds`;
}

export function createSystemService({ db, config, logger, hardwareService, getTask }) {
  const controllerHealthSchedule = new Map();

  function normalizeControllerHealthStatus(result = {}) {
    const status = String(result.status || "").trim().toLowerCase();
    if (["online", "offline", "unknown"].includes(status)) {
      return status;
    }
    if (result.ok === true && result.degraded !== true) {
      return "online";
    }
    return "unknown";
  }

  function controllerHealthSummary(previousChecks = []) {
    const controllers = db
      .prepare(
        `
          SELECT id, controller_code, heartbeat_status
          FROM controllers
          WHERE active = 1
          ORDER BY id
        `,
      )
      .all();
    const previousById = new Map(previousChecks.map((check) => [Number(check.controllerId), check]));
    const total = controllers.length;
    const online = controllers.filter((controller) => controller.heartbeat_status === "online").length;
    const offlineControllers = controllers.filter((controller) => controller.heartbeat_status !== "online");
    const retryNotices = offlineControllers.map((controller) => {
      const schedule = controllerHealthSchedule.get(Number(controller.id));
      const delayMs = schedule?.retryDelayMs || CONTROLLER_QUICK_RETRY_MS;
      return `Controller ${controller.controller_code} offline. Retrying after ${retryDelayLabel(delayMs)}.`;
    });

    return {
      status: total === online ? "healthy" : "warning",
      message:
        total === 0
          ? "No active controllers configured."
          : [
              `${online} of ${total} controllers online.`,
              ...retryNotices,
            ].join(" "),
      checked: controllers.map((controller) => {
        const previous = previousById.get(Number(controller.id)) || {};
        const schedule = controllerHealthSchedule.get(Number(controller.id));
        return {
          ...previous,
          controllerId: controller.id,
          controllerCode: controller.controller_code,
          status: normalizeControllerHealthStatus({ status: controller.heartbeat_status }),
          nextCheckAt: schedule?.nextCheckAt || null,
          retryDelayMs: schedule?.retryDelayMs || null,
        };
      }),
    };
  }

  function startupRecoverySummary(baseRecovery = {}) {
    const startupPendingIds = finiteIds(baseRecovery.pendingTaskIds || []);
    if (!startupPendingIds.length) {
      return {
        ...baseRecovery,
        status: "healthy",
        message: "No unfinished tasks found during startup recovery scan.",
        pendingTaskIds: [],
      };
    }

    const unresolvedRows = db
      .prepare(
        `
          SELECT id
          FROM tasks
          WHERE status = 'pending_review'
            AND id IN (${startupPendingIds.map(() => "?").join(", ")})
          ORDER BY id
        `,
      )
      .all(...startupPendingIds);
    const unresolvedIds = unresolvedRows.map((row) => row.id);

    return {
      ...baseRecovery,
      status: unresolvedIds.length ? "warning" : "healthy",
      message: unresolvedIds.length
        ? `${unresolvedIds.length} startup recovery task(s) still require operator review.`
        : "Startup recovery tasks have been resolved.",
      pendingTaskIds: unresolvedIds,
    };
  }

  function warningMessages(startup) {
    return [
      ["Database", startup.db],
      ["Configuration", startup.config],
      ["Hardware", startup.hardware],
      ["Controllers", startup.controllers],
      ["Recovery", startup.recovery],
    ]
      .filter(([, part]) => part?.status !== "healthy")
      .map(([label, part]) => `${label}: ${part?.message || "Warning active."}`);
  }

  function updateControllerHealthSchedule(controller, status, checkedAt) {
    const controllerId = Number(controller.id);
    const checkedAtIso = checkedAt.toISOString();

    if (status === "online") {
      controllerHealthSchedule.set(controllerId, {
        status,
        quickRetriesUsed: 0,
        lastCheckedAt: checkedAtIso,
        nextCheckAt: addMs(checkedAt, CONTROLLER_QUICK_RETRY_MS),
        retryDelayMs: CONTROLLER_QUICK_RETRY_MS,
      });
      return;
    }

    const previous = controllerHealthSchedule.get(controllerId);
    const continuingOffline = previous && previous.status !== "online";
    const quickRetriesUsed = continuingOffline ? Number(previous.quickRetriesUsed || 0) + 1 : 0;
    const retryDelayMs =
      quickRetriesUsed < CONTROLLER_QUICK_RETRY_LIMIT
        ? CONTROLLER_QUICK_RETRY_MS
        : CONTROLLER_SLOW_RETRY_MS;

    controllerHealthSchedule.set(controllerId, {
      status,
      quickRetriesUsed,
      lastCheckedAt: checkedAtIso,
      nextCheckAt: addMs(checkedAt, retryDelayMs),
      retryDelayMs,
    });
  }

  function pruneControllerHealthSchedule(activeControllerIds) {
    for (const controllerId of controllerHealthSchedule.keys()) {
      if (!activeControllerIds.has(controllerId)) {
        controllerHealthSchedule.delete(controllerId);
      }
    }
  }

  function refreshControllerHealth(controller, { now = new Date() } = {}) {
    const checkedAt = now instanceof Date ? now : new Date(now);
    const result = hardwareService.checkControllerHealth(controller);
    const status = normalizeControllerHealthStatus(result);
    updateControllerHealth(db, {
      controllerId: controller.id,
      status,
    });
    updateControllerHealthSchedule(controller, status, checkedAt);
    return {
      controllerId: controller.id,
      controllerCode: controller.controller_code,
      status,
      message: result.message || null,
    };
  }

  function activeControllers() {
    const controllers = db
      .prepare(
        `
          SELECT *
          FROM controllers
          WHERE active = 1
          ORDER BY id
        `,
      )
      .all();
    pruneControllerHealthSchedule(new Set(controllers.map((controller) => Number(controller.id))));
    return controllers;
  }

  function refreshControllerHealths({ now = new Date() } = {}) {
    const checkedAt = now instanceof Date ? now : new Date(now);
    return activeControllers().map((controller) => refreshControllerHealth(controller, { now: checkedAt }));
  }

  function refreshDueControllerHealths({ now = new Date() } = {}) {
    const checkedAt = now instanceof Date ? now : new Date(now);
    return activeControllers()
      .filter((controller) => {
        const schedule = controllerHealthSchedule.get(Number(controller.id));
        if (!schedule?.nextCheckAt) {
          return true;
        }
        const nextCheckAt = new Date(schedule.nextCheckAt);
        return Number.isNaN(nextCheckAt.getTime()) || nextCheckAt.getTime() <= checkedAt.getTime();
      })
      .map((controller) => refreshControllerHealth(controller, { now: checkedAt }));
  }

  function recordSystemEvent({ eventType, status = "info", message, payload = null }) {
    db.prepare(
      `
        INSERT INTO system_events (event_type, status, message, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(eventType, status, message, payload ? JSON.stringify(payload) : null, nowIso());
  }

  function listRecentSystemEvents(limit = 10, eventType = null) {
    if (eventType) {
      return db
        .prepare(
          `
            SELECT *
            FROM system_events
            WHERE event_type = ?
            ORDER BY id DESC
            LIMIT ?
          `,
        )
        .all(eventType, limit);
    }

    return db
      .prepare(
        `
          SELECT *
          FROM system_events
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(limit);
  }

  function runStartupChecks({ now = new Date() } = {}) {
    const integrityRow = db.prepare("PRAGMA integrity_check").get();
    const integrityValue = String(firstColumnValue(integrityRow) || "");
    if (integrityValue.toLowerCase() !== "ok") {
      throw new Error(`Database integrity check failed: ${integrityValue}`);
    }

    const schemaVersionRow = db
      .prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'")
      .get();
    const schemaVersion = schemaVersionRow?.value || "unknown";
    const adminCount = Number(
      db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get()
        .count,
    );
    const hardwareHealth = hardwareService.healthCheck();
    const controllerHealthResults = refreshControllerHealths({ now });
    const pendingTasks = db
      .prepare(
        `
          SELECT id
          FROM tasks
          WHERE status = 'pending_review'
          ORDER BY id
        `,
      )
      .all();

    const startup = {
      db: {
        status: "healthy",
        message: "SQLite integrity check passed.",
        schemaVersion,
      },
      config: {
        status: adminCount > 0 ? "healthy" : "warning",
        message: adminCount > 0 ? "Configuration is valid." : "No active admin users found.",
      },
      hardware: hardwareHealth,
      controllers: controllerHealthSummary(controllerHealthResults),
      recovery: {
        status: pendingTasks.length ? "warning" : "healthy",
        message: pendingTasks.length
          ? `${pendingTasks.length} pending task(s) require operator review after startup.`
          : "No unfinished tasks found during startup recovery scan.",
        pendingTaskIds: pendingTasks.map((row) => row.id),
        recoveredTaskIds: [],
      },
    };

    recordSystemEvent({
      eventType: "startup_check",
      status:
        [startup.db, startup.config, startup.hardware, startup.controllers, startup.recovery].every(
          (part) => part.status === "healthy",
        )
          ? "info"
          : "warning",
      message: "Startup checks completed.",
      payload: startup,
    });
    logger.info("startup.check.completed", startup);
    return startup;
  }

  function recoverPendingGuidance() {
    const rows = db
      .prepare(
        `
          SELECT id
          FROM tasks
          WHERE status = 'pending_review'
          ORDER BY id
        `,
      )
      .all();

    const recoveredTaskIds = [];
    for (const row of rows) {
      const task = getTask(db, row.id);
      if (!task) {
        continue;
      }
      const result = hardwareService.clearGuidance(task, task.lines, {
        source: "startup_recovery",
      });
      recoveredTaskIds.push(task.id);
      recordSystemEvent({
        eventType: "startup_recovery",
        status: result.degraded ? "warning" : "info",
        message: `Cleared stale guidance for task #${task.id}.`,
        payload: {
          taskId: task.id,
          degraded: result.degraded,
          adapter: hardwareService.adapterName,
        },
      });
    }

    logger.info("startup.recovery.completed", {
      recoveredTaskIds,
      adapter: hardwareService.adapterName,
    });
    return recoveredTaskIds;
  }

  function cancelStalePendingReviewTasks({
    now = new Date(),
    timeoutMs = null,
  } = {}) {
    const currentTime = now instanceof Date ? now : new Date(now);
    const configuredTimeoutMs = timeoutMs ?? readPendingReviewTimeoutSettings(db).timeoutMs;
    const cutoff = new Date(currentTime.getTime() - configuredTimeoutMs).toISOString();
    const cancelledTaskIds = [];
    const rows = db
      .prepare(
        `
          SELECT id
          FROM tasks
          WHERE status = 'pending_review'
            AND COALESCE(last_touched_at, started_at) <= ?
          ORDER BY id
        `,
      )
      .all(cutoff);

    for (const row of rows) {
      const task = getTask(db, row.id);
      if (!task || task.status !== "pending_review") {
        continue;
      }

      const cancelledAt = currentTime.toISOString();
      const clearResult = hardwareService.clearGuidance(task, task.lines, {
        source: "pending_review_timeout",
      });
      db.prepare(
        `
          UPDATE tasks
          SET status = 'cancelled', completed_at = ?, last_touched_at = ?
          WHERE id = ? AND status = 'pending_review'
        `,
      ).run(cancelledAt, cancelledAt, task.id);
      cancelledTaskIds.push(task.id);
      recordSystemEvent({
        eventType: "pending_review_timeout",
        status: clearResult.degraded ? "warning" : "info",
        message: `Cancelled stale pending review task #${task.id}.`,
        payload: {
          taskId: task.id,
          timeoutMs: configuredTimeoutMs,
          lastTouchedAt: task.last_touched_at || task.started_at,
          degraded: clearResult.degraded,
          adapter: hardwareService.adapterName,
        },
      });
    }

    if (cancelledTaskIds.length) {
      logger.info("task.pending_review.timeout_cancelled", {
        cancelledTaskIds,
        timeoutMs: configuredTimeoutMs,
      });
    }

    return cancelledTaskIds;
  }

  function getPendingReviewTimeoutSettings() {
    return readPendingReviewTimeoutSettings(db);
  }

  function updatePendingReviewTimeout({ timeoutMinutes, updatedBy = null, now = new Date() } = {}) {
    const settings = savePendingReviewTimeoutSettings(db, {
      timeoutMinutes,
      now,
    });
    recordSystemEvent({
      eventType: "pending_review_timeout_setting_updated",
      status: "info",
      message: `Task completion timeout set to ${settings.timeoutMinutes} minute(s).`,
      payload: {
        timeoutMinutes: settings.timeoutMinutes,
        updatedBy,
      },
    });
    logger.info("task.pending_review.timeout_updated", {
      timeoutMinutes: settings.timeoutMinutes,
      updatedBy,
    });
    return settings;
  }

  function issueSubmissionToken({ scope, taskId = null, userId = null }) {
    const token = randomBytes(18).toString("base64url");
    db.prepare(
      `
        INSERT INTO submission_tokens (token, scope, task_id, user_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(token, scope, taskId, userId, nowIso());
    return token;
  }

  function consumeSubmissionToken({ token, scope, taskId = null, userId = null }) {
    const row = db
      .prepare(
        `
          SELECT *
          FROM submission_tokens
          WHERE token = ? AND scope = ? AND used_at IS NULL
        `,
      )
      .get(token, scope);

    if (!row) {
      throw new Error("This form has already been submitted or is no longer valid.");
    }

    if ((taskId ?? null) !== (row.task_id ?? null)) {
      throw new Error("This form token does not match the current task.");
    }

    if (row.user_id && userId && Number(row.user_id) !== Number(userId)) {
      throw new Error("This form token belongs to another user session.");
    }

    db.prepare(
      `
        UPDATE submission_tokens
        SET used_at = ?, used_by = ?
        WHERE id = ?
      `,
    ).run(nowIso(), userId ?? null, row.id);
  }

  function healthSummary(startupState = null) {
    const baseStartup = startupState || runStartupChecks();
    const startup = {
      ...baseStartup,
      controllers: controllerHealthSummary(baseStartup.controllers?.checked || []),
      recovery: startupRecoverySummary(baseStartup.recovery),
    };
    const parts = [startup.db, startup.config, startup.hardware, startup.controllers, startup.recovery];
    const degraded = parts.some((part) => part.status !== "healthy");
    const warnings = warningMessages(startup);
    return {
      overallStatus: degraded ? "warning" : "healthy",
      degraded,
      message: degraded ? warnings.join(" ") : "System is healthy.",
      startup,
      warnings,
    };
  }

  function getDashboardData(startupState) {
    const recentRecoveryEvents = listRecentSystemEvents(5, "startup_recovery");
    const recentHardwareFailures = db
      .prepare(
        `
          SELECT *
          FROM device_events
          WHERE event_type LIKE '%skipped%' OR event_type LIKE '%failed%'
          ORDER BY id DESC
          LIMIT 8
        `,
      )
      .all();

    return {
      siteId: config.siteId,
      adapterName: hardwareService.adapterName,
      health: healthSummary(startupState),
      recentRecoveryEvents,
      recentHardwareFailures,
    };
  }

  return {
    recordSystemEvent,
    listRecentSystemEvents,
    refreshControllerHealth,
    refreshControllerHealths,
    refreshDueControllerHealths,
    runStartupChecks,
    recoverPendingGuidance,
    cancelStalePendingReviewTasks,
    getPendingReviewTimeoutSettings,
    updatePendingReviewTimeout,
    issueSubmissionToken,
    consumeSubmissionToken,
    healthSummary,
    getDashboardData,
  };
}
