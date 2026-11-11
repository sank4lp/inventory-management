import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {sectionStockReport,movementWindow,movementClass,saveMovementThreshold,movementSpeedReport,stocktakeDepthReport,reportStocktakes,customerMovementReport,voucherCustomers} from '../src/modules/reports/data.js';

const at='2026-11-10T12:00:00.000Z';
function fixture(t){
  const cwd=process.cwd(),dir=mkdtempSync(join(tmpdir(),'business-reports-'));process.chdir(dir);
  const db=createDatabase({hashPassword,allowDemoInventorySeed:false});
  t.after(()=>{db.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});});
  const admin=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get(),operator=db.prepare("SELECT * FROM users WHERE role='operator' LIMIT 1").get();
  const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id LIMIT 3').all();
  db.prepare('UPDATE products SET active=0').run();let n=0;
  const product=(section='01',mpi='CURRENT',unit='NOS',part='P1')=>{
    const id=Number(db.prepare('INSERT INTO products(sku,name,brand,unit_of_measure,items_per_cell,cos_sec,part_no,mpi_status,active,created_at) VALUES(?,?,?,?,?,?,?,?,1,?)').run('REPORT-'+(++n),'Report item '+n,'',unit,100,section,part,mpi,at).lastInsertRowid);
    return db.prepare('SELECT * FROM products WHERE id=?').get(id);
  };
  const stock=(p,cell,q)=>db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,?,0)').run(p.id,cell.id,q);
  const task=(owner=admin,type='pick')=>Number(db.prepare("INSERT INTO tasks(type,status,summary,created_by,assignee_id,started_at,last_touched_at) VALUES(?,'in_progress','Report test',?,?,?,?)").run(type,owner.id,owner.id,at,at).lastInsertRowid);
  const movement=(p,q,{type='pick',taskId=null,when=at,owner=admin,unit=p.unit_of_measure}={})=>db.prepare('INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,task_id,reason,created_at,unit_of_measure) VALUES(?,?,?,?,?,?,?,?,?)').run(type,p.id,cells[0].id,q,owner.id,taskId,'Test movement',when,unit);
  const count=(products,{status='completed',assignee=admin,pending=false}={})=>{
    const id=Number(db.prepare('INSERT INTO stocktake_runs(title,scope_json,timezone,created_by,created_at,status) VALUES(?,?,?,?,?,?)').run('Test stocktake','{"mode":"warehouse"}','Asia/Kolkata',admin.id,at,status).lastInsertRowid);
    for(const [index,lines]of products.entries()){
      const item=Number(db.prepare("INSERT INTO stocktake_items(run_id,cell_id,location_json,assignee_id,state) VALUES(?,?,?,?,'counted')").run(id,cells[index].id,'{}',assignee.id).lastInsertRowid),token='count-'+id+'-'+item;
      db.prepare('INSERT INTO stocktake_attempts(id,item_id,counter_id,generation,baseline_json,started_at,method,identity_evidence) VALUES(?,?,?,1,?,?,?,?)').run(token,item,assignee.id,'{}',at,'manual','Test');
      const data=lines.map(([p,actual,recorded=actual])=>({productId:p.id,name:p.name,sku:p.sku,catalogSnapshot:{cos_sec:p.cos_sec,part_no:p.part_no,mpi_status:p.mpi_status},unit:p.unit_of_measure,actual,recorded}));
      db.prepare("INSERT INTO stocktake_observations(id,attempt_id,item_id,counter_id,lines_json,unknown_json,received_at,status) VALUES(?,?,?,?,?,'[]',?,'approved')").run(token,token,item,assignee.id,JSON.stringify(data),at);
      db.prepare('UPDATE stocktake_items SET latest_observation=? WHERE id=?').run(token,item);
    }
    if(pending)db.prepare('INSERT INTO stocktake_items(run_id,cell_id,location_json,assignee_id) VALUES(?,?,?,?)').run(id,cells[2].id,'{}',assignee.id);
    return id;
  };
  return {db,admin,operator,cells,product,stock,task,movement,count};
}

