import {ensureAuth,ensureApiAuth} from '../../server/http/auth-guards.js';
import {sendHtml,sendJson} from '../../server/http/responses.js';
import {sectionStockReport,stocktakeDepthReport,reportStocktakes,movementSpeedReport,saveMovementThreshold,customerMovementReport} from './data.js';
import {filterReportRows,renderSectionReport,renderDepthReport,renderMovementReport,renderCustomerReport,reportCsv,SECTION_COLUMNS,DEPTH_COLUMNS,MOVEMENT_COLUMNS,CUSTOMER_COLUMNS,movementExportRows} from './pages.js';

function download(response,name,columns,rows,url){
 const csv=Buffer.from(reportCsv(columns,filterReportRows(rows,url)));
 response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="LytGuide-${name}.csv"`,'Cache-Control':'no-store','Content-Length':csv.length});response.end(csv);
}
export function businessReportRoutes(request,response,url,user,state){
 if(request.method==='POST'&&url.pathname==='/api/reports/movement-threshold'){
  if(!ensureApiAuth(response,user))return true;
  sendJson(response,{threshold:saveMovementThreshold(state.db,user,{...request.parsedForm,direction:'combined'})});return true;
 }
 if(request.method!=='GET'||!['/reports/sections','/reports/stocktake-range','/reports/movement-speed','/reports/customers'].includes(url.pathname))return false;
 if(!ensureAuth(response,user))return true;
 const db=state.db,q=url.searchParams,section=q.get('section'),csv=q.get('export')==='csv';let report;
 if(url.pathname==='/reports/sections'){
  report=sectionStockReport(db,user,{section});
  if(csv)download(response,'Section-Stock',SECTION_COLUMNS,report.rows,url);else sendHtml(response,renderSectionReport(db,user,url,report));
 }else if(url.pathname==='/reports/stocktake-range'){
  const runs=reportStocktakes(db,user),rangeBy=q.get('rangeBy')||'product';let error='';
  if(q.get('run')){try{report=stocktakeDepthReport(db,user,{runId:q.get('run'),rangeBy,section});}catch(e){if(e.statusCode!==400)throw e;error=e.message;}}
  if(csv&&report)download(response,`Stocktake-${report.run.id}-Range-${rangeBy}`,[['stocktake','Stocktake'],['coverage','Counted bins'],['reportStatus','Report status'],['range','Range'],...DEPTH_COLUMNS.map(c=>c[0]==='mpi_status'&&rangeBy==='product'?['mpi_status','Depth by MPI status']:c)],report.rows.map(r=>({...r,stocktake:report.run.id,coverage:`${report.confirmed}/${report.total}`,reportStatus:report.partial?'Partial':'Complete',range:report.range})),url);
  else sendHtml(response,renderDepthReport(db,user,url,report,runs,error),error?400:200);
 }else if(url.pathname==='/reports/movement-speed'){
  let end;
  if(q.get('through')){
   const day=q.get('through'),parsed=new Date(day+'T23:59:59.999+05:30');
   if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(parsed.getTime())||new Date(Date.parse(day+'T00:00:00Z')).toISOString().slice(0,10)!==day)throw Object.assign(new Error('Choose a valid Through date.'),{statusCode:400});
   end=new Date(Math.min(parsed.getTime(),Date.now())).toISOString();
  }
  report=movementSpeedReport(db,user,{section,period:q.get('period')||'month',end,direction:'combined'});
  if(csv)download(response,'Product-Movement',[['period','Period'],['fromAt','From'],['toAt','Through'],['scope','Scope'],...MOVEMENT_COLUMNS],movementExportRows(report).filter(r=>!q.get('classification')||r.classification===q.get('classification')).map(r=>({...r,period:report.period,fromAt:report.fromAt,toAt:report.toAt,scope:report.scope})),url);
  else sendHtml(response,renderMovementReport(db,user,url,report));
 }else{
  report=customerMovementReport(db,user,{section,customerId:q.get('customer')});
  if(csv)download(response,'Customer-Movement',CUSTOMER_COLUMNS,report.rows,url);else sendHtml(response,renderCustomerReport(db,user,url,report));
 }
 return true;
}
