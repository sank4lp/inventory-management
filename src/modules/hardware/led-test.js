import {randomUUID} from 'node:crypto';
import {escapeHtml as e} from '../../render.js';
import {templatePage,uiPanel,uiTable} from '../../server/ui.js';
import {sendHtml,sendRedirect} from '../../server/http/responses.js';
import {parseForm} from '../../server/http/request-body.js';
import {currentActor} from '../access/service.js';
import {setupLedMap} from '../locations/setup-lights.js';
import {validateLedTest} from './led-test-input.js';

export function ledTestTargets(db) {
  return db.prepare('SELECT * FROM controllers WHERE active=1 ORDER BY controller_code,id').all().flatMap(controller =>
    setupLedMap(db,controller).filter(led=>led.channel).map(led=>{
      const cell=db.prepare('SELECT * FROM cells WHERE controller_id=? AND hardware_channel=?').get(controller.id,led.channel);
      return {key:`led_${controller.id}_${led.channel}`,physical:led.physical,controllerName:controller.controller_code,
        cell:{...cell,id:cell?.id||null,controller_id:controller.id,hardware_channel:led.channel,
          controller_address:controller.address,controller_active:controller.active,heartbeat_status:controller.heartbeat_status,
          logical_code:cell?.logical_code||`LED ${led.physical}`}};
    }));
}

export function startLedTest(state,user,form) {
  const actor=currentActor(state.db,user,'hardware.test');
  const action=String(form.action||'show');
  if(!['show','locate','ping'].includes(action))throw new Error('Choose Show, Locate or Ping.');
  const spec=action==='show'?validateLedTest({mode:form.mode,text:String(form.text??'').trim(),color:String(form.color??''),brightness:form.brightness===''||form.brightness==null?NaN:Number(form.brightness)}):{};
  const available=ledTestTargets(state.db),keys=Object.keys(form).filter(k=>k.startsWith('led_')&&form[k]==='on');
  if(!keys.length)throw new Error('Select at least one LED matrix.');
  if(keys.some(k=>!available.some(t=>t.key===k)))throw new Error('An LED selection is no longer available. Refresh the page and select again.');
  const scope={kind:action==='show'?'led_test':action,ledTest:true,uiValues:{mode:form.mode,text:form.text,brightness:form.brightness,color:form.color},...spec,setupTargets:available.filter(t=>keys.includes(t.key)).map(t=>t.cell)};
  const requestId=String(form.requestId||randomUUID());
  // A retried POST must not clear and replay its own successful display.
  const existing=state.db.prepare('SELECT id FROM display_requests WHERE id=?').get(requestId);
  if(!existing){
    const previous=state.db.prepare("SELECT id FROM display_requests WHERE actor_id=? AND state IN ('active','expiring') AND (json_extract(scope_json,'$.kind')='led_test' OR json_extract(scope_json,'$.ledTest')=1)").all(actor.id);
    for(const row of previous){
      state.displayCoordinator.stop(actor,row.id);
      if(state.db.prepare('SELECT state FROM display_requests WHERE id=?').get(row.id).state!=='stopped')throw new Error('The previous test has not cleared. Check the controller connection and try again.');
    }
  }
  return state.displayCoordinator.start(actor,scope,{requestId});
}

