function stamp() {
  return new Date().toISOString();
}

function emit(event) {
  process.stdout.write(`[RS485-SIM] ${JSON.stringify(event)}\n`);
}

export function createSimulatorAdapter({ logger }) {
  function wrap(events) {
    return {
      ok: true,
      degraded: false,
      events,
    };
  }

  return {
    name: "simulator",
    healthCheck() {
      return {
        status: "healthy",
        message: "RS485 simulator active.",
      };
    },
    activateGuidance(task, lines) {
      const color = task.type === "put" ? "red" : "green";
      const events = lines.map((line) => {
        const payload = {
          ts: stamp(),
          type: "set-cell-state",
          controllerId: line.controller_id,
          cell: line.logical_code,
          hardwareChannel: line.hardware_channel,
          color,
          statusRow: color,
          taskId: task.id,
          taskType: task.type,
          quantity: line.planned_quantity,
        };
        emit(payload);
        return {
          controllerId: line.controller_id,
          cellId: line.cell_id,
          taskId: task.id,
          eventType: "guidance_activated",
          payload,
          status: "ok",
        };
      });
      logger.debug("hardware.guidance.activate", {
        adapter: "simulator",
        taskId: task.id,
        lineCount: lines.length,
      });
      return wrap(events);
    },
    clearGuidance(task, lines) {
      const events = lines.map((line) => {
        const payload = {
          ts: stamp(),
          type: "clear-cell-state",
          controllerId: line.controller_id,
          cell: line.logical_code,
          hardwareChannel: line.hardware_channel,
          taskId: task.id,
        };
        emit(payload);
        return {
          controllerId: line.controller_id,
          cellId: line.cell_id,
          taskId: task.id,
          eventType: "guidance_cleared",
          payload,
          status: "ok",
        };
      });
      logger.debug("hardware.guidance.clear", {
        adapter: "simulator",
        taskId: task.id,
        lineCount: lines.length,
      });
      return wrap(events);
    },
    sendControllerTest(controller) {
      const payload = {
        ts: stamp(),
        type: "controller-test",
        controllerId: controller.id,
        controllerCode: controller.controller_code,
        address: controller.address,
      };
      emit(payload);
      return wrap([
        {
          controllerId: controller.id,
          eventType: "controller_test",
          payload,
          status: "ok",
        },
      ]);
    },
    sendCellTest(cell, color = "amber") {
      const payload = {
        ts: stamp(),
        type: "cell-test",
        controllerId: cell.controller_id,
        cell: cell.logical_code,
        hardwareChannel: cell.hardware_channel,
        color,
      };
      emit(payload);
      return wrap([
        {
          controllerId: cell.controller_id,
          cellId: cell.id,
          eventType: "cell_test",
          payload,
          status: "ok",
        },
      ]);
    },
    setCellLocate(cell, active = true) {
      const payload = {
        ts: stamp(),
        type: "cell-locate",
        controllerId: cell.controller_id,
        cell: cell.logical_code,
        hardwareChannel: cell.hardware_channel,
        color: "red",
        active,
        timeoutMs: 120000,
      };
      emit(payload);
      return wrap([
        {
          controllerId: cell.controller_id,
          cellId: cell.id,
          eventType: active ? "cell_locate_started" : "cell_locate_cleared",
          payload,
          status: "ok",
        },
      ]);
    },
    clearAllCellLocates() {
      const payload = {
        ts: stamp(),
        type: "cell-locate-clear-all",
      };
      emit(payload);
      return wrap([
        {
          eventType: "cell_locate_cleared_all",
          payload,
          status: "ok",
        },
      ]);
    },
    recordPhysicalConfirmation(event) {
      const payload = {
        ts: stamp(),
        type: "button-press",
        controllerId: event.controller_id,
        cell: event.logical_code,
        hardwareChannel: event.hardware_channel,
        taskId: event.task_id,
        lineId: event.id,
      };
      emit(payload);
      return wrap([
        {
          controllerId: event.controller_id,
          cellId: event.cell_id,
          taskId: event.task_id,
          eventType: "button_press",
          payload,
          status: "ok",
        },
      ]);
    },
  };
}
