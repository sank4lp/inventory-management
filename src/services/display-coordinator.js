import {randomUUID,createHash} from 'node:crypto';
import {withTransaction} from '../db.js';
export function createDisplayCoordinator({db,hardwareService,operationsService,clock=()=>new Date()}) {
  const activeWork=()=>!!db.prepare("SELECT 1 FROM task_lines WHERE execution_state='working' LIMIT 1").get();
  const cell=id=>db.prepare('SELECT c.*,ctrl.address AS controller_address,ctrl.heartbeat_status,ctrl.active AS controller_active,ctrl.configured_at AS controller_configured_at FROM cells c LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?').get(id);
  const workGeneration=id=>db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(id)?.generation||null;
  function clear(row) {
    let deferred=false;
    for(const target of JSON.parse(row.targets_json)) {
      if(target.status!=='sent')continue;
      const c=target.cellId?cell(target.cellId):target.hardware;
      const controller=db.prepare('SELECT address,module_count,configured_at FROM controllers WHERE id=?').get(target.controllerId||null);
      if(target.controllerSnapshot!==JSON.stringify(controller||null))continue;
      if(target.cellId&&target.bindingRevision!==c?.binding_revision)continue;
      if(!c||c.controller_id!==target.controllerId||c.hardware_channel!==target.channel||workGeneration(target.cellId)!==target.workGeneration)continue;
      if(activeWork()){deferred=true;continue;}
      hardwareService.clearCellQuantity(c,{source:'display_coordinator',displayId:row.id,displayActor:row.actor_id});
    }
    db.prepare('UPDATE display_requests SET state=? WHERE id=?').run(deferred?'expiring':'stopped',row.id);
  }
  function expire(){for(const row of db.prepare("SELECT * FROM display_requests WHERE state IN ('active','expiring') AND expires_at<=?").all(clock().toISOString()))clear(row);}
  function view(actor,scope={}) {
    operationsService.actorNow(actor);
    const cells=db.prepare('SELECT id FROM cells WHERE active=1 ORDER BY logical_code').all().map(c=>cell(c.id)).filter(c=>(!scope.cellId||c.id===Number(scope.cellId))&&(!scope.cellIds||scope.cellIds.includes(c.id)));
    return cells.map(c=>{const products=db.prepare(`SELECT b.product_id,p.name,p.unit_of_measure,b.available_quantity AS on_hand,b.reserved_quantity,
      (EXISTS(SELECT 1 FROM work_discrepancies d WHERE d.cell_id=b.cell_id AND d.product_id=b.product_id) OR EXISTS(SELECT 1 FROM stocktake_condition_reviews cr WHERE cr.cell_id=b.cell_id AND cr.state='open')) AS uncertain
      FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.cell_id=? AND (b.available_quantity!=0 OR ?)`).all(c.id,scope.cellId?1:0).filter(p=>!scope.productId||p.product_id===Number(scope.productId));
      return {cell:c,products:products.map(p=>({...p,available:Math.max(0,p.on_hand-p.reserved_quantity)}))};}).filter(r=>scope.kind==='recommendation'||!scope.productId||r.products.length);
  }
  function start(actor,scope,input={}) {
    const a=operationsService.actorNow(actor),id=String(input.requestId||randomUUID());expire();
    const fingerprint=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    const old=db.prepare('SELECT * FROM display_requests WHERE id=?').get(id);if(old){if(old.actor_id!==a.id||old.fingerprint!==fingerprint)throw new Error('This display request belongs to different contents or an account.');return {...old,targets:JSON.parse(old.targets_json),message:'Existing display receipt retrieved; no old command was replayed.'};}
    if(db.prepare("SELECT 1 FROM display_requests WHERE state IN ('active','expiring')").get())throw new Error('Another display is active. Stop your current display or wait for its bounded lifetime.');
    if(activeWork())return {state:'busy',targets:[],message:'Location work is active. Quantities remain on screen; task guidance is unchanged.'};
    const rows=scope.setupTargets?scope.setupTargets.map(cell=>({cell,products:[]})):scope.setupTarget?[{cell:scope.setupTarget,products:[]}]:view(a,scope),targets=[];
    for(const row of rows) {
      const c=row.cell,products=row.products;let status='ready',value='LOC';
      if(!c.controller_id||!c.hardware_channel)status='unmapped';else if(c.controller_active===0||c.heartbeat_status&&c.heartbeat_status!=='online')status='unreachable';
      if(scope.kind==='quantity'){if(products.some(p=>p.uncertain))status=status==='ready'?'uncertain':status;else if(products.length>1)status=status==='ready'?'selection':status;else if(products.length===1){value=products[0].available;if(!Number.isInteger(value)||value<0||value>999)status=status==='ready'?'unsupported':status;}}
      let color='yellow';
      if(scope.kind==='recommendation'){const instructions=scope.instructions.filter(i=>i.cellId===c.id),directions=new Set(instructions.map(i=>i.direction));if(directions.size===1){value=instructions.reduce((n,i)=>n+i.quantity,0);color=instructions[0].direction==='pick'?'green':'red';if(!Number.isInteger(value)||value>999){value='LOC';}}}
      targets.push({color,bindingRevision:c.binding_revision??null,controllerSnapshot:JSON.stringify(db.prepare('SELECT address,module_count,configured_at FROM controllers WHERE id=?').get(c.controller_id||null)||null),cellId:c.id||null,controllerId:c.controller_id,channel:c.hardware_channel,hardware:scope.setupTarget||scope.setupTargets?c:null,workGeneration:workGeneration(c.id||null),status,value});
    }
    const created=clock().toISOString(),expires=new Date(clock().getTime()+120000).toISOString();
    db.prepare('INSERT INTO display_requests(id,actor_id,fingerprint,scope_json,targets_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,a.id,fingerprint,JSON.stringify(scope),JSON.stringify(targets),created,expires);
    for(const target of targets){if(!['ready','selection','unsupported','uncertain'].includes(target.status))continue;const c=target.cellId?cell(target.cellId):target.hardware;const numeric=target.status==='ready'&&target.value!=='LOC';const result=hardwareService.showCellQuantity(c,target.status==='ready'?target.value:'LOC',target.color||'yellow',{source:'display_coordinator',displayId:id,displayActor:a.id});target.status=result.ok&&!result.degraded?'sent':'unreachable';target.numeric=numeric&&Number.isInteger(target.value)&&target.value<=999;}
    db.prepare('UPDATE display_requests SET targets_json=? WHERE id=?').run(JSON.stringify(targets),id);
    return {id,state:'active',targets,expires_at:expires,message:'Display command sent for eligible locations for up to two minutes. A sent command is not physical confirmation.'};
  }
  function stop(actor,id){const a=operationsService.actorNow(actor),row=db.prepare('SELECT * FROM display_requests WHERE id=? AND actor_id=?').get(id,a.id);if(!row)throw new Error('This display belongs to another operator.');if(['active','expiring'].includes(row.state))clear(row);return {message:'Only this display request was stopped. Newer task guidance was preserved.'};}
  function status(actor){const a=operationsService.actorNow(actor);expire();return db.prepare("SELECT id,actor_id,state,expires_at,scope_json,targets_json FROM display_requests WHERE state IN ('active','expiring')").all().map(r=>({...r,canStop:r.actor_id===a.id,scope:JSON.parse(r.scope_json),targets:JSON.parse(r.targets_json)}));}
  return {start,stop,status,view,expire};
}
