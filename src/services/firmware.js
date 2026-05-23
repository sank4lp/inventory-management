import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_ESP32_FQBN,
  ESP32_FIRMWARE_PROTOCOL,
  MAX_LED_MODULES,
  MIN_LED_MODULES,
} from "./firmware-constants.js";
import { configureControllerModules } from "./inventory.js";

const MAX_LOG_LINES = 500;
const BOOT_BUTTON_GUIDANCE =
  "Upload failed while connecting to the ESP32. First confirm the selected serial port is the ESP32, not the RS485 USB-to-UART bridge. To force download mode: hold BOOT, start flashing, tap EN/RESET once when Connecting appears while still holding BOOT, then release BOOT only after upload starts. If there is no EN/RESET button, unplug and reconnect USB while holding BOOT.";

function nowIso() {
  return new Date().toISOString();
}

function asPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < MIN_LED_MODULES || number > MAX_LED_MODULES) {
    throw new Error(`${fieldName} must be a whole number from ${MIN_LED_MODULES} to ${MAX_LED_MODULES}.`);
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
  const fqbn = String(value || DEFAULT_ESP32_FQBN).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(fqbn)) {
    throw new Error("Board FQBN contains unsupported characters.");
  }
  return fqbn;
}

function normalizeControllerName(value, fallback = "ESP32-01") {
  const raw = String(value || "").trim() || fallback;
  const normalized = raw.toUpperCase().replaceAll(/\s+/g, "-");
  if (!/^[A-Z0-9._:-]+$/.test(normalized)) {
    throw new Error("Controller name can use letters, numbers, dot, dash, underscore, or colon.");
  }
  return normalized;
}

function normalizeControllerAddress(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9._:-]+$/.test(normalized)) {
    throw new Error("Controller RS485 id can use letters, numbers, dot, dash, underscore, or colon.");
  }
  return normalized;
}

