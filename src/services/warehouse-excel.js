import * as XLSX from 'xlsx';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,openSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {controllerLedMap} from '../modules/locations/led-mapping.js';

export const WAREHOUSE_EXCEL_FILE='LytGuide-Warehouse.xlsx';
export const MAPPING_COLUMNS=['Cell Name','Controller Name','Physical LED number','Warehouse','Shed/Shelf'];
export const STOCK_COLUMNS=['SKU','Product Name','Cell Name','Actual Stock','Unit','Items per location','Brand','Category','Variant','Description'];
const MAX_ROWS=20000;
const cellName=cell=>cell.display_name||cell.logical_code;

// These are physical, on-shelf totals. Reserved quantities are deliberately not
// subtracted: a reservation is a task instruction, not a warehouse movement.
export function warehouseExcelData(db) {
  const cells=db.prepare('SELECT * FROM cells WHERE active=1 ORDER BY id').all();
  const controllers=db.prepare('SELECT * FROM controllers WHERE active=1 ORDER BY id').all();
  const maps=new Map(controllers.map(c=>[c.id,controllerLedMap(db,c)]));
  const mappingRows=cells.map(cell=>{
    let controller='',physical='';
    if(cell.controller_id!=null&&cell.hardware_channel!=null){
      const map=maps.get(cell.controller_id);
      if(!map||map.error)throw new Error(`Cannot export the LED mapping for ${cellName(cell)}. ${map?.error||'Its controller is inactive or missing.'}`);
      const led=map.leds.find(row=>row.cellId===cell.id);
      if(!led?.channel)throw new Error(`Cannot identify the physical LED for ${cellName(cell)}. Verify its controller setup first.`);
      controller=map.name;physical=led.physical;
    }
    return [cellName(cell),controller,physical,cell.warehouse_name||'',cell.travel_instructions||''];
  });
  const products=db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sku,id').all();
  const balances=db.prepare(`SELECT b.* FROM inventory_balances b JOIN cells c ON c.id=b.cell_id WHERE c.active=1 ORDER BY b.product_id,b.cell_id`).all();
  const cellNames=new Map(cells.map(c=>[c.id,cellName(c)]));
  const stockRows=[];
  for(const product of products){
    const rows=balances.filter(b=>b.product_id===product.id);
    // A product without a saved location still belongs in the catalog export.
    for(const balance of rows.length?rows:[null])stockRows.push([
      product.sku,product.name,balance?cellNames.get(balance.cell_id):'',balance?Number(balance.available_quantity):'',
      product.unit_of_measure,Number(product.items_per_cell),product.brand||'',product.category||'',product.variant||'',product.description||'',
    ]);
  }
  if(mappingRows.length>MAX_ROWS||stockRows.length>MAX_ROWS)throw new Error('The warehouse is too large for a single Excel import. The full database backup is still available.');
  return {mappingRows,stockRows};
}

export function warehouseExcelBuffer(data,{createdAt=new Date(),sheets=['LED Mapping','Products & Stock']}={}) {
  const workbook=XLSX.utils.book_new();
  workbook.Props={Title:'LytGuide warehouse mapping and stock',Author:'LytGuide',CreatedDate:new Date(createdAt)};
  for(const [name,headers,rows,widths] of [
    ['LED Mapping',MAPPING_COLUMNS,data.mappingRows,[28,24,24,26,26]],
    ['Products & Stock',STOCK_COLUMNS,data.stockRows,[22,32,28,18,18,24,24,24,24,48]],
  ]){
    if(!sheets.includes(name))continue;
    const sheet=XLSX.utils.aoa_to_sheet([headers,...rows]);
    sheet['!cols']=widths.map(wch=>({wch}));
    sheet['!autofilter']={ref:XLSX.utils.encode_range({r:0,c:0},{r:Math.max(1,rows.length),c:headers.length-1})};
    // Force identifiers to text, preserving leading zeroes and literal '=' values.
    for(const [key,cell] of Object.entries(sheet))if(!key.startsWith('!')&&cell.t==='s')cell.z='@';
    XLSX.utils.book_append_sheet(workbook,sheet,name);
  }
  return XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true});
}

export function writeWarehouseExcel(snapshotPath,destination,{createdAt=new Date()}={}) {
  const db=new DatabaseSync(snapshotPath,{readOnly:true});
  let buffer;
  try{buffer=warehouseExcelBuffer(warehouseExcelData(db),{createdAt});}finally{db.close();}
  const temporary=join(dirname(destination),`.warehouse-${randomUUID()}.xlsx.tmp`);
  try{
    writeFileSync(temporary,buffer,{flag:'wx',mode:0o600});
    const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,destination);
  }finally{rmSync(temporary,{force:true});}
  return {path:destination,createdAt:new Date(createdAt).toISOString(),bytes:buffer.length};
}

// Status stays separate from the workbook so a failed export never replaces a
// good previous file, nor makes a successful database backup appear to fail.
export function refreshWarehouseExcel(snapshotPath,directory,options={}) {
  const statusPath=join(directory,'warehouse-excel-status.json');
  let previous={};try{previous=JSON.parse(readFileSync(statusPath,'utf8'));}catch{}
  let status;
  try{status={...writeWarehouseExcel(snapshotPath,join(directory,WAREHOUSE_EXCEL_FILE),options),lastError:null};}
  catch(error){status={...previous,lastError:error.message};}
  status.lastAttemptAt=new Date(options.createdAt||Date.now()).toISOString();
  const temporary=statusPath+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temporary,JSON.stringify(status),{flag:'wx',mode:0o600});renameSync(temporary,statusPath);}finally{rmSync(temporary,{force:true});}
  return status;
}
