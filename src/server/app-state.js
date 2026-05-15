import { appConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { createLogger } from "../logger.js";
import { createPageRenderer } from "./pages/index.js";
import { setRuntimeContext } from "./runtime-context.js";
import { hashPassword } from "../services/auth.js";
import { createAdminService } from "../services/admin.js";
import { createAnomalyService } from "../services/anomalies.js";
import { createBackupService } from "../services/backups.js";
import { createCatalogService } from "../services/catalog.js";
import { createDatabaseMaintenanceService } from "../services/database-maintenance.js";
import { createFirmwareService } from "../services/firmware.js";
import { createHardwareService } from "../services/hardware.js";
import { createLocationService } from "../services/locations.js";
import { createSystemService } from "../services/system.js";
import { createTaskService } from "../services/tasks.js";
import { getTask } from "../services/inventory.js";

export const logger = createLogger({
  level: appConfig.logLevel,
  siteId: appConfig.siteId,
});

let appState = null;
let stalePendingTaskTimer = null;
let databaseMaintenanceTimer = null;

function stopStalePendingTaskMaintenance() {
  if (stalePendingTaskTimer) {
    clearInterval(stalePendingTaskTimer);
    stalePendingTaskTimer = null;
  }
}

function stopDatabaseMaintenance() {
  if (databaseMaintenanceTimer) {
    clearInterval(databaseMaintenanceTimer);
    databaseMaintenanceTimer = null;
  }
}

function startStalePendingTaskMaintenance(systemService) {
  if (process.env.NO_SERVER_LISTEN === "1") {
    return;
  }

  stopStalePendingTaskMaintenance();
  stalePendingTaskTimer = setInterval(() => {
    systemService.cancelStalePendingReviewTasks();
  }, 30 * 1000);
  stalePendingTaskTimer.unref?.();
}

function startDatabaseMaintenance(databaseMaintenanceService) {
  if (process.env.NO_SERVER_LISTEN === "1") {
    return;
  }

  stopDatabaseMaintenance();
  databaseMaintenanceTimer = setInterval(() => {
    databaseMaintenanceService.runStartupMaintenance();
  }, 24 * 60 * 60 * 1000);
  databaseMaintenanceTimer.unref?.();
}

function buildAppState() {
  const db = createDatabase({
    hashPassword,
    bootstrapAdmin: appConfig.bootstrapAdmin,
    allowDevAuthSeeds: appConfig.allowDevAuthSeeds,
  });
  const hardwareService = createHardwareService({
    db,
    config: appConfig,
    logger,
  });
  const firmwareService = createFirmwareService({
    db,
    config: appConfig,
    logger,
  });
  const systemService = createSystemService({
    db,
    config: appConfig,
    logger,
    hardwareService,
    getTask,
  });
  systemService.cancelStalePendingReviewTasks();
  const startup = systemService.runStartupChecks();
  startup.recovery.recoveredTaskIds = systemService.recoverPendingGuidance();
  startStalePendingTaskMaintenance(systemService);
  const backupService = createBackupService({
    getDb: () => db,
    reloadAppState,
    logger,
    automaticBackupIntervalHours: appConfig.automaticBackupIntervalHours,
  });
  const databaseMaintenanceService = createDatabaseMaintenanceService({
    db,
    backupService,
    config: appConfig,
    logger,
  });
  databaseMaintenanceService.runStartupMaintenance();
  startDatabaseMaintenance(databaseMaintenanceService);
  const pages = createPageRenderer({ db, backupService });

  setRuntimeContext({
    config: appConfig,
    databaseMaintenanceService,
    firmwareService,
    logger,
    systemService,
    startup,
  });

  return {
    adminService: createAdminService({ db }),
    anomalyService: createAnomalyService({ db }),
    backupService,
    catalogService: createCatalogService({ db }),
    db,
    databaseMaintenanceService,
    firmwareService,
    hardwareService,
    locationService: createLocationService({ db }),
    pages,
    startup,
    systemService,
    taskService: createTaskService({
      db,
      hardwareService,
      logger,
      systemService,
    }),
  };
}

export function reloadAppState({ closeCurrentDb = true } = {}) {
  stopStalePendingTaskMaintenance();
  stopDatabaseMaintenance();
  if (closeCurrentDb && appState?.db) {
    appState.db.close();
  }

  appState = buildAppState();
  return appState;
}

export function getAppState() {
  if (!appState) {
    appState = buildAppState();
  }

  return appState;
}