function generateControllerAddress() {
  return `CTRL-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function cStringLiteral(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function usbSerialProfile(path, label = "", arduinoBoard = null) {
  const haystack = `${path} ${label} ${arduinoBoard?.name || ""} ${arduinoBoard?.fqbn || ""}`.toLowerCase();
  const knownEsp32 =
    haystack.includes("esp32") ||
    haystack.includes("espressif") ||
    haystack.includes("303a") ||
    String(arduinoBoard?.fqbn || "").toLowerCase().includes("esp32");
  const genericUsbUart =
    haystack.includes("cp210") ||
    haystack.includes("ch340") ||
    haystack.includes("ch341") ||
    haystack.includes("wchusb") ||
    haystack.includes("usb_serial") ||
    haystack.includes("usb-serial") ||
    haystack.includes("usbserial") ||
    haystack.includes("usbmodem") ||
    haystack.includes("1a86") ||
    haystack.includes("10c4");
  const likelyEsp32 =
    knownEsp32 ||
    path.includes("/ttyUSB") ||
    path.includes("/ttyACM");

  if (knownEsp32) {
    return {
      kind: "esp32",
      confidence: "known",
      recommended: true,
      badge: "ESP32",
    };
  }

  if (genericUsbUart) {
    return {
      kind: "usb_uart_bridge",
      confidence: "bridge",
      recommended: false,
      badge: "USB-UART",
    };
  }

  if (likelyEsp32) {
    return {
      kind: "esp32_candidate",
      confidence: "likely",
      recommended: true,
      badge: "Likely ESP32",
    };
  }

  return {
    kind: "serial",
    confidence: "unknown",
    recommended: false,
    badge: "Serial",
  };
}

function deviceIdentityFor(path, label, canonical) {
  if (path.includes("/dev/serial/by-id/")) {
    return `by-id:${label || path.split("/").pop()}`;
  }
  return `path:${canonical || path}`;
}

function isTtyAlias(path) {
  return (
    path.startsWith("/dev/ttyUSB") ||
    path.startsWith("/dev/ttyACM") ||
    path.startsWith("/dev/tty.usb") ||
    path.startsWith("/dev/cu.usb") ||
    path.startsWith("/dev/tty.SLAB") ||
    path.startsWith("/dev/cu.SLAB") ||
    path.startsWith("/dev/tty.wchusb") ||
    path.startsWith("/dev/cu.wchusb")
  );
}

function mergePortAlias(port, alias) {
  if (!alias) {
    return port;
  }
  if (!port.aliases.includes(alias)) {
    port.aliases.push(alias);
  }
  if (isTtyAlias(alias) && !port.ttyPath) {
    port.ttyPath = alias;
  }
  return port;
}

function readArduinoBoards(arduinoCliPath) {
  if (!executableExists(arduinoCliPath)) {
    return new Map();
  }

  const result = spawnSync(arduinoCliPath, ["board", "list", "--format", "json"], {
    encoding: "utf8",
    timeout: 3000,
  });

  if (result.status !== 0 || !result.stdout) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : parsed.detected_ports || parsed.ports || [];
    const byAddress = new Map();

    for (const row of rows) {
      const address = row?.port?.address || row?.address || row?.port || row?.port_path;
      if (!address) {
        continue;
      }
      const boards = row.matching_boards || row.boards || row.matchingBoards || [];
      const board = Array.isArray(boards) ? boards[0] : boards;
      byAddress.set(address, {
        name: board?.name || row.board_name || row.name || "",
        fqbn: board?.fqbn || row.fqbn || "",
      });
    }

    return byAddress;
  } catch {
    return new Map();
  }
}

function addPort(ports, seen, path, label = "", arduinoBoards = new Map()) {
  if (!path || seen.paths.has(path)) {
    return;
  }

  const canonical = canonicalPath(path);
  const existingPort = seen.canonical.get(canonical);
  if (existingPort) {
    seen.paths.add(path);
    mergePortAlias(existingPort, path);
    mergePortAlias(existingPort, canonical);
    return;
  }

  seen.paths.add(path);
  const aliases = [];
  const arduinoBoard = arduinoBoards.get(path) || arduinoBoards.get(canonical) || null;
  const profile = usbSerialProfile(path, label, arduinoBoard);
  const deviceIdentity = deviceIdentityFor(path, label, canonical);

  const port = {
    path,
    canonicalPath: canonical,
    label: label || path.split("/").pop() || path,
    deviceName: arduinoBoard?.name || label || path.split("/").pop() || path,
    deviceIdentity,
    aliases,
    ttyPath: "",
    arduinoBoard,
    ...profile,
  };
  mergePortAlias(port, path);
  mergePortAlias(port, canonical);
  ports.push(port);
  seen.canonical.set(canonical, port);
}

function listSerialPorts(arduinoCliPath) {
  const ports = [];
  const seen = {
    paths: new Set(),
    canonical: new Map(),
  };
  const arduinoBoards = readArduinoBoards(arduinoCliPath);

  try {
    for (const name of readdirSync("/dev/serial/by-id")) {
      addPort(ports, seen, `/dev/serial/by-id/${name}`, name, arduinoBoards);
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
      .forEach((name) => addPort(ports, seen, `/dev/${name}`, "", arduinoBoards));
  } catch {
    return ports;
  }

  return ports.sort((left, right) => {
    const rank = {
      known: 0,
      likely: 1,
      bridge: 2,
      unknown: 3,
    };
    if (rank[left.confidence] !== rank[right.confidence]) {
      return rank[left.confidence] - rank[right.confidence];
    }
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

function publicControllerRecord(controller, flashedDevices = {}) {
  const saved = flashedDevices[controller.address] || {};
  return {
    ...saved,
    controllerId: controller.id,
    controllerName: controller.controller_code,
    controllerAddress: controller.address,
    deviceName: controller.controller_code,
    deviceIdentity: controller.device_identity || saved.deviceIdentity || "",
    moduleCount: controller.module_count || saved.moduleCount || 0,
    configuredAt: saved.configuredAt || controller.configured_at || null,
  };
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
    controllerId: job.controllerId,
    controllerName: job.controllerName,
    controllerAddress: job.controllerAddress,
    previousControllerAddress: job.previousControllerAddress,
    replacingControllerId: job.replacingControllerId,
    deviceIdentity: job.deviceIdentity,
    deviceName: job.deviceName,
    flashedBy: job.flashedBy,
    fqbn: job.fqbn,
    sketchPath: job.sketchPath,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    currentCommand: job.currentCommand,
    commands: job.commands,
    logs: job.logs,
    recoveryHint: job.recoveryHint,
    verificationHint: job.verificationHint,
    mappingSummary: job.mappingSummary,
  };
}

export function createFirmwareService({ db, config = {}, logger, backupService = null }) {
  const jobs = new Map();
  const arduinoCliPath = config.arduinoCliPath || process.env.ARDUINO_CLI_PATH || "arduino-cli";
  const defaultFqbn = config.esp32Fqbn || process.env.ESP32_FQBN || DEFAULT_ESP32_FQBN;
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
    const previousController = job.replacingControllerId
      ? db.prepare("SELECT id, controller_code, address FROM controllers WHERE id = ?").get(job.replacingControllerId)
      : db
          .prepare("SELECT id, controller_code, address FROM controllers WHERE controller_code = ?")
          .get(job.controllerName);
    const controller = configureControllerModules(db, {
      controllerCode: job.controllerName,
      controllerAddress: job.controllerAddress,
      deviceIdentity: job.deviceIdentity,
      moduleCount: job.moduleCount,
      configuredBy: job.flashedBy?.id || null,
      firmwareVersion: ESP32_FIRMWARE_PROTOCOL,
    });
    job.controllerId = controller.id;
    job.controllerName = controller.controller_code;
    job.controllerAddress = controller.address;
    job.deviceName = controller.controller_code;
    job.mappingSummary = controller.mappingSummary || null;
    job.verificationHint =
      "Flash complete. Use Ping for each LED module in Cell mapping, then update the cell dropdown if a physical module is assigned to the wrong cell.";
    const payload = {
      jobId: job.id,
      controllerId: controller.id,
      controllerName: controller.controller_code,
      controllerAddress: controller.address,
      previousControllerAddress: previousController?.address || null,
      replacedExistingController: Boolean(previousController),
      moduleCount: job.moduleCount,
      assignedModules: job.assignedModules,
      mappingSummary: job.mappingSummary,
      verificationHint: job.verificationHint,
      port: job.port,
      deviceIdentity: job.deviceIdentity,
      deviceName: controller.controller_code,
      fqbn: job.fqbn,
      sketchPath: job.sketchPath,
      configuredAt: nowIso(),
      flashedBy: job.flashedBy,
    };

    db.prepare(
      `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('firmware_matrix_configuration', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
    ).run(JSON.stringify(payload), nowIso());

    const devices = getFlashedDevices();
    if (previousController?.address && previousController.address !== controller.address) {
      delete devices[previousController.address];
    }
    devices[controller.address] = payload;
    delete devices[job.deviceIdentity];
    delete devices[job.port];
    db.prepare(
      `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('firmware_matrix_devices', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
    ).run(JSON.stringify(devices), nowIso());

    try {
      const backupResult = backupService?.createCriticalBackup?.({
        source: previousController
          ? `controller-reconfigured-${controller.controller_code}`
          : `controller-added-${controller.controller_code}`,
      });
      if (backupResult?.backup?.filename) {
        appendLog(job, `Critical backup recorded: ${backupResult.backup.filename}`);
      }
    } catch (error) {
      appendLog(job, `WARNING: Critical backup failed: ${error.message}`);
      logger?.error?.("backup.critical.failed", {
        source: "firmware-controller-configuration",
        controllerId: controller.id,
        controllerCode: controller.controller_code,
        error: error.message,
      });
    }
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
          controllerAddress: job.controllerAddress,
          previousControllerAddress: job.previousControllerAddress,
          replacingControllerId: job.replacingControllerId,
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
        `compiler.cpp.extra_flags=-DLED_MODULE_COUNT=${job.moduleCount} -DCONTROLLER_NAME="${cStringLiteral(job.controllerName)}" -DCONTROLLER_ADDRESS="${cStringLiteral(job.controllerAddress)}"`,
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
          controllerAddress: job.controllerAddress,
          previousControllerAddress: job.previousControllerAddress,
          replacingControllerId: job.replacingControllerId,
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
      if (job.previousControllerAddress && job.previousControllerAddress !== job.controllerAddress) {
        appendLog(job, `Migrated existing mapping from ${job.previousControllerAddress} to ${job.controllerAddress}`);
      }
      if (job.mappingSummary) {
        appendLog(
          job,
          `Mapping after flash: preserved ${job.mappingSummary.preserved}, created ${job.mappingSummary.created}, manual ${job.mappingSummary.detached}.`,
        );
      }
      appendLog(job, job.verificationHint);
      appendLog(job, `Controller RS485 id: ${job.controllerAddress}`);
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

  function getFlashedDevices() {
    const row = db
      .prepare("SELECT value FROM app_metadata WHERE key = 'firmware_matrix_devices'")
      .get();
    const parsed = parseMetadata(row?.value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }

  function listControllerFlashRecords(flashedDevices) {
    return db
      .prepare(
        `
          SELECT id, controller_code, address, device_identity, module_count, configured_at
          FROM controllers
          WHERE active = 1
          ORDER BY controller_code
        `,
      )
      .all()
      .map((controller) => publicControllerRecord(controller, flashedDevices));
  }

  function annotatePorts(ports, flashedDevices, controllerFlashRecords) {
    return ports.map((port) => {
      const matchingRecords = controllerFlashRecords.filter(
        (record) => record.deviceIdentity && record.deviceIdentity === port.deviceIdentity,
      );
      const flashRecord = matchingRecords.length === 1 ? matchingRecords[0] : null;
      const flashRecordAmbiguous = matchingRecords.length > 1;
      return {
        ...port,
        flashStatus: flashRecord ? "configured" : flashRecordAmbiguous ? "ambiguous" : port.recommended ? "new" : "other",
        flashRecord,
        flashRecords: matchingRecords,
        flashRecordAmbiguous,
      };
    });
  }

  return {
    getFlashOptions() {
      const flashedDevices = getFlashedDevices();
      const controllerFlashRecords = listControllerFlashRecords(flashedDevices);
      const ports = annotatePorts(listSerialPorts(arduinoCliPath), flashedDevices, controllerFlashRecords);
      const lastConfiguration = getLastConfiguration();
      const lastPortAvailable = ports.some(
        (port) =>
          port.path === lastConfiguration?.port ||
          port.deviceIdentity === lastConfiguration?.deviceIdentity,
      );
      const configuredPort = ports.find((port) => port.flashStatus === "configured") || null;
      const esp32Ports = ports.filter(
        (port) => port.recommended || port.flashStatus === "configured" || port.flashStatus === "ambiguous",
      );
      const otherPorts = ports.filter((port) => !port.recommended);
      const configuredCount = esp32Ports.filter(
        (port) => port.flashStatus === "configured" || port.flashStatus === "ambiguous",
      ).length;
      const ambiguousCount = esp32Ports.filter((port) => port.flashStatus === "ambiguous").length;
      return {
        arduinoCli: {
          command: arduinoCliPath,
          available: executableExists(arduinoCliPath),
        },
        defaultFqbn,
        sketchPath,
        ports,
        esp32Ports,
        otherPorts,
        defaultPort: lastPortAvailable ? lastConfiguration.port : configuredPort?.path || "",
        portStatus: esp32Ports.length
          ? ambiguousCount
            ? `${ambiguousCount} serial port${ambiguousCount === 1 ? "" : "s"} match multiple configured controllers. Choose the exact controller name before flashing.`
            : configuredCount
            ? `${configuredCount} configured ESP32 controller${configuredCount === 1 ? "" : "s"} detected.`
            : "Step 1: unplug the ESP32 and scan without it. Then plug it in and detect the added port."
          : "Step 1: unplug the ESP32 and scan without it. Then plug it in and detect the added port.",
        moduleCount: {
          min: MIN_LED_MODULES,
          max: MAX_LED_MODULES,
          value: lastConfiguration?.moduleCount || 4,
        },
        lastConfiguration,
        flashedDevices,
        controllerFlashRecords,
      };
    },
    getLastConfiguration,
    startFlashJob(input = {}, actor = null) {
      if (!executableExists(arduinoCliPath)) {
        throw new Error(
          `Arduino CLI was not found at "${arduinoCliPath}". Install arduino-cli or set ARDUINO_CLI_PATH.`,
        );
      }

      const moduleCount = asPositiveInteger(input.module_count ?? input.moduleCount, "LED modules");
      const port = assertSafePort(input.port);
      const fqbn = assertSafeFqbn(input.fqbn || defaultFqbn);
      const deviceIdentity = String(input.device_identity || input.deviceIdentity || "").trim();
      if (!deviceIdentity) {
        throw new Error("Click Refresh ports and select the newly detected ESP32 before flashing.");
      }
      const detectedPort = listSerialPorts(arduinoCliPath).find(
        (entry) => entry.path === port || entry.canonicalPath === port,
      );
      if (!detectedPort) {
        throw new Error("ESP32 is not detected. Plug in the ESP32 USB cable, then refresh ports.");
      }
      if (detectedPort.deviceIdentity !== deviceIdentity) {
        throw new Error("Selected ESP32 changed after detection. Refresh ports and select it again.");
      }
      const requestedControllerName = String(input.controller_name || input.controllerName || "").trim();
      if (!requestedControllerName) {
        throw new Error("Controller name is required.");
      }
      const controllerName = normalizeControllerName(requestedControllerName);
      const existingByName = db
        .prepare("SELECT id, controller_code, address FROM controllers WHERE controller_code = ?")
        .get(controllerName);
      const existingController = existingByName || null;
      const controllerAddress = normalizeControllerAddress(
        input.controller_address || input.controllerAddress || generateControllerAddress(),
      );
      const assignedModules = Array.from({ length: moduleCount }, (_, index) => index + 1);
      const job = {
        id: randomUUID(),
        status: "running",
        stage: "queued",
        progress: 3,
        moduleCount,
        assignedModules,
        port,
        controllerId: null,
        controllerName,
        controllerAddress,
        previousControllerAddress: existingController?.address || null,
        replacingControllerId: existingController?.id || null,
        deviceIdentity: detectedPort.deviceIdentity,
        deviceName: controllerName,
        flashedBy: actor
          ? {
              id: actor.id,
              name: actor.name,
              username: actor.username,
            }
          : null,
        fqbn,
        sketchPath,
        startedAt: nowIso(),
        finishedAt: null,
        error: null,
        recoveryHint: null,
        verificationHint: null,
        mappingSummary: null,
        currentCommand: null,
        commands: [],
        logs: [],
      };

      jobs.set(job.id, job);
      runFlashJob(job);
      logger?.info("firmware.flash.started", {
        jobId: job.id,
        moduleCount,
        controllerAddress,
        previousControllerAddress: existingController?.address || null,
        replacingControllerId: existingController?.id || null,
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
