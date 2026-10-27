import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

test("LED brightness stays at maximum all day and ignores legacy dimming settings", async () => {
  const { resolveLedBrightness } = await freshImport("../src/services/hardware-brightness.js");
  const { resolveConfig } = await freshImport("../src/config.js");
  const legacyConfig = resolveConfig({LED_DAY_BRIGHTNESS_PERCENT: "20", LED_NIGHT_BRIGHTNESS_PERCENT: "8"});
  for (const hour of [0, 5, 6, 12, 18, 23]) {
    for (const config of [{}, legacyConfig, {
      ledDayStartHour: 7, ledNightStartHour: 19,
      ledDayBrightnessPercent: 25, ledNightBrightnessPercent: 3,
    }]) {
      const policy = resolveLedBrightness(config, new Date(2026, 4, 13, hour, 0, 0));
      assert.equal(policy.brightnessPercent, 100);
      assert.equal(policy.mode, "maximum");
    }
  }
});

test("hardware guidance records the resolved LED brightness", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "inventory-app-led-brightness-"));
  process.chdir(sandbox);

  const { createDatabase } = await freshImport("../src/db.js");
  const auth = await freshImport("../src/services/auth.js");
  const inventory = await freshImport("../src/services/inventory.js");
  const { createHardwareService } = await freshImport("../src/services/hardware.js");
  const { createLogger } = await freshImport("../src/logger.js");

  const db = createDatabase({ hashPassword: auth.hashPassword });
  const controller = inventory.configureControllerModules(db, {
    controllerCode: "ESP32-BRIGHT",
    controllerAddress: "CTRL-BRIGHT",
    moduleCount: 1,
    configuredBy: 1,
  });
  const module = inventory
    .listCellCatalog(db)
    .find((entry) => entry.controller_id === controller.id && entry.hardware_channel);
  const location = inventory.searchCells(db, "Z1-R1-C01")[0];
  inventory.updateCellMapping(db, {
    cellId: module.id,
    hardwareChannel: 1,
    targetCellId: location.id,
    mappedBy: 1,
  });
  const cell = inventory.listCells(db).find((entry) => entry.id === location.id);

  const hardwareService = createHardwareService({
    db,
    config: {
      hardwareAdapter: "simulator",
      ledBrightnessClock: () => new Date(2026, 4, 13, 14, 0, 0),
    },
    logger: createLogger({ level: "error", siteId: "test-site" }),
  });

  hardwareService.activateGuidance(
    {
      id: null,
      type: "pick",
    },
    [
      {
        ...cell,
        cell_id: cell.id,
        planned_quantity: 2,
        guidance_color: "green",
      },
    ],
  );
  hardwareService.sendCellTest(cell, "amber");
  hardwareService.setCellLocate(cell, true);

  const payloads = db
    .prepare(
      `
        SELECT payload
        FROM device_events
        WHERE event_type IN ('guidance_activated', 'cell_test', 'cell_locate_started')
        ORDER BY id
      `,
    )
    .all()
    .map((row) => JSON.parse(row.payload));

  assert.deepEqual(
    payloads.map((payload) => payload.brightnessPercent),
    [100, 100, 100],
  );
  assert.deepEqual(
    payloads.map((payload) => payload.brightnessMode),
    ["maximum", "maximum", "maximum"],
  );
});

test("RS485 guidance activation sends repeated full-plan bursts", async () => {
  const { createRs485Adapter } = await freshImport("../src/services/hardware-adapters/rs485.js");
  const { createLogger } = await freshImport("../src/logger.js");
  const writes = [];
  const adapter = createRs485Adapter({
    config: {
      rs485GuidanceBurstRepeats: 3,
      rs485GuidanceBurstDelayMs: 0,
      rs485InterCommandDelayMs: 0,
      rs485WriteLine: (line) => writes.push(line.trim()),
      ledBrightnessClock: () => new Date(2026, 4, 13, 14, 0, 0),
    },
    logger: createLogger({ level: "error", siteId: "test-site" }),
  });

  const result = adapter.activateGuidance(
    { id: 42, type: "pick" },
    [
      {
        cell_id: 1,
        logical_code: "Z1-R1-C01",
        controller_id: 7,
        controller_address: "CTRL-A",
        hardware_channel: 1,
        planned_quantity: 2,
        guidance_color: "green",
      },
      {
        cell_id: 2,
        logical_code: "Z1-R1-C02",
        controller_id: 7,
        controller_address: "CTRL-A",
        hardware_channel: 2,
        planned_quantity: 4,
        guidance_color: "red",
      },
    ],
  );

  assert.deepEqual(writes, [
    'to CTRL-A digit 1 "2" green 120 100',
    'to CTRL-A digit 2 "4" red 120 100',
    'to CTRL-A digit 1 "2" green 120 100',
    'to CTRL-A digit 2 "4" red 120 100',
    'to CTRL-A digit 1 "2" green 120 100',
    'to CTRL-A digit 2 "4" red 120 100',
  ]);
  assert.equal(result.events.length, 2);
  assert.deepEqual(
    result.events.map((event) => event.payload.guidanceBurstRepeats),
    [3, 3],
  );
});

