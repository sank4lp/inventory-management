import {randomUUID,randomBytes} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {createDatabase} from '../../src/db.js';
import {hashPassword} from '../../src/services/auth.js';
import {administratorPassword} from './account-password.mjs';

const ACCOUNT_TABLES=['access_roles','users','registration_keys','access_events'];
const CATALOG_TABLES=['product_field_definitions','products','product_attribute_values','report_definitions'];
const HARDWARE_TABLES=['zones','location_warehouses','location_shelves','controllers','cells','location_field_definitions','location_field_values','location_labels'];
const settingsKey=key=>/_(?:settings|schedule|defaults|timezone)(?:_v\d+)?$/.test(key)||['pending_review_timeout_minutes','backup_retention_days','default_pick_assignment_minutes','default_put_assignment_minutes','default_stocktake_due_days'].includes(key);

// Creates a new database in an EMPTY staging folder. It never edits source data,
// accesses serial devices or invokes a compiler/flasher.
export function buildResetWarehouse(source,folder,{resetMode,keepHardware,username,password,warehouseName}={}){
  if(!['clear-work','fresh'].includes(resetMode)||typeof keepHardware!=='boolean')throw new Error('Choose the reset level and whether to keep controller/location setup.');
  if(resetMode==='fresh'){if(!/^[A-Za-z0-9._-]{1,80}$/.test(username||''))throw new Error('Enter a valid administrator username.');administratorPassword(password);}
  const candidates=source.prepare('SELECT controller_code,address,firmware_version,module_count FROM controllers WHERE active=1 ORDER BY id').all();
  const previousCwd=process.cwd();let db;
  mkdirSync(folder,{recursive:false,mode:0o700});
  try{
    process.chdir(folder);
    db=createDatabase({hashPassword,bootstrapAdmin:{name:username||'Temporary setup',username:username||'setup-'+randomUUID(),password:password||randomBytes(32).toString('hex')},allowDevAuthSeeds:false,allowDemoInventorySeed:false,allowWarehouseSeeds:false,allowCatalogSeeds:false});
  }finally{process.chdir(previousCwd);}
  try{
    const tables=[...(resetMode==='clear-work'?[...ACCOUNT_TABLES,...CATALOG_TABLES,'location_field_definitions','stocktake_schedules']:[]),...(keepHardware?HARDWARE_TABLES:[])];
    const unique=[...new Set(tables)];
    const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try{
      for(const row of triggers)db.exec(`DROP TRIGGER "${row.name.replaceAll('"','""')}"`);
      for(const table of unique)db.exec(`DELETE FROM "${table}"`);
      for(const table of unique){
        const columns=db.prepare(`PRAGMA table_info("${table}")`).all().map(row=>row.name);
        const nullableUsers=resetMode==='fresh'?source.prepare(`PRAGMA foreign_key_list("${table}")`).all().filter(f=>['users','products'].includes(f.table)).map(f=>f.from):[];
        const insert=db.prepare(`INSERT INTO "${table}" (${columns.map(c=>'"'+c+'"').join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
        for(const original of source.prepare(`SELECT * FROM "${table}"`).iterate()){
          const row={...original};for(const column of nullableUsers)row[column]=null;
          insert.run(...columns.map(column=>row[column]??null));
        }
      }
      const save=db.prepare('INSERT OR REPLACE INTO app_metadata(key,value,updated_at) VALUES(?,?,?)');
      for(const row of source.prepare('SELECT * FROM app_metadata').all()){
        if((resetMode==='clear-work'&&settingsKey(row.key))||(keepHardware&&(row.key==='warehouse_identity'||/^controller_(?:profile|chip_identity|firmware_hold|replacement_pending|firmware_epoch):\d+$/.test(row.key))))save.run(row.key,row.value,row.updated_at);
      }
      db.exec("UPDATE users SET session_version=session_version+1; UPDATE controllers SET heartbeat_status='offline',last_seen_at=NULL");
      if(!keepHardware)db.exec('UPDATE stocktake_schedules SET enabled=0');
      if(!db.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active'").get())throw new Error('The retained accounts need an active administrator.');
      if(!keepHardware&&warehouseName)db.prepare('INSERT OR IGNORE INTO location_warehouses(name) VALUES(?)').run(warehouseName);
      for(const row of triggers)db.exec(row.sql);
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Retained setup has incomplete references. No reset was activated.');
      const now=new Date().toISOString();save.run('dataset_generation',randomUUID(),now);
      if(!keepHardware)save.run('setup_reconnect_candidates',JSON.stringify(candidates),now);
      db.prepare('INSERT INTO system_events(event_type,status,message,payload,created_at) VALUES(?,?,?,?,?)').run('warehouse_data_reset','info','Warehouse data reset during Raspberry Pi replacement.',JSON.stringify({resetMode,keepHardware}),now);
      db.exec('COMMIT; PRAGMA foreign_keys=ON; PRAGMA wal_checkpoint(TRUNCATE)');
      return {resetMode,keepHardware,reconnectCandidates:keepHardware?[]:candidates};
    }catch(error){db.exec('ROLLBACK; PRAGMA foreign_keys=ON');throw error;}
  }finally{db.close();}
}
