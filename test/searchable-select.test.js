import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {matchingOptions,selectionError} from '../public/client/searchable-select.js';

test('searchable selection requires an explicit choice, filters unavailable options, and permits clearing optional values',()=>{
 const rows=[{value:'1',textContent:'Alex · ALX'},{value:'2',textContent:'Sam',disabled:true},{value:'3',textContent:'Samantha',hidden:true}];
 assert.deepEqual(matchingOptions(rows,'alx'),[rows[0]]);assert.deepEqual(matchingOptions(rows,'sam'),[]);assert.deepEqual(matchingOptions(rows,'missing'),[]);
 assert.equal(selectionError('','Alex',true),'Choose an option from the list.');assert.equal(selectionError('','Alex',false),'Choose an option from the list.');assert.equal(selectionError('','',true),'Choose an option.');assert.equal(selectionError('','',false),'');assert.equal(selectionError('1','Alex',true),'');
});
function harness(){
 const root={querySelectorAll:()=>[]};const ctx=vm.createContext({document:{querySelector:()=>root},location:{pathname:'/pending-confirmations',search:''},localStorage:{getItem:()=>null},crypto:{randomUUID:()=>1},URLSearchParams,AbortSignal});
 vm.runInContext(readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8').split('let syncing=false;')[0],ctx);
 vm.runInContext("snapshot={site:'s',dataset:'d',user:{id:1,role:'admin'},pending:[{id:'r'}]};online=true",ctx);
 const form={elements:{reportId:{value:'r'}}};ctx.select={dataset:{searchRemote:'movements'},isConnected:true,closest:()=>form};ctx.signal={aborted:false};
 // A real signal is required by the timeout composition.
 ctx.signal=new AbortController().signal;
 return {ctx,form,run:code=>vm.runInContext(code,ctx)};
}
test('full-history combobox reads use scoped GET, no-store and identity envelope; no auto-selection',async()=>{
 const h=harness();let url,opts;h.ctx.fetch=async(u,o)=>{url=u;opts=o;return {ok:true,json:async()=>({site:'s',dataset:'d',actorId:1,movements:[{id:'old',quantity:2,unit:'cases',origin_ref:'paper-2020',created_at:'2020-01-01',performer_name:'Sam'}]})};};
 const result=await h.run("searchCombo(select,'paper-2020',signal)");assert.match(url,/movements\?reportId=r&q=paper-2020/);assert.equal(opts.cache,'no-store');assert.equal(opts.method,undefined);assert.equal(result.options[0].value,'old');assert.equal(h.ctx.select.value,undefined);
});
test('remote results cannot cross session, warehouse, dataset, capability, detached form or report changes',async()=>{
 for(const mutate of ["snapshot.user.id=2","snapshot.site='other'","snapshot.dataset='new'","snapshot.capabilities={review:false}","select.isConnected=false","snapshot.pending=[]"]){const h=harness();let resolve;h.ctx.fetch=()=>new Promise(r=>resolve=r);const result=h.run("searchCombo(select,'q',signal)");h.run(mutate);resolve({ok:true,json:async()=>({site:'s',dataset:'d',actorId:1,movements:[]})});await assert.rejects(result,/changed/);}
 const h=harness();h.ctx.fetch=async()=>({ok:true,json:async()=>({site:'s',dataset:'d',actorId:2,movements:[]})});await assert.rejects(h.run("searchCombo(select,'q',signal)"),/changed/);
 h.run('online=false');await assert.rejects(h.run("searchCombo(select,'q',signal)"),/Reconnect/);
});
test('count lookup retains complete server candidates and useful errors',async()=>{
 const h=harness();h.ctx.select.dataset.searchRemote='counts';h.ctx.fetch=async()=>({ok:true,json:async()=>({site:'s',dataset:'d',actorId:1,counts:[{id:10,title:'Annual count',created_at:'2026-01-01',lines:[{name:'Cases',actual:5,difference:2,unit:'cases'}]}]})});const r=await h.run("searchCombo(select,'Annual',signal)");assert.equal(r.options[0].value,10);assert.equal(h.form._countCandidates[0].id,10);assert.match(r.options[0].label,/actual 5/);
 h.ctx.fetch=async()=>({ok:false,json:async()=>({error:'Review no longer available'})});await assert.rejects(h.run("searchCombo(select,'Annual',signal)"),/Review no longer available/);
});
test('all duplicated work search/select pairs share enhancement and offline shell caches the module',()=>{
 const source=readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8');assert.doesNotMatch(source,/data-(operator|product|count|movement|people)-search|data-search-counts|data-search-history/);assert.match(source,/data-search-remote="counts"/);assert.match(source,/data-search-remote="movements"/);
 for(const file of ['../public/sw.js','../src/modules/operations/routes.js','../src/render.js'])assert.match(readFileSync(new URL(file,import.meta.url),'utf8'),/client\/searchable-select.js/);
 const routes=readFileSync(new URL('../src/modules/operations/routes.js',import.meta.url),'utf8');assert.match(routes,/identity\(\),actorId:user.id,counts/);assert.match(routes,/identity\(\),actorId:user.id,movements/);
});

test('remote routes return current request identity and no-store without invoking commands',async()=>{
 const {operationsRoutes}=await import('../src/modules/operations/routes.js');
 for(const kind of ['countCandidates','movements']){
  const service={identity:()=>({site:'warehouse',dataset:'generation'}),countCandidates:()=>[],searchMovements:()=>[],command:()=>{throw Error('Unexpected command');}};
  const response={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=JSON.parse(body);}};
  await operationsRoutes({method:'GET'},response,new URL('http://test/api/work/'+kind+'?reportId=r'),{id:7},{operationsService:service});
  assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.body.actorId,7);assert.equal(response.body.site,'warehouse');assert.equal(response.body.dataset,'generation');
 }
});

test('restored remote count drafts display the selected count evidence, not the current default candidate',()=>{
 const h=harness(),field={name:'countCorrectionId',value:'',type:'select-one',dataset:{searchRemote:'counts'},options:[],add(option){this.options.push(option);}},query={name:'countCorrectionIdQuery',value:'',type:'text',dataset:{}},sequence={textContent:''};
 const elements=Object.assign([field,query],{countCorrectionId:field,reportId:{value:'r'}}),form={dataset:{workAction:'resolve'},elements,querySelector:()=>sequence};
 const root=h.ctx.document.querySelector('#work-app');root.querySelectorAll=()=>[form];h.ctx.form=form;h.ctx.Option=function(text,value){this.textContent=text;this.value=value;};
 h.ctx.values={countCorrectionId:{value:'older',option:'Older count',candidate:{id:'older',logical_code:'A-01',lines:[{productId:1,recorded:12,actual:9,unit:'cases'}],counter_name:'Sam'}},countCorrectionIdQuery:{value:'Older count'}};
 h.run("snapshot.pending=[{id:'r',product_id:1,direction:'pick',quantity:3,unit:'cases',countEvidence:{id:'newer',logical_code:'A-01',lines:[{productId:1,recorded:9,actual:8,unit:'cases'}]}}];drafts.set(draftKey(form),values);restoreDrafts()");
 assert.equal(field.value,'older');assert.equal(form._countCandidates[0].id,'older');assert.match(sequence.textContent,/from 12 to 9 cases/);assert.doesNotMatch(sequence.textContent,/from 9 to 8/);
});
