import {activeWorkGuidance,displayOwner,guidanceBinding} from '../modules/operations/guidance.js';
import { createDegradedAdapter } from "./hardware-adapters/degraded.js";
import { createRs485Adapter } from "./hardware-adapters/rs485.js";
import { createSimulatorAdapter } from "./hardware-adapters/simulator.js";
import { updateControllerHealth } from "./inventory.js";

const RECONNECT_COOLDOWN_MS = 10000;
const RECONNECT_PROBE_TIMEOUT_MS = 2000;

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

export function createHardwareService({ db, config, logger, clock = () => new Date() }) {
  const adapter = adapterFactory(config, logger);
  let disposed=false;
  const controllerProbes = new Map();
  const controllerIdentity = controller => JSON.stringify([controller.address, controller.configured_at]);

  function checkControllerHealth(controller, options = {}) {
    const result = run("controller_health", adapter.checkControllerHealth.bind(adapter), [controller, options], {
      controllerId: controller.id,
    });
    controllerProbes.set(Number(controller.id), { identity: controllerIdentity(controller), at: clock().getTime(), result });
    return result;
  }

  function ensureControllerReady(controllerId) {
    const controller = db.prepare('SELECT * FROM controllers WHERE id=?').get(Number(controllerId));
    if (!controller || !controller.active || disposed) return {ok:false,degraded:true,status:'offline',message:'Controller is unavailable. Check its power and connection.'};
    if (controller.heartbeat_status === 'online') return {ok:true,degraded:false,status:'online'};
    const previous = controllerProbes.get(Number(controller.id));
    const elapsed = previous ? clock().getTime() - previous.at : Infinity;
    let result = previous?.result;
    if (!previous || previous.identity !== controllerIdentity(controller) || elapsed < 0 || elapsed >= RECONNECT_COOLDOWN_MS) {
      result = checkControllerHealth(controller, {timeoutMs:RECONNECT_PROBE_TIMEOUT_MS});
    }
    const online = result.ok && !result.degraded && result.status === 'online';
    updateControllerHealth(db, {controllerId:controller.id,status:online?'online':'offline'});
    return online ? result : {...result,ok:false,degraded:true,status:'offline',message:`Controller ${controller.controller_code} is offline. Check its power and connection, then try again.`};
  }

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

  function targetCellId(t){return db.prepare('SELECT c.id FROM cells c JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE ctrl.address=(SELECT address FROM controllers WHERE id=?) AND c.hardware_channel=?').get(t.controller_id,t.hardware_channel)?.id??t.cell_id??t.id??-1;}
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
          const scope=JSON.parse(display.scope_json);
          if(targets.some(t=>activeWorkGuidance(db,targetCellId(t))&&!(['quantity','capacity_total','capacity_available','cell_name','module_number','locate','ping'].includes(scope.kind)&&scope.overrideWork===true&&displayOwner(db,targetCellId(t))?.kind==='task')))return {ok:false,degraded:true,message:'Task or stocktake guidance is active.',events:[]};
        } else if(context.source==="work_coordinator") {
          const desired=db.prepare("SELECT generation FROM work_guidance WHERE cell_id=?").get(context.workCellId);
          if(!desired || desired.generation!==context.workGeneration || context.workBinding&&context.workBinding!==guidanceBinding(db,context.workCellId)) return {ok:false,degraded:true,message:"Superseded guidance ignored.",events:[]};
          const bound=db.prepare('SELECT c.id,c.controller_id,c.hardware_channel,ctrl.address FROM cells c LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?').get(context.workCellId);
          if(!bound||targets.some(t=>(t.cell_id??t.id)!==bound.id||t.controller_id!==bound.controller_id||t.hardware_channel!==bound.hardware_channel||t.controller_address!==bound.address))return {ok:false,degraded:true,message:'Changed guidance mapping ignored.',events:[]};
        } else if(targets.length?targets.some(t=>activeWorkGuidance(db,targetCellId(t))||db.prepare("SELECT 1 FROM display_requests d,json_each(d.targets_json) v WHERE d.state IN ('active','expiring') AND json_extract(v.value,'$.status')='sent' AND json_extract(v.value,'$.controllerId')=? AND json_extract(v.value,'$.channel')=?").get(t.controller_id,t.hardware_channel)):(activeWorkGuidance(db)||db.prepare("SELECT 1 FROM display_requests WHERE state IN ('active','expiring')").get())) {
          return {ok:false,degraded:true,message:"Location work is active. Utility displays and tests are paused until active turns settle.",events:[]};
        }
      }

      if (operationName !== 'controller_health' && adapter.name !== 'degraded') {
        // Share one recovery check across every output of the same controller.
        const controllerIds = new Set(args.flat().filter(value => value && typeof value === 'object' && 'hardware_channel' in value).map(value => value.controller_id).filter(Boolean));
        if (operationName === 'controller_test' && args[0]?.id) controllerIds.add(args[0].id);
        for (const controllerId of controllerIds) {
          const ready = ensureControllerReady(controllerId);
          if (!ready.ok || ready.degraded) return ready;
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
    checkControllerHealth,
    ensureControllerReady,
    sendCellTest(cell, color = "green", context = {}) {
      return run("cell_test", adapter.sendCellTest.bind(adapter), [cell, color], {
        cellId: cell.id,
        controllerId: cell.controller_id,
        color,
        ...context,
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
    setCellLocate(cell, active = true, context = {}) {
      return run("cell_locate", adapter.setCellLocate.bind(adapter), [cell, active, {managed:context.source==='display_coordinator'}], {
        cellId: cell.id,
        controllerId: cell.controller_id,
        active,
        ...context,
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
