import {businessProductFields} from './product-ui.js';
import {escapeHtml} from '../../server/pages/shared.js';
import {businessProductLabel} from './catalog.js';
import {templatePage,uiPanel} from '../../server/ui.js';
import {sendHtml,sendJson,sendRedirect} from '../../server/http/responses.js';
import {ensureAuth,ensureApiAuth} from '../../server/http/auth-guards.js';
import {can} from '../access/catalog.js';
import * as XLSX from 'xlsx';
import {IMPORT_COLUMNS} from './workbook.js';

export function businessImportRoutes(request,response,url,user,state){
 const service=state.businessImportService;
 if(url.pathname.startsWith('/api/business-import/')){
  if(!ensureApiAuth(response,user))return true;
  const action=url.pathname.split('/').pop();
  if(request.method==='POST'&&['upload','review','apply','saveProduct','mergeReview'].includes(action))sendJson(response,service[action](user,request.parsedForm));
  else if(request.method==='GET'&&action==='voucher')sendJson(response,service.detail(user,url.searchParams.get('id')));
  else if(request.method==='GET'&&action==='vouchers')sendJson(response,{vouchers:service.list(user)});
  else sendJson(response,{error:'Import action not found.'},404);
  return true;
 }
 if(request.method==='GET'&&/^\/products\/\d+$/.test(url.pathname)){let p=state.db.prepare('SELECT id,merged_into FROM products WHERE id=?').get(Number(url.pathname.split('/').pop()));const visited=new Set();while(p?.merged_into&&!visited.has(p.id)){visited.add(p.id);p=state.db.prepare('SELECT id,merged_into FROM products WHERE id=?').get(p.merged_into);}if(visited.size&&p){if(!ensureAuth(response,user))return true;sendRedirect(response,'/products/'+p.id);return true;}}
 if(request.method!=='GET'||!['/products/merge','/products/new','/products/import','/work/vouchers','/products/import/template.xlsx'].includes(url.pathname))return false;
 if(!ensureAuth(response,user))return true;
 if(url.pathname.endsWith('.xlsx')){
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([IMPORT_COLUMNS.products.map(([key])=>key)]),'Products');const data=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  response.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="LytGuide-Products.xlsx"','Content-Length':data.length,'Cache-Control':'no-store'});response.end(data);return true;
 }
 if(url.pathname==='/products/merge'){
  const products=state.db.prepare('SELECT * FROM products WHERE active=1 AND cos_sec IS NOT NULL ORDER BY name,mpi_status').all();
  sendHtml(response,templatePage({title:'Merge Products',user,content:`<link rel="stylesheet" href="/warehouse-excel.css"><div id="business-import" class="ui-settings-page">${uiPanel('Merge products',`<form data-product-merge class="stack-form"><label>Main product<select name="mainProductId" data-searchable required><option value="">Choose product</option>${products.map(p=>`<option value="${p.id}" data-name="${escapeHtml(p.name)}">${escapeHtml(businessProductLabel(p))}</option>`).join('')}</select></label><label>Name to keep<input name="name" required maxlength="500"></label><details class="business-multiselect" data-multi="productIds"><summary>Products to merge</summary><div><input type="search" data-option-search placeholder="Search products" aria-label="Search products to merge"><div class="business-option-list">${products.map(p=>`<label><input type="checkbox" value="${p.id}">${escapeHtml(businessProductLabel(p))}</label>`).join('')}</div></div></details><p>Stock is combined within each MPI status. Old identities will be remembered for future imports.</p><div class="ui-actions"><button>Review merge</button><a class="ghost-button" href="/products">Back</a></div><p data-import-error role="alert"></p></form>`)}<section data-import-result></section></div><script type="module" src="/client/business-import.js"></script>`}));return true;
 }
 if(url.pathname==='/products/new'){
  sendHtml(response,templatePage({title:'Add Product',user,content:`<div id="business-import" class="ui-settings-page">${uiPanel('Product details',`<form data-business-product class="stack-form">${businessProductFields()}<label class="checkbox-line"><input type="checkbox" name="confirmed" value="1" required>I confirm this product.</label><p data-import-error role="alert"></p><div class="ui-actions"><button>Save Product</button><a class="ghost-button" href="/products">Back</a></div></form>`)}</div><script type="module" src="/client/business-import.js"></script>`}));return true;
 }
 const products=url.pathname==='/products/import',allow=products?can(user,'products.edit'):can(user,'work.assign');
 sendHtml(response,templatePage({title:products?'Import Products':'Vouchers',user,content:`<link rel="stylesheet" href="/warehouse-excel.css"><div id="business-import" class="ui-settings-page" data-import-kind="${products?'products':'issue'}" data-can-import="${allow}">
 ${allow?uiPanel(products?'Products & stock':'Import voucher',`<form data-business-upload class="ui-form"><div class="ui-actions">${products?'<a class="ui-button secondary" href="/products/import/template.xlsx" download>Download sample Excel</a><a class="ui-button secondary" href="/products">Products</a>':'<label>Voucher type<select name="kind"><option value="issue">Issue Voucher — Pick</option><option value="received">Received Voucher — Put</option></select></label>'}<label>Excel file<input name="file" type="file" accept=".xls,.xlsx" required></label><button type="submit">Review file</button></div><p role="alert" data-import-error></p></form><details class="ui-help"><summary>Help</summary><p>${products?'Products match by Section and Part Number, with separate MPI stock. Stock differences create stocktakes. Inventory changes only when counted.':'One task per eligible voucher row. Received rows use CURRENT MPI; UNS rows create no Put task. Reimporting skips tasks already created and retries pending rows.'}</p></details>`):''}
 <section data-import-result></section>${!products?uiPanel('Vouchers','<div data-voucher-list>Loading vouchers…</div>'):''}</div><script type="module" src="/client/business-import.js"></script>`}));return true;
}
