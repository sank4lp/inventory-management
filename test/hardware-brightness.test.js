import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}

test("LED brightness policy uses day brightness during working hours and minimum brightness at night", async () => {
  const { resolveLedBrightness } = await freshImport("../src/services/hardware-brightness.js");

  const noon = resolveLedBrightness({}, new Date(2026, 4, 13, 12, 0, 0));
  assert.equal(noon.mode, "day");
  assert.equal(noon.brightnessPercent, 20);

  const lateNight = resolveLedBrightness({}, new Date(2026, 4, 13, 23, 0, 0));
  assert.equal(lateNight.mode, "night");
  assert.equal(lateNight.brightnessPercent, 8);

  const customNight = resolveLedBrightness(
    {
      ledDayStartHour: 7,
      ledNightStartHour: 19,
      ledDayBrightnessPercent: 25,
      ledNightBrightnessPercent: 3,
    },
    new Date(2026, 4, 13, 6, 30, 0),
  );
  assert.equal(customNight.mode, "night");
  assert.equal(customNight.brightnessPercent, 3);
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
  const cell = inventory
    .listCells(db)
    .find((entry) => entry.controller_id === controller.id && entry.hardware_channel);

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
    [20, 20, 20],
  );
  assert.deepEqual(
    payloads.map((payload) => payload.brightnessMode),
    ["day", "day", "day"],
  );
});
