import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {CAPABILITIES,SETTINGS,OPERATOR_CAPABILITIES} from '../src/modules/access/catalog.js';

function countUI(){
 const root={querySelectorAll:()=>[]},context=vm.createContext({document:{querySelector:s=>s==='#stocktaking-app'?root:null},localStorage:{getItem:()=>null},location:{pathname:'/stocktaking',search:''},URLSearchParams,FormData:class{constructor(f){this.values=new Map(Object.entries(f.data));}entries(){return this.values.entries();}get(k){return this.values.get(k)??null;}has(k){return this.values.has(k);}}});
 vm.runInContext(readFileSync(new URL('../public/client/stocktaking.js',import.meta.url),'utf8').replace('export async function mount() {','').split("root.addEventListener('submit'")[0],context);
 vm.runInContext("snapshot={site:'test',user:{id:1},capabilities:{count:true,schedule:true,manage:true},products:[],cells:[],runs:[],counters:[],warehouseTimezone:'Europe/London'}",context);
 return{context,run:code=>vm.runInContext(code,context)};
}
test('counting keeps physical totals primary and optional time unknown unless explicitly supplied',()=>{
 const ui=countUI();ui.context.run={attempts:[{id:'a',item_id:1,generation:1,baseline:{products:[{productId:1,name:'Boots',unit:'pairs',recorded:6}],pending:[],reports:[]}}]};ui.context.item={id:1,generation:1};
 const html=ui.run('countForm(run,item)');assert.match(html,/including items waiting to be picked/);assert.match(html,/<summary>Note \/ unidentified items<\/summary>/);assert.match(html,/<summary>Condition<\/summary>/);assert.doesNotMatch(html,/name="countedAt"[^>]*required/);
 ui.context.fixtureForm={dataset:{countAction:'observe'},data:{actual_1:'6',unit_1:'pairs'},querySelectorAll:()=>[{dataset:{countLine:'1'}}]};
 assert.equal(ui.run('collect(fixtureForm).countedAt'),null);assert.equal(ui.run('collect(fixtureForm).lines[0].actual'),'6');
 ui.context.fixtureForm.data.countedAt='2026-09-20T10:15';assert.equal(ui.run('collect(fixtureForm).countedAt'),new Date('2026-09-20T10:15').toISOString());
 ui.context.run.attempts[0].baseline.pending=[{id:2}];assert.match(ui.run('countForm(run,item)'),/Update Counts/);assert.doesNotMatch(ui.run('countForm(run,item)'),/another count once the movement is finished before changing stock/);
 ui.context.run.attempts[0].baseline.products=[];assert.match(ui.run('countForm(run,item)'),/name="emptyConfirmed"/);
});
test('schedule uses warehouse timezone and only enables cadence-relevant interval with stable calendar anchors',()=>{
 const ui=countUI();assert.match(ui.run('schedule()'),/Warehouse time: Europe\/London/);
 const fields={frequency:{value:'weekly'},intervalDays:{value:'10'},nextDue:{value:'2026-10-31'},timezone:{value:'Europe/London'}};
 const nodes=Object.fromEntries(['[data-custom-interval]','[data-timezone-summary]','[data-next-date]'].map(k=>[k,{}]));ui.context.fixtureForm={elements:fields,querySelector:s=>nodes[s]};
 ui.run('scheduleFields(fixtureForm)');assert.equal(nodes['[data-custom-interval]'].hidden,true);assert.equal(fields.intervalDays.disabled,true);assert.match(nodes['[data-next-date]'].textContent,/2026-11-07/);
 fields.frequency.value='monthly';ui.run('scheduleFields(fixtureForm)');assert.match(nodes['[data-next-date]'].textContent,/2026-11-30/);assert.equal(fields.nextDue.value,'2026-10-31');
 fields.frequency.value='custom';ui.run('scheduleFields(fixtureForm)');assert.equal(fields.intervalDays.disabled,false);assert.match(nodes['[data-next-date]'].textContent,/2026-11-10/);
});
test('the count form shows positive stock only while allowing a historical product to be added if found',()=>{
 const ui=countUI();ui.run(`snapshot.products=[{id:1,name:'Boots',sku:'BOOT',unit_of_measure:'pairs'},{id:2,name:'Old shirts',sku:'SHIRT',unit_of_measure:'pieces'}]`);
 ui.context.run={attempts:[{id:'a',item_id:1,generation:1,baseline:{products:[{productId:1,name:'Boots',recorded:6,unit:'pairs'},{productId:2,name:'Old shirts',recorded:0,unit:'pieces'}]}}]};ui.context.item={id:1,generation:1};
 let html=ui.run('countForm(run,item)');assert.match(html,/data-count-line="1"/);assert.doesNotMatch(html,/data-count-line="2"/);assert.match(html,/<option value="2"[^>]*>Old shirts/);
 ui.context.run.attempts[0].baseline.products[0].recorded=0;html=ui.run('countForm(run,item)');assert.doesNotMatch(html,/data-count-line=/);assert.match(html,/data-count-products hidden/);assert.match(html,/name="emptyConfirmed" required/);
 ui.context.run.attempts[0].baseline.productScope=1;html=ui.run('countForm(run,item)');assert.match(html,/Found this product\?/);assert.match(html,/This product is not at this location/);assert.doesNotMatch(html,/<option value="2"/);
});
test('stocktake locations stay hidden until searched, with partial name and area matches',()=>{
 const ui=countUI();
 ui.run(`snapshot.cells=[{id:1,shelf_id:10,warehouse_id:20},{id:2,shelf_id:11,warehouse_id:20}];snapshot.shelves=[{id:10,name:'Rack 5'},{id:11,name:'Rack 6'}];snapshot.warehouses=[{id:20,name:'Main warehouse'}];snapshot.conditions=[];`);
 ui.context.stocktake={id:7,status:'in_progress',scopeChanges:[],items:[{id:101,cell_id:1,logical_code:'Z1-R5-C01',description:{name:'Boots bin',directions:'Rack 5'},state:'pending',counter_name:'Rajesh',assignee_id:1},{id:102,cell_id:2,logical_code:'Z1-R6-C02',description:{name:'Shirts bin',directions:'Rack 6'},state:'counted',counter_name:'Anita'}]};
 assert.equal(ui.run('matchingStocktakeLocations(stocktake," ").length'),0);
 assert.doesNotMatch(ui.run('runView(stocktake)'),/data-count-row=/);
 assert.match(ui.run('runView(stocktake)'),/data-stocktake-location-results hidden/);
 assert.deepEqual(Array.from(ui.run('matchingStocktakeLocations(stocktake," BOOT ").map(i=>i.id)')),[101]);
 assert.deepEqual(Array.from(ui.run('matchingStocktakeLocations(stocktake,"r6-c").map(i=>i.id)')),[102]);
 assert.equal(ui.run('matchingStocktakeLocations(stocktake,"main ware").length'),2);
 assert.match(ui.run('stocktakeLocationResults(stocktake,"boot")'),/data-count-row="101"/);
 assert.doesNotMatch(ui.run('stocktakeLocationResults(stocktake,"boot")'),/data-count-row="102"/);
 assert.match(ui.run('stocktakeLocationResults(stocktake,"boot")'),/Rajesh/);
 assert.match(ui.run('stocktakeLocationResults(stocktake,"missing")'),/No matching locations/);
 assert.equal(ui.run('stocktakeLocationResults(stocktake,"")'),'');
});
test('a paused stocktake shows its summary and Resume without automatically starting from its list link',()=>{
 const ui=countUI();ui.run(`snapshot.conditions=[];snapshot.runs=[{id:7,title:'Main warehouse',status:'in_progress',started_at:'2026-10-13T09:00:00Z',paused_at:'2026-10-13T10:00:00Z',completed:1,total:2,scopeChanges:[],items:[{id:1,cell_id:1,state:'counted',assignee_id:1,description:{name:'A'}},{id:2,cell_id:2,state:'pending',assignee_id:1,description:{name:'B'}}]}]`);
 const html=ui.run('runView(snapshot.runs[0])');assert.match(html,/>Paused</);assert.match(html,/data-start-run/);assert.match(html,/1\/2 cells done/);assert.match(html,/data-scan-stocktake disabled/);assert.doesNotMatch(html,/Start counting|data-count-action="observe"/);
 assert.equal(ui.run('stocktakeLink(snapshot.runs[0])'),'/stocktaking?run=7');assert.match(ui.run('landing()'),/href="\/stocktaking\?run=7">Resume/);
});
test('searching stocktake product locations preserves hidden selections and warehouse eligibility',()=>{
 const ui=countUI(),search={value:''},status={},rows=[
  {textContent:'Boots bin',box:{checked:true,disabled:false}},
  {textContent:'Shirts bin',box:{checked:false,disabled:false}},
  {textContent:'Boots elsewhere',box:{checked:true,disabled:true}}
 ];
 for(const row of rows)row.querySelector=()=>row.box;
 ui.context.picker={querySelector:selector=>selector==='[data-location-search]'?search:status,querySelectorAll:()=>rows};
 ui.run('filterProductLocations(picker)');assert.ok(rows.every(row=>row.hidden));assert.equal(rows[0].box.checked,true);
 search.value=' BOOT ';ui.run('filterProductLocations(picker)');assert.equal(rows[0].hidden,false);assert.equal(rows[1].hidden,true);assert.equal(rows[2].hidden,true);
 search.value='missing';ui.run('filterProductLocations(picker)');assert.equal(status.hidden,false);assert.equal(rows[0].box.checked,true);
 search.value='';ui.run('filterProductLocations(picker)');assert.equal(status.hidden,true);assert.ok(rows.every(row=>row.hidden));
});
test('role editor previews transitive requirements and adds them only after explicit inclusion',()=>{
 const boxes=CAPABILITIES.map(c=>({dataset:{capability:c.id},checked:OPERATOR_CAPABILITIES.includes(c.id)})),nodes={'[data-role-preview]':{},'[data-role-prerequisites]':{},'[data-include-required]':{addEventListener(_,f){this.click=f;}}};let change;
 const form={querySelector:s=>nodes[s],querySelectorAll:s=>s.includes(':checked')?boxes.filter(b=>b.checked):boxes,addEventListener(_,f){change=f;}};
 vm.runInNewContext(readFileSync(new URL('../public/client/roles.js',import.meta.url),'utf8').replace('export function mount','function mount'),{document:{querySelector:s=>s==='[data-role-editor]'?form:{textContent:JSON.stringify({catalog:CAPABILITIES,settings:SETTINGS})}}});
 boxes.find(b=>b.dataset.capability==='work.assign').checked=true;change();assert.equal(nodes['[data-include-required]'].hidden,true);assert.equal(boxes.find(b=>b.dataset.capability==='work.team').checked,false);
 boxes.find(b=>b.dataset.capability==='work.timing').checked=true;change();assert.match(nodes['[data-role-prerequisites]'].textContent,/View team work/);assert.equal(boxes.find(b=>b.dataset.capability==='work.team').checked,false);
 nodes['[data-include-required]'].click();assert.equal(boxes.find(b=>b.dataset.capability==='work.team').checked,true);assert.equal(boxes.find(b=>b.dataset.capability==='hardware.flash').checked,false);assert.equal(nodes['[data-include-required]'].hidden,true);
 boxes.find(b=>b.dataset.capability==='access.manage').checked=true;change();assert.match(nodes['[data-role-prerequisites]'].textContent,/Required additional access/);assert.equal(boxes.find(b=>b.dataset.capability==='hardware.flash').checked,false);
});

