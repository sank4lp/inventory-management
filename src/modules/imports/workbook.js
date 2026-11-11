import * as XLSX from 'xlsx';
import {createHash} from 'node:crypto';
import {checkZip} from '../excel/workbook.js';

export const IMPORT_LIMITS={bytes:6*1024*1024,rows:20000,columns:256};
export const PRODUCT_COLUMNS=[['cos_sec','Section'],['part_no','Part Number'],['nomen1','Nomenclature'],['stok_ser','Current Stock'],['au','AU'],['mpi_status','MPI Status'],['cicp_id','CICP ID'],['review_dt','Review Date']];
export const ISSUE_COLUMNS=[['comp_no','Computer Number'],['gs_no','Issue Number'],['issu_dt','Issue Date'],['sub_depot','Sub Depot'],['cos_sec','Section'],['part_no','Part Number'],['nomen1','Nomenclature'],['auth','Description'],['qty_iss','Quantity Issued'],['au','AU'],['cust_code','Customer Code'],['cust','Customer'],['sus_no','Sus Number']];
export const RECEIVED_COLUMNS=[['comp_no','Computer Number'],['rv_no','Received Number'],['rv_dt','Received Date'],['sub_depot','Sub Depot'],['cos_sec','Section'],['part_no','Part Number'],['condition','Condition'],['nomen1','Nomenclature'],['qty_r','Quantity Received'],['au','AU'],['cust_code','Customer Code'],['cust','Customer'],['sus_no','Sus Number'],['created_by','Created By'],['inspected_by','Inspected By']];
export const IMPORT_COLUMNS={products:PRODUCT_COLUMNS,issue:ISSUE_COLUMNS,received:RECEIVED_COLUMNS};
export const importColumnLabel=([key,label])=>`${label} (${key})`;
export const normalizeIdentity=value=>String(value??'').trim().toUpperCase();
export const productIdentity=row=>JSON.stringify([normalizeIdentity(row.cos_sec),normalizeIdentity(row.part_no)]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{const error=new Error(message);error.statusCode=400;throw error;};
const DATES=new Set(['review_dt','issu_dt','rv_dt']);
const NUMBERS=new Set(['stok_ser','qty_iss','qty_r']);

function calendarDate(year,month,day){
  const date=new Date(Date.UTC(year,month-1,day));
  if(year<1900||year>2200||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new Error('Use a valid date.');
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
export function importDate(value,date1904=false){
  if(value==null||String(value).trim()===''||String(value).trim()==='_')return null;
  if(typeof value==='number'){
    const d=XLSX.SSF.parse_date_code(value,{date1904});
    if(!d)throw new Error('Use a valid Excel date.');
    return calendarDate(d.y,d.m,d.d);
  }
  const text=String(value).trim();
  let match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if(match)return calendarDate(+match[1],+match[2],+match[3]);
  match=/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if(match)return calendarDate(+match[3],+match[2],+match[1]);
  throw new Error('Use an Excel date, DD/MM/YYYY or YYYY-MM-DD.');
}
function identifier(cell){
  const value=cell?.v;
  if(value==null)return '';
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value)||Math.abs(value)>=1e15)throw new Error('Save this identifier as text to preserve every digit.');
    // Preserve deliberate leading zeroes without importing scientific notation.
    const formatted=XLSX.utils.format_cell(cell);
    return /^0\d+$/.test(formatted)?formatted:String(value);
  }
  const text=String(value).trim();
  if(text.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new Error('Use readable text, up to 500 characters.');
  return text;
}
function quantity(value,positive){
  const text=String(value??'').trim();
  if(!text||!/^\d+(?:\.\d{1,6})?$/.test(text)||!Number.isFinite(Number(text))||Number(text)>1e9||positive&&Number(text)<=0)throw new Error(positive?'Enter a quantity greater than zero, with at most six decimal places.':'Enter zero or a positive stock quantity, with at most six decimal places.');
  return Number(text);
}

// Read only the agreed columns. Uploaded macros/formulas are never executed,
// and unrelated source fields are not retained in the import or task records.
export function parseBusinessWorkbook(buffer,kind){
  const columns=IMPORT_COLUMNS[kind];
  if(!columns)fail('Choose Products, Issue Voucher or Received Voucher.');
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>IMPORT_LIMITS.bytes)fail('Choose an Excel file smaller than 6 MB.');
  const zip=buffer.length>=4&&buffer.readUInt32LE(0)===0x04034b50;
  const binary=buffer.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'));
  if(!zip&&!binary)fail('Choose an .xls or .xlsx workbook.');
  if(zip)checkZip(buffer);
  let book;
  try{book=XLSX.read(buffer,{type:'buffer',cellDates:false,cellNF:true,cellHTML:false,cellFormula:true,bookVBA:true,sheetRows:IMPORT_LIMITS.rows+2});}
  catch{fail('This workbook could not be read. Save an unencrypted Excel file and retry.');}
  if(book.vbaraw||book.Workbook?.Sheets?.some(s=>s.Hidden===2))fail('Use a plain workbook without macros or hidden macro sheets.');
  const required=kind==='products'?columns.map(([key])=>key):kind==='issue'?['gs_no','cos_sec','part_no','nomen1','qty_iss','au']:['rv_no','cos_sec','part_no','condition','nomen1','qty_r','au'];
  const matches=[];
  for(const name of book.SheetNames){
    const sheet=book.Sheets[name],range=XLSX.utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1');
    if(range.e.r>IMPORT_LIMITS.rows||range.e.c>=IMPORT_LIMITS.columns)fail(`Use at most ${IMPORT_LIMITS.rows} rows and ${IMPORT_LIMITS.columns} columns per sheet.`);
    if(!sheet['!ref'])continue;
    const headers=new Map();
    for(let col=range.s.c;col<=range.e.c;col++){
      const name=String(sheet[XLSX.utils.encode_cell({r:range.s.r,c:col})]?.v??'').trim().toLowerCase();
      if(!name)continue;
      if(headers.has(name))fail(`Sheet ${name}: a column header is repeated. Use each header once.`);
      headers.set(name,col);
    }
    if(required.every(key=>headers.has(key)))matches.push({name,sheet,range,headers});
  }
  if(matches.length!==1)fail(matches.length?'This file has several matching sheets. Upload one import sheet at a time.':`The file does not match ${kind==='products'?'Products':kind==='issue'?'Issue Voucher':'Received Voucher'}. Required columns: ${required.join(', ')}.`);
  const {name,sheet,range,headers}=matches[0],rows=[];
  if((sheet['!merges']||[]).length)fail('Unmerge cells in the import sheet first.');
  for(let r=range.s.r+1;r<=range.e.r;r++){
    if(!columns.some(([key])=>headers.has(key)&&String(sheet[XLSX.utils.encode_cell({r,c:headers.get(key)})]?.v??'').trim()!==''))continue;
    const row={row:r+1,values:{},errors:[]};
    for(const [key,label] of columns){
      const cell=headers.has(key)?sheet[XLSX.utils.encode_cell({r,c:headers.get(key)})]:null;
      try{
        if(cell?.f||cell?.F||cell?.t==='e')throw new Error('Replace the formula or Excel error with its confirmed value.');
        row.values[key]=DATES.has(key)?importDate(cell?.v,!!book.Workbook?.WBProps?.date1904):NUMBERS.has(key)?quantity(cell?.v,kind!=='products'):identifier(cell);
      }catch(error){row.values[key]=null;row.errors.push(`${label} (${key}): ${error.message}`);}
    }
    for(const key of ['cos_sec','part_no','nomen1','au',...(kind==='products'?['mpi_status']:kind==='issue'?['gs_no']:['rv_no','condition'])])if(!row.values[key])row.errors.push(`Enter ${columns.find(c=>c[0]===key)?.[1]||key} (${key}).`);
    row.productKey=productIdentity(row.values);
    if(kind!=='products'){
      row.voucherNumber=row.values[kind==='issue'?'gs_no':'rv_no'];
      // A voucher can contain several products. Never deduplicate on its number alone.
      row.lineKey=hash(JSON.stringify([row.voucherNumber,row.productKey]));
    }
    row.fingerprint=hash(JSON.stringify(row.values));rows.push(row);
  }
  if(!rows.length)fail('The file contains headers only. Add at least one product or voucher row.');
  const groups=new Map();
  for(const row of rows){const key=kind==='products'?JSON.stringify([row.productKey,normalizeIdentity(row.values.mpi_status)]):row.lineKey;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  for(const group of groups.values())if(group.length>1){const rowList=group.slice(0,10).map(r=>r.row).join(', ')+(group.length>10?` and ${group.length-10} more rows`:'');const message=`This ${kind==='products'?'product and MPI status':'voucher product line'} is repeated in rows ${rowList}. Resolve the repeated rows before importing them.`;for(const row of group)row.errors.push(message);}
  return {kind,sheet:name,columns,rows,fileHash:hash(buffer)};
}
