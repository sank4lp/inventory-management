import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_FQBN = "esp32:esp32:esp32";
const MIN_MODULES = 1;
const MAX_MODULES = 64;
const MAX_LOG_LINES = 500;
const BOOT_BUTTON_GUIDANCE =
  "Upload failed while connecting to the ESP32. Hold the BOOT button, start flashing again, release BOOT when the upload begins, then wait for the progress to finish.";

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

function addPort(ports, seen, path, label = "") {
  if (!path || seen.has(path)) {
    return;
  }

  seen.add(path);
  const haystack = `${path} ${label}`.toLowerCase();
  const recommended =
    haystack.includes("esp32") ||
    haystack.includes("espressif") ||
    haystack.includes("cp210") ||
    haystack.includes("ch340") ||
    haystack.includes("ch341") ||
    haystack.includes("wchusb") ||
    haystack.includes("usb_serial") ||
    haystack.includes("usb-serial") ||
    haystack.includes("usbserial") ||
    haystack.includes("usbmodem") ||
    haystack.includes("1a86") ||
    haystack.includes("10c4") ||
    haystack.includes("303a") ||
    path.includes("/ttyUSB") ||
    path.includes("/ttyACM");

  ports.push({
    path,
    label: label || path.split("/").pop() || path,
    kind: recommended ? "esp32_candidate" : "serial",
    recommended,
  });
}

function listSerialPorts() {
  const ports = [];
  const seen = new Set();

  try {
    for (const name of readdirSync("/dev/serial/by-id")) {
      addPort(ports, seen, `/dev/serial/by-id/${name}`, name);
    }
  } catch {}

  try {
    readdirSync("/dev")
      .filter(
        (name) =>
          name.startsWith("cu.usb") ||
          name.startsWith("tty.usb") ||
          name.startsWith("cu.usbmodem") ||
          name.startsWith("tty.usbmodem") ||
          name.startsWith("cu.SLAB") ||
          name.startsWith("tty.SLAB") ||
          name.startsWith("cu.wchusb") ||
          name.startsWith("tty.wchusb") ||
          name.startsWith("cu.usbserial") ||
          name.startsWith("tty.usbserial") ||
          name.startsWith("ttyUSB") ||
          name.startsWith("ttyACM"),
      )
      .sort()
      .forEach((name) => addPort(ports, seen, `/dev/${name}`));
  } catch {
    return ports;
  }

  return ports.sort((left, right) => {
    if (left.recommended !== right.recommended) {
      return left.recommended ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });
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
    recoveryHint: job.recoveryHint,
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
      const failedStage = job.stage;
      const uploadFailed = failedStage === "uploading";
      const message = error.message;
      const eventMessage = uploadFailed
        ? `${error.message} ${BOOT_BUTTON_GUIDANCE}`
        : error.message;
      job.status = "failed";
      job.stage = "failed";
      job.progress = Math.max(job.progress || 0, 100);
      job.finishedAt = nowIso();
      job.error = message;
      job.recoveryHint = uploadFailed ? BOOT_BUTTON_GUIDANCE : null;
      job.currentCommand = null;
      appendLog(job, `ERROR: ${eventMessage}`);
      recordSystemEvent({
        eventType: "firmware_flash_failed",
        status: "warning",
        message: eventMessage,
        payload: {
          jobId: job.id,
          moduleCount: job.moduleCount,
          port: job.port,
          fqbn: job.fqbn,
        },
      });
      logger?.error("firmware.flash.failed", {
        jobId: job.id,
        error: eventMessage,
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
      const lastConfiguration = getLastConfiguration();
      const lastPortAvailable = ports.some((port) => port.path === lastConfiguration?.port);
      const recommendedPort = ports.find((port) => port.recommended) || ports[0] || null;
      return {
        arduinoCli: {
          command: arduinoCliPath,
          available: executableExists(arduinoCliPath),
        },
        defaultFqbn,
        sketchPath,
        ports,
        defaultPort: lastPortAvailable ? lastConfiguration.port : recommendedPort?.path || "",
        portStatus: ports.length
          ? "ESP32 serial port detected. Choose a port or refresh after reconnecting the device."
          : "No ESP32 serial port detected. Plug in the ESP32 USB cable, then refresh ports.",
        moduleCount: {
          min: MIN_MODULES,
          max: MAX_MODULES,
          value: lastConfiguration?.moduleCount || 4,
        },
        lastConfiguration,
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
        recoveryHint: null,
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
