import {DatabaseSync} from 'node:sqlite';
import {createDatabase} from '../../src/db.js';
import {hashPassword} from '../../src/services/auth.js';
import {readFileSync} from 'node:fs';
import {prepareRecoveredDatabase} from './restore-data.mjs';
import {buildResetWarehouse} from './reset-data.mjs';
import {administratorPassword,updateAdministrator} from './administrator.mjs';

const input=JSON.parse(readFileSync(0,'utf8'));
if(input.action==='backup') {
  const db=new DatabaseSync(input.source,{readOnly:true});
  try {db.exec(`VACUUM INTO '${String(input.destination).replaceAll("'","''")}'`);}finally{db.close();}
} else if(input.action==='initialise') {
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(input.username))throw new Error('Enter a valid administrator username.');
  administratorPassword(input.password);
  const db=createDatabase({hashPassword,bootstrapAdmin:{name:input.username,username:input.username,password:input.password},allowDevAuthSeeds:false,allowDemoInventorySeed:false,allowWarehouseSeeds:!input.blankWarehouse,allowCatalogSeeds:!input.blankWarehouse});
  if(input.blankWarehouse&&input.warehouseName){db.prepare('INSERT OR IGNORE INTO location_warehouses(name) VALUES(?)').run(input.warehouseName);}
  db.close();
} else if(input.action==='administrator') {
  const db=new DatabaseSync('data/inventory.db');
  try {db.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');console.log(JSON.stringify(updateAdministrator(db,input)));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
} else if(input.action==='recover') {
  const db=createDatabase({hashPassword,allowDevAuthSeeds:false,allowDemoInventorySeed:false,allowWarehouseSeeds:!input.blankWarehouse,allowCatalogSeeds:!input.blankWarehouse});
  try {console.log(JSON.stringify(prepareRecoveredDatabase(db,input)));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
} else if(input.action==='reset') {
  if(input.resetMode==='clear-work'){
    const original=new DatabaseSync('data/inventory.db',{readOnly:true});
    try{if(!original.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active'").get())throw new Error('The backup needs an active administrator to keep its accounts. Choose Start fresh to create a new administrator.');}finally{original.close();}
  }
  const db=createDatabase({hashPassword,allowDevAuthSeeds:false,allowDemoInventorySeed:false,allowWarehouseSeeds:false,allowCatalogSeeds:false});
  try{console.log(JSON.stringify(buildResetWarehouse(db,input.destination,input)));}finally{db.close();}
} else throw new Error('Unsupported setup action.');