test('Section stock reports filter exactly and never combine units',t=>{
  const f=fixture(t),a=f.product(),b=f.product('01','OBT','kg'),other=f.product('010');
  f.stock(a,f.cells[0],4);f.stock(a,f.cells[1],6);f.stock(b,f.cells[0],3);f.stock(other,f.cells[0],20);
  const report=sectionStockReport(f.db,f.admin,{section:'01'});assert.equal(report.rows.length,2);
  assert.deepEqual(report.totals.sort((a,b)=>a.unit.localeCompare(b.unit)),[{unit:'kg',quantity:3},{unit:'NOS',quantity:10}]);
  assert.equal(sectionStockReport(f.db,f.admin,{section:'missing'}).rows.length,0);
});

test('movement periods include 15 days and clamp calendar months at month ends',()=>{
  assert.equal(movementWindow('fortnight',at).fromAt,'2026-10-26T12:00:00.000Z');
  assert.equal(movementWindow('month','2026-03-31T12:00:00Z').fromAt,'2026-02-28T12:00:00.000Z');
  assert.equal(movementWindow('quarter','2026-05-31T12:00:00Z').fromAt,'2026-02-28T12:00:00.000Z');
  assert.throws(()=>movementWindow('year',at),/Choose/);
});

test('movement thresholds include both boundary values in Normal and persist with scope and revision checks',t=>{
  const f=fixture(t),p=f.product(),input={productId:p.id,period:'day',direction:'pick',slowBelow:10,fastAbove:100,unit:'NOS',revision:0};
  const saved=saveMovementThreshold(f.db,f.admin,input);
  assert.deepEqual([0,9,10,11,99,100,101].map(n=>movementClass(n,saved)),['Slow','Slow','Normal','Normal','Normal','Normal','Fast']);
  assert.equal(movementClass(20,null),'Not configured');
  assert.throws(()=>saveMovementThreshold(f.db,f.operator,input),/permitted|permission/i);
  assert.throws(()=>saveMovementThreshold(f.db,f.admin,input),/changed/);
  assert.throws(()=>saveMovementThreshold(f.db,f.admin,{...input,revision:1,fastAbove:9}),/threshold/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM movement_threshold_events').get().n,1);
});

test('movement speed uses posted partial work and signed task corrections, excluding counts and reservations',t=>{
  const f=fixture(t),p=f.product(),taskId=f.task();f.stock(p,f.cells[0],400);
  f.movement(p,-20,{taskId});f.movement(p,5,{type:'adjustment',taskId});
  f.movement(p,300,{type:'adjustment'});f.movement(p,7,{type:'put'});
  f.movement(p,-500,{when:'2026-11-01T12:00:00.000Z'});
  saveMovementThreshold(f.db,f.admin,{productId:p.id,period:'day',direction:'pick',slowBelow:10,fastAbove:100,unit:'NOS',revision:0});
  const row=movementSpeedReport(f.db,f.admin,{period:'day',end:at,direction:'pick'}).rows[0];
  assert.equal(row.picked,15);assert.equal(row.put,7);assert.equal(row.classification,'Normal');
  assert.equal(movementSpeedReport(f.db,f.admin,{period:'day',end:at,direction:'combined'}).rows[0].quantity,22);
  assert.equal(movementSpeedReport(f.db,f.operator,{period:'day',end:at,direction:'pick'}).rows[0].quantity,0);
});

test('unit changes disable stale thresholds and unresolved unit history is not silently combined',t=>{
  const f=fixture(t),p=f.product();
  saveMovementThreshold(f.db,f.admin,{productId:p.id,period:'week',direction:'pick',slowBelow:10,fastAbove:100,unit:'NOS',revision:0});
  f.movement(p,-10);f.db.prepare("UPDATE products SET unit_of_measure='BOX' WHERE id=?").run(p.id);
  const rows=movementSpeedReport(f.db,f.admin,{period:'week',end:at,direction:'pick'}).rows;
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.classification==='Not configured'));
  assert.ok(rows.find(r=>r.unit_of_measure==='NOS').conversionError);
});

