import {withTransaction} from '../../db.js';
import {currentActor} from '../access/service.js';
import {can} from '../access/catalog.js';
import {historicalFactor} from '../operations/corrections.js';
import {createHash} from 'node:crypto';

export const MOVEMENT_PERIODS=[['day','Day'],['week','Week'],['fortnight','15 days'],['month','Month'],['quarter','3 months']];
const round=n=>Math.round(n*1e6)/1e6;
const key=value=>String(value??'').trim().toUpperCase();
const parse=value=>JSON.parse(value||'{}');
const fail=message=>{throw Object.assign(new Error(message),{statusCode:400});};

export function migrateBusinessReports(db){
  db.exec(`CREATE TABLE IF NOT EXISTS product_movement_thresholds (
    product_id INTEGER NOT NULL REFERENCES products(id), period TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('pick','put','combined')),
    slow_below REAL NOT NULL CHECK(slow_below>=0), fast_above REAL NOT NULL CHECK(fast_above>=slow_below),
    unit TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
    PRIMARY KEY(product_id,period,direction)
  );
  CREATE TABLE IF NOT EXISTS movement_threshold_events (
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, actor_id INTEGER NOT NULL,
    before_json TEXT, after_json TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
}

export function movementWindow(period,end=new Date().toISOString()){
  if(!MOVEMENT_PERIODS.some(([id])=>id===period))fail('Choose Day, Week, 15 days, Month or 3 months.');
  const to=new Date(end);if(!Number.isFinite(to.getTime()))fail('Choose a valid report end time.');
  const from=new Date(to);
  if(period==='month'||period==='quarter'){
    const day=from.getUTCDate();from.setUTCDate(1);from.setUTCMonth(from.getUTCMonth()-(period==='month'?1:3));
    const last=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,0)).getUTCDate();from.setUTCDate(Math.min(day,last));
  }else from.setUTCDate(from.getUTCDate()-({day:1,week:7,fortnight:15}[period]));
  return {period,fromAt:from.toISOString(),toAt:to.toISOString()};
}

export function movementClass(quantity,threshold){
  if(!threshold)return 'Not configured';
  return quantity<threshold.slow_below?'Slow':quantity>threshold.fast_above?'Fast':'Normal';
}

export function saveMovementThreshold(db,actor,input){
  return withTransaction(db,()=>{
    const user=currentActor(db,actor,'reports.view');currentActor(db,user,'products.edit');
    const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(input.productId));
    if(!product)fail('Choose an active product.');
    movementWindow(input.period);
    if(!['pick','put','combined'].includes(input.direction))fail('Choose Pick, Put or combined movement.');
    const slow=Number(input.slowBelow),fast=Number(input.fastAbove);
    if([input.slowBelow,input.fastAbove].some(v=>v==null||String(v).trim()==='')||![slow,fast].every(n=>Number.isFinite(n)&&n>=0&&n<=1e12)||fast<slow)fail('Enter valid thresholds. Fast must be at least the Slow threshold.');
    if(input.unit!==product.unit_of_measure)fail('The product unit changed. Reload before setting thresholds.');
    const old=db.prepare('SELECT * FROM product_movement_thresholds WHERE product_id=? AND period=? AND direction=?').get(product.id,input.period,input.direction);
    if(Number(input.revision)!==(old?.revision||0))fail('These thresholds changed. Reload before saving.');
    const time=new Date().toISOString();
    db.prepare(`INSERT INTO product_movement_thresholds(product_id,period,direction,slow_below,fast_above,unit,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(product_id,period,direction) DO UPDATE SET slow_below=excluded.slow_below,fast_above=excluded.fast_above,unit=excluded.unit,updated_by=excluded.updated_by,updated_at=excluded.updated_at,revision=revision+1`).run(product.id,input.period,input.direction,slow,fast,product.unit_of_measure,user.id,time);
    const saved=db.prepare('SELECT * FROM product_movement_thresholds WHERE product_id=? AND period=? AND direction=?').get(product.id,input.period,input.direction);
    db.prepare('INSERT INTO movement_threshold_events(product_id,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run(product.id,user.id,old?JSON.stringify(old):null,JSON.stringify(saved),time);
    return saved;
  });
}

export function reportSections(db){
  return db.prepare("SELECT DISTINCT TRIM(cos_sec) section FROM products WHERE cos_sec IS NOT NULL AND TRIM(cos_sec)!='' ORDER BY section COLLATE NOCASE").all().map(r=>r.section);
}

function productFilter(product,options){
  return (!options.section||key(product.cos_sec)===key(options.section))&&(!options.productId||product.id===Number(options.productId));
}
function unitTotals(rows,field){
  const totals=new Map();for(const r of rows){const unit=r.unit_of_measure||r.unit;totals.set(unit,round((totals.get(unit)||0)+Number(r[field]||0)));}
  return [...totals].map(([unit,quantity])=>({unit,quantity}));
}

export function sectionStockReport(db,actor,options={}){
  currentActor(db,actor,'reports.view');
  const rows=db.prepare(`SELECT p.*,ROUND(COALESCE(SUM(b.available_quantity),0),6) quantity
    FROM products p LEFT JOIN inventory_balances b ON b.product_id=p.id WHERE p.active=1
    GROUP BY p.id ORDER BY p.cos_sec,p.name,p.mpi_status,p.id`).all().filter(p=>productFilter(p,options));
  return {rows,totals:unitTotals(rows,'quantity'),sections:reportSections(db),generatedAt:new Date().toISOString()};
}

// Match History's access boundary: shared reports never expose another worker's
// task or standalone movement merely because they have Reports access.
function allowedTask(db,actor,task){
  return can(actor,'work.team')||task&&(task.created_by===actor.id||task.assignee_id===actor.id||
    !!db.prepare('SELECT 1 FROM task_assignment_events WHERE task_id=? AND (assignee_id=? OR previous_assignee=?)').get(task.id,actor.id,actor.id));
}

export function recordedMovements(db,actor,{fromAt,toAt,section,productId}={}){
  const user=currentActor(db,actor,'reports.view'),conditions=["(tr.type IN ('pick','put') OR (tr.type='adjustment' AND t.type IN ('pick','put')))"],args=[];
  for(const [value,clause] of [[fromAt,'tr.created_at>=?'],[toAt,'tr.created_at<=?']])if(value){if(!Number.isFinite(Date.parse(value)))fail('Choose a valid report timeframe.');conditions.push(clause);args.push(new Date(value).toISOString());}
  if(fromAt&&toAt&&Date.parse(fromAt)>Date.parse(toAt))fail('The report start must be before its end.');
  const products=new Map(db.prepare('SELECT * FROM products').all().map(p=>[p.id,p]));
  const conversions=new Map();for(const c of db.prepare('SELECT * FROM product_unit_conversions ORDER BY created_at,id').all()){if(!conversions.has(c.product_id))conversions.set(c.product_id,[]);conversions.get(c.product_id).push(c);}
  const conversionContext={products,conversions};
  const tasks=new Map(db.prepare('SELECT id,type,created_by,assignee_id FROM tasks').all().map(t=>[t.id,t]));
  return db.prepare(`SELECT tr.*,t.type task_type FROM transactions tr LEFT JOIN tasks t ON t.id=tr.task_id WHERE ${conditions.join(' AND ')} ORDER BY tr.created_at,tr.id`).all(...args).flatMap(tr=>{
    const p=products.get(tr.product_id);if(!p||!productFilter(p,{section,productId}))return [];
    if(!can(user,'work.team')&&!(tr.task_id?allowedTask(db,user,tasks.get(tr.task_id)):tr.user_id===user.id||tr.performed_by===user.id))return [];
    const direction=tr.type==='adjustment'?tr.task_type:tr.type;
    let quantity=Number(tr.quantity_delta)*(direction==='pick'?-1:1),unit=tr.unit_of_measure||p.unit_of_measure,conversionError=null;
    try{quantity=round(quantity*historicalFactor(db,p.id,unit,tr.created_at,tr.merged_from_product_id,conversionContext));unit=p.unit_of_measure;}catch(error){conversionError=error.message;}
    return [{...tr,product:p,direction,quantity,unit,conversionError}];
  });
}

export function movementSpeedReport(db,actor,{period='month',end,section,productId,direction}={}){
  const user=currentActor(db,actor,'reports.view');
  if(!['pick','put','combined'].includes(direction))fail('Choose which movements to classify.');
  const window=movementWindow(period,end),events=recordedMovements(db,user,{...window,section,productId});
  const products=db.prepare('SELECT * FROM products WHERE active=1 ORDER BY cos_sec,name,mpi_status,id').all().filter(p=>productFilter(p,{section,productId}));
  const grouped=new Map(products.map(p=>[`${p.id}:${p.unit_of_measure}`,{...p,product_id:p.id,picked:0,put:0,conversionError:null}]));
  for(const event of events){
    const id=`${event.product.id}:${event.unit}`;
    if(!grouped.has(id))grouped.set(id,{...event.product,unit_of_measure:event.unit,product_id:event.product.id,picked:0,put:0,conversionError:event.conversionError});
    const row=grouped.get(id);row[event.direction==='pick'?'picked':'put']=round(row[event.direction==='pick'?'picked':'put']+event.quantity);if(event.conversionError)row.conversionError=event.conversionError;
  }
  const thresholds=new Map(db.prepare('SELECT * FROM product_movement_thresholds WHERE period=? AND direction=?').all(period,direction).map(t=>[t.product_id,t]));
  const rows=[...grouped.values()].map(p=>{
    const saved=thresholds.get(p.id);
    const threshold=saved&&saved.unit===p.unit_of_measure&&!p.conversionError?saved:null;
    const quantity=direction==='pick'?p.picked:direction==='put'?p.put:round(p.picked+p.put);
    return {...p,quantity,threshold,savedThreshold:saved||null,classification:movementClass(quantity,threshold)};
  });
  return {rows,...window,direction,scope:can(user,'work.team')?'All work':'My work',sections:reportSections(db),totals:unitTotals(rows,'quantity')};
}

function permittedCountItems(db,actor,runId){
  return db.prepare('SELECT * FROM stocktake_items WHERE run_id=? ORDER BY id').all(runId).filter(i=>can(actor,'count.team')||i.assignee_id===actor.id||
    !!db.prepare('SELECT 1 FROM stocktake_item_counters WHERE item_id=? AND user_id=?').get(i.id,actor.id)||
    !!db.prepare('SELECT 1 FROM stocktake_attempts WHERE item_id=? AND counter_id=?').get(i.id,actor.id));
}
export function reportStocktakes(db,actor){
  const user=currentActor(db,actor,'reports.view');
  return db.prepare('SELECT * FROM stocktake_runs ORDER BY id DESC').all().filter(r=>can(user,'count.team')||permittedCountItems(db,user,r.id).length);
}

export function stocktakeDepthReport(db,actor,{runId,section,rangeBy}={}){
  const user=currentActor(db,actor,'reports.view');
  if(!['product','mpi'].includes(rangeBy))fail('Choose how MPI variants count toward Range.');
  const run=reportStocktakes(db,user).find(r=>r.id===Number(runId));if(!run)fail('Choose a stocktake available to you.');
  const items=permittedCountItems(db,user,run.id),groups=new Map();let confirmed=0,legacyDetails=false,unidentifiedBins=0;
  for(const item of items){
    const observation=item.latest_observation&&db.prepare('SELECT * FROM stocktake_observations WHERE id=? AND item_id=?').get(item.latest_observation,item.id);
    if(!observation||item.state!=='counted'||!['matched','approved','linked'].includes(observation.status))continue;
    confirmed++;
    if(JSON.parse(observation.unknown_json||'[]').length)unidentifiedBins++;
    for(const line of parse(observation.lines_json)){
      const current=db.prepare('SELECT * FROM products WHERE id=?').get(line.productId)||{};
      const identity=line.catalogSnapshot||{cos_sec:current.cos_sec,part_no:current.part_no,mpi_status:current.mpi_status};
      if(!line.catalogSnapshot)legacyDetails=true;
      if(section&&key(identity.cos_sec)!==key(section))continue;
      const rowKey=JSON.stringify([line.productId,line.unit,identity.cos_sec,identity.part_no,identity.mpi_status]);
      if(!groups.has(rowKey))groups.set(rowKey,{product_id:line.productId,name:line.name,sku:line.sku,...identity,unit_of_measure:line.unit,quantity:0,recorded:0,bins:[],lastCounted:null});
      const row=groups.get(rowKey);row.quantity=round(row.quantity+line.actual);row.recorded=round(row.recorded+line.recorded);row.bins.push(item.cell_id);row.lastCounted=[row.lastCounted,observation.counted_at||observation.received_at].filter(Boolean).sort().at(-1);
    }
  }
  const details=[...groups.values()].sort((a,b)=>String(a.cos_sec||'').localeCompare(String(b.cos_sec||''))||a.name.localeCompare(b.name));
  const sections=[...new Set(items.flatMap(item=>{
    const o=item.latest_observation&&db.prepare('SELECT lines_json FROM stocktake_observations WHERE id=?').get(item.latest_observation);
    return o?parse(o.lines_json).map(l=>l.catalogSnapshot?.cos_sec||db.prepare('SELECT cos_sec FROM products WHERE id=?').get(l.productId)?.cos_sec).filter(Boolean):[];
  }))].sort();
  const combined=new Map();
  for(const row of details){
    const identity=row.cos_sec&&row.part_no?[key(row.cos_sec),key(row.part_no)]:row.product_id;
    const id=JSON.stringify([identity,row.unit_of_measure]);
    if(!combined.has(id))combined.set(id,{...row,quantity:0,recorded:0,bins:[],mpiDepths:new Map()});
    const entry=combined.get(id);entry.quantity=round(entry.quantity+row.quantity);entry.recorded=round(entry.recorded+row.recorded);
    entry.bins=[...new Set([...entry.bins,...row.bins])];entry.mpiDepths.set(row.mpi_status||'Unspecified',round((entry.mpiDepths.get(row.mpi_status||'Unspecified')||0)+row.quantity));
  }
  const rows=rangeBy==='mpi'?details:([...combined.values()].map(r=>({...r,mpi_status:[...r.mpiDepths].map(([mpi,n])=>`${mpi}: ${n}`).join(' · ')})));
  const range=new Set(rows.filter(r=>r.quantity>0).map(r=>JSON.stringify([r.cos_sec&&r.part_no?[key(r.cos_sec),key(r.part_no)]:r.product_id,...(rangeBy==='mpi'?[key(r.mpi_status)]:[])]))).size;
  return {run,rows,details,range,rangeBy,confirmed,total:items.length,excluded:items.filter(i=>i.state==='excluded').length,unidentifiedBins,partial:confirmed!==items.filter(i=>i.state!=='excluded').length||run.status!=='completed',legacyDetails,totals:unitTotals(rows,'quantity'),sections,scope:can(user,'count.team')?'Full stocktake':'My assigned bins'};
}

// The three voucher identifiers describe one customer. Connect partial records
// only when their identifiers agree; conflicting identities stay separate.
export function voucherCustomers(lines){
  const parents=lines.map((_,i)=>i),tokens=new Map(),find=i=>parents[i]===i?i:(parents[i]=find(parents[i]));
  lines.forEach((line,i)=>{
    for(const field of ['cust','cust_code','sus_no'])if(key(line.values[field])){
      const token=field+':'+key(line.values[field]);
      if(tokens.has(token))parents[find(i)]=find(tokens.get(token));else tokens.set(token,i);
    }
  });
  const connected=new Map();lines.forEach((line,i)=>{const id=find(i);connected.set(id,[...(connected.get(id)||[]),line]);});
  const groups=new Map();
  for(const entries of connected.values()){
    const values=Object.fromEntries(['cust','cust_code','sus_no'].map(field=>[field,[...new Set(entries.map(l=>key(l.values[field])).filter(Boolean))]]));
    const conflict=Object.values(values).some(v=>v.length>1);
    for(const line of entries){
      const identity=Object.fromEntries(Object.keys(values).map(field=>[field,conflict?key(line.values[field]):values[field][0]||'']));
      const id=createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24);
      if(!groups.has(id))groups.set(id,{id,...Object.fromEntries(Object.keys(values).map(field=>[field,conflict?line.values[field]||'':entries.find(l=>key(l.values[field])===identity[field])?.values[field]||''])),conflict,lines:[]});
      const customer=groups.get(id);customer.lines.push(line);line.customer=customer;
    }
  }
  return [...groups.values()].sort((a,b)=>String(a.cust||a.cust_code||a.sus_no).localeCompare(String(b.cust||b.cust_code||b.sus_no)));
}

export function customerMovementReport(db,actor,{customerId,section}={}){
  const user=currentActor(db,actor,'reports.view');
  const tasks=new Map(db.prepare('SELECT * FROM tasks').all().map(t=>[t.id,t]));
  const lines=db.prepare(`SELECT l.*,v.kind,v.number,v.created_by voucher_creator,v.created_at imported_at
    FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id ORDER BY v.id DESC,l.id`).all()
    .filter(l=>can(user,'work.team')||(l.task_id?allowedTask(db,user,tasks.get(l.task_id)):l.voucher_creator===user.id))
    .map(l=>({...l,values:parse(l.source_json)}));
  const customers=voucherCustomers(lines),events=recordedMovements(db,user),byTask=new Map();
  for(const e of events)if(e.task_id)byTask.set(e.task_id,[...(byTask.get(e.task_id)||[]),e]);
  const rows=[],summaries=new Map();
  for(const line of lines){
    if(customerId&&line.customer.id!==customerId||section&&key(line.values.cos_sec)!==key(section))continue;
    const direction=line.kind==='issue'?'pick':'put',task=tasks.get(line.task_id),movements=byTask.get(line.task_id)||[],byUnit=new Map();
    for(const event of movements){if(event.direction!==direction)continue;byUnit.set(event.unit,round((byUnit.get(event.unit)||0)+event.quantity));}
    if(!byUnit.size)byUnit.set(line.values.au||'—',0);
    const quantity=Number(line.values[line.kind==='issue'?'qty_iss':'qty_r']||0);
    let firstUnit=true;
    for(const [unit,recorded] of byUnit){
      rows.push({...line.values,voucher_id:line.voucher_id,voucher:line.number,voucher_date:line.values[line.kind==='issue'?'issu_dt':'rv_dt'],kind:line.kind,direction,product_id:line.product_id,mpi_status:line.mpi_status||'—',requested:firstUnit?quantity:null,recorded,recorded_unit:unit,task_id:line.task_id,status:line.status==='excluded_uns'?'UNS — excluded':task?.status||line.status,customer_id:line.customer.id,customer_conflict:line.customer.conflict,conversionError:movements.some(e=>e.conversionError)});
      firstUnit=false;
      const id=line.customer.id+':'+unit;
      if(!summaries.has(id)){const {lines,...customer}=line.customer;summaries.set(id,{...customer,unit,put:0,pick:0});}
      const summary=summaries.get(id);summary[direction]=round(summary[direction]+recorded);
    }
  }
  return {rows,summaries:[...summaries.values()],customers:customers.map(({lines,...c})=>c),sections:[...new Set(lines.map(l=>l.values.cos_sec).filter(Boolean))].sort(),scope:can(user,'work.team')?'All work':'My work',generatedAt:new Date().toISOString(),conflicts:customers.some(c=>c.conflict)};
}
