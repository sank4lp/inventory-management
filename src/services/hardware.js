function stamp() {
  return new Date().toISOString();
}

function emit(event) {
  process.stdout.write(`[RS485-SIM] ${JSON.stringify(event)}\n`);
}

function saveDeviceEvent(db, params) {
  db.prepare(
    `
      INSERT INTO device_events (controller_id, cell_id, task_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    params.controllerId ?? null,
    params.cellId ?? null,
    params.taskId ?? null,
    params.eventType,
    JSON.stringify(params.payload),
    stamp(),
  );
}

export function activateGuidance(db, task, lines) {
  for (const line of lines) {
    const event = {
      ts: stamp(),
      type: "set-cell-state",
      controllerId: line.controller_id,
      cell: line.logical_code,
      hardwareChannel: line.hardware_channel,
      color: line.guidance_color,
      taskId: task.id,
      quantity: line.planned_quantity,
    };
    emit(event);
    saveDeviceEvent(db, {
      controllerId: line.controller_id,
      cellId: line.cell_id,
      taskId: task.id,
      eventType: "guidance_activated",
      payload: event,
    });
  }
}

export function clearGuidance(db, task, lines) {
  for (const line of lines) {
    const event = {
      ts: stamp(),
      type: "clear-cell-state",
      controllerId: line.controller_id,
      cell: line.logical_code,
      hardwareChannel: line.hardware_channel,
      taskId: task.id,
    };
    emit(event);
    saveDeviceEvent(db, {
      controllerId: line.controller_id,
      cellId: line.cell_id,
      taskId: task.id,
      eventType: "guidance_cleared",
      payload: event,
    });
  }
}

export function sendControllerTest(db, controller) {
  const event = {
    ts: stamp(),
    type: "controller-test",
    controllerId: controller.id,
    controllerCode: controller.controller_code,
    address: controller.address,
  };
  emit(event);
  saveDeviceEvent(db, {
    controllerId: controller.id,
    eventType: "controller_test",
    payload: event,
  });
}

export function sendCellTest(db, cell, color = "amber") {
  const event = {
    ts: stamp(),
    type: "cell-test",
    controllerId: cell.controller_id,
    cell: cell.logical_code,
    hardwareChannel: cell.hardware_channel,
    color,
  };
  emit(event);
  saveDeviceEvent(db, {
    controllerId: cell.controller_id,
    cellId: cell.id,
    eventType: "cell_test",
    payload: event,
  });
}

export function simulateButtonPress(db, line) {
  const event = {
    ts: stamp(),
    type: "button-press",
    controllerId: line.controller_id,
    cell: line.logical_code,
    hardwareChannel: line.hardware_channel,
    taskId: line.task_id,
    lineId: line.id,
  };
  emit(event);
  saveDeviceEvent(db, {
    controllerId: line.controller_id,
    cellId: line.cell_id,
    taskId: line.task_id,
    eventType: "button_press",
    payload: event,
  });
}
