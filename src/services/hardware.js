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
          let unboundSetup=false;
          if(aliases===0&&context.source==='display_coordinator') {
            const request=db.prepare("SELECT * FROM display_requests WHERE id=? AND actor_id=? AND state IN ('active','expiring')").get(context.displayId,context.displayActor);
            const scope=request?JSON.parse(request.scope_json):{};
            const controller=scope.controllerTest?db.prepare('SELECT * FROM controllers WHERE id=? AND active=1').get(scope.controllerTest):null;
            const setup=scope.setupSession?db.prepare('SELECT * FROM location_setup_sessions WHERE id=? AND actor_id=?').get(scope.setupSession,context.displayActor):null;
            // Only the selected output from an authenticated setup receipt may address an unbound light.
            unboundSetup=!!controller&&controller.id===target.controller_id&&ch<=controller.module_count&&scope.controllerRevision===JSON.stringify([controller.address,controller.module_count,controller.configured_at]);
            unboundSetup=unboundSetup||!!setup&&setup.controller_id===target.controller_id&&
              JSON.parse(request.targets_json).some(t=>t.channel===ch&&t.controllerId===target.controller_id)&&
              (operationName==='cell_quantity_clear'||(setup.status==='active'&&setup.output===ch&&setup.generation===scope.setupGeneration));
          }
          if(!Number.isInteger(ch)||ch<1||ch>255||(aliases!==1&&!unboundSetup))return {ok:false,degraded:true,message:"Physical mapping is ambiguous or invalid. Follow phone instructions manually and correct the mapping after work settles.",events:[]};
        }

        if(context.source==='display_coordinator') {
          const display=db.prepare("SELECT * FROM display_requests WHERE id=? AND actor_id=? AND state IN ('active','expiring')").get(context.displayId,context.displayActor);
          if(!display)return {ok:false,degraded:true,message:'Superseded display request ignored.',events:[]};
          for(const target of targets){const owned=JSON.parse(display.targets_json).find(t=>t.controllerId===target.controller_id&&t.channel===target.hardware_channel);const work=db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(target.id||null)?.generation||null;if(!owned||owned.workGeneration!==work)return {ok:false,degraded:true,message:'Newer task guidance is protected.',events:[]};}
          if(db.prepare("SELECT 1 FROM task_lines WHERE execution_state='working' LIMIT 1").get())return {ok:false,degraded:true,message:'Task guidance is active.',events:[]};
        } else if(context.source==="work_coordinator") {
          const desired=db.prepare("SELECT generation FROM work_guidance WHERE cell_id=?").get(context.workCellId);
          if(!desired || desired.generation!==context.workGeneration) return {ok:false,degraded:true,message:"Superseded guidance ignored.",events:[]};
        } else if(db.prepare("SELECT 1 FROM task_lines WHERE execution_state='working' LIMIT 1").get() || db.prepare("SELECT 1 FROM display_requests WHERE state IN ('active','expiring') LIMIT 1").get()) {
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
