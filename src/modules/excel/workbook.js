import * as XLSX from 'xlsx';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {MAPPING_COLUMNS,STOCK_COLUMNS} from '../../services/warehouse-excel.js';

export const MAX_EXCEL_BYTES=6*1024*1024;
const MAX_ROWS=20000;
export const locationKey=value=>String(value??'').trim().toLowerCase();
export const productKey=row=>row.sku?'sku:'+row.sku.toUpperCase():'name:'+row.name.toLowerCase();
function fail(message,sheet,row){const error=new Error((sheet?`${sheet}${row?`, row ${row}`:''}: `:'')+message);error.statusCode=400;throw error;}

// Bound actual ZIP expansion as well as directory sizes before parsing XML.
// Imported files are data only: no macros, linked workbooks, or formulas.
function checkZip(buffer){
  if(buffer.length<22||buffer.readUInt32LE(0)!==0x04034b50)fail('Choose an .xlsx workbook.');
  let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)fail('The Excel file is incomplete. Save it again and retry.');
  const entries=buffer.readUInt16LE(end+10),size=buffer.readUInt32LE(end+12),offset=buffer.readUInt32LE(end+16);
  if(!entries||entries>2000||offset+size>end||buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6))fail('This workbook format is not supported. Save a plain .xlsx file.');
  let at=offset,total=0;const names=new Set();
  for(let i=0;i<entries;i++){
    if(at+46>offset+size||buffer.readUInt32LE(at)!==0x02014b50)fail('The Excel file has a damaged directory.');
    const nameLength=buffer.readUInt16LE(at+28),extra=buffer.readUInt16LE(at+30),comment=buffer.readUInt16LE(at+32);
    if(at+46+nameLength+extra+comment>offset+size)fail('The Excel file is incomplete.');
    const name=buffer.toString('utf8',at+46,at+46+nameLength);
    total+=buffer.readUInt32LE(at+24);
    if(total>40*1024*1024||names.has(name)||buffer.readUInt16LE(at+8)&1)fail('Workbook too large, encrypted or damaged. Use the downloaded template.');
    if(/(?:vbaProject\.bin|externalLinks\/|activeX\/)/i.test(name))fail('Remove macros and external workbook links before importing.');
    const method=buffer.readUInt16LE(at+10),compressed=buffer.readUInt32LE(at+20),expanded=buffer.readUInt32LE(at+24),local=buffer.readUInt32LE(at+42);
    if(local+30>offset||buffer.readUInt32LE(local)!==0x04034b50||buffer.readUInt16LE(local+8)!==method||![0,8].includes(method))fail('The Excel file has a damaged entry.');
    const localName=buffer.readUInt16LE(local+26),start=local+30+localName+buffer.readUInt16LE(local+28);
    if(start+compressed>offset||buffer.toString('utf8',local+30,local+30+localName)!==name)fail('The Excel file has a damaged entry.');
    const packed=buffer.subarray(start,start+compressed);let actual;
    try{actual=method===0?packed.length:inflateRawSync(packed,{maxOutputLength:Math.max(1,expanded)}).length;}catch{fail('Workbook too large or damaged. Save it again and retry.');}
    if(actual!==expanded)fail('The Excel file has incorrect entry sizes. Save it again and retry.');
    names.add(name);at+=46+nameLength+extra+comment;
  }
  if(!names.has('xl/workbook.xml'))fail('Choose an .xlsx workbook.');
}
function readRows(book,name,columns,required){
  const sheet=book.Sheets[name];if(!sheet)return [];
  if((sheet['!merges']||[]).length)fail('Unmerge cells before importing.',name);
  const range=XLSX.utils.decode_range(sheet['!ref']||'A1');
  if(range.e.r>MAX_ROWS||range.e.c>40)fail(`Use at most ${MAX_ROWS} data rows and 41 columns.`,name);
  for(const [address,cell] of Object.entries(sheet))if(!address.startsWith('!')){
    if(cell.f||cell.F)fail('Replace formulas with their values before importing.',name,XLSX.utils.decode_cell(address).r+1);
    if(cell.t==='e')fail('Correct the Excel error in this row.',name,XLSX.utils.decode_cell(address).r+1);
    if(String(cell.v??'').length>2000)fail('Keep each value under 2,000 characters.',name,XLSX.utils.decode_cell(address).r+1);
  }
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:true});
  const headers=(rows[0]||[]).map(value=>String(value).trim());
  if(new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length)fail('Use each column header once.',name,1);
  for(const column of required)if(!headers.includes(column))fail(`Missing column: ${column}.`,name,1);
  const output=[];
  rows.slice(1).forEach((values,index)=>{
    if(!values.some(value=>String(value).trim()!==''))return;
    const row={row:index+2};for(const column of columns)row[column]=values[headers.indexOf(column)]??'';
    output.push(row);
  });
  return output;
}
const text=value=>String(value??'').trim();
export function parseWarehouseExcel(buffer){
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_EXCEL_BYTES)fail('Choose an Excel file smaller than 6 MB.');
  checkZip(buffer);
  let book;try{book=XLSX.read(buffer,{type:'buffer',cellHTML:false,cellFormula:true,bookVBA:false,sheetRows:MAX_ROWS+2});}catch{fail('This Excel file could not be read. Save it as .xlsx and retry.');}
  if(!book.Sheets['LED Mapping']&&!book.Sheets['Products & Stock'])fail('Use the LED Mapping or Products & Stock sheet from the template.');
  const mappings=readRows(book,'LED Mapping',MAPPING_COLUMNS,MAPPING_COLUMNS.slice(0,3)).map(row=>{
    const name=text(row['Cell Name']),controller=text(row['Controller Name']),physical=text(row['Physical LED number']);
    if(!name||name.length>160||/[\u0000-\u001f\u007f]/.test(name))fail('Enter a readable Cell Name, up to 160 characters.','LED Mapping',row.row);
    if(Boolean(controller)!==Boolean(physical))fail('Enter both Controller Name and Physical LED number, or leave both blank.','LED Mapping',row.row);
    if(physical&&(!Number.isInteger(Number(physical))||Number(physical)<1||Number(physical)>64))fail('Physical LED number must be a whole number from 1 to 64.','LED Mapping',row.row);
    return {row:row.row,name,key:locationKey(name),controller,physical:physical?Number(physical):null,warehouse:text(row.Warehouse),shelf:text(row['Shed/Shelf'])};
  });
  const stock=readRows(book,'Products & Stock',STOCK_COLUMNS,['SKU','Product Name','Cell Name','Actual Stock']).map(row=>{
    const sku=text(row.SKU).toUpperCase(),name=text(row['Product Name']),location=text(row['Cell Name']),quantity=text(row['Actual Stock']);
    if(!sku&&!name)fail('Enter the SKU or Product Name.','Products & Stock',row.row);
    if(sku.length>160||name.length>300||location.length>160)fail('The SKU, name or location is too long.','Products & Stock',row.row);
    if(Boolean(location)!==Boolean(quantity))fail('Enter both Cell Name and Actual Stock, or leave both blank for a catalog-only product.','Products & Stock',row.row);
    if(quantity&&(!Number.isFinite(Number(quantity))||Number(quantity)<0||Number(quantity)>1e9||!/^\d+(?:\.\d{1,6})?$/.test(quantity)))fail('Actual Stock must be zero or greater, with at most six decimal places.','Products & Stock',row.row);
    const value={row:row.row,sku,name,location,locationKey:locationKey(location),quantity:quantity===''?null:Number(quantity),unit:text(row.Unit),itemsPerCell:row['Items per location'],brand:text(row.Brand),category:text(row.Category),variant:text(row.Variant),description:text(row.Description)};
    return {...value,key:productKey(value)};
  });
  if(!mappings.length&&!stock.length)fail('Add at least one mapping or product row before importing.');
  return {mappings,stock,fileHash:createHash('sha256').update(buffer).digest('hex')};
}
