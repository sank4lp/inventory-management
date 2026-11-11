import {normalizeIdentity,productIdentity} from './workbook.js';

export function migrateBusinessImports(db){
 const columns=new Set(db.prepare('PRAGMA table_info(products)').all().map(r=>r.name));
 for(const [name,type] of [['cos_sec','TEXT'],['part_no','TEXT'],['mpi_status','TEXT'],['cicp_id','TEXT'],['review_dt','TEXT'],['capacity_pending','INTEGER NOT NULL DEFAULT 0'],['merged_into','INTEGER REFERENCES products(id)'],['merged_at','TEXT']])if(!columns.has(name))db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);
 for(const table of ['task_lines','transactions','work_reports'])if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='merged_from_product_id'))db.exec(`ALTER TABLE ${table} ADD COLUMN merged_from_product_id INTEGER REFERENCES products(id)`);
 db.exec(`CREATE TABLE IF NOT EXISTS product_import_aliases(identity_key TEXT PRIMARY KEY,cos_sec TEXT NOT NULL,part_no TEXT NOT NULL,main_product_id INTEGER NOT NULL REFERENCES products(id),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);`);
 db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS product_business_identity ON products(UPPER(TRIM(cos_sec)),UPPER(TRIM(part_no)),UPPER(TRIM(mpi_status))) WHERE active=1 AND cos_sec IS NOT NULL AND part_no IS NOT NULL AND mpi_status IS NOT NULL;
 CREATE TABLE IF NOT EXISTS business_imports(id TEXT PRIMARY KEY,actor_id INTEGER NOT NULL,dataset TEXT NOT NULL,kind TEXT NOT NULL,file_name TEXT NOT NULL,document_json TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,choices_json TEXT,review_token TEXT,state_hash TEXT,result_json TEXT);
 CREATE TABLE IF NOT EXISTS vouchers(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,number TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(kind,number));
 CREATE TABLE IF NOT EXISTS voucher_lines(id INTEGER PRIMARY KEY,voucher_id INTEGER NOT NULL REFERENCES vouchers(id),line_key TEXT NOT NULL UNIQUE,source_json TEXT NOT NULL,source_hash TEXT NOT NULL,product_id INTEGER REFERENCES products(id),mpi_status TEXT,condition TEXT,task_id INTEGER REFERENCES tasks(id),status TEXT NOT NULL,message TEXT,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS business_import_events(id INTEGER PRIMARY KEY,import_id TEXT,actor_id INTEGER NOT NULL,event_type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS stocktake_capacity_inputs(run_id INTEGER NOT NULL REFERENCES stocktake_runs(id),product_id INTEGER NOT NULL REFERENCES products(id),items_per_cell REAL,applied_at TEXT,PRIMARY KEY(run_id,product_id));`);
}
export function businessProductLabel(p){return p.cos_sec?`${p.cos_sec} · ${p.part_no} · ${p.mpi_status} · ${p.name}`:p.name;}
export function aliasMain(db,row){const p=db.prepare('SELECT p.* FROM product_import_aliases a JOIN products p ON p.id=a.main_product_id WHERE a.identity_key=?').get(productIdentity(row))||null;if(p&&!p.active)throw new Error('The merged product is inactive. Restore it before importing its old identities.');return p;}
export function productVariants(db,row){const main=aliasMain(db,row)||row;return db.prepare('SELECT * FROM products WHERE active=1 AND UPPER(TRIM(cos_sec))=? AND UPPER(TRIM(part_no))=? ORDER BY mpi_status,id').all(normalizeIdentity(main.cos_sec),normalizeIdentity(main.part_no));}
export function productStockTotal(db,id){return Number(db.prepare('SELECT COALESCE(SUM(b.available_quantity),0) n FROM inventory_balances b JOIN cells c ON c.id=b.cell_id WHERE b.product_id=? AND c.active=1').get(id).n);}
export function activateBusinessFields(db){
 if(db.prepare("SELECT value FROM app_metadata WHERE key='business_product_fields'").get()?.value==='1')return;
 const definitions=[['cos_sec','Section (cos_sec)','text'],['part_no','Part Number (part_no)','text'],['mpi_status','MPI Status (mpi_status)','text'],['cicp_id','CICP ID (cicp_id)','text'],['review_dt','Review Date (review_dt)','date']];
 for(const [index,[column,label,type]] of definitions.entries())db.prepare(`INSERT OR IGNORE INTO product_field_definitions(field_key,source_column,label,data_type,field_kind,system_role,required,searchable,filterable,reportable,visible,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,'core',?,0,1,1,1,1,1,?,?,?)`).run('product.'+column,column,label,type,'business_'+column,index*10,new Date().toISOString(),new Date().toISOString());
 db.prepare("UPDATE product_field_definitions SET label='Nomenclature (nomen1)' WHERE source_column='name'").run();
 db.prepare("UPDATE product_field_definitions SET label='AU (au)' WHERE source_column='unit_of_measure'").run();
 db.prepare("UPDATE product_field_definitions SET label='Product identity (Section / Part / MPI)' WHERE source_column='sku'").run();
 db.prepare("UPDATE product_field_definitions SET visible=0,required=0 WHERE source_column IN ('brand','category','variant','description')").run();
 db.prepare("INSERT INTO app_metadata(key,value,updated_at) VALUES('business_product_fields','1',?) ON CONFLICT(key) DO UPDATE SET value='1',updated_at=excluded.updated_at").run(new Date().toISOString());
}
export function saveBusinessProduct(db,values,{existing=null,capacity=null,confirmed=false}={}){
 const remembered=aliasMain(db,values);
 if(remembered&&productIdentity(values)!==productIdentity(remembered))throw new Error(`This identity belongs to ${remembered.name}. Use Section ${remembered.cos_sec} and Part Number ${remembered.part_no} to add or edit its MPI variants.`);
 const mpi=normalizeIdentity(values.mpi_status),section=String(values.cos_sec||'').trim(),part=String(values.part_no||'').trim(),name=String(values.nomen1||'').trim(),unit=String(values.au||'').trim();
 if(!section||!part||!name||!unit||!mpi)throw new Error('Complete Section, Part Number, Nomenclature, AU and MPI Status.');
 if(existing&&normalizeIdentity(existing.unit_of_measure)!==normalizeIdentity(unit))throw new Error('AU differs from this product. Use Change unit on its product page before importing.');
 const hasCapacity=capacity!==null&&capacity!==undefined&&String(capacity).trim()!=='';
 if(hasCapacity&&(!Number.isFinite(Number(capacity))||Number(capacity)<=0||Number(capacity)>1e9))throw new Error('Items per location must be greater than zero.');
 const duplicate=productVariants(db,values).find(p=>normalizeIdentity(p.mpi_status)===mpi&&p.id!==existing?.id);
 if(duplicate)throw new Error('This Section, Part Number and MPI Status already exists. Select that row instead.');
 activateBusinessFields(db);
 const sku=`${section} · ${part} · ${mpi}`;
 if(existing){
  db.prepare('UPDATE products SET cos_sec=?,part_no=?,name=?,mpi_status=?,cicp_id=?,review_dt=?,sku=?,items_per_cell=?,capacity_pending=? WHERE id=?').run(section,part,name,mpi,values.cicp_id||null,values.review_dt||null,sku,hasCapacity?Number(capacity):existing.items_per_cell,hasCapacity?0:existing.capacity_pending,existing.id);
  return db.prepare('SELECT * FROM products WHERE id=?').get(existing.id);
 }
 if(!confirmed)throw new Error('Tick Create product to confirm this new product and MPI status.');
 const result=db.prepare('INSERT INTO products(sku,name,brand,unit_of_measure,items_per_cell,capacity_pending,cos_sec,part_no,mpi_status,cicp_id,review_dt,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)').run(sku,name,'',unit,hasCapacity?Number(capacity):1,hasCapacity?0:1,section,part,mpi,values.cicp_id||null,values.review_dt||null,new Date().toISOString());
 return db.prepare('SELECT * FROM products WHERE id=?').get(Number(result.lastInsertRowid));
}
export function saveCountCapacity(db,{runId,productId,value}){
 if(value==null||String(value).trim()==='')return;
 const n=Number(value);if(!Number.isFinite(n)||n<=0||n>1e9)throw new Error('Items per location must be greater than zero.');
 db.prepare('INSERT INTO stocktake_capacity_inputs(run_id,product_id,items_per_cell) VALUES(?,?,?) ON CONFLICT(run_id,product_id) DO UPDATE SET items_per_cell=excluded.items_per_cell,applied_at=NULL').run(runId,productId,n);
}
export function finishCountCapacities(db,runId){
 const rows=db.prepare(`SELECT o.lines_json FROM stocktake_items i JOIN stocktake_observations o ON o.id=i.latest_observation WHERE i.run_id=? AND i.state='counted'`).all(runId);
 const maximum=new Map();for(const row of rows)for(const line of JSON.parse(row.lines_json))maximum.set(line.productId,Math.max(maximum.get(line.productId)||0,Number(line.actual)||0));
 for(const [id,max] of maximum){
  const p=db.prepare('SELECT * FROM products WHERE id=?').get(id),choice=db.prepare('SELECT * FROM stocktake_capacity_inputs WHERE run_id=? AND product_id=?').get(runId,id);
  if(choice?.applied_at||!p.capacity_pending&&!choice?.items_per_cell)continue;
  const capacity=choice?.items_per_cell||max;if(capacity<=0)continue;
  db.prepare('UPDATE products SET items_per_cell=?,capacity_pending=0 WHERE id=?').run(capacity,id);
  db.prepare('INSERT INTO stocktake_capacity_inputs(run_id,product_id,items_per_cell,applied_at) VALUES(?,?,?,?) ON CONFLICT(run_id,product_id) DO UPDATE SET applied_at=excluded.applied_at').run(runId,id,capacity,new Date().toISOString());
 }
}
