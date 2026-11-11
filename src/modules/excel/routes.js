import {templatePage,uiPanel} from '../../server/ui.js';
import {sendHtml,sendJson} from '../../server/http/responses.js';
import {ensureApiAuth,ensureAuth} from '../../server/http/auth-guards.js';
import {can} from '../access/catalog.js';
import {warehouseExcelBuffer} from '../../services/warehouse-excel.js';

export function warehouseExcelRoutes(request,response,url,user,state){
  if(request.method==='POST'&&url.pathname.startsWith('/api/warehouse-excel/')){
    if(!ensureApiAuth(response,user))return true;
    const action=url.pathname.split('/').pop();
    if(!['upload','review','apply'].includes(action)){sendJson(response,{error:'Unknown import action.'},404);return true;}
    sendJson(response,state.warehouseExcelService[action](user,request.parsedForm));return true;
  }
  if(request.method!=='GET'||!['/warehouse-excel','/warehouse-excel/template.xlsx'].includes(url.pathname))return false;
  if(!ensureAuth(response,user))return true;
  if(url.pathname.endsWith('.xlsx')){
    const buffer=warehouseExcelBuffer({mappingRows:[],stockRows:[]});
    response.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="LytGuide-Shed-Sample.xlsx"','Cache-Control':'no-store','Content-Length':buffer.length});response.end(buffer);return true;
  }
  sendHtml(response,templatePage({title:'Shed Excel',user,content:`<link rel="stylesheet" href="/warehouse-excel.css"><div id="warehouse-excel" class="ui-settings-page">
    <nav class="ui-toolbar"><a href="/locations/manage">Manage Locations</a><a href="/products">Products</a>${can(user,'backups.view')?'<a href="/backups">Backups</a>':''}</nav>
    ${uiPanel('Import mappings & stock',`<p>Download the sample Excel, fill it in, and upload it here. Stock differences become stocktaking tasks.</p><div class="ui-actions"><a class="ui-button secondary" href="/warehouse-excel/template.xlsx" download="LytGuide-Shed-Sample.xlsx">Download sample Excel</a>${can(user,'backups.view')?'<a class="ui-button secondary" href="/backups/warehouse.xlsx" download>Download latest backup Excel</a>':''}</div><form data-excel-upload class="ui-form"><label>Excel file<input type="file" name="workbook" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label><button type="submit">Review file</button><p role="alert" data-excel-error></p></form><details class="ui-help"><summary>Column guide</summary><p><strong>LED Mapping:</strong> Bin Name, Controller Name, Physical LED number. Shed and Rack are optional.</p><p><strong>Products & Stock:</strong> one row per SKU and bin. Actual Stock is the physical count, including reserved stock. Omitted rows stay unchanged. Repeated location names are resolved once.</p><p>New products need SKU, Product Name, Unit, Items per location and Brand. Existing product details are kept. Blank controller/LED fields keep the current mapping. Stock is updated only after the stocktake.</p></details>`)}
    <section data-excel-result hidden></section></div><script type="module" src="/client/warehouse-excel.js"></script>`}));
  return true;
}