test('stocktake Depth uses saved per-bin counts and saved identities, with selectable Range basis',t=>{
  const f=fixture(t),a=f.product(),b=f.product('01','OBT'),zero=f.product('02','CURRENT','NOS','P2');
  const runId=f.count([[[a,3,5],[b,2],[zero,0,2]],[[a,4]]]);
  f.stock(a,f.cells[0],999);f.db.prepare("UPDATE products SET name='Changed name',mpi_status='NFP' WHERE id=?").run(a.id);
  const report=stocktakeDepthReport(f.db,f.admin,{runId,rangeBy:'product'});
  assert.equal(report.range,1);assert.equal(report.rows.find(r=>r.product_id===a.id).quantity,9);
  assert.equal(report.rows.find(r=>r.product_id===a.id).mpi_status,'CURRENT: 7 · OBT: 2');assert.equal(report.rows.find(r=>r.product_id===a.id).name,a.name);
  assert.equal(stocktakeDepthReport(f.db,f.admin,{runId,rangeBy:'mpi'}).range,2);
  assert.equal(report.partial,false);assert.equal(report.confirmed,2);assert.deepEqual(stocktakeDepthReport(f.db,f.admin,{runId,rangeBy:'mpi',section:'01'}).sections,['01','02']);
  f.db.prepare("UPDATE stocktake_observations SET unknown_json='[\"Unidentified box\"]' WHERE item_id IN (SELECT id FROM stocktake_items WHERE run_id=?)").run(runId);
  assert.equal(stocktakeDepthReport(f.db,f.admin,{runId,rangeBy:'mpi'}).unidentifiedBins,2);
  assert.throws(()=>stocktakeDepthReport(f.db,f.operator,{runId,rangeBy:'product'}),/available/);
});

test('unfinished stocktakes and recounts do not report missing counts as zero or double-count old observations',t=>{
  const f=fixture(t),p=f.product(),runId=f.count([[[p,5]]],{status:'in_progress',assignee:f.operator,pending:true});
  assert.equal(reportStocktakes(f.db,f.operator).length,1);
  let report=stocktakeDepthReport(f.db,f.operator,{runId,rangeBy:'product'});assert.equal(report.partial,true);assert.equal(report.confirmed,1);assert.equal(report.rows[0].quantity,5);
  f.db.prepare("UPDATE stocktake_items SET state='recheck' WHERE run_id=? AND latest_observation IS NOT NULL").run(runId);
  report=stocktakeDepthReport(f.db,f.operator,{runId,rangeBy:'product'});assert.equal(report.confirmed,0);assert.equal(report.rows.length,0);assert.equal(report.range,0);
});


test('customer identifiers match partial records but contradictory identities stay separate',()=>{
 const lines=[{values:{cust:'Depot A',cust_code:'001',sus_no:'S01'}},{values:{cust:'depot a'}},{values:{sus_no:'S01'}},{values:{cust:'Depot B',cust_code:'002'}}];
 const groups=voucherCustomers(lines);assert.equal(groups.length,2);assert.equal(groups[0].lines.length,3);assert.ok(groups.every(g=>!g.conflict));
 const conflict=voucherCustomers([{values:{cust:'Depot A',cust_code:'001'}},{values:{cust:'Depot B',cust_code:'001'}}]);
 assert.equal(conflict.length,2);assert.ok(conflict.every(g=>g.conflict));
});

