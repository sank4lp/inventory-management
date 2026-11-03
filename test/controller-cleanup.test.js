import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';

for (const reference of ['guidance', 'label', 'stock', 'none']) {
  test(`controller setup safely retires an unused LED with ${reference}`, t => {
    const previousDirectory = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), 'controller-cleanup-')));
    const db = createDatabase({hashPassword});
    t.after(() => { db.close(); process.chdir(previousDirectory); });
    const controller = configureControllerModules(db, {
      controllerCode: 'CLEANUP', controllerAddress: 'CLEANUP', moduleCount: 2,
    });
    const cell = db.prepare('SELECT * FROM cells WHERE controller_id=? AND hardware_channel=2').get(controller.id);
    if (reference === 'guidance') {
      db.prepare('INSERT INTO work_guidance(cell_id,generation,desired,delivered,updated_at) VALUES(?,?,?,?,?)')
        .run(cell.id, 'saved', 'off', 1, new Date().toISOString());
    } else if (reference === 'label') {
      db.prepare('INSERT INTO location_labels(token,cell_id,state,created_at) VALUES(?,?,?,?)')
        .run('saved-label', cell.id, 'bound', new Date().toISOString());
    } else if (reference === 'stock') {
      const product = db.prepare('SELECT id FROM products LIMIT 1').get();
      db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,5,0)')
        .run(product.id, cell.id);
    }

    const result = configureControllerModules(db, {
      controllerCode: 'CLEANUP', controllerAddress: 'CLEANUP', moduleCount: 1,
    });
    const retired = db.prepare('SELECT * FROM cells WHERE id=?').get(cell.id);
    if (reference === 'none') {
      assert.equal(retired, undefined);
      assert.equal(result.mappingSummary.removed, 1);
    } else {
      assert.equal(retired.active, 0);
      assert.equal(retired.controller_id, null);
      assert.equal(retired.hardware_channel, null);
      assert.equal(result.mappingSummary.detached, 1);
      if (reference === 'guidance') assert.equal(db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(cell.id).generation, 'saved');
      if (reference === 'label') assert.equal(db.prepare('SELECT cell_id FROM location_labels WHERE token=?').get('saved-label').cell_id, cell.id);
      if (reference === 'stock') assert.equal(db.prepare('SELECT available_quantity FROM inventory_balances WHERE cell_id=?').get(cell.id).available_quantity, 5);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
}
