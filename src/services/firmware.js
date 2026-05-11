import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_FQBN = "esp32:esp32:esp32";
const MIN_MODULES = 1;
const MAX_MODULES = 64;
const MAX_LOG_LINES = 500;

function nowIso() {
  return new Date().toISOString();
}

function asPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < MIN_MODULES || number > MAX_MODULES) {
    throw new Error(`${fieldName} must be a whole number from ${MIN_MODULES} to ${MAX_MODULES}.`);
  }
  return number;
}

function assertSafePort(value) {
  const port = String(value || "").trim();
  if (!port) {
    throw new Error("Serial port is required.");
  }
  if (!/^[A-Za-z0-9._:/\\-]+$/.test(port)) {
    throw new Error("Serial port contains unsupported characters.");
  }
  return port;
}

function assertSafeFqbn(value) {
  const fqbn = String(value || DEFAULT_FQBN).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(fqbn)) {
    throw new Error("Board FQBN contains unsupported characters.");
  }
  return fqbn;
}

function executableExists(command) {
  const value = String(command || "").trim();
  if (!value) {
    return false;
  }

  if (value.includes("/") || value.includes("\\")) {
    try {
      accessSync(value, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  for (const directory of String(process.env.PATH || "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    try {
      accessSync(join(directory, value), constants.X_OK);
      return true;
    } catch {}
  }

  return false;
}

function listSerialPorts() {
  try {
    return readdirSync("/dev")
      .filter(
        (name) =>
          name.startsWith("cu.usb") ||
          name.startsWith("tty.usb") ||
          name.startsWith("cu.SLAB") ||
          name.startsWith("tty.SLAB") ||
          name.startsWith("cu.wchusb") ||
          name.startsWith("tty.wchusb") ||
          name.startsWith("cu.usbserial") ||
          name.startsWith("tty.usbserial"),
      )
      .map((name) => `/dev/${name}`)
      .sort();
  } catch {
    return [];
  }
}

function commandLine(command, args) {
  return [command, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function parseMetadata(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function publicJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    moduleCount: job.moduleCount,
    assignedModules: job.assignedModules,
    port: job.port,
    fqbn: job.fqbn,
    sketchPath: job.sketchPath,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    currentCommand: job.currentCommand,
    commands: job.commands,
    logs: job.logs,
  };
}

export function createFirmwareService({ db, config = {}, logger }) {
  const jobs = new Map();
  const arduinoCliPath = config.arduinoCliPath || process.env.ARDUINO_CLI_PATH || "arduino-cli";
  const defaultFqbn = config.esp32Fqbn || process.env.ESP32_FQBN || DEFAULT_FQBN;
  const sketchPath = resolve(
    config.esp32SketchPath || process.env.ESP32_SKETCH_PATH || "firmware/esp32-simple-matrix",
  );

  function appendLog(job, text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      job.logs.push({
        at: nowIso(),
        line,
      });
    }

    if (job.logs.length > MAX_LOG_LINES) {
      job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    }
  }

  function recordSystemEvent({ eventType, status, message, payload }) {
    db.prepare(
      `
        INSERT INTO system_events (event_type, status, message, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(eventType, status, message, payload ? JSON.stringify(payload) : null, nowIso());
  }

  function saveLastConfiguration(job) {
    const payload = {
      jobId: job.id,
      moduleCount: job.moduleCount,
      assignedModules: job.assignedModules,
      port: job.port,
      fqbn: job.fqbn,
      sketchPath: job.sketchPath,
      configuredAt: nowIso(),
    };

    db.prepare(
      `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('firmware_matrix_configuration', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
    ).run(JSON.stringify(payload), nowIso());
  }

  function runCommand(job, stage, progress, args) {
    return new Promise((resolveCommand, rejectCommand) => {
      job.stage = stage;
      job.progress = progress;
      job.currentCommand = commandLine(arduinoCliPath, args);
      job.commands.push(job.currentCommand);
      appendLog(job, `$ ${job.currentCommand}`);

      const child = spawn(arduinoCliPath, args, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => appendLog(job, chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => appendLog(job, chunk.toString("utf8")));
      child.on("error", rejectCommand);
      child.on("close", (code) => {
        if (code === 0) {
          resolveCommand();
          return;
        }
        rejectCommand(new Error(`${stage} command exited with code ${code}.`));
      });
    });
  }

  async function runFlashJob(job) {
    try {
      recordSystemEvent({
        eventType: "firmware_flash_started",
        status: "info",
        message: `ESP32 flash started for ${job.moduleCount} module(s).`,
        payload: {
          jobId: job.id,
          moduleCount: job.moduleCount,
          port: job.port,
          fqbn: job.fqbn,
        },
      });

      const buildDir = join(tmpdir(), `inventory-esp32-${job.id}`);
      mkdirSync(buildDir, { recursive: true });
      job.buildDir = buildDir;
      job.progress = 8;
      job.stage = "compiling";

      await runCommand(job, "compiling", 12, [
        "compile",
        "--fqbn",
        job.fqbn,
        "--build-property",
        `compiler.cpp.extra_flags=-DLED_MODULE_COUNT=${job.moduleCount}`,
        "--output-dir",
        buildDir,
        job.sketchPath,
      ]);

      job.progress = 58;
      await runCommand(job, "uploading", 62, [
        "upload",
        "--fqbn",
        job.fqbn,
        "-p",
        job.port,
        "--input-dir",
        buildDir,
        job.sketchPath,
      ]);

      job.stage = "configuring";
      job.progress = 92;
      saveLastConfiguration(job);
      recordSystemEvent({
        eventType: "firmware_flash_completed",
        status: "info",
        message: `ESP32 flash completed for ${job.moduleCount} module(s).`,
        payload: {
          jobId: job.id,
          moduleCount: job.moduleCount,
          assignedModules: job.assignedModules,
          port: job.port,
          fqbn: job.fqbn,
        },
      });

      job.status = "completed";
      job.stage = "completed";
      job.progress = 100;
      job.finishedAt = nowIso();
      job.currentCommand = null;
      appendLog(job, `Configured module numbers: ${job.assignedModules.join(", ")}`);
    } catch (error) {
      job.status = "failed";
      job.stage = "failed";
      job.progress = Math.max(job.progress || 0, 100);
      job.finishedAt = nowIso();
      job.error = error.message;
      job.currentCommand = null;
      appendLog(job, `ERROR: ${error.message}`);
      recordSystemEvent({
        eventType: "firmware_flash_failed",
        status: "warning",
        message: error.message,
        payload: {
          jobId: job.id,
          moduleCount: job.moduleCount,
          port: job.port,
          fqbn: job.fqbn,
        },
      });
      logger?.error("firmware.flash.failed", {
        jobId: job.id,
        error: error.message,
      });
    }
  }

  function getLastConfiguration() {
    const row = db
      .prepare("SELECT value FROM app_metadata WHERE key = 'firmware_matrix_configuration'")
      .get();
    return parseMetadata(row?.value);
  }

  return {
    getFlashOptions() {
      const ports = listSerialPorts();
      return {
        arduinoCli: {
          command: arduinoCliPath,
          available: executableExists(arduinoCliPath),
        },
        defaultFqbn,
        sketchPath,
        ports,
        defaultPort: ports[0] || "",
        moduleCount: {
          min: MIN_MODULES,
          max: MAX_MODULES,
          value: getLastConfiguration()?.moduleCount || 4,
        },
        lastConfiguration: getLastConfiguration(),
      };
    },
    getLastConfiguration,
    startFlashJob(input = {}) {
      if (!executableExists(arduinoCliPath)) {
        throw new Error(
          `Arduino CLI was not found at "${arduinoCliPath}". Install arduino-cli or set ARDUINO_CLI_PATH.`,
        );
      }

      const moduleCount = asPositiveInteger(input.module_count ?? input.moduleCount, "LED modules");
      const port = assertSafePort(input.port);
      const fqbn = assertSafeFqbn(input.fqbn || defaultFqbn);
      const assignedModules = Array.from({ length: moduleCount }, (_, index) => index + 1);
      const job = {
        id: randomUUID(),
        status: "running",
        stage: "queued",
        progress: 3,
        moduleCount,
        assignedModules,
        port,
        fqbn,
        sketchPath,
        startedAt: nowIso(),
        finishedAt: null,
        error: null,
        currentCommand: null,
        commands: [],
        logs: [],
      };

      jobs.set(job.id, job);
      runFlashJob(job);
      logger?.info("firmware.flash.started", {
        jobId: job.id,
        moduleCount,
        port,
        fqbn,
      });
      return publicJob(job);
    },
    getJob(jobId) {
      return publicJob(jobs.get(jobId));
    },
  };
}
