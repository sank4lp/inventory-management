import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PageScope} from '../public/client/page-lifecycle.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const quantitySource=source.slice(source.indexOf('function catalogProductQuantityKey('),source.indexOf('function wireProductFindLedCleanup('));
class Target {
  handlers=new Map();
  addEventListener(type,fn){const set=this.handlers.get(type)||new Set();set.add(fn);this.handlers.set(type,set);}
  removeEventListener(type,fn){this.handlers.get(type)?.delete(fn);}
  async fire(type,event){for(const handler of this.handlers.get(type)||[])await handler(event);}
}
function button(dataset){const attributes={};return {dataset,matches:selector=>selector.includes('[data-locate-cell]')&&dataset.locateCell!==undefined||selector.includes('[data-adjustment-locate-cell]')&&dataset.adjustmentLocateCell!==undefined||selector.includes('[data-ping-cell]')&&dataset.pingCell!==undefined,closest:()=>null,disabled:false,textContent:dataset.locateCell!==undefined?'Locate':'Show Quantity',classList:{toggle(){}},getAttribute:key=>attributes[key]??null,setAttribute:(key,value)=>attributes[key]=value,attributes};}

test('quantity handlers work after repeated content-only navigation without duplicate commands',async()=>{
  const document=new Target(),window=new Target(),requests=[],clears=[];
  document.documentElement={dataset:{}};let buttons=[];
  document.querySelectorAll=()=>buttons;window.location={pathname:'/products',search:''};
  const host={...globalThis,fetch:async()=>{},setTimeout,clearTimeout,setInterval,clearInterval};
  function mount(scope){
    const loading=new WeakMap();
    const context=vm.createContext({document,window,pageScope:scope,URLSearchParams,crypto,
      activeCatalogProductQuantity:null,onPage:(target,...args)=>scope.listen(target,...args),setTimeout:(...args)=>scope.timeout(...args),
      setButtonLoading:(button,active)=>{if(active&&!loading.has(button)){loading.set(button,button.textContent);button.disabled=true;button.textContent='Working';}else if(!active&&loading.has(button)){button.textContent=loading.get(button);button.disabled=false;loading.delete(button);}},
      sendProductFindLedClearEndpoint:async(endpoint,{body})=>clears.push({endpoint,id:body.get('displayId')}),
      fetch:async(endpoint,options)=>{const preview=options.body.get('previewOnly')==='1';requests.push({endpoint,preview,kind:options.body.get('kind'),cellId:options.body.get('cellId'),displayId:options.body.get('displayId')});return {ok:true,json:async()=>preview?{state:'ready'}:{displayId:'display-'+requests.length,targets:[{status:'sent'}]}};}});
    vm.runInContext(quantitySource+';wireCatalogProductQuantity();wireCatalogProductQuantity();',context);
  }
  for(const dataset of [
    {productId:'15',activateEndpoint:'/products/15/find',clearEndpoint:'/products/15/find/clear'},
    {cellId:'2',activateEndpoint:'/api/cells/2/count',clearEndpoint:'/api/cells/2/count/clear'},
    {quantityKey:'catalog-audit',activateEndpoint:'/products/quantities',clearEndpoint:'/products/quantities/clear'},
    {quantityKey:'locations-audit',activateEndpoint:'/cells/quantities',clearEndpoint:'/cells/quantities/clear'},
    {locateCell:'',cellId:'3'},
    {pingCell:'',cellId:'5'},
    {adjustmentLocateCell:'',cellId:'4',showLabel:'Locate Cell'},
  ]){
    const scope=new PageScope(host),control=button(dataset);buttons=[control];mount(scope);
    assert.equal(document.handlers.get('click').size,1);
    const before=requests.length;await document.fire('click',{target:{closest:()=>control},preventDefault(){}});
    assert.equal(requests.length-before,2,'one preview and one activation per click');
    if(dataset.locateCell!==undefined||dataset.adjustmentLocateCell!==undefined){
      assert.ok(requests.slice(before).every(r=>r.kind==='locate'&&r.cellId===dataset.cellId&&r.endpoint===`/api/cells/${dataset.cellId}/locate`));
    }
    if(dataset.pingCell!==undefined)assert.ok(requests.slice(before).every(r=>r.kind==='ping'&&r.endpoint===`/api/cells/${dataset.cellId}/ping`));
    assert.equal(control.attributes['aria-pressed'],'true');assert.equal(control.textContent,dataset.pingCell!==undefined?'Pinging':dataset.locateCell!==undefined||dataset.adjustmentLocateCell!==undefined?'Locating':'Showing Quantity');
    await document.fire('click',{target:{closest:()=>control},preventDefault(){}});
    assert.equal(requests.at(-1).displayId,'display-'+(before+2),'stop uses the original display ownership receipt');
    assert.equal(control.attributes['aria-pressed'],'false');assert.equal(control.textContent,dataset.showLabel||(dataset.pingCell!==undefined?'Ping':dataset.locateCell!==undefined?'Locate':'Show Quantity'),'loading restoration must not leave the button labelled as active');
    await document.fire('click',{target:{closest:()=>control},preventDefault(){}});
    assert.equal(control.attributes['aria-pressed'],'true');
    scope.dispose();assert.equal(document.handlers.get('click').size,0);assert.equal(document.documentElement.dataset.catalogProductQuantityBound,undefined);
    assert.equal(clears.at(-1).endpoint,dataset.clearEndpoint||'/api/displays/stop','leave cleans the display owned by this page');
  }
  assert.equal(clears.length,7);
});

test('legacy location utility listeners are reattached to the retained document after leaving',()=>{
  const document=new Target(),window=new Target();document.documentElement={dataset:{}};
  const wiring=source.slice(source.indexOf('function wireLocationUtilityActions('),source.indexOf('function wireConfigurationWorkspace('));
  for(let n=0;n<3;n++){
    const scope=new PageScope(),context=vm.createContext({document,window,pageScope:scope,onPage:(target,...args)=>scope.listen(target,...args),activeCounts:new Map(),clearAllCountUi:()=>{}});
    vm.runInContext(wiring+';wireLocationUtilityActions();wireLocationUtilityActions();',context);
    assert.equal(document.handlers.get('click').size,1);scope.dispose();assert.equal(document.handlers.get('click').size,0);assert.equal(document.documentElement.dataset.locationUtilityActionsBound,undefined);
  }
});
