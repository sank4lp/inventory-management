import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/client/location-history.js',import.meta.url),'utf8').replace('export function','function');
test('cell timeline renders ledger quantities, separate identities, scoped access and paging without editable controls',()=>{
 const context=vm.createContext({document:{querySelector:()=>null}});vm.runInContext(source,context);
 context.data={scope:'own',cell:{display_name:'<img onerror=alert(1)>',logical_code:'A'},entries:[{time:'2026-10-01T10:00:00Z',taskId:9,type:'pick',quantity:-2,unit:'cases',product:'Part <A>',performer:null,recorder:'Admin',reason:'<script>bad</script>'}],page:{number:1,pages:2,total:51}};
 const html=vm.runInContext('cellHistoryContent(data)',context);assert.match(html,/Your recorded movements/);assert.match(html,/Not recorded/);assert.match(html,/Admin/);assert.match(html,/>-2<\/td><td>cases/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img|<input|<form/);assert.match(html,/data-cell-history-page="2"/);assert.match(html,/IST/);
 context.data.scope='team';context.data.entries=[];assert.match(vm.runInContext('cellHistoryContent(data)',context),/No recorded movements/);assert.doesNotMatch(vm.runInContext('cellHistoryContent(data)',context),/Your recorded movements/);
});
