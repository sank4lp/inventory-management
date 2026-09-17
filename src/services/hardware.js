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
  let disposed=false;

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
      if(disposed) return {ok:false,degraded:true,message:"Hardware service was replaced.",events:[]};
      if(operationName!=="controller_health") {
        const targets=args.flat().filter(v=>v&&typeof v==='object'&&('hardware_channel' in v));
        for(const target of targets) {
          if(!target.controller_id||!target.hardware_channel)continue;
          const ch=Number(target.hardware_channel);
          const aliases=db.prepare("SELECT COUNT(*) n FROM cells c JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE ctrl.address=(SELECT address FROM controllers WHERE id=?) AND c.hardware_channel=?").get(target.controller_id,ch).n;
          if(!Number.isInteger(ch)||ch<1||ch>255||aliases!==1)return {ok:false,degraded:true,message:"Physical mapping is ambiguous or invalid. Follow phone instructions manually and correct the mapping after work settles.",events:[]};
        }

        if(context.source==="work_coordinator") {
          const desired=db.prepare("SELECT generation FROM work_guidance WHERE cell_id=?").get(context.workCellId);
          if(!desired || desired.generation!==context.workGeneration) return {ok:false,degraded:true,message:"Superseded guidance ignored.",events:[]};
        } else if(db.prepare("SELECT 1 FROM task_lines WHERE execution_state='working' LIMIT 1").get()) {
          return {ok:false,degraded:true,message:"Location work is active. Utility displays and tests are paused until active turns settle.",events:[]};
        }
      }

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
      try { saveDeviceEvent({
        eventType: `${operationName}_failed`,
        payload: {
          error: error.message,
          context,
        },
        status: "error",
      }); } catch { /* Evidence logging must not turn a committed stock receipt into a failure. */ }
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
    dispose() { disposed=true; adapter.dispose?.(); },
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
    showCellQuantity(cell, quantity, color = "yellow", context = {}) {
      return run(
        "cell_quantity_display",
        adapter.showCellQuantity.bind(adapter),
        [cell, quantity, color],
        {
          cellId: cell.id,
          controllerId: cell.controller_id,
          quantity,
          color,
          ...context,
        },
      );
    },
    clearCellQuantity(cell, context = {}) {
      return run(
        "cell_quantity_clear",
        adapter.clearCellQuantity.bind(adapter),
        [cell],
        {
          cellId: cell.id,
          controllerId: cell.controller_id,
          ...context,
        },
      );
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
