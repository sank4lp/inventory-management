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
 const html=ui.run('countForm(run,item)');assert.match(html,/including items waiting to be picked/);assert.match(html,/<summary>Notes, earlier counting time or unidentified items<\/summary>/);assert.match(html,/<summary>Damaged or expired items<\/summary>/);assert.doesNotMatch(html,/name="countedAt"[^>]*required/);
 ui.context.fixtureForm={dataset:{countAction:'observe'},data:{actual_1:'6',unit_1:'pairs'},querySelectorAll:()=>[{dataset:{countLine:'1'}}]};
 assert.equal(ui.run('collect(fixtureForm).countedAt'),null);assert.equal(ui.run('collect(fixtureForm).lines[0].actual'),'6');
 ui.context.fixtureForm.data.countedAt='2026-09-20T10:15';assert.equal(ui.run('collect(fixtureForm).countedAt'),new Date('2026-09-20T10:15').toISOString());
 ui.context.run.attempts[0].baseline.pending=[{id:2}];assert.match(ui.run('countForm(run,item)'),/another count once the movement is finished before changing stock/);
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
 const panel={querySelector:s=>({'[data-camera-view]':host,'[name="label"]':input,'[data-label-status]':status,'[data-manual-label]':manual,'[name="displayName"]':name})[s]};
 const root={addEventListener(){}},boot={site:'fixture',user:{id:1}};
 const context=vm.createContext({document:{querySelector:s=>s==='#location-setup-app'?root:{textContent:JSON.stringify(boot)},createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:[],width:1,height:1})})})},localStorage:{getItem:()=>null},navigator:{mediaDevices:{getUserMedia:async()=>{if(failed)throw new Error('No camera');return{getTracks:()=>[{stop(){stopped=true;}}]};}}},Event:class{},jsQR:()=>({data:'lytguide:fixture:sticker:1'}),panel});
 vm.runInContext(readFileSync(new URL('../public/client/location-setup.js',import.meta.url),'utf8').replace('export async function mount() {','').split("onPage(window,'pagehide'")[0],context);
 await vm.runInContext('scan(panel)',context);assert.equal(input.value,'lytguide:fixture:sticker:1');assert.equal(manual.open,false);assert.equal(focused,true);assert.equal(stopped,true);assert.equal(status.textContent,'Sticker read. Check that it is beside the blinking light.');
 failed=true;await vm.runInContext('scan(panel)',context);assert.equal(manual.open,true);assert.match(host.textContent,/manual QR text option/);
});
