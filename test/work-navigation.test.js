import test from 'node:test';
import assert from 'node:assert/strict';
import {page} from '../src/render.js';
import {ADMIN_CAPABILITIES,WORK_TABS,workTabs,currentWorkTab} from '../src/modules/access/catalog.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const admin={id:1,name:'Admin',role:'admin',capabilities:ADMIN_CAPABILITIES};
function links(markup){return [...markup.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map(x=>({href:x[1],label:x[2]}));}
function sidebar(html){return html.match(/<nav class="side-nav-sublist" aria-label="Work pages">([\s\S]*?)<\/nav>/)?.[1]||'';}
test('all Work views have one selected sidebar child without duplicate top tabs',()=>{
 for(const tab of WORK_TABS){const html=page({title:tab.label,user:admin,currentPath:tab.href,content:''});
  assert.deepEqual(links(sidebar(html)).map(x=>x.href),workTabs(admin).map(x=>x.href));
  assert.doesNotMatch(html,/aria-label="Work views"/);
  assert.equal((sidebar(html).match(/aria-current="page"/g)||[]).length,1);
  const active=sidebar(html).match(/<a[^>]*href="([^"]+)"[^>]*aria-current="page"/);assert.equal(active?.[1],tab.href);
 }
 const html=page({title:'Task #19 - Pick Product',user:admin,currentPath:'/tasks/19',content:''});assert.match(sidebar(html),/href="\/work" aria-current="page"/);
 assert.equal(currentWorkTab('/work/history?state=all'),'/work/history');assert.equal(currentWorkTab('/put'),'/work');assert.equal(currentWorkTab('/work/timing'),null);
});
test('custom role cannot discover Assign Work or Record Movement without its own permission',()=>{
 const user={id:2,name:'Viewer',role:'custom',capabilities:['work.view']};
 assert.deepEqual(workTabs(user).map(x=>x.href),['/work','/work/history','/work/task-history','/recommended-actions']);
 const html=page({title:'My Work',user,currentPath:'/work',content:''});
 assert.doesNotMatch(sidebar(html),/Assign Work|Record Movement/);
 const assignee={...user,capabilities:['work.view','work.assign']};assert.ok(workTabs(assignee).some(x=>x.href==='/work/overview'));assert.ok(!workTabs(assignee).some(x=>x.href==='/record-movement'));
});

// Run the real browser wiring: the server initially selected the right page,
// and the client must not re-highlight its /work parent as a second child.
test('client sidebar selects exactly one Work child on load and after back navigation',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const wiring='function wireNavState()'+source.split('function wireNavState()')[1].split('function dashboardSubtabTarget()')[0];
 const makeLink=href=>{const attributes={href};let active=false;return {getAttribute:key=>attributes[key],setAttribute:(key,value)=>attributes[key]=value,removeAttribute:key=>delete attributes[key],classList:{toggle:(name,value)=>{if(name==='nav-link-active')active=value;}},get active(){return active;}};};
 const workLinks=WORK_TABS.map(tab=>makeLink(tab.href)),parent=makeLink('/work'),settings=makeLink('/settings');
 const all=[parent,...workLinks,settings];
 const sidebar={querySelectorAll:selector=>selector.includes('Work pages')?workLinks:selector==='.side-nav-group'?[]:all};
 const window={location:{pathname:'/work',hash:'',href:'http://warehouse/work'}};
 const context=vm.createContext({document:{querySelector:()=>sidebar},window,URL});vm.runInContext(wiring,context);
 for(const pathname of [...WORK_TABS.map(t=>t.href),'/pick','/put','/tasks/77','/recommended-actions/detail','/work/history','/work','/work/task-history','/work/timing','/products']){
  window.location={pathname,hash:'',href:'http://warehouse'+pathname};vm.runInContext('wireNavState()',context);
  const selected=workLinks.filter(link=>link.active);assert.deepEqual(selected.map(link=>link.getAttribute('href')),currentWorkTab(pathname)?[currentWorkTab(pathname)]:[],pathname);
  assert.deepEqual(workLinks.filter(link=>link.getAttribute('aria-current')==='page'),selected,pathname);
  assert.equal(parent.active,Boolean(currentWorkTab(pathname)),pathname);
 }
});
