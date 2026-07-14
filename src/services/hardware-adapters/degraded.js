import { resolveLedBrightness } from "../hardware-brightness.js";

function stamp() {
  return new Date().toISOString();
}

function createSkippedEvent({ controllerId = null, cellId = null, taskId = null, eventType, payload }) {
  return {
    controllerId,
    cellId,
    taskId,
    eventType,
    payload,
    status: "degraded",
  };
}

export function createDegradedAdapter({ config = {} } = {}) {
  const now = typeof config.ledBrightnessClock === "function"
    ? config.ledBrightnessClock
    : () => new Date();

  function brightnessPayload() {
    const policy = resolveLedBrightness(config, now());
    return {
      brightnessPercent: policy.brightnessPercent,
      brightnessMode: policy.mode,
    };
  }

  function skipped(operation, extra = {}) {
    return {
      ok: false,
      degraded: true,
      message: "Hardware adapter unavailable. Manual guidance mode is active.",
      events: [
        createSkippedEvent({
          controllerId: extra.controllerId ?? null,
          cellId: extra.cellId ?? null,
          taskId: extra.taskId ?? null,
          eventType: operation,
          payload: {
            ts: stamp(),
            type: operation,
            mode: "manual-guidance",
            ...extra.payload,
          },
        }),
      ],
    };
  }

  return {
    name: "degraded",
    healthCheck() {
      return {
        status: "degraded",
        message: "Running in manual guidance mode.",
      };
    },
    activateGuidance(task) {
      return skipped("guidance_skipped", { taskId: task.id });
    },
    clearGuidance(task) {
      return skipped("guidance_clear_skipped", { taskId: task.id });
    },
    sendControllerTest(controller) {
      return skipped("controller_test_skipped", { controllerId: controller.id });
    },
    checkControllerHealth(controller) {
      return {
        ...skipped("controller_health_skipped", { controllerId: controller.id }),
        status: "unknown",
      };
    },
    sendCellTest(cell, color = "amber") {
      return skipped("cell_test_skipped", {
        controllerId: cell.controller_id,
        cellId: cell.id,
        payload: { color, ...brightnessPayload() },
      });
    },
    showCellQuantity(cell, quantity, color = "yellow") {
      return skipped("cell_quantity_display_skipped", {
        controllerId: cell.controller_id,
        cellId: cell.id,
        payload: { quantity, color, ...brightnessPayload() },
      });
    },
    setCellLocate(cell, active = true) {
      return skipped("cell_locate_skipped", {
        controllerId: cell.controller_id,
        cellId: cell.id,
        payload: {
          color: "red",
          active,
          ...brightnessPayload(),
        },
      });
    },
    clearAllCellLocates() {
      return skipped("cell_locate_clear_all_skipped", {
        payload: {},
      });
    },
    recordPhysicalConfirmation(event) {
      return skipped("physical_confirmation_recorded", {
        controllerId: event.controller_id,
        cellId: event.cell_id,
        taskId: event.task_id,
      });
    },
  };
}
