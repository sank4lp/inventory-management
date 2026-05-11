import { appendFileSync, accessSync, constants } from "node:fs";
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

export function createRs485Adapter({ config = {}, logger }) {
  const port = config.rs485SerialPort || process.env.RS485_SERIAL_PORT || "";
  let configured = false;

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
      ]);
      if (result.status !== 0) {
        throw new Error(`Could not configure RS485 serial port ${port}.`);
      }
      configured = true;
    }
  }

  function send(command) {
    ensureReady();
    appendFileSync(port, `${command}\n`);
    logger?.debug("hardware.rs485.write", {
      port,
      command,
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
        const command = `${line.hardware_channel} ${firmwareToken(text)} ${firmwareWord(line.guidance_color, "green")}`;
        send(command);
        events.push(
          event({
            controllerId: line.controller_id,
            cellId: line.cell_id,
            taskId: task.id,
            eventType: "guidance_activated",
            payload: {
              type: "display-module",
              command,
              hardwareChannel: line.hardware_channel,
              cell: line.logical_code,
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
      const command = `blink ${cell.hardware_channel} ${firmwareWord(color, "green")} 80 1200`;
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
