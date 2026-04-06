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

export function createDegradedAdapter() {
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
    sendCellTest(cell, color = "amber") {
      return skipped("cell_test_skipped", {
        controllerId: cell.controller_id,
        cellId: cell.id,
        payload: { color },
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
