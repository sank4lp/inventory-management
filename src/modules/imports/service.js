import {stageProductMerge} from './merge.js';
import {createHash,randomUUID} from 'node:crypto';
import {withTransaction} from '../../db.js';
import {currentActor,effectiveUser} from '../access/service.js';
import {can,assertCan} from '../access/catalog.js';
import {parseBusinessWorkbook,normalizeIdentity,importDate,productIdentity} from './workbook.js';
import {productVariants,productStockTotal,saveBusinessProduct,businessProductLabel,aliasMain} from './catalog.js';
import {stocktakeDefaultDueDate,readDeadlineDefaults} from '../../services/deadline-defaults.js';

const json=JSON.stringify,hash=v=>createHash('sha256').update(json(v)).digest('hex');
export function createBusinessImportService({db,operationsService,stocktakingService,backupService,clock=()=>new Date()}){
 const now=()=>clock().toISOString(),dataset=()=>db.prepare("SELECT value FROM app_metadata WHERE key='dataset_generation'").get()?.value||'';
 const actor=(u,kind)=>currentActor(db,u,['products','merge'].includes(kind)?'products.edit':'work.assign');
 const variants=row=>productVariants(db,row);
 const stamp=()=>hash([dataset(),...['product_import_aliases','product_unit_conversions','products','inventory_balances','tasks','task_lines','work_reservations','work_reports','vouchers','voucher_lines','stocktake_runs','stocktake_items','stocktake_item_counters','access_roles','cells','location_shelves','location_warehouses','product_field_definitions'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),db.prepare('SELECT id,name,username,role,role_id,status,session_version FROM users ORDER BY id').all(),db.prepare('SELECT * FROM controllers ORDER BY id').all().map(({last_seen_at,heartbeat_status,...c})=>c)]);
 function event(a,id,type,payload){db.prepare('INSERT INTO business_import_events(import_id,actor_id,event_type,payload,created_at) VALUES(?,?,?,?,?)').run(id,a.id,type,json(payload),now());}
 function draft(a,id){const d=db.prepare('SELECT * FROM business_imports WHERE id=? AND actor_id=?').get(String(id),a.id);if(!d)throw new Error('Import not found for this account. Upload the file again.');if(d.dataset!==dataset())throw new Error('Shed data was replaced. Upload the file again.');if(!d.result_json&&d.expires_at<now())throw new Error('This import expired. Upload the file again.');return d;}
 function people(permission){return db.prepare("SELECT * FROM users WHERE status='active' ORDER BY name,id").all().map(u=>effectiveUser(db,u)).filter(u=>can(u,permission)).map(u=>({id:u.id,name:u.name,role:u.role_name||u.role}));}
 function describe(a,d){
  const document=JSON.parse(d.document_json);
  return {id:d.id,kind:d.kind,fileName:d.file_name,columns:document.columns,rows:document.rows.map(row=>({...row,rememberedProduct:aliasMain(db,row.values),variants:variants(row.values).map(p=>({...p,label:businessProductLabel(p),currentStock:productStockTotal(db,p.id)})),existingLine:row.lineKey?db.prepare('SELECT id,status,task_id,source_hash,message FROM voucher_lines WHERE line_key=?').get(d.kind+':'+row.lineKey)||null:null})),
   choices:{products:db.prepare('SELECT * FROM products WHERE active=1 AND cos_sec IS NOT NULL ORDER BY name,mpi_status').all().map(p=>({...p,label:businessProductLabel(p)})),taskDueMinutes:readDeadlineDefaults(db)[d.kind==='received'?'putMinutes':'pickMinutes'],assignees:people('work.execute'),counters:people('count.perform'),cells:db.prepare('SELECT id,COALESCE(NULLIF(display_name,\'\'),logical_code) name FROM cells WHERE active=1 ORDER BY logical_code').all(),mpi:[...new Set(['CURRENT','OBT','NFP','OBE',...db.prepare('SELECT DISTINCT mpi_status FROM products WHERE active=1 AND mpi_status IS NOT NULL').all().map(p=>p.mpi_status)])],dueDate:stocktakeDefaultDueDate(db,clock(),db.prepare("SELECT value FROM app_metadata WHERE key='warehouse_timezone'").get()?.value||'Asia/Kolkata')}};
 }
 function upload(user,input){
  const a=actor(user,input.kind),document=parseBusinessWorkbook(Buffer.from(String(input.base64||''),'base64'),input.kind),id=randomUUID();
  db.prepare('INSERT INTO business_imports(id,actor_id,dataset,kind,file_name,document_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,a.id,dataset(),input.kind,String(input.fileName||'Excel').slice(0,200),json(document),now(),new Date(clock().getTime()+86400000).toISOString());
  return describe(a,draft(a,id));
 }
 function productFor(a,row,choice,kind,initial){
  const values={...row.values},main=aliasMain(db,values);
  if(main){const otherIdentity=productIdentity(values)!==productIdentity(main);values.cos_sec=main.cos_sec;values.part_no=main.part_no;values.nomen1=main.name;if(otherIdentity){values.cicp_id=main.cicp_id;values.review_dt=main.review_dt;}}
  const siblings=initial.byIdentity.get(productIdentity(values))||[];
  if(kind!=='products'){values.mpi_status=kind==='received'?'CURRENT':normalizeIdentity(choice.mpiStatus);values.cicp_id=main?.cicp_id??values.comp_no;values.review_dt=main?.review_dt??null;if(!values.mpi_status)throw new Error('Choose MPI Status for this Issue row.');}
  let existing=variants(values).find(p=>normalizeIdentity(p.mpi_status)===normalizeIdentity(values.mpi_status));
  if(kind==='products'&&!existing){
   if(choice.sourceProductId==='new')existing=null;
   else if(choice.sourceProductId){existing=siblings.find(p=>p.id===Number(choice.sourceProductId));if(!existing)throw new Error('Choose an existing MPI row for this Section and Part Number.');}
   else if(siblings.length===1)existing=siblings[0];
   else if(siblings.length>1)throw new Error('Choose which existing MPI row to change, or choose Add new status.');
  }
  if(kind!=='products'&&existing){
   if(normalizeIdentity(values.au)!==normalizeIdentity(existing.unit_of_measure))throw new Error('Voucher AU does not match the product. Correct it or use Change unit first.');
   if(kind==='received'&&existing.capacity_pending){assertCan(a,'products.capacity');if(!choice.itemsPerCell)throw new Error('Enter items per location before creating Put work.');return saveBusinessProduct(db,{...values,nomen1:existing.name,cicp_id:existing.cicp_id,review_dt:existing.review_dt},{existing,capacity:choice.itemsPerCell});}
   return existing;
  }
  assertCan(a,existing?'products.edit':'products.add');
  if(existing&&choice.itemsPerCell&&Number(choice.itemsPerCell)!==existing.items_per_cell)assertCan(a,'products.capacity');
  if(kind==='received'&&!choice.itemsPerCell)throw new Error('Enter items per location for the new CURRENT product.');
  const product=saveBusinessProduct(db,values,{existing,capacity:choice.itemsPerCell,confirmed:choice.createConfirmed===true});
  if(existing&&normalizeIdentity(existing.mpi_status)!==normalizeIdentity(product.mpi_status))operationsService.stageMpiChange(a,product.id,existing.mpi_status,product.mpi_status);
  return product;
 }
 function stageCount(a,d,row,product,choice,input,validated){
  const recorded=productStockTotal(db,product.id),expected=Number(row.values.stok_ser);
  if(input.skipStocktake===true)return {recorded,expected,stocktakeId:null,stocktakeSkipped:true};
  if(Math.abs(recorded-expected)<1e-6)return {recorded,expected,stocktakeId:null};
  assertCan(a,'count.manage');
  const known=db.prepare('SELECT b.cell_id FROM inventory_balances b JOIN cells c ON c.id=b.cell_id WHERE b.product_id=? AND c.active=1 AND b.available_quantity!=0').all(product.id).map(r=>r.cell_id);
  let cells=Array.isArray(choice.cellIds)&&choice.cellIds.length?choice.cellIds.map(Number):known.length?known:db.prepare('SELECT id FROM cells WHERE active=1').all().map(c=>c.id);
  if(!cells.length)throw new Error('Add shed locations before creating this product stocktake.');
  if(!Array.isArray(input.counterIds)||!input.counterIds.length)throw new Error('Choose a counter for the stock differences.');
  const validationKey=json(cells);
  if(!validated.has(validationKey)){stocktakingService.validateExcelCount(a,{mode:'selected',cellIds:cells,counterIds:input.counterIds,dueDate:input.countDueDate});validated.add(validationKey);}
  return {recorded,expected,stocktakeId:null,countCells:cells};
 }
 function voucher(a,kind,number){
  db.prepare('INSERT OR IGNORE INTO vouchers(kind,number,created_by,created_at) VALUES(?,?,?,?)').run(kind,number,a.id,now());return db.prepare('SELECT * FROM vouchers WHERE kind=? AND number=?').get(kind,number);
 }
 function storeLine(v,d,row,{product=null,taskId=null,status,message,mpi=null}){
  db.prepare(`INSERT INTO voucher_lines(voucher_id,line_key,source_json,source_hash,product_id,mpi_status,condition,task_id,status,message,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(line_key) DO UPDATE SET source_json=excluded.source_json,source_hash=excluded.source_hash,product_id=COALESCE(excluded.product_id,voucher_lines.product_id),mpi_status=excluded.mpi_status,condition=excluded.condition,task_id=COALESCE(excluded.task_id,voucher_lines.task_id),status=excluded.status,message=excluded.message,updated_at=excluded.updated_at`).run(v.id,d.kind+':'+row.lineKey,json(row.values),row.fingerprint,product?.id||null,mpi||product?.mpi_status||null,row.values.condition||null,taskId,status,message||'',now());
 }
 function stage(a,d,input){
  const doc=JSON.parse(d.document_json),choices=new Map((input.rows||[]).map(r=>[Number(r.row),r])),results=[];
  if(input.merges?.length&&d.kind!=='products'&&d.kind!=='merge')throw Error('Merge products from Products or the product import first.');
  const merges=(input.merges||[]).map(merge=>{assertCan(a,'products.edit');const result=stageProductMerge(db,a,merge,{rows:doc.rows,choices:input.rows,now:now()});operationsService.refreshMergedInstructions(a,result.taskIds);return result;});
  const initial=db.prepare('SELECT * FROM products WHERE active=1').all();
  initial.byId=new Map(initial.map(p=>[p.id,p]));initial.byIdentity=new Map();
  for(const p of initial){const key=productIdentity(p);if(!initial.byIdentity.has(key))initial.byIdentity.set(key,[]);initial.byIdentity.get(key).push(p);}
  const countValidations=new Set();
  const groups=new Map();for(const row of doc.rows){const key=d.kind==='products'&&!choices.get(row.row)?.skip?productIdentity(aliasMain(db,row.values)||row.values)+'|'+normalizeIdentity(row.values.mpi_status):String(row.row);groups.set(key,[...(groups.get(key)||[]),row]);}
  if(choices.size!==(input.rows||[]).length)throw new Error('Resolve each file row once.');
  const touchedProducts=new Set();
  for(const group of groups.values()){
   const row=group.find(r=>productIdentity(r.values)===productIdentity(aliasMain(db,r.values)||r.values))||group[0];
   const choice={...(choices.get(row.row)||{})},result={row:row.row,values:row.values,mpiStatus:d.kind==='received'?'CURRENT':normalizeIdentity(d.kind==='issue'?choice.mpiStatus:row.values.mpi_status),status:'blocked'};
   const prior=row.lineKey?db.prepare('SELECT * FROM voucher_lines WHERE line_key=?').get(d.kind+':'+row.lineKey):null;
   db.exec('SAVEPOINT business_row');
   try{
    if(group.length>1){
     if(group.some(r=>r.errors.length))throw Error(group.flatMap(r=>r.errors).join(' '));
     if(new Set(group.map(r=>normalizeIdentity(r.values.au))).size!==1)throw Error('Merged rows have different units. Correct the file before importing.');
     for(const field of ['itemsPerCell','sourceProductId']){const values=[...new Set(group.map(r=>choices.get(r.row)?.[field]).filter(v=>v!=null&&v!=='' ).map(String))];if(field==='itemsPerCell'&&aliasMain(db,row.values))continue;if(values.length>1)throw Error('Use the same '+(field==='itemsPerCell'?'items per location':'MPI row choice')+' for merged rows.');if(values.length)choice[field]=values[0];}
     choice.createConfirmed=group.every(r=>choices.get(r.row)?.createConfirmed===true);choice.cellIds=[...new Set(group.flatMap(r=>choices.get(r.row)?.cellIds||[]))];
    }
    if(choice.skip===true){result.status='excluded';result.message='Excluded from this import.';}
    else if(row.errors.length)throw new Error(row.errors.join(' '));
    else if(prior?.task_id&&prior.source_hash===row.fingerprint){Object.assign(result,{status:'existing',taskId:prior.task_id,message:'Task already created.'});}
    else if(d.kind==='received'&&normalizeIdentity(row.values.condition)==='UNS'){
     if(prior?.task_id)throw new Error('This voucher line already has a task. Resolve that task before changing its condition to UNS.');
     const v=voucher(a,d.kind,row.voucherNumber);storeLine(v,d,row,{status:'excluded_uns',mpi:'CURRENT',message:'Unserviceable (UNS) — no Put task.'});Object.assign(result,{status:'excluded_uns',voucherId:v.id,message:'Unserviceable (UNS) — no Put task.'});
    }else{
     if(prior?.task_id&&choice.updateConfirmed!==true)throw new Error(`Voucher row changed. Tick Update unstarted task to update Task #${prior.task_id}.`);
     const product=productFor(a,row,choice,d.kind,initial);result.productName=product.name;
     if(d.kind==='products'){
      if(touchedProducts.has(product.id))throw new Error('Two source rows would change the same product variant. Choose Add new status for the additional row.');
      const count=stageCount(a,d,{...row,values:{...row.values,stok_ser:group.reduce((n,r)=>n+Number(r.values.stok_ser),0)}},product,choice,input,countValidations),old=initial.byId.get(product.id),change=old&&old.mpi_status!==product.mpi_status?`MPI changes from ${old.mpi_status} to ${product.mpi_status}; open tasks go to review. `:'';Object.assign(result,{status:'ready',productId:product.id,message:change+(count.stocktakeSkipped?'Product only. Stock unchanged; stocktaking skipped.':count.countCells?'Stocktake required.':'Stock matches.'),...count});touchedProducts.add(product.id);
     }else{
      const spec={direction:d.kind==='issue'?'pick':'put',productId:product.id,quantity:row.values[d.kind==='issue'?'qty_iss':'qty_r'],assigneeId:choice.assigneeId||input.assigneeId,dueDuration:choice.dueDuration||input.dueDuration||readDeadlineDefaults(db)[d.kind==='received'?'putMinutes':'pickMinutes'],dueUnit:choice.dueUnit||input.dueUnit||'minutes',note:`${d.kind==='issue'?'Issue':'Received'} Voucher ${row.voucherNumber}${row.values.condition?' · Condition: '+row.values.condition:''}`};
      const task=prior?.task_id?operationsService.stageVoucherUpdate(a,{...spec,taskId:prior.task_id}):operationsService.stageVoucherAssignment(a,spec);
      const v=voucher(a,d.kind,row.voucherNumber);storeLine(v,d,row,{product,taskId:task.taskId,status:'created'});Object.assign(result,{status:'ready',productId:product.id,taskId:task.taskId,voucherId:v.id,message:prior?.task_id?'Update task.':'Create task.'});
     }
    }
    db.exec('RELEASE business_row');
   }catch(error){
    db.exec('ROLLBACK TO business_row; RELEASE business_row');result.message=error.message;
    // Keep failed rows for retry, but never replace the source of an existing task.
    if(d.kind!=='products'&&row.voucherNumber&&!row.errors.length&&!prior?.task_id){const v=voucher(a,d.kind,row.voucherNumber);storeLine(v,d,row,{status:'pending',message:error.message,mpi:d.kind==='received'?'CURRENT':choice.mpiStatus});result.voucherId=v.id;}
   }
   for(const member of group)results.push({...result,row:member.row,values:member.values,...(group.length>1?{mergedRows:group.map(r=>r.row),message:result.message+' Combined stock from '+group.length+' rows.'}:{})});
  }
  const differences=[...new Map(results.filter(r=>r.status==='ready'&&r.countCells).map(r=>[r.productId,r])).values()];
  if(differences.length){
   const productsByCell={};
   for(const row of differences)for(const cell of row.countCells)(productsByCell[cell]??=[]).push(row.productId);
   const created=stocktakingService.stageExcelCount(a,{mode:'selected',cellIds:Object.keys(productsByCell).map(Number),productsByCell,counterIds:input.counterIds,dueDate:input.countDueDate,title:`Import stocktake · ${d.file_name}`,importId:d.id,comparisons:differences.map(r=>({productId:r.productId,recorded:r.recorded,expected:r.expected,sourceRow:r.row}))});
   for(const row of results)if(row.countCells){row.stocktakeId=created.runId;delete row.countCells;}
  }
  return {merges,rows:results.sort((a,b)=>a.row-b.row),ready:results.filter(r=>r.status==='ready').length,blocked:results.filter(r=>r.status==='blocked').length,existing:results.filter(r=>r.status==='existing').length,excluded:results.filter(r=>['excluded','excluded_uns'].includes(r.status)).length};
 }
 function review(user,input){
  const raw=db.prepare('SELECT kind FROM business_imports WHERE id=?').get(String(input.id));if(!raw)throw new Error('Import not found.');const a=actor(user,raw.kind),d=draft(a,input.id);
  if(d.result_json)return {applied:true,...JSON.parse(d.result_json)};
  let result,state;db.exec('BEGIN IMMEDIATE');try{state=stamp();result=stage(a,d,input);}finally{db.exec('ROLLBACK');}
  const token=randomUUID();db.prepare('UPDATE business_imports SET choices_json=?,review_token=?,state_hash=? WHERE id=?').run(json(input),token,state,d.id);return {id:d.id,token,...result};
 }
 function apply(user,input){
  const raw=db.prepare('SELECT kind FROM business_imports WHERE id=?').get(String(input.id));if(!raw)throw new Error('Import not found.');const a=actor(user,raw.kind),d=draft(a,input.id);
  if(d.result_json){if(input.token!==d.review_token)throw new Error('This import was already saved from another review.');return {...JSON.parse(d.result_json),replayed:true};}
  if(input.confirmed!==true||!d.review_token||input.token!==d.review_token)throw new Error('Review the rows and confirm before saving.');
  if(stamp()!==d.state_hash)throw new Error('Stock or tasks changed after this preview. Check the import again before saving.');
  backupService.createBackup({kind:'manual',source:'before-business-import'});
  const result=withTransaction(db,()=>{if(stamp()!==d.state_hash)throw new Error('Shed data changed. Check the import again.');const s=stage(a,d,JSON.parse(d.choices_json));const result={id:d.id,kind:d.kind,...s,message:d.kind==='merge'?'Products merged. Stock, task links and import aliases saved.':`Saved ${s.ready} row(s). ${s.blocked} need attention. ${s.existing} already had tasks. ${s.excluded} excluded.`};event(a,d.id,'applied',result);db.prepare('UPDATE business_imports SET result_json=? WHERE id=?').run(json(result),d.id);return result;});
  try{operationsService.flushGuidance();}catch{result.warning='Saved. LED updates will retry; check controller health.';}return result;
 }
 function list(user){
  const a=currentActor(db,user,'work.view'),all=can(a,'work.team');
  return db.prepare(`SELECT v.*,COUNT(l.id) line_count,SUM(l.status='pending') pending_count,SUM(l.status='excluded_uns') excluded_count FROM vouchers v JOIN voucher_lines l ON l.voucher_id=v.id LEFT JOIN tasks t ON t.id=l.task_id WHERE (? OR t.assignee_id=? OR v.created_by=?) GROUP BY v.id ORDER BY v.id DESC LIMIT 100`).all(all?1:0,a.id,a.id);
 }
 function detail(user,id){
  const a=currentActor(db,user,'work.view'),v=db.prepare('SELECT * FROM vouchers WHERE id=?').get(Number(id));if(!v)throw new Error('Voucher not found.');
  const rows=db.prepare(`SELECT l.*,t.assignee_id,t.status task_status,t.outcome,t.due_at,u.name assigned_to FROM voucher_lines l LEFT JOIN tasks t ON t.id=l.task_id LEFT JOIN users u ON u.id=t.assignee_id WHERE l.voucher_id=? AND (? OR t.assignee_id=? OR ?=?) ORDER BY l.id`).all(v.id,can(a,'work.team')?1:0,a.id,v.created_by,a.id);
  if(!rows.length)throw new Error('This voucher is not assigned to you.');return {...v,rows:rows.map(r=>({...r,values:JSON.parse(r.source_json)}))};
 }
 function saveProduct(user,input){
  const a=currentActor(db,user),existing=input.productId?db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(input.productId)):null;
  if(input.productId&&!existing)throw new Error('Product not found.');
  if(!existing)assertCan(a,'products.add');else if(!can(a,'products.edit')){
   assertCan(a,'products.capacity');for(const [key,column] of [['cos_sec','cos_sec'],['part_no','part_no'],['nomen1','name'],['mpi_status','mpi_status'],['au','unit_of_measure'],['cicp_id','cicp_id'],['review_dt','review_dt']])if(String(input[key]||'')!==String(existing[column]||''))throw new Error('Only product capacity can be changed with this role.');
  }
  const mergedMain=existing&&aliasMain(db,existing);if(mergedMain&&productIdentity(existing)!==productIdentity(input))throw new Error('This product has remembered import identities. Keep its Section and Part Number when editing.');
  if(input.confirmed!==true&&input.confirmed!=='1')throw new Error('Confirm the changes before saving.');
  if(existing&&input.itemsPerCell!=null&&String(input.itemsPerCell)!==String(existing?.items_per_cell??''))assertCan(a,'products.capacity');
  const result=withTransaction(db,()=>{
   const values={cos_sec:input.cos_sec,part_no:input.part_no,nomen1:input.nomen1,au:input.au,mpi_status:input.mpi_status,cicp_id:input.cicp_id,review_dt:importDate(input.review_dt)};
   const product=saveBusinessProduct(db,values,{existing,capacity:input.itemsPerCell,confirmed:true});
   if(mergedMain)for(const sibling of productVariants(db,product))db.prepare('UPDATE products SET name=? WHERE id=?').run(product.name,sibling.id);
   const affected=existing&&existing.mpi_status!==product.mpi_status?operationsService.stageMpiChange(a,product.id,existing.mpi_status,product.mpi_status):[];
   event(a,null,'product_saved',{productId:product.id,before:existing,after:product,reviewTasks:affected});return {productId:product.id,redirectUrl:'/products/'+product.id};
  });
  try{operationsService.flushGuidance();}catch{}return result;
 }
 function mergeReview(user,input){
  const a=actor(user,'merge'),id=randomUUID();db.prepare("INSERT INTO business_imports(id,actor_id,dataset,kind,file_name,document_json,created_at,expires_at) VALUES(?,?,?,'merge','Product merge',?,?,?)").run(id,a.id,dataset(),json({rows:[]}),now(),new Date(clock().getTime()+86400000).toISOString());return review(a,{id,merges:[input]});
 }
 return {upload,review,apply,list,detail,saveProduct,mergeReview};
}
