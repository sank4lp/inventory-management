import { resolveLedBrightness } from "../hardware-brightness.js";

function stamp() {
  return new Date().toISOString();
}

function emit(event) {
  process.stdout.write(`[RS485-SIM] ${JSON.stringify(event)}\n`);
}

export function createSimulatorAdapter({ config = {}, logger }) {
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

  function wrap(events) {
    return {
      ok: true,
      degraded: events.some((event) => event.status === "degraded"),
      events,
    };
  }

  function hasModuleTarget(record = {}) {
    return Boolean(record.controller_id) && Boolean(record.hardware_channel);
  }

  function guidanceColor(task, line = {}) {
    return line.guidance_color || (task.type === "put" ? "red" : "green");
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
      const events = lines.map((line) => {
        const color = guidanceColor(task, line);
        const brightness = brightnessPayload();
        if (!hasModuleTarget(line)) {
          const payload = {
            ts: stamp(),
            type: "manual-guidance",
            controllerId: line.controller_id,
            cell: line.logical_code,
            taskId: task.id,
            taskType: task.type,
            quantity: line.planned_quantity,
            color,
            ...brightness,
            reason: "cell-not-mapped-to-controller",
          };
          emit(payload);
          return {
            controllerId: line.controller_id,
            cellId: line.cell_id,
            taskId: task.id,
            eventType: "guidance_manual",
            payload,
            status: "degraded",
          };
        }
        const payload = {
          ts: stamp(),
          type: "set-cell-state",
          controllerId: line.controller_id,
          cell: line.logical_code,
          hardwareChannel: line.hardware_channel,
          color,
          ...brightness,
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
        if (!hasModuleTarget(line)) {
          const payload = {
            ts: stamp(),
            type: "manual-guidance-clear",
            controllerId: line.controller_id,
            cell: line.logical_code,
            taskId: task.id,
            reason: "cell-not-mapped-to-controller",
          };
          emit(payload);
          return {
            controllerId: line.controller_id,
            cellId: line.cell_id,
            taskId: task.id,
            eventType: "guidance_manual_clear",
            payload,
            status: "degraded",
          };
        }
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
    checkControllerHealth(controller) {
      const payload = {
        ts: stamp(),
        type: "controller-health",
        controllerId: controller.id,
        controllerCode: controller.controller_code,
        controllerAddress: controller.address,
        status: "online",
      };
      emit(payload);
      return {
        ok: true,
        degraded: false,
        status: "online",
        message: `${controller.controller_code} responded in simulator.`,
        events: [
          {
            controllerId: controller.id,
            eventType: "controller_health_check",
            payload,
            status: "ok",
          },
        ],
      };
    },
    sendCellTest(cell, color = "amber") {
      const brightness = brightnessPayload();
      if (!hasModuleTarget(cell)) {
        const payload = {
          ts: stamp(),
          type: "manual-guidance",
          controllerId: cell.controller_id,
          cell: cell.logical_code,
          color,
          ...brightness,
          reason: "cell-not-mapped-to-controller",
        };
        emit(payload);
        return {
          ok: true,
          degraded: true,
          message: `${cell.logical_code} is not mapped to a controller.`,
          events: [
            {
              controllerId: cell.controller_id,
              cellId: cell.id,
              eventType: "cell_test_manual",
              payload,
              status: "degraded",
            },
          ],
        };
      }
      const payload = {
        ts: stamp(),
        type: "cell-test",
        controllerId: cell.controller_id,
        cell: cell.logical_code,
        hardwareChannel: cell.hardware_channel,
        color,
        ...brightness,
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
      const brightness = brightnessPayload();
      if (!hasModuleTarget(cell)) {
        const payload = {
          ts: stamp(),
          type: "manual-guidance",
          controllerId: cell.controller_id,
          cell: cell.logical_code,
          color: "red",
          active,
          ...brightness,
          reason: "cell-not-mapped-to-controller",
        };
        emit(payload);
        return {
          ok: true,
          degraded: true,
          message: `${cell.logical_code} is not mapped to a controller.`,
          events: [
            {
              controllerId: cell.controller_id,
              cellId: cell.id,
              eventType: active ? "cell_locate_manual" : "cell_locate_manual_clear",
              payload,
              status: "degraded",
            },
          ],
        };
      }
      const payload = {
        ts: stamp(),
        type: "cell-locate",
        controllerId: cell.controller_id,
        cell: cell.logical_code,
        hardwareChannel: cell.hardware_channel,
        color: "red",
        active,
        ...brightness,
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
    clearAllCellLocates(cells = []) {
      const payload = {
        ts: stamp(),
        type: "cell-locate-clear-all",
        hardwareChannels: cells.map((cell) => cell.hardware_channel).filter(Boolean),
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
