import { accessSync, constants, openSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";

function stamp() {
  return new Date().toISOString();
}

function firmwareToken(value) {
  const cleaned = String(value)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll('"', "'");
  return `"${cleaned}"`;
}

function firmwareWord(value, fallback) {
  const word = String(value || fallback).trim().toLowerCase();
  return /^[a-z0-9#]+$/.test(word) ? word : fallback;
}

function firmwareAddress(value) {
  const address = String(value || "").trim();
  return /^[A-Za-z0-9._:-]+$/.test(address) ? address : "";
}

const LOCATE_TIMEOUT_MS = 120000;
const BLINK_TEST_DURATION_MS = 2250;
const DEFAULT_RS485_WRITE_REPEATS = 3;
const DEFAULT_RS485_WRITE_REPEAT_DELAY_MS = 90;
const DEFAULT_RS485_INTER_COMMAND_DELAY_MS = 35;
const DEFAULT_RS485_CLEAR_REPEATS = 5;
const HEARTBEAT_SYNC_INTERVAL_MS = 5000;
const HEARTBEAT_COLUMN_COUNT = 8;

function numberSetting(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function sleepMs(ms) {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createRs485Adapter({ config = {}, logger }) {
  const port = config.rs485SerialPort || process.env.RS485_SERIAL_PORT || "";
  const writeRepeats = numberSetting(
    config.rs485WriteRepeats || process.env.RS485_WRITE_REPEATS,
    DEFAULT_RS485_WRITE_REPEATS,
    { min: 1, max: 5 },
  );
  const writeRepeatDelayMs = numberSetting(
    config.rs485WriteRepeatDelayMs || process.env.RS485_WRITE_REPEAT_DELAY_MS,
    DEFAULT_RS485_WRITE_REPEAT_DELAY_MS,
    { min: 0, max: 500 },
  );
  const interCommandDelayMs = numberSetting(
    config.rs485InterCommandDelayMs || process.env.RS485_INTER_COMMAND_DELAY_MS,
    DEFAULT_RS485_INTER_COMMAND_DELAY_MS,
    { min: 0, max: 500 },
  );
  let configured = false;
  let portFd = null;
  let lastWriteAt = 0;
  let heartbeatSyncStarted = false;
  let heartbeatSyncTimer = null;
  const locateTimers = new Map();

  function controllerAddressFor(record = {}) {
    return record.controller_address || record.address || "";
  }

  function addressedCommand(controllerAddress, command) {
    const address = firmwareAddress(controllerAddress);
    return address ? `to ${address} ${command}` : command;
  }

  function ensureReady() {
    if (!port) {
      throw new Error("RS485_SERIAL_PORT is not configured.");
    }
    accessSync(port, constants.W_OK);
    if (!configured) {
      const result = spawnSync("stty", [
        "-F",
        port,
        "115200",
        "cs8",
        "-cstopb",
        "-parenb",
        "-ixon",
        "-ixoff",
        "raw",
        "-echo",
      ]);
      if (result.status !== 0) {
        throw new Error(`Could not configure RS485 serial port ${port}.`);
      }
      configured = true;
    }
    if (portFd === null) {
      portFd = openSync(port, "a");
    }
    startHeartbeatSync();
  }

  function send(command, options = {}) {
    ensureReady();
    const repeats = numberSetting(options.repeats, writeRepeats, { min: 1, max: 8 });
    try {
      const now = Date.now();
      const sinceLastWrite = now - lastWriteAt;
      if (lastWriteAt > 0 && sinceLastWrite < interCommandDelayMs) {
        sleepMs(interCommandDelayMs - sinceLastWrite);
      }

      for (let attempt = 1; attempt <= repeats; attempt += 1) {
        writeSync(portFd, `${command}\n`);
        lastWriteAt = Date.now();
        if (attempt < repeats) {
          sleepMs(writeRepeatDelayMs);
        }
      }
    } catch (error) {
      portFd = null;
      configured = false;
      throw error;
    }
    logger?.debug("hardware.rs485.write", {
      port,
      command,
      repeats,
      repeatDelayMs: writeRepeatDelayMs,
      interCommandDelayMs,
    });
  }

  function sendClear(hardwareChannel, controllerAddress = "") {
    send(addressedCommand(controllerAddress, `clear ${hardwareChannel}`), {
      repeats: Math.max(writeRepeats, DEFAULT_RS485_CLEAR_REPEATS),
    });
  }

  function heartbeatColumnForNow() {
    return Math.floor(Date.now() / HEARTBEAT_SYNC_INTERVAL_MS) % HEARTBEAT_COLUMN_COUNT;
  }

  function sendHeartbeatSync() {
    try {
      send(`sync-heartbeat ${heartbeatColumnForNow()}`, { repeats: 2 });
    } catch (error) {
      logger?.warn("hardware.rs485.heartbeat_sync_failed", {
        port,
        error: error.message,
      });
    }
  }

  function startHeartbeatSync() {
    if (heartbeatSyncStarted) {
      return;
    }
    heartbeatSyncStarted = true;
    const delay = Math.max(10, HEARTBEAT_SYNC_INTERVAL_MS - (Date.now() % HEARTBEAT_SYNC_INTERVAL_MS));
    heartbeatSyncTimer = setTimeout(() => {
      sendHeartbeatSync();
      heartbeatSyncTimer = setInterval(sendHeartbeatSync, HEARTBEAT_SYNC_INTERVAL_MS);
      heartbeatSyncTimer.unref?.();
    }, delay);
    heartbeatSyncTimer.unref?.();
  }

  function taskColor(task) {
    return task?.type === "put" ? "red" : "green";
  }

  function locateKey(hardwareChannel, controllerAddress = "") {
    return `${firmwareAddress(controllerAddress)}:${Number(hardwareChannel)}`;
  }

  function clearLocateTimer(hardwareChannel, controllerAddress = "") {
    const key = locateKey(hardwareChannel, controllerAddress);
    const locate = locateTimers.get(key);
    if (locate?.timeout) {
      clearTimeout(locate.timeout);
      locateTimers.delete(key);
    }
  }

  function clearAllLocateTimers(cells = []) {
    const locates = new Map(locateTimers);
    for (const cell of cells) {
      if (cell?.hardware_channel) {
        const controllerAddress = controllerAddressFor(cell);
        locates.set(locateKey(cell.hardware_channel, controllerAddress), {
          hardwareChannel: Number(cell.hardware_channel),
          controllerAddress,
          timeout: locateTimers.get(locateKey(cell.hardware_channel, controllerAddress))?.timeout || null,
        });
      }
    }
    for (const [key, locate] of locates) {
      if (locate?.timeout) {
        clearTimeout(locate.timeout);
      }
      locateTimers.delete(key);
      try {
        sendClear(locate.hardwareChannel, locate.controllerAddress);
      } catch (error) {
        logger?.warn("hardware.rs485.locate_clear_all_failed", {
          port,
          controllerAddress: locate.controllerAddress,
          hardwareChannel: locate.hardwareChannel,
          error: error.message,
        });
      }
    }
    return Array.from(locates.values()).map((locate) => ({
      controllerAddress: locate.controllerAddress,
      hardwareChannel: locate.hardwareChannel,
    }));
  }

  function scheduleLocateClear(cell) {
    const controllerAddress = controllerAddressFor(cell);
    clearLocateTimer(cell.hardware_channel, controllerAddress);
    const timeout = setTimeout(() => {
      locateTimers.delete(locateKey(cell.hardware_channel, controllerAddress));
      try {
        sendClear(cell.hardware_channel, controllerAddress);
      } catch (error) {
        logger?.warn("hardware.rs485.locate_timeout_clear_failed", {
          port,
          controllerAddress,
          hardwareChannel: cell.hardware_channel,
          error: error.message,
        });
      }
    }, LOCATE_TIMEOUT_MS);
    timeout.unref?.();
    locateTimers.set(locateKey(cell.hardware_channel, controllerAddress), {
      timeout,
      controllerAddress,
      hardwareChannel: Number(cell.hardware_channel),
    });
  }

  function event({ controllerId = null, cellId = null, taskId = null, eventType, payload }) {
    return {
      controllerId,
      cellId,
      taskId,
      eventType,
      payload: {
        ts: stamp(),
        port,
        ...payload,
      },
      status: "ok",
    };
  }

  return {
    name: "rs485",
    healthCheck() {
      try {
        ensureReady();
        return {
          status: "healthy",
          message: `RS485 serial port active at ${port}.`,
        };
      } catch (error) {
        return {
          status: "degraded",
          message: error.message,
        };
      }
    },
    activateGuidance(task, lines) {
      const events = [];
      for (const line of lines) {
        const text = String(line.planned_quantity ?? "");
        const color = taskColor(task);
        const controllerAddress = controllerAddressFor(line);
        const command = addressedCommand(
          controllerAddress,
          `digit ${line.hardware_channel} ${firmwareToken(text)} ${color} 120 80`,
        );
        clearLocateTimer(line.hardware_channel, controllerAddress);
        send(command);
        events.push(
          event({
            controllerId: line.controller_id,
            cellId: line.cell_id,
            taskId: task.id,
            eventType: "guidance_activated",
            payload: {
              type: "task-module",
              command,
              hardwareChannel: line.hardware_channel,
              controllerAddress,
              cell: line.logical_code,
              taskType: task.type,
              quantity: line.planned_quantity,
              color,
            },
          }),
        );
      }
      return { ok: true, degraded: false, events };
    },
    clearGuidance(task, lines) {
      const events = [];
      for (const line of lines) {
        const controllerAddress = controllerAddressFor(line);
        const command = addressedCommand(controllerAddress, `clear ${line.hardware_channel}`);
        clearLocateTimer(line.hardware_channel, controllerAddress);
        send(command, { repeats: Math.max(writeRepeats, DEFAULT_RS485_CLEAR_REPEATS) });
        events.push(
          event({
            controllerId: line.controller_id,
            cellId: line.cell_id,
            taskId: task.id,
            eventType: "guidance_cleared",
            payload: {
              type: "clear-module",
              command,
              hardwareChannel: line.hardware_channel,
              controllerAddress,
              cell: line.logical_code,
            },
          }),
        );
      }
      return { ok: true, degraded: false, events };
    },
    sendControllerTest(controller) {
      const controllerAddress = controllerAddressFor(controller);
      const command = addressedCommand(controllerAddress, "ping");
      send(command);
      return {
        ok: true,
        degraded: false,
        events: [
          event({
            controllerId: controller.id,
            eventType: "controller_test",
            payload: {
              type: "controller-test",
              command,
              controllerAddress,
              controllerCode: controller.controller_code,
            },
          }),
        ],
      };
    },
    sendCellTest(cell, color = "green") {
      const controllerAddress = controllerAddressFor(cell);
      const command = addressedCommand(
        controllerAddress,
        `blink ${cell.hardware_channel} ${firmwareWord(color, "green")} 80 ${BLINK_TEST_DURATION_MS}`,
      );
      clearLocateTimer(cell.hardware_channel, controllerAddress);
      send(command);
      return {
        ok: true,
        degraded: false,
        events: [
          event({
            controllerId: cell.controller_id,
            cellId: cell.id,
            eventType: "cell_test",
            payload: {
              type: "module-blink-test",
              command,
              hardwareChannel: cell.hardware_channel,
              controllerAddress,
              color,
            },
          }),
        ],
      };
    },
    setCellLocate(cell, active = true) {
      const controllerAddress = controllerAddressFor(cell);
      const command = active
        ? addressedCommand(controllerAddress, `locate ${cell.hardware_channel} red 80 ${LOCATE_TIMEOUT_MS}`)
        : addressedCommand(controllerAddress, `clear ${cell.hardware_channel}`);
      clearLocateTimer(cell.hardware_channel, controllerAddress);
      if (active) {
        send(command);
      } else {
        send(command, { repeats: Math.max(writeRepeats, DEFAULT_RS485_CLEAR_REPEATS) });
      }
      if (active) {
        scheduleLocateClear(cell);
      }
      return {
        ok: true,
        degraded: false,
        events: [
          event({
            controllerId: cell.controller_id,
            cellId: cell.id,
            eventType: active ? "cell_locate_started" : "cell_locate_cleared",
            payload: {
              type: "cell-locate",
              command,
              active,
              hardwareChannel: cell.hardware_channel,
              controllerAddress,
              color: "red",
              timeoutMs: LOCATE_TIMEOUT_MS,
            },
          }),
        ],
      };
    },
    clearAllCellLocates(cells = []) {
      const channels = clearAllLocateTimers(cells);
      return {
        ok: true,
        degraded: false,
        events: [
          event({
            eventType: "cell_locate_cleared_all",
            payload: {
              type: "cell-locate-clear-all",
              hardwareChannels: channels,
            },
          }),
        ],
      };
    },
    recordPhysicalConfirmation(eventPayload) {
      return {
        ok: true,
        degraded: false,
        events: [
          event({
            controllerId: eventPayload.controller_id,
            cellId: eventPayload.cell_id,
            taskId: eventPayload.task_id,
            eventType: "physical_confirmation_recorded",
            payload: {
              type: "button-press-unavailable",
              hardwareChannel: eventPayload.hardware_channel,
            },
          }),
        ],
      };
    },
  };
}
