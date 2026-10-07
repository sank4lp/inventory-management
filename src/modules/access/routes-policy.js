import {can,SETTINGS} from './catalog.js';
// Every public route is explicit. API command families additionally enforce action and resource scope in services.
export const ROUTE_POLICY = [
  ['GET',/^\/(login|register|offline|stocktaking\/offline)$/,'public'],['POST',/^\/(login|register|logout)$/,'public'],
  ['GET',/^\/profile$/,'account'],['GET',/^\/api\/system\/health$/,'account'],
  ['GET',/^\/(settings|admin)$/,'settings'],
  ['GET',/^\/settings\/roles$/,'access.manage'],['POST',/^\/settings\/roles(\/assign)?$/,'access.manage'],
  ['GET',/^\/settings\/people$/,'people.view'],['GET',/^\/admin\/users\/\d+$/,'people.view'],
  ['POST',/^\/admin\/users\/status$/,'people.manage'],['POST',/^\/admin\/registration-keys(\/revoke)?$/,'access.manage'],
  ['GET',/^\/settings\/system$/,'system.view'],['POST',/^\/admin\/task-timeout$/,'work.timing'],
  ['GET',/^\/admin\/product-fields$/,'products.fields'],['POST',/^\/admin\/(product-fields(\/\d+)?|product-unit-conversions\/(preview|apply))$/,'products.fields'],
  ['GET',/^\/backups$/,'backups.view'],['POST',/^\/backups\/create$/,'backups.create'],['POST',/^\/backups\/restore$/,'backups.restore'],['POST',/^\/backups\/(schedule|retention)$/,'backups.configure'],
  ['GET',/^\/devices(\/sections\/[a-z-]+)?$/,'hardware.view'],['POST',/^\/devices\/(controller-test|controller-ping|cell-test)$/,'hardware.test'],['POST',/^\/devices\/controller-delete$/,'hardware.controllers'],
  ['GET',/^\/api\/firmware\/options$/,'hardware.view'],['GET',/^\/api\/firmware\/jobs\/[A-Za-z0-9-]+$/,'hardware.flash'],['POST',/^\/api\/firmware\/flash$/,'hardware.flash'],
  ['POST',/^\/mapping(\/bulk)?$/,'hardware.map'],['POST',/^\/devices\/cells(\/(rename|delete))?$/,'locations.manage'],
  ['GET',/^\/location-setup(\/print)?$/,'locations.manage'],['GET',/^\/locations\/manage$/,'locations.manage'],
  ['GET',/^\/api\/location-setup\/snapshot$/,'locations.manage'],['POST',/^\/api\/location-setup\/[A-Za-z]+$/,'account'],
  ['GET',/^\/stocktaking(\/results)?$/,'count.view'],['GET',/^\/reports\/stocktake-differences$/,'count.view'],['GET',/^\/api\/stocktaking\/snapshot$/,'account'],['GET',/^\/api\/stocktaking\/movements$/,'count.team'],['POST',/^\/api\/stocktaking\/[A-Za-z]+$/,'account'],
  ['GET',/^\/reports$/,'reports.view'],['POST',/^\/reports\/format(\/reset)?$/,'reports.format'],
  ['GET',/^\/$/,'work.view'],['GET',/^\/work(\/(history|task-history))?$/,'work.view'],['GET',/^\/work\/overview$/,'work.assign'],['GET',/^\/work\/timing$/,'work.timing'],['GET',/^\/pending-confirmations$/,'review.view'],
  ['GET',/^\/record-movement$/,'work.report'],['GET',/^\/movement-history$/,'work.view'],['GET',/^\/tasks\/\d+$/,'work.view'],['POST',/^\/tasks\/\d+\/(confirm|put-plan|simulate-button)$/,'work.execute'],['POST',/^\/tasks\/\d+\/correct$/,'work.correct'],['POST',/^\/tasks\/\d+\/cancel$/,'work.stop'],
  ['GET',/^\/api\/work\/snapshot$/,'account'],['GET',/^\/api\/work\/(productStock|planningOptions|taskHistory|activityHistory)$/,'work.view'],['GET',/^\/api\/work\/cellHistory$/,'locations.view'],['GET',/^\/api\/work\/(movements|countCandidates)$/,'review.view'],['POST',/^\/api\/work\/[A-Za-z]+$/,'account'],
  ['GET',/^\/pick$/,'work.pick'],['POST',/^\/pick$/,'work.pick'],['GET',/^\/put$/,'work.put'],['POST',/^\/put$/,'work.put'],
  ['GET',/^\/(products(\/\d+)?|fragments\/catalog-products)$/,'products.view'],['POST',/^\/products$/,'products.add'],['POST',/^\/products\/\d+\/items-per-cell$/,'products.capacity'],['POST',/^\/products\/\d+\/details$/,'products.edit'],['POST',/^\/products\/\d+\/delete$/,'products.remove'],
  ['POST',/^\/products\/(quantities(\/clear)?|\d+\/find(\/clear)?)$/,'locations.quantity'],
  ['GET',/^\/(cells(\/\d+)?|fragments\/cell-search|api\/locations\/resolve)$/,'locations.view'],['POST',/^\/cells\/\d+\/directions$/,'locations.manage'],
  ['GET',/^\/fragments\/movement-stock-locations$/,'work.view'],['GET',/^\/labels(\/\d+\.svg)?$/,'locations.labels'],
  ['GET',/^\/quantities$/,'locations.view'],['GET',/^\/api\/displays\/status$/,'locations.view'],['POST',/^\/api\/displays\/(start|stop)$/,'account'],
  ['POST',/^\/api\/cells\/(\d+\/(locate|ping|count)(\/clear)?|locate\/clear-all)$/,'locations.view'],
  ['GET',/^\/recommended-actions$/,'work.view'],['POST',/^\/recommended-actions\/apply$/,'work.report'],['POST',/^\/recommended-actions\/(light-cell(\/clear)?|clear-leds)$/,'locations.locate'],
  ['GET',/^\/api\/admin\/adjustments\/cell-products$/,'count.team'],['POST',/^\/api\/admin\/adjustments\/light$/,'locations.locate'],['POST',/^\/admin\/adjustments$/,'count.approve'],
];
export function routeCapability(method,path) {return ROUTE_POLICY.find(([m,r])=>m===method&&r.test(path))?.[2]||null;}
export function routeAllowed(user,method,path) {
  const url=new URL(path,'http://local');
  if(url.pathname==='/stocktaking'&&url.searchParams.has('device_help'))return !!user;
  if(url.pathname==='/work'&&url.searchParams.has('device_help'))return !!user;
  if(url.pathname==='/products'&&url.searchParams.has('show_add'))return can(user,'products.add');
  if(url.pathname==='/reports'&&url.searchParams.has('format'))return can(user,'reports.format');
  const section=url.pathname.match(/^\/devices\/sections\/(controller-setup|cell-create|cell-management|cell-mapping)$/);
  if(section)return can(user,{'controller-setup':'hardware.flash','cell-create':'locations.manage','cell-management':'locations.manage','cell-mapping':'hardware.map'}[section[1]]);
  const c=routeCapability(method,url.pathname);
  return c==='public'||(!!user&&(c==='account'||c==='settings'&&SETTINGS.some(x=>can(user,x[2]))||can(user,c)));
}
// Remove inaccessible server-rendered actions before delivery, including retained legacy pages.
// HTML is generated by this app; only balanced form/anchor elements are filtered.
export function permittedMarkup(html,user) {
  let omitted=null,depth=0;
  return html.split(/(<[^>]+>)/g).map(token=>{
    const tag=token.match(/^<\s*(\/?)\s*([a-z][\w-]*)\b/i);
    if(omitted){if(tag?.[2].toLowerCase()===omitted){depth+=tag[1]?-1:1;if(depth===0)omitted=null;}return '';}
    if(!tag||tag[1])return token;
    const name=tag[2].toLowerCase();if(!['a','form','button'].includes(name))return token;
    const attributePermissions={'data-show-product-quantity':'locations.quantity','data-show-location-count':'locations.quantity','data-ping-cell':'locations.locate','data-locate-cell':'locations.locate','data-adjustment-locate-cell':'locations.locate','data-location-mode':'locations.mode'};
    const permission=Object.entries(attributePermissions).find(([attr])=>new RegExp('\\b'+attr+'(?:[\\s=>])').test(token))?.[1];
    if(permission&&!can(user,permission)){omitted=name;depth=1;return '';}
    const section=token.match(/data-config-section-link="([^"]+)"/);
    if(section&&!can(user,{'controller-setup':'hardware.flash','cell-create':'locations.manage','cell-management':'locations.manage','cell-mapping':'hardware.map'}[section[1]])){omitted=name;depth=1;return '';}
    if(name==='button')return token;
    const match=token.match(name==='a'?/\bhref\s*=\s*["']([^"']+)["']/i:/\baction\s*=\s*["']([^"']+)["']/i);
    if(!match||!match[1].startsWith('/')||match[1].startsWith('//'))return token;
    const method=name==='form'&&/\bmethod\s*=\s*["']post["']/i.test(token)?'POST':'GET';
    if(!routeAllowed(user,method,match[1].replaceAll('&amp;','&'))){omitted=name;depth=1;return '';}
    return token;
  }).join('');
}
