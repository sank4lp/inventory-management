import {createHostAdapter} from "../modules/hardware/host-adapter.js";
import {currentActor} from "../modules/access/service.js";
import { guardSetupChange, guardUtilityDisplays, hasOutstandingWork } from "../modules/operations/guards.js";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { openUsbControllerSession } from "./usb-controller-session.js";
import { controllerBusDiagnostics, loadControllerProfile, saveControllerProfile, validateControllerConfiguration } from "./controller-profiles.js";
import { encodeControllerConfiguration } from "./hardware-adapters/controller-configuration.js";
import {resizedControllerProfile,applyControllerLayout} from './controller-layout.js';
import {firmwareFailure} from './firmware-errors.js';
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
    maintenanceAction:job.maintenanceAction,
    layoutChanged:!!job.layoutChanged,
    freshSetup: !!job.freshSetup,
    configurationVerified: !!job.configurationVerified,
    preservesTasks: !!job.preserveExistingWork,
    mappingSummary: job.mappingSummary,
  };
}

export function createFirmwareService({ db, config = {}, logger, backupService = null, hostAdapter = null, serialSessionFactory = openUsbControllerSession, onMaintenanceReleased = null }) {
  const jobs = new Map();
  function persistJob(job) {
    db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`firmware_job:${job.id}`,JSON.stringify(publicJob(job)),nowIso());
    db.prepare("DELETE FROM app_metadata WHERE key IN (SELECT key FROM app_metadata WHERE key LIKE 'firmware_job:%' ORDER BY updated_at DESC LIMIT -1 OFFSET 20)").run();
  }
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
      const key=`firmware_job:${owner.id}`,saved=parseMetadata(db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value);
      if(saved?.status==='running'){
        saved.status='failed';saved.stage='interrupted';saved.finishedAt=nowIso();saved.error='Controller maintenance was interrupted. Reconnect the same ESP32 and retry this controller.';
        saved.recoveryHint='The warehouse mappings were kept. An upload that was not verified must be retried before using this controller.';
        db.prepare('UPDATE app_metadata SET value=?,updated_at=? WHERE key=?').run(JSON.stringify(saved),nowIso(),key);
      }
      for(const pending of db.prepare("SELECT key,value FROM app_metadata WHERE key LIKE 'controller_replacement_pending:%'").all()){
        const receipt=parseMetadata(pending.value);
        if(receipt?.jobId===owner.id&&!receipt.uploadStarted){db.prepare('DELETE FROM app_metadata WHERE key=?').run(pending.key);db.prepare('DELETE FROM app_metadata WHERE key=? AND value=?').run(`controller_firmware_hold:${receipt.controllerId}`,owner.id);}
      }
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
    if(controller&&preserveExistingWork)guardUtilityDisplays(db);else guardSetupChange(db);
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
    const reply=await session.exchange(`to ${address} config-status ${request}`,r=>r.type==='controller-config' && r.address?.toUpperCase()===address.toUpperCase() && r.request===request,options.exchange);
    const configuration=validateControllerConfiguration(reply,address,request,options);
    options.onReply?.(reply);
    return configuration;
  }
  const savedChipIdentity=id=>db.prepare('SELECT value FROM app_metadata WHERE key=?').get(`controller_chip_identity:${id}`)?.value;
  async function identifyUsbController(job){
    if(host.support().simulated||!host.readChipIdentity)return;
    const collisions=job.replacement?[]:db.prepare('SELECT id,controller_code,address FROM controllers WHERE device_identity=? AND active=1').all(job.deviceIdentity);
    // USB bridges can all report the same factory serial (for example 0001).
    // An older registered controller has no ROM identity yet: check its saved
    // address over USB before accepting an explicitly confirmed different board.
    for(const controller of collisions.filter(c=>!savedChipIdentity(c.id))){
      const session=serialSessionFactory(job.port,host);let matched=false;
      try{await readUsbConfiguration(session,controller.address,{allowFault:true,allowBusFault:true,allowLedFault:true,exchange:{attempts:2,timeoutMs:700}});matched=true;}
      catch(error){if(!/USB confirmation timed out/.test(error.message))throw error;}
      finally{session.close();}
      if(matched)throw new Error(`This ESP32 is already registered as ${controller.controller_code}. Use Edit on that controller; its locations are kept.`);
      if(!job.sharedUsbConfirmed)throw new Error('This USB serial is also used by an older controller. Confirm that you connected a different ESP32, then retry.');
    }
    job.stage='identifying';job.progress=5;appendLog(job,'Checking the ESP32 hardware identity before flashing.');
    const chip=await host.readChipIdentity(job.port,{fqbn:job.fqbn});
    if(!/^[\da-f]{2}(?::[\da-f]{2}){5}$/.test(chip))throw new Error('Invalid ESP32 hardware identity. Nothing was flashed.');
    const owner=db.prepare("SELECT c.id,c.controller_code FROM controllers c JOIN app_metadata m ON m.key='controller_chip_identity:'||c.id WHERE c.active=1 AND m.value=?").get(chip);
    if(owner&&owner.id!==job.replacingControllerId)throw new Error(`This ESP32 is already registered as ${owner.controller_code}. Use Edit on that controller; its locations are kept.`);
    const previous=job.replacement?savedChipIdentity(job.replacingControllerId):null;
    if(job.maintenanceAction==='update'&&previous&&previous!==chip)throw new Error('A different ESP32 is connected. Select Replace ESP32 on this controller to preserve its locations. Nothing was uploaded.');
    if(job.maintenanceAction==='replace'&&previous===chip)throw new Error('This is the original ESP32. Choose Update firmware, or connect its replacement. Nothing was uploaded.');
    if(job.replacement){
      job.sameControllerUpdate=previous?previous===chip:job.maintenanceAction!=='replace'&&job.sameControllerUpdate;
      if(previous&&previous!==chip&&job.maintenanceAction==='auto'&&!job.keepExistingWork){job.preserveExistingWork=false;guardMaintenance(null,job.deviceIdentity);}
    }
    job.chipIdentity=chip;
  }
  async function verifyUploadedConfiguration(job) {
    job.stage='verifying';job.progress=88;
    const session=serialSessionFactory(job.port,host);
    try {
      let actual=await readUsbConfiguration(session,job.controllerAddress,{allowFault:job.replacement||job.freshSetup});
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
      } else if(job.freshSetup) {
        const routing=Array.from({length:64},(_,i)=>i<job.moduleCount?i+1:0);
        if(actual.fault || actual.physicalCount!==job.moduleCount || JSON.stringify(actual.routing)!==JSON.stringify(routing)) {
          currentActor(db,job.flashedBy,'hardware.flash');
          selectedUsbDevice({port:job.port,device_identity:job.deviceIdentity});
          guardMaintenance(null,job.deviceIdentity);
          const requestId=job.id.replaceAll('-','').slice(0,16);
          const command=encodeControllerConfiguration({address:job.controllerAddress,requestId,expectedRevision:actual.revision,physicalCount:job.moduleCount,routing});
          appendLog(job,'Applying the confirmed fresh LED setup to this ESP32.');
          try {await session.exchange(command,r=>r.type==='ack' && r.command==='configure' && r.address?.toUpperCase()===job.controllerAddress.toUpperCase() && r.request===requestId);}catch(error){appendLog(job,`Setup confirmation missing; checking the full configuration: ${error.message}`);}
          actual=await readUsbConfiguration(session,job.controllerAddress);
        }
        if(actual.physicalCount!==job.moduleCount || actual.logicalCount!==job.moduleCount || JSON.stringify(actual.routing)!==JSON.stringify(routing))throw new Error('The fresh LED setup could not be verified. The controller was not registered. Check the USB connection and retry setup.');
      } else if(actual.physicalCount!==job.moduleCount || actual.logicalCount!==job.moduleCount || actual.routing.some((n,i)=>n!==(i<job.moduleCount?i+1:0))) {
        throw new Error('Controller contains a different saved configuration. Back it up and use Replace existing controller to preserve routing.');
      }
      job.verifiedConfiguration=actual;job.configurationVerified=true;
    } finally {session.close();}
  }
  async function verifySavedConfiguration(job) {
    if(!job.chipIdentity)return;
    job.stage='checking-saved-setup';job.progress=94;persistJob(job);
    // readChipIdentity performs a hardware reset after reading ROM. Verify that
    // the same chip reloads the complete configuration from nonvolatile storage.
    if(await host.readChipIdentity(job.port,{fqbn:job.fqbn})!==job.chipIdentity)throw new Error('The ESP32 changed before final verification. Reconnect the selected controller and retry.');
    const session=serialSessionFactory(job.port,host);
    try{
      const actual=await readUsbConfiguration(session,job.controllerAddress),expected=job.verifiedConfiguration;
      if(actual.revision!==expected.revision||actual.physicalCount!==expected.physicalCount||JSON.stringify(actual.routing)!==JSON.stringify(expected.routing))throw new Error('The ESP32 did not keep its LED setup after restarting. Keep USB connected and retry this controller.');
      appendLog(job,'ESP32 identity and saved LED setup verified again after a hardware reset.');
    }finally{session.close();}
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
      const mappingSummary=job.layoutChanged?applyControllerLayout(db,db.prepare('SELECT * FROM controllers WHERE id=?').get(job.replacingControllerId),job.replacementProfile,job.flashedBy.id,job.sourceProfile):{preserved:db.prepare('SELECT COUNT(*) n FROM cells WHERE controller_id=? AND active=1').get(job.replacingControllerId).n,created:0,detached:0};
      db.prepare("UPDATE controllers SET device_identity=?,firmware_version=?,configured_at=?,configured_by=?,heartbeat_status='offline' WHERE id=?").run(job.deviceIdentity,ESP32_FIRMWARE_PROTOCOL,configuredAt,job.flashedBy.id,job.replacingControllerId);
      const controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(job.replacingControllerId);
      saveControllerProfile(db,controller,job.verifiedConfiguration);
      const result={...controller,mappingSummary};
      finishConfiguration(result,previousController,job);return result;
    }) : configureControllerModules(db, {
      controllerCode: job.controllerName,
      controllerAddress: job.controllerAddress,
      deviceIdentity: job.deviceIdentity,
      moduleCount: job.moduleCount,
      configuredBy: job.flashedBy?.id || null,
      firmwareVersion: ESP32_FIRMWARE_PROTOCOL,
    },controller=>{
      db.prepare("UPDATE controllers SET heartbeat_status='offline',last_seen_at=NULL WHERE id=?").run(controller.id);
      saveControllerProfile(db,controller,job.verifiedConfiguration);finishConfiguration(controller,previousController,job);
    });
    return controller;
  }
  function finishConfiguration(controller,previousController,job) {
    if(job.chipIdentity)db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`controller_chip_identity:${controller.id}`,job.chipIdentity,nowIso());
    job.controllerId = controller.id;
    job.controllerName = controller.controller_code;
    job.controllerAddress = controller.address;
    job.deviceName = controller.controller_code;
    job.mappingSummary = controller.mappingSummary || null;
    job.verificationHint = job.preserveExistingWork ? "Firmware and the saved LED order verified. Existing tasks, locations and stock are unchanged. Reconnect the same LED/RS485 wiring; task lights resume when the controller reconnects." : job.replacement ? "Replacement firmware and routing verified over USB. Cell mappings are unchanged. Disconnect USB, reconnect the same LED/RS485 wiring, then Ping the controller to check the connection." :
      "Controller firmware and LED setup verified. Reconnect its LED/RS485 wiring, check Controller health, then name and pair locations in Manage Locations.";
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
      chipIdentity: job.chipIdentity || null,
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

  }
  function backupAfterConfiguration(job) {
    try {
      const backupResult = backupService?.createCriticalBackup?.({
        source: job.replacement
          ? `controller-reconfigured-${job.controllerName}`
          : `controller-added-${job.controllerName}`,
      });
      if (backupResult?.backup?.filename) {
        appendLog(job, `Critical backup recorded: ${backupResult.backup.filename}`);
      }
    } catch (error) {
      appendLog(job, `WARNING: Critical backup failed: ${error.message}`);
      logger?.error?.("backup.critical.failed", {
        source: "firmware-controller-configuration",
        controllerId: job.controllerId,
        controllerCode: job.controllerName,
        error: error.message,
      });
    }
  }

  function runCommand(job,stage,progress,args) {
    currentActor(db,job.flashedBy,'hardware.flash');
    job.stage=stage;job.progress=progress;job.currentCommand=commandLine(host.command(),args);job.commands.push(job.currentCommand);
    appendLog(job,`$ ${job.currentCommand}`);
    persistJob(job);
    return host.runFirmware(args,{onOutput:text=>appendLog(job,text),timeoutMs:stage==='compiling'?600000:180000});
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
      await identifyUsbController(job);
      if(job.sameControllerUpdate&&!job.recoveringUpload&&!host.support().simulated&&Number(/^simple-matrix-v(\d+)-rs485-addressed$/.exec(job.previousProtocol||'')?.[1])>=15){
        const session=serialSessionFactory(job.port,host);
        try{
          let actual;
          try{actual=await readUsbConfiguration(session,job.controllerAddress,{allowFault:true,allowBusFault:true,allowLedFault:true});}
          catch(error){
            // The ROM can be healthy while the old application is damaged or
            // no longer starts. A verified host profile and ROM identity allow
            // reflashing; an unavailable old application is not a dead end.
            if(!/USB confirmation timed out|configuration response|configuration reply|configuration checksum|ESP32 rejected/.test(error.message))throw error;
            appendLog(job,`The old firmware could not report its LED setup (${error.message}). Restoring the verified warehouse profile after upload.`);
          }
          const desired=job.sourceProfile;
          if(actual?.fault)appendLog(job,'The ESP32 has a saved-setup fault. Restoring the verified warehouse profile after upload.');
          else if(actual&&(actual.physicalCount!==desired.physicalCount||JSON.stringify(actual.routing)!==JSON.stringify(desired.routing)))throw new Error('The connected controller LED count or order differs from its saved setup. Review the layout before updating firmware. Existing tasks are kept.');
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
        `compiler.cpp.extra_flags=-MMD -c -DLED_MODULE_COUNT=${job.replacement || job.freshSetup ? 0 : job.moduleCount} -DCONTROLLER_NAME="${cStringLiteral(job.controllerName)}" -DCONTROLLER_ADDRESS="${cStringLiteral(job.controllerAddress)}"`,
        "--output-dir",
        buildDir,
        job.sketchPath,
      ]);

      assertReplacementUnchanged(job);
      currentActor(db,job.flashedBy,'hardware.flash');
      selectedUsbDevice({port:job.port,device_identity:job.deviceIdentity});
      if(job.chipIdentity&&await host.readChipIdentity(job.port,{fqbn:job.fqbn})!==job.chipIdentity)throw new Error('The connected ESP32 changed while compiling. Nothing was uploaded. Reconnect the selected controller and retry.');
      if(job.layoutChanged)resizedControllerProfile(db,db.prepare('SELECT * FROM controllers WHERE id=?').get(job.replacingControllerId),job.sourceProfile,job.replacementProfile.physicalCount);
      job.progress = 58;
      if(job.replacement&&!host.support().simulated){
        const key=`controller_replacement_pending:${job.replacingControllerId}`,pending=parseMetadata(db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value);
        if(!pending||pending.jobId!==job.id)throw new Error('Controller maintenance receipt changed. Retry the update.');
        db.prepare('UPDATE app_metadata SET value=?,updated_at=? WHERE key=?').run(JSON.stringify({...pending,uploadStarted:true}),nowIso(),key);
      }
      job.uploadStarted=true;
      await runCommand(job, "uploading", 62, [
        "upload",
        "--fqbn",
        job.fqbn,
        "-p",
        job.port,
        "--input-dir",
        buildDir,
        "--upload-property",
        "upload.speed=115200",
        job.sketchPath,
      ]);

      job.stage = "configuring";
      job.progress = 82;
      persistJob(job);
      if(host.support().simulated){job.status="completed";job.stage="simulated";job.progress=100;job.finishedAt=nowIso();job.currentCommand=null;appendLog(job,"Simulation completed. No firmware was compiled or flashed and no controller configuration was saved.");return;}
      await verifyUploadedConfiguration(job);
      await verifySavedConfiguration(job);
      currentActor(db,job.flashedBy,'hardware.flash');
      guardMaintenance(job.replacement?db.prepare('SELECT * FROM controllers WHERE id=?').get(job.replacingControllerId):null,job.deviceIdentity,job.preserveExistingWork);
      saveLastConfiguration(job);
      backupAfterConfiguration(job);
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
      const failure=firmwareFailure(error,failedStage,job.logs.slice(-30).map(x=>x.line).join('\n'));
      const message = failure.message;
      const eventMessage = uploadFailed
        ? `${error.message} ${BOOT_BUTTON_GUIDANCE}`
        : error.message;
      job.status = "failed";
      job.stage = "failed";
      job.progress = job.progress || 0;
      job.finishedAt = nowIso();
      job.error = message;
      job.recoveryHint = failure.hint;
      job.currentCommand = null;
      if(job.replacement&&!job.uploadStarted&&!job.recoveringUpload){
        withTransaction(db,()=>{
          db.prepare('DELETE FROM app_metadata WHERE key=? AND value=?').run(`controller_firmware_hold:${job.replacingControllerId}`,job.id);
          db.prepare('DELETE FROM app_metadata WHERE key=?').run(`controller_replacement_pending:${job.replacingControllerId}`);
        });
      }
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
    finally {try{persistJob(job);}finally{releaseMaintenance(job.id,job.replacingControllerId);}}
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
        const pending=parseMetadata(db.prepare('SELECT value FROM app_metadata WHERE key=?').get(`controller_replacement_pending:${controller.id}`)?.value);
        return {...publicControllerRecord(controller, flashedDevices),replacementReady:!!profile,physicalModuleCount:profile?.physicalCount ?? null,pendingPhysicalCount:pending?.uploadStarted?pending.profile?.physicalCount:null,maintenancePending:!!pending?.uploadStarted,profileError};
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
        activeJob:publicJob([...jobs.values()].find(job=>job.status==='running'))||parseMetadata(db.prepare("SELECT value FROM app_metadata WHERE key='firmware_job:'||(SELECT value FROM app_metadata WHERE key='firmware_busy')").get()?.value),
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
      guardMaintenance(controller,selected.device.deviceIdentity,sameBoard(controller,selected.device.deviceIdentity));
      acquireMaintenance(lock);
      let session;
      try {
        session=serialSessionFactory(selected.port,host);
        let diagnostics=null;
        const actual=await readUsbConfiguration(session,controller.address,{onReply:reply=>{diagnostics=controllerBusDiagnostics(reply);}});
        currentActor(db,actor,'hardware.flash');
        if(replacementSignature(controller.id)!==signature)throw new Error('Controller setup changed during backup. Refresh and retry.');
        if(hasOutstandingWork(db)&&sameBoard(controller,selected.device.deviceIdentity)){
          const previous=loadControllerProfile(db,controller);
          if(previous&&(actual.physicalCount!==previous.physicalCount||JSON.stringify(actual.routing)!==JSON.stringify(previous.routing)))throw new Error('The LED count or order changed. Resolve the layout separately before updating its backup; existing tasks are kept.');
        }
        const profile=saveControllerProfile(db,controller,actual);
        recordSystemEvent({eventType:'controller_profile_saved',status:'info',message:`Replacement backup saved for ${controller.controller_code}.`,payload:{controllerId:controller.id,revision:actual.revision}});
        backupService?.createCriticalBackup?.({source:`controller-profile-${controller.controller_code}`});
        const busMessage=diagnostics?` RS485 port ready: target 115200 baud, reported ${diagnostics.baud}. RX GPIO${diagnostics.rxPin}, TX GPIO${diagnostics.txPin}, direction GPIO${diagnostics.directionPin}. Received ${diagnostics.rxBytes} bytes / ${diagnostics.rxLines} lines; ${diagnostics.pingRequests} ping requests; submitted ${diagnostics.txBytes} bytes for transmission. This does not verify the A/B connection.`:' This firmware does not report RS485 diagnostics. USB setup is verified; the A/B connection is not.';
        return {message:'Controller setup saved. You can now replace its ESP32 without remapping cells.'+busMessage,profile,diagnostics};
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
      const setupMode=String(input.controller_setup_mode||'');
      if(setupMode && setupMode!=='fresh')throw new Error('Choose a supported controller setup option.');
      const freshSetup=setupMode==='fresh';
      if(freshSetup && replacementId)throw new Error('Fresh setup cannot overwrite a registered controller. Use its Edit action to preserve existing locations.');
      if(freshSetup && !['1','on',true].includes(input.fresh_setup_confirmed))throw new Error('Confirm that the saved LED setup on this ESP32 may be replaced.');
      const replacementController=replacementId?db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(replacementId):null;
      if(replacementId && !replacementController)throw new Error('Replacement controller no longer exists.');
      if(replacementId && !['1','on',true].includes(input.replacement_confirmed))throw new Error('Confirm the old controller is disconnected and the LED chain is unchanged.');
      const sourceProfile=replacementController?loadControllerProfile(db,replacementController):null;
      if(replacementController && !sourceProfile)throw new Error('No verified controller backup is saved. Connect the original board by USB and save its setup before replacement.');
      const maintenanceAction=String(input.maintenance_action||'auto');
      if(!['auto','update','replace'].includes(maintenanceAction))throw new Error('Choose Update firmware or Replace ESP32.');
      if(!replacementController&&maintenanceAction!=='auto')throw new Error('Choose an existing controller for maintenance.');
      const physicalCount=asPositiveInteger(input.module_count??input.moduleCount??sourceProfile?.physicalCount,'LED modules');
      const layoutChanged=!!sourceProfile&&physicalCount!==sourceProfile.physicalCount;
      if(layoutChanged&&!['1','on',true].includes(input.layout_change_confirmed))throw new Error('Confirm the new LED count and keep the saved LED order. Complete outstanding work before changing the layout.');
      if(layoutChanged)guardSetupChange(db);
      const replacementProfile=layoutChanged?resizedControllerProfile(db,replacementController,sourceProfile,physicalCount):sourceProfile;
      const moduleCount=replacementProfile?.logicalCount??physicalCount;
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
      if(!replacementController && !host.readChipIdentity && db.prepare('SELECT id FROM controllers WHERE device_identity=? AND active=1').get(deviceIdentity))throw new Error('This ESP32 is already registered here. Use Edit on its controller to keep the existing locations and LED mapping.');
      // A bridge serial is not a board identity. Explicit update can preserve
      // work, but the ROM identity and saved routing must verify before upload.
      const preserveExistingWork=!!replacementController&&!layoutChanged&&(maintenanceAction==='update'||sameBoard(replacementController,deviceIdentity)&&maintenanceAction==='auto'||input.keep_existing_work==='1');
      guardMaintenance(replacementController,deviceIdentity,preserveExistingWork);
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
        maintenanceAction,
        layoutChanged,
        sourceProfile,
        uploadStarted:false,
        freshSetup,
        sharedUsbConfirmed:['1','on',true].includes(input.shared_usb_confirmed),
        sameControllerUpdate:sameBoard(replacementController,deviceIdentity),
        preserveExistingWork,
        keepExistingWork:input.keep_existing_work==='1',
        previousProtocol:replacementController?.firmware_version,
        recoveringUpload:previousMaintenance?.uploadStarted===true&&previousMaintenance.controllerId===replacementId,
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
        db.prepare('INSERT INTO app_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`controller_replacement_pending:${replacementId}`,JSON.stringify({jobId:job.id,controllerId:replacementId,deviceIdentity:job.deviceIdentity,profile:replacementProfile,sourceProfile,uploadStarted:job.recoveringUpload,startedAt:job.startedAt}),nowIso());
      }
      acquireMaintenance(job.id,{controllerId:job.replacement&&!host.support().simulated?replacementId:null});
      jobs.set(job.id, job);
      // A storage failure while recording diagnostics must not turn a failed
      // hardware job into an unhandled rejection that exits the app service.
      runFlashJob(job).catch(error=>{job.status='failed';job.stage='failed';job.finishedAt=nowIso();job.error=`Controller update could not be saved: ${error.message}`;job.recoveryHint='Check free disk space and restart the app. Keep this ESP32 connected and retry this controller.';logger?.error?.('firmware.job.storage-failed',{jobId:job.id,error:error.message});});
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
      recoverInterruptedMaintenance();
      return publicJob(jobs.get(jobId))||parseMetadata(db.prepare('SELECT value FROM app_metadata WHERE key=?').get(`firmware_job:${jobId}`)?.value);
    },
  };
}
