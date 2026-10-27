import {createHostAdapter} from "../modules/hardware/host-adapter.js";
import {currentActor} from "../modules/access/service.js";
import { guardSetupChange, guardUtilityDisplays, hasOutstandingWork } from "../modules/operations/guards.js";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { openUsbControllerSession } from "./usb-controller-session.js";
import { loadControllerProfile, saveControllerProfile, validateControllerConfiguration } from "./controller-profiles.js";
import { encodeControllerConfiguration } from "./hardware-adapters/controller-configuration.js";
import { withTransaction } from "../db.js";
import { randomBytes, randomUUID } from "node:crypto";

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

function readArduinoBoards(arduinoCliPath,env=process.env) {
  if (!executableExists(arduinoCliPath)) {
    return new Map();
  }

  const result = spawnSync(arduinoCliPath, ["board", "list", "--format", "json"], {
    env,
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

function listSerialPorts(arduinoCliPath,env=process.env) {
  const ports = [];
  const seen = {
    paths: new Set(),
    canonical: new Map(),
  };
  const arduinoBoards = readArduinoBoards(arduinoCliPath,env);

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
    physicalModuleCount:job.replacementProfile?.physicalCount ?? job.moduleCount,
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
    replacement: !!job.replacement,
    configurationVerified: !!job.configurationVerified,
    preservesTasks: !!job.preserveExistingWork,
    mappingSummary: job.mappingSummary,
  };
}

export function createFirmwareService({ db, config = {}, logger, backupService = null, hostAdapter = null, serialSessionFactory = openUsbControllerSession, onMaintenanceReleased = null }) {
  const jobs = new Map();
  const host=hostAdapter || createHostAdapter({config,discover:listSerialPorts});
  const arduinoCliPath = config.arduinoCliPath || process.env.ARDUINO_CLI_PATH || "arduino-cli";
  const defaultFqbn = config.esp32Fqbn || process.env.ESP32_FQBN || DEFAULT_ESP32_FQBN;
  const sketchPath = resolve(
    config.esp32SketchPath || process.env.ESP32_SKETCH_PATH || "firmware/esp32-simple-matrix",
  );

  function recoverInterruptedMaintenance() {
    const busy=db.prepare("SELECT value FROM app_metadata WHERE key='firmware_busy'").get();
    const owner=parseMetadata(db.prepare("SELECT value FROM app_metadata WHERE key='firmware_busy_owner'").get()?.value);
    if(!busy || owner?.id!==busy.value || !Number.isSafeInteger(owner.pid) || owner.pid<1)return;
    try {process.kill(owner.pid,0);return;}catch(error){if(error.code!=='ESRCH')return;}
    withTransaction(db,()=>{
      db.prepare("DELETE FROM app_metadata WHERE key='firmware_busy' AND value=?").run(owner.id);
      db.prepare("DELETE FROM app_metadata WHERE key='firmware_busy_owner'").run();
    });
    recordSystemEvent({eventType:'firmware_maintenance_interrupted',status:'warning',message:'Interrupted controller maintenance can be retried. Saved replacement profiles and pending recovery records were retained.',payload:{jobId:owner.id}});
  }
  function assertNoMaintenance() {
    recoverInterruptedMaintenance();
    if(db.prepare("SELECT 1 FROM app_metadata WHERE key='firmware_busy'").get())throw new Error('Controller maintenance is already in progress.');
  }
  function acquireMaintenance(id,{controllerId=null}={}) {
    withTransaction(db,()=>{
      if(db.prepare("SELECT 1 FROM app_metadata WHERE key='firmware_busy'").get())throw new Error('Controller maintenance is already in progress.');
      db.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('firmware_busy',?,?)").run(id,nowIso());
      db.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('firmware_busy_owner',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify({id,pid:process.pid}),nowIso());
      if(controllerId){
        db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`controller_firmware_hold:${controllerId}`,id,nowIso());
        db.prepare('UPDATE work_guidance SET delivered=0 WHERE cell_id IN (SELECT id FROM cells WHERE controller_id=?)').run(controllerId);
      }
    });
  }
  function releaseMaintenance(id,controllerId=null) {
    const released=withTransaction(db,()=>{
      const removed=db.prepare("DELETE FROM app_metadata WHERE key='firmware_busy' AND value=?").run(id);
      if(removed.changes)db.prepare("DELETE FROM app_metadata WHERE key='firmware_busy_owner'").run();
      return !!removed.changes;
    });
    if(released&&controllerId&&onMaintenanceReleased){try{onMaintenanceReleased(controllerId);}catch(error){logger?.warn?.('firmware.guidance.deferred',{controllerId,error:error.message});}}
  }
  function sameBoard(controller,deviceIdentity){return !!controller?.device_identity&&controller.device_identity===deviceIdentity;}
  function guardMaintenance(controller,deviceIdentity,preserveExistingWork=false){
    // The saved layout is restored and verified before preserving work on the same logical controller.
    if(controller&&(sameBoard(controller,deviceIdentity)||preserveExistingWork))guardUtilityDisplays(db);else guardSetupChange(db);
  }
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

  function replacementSignature(controllerId) {
    const controller=db.prepare('SELECT id,controller_code,address,module_count,device_identity,configured_at,active FROM controllers WHERE id=?').get(controllerId);
    const cells=db.prepare('SELECT id,hardware_channel,binding_revision,active FROM cells WHERE controller_id=? ORDER BY id').all(controllerId);
    return JSON.stringify({controller,cells});
  }
  function assertReplacementUnchanged(job) {
    if(job.replacement && replacementSignature(job.replacingControllerId)!==job.replacementSignature)throw new Error('Controller setup changed during replacement. Its mappings were preserved; refresh and retry with a current backup.');
  }
  function selectedUsbDevice(input) {
    const port=assertSafePort(input.port),identity=String(input.device_identity || input.deviceIdentity || '').trim();
    const detected=host.listDevices().find(entry=>entry.path===port || entry.canonicalPath===port);
    if(!detected || !identity || detected.deviceIdentity!==identity)throw new Error('Selected ESP32 changed after detection. Refresh ports and select it again.');
    const rs485Port=config.rs485SerialPort || process.env.RS485_SERIAL_PORT;
    if(rs485Port && canonicalPath(port)===canonicalPath(rs485Port))throw new Error('Select the ESP32 USB port, not the RS485 adapter.');
    return {port,device:detected};
  }
  async function readUsbConfiguration(session,address,options={}) {
    const request=randomBytes(8).toString('hex');
    const reply=await session.exchange(`to ${address} config-status ${request}`,r=>r.type==='controller-config' && r.address?.toUpperCase()===address.toUpperCase() && r.request===request);
    return validateControllerConfiguration(reply,address,request,options);
  }
  async function verifyUploadedConfiguration(job) {
    job.stage='verifying';job.progress=88;
    const session=serialSessionFactory(job.port,host);
    try {
      let actual=await readUsbConfiguration(session,job.controllerAddress,{allowFault:job.replacement});
      if(job.replacement) {
        const desired=job.replacementProfile;
        if(actual.fault || actual.physicalCount!==desired.physicalCount || JSON.stringify(actual.routing)!==JSON.stringify(desired.routing)) {
          currentActor(db,job.flashedBy,'hardware.flash');
          assertReplacementUnchanged(job);
          const requestId=job.id.replaceAll('-','').slice(0,16);
          const command=encodeControllerConfiguration({address:job.controllerAddress,requestId,expectedRevision:actual.revision,physicalCount:desired.physicalCount,routing:desired.routing});
          // A missing ACK is uncertain: read back before deciding whether restoration failed.
          try {await session.exchange(command,r=>r.type==='ack' && r.command==='configure' && r.address?.toUpperCase()===job.controllerAddress.toUpperCase() && r.request===requestId);}catch(error){appendLog(job,`Restore confirmation missing; checking the full configuration: ${error.message}`);}
          actual=await readUsbConfiguration(session,job.controllerAddress);
        }
        if(actual.physicalCount!==desired.physicalCount || JSON.stringify(actual.routing)!==JSON.stringify(desired.routing))throw new Error('Replacement routing could not be verified. Existing cell mappings were preserved.');
      } else if(actual.physicalCount!==job.moduleCount || actual.logicalCount!==job.moduleCount || actual.routing.some((n,i)=>n!==(i<job.moduleCount?i+1:0))) {
        throw new Error('Controller contains a different saved configuration. Back it up and use Replace existing controller to preserve routing.');
      }
      job.verifiedConfiguration=actual;job.configurationVerified=true;
    } finally {session.close();}
  }
  function saveLastConfiguration(job) {
    const previousController = job.replacingControllerId
      ? db.prepare("SELECT id, controller_code, address FROM controllers WHERE id = ?").get(job.replacingControllerId)
      : db
          .prepare("SELECT id, controller_code, address FROM controllers WHERE controller_code = ?")
          .get(job.controllerName);
    assertReplacementUnchanged(job);
    const controller = job.replacement ? withTransaction(db,()=>{
      currentActor(db,job.flashedBy,'hardware.flash');
      assertReplacementUnchanged(job);
      const configuredAt=job.preserveExistingWork?db.prepare('SELECT configured_at FROM controllers WHERE id=?').get(job.replacingControllerId).configured_at:nowIso();
      db.prepare("UPDATE controllers SET device_identity=?,firmware_version=?,configured_at=?,configured_by=?,heartbeat_status='offline' WHERE id=?").run(job.deviceIdentity,ESP32_FIRMWARE_PROTOCOL,configuredAt,job.flashedBy.id,job.replacingControllerId);
      const controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(job.replacingControllerId);
      saveControllerProfile(db,controller,job.verifiedConfiguration);
      return {...controller,mappingSummary:{preserved:db.prepare('SELECT COUNT(*) n FROM cells WHERE controller_id=? AND active=1').get(controller.id).n,created:0,detached:0}};
    }) : configureControllerModules(db, {
      controllerCode: job.controllerName,
      controllerAddress: job.controllerAddress,
      deviceIdentity: job.deviceIdentity,
      moduleCount: job.moduleCount,
      configuredBy: job.flashedBy?.id || null,
      firmwareVersion: ESP32_FIRMWARE_PROTOCOL,
    });
    if(!job.replacement)saveControllerProfile(db,controller,job.verifiedConfiguration);
    job.controllerId = controller.id;
    job.controllerName = controller.controller_code;
    job.controllerAddress = controller.address;
    job.deviceName = controller.controller_code;
    job.mappingSummary = controller.mappingSummary || null;
    job.verificationHint = job.preserveExistingWork ? "Firmware and the saved LED order verified. Existing tasks, locations and stock are unchanged. Reconnect the same LED/RS485 wiring; task lights resume when the controller reconnects." : job.replacement ? "Replacement firmware and routing verified over USB. Cell mappings are unchanged. Disconnect USB, reconnect the same LED/RS485 wiring, then Ping the controller to check the connection." :
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

  function runCommand(job,stage,progress,args) {
    currentActor(db,job.flashedBy,'hardware.flash');
    job.stage=stage;job.progress=progress;job.currentCommand=commandLine(host.command(),args);job.commands.push(job.currentCommand);
    appendLog(job,`$ ${job.currentCommand}`);
    return host.runFirmware(args,{onOutput:text=>appendLog(job,text)});
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

      assertReplacementUnchanged(job);
      if(job.sameControllerUpdate&&!job.recoveringUpload&&!host.support().simulated&&Number(/^simple-matrix-v(\d+)-rs485-addressed$/.exec(job.previousProtocol||'')?.[1])>=14){
        const session=serialSessionFactory(job.port,host);
        try{
          const actual=await readUsbConfiguration(session,job.controllerAddress),desired=job.replacementProfile;
          if(actual.physicalCount!==desired.physicalCount||JSON.stringify(actual.routing)!==JSON.stringify(desired.routing))throw new Error('The connected controller LED count or order differs from its saved setup. Review the layout before updating firmware. Existing tasks are kept.');
        }finally{session.close();}
      }
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
        `compiler.cpp.extra_flags=-MMD -c -DLED_MODULE_COUNT=${job.replacement ? 0 : job.moduleCount} -DCONTROLLER_NAME="${cStringLiteral(job.controllerName)}" -DCONTROLLER_ADDRESS="${cStringLiteral(job.controllerAddress)}"`,
        "--output-dir",
        buildDir,
        job.sketchPath,
      ]);

      assertReplacementUnchanged(job);
      currentActor(db,job.flashedBy,'hardware.flash');
      selectedUsbDevice({port:job.port,device_identity:job.deviceIdentity});
      job.progress = 58;
      if(job.replacement&&!host.support().simulated){
        const key=`controller_replacement_pending:${job.replacingControllerId}`,pending=parseMetadata(db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value);
        if(!pending||pending.jobId!==job.id)throw new Error('Controller maintenance receipt changed. Retry the update.');
        db.prepare('UPDATE app_metadata SET value=?,updated_at=? WHERE key=?').run(JSON.stringify({...pending,uploadStarted:true}),nowIso(),key);
      }
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
      if(host.support().simulated){job.status="completed";job.stage="simulated";job.progress=100;job.finishedAt=nowIso();job.currentCommand=null;appendLog(job,"Simulation completed. No firmware was compiled or flashed and no controller configuration was saved.");return;}
      await verifyUploadedConfiguration(job);
      currentActor(db,job.flashedBy,'hardware.flash');
      guardMaintenance(job.replacement?db.prepare('SELECT * FROM controllers WHERE id=?').get(job.replacingControllerId):null,job.deviceIdentity,job.preserveExistingWork);
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

      if(job.replacement){
        withTransaction(db,()=>{
          db.prepare('DELETE FROM app_metadata WHERE key=?').run(`controller_replacement_pending:${job.replacingControllerId}`);
          db.prepare('DELETE FROM app_metadata WHERE key=? AND value=?').run(`controller_firmware_hold:${job.replacingControllerId}`,job.id);
          db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`controller_firmware_epoch:${job.replacingControllerId}`,job.id,nowIso());
        });
      }
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
    finally { releaseMaintenance(job.id,job.replacingControllerId); }
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
          SELECT id, controller_code, address, device_identity, module_count, configured_at, firmware_version
          FROM controllers
          WHERE active = 1
          ORDER BY controller_code
        `,
      )
      .all()
      .map((controller) => {
        let profile=null,profileError=null;
        try {profile=loadControllerProfile(db,controller);}catch(error){profileError=error.message;}
        return {...publicControllerRecord(controller, flashedDevices),replacementReady:!!profile,physicalModuleCount:profile?.physicalCount ?? null,profileError};
      });
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
      recoverInterruptedMaintenance();
      const flashedDevices = getFlashedDevices();
      const controllerFlashRecords = listControllerFlashRecords(flashedDevices);
      const ports = annotatePorts(host.listDevices(), flashedDevices, controllerFlashRecords);
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
        host:host.support(),
        arduinoCli: {
          command: host.command(),
          available: config.firmwareSimulation===true||executableExists(host.command()),
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
    async backupController(input={},actor=null) {
      actor=currentActor(db,actor,'hardware.flash');guardUtilityDisplays(db);
      if(host.support().simulated)throw new Error('Simulation cannot create a verified controller backup.');
      assertNoMaintenance();
      const controller=db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(Number(input.replacement_controller_id));
      if(!controller)throw new Error('Choose the existing controller whose connected board you are backing up.');
      const selected=selectedUsbDevice(input),signature=replacementSignature(controller.id),lock=randomUUID();
      guardMaintenance(controller,selected.device.deviceIdentity);
      acquireMaintenance(lock);
      let session;
      try {
        session=serialSessionFactory(selected.port,host);
        const actual=await readUsbConfiguration(session,controller.address);
        currentActor(db,actor,'hardware.flash');
        if(replacementSignature(controller.id)!==signature)throw new Error('Controller setup changed during backup. Refresh and retry.');
        if(hasOutstandingWork(db)&&sameBoard(controller,selected.device.deviceIdentity)){
          const previous=loadControllerProfile(db,controller);
          if(previous&&(actual.physicalCount!==previous.physicalCount||JSON.stringify(actual.routing)!==JSON.stringify(previous.routing)))throw new Error('The LED count or order changed. Resolve the layout separately before updating its backup; existing tasks are kept.');
        }
        const profile=saveControllerProfile(db,controller,actual);
        recordSystemEvent({eventType:'controller_profile_saved',status:'info',message:`Replacement backup saved for ${controller.controller_code}.`,payload:{controllerId:controller.id,revision:actual.revision}});
        backupService?.createCriticalBackup?.({source:`controller-profile-${controller.controller_code}`});
        return {message:'Controller setup saved. You can now replace its ESP32 without remapping cells.',profile};
      }finally{session?.close();releaseMaintenance(lock,controller.id);}
    },
    startFlashJob(input = {}, actor = null) {
      actor=currentActor(db,actor,"hardware.flash");
      guardUtilityDisplays(db);
      assertNoMaintenance();
      if(config.firmwareToolchainRoot||process.env.FIRMWARE_TOOLCHAIN_ROOT)host.verifyToolchain();
      if (!config.firmwareSimulation && !executableExists(host.command())) {
        throw new Error(
          `Arduino CLI was not found at "${arduinoCliPath}". Install arduino-cli or set ARDUINO_CLI_PATH.`,
        );
      }

      const replacementId=Number(input.replacement_controller_id || 0);
      if(!Number.isSafeInteger(replacementId) || replacementId<0)throw new Error('Choose an existing controller to replace.');
      const replacementController=replacementId?db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(replacementId):null;
      if(replacementId && !replacementController)throw new Error('Replacement controller no longer exists.');
      if(replacementId && !['1','on',true].includes(input.replacement_confirmed))throw new Error('Confirm the old controller is disconnected and the LED chain is unchanged.');
      const replacementProfile=replacementController?loadControllerProfile(db,replacementController):null;
      if(replacementController && !replacementProfile)throw new Error('No verified controller backup is saved. Connect the original board by USB and save its setup before replacement.');
      const moduleCount = replacementController ? replacementController.module_count : asPositiveInteger(input.module_count ?? input.moduleCount, "LED modules");
      const port = assertSafePort(input.port);
      const fqbn = assertSafeFqbn(input.fqbn || defaultFqbn);
      const deviceIdentity = String(input.device_identity || input.deviceIdentity || "").trim();
      if (!deviceIdentity) {
        throw new Error("Click Refresh ports and select the newly detected ESP32 before flashing.");
      }
      const detectedPort = host.listDevices().find(
        (entry) => entry.path === port || entry.canonicalPath === port,
      );
      if (!detectedPort) {
        throw new Error("ESP32 is not detected. Plug in the ESP32 USB cable, then refresh ports.");
      }
      if (detectedPort.deviceIdentity !== deviceIdentity) {
        throw new Error("Selected ESP32 changed after detection. Refresh ports and select it again.");
      }
      selectedUsbDevice(input);
      const preserveExistingWork=!!replacementController&&(sameBoard(replacementController,deviceIdentity)||input.keep_existing_work==='1');
      guardMaintenance(replacementController,deviceIdentity,preserveExistingWork);
      if(replacementProfile&&input.module_count!=null&&Number(input.module_count)!==replacementProfile.physicalCount)throw new Error('An in-place firmware update must keep the saved LED count and order. Change the physical layout separately.');
      const requestedControllerName = replacementController?.controller_code || String(input.controller_name || input.controllerName || "").trim();
      if (!requestedControllerName) {
        throw new Error("Controller name is required.");
      }
      const controllerName = normalizeControllerName(requestedControllerName);
      const existingByName = db
        .prepare("SELECT id, controller_code, address FROM controllers WHERE controller_code = ?")
        .get(controllerName);
      const existingController = replacementController || existingByName || null;
      if(existingController && !replacementController)throw new Error('This controller already exists. Choose Replace existing controller to preserve its identity and mappings.');
      const controllerAddress = normalizeControllerAddress(
        replacementController?.address || input.controller_address || input.controllerAddress || generateControllerAddress(),
      );
      const addressOwner=db.prepare('SELECT id FROM controllers WHERE address=? AND active=1').get(controllerAddress);
      if(addressOwner && addressOwner.id!==existingController?.id)throw new Error('That controller address is already in use.');
      const assignedModules = replacementProfile ? replacementProfile.routing.flatMap((physical,index)=>physical?[index+1]:[]) : Array.from({ length: moduleCount }, (_, index) => index + 1);
      const previousMaintenance=replacementController?parseMetadata(db.prepare('SELECT value FROM app_metadata WHERE key=?').get(`controller_replacement_pending:${replacementId}`)?.value):null;
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
        replacement:!!replacementController,
        sameControllerUpdate:sameBoard(replacementController,deviceIdentity),
        preserveExistingWork,
        previousProtocol:replacementController?.firmware_version,
        recoveringUpload:previousMaintenance?.uploadStarted===true&&previousMaintenance.deviceIdentity===deviceIdentity&&previousMaintenance.controllerId===replacementId,
        replacementProfile,
        replacementSignature:replacementController?replacementSignature(replacementController.id):null,
        configurationVerified:false,
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

      if(job.replacement && !host.support().simulated) {
        backupService?.createCriticalBackup?.({source:`before-controller-replacement-${job.controllerName}`});
        db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`controller_replacement_pending:${replacementId}`,JSON.stringify({jobId:job.id,controllerId:replacementId,deviceIdentity:job.deviceIdentity,profile:replacementProfile,startedAt:job.startedAt}),nowIso());
      }
      acquireMaintenance(job.id,{controllerId:job.replacement&&!host.support().simulated?replacementId:null});
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