test('setup scan confirms a read label, focuses its name and keeps physical confirmation separate; failed camera reveals fallback',async()=>{
 let stopped=false,focused=false,failed=false;
 const input={value:'',dispatchEvent(){}},manual={open:true},status={textContent:''},name={focus(){focused=true;}},video={readyState:2,videoWidth:1,videoHeight:1,play:async()=>{}},host={innerHTML:'',querySelector:s=>s==='video'?video:{}};
 const panel={isConnected:true,querySelector:s=>({'[data-camera-view]':host,'[name="label"]':input,'[data-label-status]':status,'[data-manual-label]':manual,'[name="displayName"]':name})[s]};
 const root={addEventListener(){}},boot={site:'fixture',user:{id:1}};
 const context=vm.createContext({document:{querySelector:s=>s==='#location-setup-app'?root:{textContent:JSON.stringify(boot)},createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:[],width:1,height:1})})})},localStorage:{getItem:()=>null},navigator:{mediaDevices:{getUserMedia:async()=>{if(failed)throw new Error('No camera');return{getTracks:()=>[{stop(){stopped=true;}}]};}}},Event:class{},jsQR:()=>({data:'lytguide:fixture:sticker:1'}),panel});
 context.WarehouseCamera={mountCameraZoom:()=>({drawFrame:()=>true,dispose(){}})};
 vm.runInContext(readFileSync(new URL('../public/client/location-setup.js',import.meta.url),'utf8').replace('export async function mount() {','').split("onPage(window,'pagehide'")[0],context);
 await vm.runInContext('scan(panel)',context);assert.equal(input.value,'lytguide:fixture:sticker:1');assert.equal(manual.open,false);assert.equal(focused,true);assert.equal(stopped,true);assert.equal(status.textContent,'Sticker read. Check that it is beside the blinking light.');
 failed=true;await vm.runInContext('scan(panel)',context);assert.equal(manual.open,true);assert.match(host.textContent,/manual QR text option/);
});
