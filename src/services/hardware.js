import { createDegradedAdapter } from "./hardware-adapters/degraded.js";
import { createRs485Adapter } from "./hardware-adapters/rs485.js";
import { createSimulatorAdapter } from "./hardware-adapters/simulator.js";

function nowIso() {
  return new Date().toISOString();
}

function adapterFactory(config, logger) {
  if (config.hardwareAdapter === "degraded") {
    return createDegradedAdapter({ config, logger });
  }
  if (config.hardwareAdapter === "rs485") {
    return createRs485Adapter({ config, logger });
  }
  return createSimulatorAdapter({ config, logger });
}

function normalizeResult(result = {}) {
  return {
    ok: result.ok !== false,
    degraded: result.degraded === true,
    status: result.status || null,
    message: result.message || null,
    events: Array.isArray(result.events) ? result.events : [],
  };
}

export function createHardwareService({ db, config, logger }) {
  const adapter = adapterFactory(config, logger);

  function saveDeviceEvent(event) {
    db.prepare(
      `
        INSERT INTO device_events (controller_id, cell_id, task_id, event_type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      event.controllerId ?? null,
      event.cellId ?? null,
      event.taskId ?? null,
      event.eventType,
      JSON.stringify({
        status: event.status || "ok",
        adapter: adapter.name,
        ...event.payload,
      }),
      nowIso(),
    );
  }

  function run(operationName, fn, args = [], context = {}) {
    try {
      const result = normalizeResult(fn(...args));
      for (const event of result.events) {
        saveDeviceEvent(event);
      }
      if (result.degraded) {
        logger.warn(`hardware.${operationName}.degraded`, {
          adapter: adapter.name,
          ...context,
          message: result.message,
        });
      } else {
        logger.info(`hardware.${operationName}.ok`, {
          adapter: adapter.name,
          ...context,
        });
      }
      return result;
    } catch (error) {
      saveDeviceEvent({
        eventType: `${operationName}_failed`,
        payload: {
          error: error.message,
          context,
        },
        status: "error",
      });
      logger.error(`hardware.${operationName}.failed`, {
        adapter: adapter.name,
        ...context,
        error: error.message,
      });
      return {
        ok: false,
        degraded: true,
        message: "Hardware command failed. Manual guidance mode is recommended.",
        events: [],
      };
    }
  }

  return {
    adapterName: adapter.name,
    healthCheck() {
      return adapter.healthCheck();
    },
    activateGuidance(task, lines, context = {}) {
      return run("activate_guidance", adapter.activateGuidance.bind(adapter), [task, lines], {
        taskId: task.id,
        lineCount: lines.length,
        ...context,
      });
    },
    clearGuidance(task, lines, context = {}) {
      return run("clear_guidance", adapter.clearGuidance.bind(adapter), [task, lines], {
        taskId: task.id,
        lineCount: lines.length,
        ...context,
      });
    },
    sendControllerTest(controller) {
      return run("controller_test", adapter.sendControllerTest.bind(adapter), [controller], {
        controllerId: controller.id,
      });
    },
    checkControllerHealth(controller) {
      return run("controller_health", adapter.checkControllerHealth.bind(adapter), [controller], {
        controllerId: controller.id,
      });
    },
    sendCellTest(cell, color = "amber") {
      return run("cell_test", adapter.sendCellTest.bind(adapter), [cell, color], {
        cellId: cell.id,
        controllerId: cell.controller_id,
        color,
      });
    },
    setCellLocate(cell, active = true) {
      return run("cell_locate", adapter.setCellLocate.bind(adapter), [cell, active], {
        cellId: cell.id,
        controllerId: cell.controller_id,
        active,
      });
    },
    clearAllCellLocates(cells = []) {
      return run("cell_locate_clear_all", adapter.clearAllCellLocates.bind(adapter), [cells], {
        cellCount: cells.length,
      });
    },
    recordPhysicalConfirmation(event, userId = null) {
      return run(
        "physical_confirmation",
        adapter.recordPhysicalConfirmation.bind(adapter),
        [event],
        {
          taskId: event.task_id,
          cellId: event.cell_id,
          lineId: event.id,
          userId,
        },
      );
    },
  };
}
