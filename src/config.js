const VALID_HARDWARE_ADAPTERS = new Set(["simulator", "degraded"]);
const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export function resolveConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const hardwareAdapter = env.HARDWARE_ADAPTER || "simulator";
  const logLevel = env.LOG_LEVEL || "info";
  const siteId = env.WAREHOUSE_SITE_ID || "warehouse-local";
  const sessionSecret = env.SESSION_SECRET || "inventory-local-dev-secret";
  const arduinoCliPath = env.ARDUINO_CLI_PATH || "arduino-cli";
  const esp32Fqbn = env.ESP32_FQBN || "esp32:esp32:esp32";
  const esp32SketchPath = env.ESP32_SKETCH_PATH || "firmware/esp32-simple-matrix";
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
    bootstrapAdmin,
    allowDevAuthSeeds: nodeEnv !== "production",
  };
}

export const appConfig = resolveConfig();
