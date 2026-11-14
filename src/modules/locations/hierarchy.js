import {createHash,randomUUID} from 'node:crypto';

export const DEFAULT_WAREHOUSE='Default Shed';
export const DEFAULT_SHELF='Unassigned rack';

// Resolve the selector against saved groups inside the location-save transaction.
// Legacy setup forms may continue to supply the names directly.
export function locationGroupNames(db,input) {
 if(input.shelfId==null&&input.newShelfName==null)return {warehouseName:input.warehouseName,travelInstructions:input.travelInstructions};
 const warehouse=db.prepare('SELECT * FROM location_warehouses WHERE id=?').get(Number(input.warehouseId));
 if(!warehouse)throw new Error('Choose a shed.');
 if(input.shelfId==='new'){
  const name=String(input.newShelfName||'').trim();
  if(!name||name.length>1000||/[\u0000-\u001f\u007f]/.test(name))throw new Error('Enter a readable rack name, up to 1000 characters.');
  return {warehouseName:warehouse.name,travelInstructions:name};
 }
 const shelf=db.prepare('SELECT * FROM location_shelves WHERE id=? AND warehouse_id=?').get(Number(input.shelfId),warehouse.id);
 if(!shelf)throw new Error('Choose a rack in this shed, or add a new one.');
 return {warehouseName:warehouse.name,travelInstructions:shelf.name};
}

