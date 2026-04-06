const LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(currentLevel, desiredLevel) {
  return LEVEL_ORDER[desiredLevel] >= LEVEL_ORDER[currentLevel];
}

export function createLogger({ level = "info", siteId = "warehouse-local" } = {}) {
  function log(desiredLevel, event, data = {}) {
    if (!shouldLog(level, desiredLevel)) {
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      level: desiredLevel,
      event,
      siteId,
      ...data,
    };

    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    debug(event, data) {
      log("debug", event, data);
    },
    info(event, data) {
      log("info", event, data);
    },
    warn(event, data) {
      log("warn", event, data);
    },
    error(event, data) {
      log("error", event, data);
    },
  };
}
