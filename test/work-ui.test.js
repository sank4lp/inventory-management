import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the actual rendering functions without booting storage or a network poll.
const source = readFileSync(new URL('../public/client/work.js', import.meta.url), 'utf8').split('let syncing=false;')[0];
function view({online = true, role = 'operator', tasks = []} = {}) {
  const root = {innerHTML: '', querySelectorAll: () => []};
  const context = vm.createContext({
    document: {querySelector: selector => selector === '#work-app' ? root : null},
    crypto: {randomUUID: () => 'test-device'}, localStorage: {getItem: () => 'test-device'},
    URLSearchParams, location: {pathname: '/work', search: ''},
  });
  vm.runInContext(source, context);
  context.state = {site:'warehouse-a',user:{id:1,name:'Operator',role},generatedAt:'2026-09-25T10:00:00Z',products:[],cells:[],tasks};
  vm.runInContext(`snapshot=state;online=${online};`, context);
  return {root, context, run: code => vm.runInContext(code, context)};
}
const line = {id:1,revision:2,cell_id:3,logical_code:'A3',unit_of_measure:'pieces',planned_quantity:5,product_name:'Part',product_id:1,type:'pick',execution_state:'ready',created_by:1};

test('ready work separates arrival from physical-report recovery; working actual remains explicit', () => {
  const ui = view(); ui.context.line = line;
  const ready = ui.run('lineCard(line)');
  assert.match(ready, /Start at this location/);
  assert.match(ready, /data-disclosure="manual-1"[^>]*><summary>Already moved stock/);
  assert.match(ready, /name="manual" value="true"/);
  const working = ui.run("lineCard({...line,execution_state:'working'})");
  const actual = working.match(/<input name="quantity"[^>]+>/)[0];
  assert.match(actual, /min="0"/);
  assert.match(actual, /required/);
  assert.doesNotMatch(actual, /value=/, 'planned quantity must never prefill the actual');
  assert.match(working, /Use 0 if nothing moved/);
  assert.match(working, /data-disclosure="resume-1"/);
  assert.match(working, /name="manual"/);
});

test('offline reports stay accessible and queued/view-only safeguards survive simpler screens', () => {
  const ui = view({online:false}); ui.context.line = line;
  const offline = ui.run('lineCard(line)');
  assert.match(offline, /data-disclosure="manual-1" open/);
  assert.doesNotMatch(offline, /data-work-action="acquire"/);
  const readonly = ui.run('lineCard({...line,canAct:false})');
  assert.doesNotMatch(readonly, /<form/);
  ui.run("outbox=[{partition:key(),state:'local',input:{lineId:1}}]");
  assert.match(ui.run('lineCard(line)'), /Do not repeat the movement/);
  assert.match(ui.run('lineCard(line)'), /<button disabled>Report saved/);
});

test('active and review tasks precede completed history; optional location retains explicit preference', () => {
  const ui = view({tasks:[
    {id:1,status:'completed',summary:'Completed task',lines:[]},
    {id:2,status:'working',summary:'Active task',lines:[]},
    {id:3,status:'completed',attention:1,summary:'Needs checking',lines:[]},
  ]});
  const home = ui.run('home()');
  assert.ok(home.indexOf('Active task') < home.indexOf('Completed task'));
  assert.ok(home.indexOf('Needs checking') < home.indexOf('data-disclosure="completed-work"'));
  const plan = ui.run("createPage('pick')");
  assert.match(plan, /data-disclosure="preferred-location"[^>]*><summary>/);
  ui.run("location.search='?cell_id=3'");
  assert.match(ui.run("createPage('put')"), /data-disclosure="preferred-location" open/);
});

test('refresh restores both opened and explicitly closed disclosure state', () => {
  const ui = view();
  const before = [{dataset:{disclosure:'work-tools'},open:true},{dataset:{disclosure:'manual-1'},open:false}];
  const after = [{dataset:{disclosure:'work-tools'},open:false},{dataset:{disclosure:'manual-1'},open:true}];
  let reads = 0;
  ui.root.querySelectorAll = () => reads++ === 0 ? before : after;
  ui.run('render()');
  assert.equal(after[0].open,true);
  assert.equal(after[1].open,false);
});

test('mobile menu Escape and breakpoint changes restore focus after CSS hides a link', () => {
  const handlers = new Map();
  const listen = target => (name, callback) => handlers.set(`${target}:${name}`,callback);
  const classes = new Set();
  const document = {body:{},activeElement:null,addEventListener:listen('document')};
  const media = {matches:false,addEventListener:listen('media')};
  const link = {closest:()=>null,focus:()=>{document.activeElement=link;}};
  const attrs = {'aria-expanded':'false'};
  const toggle = {hidden:true,textContent:'Menu',addEventListener:listen('toggle'),getAttribute:n=>attrs[n],setAttribute:(n,v)=>{attrs[n]=v;},focus:()=>{document.activeElement=toggle;}};
  const sidebar = {
    classList:{add:c=>classes.add(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},
    querySelector:s=>s==='.mobile-nav-toggle'?toggle:link,
    contains:e=>e===link||e===toggle,addEventListener:listen('sidebar'),
  };
  document.querySelector=()=>sidebar;
  vm.runInNewContext(readFileSync(new URL('../public/client/mobile-nav.js',import.meta.url),'utf8'),{document,window:{matchMedia:()=>media,addEventListener:listen('window')}});
  assert.equal(toggle.hidden,false);
  assert.ok(classes.has('nav-ready'));
  handlers.get('document:focusin')({target:link});
  document.activeElement=document.body; // Browser blurs a link as display:none takes effect.
  media.matches=true;handlers.get('media:change')();
  assert.equal(document.activeElement,toggle);
  handlers.get('toggle:click')();
  assert.equal(attrs['aria-expanded'],'true');
  let prevented=false;
  handlers.get('sidebar:keydown')({key:'Escape',preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(attrs['aria-expanded'],'false');
  assert.equal(document.activeElement,toggle);
  media.matches=false;handlers.get('media:change')();
  assert.equal(document.activeElement,link);
  assert.equal(classes.has('mobile-menu-open'),false);
});
