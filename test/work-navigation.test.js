import test from 'node:test';
import assert from 'node:assert/strict';
import {page} from '../src/render.js';
import {ADMIN_CAPABILITIES,WORK_TABS,workTabs,currentWorkTab} from '../src/modules/access/catalog.js';
import {workNavigation} from '../src/modules/operations/navigation.js';
const admin={id:1,name:'Admin',role:'admin',capabilities:ADMIN_CAPABILITIES};
function links(markup){return [...markup.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map(x=>({href:x[1],label:x[2]}));}
function sidebar(html){return html.match(/<nav class="side-nav-sublist" aria-label="Work pages">([\s\S]*?)<\/nav>/)?.[1]||'';}
test('all Work views use the same role-scoped sidebar and tabs, including explicit task paths',()=>{
 for(const tab of WORK_TABS){const html=page({title:tab.label,user:admin,currentPath:tab.href,content:workNavigation(admin,tab.href)});
  assert.deepEqual(links(sidebar(html)).map(x=>x.href),links(workNavigation(admin,tab.href)).map(x=>x.href));
  const active=sidebar(html).match(/<a[^>]*href="([^"]+)"[^>]*aria-current="page"/);assert.equal(active?.[1],tab.href);
 }
 const html=page({title:'Task #19 - Pick Product',user:admin,currentPath:'/tasks/19',content:''});assert.match(sidebar(html),/href="\/work" aria-current="page"/);
 assert.equal(currentWorkTab('/work/history?state=all'),'/work/history');assert.equal(currentWorkTab('/put'),'/work');assert.equal(currentWorkTab('/work/timing'),null);
});
test('custom role cannot discover Assign Work or Record Movement without its own permission',()=>{
 const user={id:2,name:'Viewer',role:'custom',capabilities:['work.view']};
 assert.deepEqual(workTabs(user).map(x=>x.href),['/work','/work/history','/work/task-history','/recommended-actions']);
 const html=page({title:'My Work',user,currentPath:'/work',content:workNavigation(user,'/work')});
 assert.doesNotMatch(sidebar(html),/Assign Work|Record Movement/);assert.doesNotMatch(workNavigation(user),/Assign Work|Record Movement/);
 const assignee={...user,capabilities:['work.view','work.assign']};assert.ok(workTabs(assignee).some(x=>x.href==='/work/overview'));assert.ok(!workTabs(assignee).some(x=>x.href==='/record-movement'));
});