test("RS485 stock count uses yellow text display for multi-digit and decimal quantities", async () => {
  const { createRs485Adapter } = await freshImport("../src/services/hardware-adapters/rs485.js");
  const { createLogger } = await freshImport("../src/logger.js");
  const writes = [];
  const adapter = createRs485Adapter({
    config: {
      rs485InterCommandDelayMs: 0,
      rs485WriteRepeats: 1,
      rs485WriteLine: (line) => writes.push(line.trim()),
      ledBrightnessClock: () => new Date(2026, 4, 13, 14, 0, 0),
    },
    logger: createLogger({ level: "error", siteId: "test-site" }),
  });

  const result = adapter.showCellQuantity(
    {
      id: 1,
      logical_code: "Z1-R1-C01",
      controller_id: 7,
      controller_address: "CTRL-A",
      hardware_channel: 1,
    },
    "12.5",
    "yellow",
  );

  assert.deepEqual(writes, ['to CTRL-A text 1 "12.5" yellow 120 100']);
  assert.equal(result.degraded, false);
  assert.equal(result.events[0].eventType, "cell_quantity_displayed");
  assert.equal(result.events[0].payload.quantity, "12.5");
  assert.equal(result.events[0].payload.color, "yellow");

  const clearResult = adapter.clearCellQuantity({
    id: 1,
    logical_code: "Z1-R1-C01",
    controller_id: 7,
    controller_address: "CTRL-A",
    hardware_channel: 1,
  });
  assert.deepEqual(writes.slice(1), Array(5).fill("to CTRL-A clear 1"));
  assert.equal(clearResult.degraded, false);
  assert.equal(clearResult.events[0].eventType, "cell_quantity_cleared");
});


test("every RS485 lighting action sends maximum brightness even with legacy night dimming", async () => {
  const { createRs485Adapter } = await freshImport("../src/services/hardware-adapters/rs485.js");
  const { createLogger } = await freshImport("../src/logger.js");
  for (const hour of [12, 23]) {
    const writes = [];
    const adapter = createRs485Adapter({
      config: {
        rs485GuidanceBurstRepeats: 1, rs485InterCommandDelayMs: 0,
        rs485WriteRepeats: 1, rs485WriteLine: line => writes.push(line.trim()),
        ledDayBrightnessPercent: 20, ledNightBrightnessPercent: 8,
        ledBrightnessClock: () => new Date(2026, 4, 13, hour, 0, 0),
      },
      logger: createLogger({level: "error", siteId: "test-site"}),
    });
    const cell = {id: 1, cell_id: 1, logical_code: "Z1-R1-C01", controller_id: 7,
      controller_address: "CTRL-A", hardware_channel: 1, planned_quantity: 2};
    const results = [
      adapter.activateGuidance({id: 42, type: "pick"}, [cell]),
      adapter.activateGuidance({id: 43, type: "put"}, [cell]),
      adapter.showCellQuantity(cell, 12, "yellow"),
      adapter.setCellLocate(cell, true, {managed: true}),
      adapter.sendCellTest(cell, "green"),
    ];
    assert.deepEqual(writes, [
      'to CTRL-A digit 1 "2" green 120 100',
      'to CTRL-A digit 1 "2" red 120 100',
      'to CTRL-A text 1 "12" yellow 120 100',
      'to CTRL-A locate 1 red 100 300000',
      'to CTRL-A blink 1 green 100 5000',
    ]);
    for (const result of results) {
      assert.equal(result.ok, true);
      assert.equal(result.degraded, false);
      for (const event of result.events) {
        assert.equal(event.payload.brightnessPercent, 100);
        assert.equal(event.payload.brightnessMode, "maximum");
      }
    }
  }
});