export function migrateLocationHierarchy(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS location_warehouses (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE
 );
 CREATE TABLE IF NOT EXISTS location_shelves (
  id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES location_warehouses(id),
  name TEXT NOT NULL COLLATE NOCASE, UNIQUE(warehouse_id,name)
 );`);
 if(!db.prepare('PRAGMA table_info(cells)').all().some(c=>c.name==='shelf_id'))db.exec('ALTER TABLE cells ADD COLUMN shelf_id INTEGER REFERENCES location_shelves(id)');
 // Rename only our old defaults, once. Customer-entered names, IDs, QR labels,
 // controller mappings, stock and history are never rewritten by terminology.
 const hasMetadata=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_metadata'").get();
 const migrated=hasMetadata&&db.prepare("SELECT 1 FROM app_metadata WHERE key='location_terminology_v2'").get();
 if(!migrated){
  db.exec('SAVEPOINT location_terminology');
  try{
   db.prepare('UPDATE location_warehouses SET name=? WHERE name=? AND NOT EXISTS(SELECT 1 FROM location_warehouses WHERE name=?)').run(DEFAULT_WAREHOUSE,'Default Warehouse',DEFAULT_WAREHOUSE);
   db.prepare('UPDATE location_shelves SET name=? WHERE name=? AND NOT EXISTS(SELECT 1 FROM location_shelves other WHERE other.warehouse_id=location_shelves.warehouse_id AND other.name=?)').run(DEFAULT_SHELF,'Unassigned shed/shelf',DEFAULT_SHELF);
   if(hasMetadata)db.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('location_terminology_v2','1',?)").run(new Date().toISOString());
   db.exec('RELEASE location_terminology');
  }catch(error){db.exec('ROLLBACK TO location_terminology; RELEASE location_terminology');throw error;}
 }
 const warehouse=`COALESCE(NULLIF(TRIM(NEW.warehouse_name),''),'${DEFAULT_WAREHOUSE}')`;
 const shelf=`COALESCE(NULLIF(TRIM(NEW.travel_instructions),''),'${DEFAULT_SHELF}')`;
 const sync=`INSERT OR IGNORE INTO location_warehouses(name) VALUES(${warehouse});
 INSERT OR IGNORE INTO location_shelves(warehouse_id,name) SELECT id,${shelf} FROM location_warehouses WHERE name=${warehouse} COLLATE NOCASE;
 UPDATE cells SET shelf_id=(SELECT s.id FROM location_shelves s JOIN location_warehouses w ON w.id=s.warehouse_id WHERE w.name=${warehouse} COLLATE NOCASE AND s.name=${shelf} COLLATE NOCASE),
 warehouse_name=(SELECT name FROM location_warehouses WHERE name=${warehouse} COLLATE NOCASE),
 travel_instructions=(SELECT s.name FROM location_shelves s JOIN location_warehouses w ON w.id=s.warehouse_id WHERE w.name=${warehouse} COLLATE NOCASE AND s.name=${shelf} COLLATE NOCASE)
 WHERE id=NEW.id;`;
 db.exec(`DROP TRIGGER IF EXISTS location_hierarchy_insert;
 DROP TRIGGER IF EXISTS location_hierarchy_details;
 CREATE TRIGGER location_hierarchy_insert AFTER INSERT ON cells BEGIN ${sync} END;
 CREATE TRIGGER location_hierarchy_details AFTER UPDATE OF warehouse_name,travel_instructions ON cells
 WHEN NEW.warehouse_name IS NOT OLD.warehouse_name OR NEW.travel_instructions IS NOT OLD.travel_instructions
 BEGIN ${sync} END;`);
 // Update the denormalized names before discovering any genuinely new groups.
 db.exec(`UPDATE cells SET warehouse_name=(SELECT w.name FROM location_shelves s JOIN location_warehouses w ON w.id=s.warehouse_id WHERE s.id=cells.shelf_id),travel_instructions=(SELECT name FROM location_shelves WHERE id=cells.shelf_id) WHERE shelf_id IS NOT NULL;`);
 // Existing names remain intact; blank legacy values get a visible default group.
 db.exec(`INSERT OR IGNORE INTO location_warehouses(name) SELECT DISTINCT COALESCE(NULLIF(TRIM(warehouse_name),''),'${DEFAULT_WAREHOUSE}') FROM cells;
 INSERT OR IGNORE INTO location_shelves(warehouse_id,name)
 SELECT DISTINCT w.id,COALESCE(NULLIF(TRIM(c.travel_instructions),''),'${DEFAULT_SHELF}') FROM cells c JOIN location_warehouses w ON w.name=COALESCE(NULLIF(TRIM(c.warehouse_name),''),'${DEFAULT_WAREHOUSE}') COLLATE NOCASE;
 UPDATE cells SET shelf_id=(SELECT s.id FROM location_shelves s JOIN location_warehouses w ON w.id=s.warehouse_id
 WHERE w.name=COALESCE(NULLIF(TRIM(cells.warehouse_name),''),'${DEFAULT_WAREHOUSE}') COLLATE NOCASE AND s.name=COALESCE(NULLIF(TRIM(cells.travel_instructions),''),'${DEFAULT_SHELF}') COLLATE NOCASE)
 WHERE shelf_id IS NULL;
 UPDATE cells SET warehouse_name=(SELECT w.name FROM location_shelves s JOIN location_warehouses w ON w.id=s.warehouse_id WHERE s.id=cells.shelf_id),
 travel_instructions=(SELECT name FROM location_shelves WHERE id=cells.shelf_id)
 WHERE shelf_id IS NOT NULL AND (warehouse_name IS NOT (SELECT w.name FROM location_shelves s JOIN location_warehouses w ON w.id=s.warehouse_id WHERE s.id=cells.shelf_id)
 OR travel_instructions IS NOT (SELECT name FROM location_shelves WHERE id=cells.shelf_id));`);
}

export function locationHierarchy(db) {
 const warehouses=db.prepare('SELECT * FROM location_warehouses ORDER BY name,id').all();
 const shelves=db.prepare('SELECT * FROM location_shelves ORDER BY name,id').all();
 const cells=db.prepare('SELECT id,shelf_id,display_name,logical_code,description_revision,active FROM cells ORDER BY id').all();
 return {warehouses,shelves,cells:cells.filter(c=>c.active),version:createHash('sha256').update(JSON.stringify({warehouses,shelves,cells})).digest('hex')};
}

// Called inside the setup service's receipt transaction: either every move saves or none do.
export function saveLocationHierarchy(db,input) {
 const current=locationHierarchy(db);
 if(input.version!==current.version)throw new Error('Locations changed since you opened Edit. Your changes were not saved. Cancel Edit, reload the page, and apply them again.');
 const {warehouses,shelves,cells}=input;
 if(!Array.isArray(warehouses)||!Array.isArray(shelves)||!Array.isArray(cells)||warehouses.length>500||shelves.length>5000||cells.length>50000)throw new Error('Use a valid shed and rack layout.');
 const validate=(rows,old,max,kind)=>{
  const ids=new Set();for(const row of rows){const id=String(row.id),name=String(row.name||'').trim();
   if(!/^(?:[1-9]\d*|new-[\w-]+)$/.test(id)||ids.has(id)||!name||name.length>max||/[\u0000-\u001f\u007f]/.test(name))throw new Error(`Use unique ${kind} entries with readable names up to ${max} characters.`);
   if(!id.startsWith('new-')&&!old.some(v=>String(v.id)===id))throw new Error(`Unknown ${kind}. Reload the layout.`);ids.add(id);
  }
  if(old.some(v=>!ids.has(String(v.id))))throw new Error(`Keep existing ${kind} entries. Move their contents instead of removing them.`);
  return ids;
 };
 const warehouseIds=validate(warehouses,current.warehouses,160,'shed'),shelfIds=validate(shelves,current.shelves,1000,'rack');
 const warehouseNames=new Set(),shelfNames=new Set();
 for(const w of warehouses){const key=w.name.trim().toLowerCase();if(warehouseNames.has(key))throw new Error('Each shed needs a different name.');warehouseNames.add(key);}
 for(const s of shelves){if(!warehouseIds.has(String(s.warehouseId)))throw new Error('Choose a shed for each rack.');const key=String(s.warehouseId)+':'+s.name.trim().toLowerCase();if(shelfNames.has(key))throw new Error('Two racks in the same shed cannot have the same name. Rename one before moving it.');shelfNames.add(key);}
 const cellIds=new Set();for(const c of cells){if(cellIds.has(Number(c.id))||!current.cells.some(v=>v.id===Number(c.id))||!shelfIds.has(String(c.shelfId)))throw new Error('Choose one valid rack for every location.');cellIds.add(Number(c.id));}
 if(cellIds.size!==current.cells.length)throw new Error('Include every location when saving the layout.');
 const warehouseMap=new Map(),shelfMap=new Map(),temp='pending-'+randomUUID();
 // Temporary names let a complete edit swap names without transient uniqueness failures.
 for(const w of current.warehouses)db.prepare('UPDATE location_warehouses SET name=? WHERE id=?').run(temp+'-'+w.id,w.id);
 for(const s of current.shelves)db.prepare('UPDATE location_shelves SET name=? WHERE id=?').run(temp+'-'+s.id,s.id);
 for(const w of warehouses){const id=String(w.id).startsWith('new-')?Number(db.prepare('INSERT INTO location_warehouses(name) VALUES(?)').run(w.name.trim()).lastInsertRowid):Number(w.id);if(!String(w.id).startsWith('new-'))db.prepare('UPDATE location_warehouses SET name=? WHERE id=?').run(w.name.trim(),id);warehouseMap.set(String(w.id),id);}
 for(const s of shelves){const warehouseId=warehouseMap.get(String(s.warehouseId));const id=String(s.id).startsWith('new-')?Number(db.prepare('INSERT INTO location_shelves(warehouse_id,name) VALUES(?,?)').run(warehouseId,s.name.trim()).lastInsertRowid):Number(s.id);if(!String(s.id).startsWith('new-'))db.prepare('UPDATE location_shelves SET warehouse_id=?,name=? WHERE id=?').run(warehouseId,s.name.trim(),id);shelfMap.set(String(s.id),id);}
 for(const c of cells)db.prepare('UPDATE cells SET shelf_id=? WHERE id=?').run(shelfMap.get(String(c.shelfId)),Number(c.id));
 const changed=db.prepare(`SELECT c.id,w.name AS warehouse,s.name AS shelf FROM cells c JOIN location_shelves s ON s.id=c.shelf_id JOIN location_warehouses w ON w.id=s.warehouse_id WHERE c.warehouse_name IS NOT w.name OR c.travel_instructions IS NOT s.name`).all();
 for(const c of changed)db.prepare('UPDATE cells SET warehouse_name=?,travel_instructions=?,description_revision=description_revision+1 WHERE id=?').run(c.warehouse,c.shelf,c.id);
 return {status:'recorded',message:'Location layout saved.',changed:changed.length,hierarchy:locationHierarchy(db)};
}
