import {activeWorkGuidance,displayOwner} from '../modules/operations/guidance.js';
import {assertCan,can} from "../modules/access/catalog.js";
import {randomUUID,createHash} from 'node:crypto';
import {withTransaction} from '../db.js';
export function createDisplayCoordinator({db,hardwareService,operationsService,clock=()=>new Date()}) {
  const mixedColors=['amber','cyan','white','green','red'];
  const numberDisplayKinds=new Set(['quantity','capacity_total','capacity_available']);
  const overrideDisplayKinds=new Set([...numberDisplayKinds,'locate']);
  const activeWork=id=>activeWorkGuidance(db,id);
  const cell=id=>db.prepare('SELECT c.*,ctrl.address AS controller_address,ctrl.heartbeat_status,ctrl.active AS controller_active,ctrl.configured_at AS controller_configured_at FROM cells c LEFT JOIN controllers ctrl ON ctrl.id=c.controller_id WHERE c.id=?').get(id);
  const workGeneration=id=>db.prepare('SELECT generation FROM work_guidance WHERE cell_id=?').get(id)?.generation||null;
  function clear(row) {
    const scope=JSON.parse(row.scope_json);
    const restoreCells=[];
    for(const target of JSON.parse(row.targets_json)) {
      if(target.status!=='sent')continue;
      if(scope.overrideWork&&target.cellId)restoreCells.push(target.cellId);
      const c=target.cellId?cell(target.cellId):target.hardware;
      const controller=db.prepare('SELECT address,module_count,configured_at FROM controllers WHERE id=?').get(target.controllerId||null);
      if(target.controllerSnapshot!==JSON.stringify(controller||null))continue;
      if(target.cellId&&target.bindingRevision!==c?.binding_revision)continue;
      if(!c||c.controller_id!==target.controllerId||c.hardware_channel!==target.channel||workGeneration(target.cellId)!==target.workGeneration)continue;
      if(activeWork(target.cellId)&&!target.overrodeWork){continue;}
      hardwareService.clearCellQuantity(c,{source:'display_coordinator',displayId:row.id,displayActor:row.actor_id});
    }
    db.prepare("UPDATE display_requests SET state='stopped' WHERE id=?").run(row.id);
    if(scope.overrideWork&&restoreCells.length)operationsService.flushGuidance({restoreCells:[...new Set(restoreCells)]});
  }
  function expire(){
    const now=clock();
    for(const row of db.prepare("SELECT * FROM display_requests WHERE state IN ('active','expiring')").all()) {
      if(row.expires_at<=now.toISOString()){clear(row);continue;}
      const targets=JSON.parse(row.targets_json);
      if(targets.some(t=>t.status==='sent'&&t.cellId&&(workGeneration(t.cellId)!==t.workGeneration||cell(t.cellId)?.binding_revision!==t.bindingRevision))){clear(row);continue;}
      let changed=false;
      for(const target of targets){
        if(target.status!=='sent'||!target.sequence?.length||now.getTime()-Date.parse(target.lastShownAt||row.created_at)<4000)continue;
        const c=cell(target.cellId),nextIndex=(Number(target.sequenceIndex||0)+1)%target.sequence.length,next=target.sequence[nextIndex];
        const result=hardwareService.showCellQuantity(c,next.value,next.color,{source:'display_coordinator',displayId:row.id,displayActor:row.actor_id});
        if(!result.ok||result.degraded)continue;
        target.sequenceIndex=nextIndex;target.value=next.value;target.color=next.color;target.lastShownAt=now.toISOString();changed=true;
      }
      if(changed)db.prepare("UPDATE display_requests SET targets_json=? WHERE id=? AND state IN ('active','expiring')").run(JSON.stringify(targets),row.id);
    }
  }
  function view(actor,scope={}) {
    assertCan(operationsService.actorNow(actor),"locations.view");
    const cells=db.prepare('SELECT id FROM cells WHERE active=1 ORDER BY logical_code').all().map(c=>cell(c.id)).filter(c=>(!scope.cellId||c.id===Number(scope.cellId))&&(!scope.cellIds||scope.cellIds.includes(c.id)));
    return cells.map(c=>{const allProducts=db.prepare(`SELECT b.product_id,p.sku,p.name,p.unit_of_measure,p.items_per_cell,b.available_quantity AS on_hand,b.reserved_quantity,
      (EXISTS(SELECT 1 FROM work_discrepancies d WHERE d.cell_id=b.cell_id AND d.product_id=b.product_id) OR EXISTS(SELECT 1 FROM stocktake_condition_reviews cr WHERE cr.cell_id=b.cell_id AND cr.state='open')) AS uncertain
      FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.cell_id=? AND (b.available_quantity!=0 OR ?)`).all(c.id,scope.cellId?1:0);
      const occupiedFraction=allProducts.reduce((sum,p)=>sum+(p.items_per_cell>0?Math.max(0,p.on_hand)/p.items_per_cell:Infinity),0);
      const products=allProducts.filter(p=>!scope.productId||p.product_id===Number(scope.productId));
      return {cell:c,occupiedFraction,products:products.map(p=>({...p,available:Math.max(0,p.on_hand-p.reserved_quantity)}))};}).filter(r=>scope.kind==='recommendation'||!scope.productId||r.products.length);
  }
  function start(actor,scope,input={}) {
    const a=operationsService.actorNow(actor),id=String(input.requestId||randomUUID());expire();
    const fingerprint=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    const old=db.prepare('SELECT * FROM display_requests WHERE id=?').get(id);if(old){if(old.actor_id!==a.id||old.fingerprint!==fingerprint)throw new Error('This display request belongs to different contents or an account.');return {...old,targets:JSON.parse(old.targets_json),message:'Existing display receipt retrieved; no old command was replayed.'};}
    assertCan(a,scope.setupTarget||scope.setupTargets?(scope.controllerTest?'hardware.test':'locations.bind'):numberDisplayKinds.has(scope.kind)?'locations.quantity':'locations.locate');
    const rows=scope.setupTargets?scope.setupTargets.map(cell=>({cell,products:[]})):scope.setupTarget?[{cell:scope.setupTarget,products:[]}]:view(a,scope),targets=[];
    if(scope.overrideWork&&(!input.confirmOverride||!overrideDisplayKinds.has(scope.kind)))throw new Error('Confirm the PICK/PUT light override before replacing its display.');
    const conflicts=rows.filter(row=>row.cell.id).map(row=>({cellId:row.cell.id,owner:displayOwner(db,row.cell.id)})).filter(row=>row.owner?.kind==='task'&&activeWork(row.cellId));
    if(input.previewOnly)return {state:conflicts.length?'confirmation_required':'ready',conflicts:conflicts.map(row=>({cellId:row.cellId,taskId:row.owner.taskId,name:row.owner.name})),message:conflicts.length?'These cells are showing PICK/PUT work. Confirm before temporarily replacing those lights.':'Quantity display can start without replacing PICK/PUT lights.'};
    if(input.promptOnBusy&&!scope.overrideWork&&conflicts.length)return {state:'confirmation_required',conflicts:conflicts.map(row=>({cellId:row.cellId,taskId:row.owner.taskId,name:row.owner.name})),message:'These cells are showing PICK/PUT work. Confirm before temporarily replacing those lights.'};
    for(const row of rows) {
      const c=row.cell,products=row.products;let status='ready',value='LOC',color='yellow',sequence=null;
      if(!c.controller_id||!c.hardware_channel)status='unmapped';else if(c.controller_active===0||c.heartbeat_status&&c.heartbeat_status!=='online')status='unreachable';
      if(numberDisplayKinds.has(scope.kind)){
        if(products.some(p=>p.uncertain))status=status==='ready'?'uncertain':status;
        else if(products.length){
          const displayValue=p=>scope.kind==='capacity_total'?p.items_per_cell:scope.kind==='capacity_available'?Math.max(0,Math.floor((1-row.occupiedFraction)*p.items_per_cell+1e-9)):p.on_hand;
          if(products.some(p=>!Number.isInteger(displayValue(p))||displayValue(p)<0||displayValue(p)>999))status=status==='ready'?'unsupported':status;
          else if(products.length===1)value=displayValue(products[0]);
          else{sequence=products.map((p,index)=>({productId:p.product_id,sku:p.sku,value:displayValue(p),color:mixedColors[index%mixedColors.length]}));value=sequence[0].value;color=sequence[0].color;}
        }
      }
      const owner=c.id?displayOwner(db,c.id):null,overrodeWork=!!(scope.overrideWork&&overrideDisplayKinds.has(scope.kind)&&owner?.kind==='task'&&activeWork(c.id));
      if(c.id&&activeWork(c.id)&&!overrodeWork)status='busy';
      const utility=db.prepare("SELECT 1 FROM display_requests d,json_each(d.targets_json) t WHERE d.state IN ('active','expiring') AND json_extract(t.value,'$.status')='sent' AND json_extract(t.value,'$.controllerId')=? AND json_extract(t.value,'$.channel')=? AND json_extract(t.value,'$.workGeneration') IS ?").get(c.controller_id,c.hardware_channel,workGeneration(c.id||null));if(utility)status='busy';
      if(scope.kind==='recommendation'){const instructions=scope.instructions.filter(i=>i.cellId===c.id),directions=new Set(instructions.map(i=>i.direction));if(directions.size===1){value=instructions.reduce((n,i)=>n+i.quantity,0);color=instructions[0].direction==='pick'?'green':'red';if(!Number.isInteger(value)||value>999){value='LOC';}}}
      if(status!=='busy'&&c.id)db.prepare("UPDATE work_guidance SET generation=?,delivered=1 WHERE cell_id=? AND json_extract(desired,'$.action')='clear' AND delivered=0").run(randomUUID(),c.id);
      targets.push({color,bindingRevision:c.binding_revision??null,controllerSnapshot:JSON.stringify(db.prepare('SELECT address,module_count,configured_at FROM controllers WHERE id=?').get(c.controller_id||null)||null),cellId:c.id||null,controllerId:c.controller_id,channel:c.hardware_channel,hardware:scope.setupTarget||scope.setupTargets?c:null,workGeneration:workGeneration(c.id||null),status,value,overrodeWork,sequence,sequenceIndex:0,lastShownAt:clock().toISOString()});
    }
    const created=clock().toISOString(),expires=new Date(clock().getTime()+120000).toISOString();
    db.prepare('INSERT INTO display_requests(id,actor_id,fingerprint,scope_json,targets_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,a.id,fingerprint,JSON.stringify(scope),JSON.stringify(targets),created,expires);
    for(const target of targets){if(!['ready','selection','unsupported','uncertain'].includes(target.status))continue;const c=target.cellId?cell(target.cellId):target.hardware;const numeric=target.status==='ready'&&target.value!=='LOC';const result=hardwareService.showCellQuantity(c,target.status==='ready'?target.value:'LOC',target.color||'yellow',{source:'display_coordinator',displayId:id,displayActor:a.id});target.status=result.ok&&!result.degraded?'sent':'unreachable';target.numeric=numeric&&Number.isInteger(target.value)&&target.value<=999;}
    db.prepare('UPDATE display_requests SET targets_json=? WHERE id=?').run(JSON.stringify(targets),id);
    return {id,state:targets.every(t=>t.status==='busy')?'busy':'active',targets,expires_at:expires,message:targets.some(t=>t.status==='sent')?scope.kind==='locate'?'Location light is on for up to two minutes. Task lights return when Locate ends.':'Numbers are showing for up to two minutes. Mixed-product locations alternate colors; task lights return when this display ends.':scope.kind==='locate'?'This location could not be lit. It may be used for stocktaking or another display, or its controller may be offline.':'No display was sent. Check each location’s status; task and count lights were preserved.'};
  }
  function stop(actor,id){const a=operationsService.actorNow(actor),row=db.prepare('SELECT * FROM display_requests WHERE id=? AND actor_id=?').get(id,a.id);if(!row)throw new Error('This display belongs to another operator.');if(['active','expiring'].includes(row.state))clear(row);return {message:'Only this display request was stopped. Newer task guidance was preserved.'};}
  function status(actor){const a=operationsService.actorNow(actor,"locations.view");expire();return db.prepare("SELECT id,actor_id,state,expires_at,scope_json,targets_json FROM display_requests WHERE state IN ('active','expiring')").all().filter(r=>r.actor_id===a.id||can(a,"hardware.view")).map(r=>({...r,canStop:r.actor_id===a.id,scope:JSON.parse(r.scope_json),targets:JSON.parse(r.targets_json)}));}
  return {start,stop,status,view,expire};
}
