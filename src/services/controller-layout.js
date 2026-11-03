import {cellHasReferences} from '../repositories/cell-reference-repository.js';

// Physical order is never rebuilt from the location names. Grow at the end of
// the chain, keeping every existing logical output and location identity.
export function resizedControllerProfile(db, controller, profile, count) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('LED modules must be a whole number from 1 to 64.');
  const routing = [...profile.routing];
  const cells = db.prepare('SELECT * FROM cells WHERE controller_id=?').all(controller.id);
  const removed = cells.filter(cell => routing[cell.hardware_channel - 1] > count);
  for (const cell of removed) {
    if (cell.active || cell.display_name || cell.binding_verified_at || cellHasReferences(db, cell.id) || db.prepare('SELECT 1 FROM inventory_balances WHERE cell_id=? AND (available_quantity!=0 OR reserved_quantity!=0)').get(cell.id)) {
      throw new Error(`LED ${profile.routing[cell.hardware_channel - 1]} belongs to ${cell.display_name || cell.logical_code}. Move its stock and unmap this location in Manage Locations before reducing the LED count. No firmware was uploaded.`);
    }
  }
  for (let i = 0; i < routing.length; i++) if (routing[i] > count) routing[i] = 0;
  for (let physical = profile.physicalCount + 1; physical <= count; physical++) {
    const logical = routing.findIndex((value, i) => value === 0 && !cells.some(cell => cell.hardware_channel === i + 1 && !removed.includes(cell)));
    if (logical < 0) throw new Error('There are no unused logical outputs left on this controller. Use another controller or clear unused mappings first.');
    routing[logical] = physical;
  }
  return {...profile, physicalCount: count, logicalCount: routing.findLastIndex(n => n > 0) + 1, routing};
}

export function applyControllerLayout(db, controller, profile, actorId, previousProfile) {
  const cells = db.prepare('SELECT * FROM cells WHERE controller_id=?').all(controller.id);
  let created = 0, removed = 0;
  for (const cell of cells) if (previousProfile.routing[cell.hardware_channel - 1] && !profile.routing[cell.hardware_channel - 1]) {
    // Recheck against the live database immediately before committing, too.
    if (cell.active || cell.display_name || cell.binding_verified_at || cellHasReferences(db, cell.id) || db.prepare('SELECT 1 FROM inventory_balances WHERE cell_id=? AND (available_quantity!=0 OR reserved_quantity!=0)').get(cell.id)) throw new Error('A removed LED acquired location data during maintenance. The saved mappings were kept; reconnect and retry.');
    db.prepare('DELETE FROM inventory_balances WHERE cell_id=?').run(cell.id);
    db.prepare('DELETE FROM device_events WHERE cell_id=?').run(cell.id);
    db.prepare('DELETE FROM cells WHERE id=?').run(cell.id); removed++;
  }
  for (let i = 0; i < profile.routing.length; i++) if (profile.routing[i] && !cells.some(cell => cell.hardware_channel === i + 1)) {
    let code = `${controller.controller_code}-LED-${i + 1}`, suffix = 1;
    while (db.prepare('SELECT 1 FROM cells WHERE logical_code=?').get(code)) code = `${controller.controller_code}-LED-${i + 1}-${suffix++}`;
    db.prepare(`INSERT INTO cells(logical_code,zone_id,row_number,column_number,controller_id,hardware_channel,mapping_status,active,capacity,mapped_by)
      VALUES(?,?,1,?,?,?,'unmapped',0,12,?)`).run(code, controller.zone_id, i + 1, controller.id, i + 1, actorId);
    created++;
  }
  db.prepare('UPDATE controllers SET module_count=?,cell_end_column=? WHERE id=?').run(profile.logicalCount, profile.logicalCount, controller.id);
  return {created, removed, detached: 0, preserved: cells.length - removed};
}
