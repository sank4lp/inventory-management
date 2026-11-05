import {createHash,randomUUID} from 'node:crypto';
import {withTransaction} from '../../db.js';
import {currentActor,effectiveUser} from '../access/service.js';
import {can,assertCan} from '../access/catalog.js';
import {controllerLedMap} from '../locations/led-mapping.js';
import {createProduct} from '../../services/inventory.js';
import {createProductFieldService} from '../../services/product-fields.js';
import {stocktakeDefaultDueDate} from '../../services/deadline-defaults.js';
import {parseWarehouseExcel,locationKey} from './workbook.js';

const json=JSON.stringify;
const hash=value=>createHash('sha256').update(json(value)).digest('hex');
const nameOf=cell=>cell.display_name||cell.logical_code;
const round=value=>Math.round(value*1e6)/1e6;
const clean=value=>String(value??'').trim();
function error(message){throw new Error(message);}

export function createWarehouseExcelService({db,locationSetupService,stocktakingService,backupService,clock=()=>new Date()}){
  db.exec(`CREATE TABLE IF NOT EXISTS warehouse_excel_imports(
    id TEXT PRIMARY KEY,actor_id INTEGER NOT NULL REFERENCES users(id),dataset TEXT NOT NULL,file_name TEXT NOT NULL,file_hash TEXT NOT NULL,
    document_json TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',
    review_json TEXT,review_token TEXT,state_hash TEXT,result_json TEXT
  )`);
  const actor=user=>currentActor(db,user,'count.manage');
  const dataset=()=>db.prepare("SELECT value FROM app_metadata WHERE key='dataset_generation'").get()?.value||'';
  const fields=createProductFieldService({db});
  const cells=()=>db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id').all();
  const products=()=>db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sku,id').all();
  const controllers=()=>db.prepare('SELECT * FROM controllers WHERE active=1 ORDER BY id').all().map(c=>controllerLedMap(db,c));
  function stateHash(){
    const tables=['cells','controllers','products','inventory_balances','location_field_definitions','location_field_values','product_field_definitions','location_warehouses','location_shelves','stocktake_runs','stocktake_items','stocktake_item_counters'];
    // Health polling is not a mapping edit. Keep all controller configuration in
    // the fingerprint, but ignore the two fields changed by routine heartbeats.
    return hash([dataset(),...tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>{
      if(table!=='controllers')return row;
      const {last_seen_at,heartbeat_status,...configuration}=row;return configuration;
    })),db.prepare("SELECT * FROM app_metadata WHERE key LIKE 'controller_profile:%' OR key='firmware_busy' ORDER BY key").all()]);
  }
  function draft(a,id){
    const value=db.prepare('SELECT * FROM warehouse_excel_imports WHERE id=? AND actor_id=?').get(String(id),a.id);
    if(!value)error('This import was not found for your account. Upload the file again.');
    if(value.dataset!==dataset())error('Warehouse data was restored. Upload the file again.');
    if(value.status!=='applied'&&value.expires_at<clock().toISOString())error('This import expired. Upload the file again.');
    return value;
  }
  function groupDocument(document){
    const locationGroups=new Map(),productGroups=new Map();
    for(const row of [...document.mappings,...document.stock.filter(r=>r.location).map(r=>({name:r.location,key:r.locationKey,row:r.row,stock:true}))]){
      const group=locationGroups.get(row.key)||{key:row.key,name:row.name,rows:[],mapping:null};
      group.rows.push({sheet:row.stock?'Products & Stock':'LED Mapping',row:row.row});
      if(!row.stock){
        if(group.mapping&&json([group.mapping.controller,group.mapping.physical])!==json([row.controller,row.physical]))error(`LED Mapping, row ${row.row}: ${row.name} has conflicting LED assignments. Use one assignment for this location.`);
        group.mapping=row;
      }
      locationGroups.set(row.key,group);
    }
    for(const row of document.stock){
      const group=productGroups.get(row.key)||{key:row.key,...row,rows:[]};group.rows.push(row.row);productGroups.set(row.key,group);
    }
    return {locations:[...locationGroups.values()],products:[...productGroups.values()]};
  }
  function describe(a,value){
    const document=JSON.parse(value.document_json),groups=groupDocument(document),existingCells=cells(),existingProducts=products();
    return {id:value.id,fileName:value.file_name,rows:{mapping:document.mappings.length,stock:document.stock.length},
      locations:groups.locations.map(group=>{
        const matches=existingCells.filter(c=>[c.display_name,c.logical_code].some(n=>locationKey(n)===group.key));
        return {...group,existingId:matches.length===1?matches[0].id:null,ambiguous:matches.length>1};
      }),
      products:groups.products.map(group=>({...group,existing:existingProducts.find(p=>group.sku&&p.sku.toUpperCase()===group.sku)||null})),
      choices:{cells:existingCells.map(c=>({id:c.id,name:nameOf(c),controllerId:c.controller_id,channel:c.hardware_channel})),controllers:controllers(),
        warehouses:db.prepare('SELECT * FROM location_warehouses ORDER BY name').all(),shelves:db.prepare('SELECT * FROM location_shelves ORDER BY name').all(),
        locationFields:db.prepare('SELECT * FROM location_field_definitions WHERE enabled=1 ORDER BY display_order,field_key').all(),
        productFields:fields.list().filter(f=>f.active&&f.field_kind==='custom'),
        counters:db.prepare("SELECT * FROM users WHERE status='active' ORDER BY name,id").all().filter(u=>can(effectiveUser(db,u),'count.perform')).map(u=>({id:u.id,name:u.name,role:effectiveUser(db,u).role_name})),
        dueDate:stocktakeDefaultDueDate(db,clock(),db.prepare("SELECT value FROM app_metadata WHERE key='warehouse_timezone'").get()?.value||'Asia/Kolkata')},
      capabilities:{locations:can(a,'locations.manage'),mapping:can(a,'hardware.map'),products:can(a,'products.add'),lights:can(a,'hardware.test')}};
  }
  function upload(user,input){
    const a=actor(user),buffer=Buffer.from(String(input.base64||''),'base64'),document=parseWarehouseExcel(buffer);
    groupDocument(document); // Report file conflicts before storing a draft.
    const id=randomUUID(),created=clock(),expires=new Date(created.getTime()+24*60*60*1000);
    db.prepare("DELETE FROM warehouse_excel_imports WHERE status='draft' AND expires_at<?").run(created.toISOString());
    db.prepare('INSERT INTO warehouse_excel_imports(id,actor_id,dataset,file_name,file_hash,document_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,a.id,dataset(),clean(input.fileName).slice(0,200)||'Warehouse.xlsx',document.fileHash,json(document),created.toISOString(),expires.toISOString());
    return describe(a,draft(a,id));
  }
  function stage(a,value,input){
    const document=JSON.parse(value.document_json),groups=groupDocument(document),resolved=new Map(),newLocations=[],newProducts=[],mappingChanges=[];
    const choices=new Map((input.locations||[]).map(row=>[row.key,row]));
    if(choices.size!==(input.locations||[]).length)error('Resolve each location name only once.');
    const maps=controllers(),existing=cells(),wanted=[];
    for(const group of groups.locations){
      const choice=choices.get(group.key),matches=existing.filter(c=>[c.display_name,c.logical_code].some(n=>locationKey(n)===group.key));
      if(choice?.create&&choice.existingId)error(`Choose either a new or existing location for ${group.name}.`);
      let cell=choice?.existingId?existing.find(c=>c.id===Number(choice.existingId)):!choice?.create&&matches.length===1?matches[0]:null;
      if(choice?.existingId&&!cell)error(`Choose an active location for ${group.name}.`);
      if(!cell){
        if(choice?.create!==true||choice.confirmed!==true)error(`Confirm creating ${group.name}, or select its existing location.`);
        assertCan(a,'locations.manage');
        const displayName=clean(choice.displayName||group.name);
        if(!displayName||displayName.length>160||/[\u0000-\u001f\u007f]/.test(displayName))error(`Enter a readable name for ${group.name}, up to 160 characters.`);
        if(cells().some(c=>[c.display_name,c.logical_code].some(n=>locationKey(n)===locationKey(displayName))))error(`${displayName} already exists. Select it instead of creating a duplicate.`);
        if(!choice.controllerId||!choice.physical)error(`Choose a controller and physical LED for new location ${displayName}.`);
        const created=locationSetupService.stageExcelLocation(a,{...choice,displayName});
        cell=db.prepare('SELECT * FROM cells WHERE id=?').get(created.cellId);newLocations.push({id:cell.id,name:nameOf(cell),fileName:group.name});
      }
      resolved.set(group.key,cell);
      let map,physical;
      if(choice?.create){map=maps.find(c=>c.id===Number(choice.controllerId));physical=Number(choice.physical);}
      else if(group.mapping?.controller){map=maps.find(c=>c.name===group.mapping.controller||c.controller_code===group.mapping.controller);physical=group.mapping.physical;}
      else continue; // Blank mapping columns preserve an existing binding.
      if(!map)error(`${group.name}: Controller Name must exactly match a registered controller.`);
      if(map.error)error(`${group.name}: ${map.error}`);
      const led=map.leds.find(l=>l.physical===physical);
      if(!led?.channel)error(`${group.name}: LED ${physical} is not configured on ${map.name}.`);
      if(led.cellId&&led.cellId!==cell.id)error(`${map.name}, LED ${physical} belongs to ${led.name}. Correct that mapping in Manage Locations first, or choose a free LED.`);
      const collision=wanted.find(row=>row.controllerId===map.id&&row.physical===physical&&row.cell.id!==cell.id||row.cell.id===cell.id&&(row.controllerId!==map.id||row.physical!==physical));
      if(collision)error(`Conflicting mapping for ${nameOf(cell)}. Each location and physical LED must appear in only one assignment.`);
      if(!wanted.some(row=>row.cell.id===cell.id))wanted.push({cell,controllerId:map.id,physical,channel:led.channel,controllerName:map.name});
    }
    for(const map of maps){
      const rows=wanted.filter(row=>row.controllerId===map.id&&(row.cell.controller_id!==map.id||row.cell.hardware_channel!==row.channel));
      if(!rows.length)continue;
      const current=controllerLedMap(db,db.prepare('SELECT * FROM controllers WHERE id=?').get(map.id));
      locationSetupService.stageExcelMappings(a,{controllerId:map.id,revision:current.revision,rows:rows.map(row=>({physical:row.physical,name:nameOf(row.cell),cellId:row.cell.id}))});
      mappingChanges.push(...rows.map(row=>({cell:nameOf(row.cell),controller:map.name,physical:row.physical})));
    }
    const productChoices=new Map((input.products||[]).map(row=>[row.key,row])),productMap=new Map();
    if(productChoices.size!==(input.products||[]).length)error('Confirm each new product only once.');
    const originalProducts=products();
    for(const group of groups.products){
      let product=originalProducts.find(p=>group.sku&&p.sku.toUpperCase()===group.sku);
      if(!product){
        const choice=productChoices.get(group.key);
        if(choice?.confirmed!==true)error(`Confirm the new product ${group.name||group.sku}.`);
        assertCan(a,'products.add');
        const sku=clean(choice.sku).toUpperCase(),name=clean(choice.name),unit=clean(choice.unit),capacity=Number(choice.itemsPerCell);
        if(!sku||sku.length>160||!name||name.length>300||!unit||unit.length>100||!Number.isFinite(capacity)||capacity<=0||capacity>1e9)error(`Complete the SKU, name, unit and items per location for ${group.name||group.sku}.`);
        if(db.prepare('SELECT 1 FROM products WHERE sku=? COLLATE NOCASE').get(sku))error(`SKU ${sku} already exists, including archived products. Correct the SKU in the file or restore that product first.`);
        const result=createProduct(db,{sku,name,brand:clean(choice.brand),unit_of_measure:unit,items_per_cell:capacity,category:clean(choice.category),variant:clean(choice.variant),description:clean(choice.description)});
        product=db.prepare('SELECT * FROM products WHERE id=?').get(result.id);
        for(const field of fields.list().filter(f=>f.active&&f.field_kind==='custom'))fields.setProductValue({actor:a,productId:product.id,fieldId:field.id,value:choice.attributes?.[field.id]??''});
        newProducts.push({id:product.id,sku:product.sku,name:product.name});
      }
      productMap.set(group.key,product);
    }
    const compared=new Set(),differences=new Map();
    for(const row of document.stock){
      if(row.quantity===null)continue;
      const product=productMap.get(row.key),cell=resolved.get(row.locationKey),key=product.id+':'+cell.id;
      if(compared.has(key))error(`Products & Stock, row ${row.row}: ${product.sku} appears more than once at ${nameOf(cell)} after resolving location names. Keep one stock row for this pair.`);
      compared.add(key);
      if(row.unit&&row.unit!==product.unit_of_measure)error(`Products & Stock, row ${row.row}: use ${product.unit_of_measure} for ${product.sku}. An import cannot convert units.`);
      const current=Number(db.prepare('SELECT available_quantity FROM inventory_balances WHERE product_id=? AND cell_id=?').get(product.id,cell.id)?.available_quantity||0);
      if(Math.abs(current-row.quantity)<1e-6)continue;
      const difference={cellId:cell.id,cell:nameOf(cell),recorded:current,imported:row.quantity,row:row.row};
      const group=differences.get(product.id)||{productId:product.id,sku:product.sku,name:product.name,unit:product.unit_of_measure,cells:[],recordedTotal:Number(db.prepare('SELECT COALESCE(SUM(b.available_quantity),0) total FROM inventory_balances b JOIN cells c ON c.id=b.cell_id WHERE b.product_id=? AND c.active=1').get(product.id).total)};
      group.cells.push(difference);differences.set(product.id,group);
    }
    const stocktakes=[];
    for(const difference of differences.values()){
      difference.proposedTotal=round(difference.recordedTotal+difference.cells.reduce((n,c)=>n+c.imported-c.recorded,0));
      const pending=db.prepare("SELECT r.id,r.scope_json,i.cell_id FROM stocktake_runs r JOIN stocktake_items i ON i.run_id=r.id WHERE r.status NOT IN ('completed','closed','stopped') AND i.state IN ('pending','counting','skipped','recheck') ORDER BY r.id").all().filter(row=>JSON.parse(row.scope_json).productId===difference.productId);
      const uncovered=difference.cells.filter(cell=>!pending.some(row=>row.cell_id===cell.cellId));
      const existingRunIds=[...new Set(pending.filter(row=>difference.cells.some(cell=>cell.cellId===row.cell_id)).map(row=>row.id))];
      let runId=null;
      if(uncovered.length){
        if(!Array.isArray(input.counterIds)||!input.counterIds.length)error('Choose at least one counter for the stocktaking work.');
        const result=stocktakingService.stageExcelCount(a,{mode:'product',productId:difference.productId,cellIds:uncovered.map(c=>c.cellId),locationsChosen:true,counterIds:input.counterIds,dueDate:input.dueDate,
          title:`Excel stock check · ${difference.name}`,importId:value.id,comparisons:uncovered});runId=result.runId;
      }
      stocktakes.push({...difference,runId,existingRunIds,newCells:uncovered.length});
    }
    return {newLocations,newProducts,mappingChanges,stocktakes,stockUnchanged:true};
  }
  function review(user,input){
    const a=actor(user),value=draft(a,input.id);
    if(value.status==='applied')return {applied:true,...JSON.parse(value.result_json)};
    const choices={locations:input.locations||[],products:input.products||[],counterIds:input.counterIds||[],...(input.dueDate!==undefined?{dueDate:input.dueDate}:{})};
    let summary,revision;
    db.exec('BEGIN IMMEDIATE');
    try{revision=stateHash();summary=stage(a,value,choices);}finally{db.exec('ROLLBACK');}
    const token=randomUUID();
    db.prepare('UPDATE warehouse_excel_imports SET review_json=?,review_token=?,state_hash=? WHERE id=?').run(json(choices),token,revision,value.id);
    return {id:value.id,token,summary};
  }
  function apply(user,input){
    const a=actor(user),value=draft(a,input.id);
    if(value.status==='applied'){
      if(input.token!==value.review_token)error('This import was already saved from a different review.');
      return {...JSON.parse(value.result_json),replayed:true};
    }
    if(input.confirmed!==true||!value.review_token||input.token!==value.review_token)error('Review the import and confirm before saving.');
    if(stateHash()!==value.state_hash)error('Stock, locations or assignments changed after your review. Review the import again; nothing was saved.');
    const backup=backupService.createBackup({kind:'manual',source:'before-excel-import'});
    const result=withTransaction(db,()=>{
      const current=actor(a);if(stateHash()!==value.state_hash)error('Warehouse data changed. Review the import again.');
      const summary=stage(current,value,JSON.parse(value.review_json));
      const result={id:value.id,...summary,backup:backup.filename,message:'Import saved. Stock quantities are unchanged; mismatches are ready for stocktaking.'};
      db.prepare("UPDATE warehouse_excel_imports SET status='applied',document_json='{}',review_json=NULL,result_json=? WHERE id=?").run(json(result),value.id);
      db.prepare('INSERT INTO system_events(event_type,status,message,payload,created_at) VALUES(?,?,?,?,?)').run('warehouse_excel_import','success',result.message,json({importId:value.id,fileHash:value.file_hash,actorId:current.id,newLocations:summary.newLocations,newProducts:summary.newProducts,mappingChanges:summary.mappingChanges,stocktakes:summary.stocktakes}),clock().toISOString());
      return result;
    });
    try{const saved=backupService.createBackup({kind:'manual',source:'after-excel-import'});if(saved.excel?.lastError)result.warning='Import saved. Excel refresh failed: '+saved.excel.lastError;}
    catch(e){result.warning='Import saved. The new backup could not be created: '+e.message;}
    return result;
  }
  return {upload,review,apply};
}
