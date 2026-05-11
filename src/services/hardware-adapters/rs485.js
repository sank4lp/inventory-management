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

const LOCATE_TIMEOUT_MS = 120000;

export function createRs485Adapter({ config = {}, logger }) {
  const port = config.rs485SerialPort || process.env.RS485_SERIAL_PORT || "";
  let configured = false;
  let portFd = null;
  const locateTimers = new Map();

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
  }

  function send(command) {
    ensureReady();
    try {
      writeSync(portFd, `${command}\n`);
    } catch (error) {
      portFd = null;
      configured = false;
      throw error;
    }
    logger?.debug("hardware.rs485.write", {
      port,
      command,
    });
  }

  function taskColor(task) {
    return task?.type === "put" ? "red" : "green";
  }

  function clearLocateTimer(hardwareChannel) {
    const key = Number(hardwareChannel);
    const timeout = locateTimers.get(key);
    if (timeout) {
      clearTimeout(timeout);
      locateTimers.delete(key);
    }
  }

  function scheduleLocateClear(cell) {
    clearLocateTimer(cell.hardware_channel);
    const timeout = setTimeout(() => {
      locateTimers.delete(Number(cell.hardware_channel));
      try {
        send(`clear ${cell.hardware_channel}`);
      } catch (error) {
        logger?.warn("hardware.rs485.locate_timeout_clear_failed", {
          port,
          hardwareChannel: cell.hardware_channel,
          error: error.message,
        });
      }
    }, LOCATE_TIMEOUT_MS);
    timeout.unref?.();
    locateTimers.set(Number(cell.hardware_channel), timeout);
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
        const command = `digit ${line.hardware_channel} ${firmwareToken(text)} ${color} 120 80`;
        clearLocateTimer(line.hardware_channel);
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
              cell: line.logical_code,
              taskType: task.type,
              quantity: line.planned_quantity,
              color,
              statusRow: color,
            },
          }),
        );
      }
      return { ok: true, degraded: false, events };
    },
    clearGuidance(task, lines) {
      const events = [];
      for (const line of lines) {
        const command = `clear ${line.hardware_channel}`;
        clearLocateTimer(line.hardware_channel);
        send(command);
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
              cell: line.logical_code,
            },
          }),
        );
      }
      return { ok: true, degraded: false, events };
    },
    sendControllerTest(controller) {
      const command = "ping";
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
              controllerCode: controller.controller_code,
            },
          }),
        ],
      };
    },
    sendCellTest(cell, color = "green") {
      const command = `blink ${cell.hardware_channel} ${firmwareWord(color, "green")} 80 2000`;
      clearLocateTimer(cell.hardware_channel);
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
              color,
            },
          }),
        ],
      };
    },
    setCellLocate(cell, active = true) {
      const command = active
        ? `fill ${cell.hardware_channel} red 80`
        : `clear ${cell.hardware_channel}`;
      clearLocateTimer(cell.hardware_channel);
      send(command);
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
              color: "red",
              timeoutMs: LOCATE_TIMEOUT_MS,
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
