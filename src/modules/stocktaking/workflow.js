// Pending and completed indicators never own a physical cell turn.
export function stocktakeScope(db,input) {
  let cells=db.prepare('SELECT c.id,c.shelf_id,s.warehouse_id FROM cells c LEFT JOIN location_shelves s ON s.id=c.shelf_id WHERE c.active=1 ORDER BY c.id').all();
  if(input.warehouseId){
    if(!db.prepare('SELECT 1 FROM location_warehouses WHERE id=?').get(Number(input.warehouseId)))throw new Error('Choose an existing warehouse.');
    cells=cells.filter(c=>c.warehouse_id===Number(input.warehouseId));
  }
  if(input.mode==='shelf'){
    if(!input.shelfId||!db.prepare('SELECT 1 FROM location_shelves WHERE id=?').get(Number(input.shelfId)))throw new Error('Choose a shed / shelf.');
    cells=cells.filter(c=>c.shelf_id===Number(input.shelfId));
  }
  if(['selected','product'].includes(input.mode)){
    const ids=[...new Set((input.cellIds||[]).map(Number))];
    if(ids.length){if(ids.some(id=>!cells.some(c=>c.id===id)))throw new Error('Choose active locations within this warehouse.');cells=cells.filter(c=>ids.includes(c.id));}
    else if(input.mode==='selected'||input.locationsChosen===true||input.locationsChosen==='true')throw new Error('Choose at least one location.');
    if(input.mode==='product'){
      if(!db.prepare('SELECT 1 FROM products WHERE id=? AND active=1').get(Number(input.productId)))throw new Error('Choose an active product.');
      if(!ids.length)cells=cells.filter(c=>db.prepare('SELECT 1 FROM inventory_balances WHERE cell_id=? AND product_id=? AND available_quantity!=0').get(c.id,Number(input.productId)));
    }
  }
  if(!['warehouse','shelf','product','selected'].includes(input.mode))throw new Error('Choose warehouse, shed / shelf or product.');
  if(!cells.length)throw new Error('No active locations in this selection.');
  return cells.map(c=>c.id);
}
export function countCellValues(db,cellId,productId=null){
  const rows=db.prepare('SELECT product_id,available_quantity FROM inventory_balances WHERE cell_id=? AND (? IS NULL OR product_id=?) AND available_quantity!=0 ORDER BY product_id').all(cellId,productId,productId);
  return rows.length?rows.map(r=>({productId:r.product_id,value:r.available_quantity})):[{productId:productId||null,value:0}];
}
export function stocktakeIndicator(db,cellId){
  const item=db.prepare(`SELECT i.*,r.scope_json FROM stocktake_items i JOIN stocktake_runs r ON r.id=i.run_id
    WHERE i.cell_id=? AND i.display_active=1 AND r.display_enabled=1 AND i.state!='excluded' AND r.status!='closed'
    ORDER BY r.id DESC LIMIT 1`).get(cellId);
  if(!item)return null;
  return {action:'stocktake',runId:item.run_id,itemId:item.id,color:item.state==='counted'?'blue':'yellow',values:countCellValues(db,cellId,JSON.parse(item.scope_json).productId||null)};
}
export function countCellOwner(db,cellId){
  return db.prepare(`SELECT cl.*,i.cell_id,i.state,i.run_id,u.name FROM stocktake_display_claims cl
    JOIN stocktake_items i ON i.id=cl.item_id JOIN stocktake_runs r ON r.id=i.run_id JOIN users u ON u.id=cl.actor_id
    JOIN work_guidance g ON g.cell_id=i.cell_id AND json_extract(g.desired,'$.action')='count'
      AND json_extract(g.desired,'$.itemId')=i.id AND json_extract(g.desired,'$.itemGeneration')=i.generation
    WHERE i.cell_id=? AND i.generation=cl.generation AND i.assignee_id=cl.actor_id AND i.state IN ('pending','counting','skipped','recheck')
    AND r.status NOT IN ('closed','completed') ORDER BY cl.requested_at LIMIT 1`).get(cellId);
}
export function enableStocktakeProgress(db,runId,cellIds){
  for(const cellId of cellIds){db.prepare('UPDATE stocktake_items SET display_active=0 WHERE cell_id=?').run(cellId);db.prepare('UPDATE stocktake_items SET display_active=1 WHERE run_id=? AND cell_id=?').run(runId,cellId);}
  db.prepare('UPDATE stocktake_runs SET display_enabled=1 WHERE id=?').run(runId);
}
