const VALID_HARDWARE_ADAPTERS = new Set(["simulator", "degraded", "rs485"]);
const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

function numberSetting(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

export function resolveConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const hardwareAdapter = env.HARDWARE_ADAPTER || "simulator";
  const logLevel = env.LOG_LEVEL || "info";
  const siteId = env.WAREHOUSE_SITE_ID || "warehouse-local";
  const sessionSecret = env.SESSION_SECRET || "inventory-local-dev-secret";
  const arduinoCliPath = env.ARDUINO_CLI_PATH || "arduino-cli";
  const esp32Fqbn = env.ESP32_FQBN || "esp32:esp32:esp32";
  const esp32SketchPath = env.ESP32_SKETCH_PATH || "firmware/esp32-simple-matrix";
  const rs485SerialPort = env.RS485_SERIAL_PORT || "";
  const ledDayBrightnessPercent = numberSetting(env.LED_DAY_BRIGHTNESS_PERCENT, 20, {
    min: 1,
    max: 100,
  });
  const ledNightBrightnessPercent = numberSetting(env.LED_NIGHT_BRIGHTNESS_PERCENT, 8, {
    min: 1,
    max: 100,
  });
  const ledDayStartHour = numberSetting(env.LED_DAY_START_HOUR, 6, {
    min: 0,
    max: 23,
  });
  const ledNightStartHour = numberSetting(env.LED_NIGHT_START_HOUR, 18, {
    min: 0,
    max: 23,
  });
  const automaticBackupIntervalHours = numberSetting(env.AUTO_BACKUP_INTERVAL_HOURS, 24, {
    min: 1,
    max: 24 * 30,
  });
  const reportDefaultDays = numberSetting(env.REPORT_DEFAULT_DAYS, 30, {
    min: 1,
    max: 365,
  });
  const deviceEventRetentionDays = numberSetting(env.DEVICE_EVENT_RETENTION_DAYS, 90, {
    min: 1,
    max: 3650,
  });
  const systemEventRetentionDays = numberSetting(env.SYSTEM_EVENT_RETENTION_DAYS, 90, {
    min: 1,
    max: 3650,
  });
  const businessArchiveAfterDays = numberSetting(env.BUSINESS_ARCHIVE_AFTER_DAYS, 730, {
    min: 30,
    max: 3650,
  });
  const allowDemoInventorySeed = env.DEMO_INVENTORY_SEED === "1";
  const bootstrapAdmin =
    env.BOOTSTRAP_ADMIN_USERNAME && env.BOOTSTRAP_ADMIN_PASSWORD
      ? {
          name: (env.BOOTSTRAP_ADMIN_NAME || env.BOOTSTRAP_ADMIN_USERNAME).trim(),
          username: env.BOOTSTRAP_ADMIN_USERNAME.trim(),
          password: env.BOOTSTRAP_ADMIN_PASSWORD,
        }
      : null;

  if (!VALID_HARDWARE_ADAPTERS.has(hardwareAdapter)) {
    throw new Error(
      `Unsupported HARDWARE_ADAPTER "${hardwareAdapter}". Expected one of: ${[
        ...VALID_HARDWARE_ADAPTERS,
      ].join(", ")}.`,
    );
  }

  if (!VALID_LOG_LEVELS.has(logLevel)) {
    throw new Error(
      `Unsupported LOG_LEVEL "${logLevel}". Expected one of: ${[
        ...VALID_LOG_LEVELS,
      ].join(", ")}.`,
    );
  }

  if (nodeEnv === "production" && !env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set when NODE_ENV=production.");
  }

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    sessionSecret,
    hardwareAdapter,
    logLevel,
    siteId,
    arduinoCliPath,
    esp32Fqbn,
    esp32SketchPath,
    rs485SerialPort,
    ledDayBrightnessPercent,
    ledNightBrightnessPercent,
    ledDayStartHour,
    ledNightStartHour,
    automaticBackupIntervalHours,
    reportDefaultDays,
    deviceEventRetentionDays,
    systemEventRetentionDays,
    businessArchiveAfterDays,
    bootstrapAdmin,
    allowDevAuthSeeds: nodeEnv !== "production",
    allowDemoInventorySeed,
  };
}

export const appConfig = resolveConfig();