test('customer reports total actual voucher movements, keep UNS visible and enforce operator scope',t=>{
 const f=fixture(t),p=f.product(),taskId=f.task(f.admin,'put'),pick=f.task(f.admin,'pick');
 const add=(kind,task,customer='Depot A',status='created')=>{
  const v=Number(f.db.prepare('INSERT INTO vouchers(kind,number,created_by,created_at) VALUES(?,?,?,?)').run(kind,'V'+kind+customer+status,f.admin.id,at).lastInsertRowid);
  const values={cos_sec:'01',part_no:'P1',nomen1:p.name,au:'NOS',cust:customer,cust_code:customer==='Depot A'?'001':'002',sus_no:customer==='Depot A'?'S01':'S02',qty_iss:100,qty_r:100,rv_dt:'2026-11-10',issu_dt:'2026-11-09',condition:status==='excluded_uns'?'UNS':'S'};
  f.db.prepare('INSERT INTO voucher_lines(voucher_id,line_key,source_json,source_hash,product_id,mpi_status,condition,task_id,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(v,'L'+v,JSON.stringify(values),'hash',p.id,'CURRENT',values.condition,task,status,at);
 };
 add('received',taskId);add('issue',pick);add('received',null,'Depot A','excluded_uns');add('issue',null,'Depot B','pending');
 f.movement(p,12,{type:'put',taskId});f.movement(p,-2,{type:'adjustment',taskId});f.movement(p,-4,{taskId:pick});f.movement(p,500,{type:'put'});
 const r=customerMovementReport(f.db,f.admin);assert.equal(r.rows.length,4);assert.equal(r.customers.length,2);
 const depot=r.summaries.find(s=>s.cust==='Depot A');assert.equal(depot.put,10);assert.equal(depot.pick,4);
 assert.equal(r.rows.find(row=>row.condition==='UNS').recorded,0);assert.equal(r.rows.find(row=>row.condition==='UNS').status,'UNS — excluded');
 assert.equal(customerMovementReport(f.db,f.admin,{customerId:depot.id}).rows.length,3);
 assert.equal(customerMovementReport(f.db,f.admin,{section:'010'}).rows.length,0);
 assert.equal(customerMovementReport(f.db,f.operator).rows.length,0);
 f.db.prepare('UPDATE tasks SET assignee_id=? WHERE id=?').run(f.operator.id,taskId);
 assert.equal(customerMovementReport(f.db,f.operator).rows.length,1);
});

test('report CSV escapes formula-like identities and UI escapes imported product text',async t=>{
 const {reportCsv,renderSectionReport,SECTION_COLUMNS}=await import('../src/modules/reports/pages.js');
 const f=fixture(t),p=f.product();f.db.prepare('UPDATE products SET name=?,part_no=? WHERE id=?').run('<script>alert(1)</script>','=1+1',p.id);
 const r=sectionStockReport(f.db,f.admin);const csv=reportCsv(SECTION_COLUMNS,r.rows);
 assert.ok(csv.startsWith('\ufeff'));assert.ok(csv.includes('"\'=1+1"'));assert.ok(reportCsv([['q','Quantity']],[{q:-2}]).includes('"-2"'));
 const html=renderSectionReport(f.db,f.admin,new URL('http://local/reports/sections'),r);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('report routes offer both Range modes, filtered exports and combined thresholds',async t=>{
 const {businessReportRoutes}=await import('../src/modules/reports/routes.js');const {routeAllowed}=await import('../src/modules/access/routes-policy.js');
 const f=fixture(t),p=f.product(),other=f.product('02'),run=f.count([[[p,3]]]);f.stock(p,f.cells[0],4);f.stock(other,f.cells[0],8);
 const request=(path,method='GET',input=null,user=f.admin)=>{let body='',status=0,headers;const response={writeHead:(code,h)=>{status=code;headers=h;},end:value=>{body=String(value||'');}};assert.equal(businessReportRoutes({method,parsedForm:input},response,new URL(path,'http://local'),user,{db:f.db}),true);return {body,status,headers};};
 for(const mode of ['product','mpi']){const r=request('/reports/stocktake-range?run='+run+'&rangeBy='+mode);assert.equal(r.status,200);assert.ok(r.body.includes('Depth'));assert.equal(routeAllowed(f.admin,'GET','/reports/stocktake-range'),true);}
 const exported=request('/reports/sections?section=01&export=csv');assert.equal(exported.status,200);assert.ok(exported.body.includes(p.name));assert.ok(!exported.body.includes(other.name));assert.equal(exported.headers['Cache-Control'],'no-store');
 const save=request('/api/reports/movement-threshold','POST',{productId:p.id,period:'day',slowBelow:10,fastAbove:100,unit:'NOS',revision:0});assert.equal(JSON.parse(save.body).threshold.direction,'combined');
 assert.throws(()=>request('/api/reports/movement-threshold','POST',{productId:p.id},f.operator),/permitted|permission/i);
 assert.equal(request('/reports/stocktake-range?run='+run+'&rangeBy=mpi','GET',null,f.operator).status,400);
 assert.equal(request('/reports/stocktake-range?run=9999&export=csv').status,400);
 assert.equal(request('/reports/movement-speed?period=day').status,200);
 assert.equal(request('/reports/customers').status,200);
});