export function renderLedTest(state,user,form={},error='') {
  const actor=currentActor(state.db,user,'hardware.test'),targets=ledTestTargets(state.db);
  const row=state.db.prepare("SELECT * FROM display_requests WHERE actor_id=? AND (json_extract(scope_json,'$.kind')='led_test' OR json_extract(scope_json,'$.ledTest')=1) ORDER BY created_at DESC,rowid DESC LIMIT 1").get(actor.id);
  const previous=row?JSON.parse(row.scope_json):null;
  const values={mode:'text',text:'8',brightness:100,color:'#00ff00',...previous,...previous?.uiValues,...form};
  const selected=new Set(Object.keys(form).length?Object.keys(form).filter(k=>form[k]==='on'):previous?.setupTargets?.map(c=>`led_${c.controller_id}_${c.hardware_channel}`)||[]);
  const cells=uiTable([{key:'select',label:'Select'},{key:'controller',label:'Controller'},{key:'led',label:'LED number'},{key:'bin',label:'Bin'},{key:'health',label:'Controller status'}],targets.map(t=>[
    `<input type="checkbox" name="${t.key}" data-led-choice ${selected.has(t.key)?'checked':''} aria-label="${e(t.controllerName)} LED ${t.physical}">`,
    e(t.controllerName),String(t.physical),e(t.cell.display_name||t.cell.logical_code),e(t.cell.heartbeat_status||'Unknown')
  ]),{label:'LED matrices',empty:'No configured LEDs. Add a controller and its LED modules in Hardware.'});
  const statuses={sent:'Sent',busy:'Busy — work or another display',unreachable:'Offline / not confirmed',unmapped:'Not mapped',unsupported:'Unsupported'};
  const report=row?JSON.parse(row.targets_json):[];
  const active=row&&['active','expiring'].includes(row.state)&&row.expires_at>new Date().toISOString();
  const patternButton=(kind,label,running)=>{const on=active&&previous?.kind===kind;return `<button name="action" value="${kind}" formnovalidate data-led-pattern="${kind}"${on?` formaction="/settings/led-test/stop" data-until="${e(row.expires_at)}" aria-pressed="true"`:' aria-pressed="false"'}${targets.length?'':' disabled'}>${on?running:label}</button>`;};
  const results=row?uiPanel('Last test',`<p>${row.state==='expiring'?'Stopping — waiting for controller confirmation.':active?`${report.filter(t=>t.status==='sent').length} of ${report.length} matrices sent. ${previous?.kind==='ping'?'Ping: five seconds.':previous?.kind==='locate'?'Locate: five minutes.':'Test window: two minutes.'}`:'Test ended.'}</p>${uiTable([{key:'controller',label:'Controller'},{key:'led',label:'LED number'},{key:'result',label:'Delivery'}],report.map(t=>{
    const target=targets.find(a=>a.cell.controller_id===t.controllerId&&a.cell.hardware_channel===t.channel);
    return [e(target?.controllerName||String(t.controllerId)),e(String(target?.physical||t.channel)),e(statuses[t.status]||t.status)];
  }),{label:'Test delivery'})}${row.state!=='stopped'?`<form method="post" action="/settings/led-test/stop" class="ui-actions"><input type="hidden" name="displayId" value="${e(row.id)}"><button class="ui-button-secondary">Stop test</button></form>`:''}`):'';
  return templatePage({title:'LED matrix test',currentPath:'/settings/led-test',user,content:`<div class="ui-settings-page led-test-page">
    <nav class="ui-toolbar"><a href="/settings">← Settings</a><a href="/devices">Hardware</a></nav>
    ${error?`<p role="alert" class="led-test-error">${e(error)}</p>`:''}
    ${uiPanel('Test display',`<form method="post" action="/settings/led-test" class="ui-form" data-led-test-form>
      <input type="hidden" name="requestId" value="${randomUUID()}"><input type="hidden" name="displayId" value="${e(row?.id||'')}">
      <div class="led-test-controls">
        <label>Display type<select name="mode"><option value="text"${values.mode==='text'?' selected':''}>Text (String)</option><option value="integer"${values.mode==='integer'?' selected':''}>Number (Int)</option></select></label>
        <label>Content<input name="text" required maxlength="55" value="${e(values.text)}" autocomplete="off"></label>
        <label>Brightness (%)<input type="number" name="brightness" min="0" max="100" step="1" required value="${e(values.brightness)}"></label>
        <label>Colour<input type="color" name="color" value="${/^#[0-9a-f]{6}$/i.test(values.color)?values.color:'#00ff00'}"></label>
      </div>
      <div class="ui-toolbar"><label><input type="checkbox" data-led-select-all> Select all LEDs</label><span data-led-selection-count aria-live="polite"></span></div>
      <div class="ui-actions led-test-actions"><button name="action" value="show"${targets.length?'':' disabled'}>Show on selected LEDs</button>${patternButton('locate','Locate','Locating')}${patternButton('ping','Ping','Pinging')}</div>${cells}
      <details class="ui-help"><summary>Help</summary><p>The same content appears on each selected matrix. Longer content scrolls. Text supports up to 55 English letters, numbers or symbols, without double quotes. Brightness 0 turns the pixels dark.</p><p>Busy LEDs are skipped. Content tests stop after two minutes. Locate uses the red inward pattern for five minutes; Ping uses the green outward pattern for five seconds. Click Locating or Pinging again to stop. These patterns use full brightness and their standard colours. Timers continue when you leave this page. Stop test ends the display sooner. Inventory and LED mappings are unchanged.</p></details>
    </form>`)}${results}</div><link rel="stylesheet" href="/led-test.css"><script type="module" src="/client/led-test.js"></script>`});
}

export async function ledTestRoutes(request,response,url,user,state) {
  if(!['/settings/led-test','/settings/led-test/stop'].includes(url.pathname))return false;
  currentActor(state.db,user,'hardware.test');
  if(request.method==='GET'){
    state.displayCoordinator.expire();
    sendHtml(response,renderLedTest(state,user));return true;
  }
  if(request.method!=='POST')return false;
  const form=await parseForm(request);
  try{
    if(url.pathname.endsWith('/stop')){
      const row=state.db.prepare("SELECT id FROM display_requests WHERE id=? AND actor_id=? AND (json_extract(scope_json,'$.kind')='led_test' OR json_extract(scope_json,'$.ledTest')=1)").get(form.displayId,user.id);
      if(!row)throw new Error('This test is no longer available for your account.');
      state.displayCoordinator.stop(user,row.id);
    }else startLedTest(state,user,form);
    sendRedirect(response,'/settings/led-test');
  }catch(error){sendHtml(response,renderLedTest(state,user,form,error.message),422);}
  return true;
}
