import {assertCan} from '../access/catalog.js';
import {normalizeIdentity,productIdentity} from './workbook.js';
import {aliasMain,productVariants,saveBusinessProduct,productStockTotal} from './catalog.js';

// Called inside the preview rollback or confirmed import transaction only.
export function stageProductMerge(db,actor,input,{rows=[],choices=[],now=new Date().toISOString()}={}){
 const byRow=new Map(rows.map(r=>[r.row,r])),byChoice=new Map(choices.map(c=>[Number(c.row),c]));
 const selectedRows=(input.rows||[]).map(n=>{const r=byRow.get(Number(n));if(!r||r.errors.length)throw Error('Correct the selected Excel rows before merging.');return r;});
 const selectedProducts=[...new Set((input.productIds||[]).map(Number))].map(id=>{const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);if(!p||!p.cos_sec)throw Error('Choose active products with Section and Part Number.');return p;});
 let main=input.mainProductId?db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(input.mainProductId)):null;
 const mainRow=input.mainRow?byRow.get(Number(input.mainRow)):null;
 if(!main&&!mainRow)throw Error('Choose the main product to keep.');
 if(main&&!main.cos_sec)throw Error('The main product needs Section and Part Number.');
 if(mainRow){if(!selectedRows.includes(mainRow))throw Error('Select the main Excel row for merging.');main=aliasMain(db,mainRow.values)||productVariants(db,mainRow.values).find(p=>normalizeIdentity(p.mpi_status)===normalizeIdentity(mainRow.values.mpi_status));}
 if(main){main=aliasMain(db,main)||main;if(!selectedProducts.some(p=>p.id===main.id))selectedProducts.push(main);}
 const identities=new Map([...selectedProducts,...selectedRows.map(r=>r.values)].map(v=>[productIdentity(v),v]));
 if(identities.size<2)throw Error('Select at least two different product identities.');
 const name=String(input.name||'').trim();if(!name||name.length>500||/[\u0000-\u001f]/.test(name))throw Error('Enter the name to keep, up to 500 characters.');
 const unit=normalizeIdentity(main?.unit_of_measure||mainRow?.values.au);
 const sources=new Map();
 for(const value of identities.values()){
  if(normalizeIdentity(value.unit_of_measure||value.au)!==unit)throw Error('Products use different units. Convert their units before merging.');
  for(const p of productVariants(db,value)){if(normalizeIdentity(p.unit_of_measure)!==unit)throw Error('All MPI variants must use the same unit before merging.');sources.set(p.id,p);}
 }
 // Prevent relabelling the instructions while a person is physically using them.
 const cells=new Set();for(const id of sources.keys())for(const b of db.prepare('SELECT cell_id FROM inventory_balances WHERE product_id=? AND available_quantity!=0').all(id))cells.add(b.cell_id);
 for(const id of sources.keys()){
  if(db.prepare('SELECT 1 FROM cell_turns c JOIN task_lines l ON l.id=c.line_id WHERE l.product_id=?').get(id)||db.prepare("SELECT 1 FROM tasks t JOIN task_lines l ON l.task_id=t.id WHERE l.product_id=? AND t.completed_at IS NULL AND t.assignment_state='started' AND t.guidance_paused=0 AND t.attention=0").get(id))throw Error('Pause the active Pick/Put for these products before merging.');
  if(db.prepare("SELECT 1 FROM stocktake_items i,json_each(COALESCE(i.required_products_json,'[]')) p WHERE i.state='counting' AND p.value=?").get(id))throw Error('Finish or pause the active bin count before merging these products.');
  if(db.prepare("SELECT 1 FROM stocktake_items i JOIN stocktake_runs r ON r.id=i.run_id WHERE i.state='counting' AND (json_extract(r.scope_json,'$.productId')=? OR (json_extract(r.scope_json,'$.productId') IS NULL AND i.cell_id IN (SELECT cell_id FROM inventory_balances WHERE product_id=? AND available_quantity!=0)))").get(id,id))throw Error('Finish or pause the active bin count before merging these products.');
 }
 if(!main){assertCan(actor,'products.add');const choice=byChoice.get(mainRow.row)||{};main=saveBusinessProduct(db,{...mainRow.values,nomen1:name},{confirmed:choice.createConfirmed===true,capacity:choice.itemsPerCell});sources.set(main.id,main);}
 const mainIdentity=productIdentity(main),targets=new Map(productVariants(db,main).map(p=>[normalizeIdentity(p.mpi_status),p])),mappings=[],before=[...sources.values()];
 for(const row of selectedRows){const mpi=normalizeIdentity(row.values.mpi_status);if(targets.has(mpi))continue;assertCan(actor,'products.add');const created=saveBusinessProduct(db,{...main,nomen1:name,au:main.unit_of_measure,mpi_status:mpi},{confirmed:byChoice.get(row.row)?.createConfirmed===true,capacity:main.capacity_pending?null:main.items_per_cell});targets.set(mpi,created);}
 for(const p of sources.values()){
  const mpi=normalizeIdentity(p.mpi_status);let target=targets.get(mpi);
  if(!target){assertCan(actor,'products.add');target=saveBusinessProduct(db,{...main,nomen1:name,au:main.unit_of_measure,mpi_status:mpi},{confirmed:true,capacity:main.capacity_pending?null:main.items_per_cell});targets.set(mpi,target);}
  if(p.id===target.id)continue;
  mappings.push({from:p.id,to:target.id,mpi,quantity:productStockTotal(db,p.id)});
  for(const b of db.prepare('SELECT * FROM inventory_balances WHERE product_id=?').all(p.id)){
   cells.add(b.cell_id);db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,?) ON CONFLICT(product_id,cell_id) DO UPDATE SET available_quantity=ROUND(available_quantity+excluded.available_quantity,6),reserved_quantity=ROUND(reserved_quantity+excluded.reserved_quantity,6)').run(target.id,b.cell_id,b.available_quantity,b.reserved_quantity);
  }
  db.prepare('DELETE FROM inventory_balances WHERE product_id=?').run(p.id);
  for(const table of ['task_lines','transactions','work_reports'])db.prepare(`UPDATE ${table} SET merged_from_product_id=COALESCE(merged_from_product_id,product_id),product_id=? WHERE product_id=?`).run(target.id,p.id);
  db.prepare('UPDATE voucher_lines SET product_id=? WHERE product_id=?').run(target.id,p.id);
  for(const d of db.prepare('SELECT * FROM work_discrepancies WHERE product_id=?').all(p.id))db.prepare('INSERT INTO work_discrepancies(cell_id,product_id,reason,updated_at) VALUES(?,?,?,?) ON CONFLICT(cell_id,product_id) DO UPDATE SET reason=reason||char(10)||excluded.reason,updated_at=excluded.updated_at').run(d.cell_id,target.id,d.reason,now);
  db.prepare('DELETE FROM work_discrepancies WHERE product_id=?').run(p.id);
  db.prepare('UPDATE products SET active=0,merged_into=?,merged_at=? WHERE id=?').run(target.id,now,p.id);
 }
 // Flatten aliases (including earlier merges) without discarding original identities.
 const ids=[...sources.keys()];for(const id of ids)db.prepare('UPDATE product_import_aliases SET main_product_id=? WHERE main_product_id=?').run(main.id,id);
 for(const p of [...identities.values(),...sources.values(),main])db.prepare('INSERT INTO product_import_aliases(identity_key,cos_sec,part_no,main_product_id,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET main_product_id=excluded.main_product_id').run(productIdentity(p),p.cos_sec,p.part_no,main.id,actor.id,now);
 for(const target of targets.values())db.prepare('UPDATE products SET name=? WHERE id=?').run(name,target.id);
 const taskIds=new Set();for(const target of targets.values())for(const t of db.prepare("SELECT DISTINCT t.id FROM tasks t JOIN task_lines l ON l.task_id=t.id WHERE l.product_id=? AND t.completed_at IS NULL").all(target.id))taskIds.add(t.id);
 for(const id of taskIds){
  db.prepare('UPDATE tasks SET plan_revision=plan_revision+1,assignment_generation=assignment_generation+1 WHERE id=?').run(id);
  db.prepare('UPDATE task_lines SET revision=revision+1,assignment_generation=(SELECT assignment_generation FROM tasks WHERE id=?) WHERE task_id=?').run(id,id);
  db.prepare("INSERT INTO task_assignment_events(task_id,actor_id,event_type,generation,assignee_id,payload,created_at) SELECT id,?,'products_merged',assignment_generation,assignee_id,?,? FROM tasks WHERE id=?").run(actor.id,JSON.stringify({mainProductId:main.id,name,mappings}),now,id);
 }
 // Pending counts must get a fresh baseline for the combined stock. Completed audit records stay intact.
 const remap=new Map(mappings.map(m=>[m.from,m.to]));
 for(const run of db.prepare("SELECT * FROM stocktake_runs WHERE status NOT IN ('completed','closed')").all()){
  const scope=JSON.parse(run.scope_json),scoped=ids.includes(scope.productId)||[...targets.values()].some(p=>p.id===scope.productId);
  if(scope.productId&&!scoped)continue;
  const affected=db.prepare("SELECT * FROM stocktake_items WHERE run_id=? AND state!='excluded'").all(run.id).filter(i=>scoped||cells.has(i.cell_id)||JSON.parse(i.required_products_json||'[]').some(id=>ids.includes(id)));if(!affected.length)continue;
  if(remap.has(scope.productId))scope.productId=remap.get(scope.productId);
  if(scope.productsByCell)for(const cell of Object.keys(scope.productsByCell))scope.productsByCell[cell]=[...new Set(scope.productsByCell[cell].map(id=>remap.get(id)||id))];
  db.prepare('UPDATE stocktake_runs SET scope_json=?,revision=revision+1 WHERE id=?').run(JSON.stringify(scope),run.id);
  for(const item of affected){
    if(item.required_products_json)db.prepare('UPDATE stocktake_items SET required_products_json=? WHERE id=?').run(JSON.stringify([...new Set(JSON.parse(item.required_products_json).map(id=>remap.get(id)||id))]),item.id);
    db.prepare('DELETE FROM stocktake_reused_counts WHERE item_id=?').run(item.id);
    db.prepare("UPDATE stocktake_items SET generation=generation+1,state='pending',latest_observation=NULL,note='Products merged. Count the combined stock.' WHERE id=?").run(item.id);db.prepare('DELETE FROM stocktake_display_claims WHERE item_id=?').run(item.id);}
  for(const id of ids)db.prepare('DELETE FROM stocktake_capacity_inputs WHERE run_id=? AND product_id=?').run(run.id,id);
  db.prepare("INSERT INTO stocktake_events(run_id,actor_id,event_type,payload,created_at) VALUES(?,?,'products_merged',?,?)").run(run.id,actor.id,JSON.stringify({mappings,items:affected.map(i=>i.id)}),now);
 }
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='display_requests'").get())for(const display of db.prepare("SELECT * FROM display_requests WHERE state='active'").all()){const scope=JSON.parse(display.scope_json);if(['quantity','items_per_location','capacity_available','capacity_total'].includes(scope.kind)&&JSON.parse(display.targets_json).some(t=>cells.has(t.cellId)))db.prepare('UPDATE display_requests SET expires_at=? WHERE id=?').run(now,display.id);}
 const aliases=db.prepare('SELECT cos_sec,part_no FROM product_import_aliases WHERE main_product_id=? ORDER BY cos_sec,part_no').all(main.id);
 const result={mainProductId:main.id,name,identity:mainIdentity,aliases,mappings,taskIds:[...taskIds],variants:[...targets.values()].map(p=>({id:p.id,mpi:p.mpi_status,quantity:productStockTotal(db,p.id),unit:p.unit_of_measure}))};
 db.prepare("INSERT INTO business_import_events(actor_id,event_type,payload,created_at) VALUES(?,'products_merged',?,?)").run(actor.id,JSON.stringify({before,...result}),now);
 return result;
}
