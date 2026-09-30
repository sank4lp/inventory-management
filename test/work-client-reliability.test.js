import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/client/work.js',import.meta.url),'utf8');
function client(){
 const root={innerHTML:'',querySelectorAll:()=>[],contains:()=>false,addEventListener:()=>{}};
 const context=vm.createContext({document:{querySelector:s=>s==='#work-app'?root:null},crypto:{randomUUID:()=> 'test-device'},localStorage:{getItem:()=> 'test-device',setItem:()=>{}},URLSearchParams,location:{pathname:'/work',search:''},AbortSignal,Date,Map});
 vm.runInContext(source.slice(0,source.indexOf("root.addEventListener('invalid'")),context);
 vm.runInContext(`snapshot={site:'test',dataset:'data',user:{id:1,role:'operator'},tasks:[],products:[],cells:[],reports:[]};`,context);
 return {context,run:s=>vm.runInContext(s,context)};
}
test('lost response retries the exact durable command; other accounts are never delivered',async()=>{
 const {context,run}=client();const records=new Map(),sent=[];let attempt=0;
 const report={id:'durable-one',partition:'test:1',action:'report',state:'local',input:{requestId:'durable-one',actorId:1,lineId:7,quantity:4,revision:2}};
 records.set(report.id,report);records.set('other',{...report,id:'other',partition:'test:2',input:{...report.input,actorId:2}});
 context.records=records;context.sent=sent;context.fetch=async(url,options)=>{sent.push(options.body);if(attempt++===0)throw new TypeError('lost response');return {ok:true,json:async()=>({status:'recorded',message:'Recorded'})};};
 run(`store=async(name,mode,fn)=>fn({getAll:()=>[...records.values()],put:o=>records.set(o.id,o)});refresh=async()=>{online=true;};`);
 await run('sync()');assert.equal(records.get('durable-one').state,'local');assert.equal(sent.length,1);
 await run('sync()');assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);assert.equal(records.get('durable-one').state,'recorded');assert.equal(records.get('other').state,'local');
});
test('refresh refuses account changes before sending any queued work',async()=>{
 const {context,run}=client();let writes=0;context.fetch=async()=>({ok:true,json:async()=>({site:'test',user:{id:2},reports:[]})});context.saved=()=>{writes++;};
 run('store=async()=>saved();');await assert.rejects(run('refresh()'),/account or warehouse changed/);assert.equal(writes,0);
});
test('Finish queued during an existing sync is delivered before its own sync resolves',async()=>{
 const {context,run}=client();const records=new Map(),sent=[];let release;
 context.records=records;context.sent=sent;context.fetch=async(url,options)=>{sent.push(options.body);return {ok:true,json:async()=>({status:'recorded',message:'Recorded'})};};
 context.pause=new Promise(resolve=>{release=resolve;});
 run(`store=async(name,mode,fn)=>fn({getAll:()=>[...records.values()],put:o=>records.set(o.id,o)});let refreshCount=0;refresh=async()=>{if(++refreshCount===2)await pause;};`);
 const first=run('sync()');
 // The first pass has read an empty queue and is now refreshing its receipt view.
 while(run('refreshCount')<2)await Promise.resolve();
 records.set('during-refresh',{id:'during-refresh',partition:'test:1',action:'report',state:'local',input:{requestId:'during-refresh',actorId:1,lineId:7,quantity:2}});
 const finish=run('sync()');release();await Promise.all([first,finish]);
 assert.equal(sent.length,1);assert.equal(records.get('during-refresh').state,'recorded');
});
test('summary and quantity draft identities are bound to instruction, account and method context',()=>{
 const {context,run}=client();context.l={id:7,revision:2,current_generation:1};
 const first=run('stageKey(l)');run('l.revision=3');assert.notEqual(run('stageKey(l)'),first);run('l.revision=2;snapshot.user.id=2');assert.notEqual(run('stageKey(l)'),first);
 context.form={dataset:{workAction:'report'},elements:{lineId:{value:'7'},revision:{value:'2'}}};const normal=run('draftKey(form)');run("form.dataset.draftKind='difference'");assert.notEqual(run('draftKey(form)'),normal);
});
function scanner(){
 const {context,run}=client();const frames=[],commands=[],summaries=[];let stopped=0,removed=0;const buttons={};
 const video={readyState:2,videoWidth:1,videoHeight:1,play:async()=>{}};
 const dialog={innerHTML:'',showModal(){},remove(){removed++;},addEventListener(){},querySelector(s){if(s==='video')return video;return buttons[s]||=( {} );}};
 context.document.createElement=tag=>tag==='dialog'?dialog:{getContext:()=>({drawImage(){},getImageData:()=>({data:[],width:1,height:1})})};context.document.body={append(){}};
 context.window={isSecureContext:true,jsQR:()=>({data:'expected-label'})};context.navigator={mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}]})}};
 context.requestAnimationFrame=fn=>frames.push(fn);context.commands=commands;context.summaries=summaries;
 run("immediate=async(action,input)=>{commands.push({action,input});return {message:'Verified'};};showSummary=async(l,method,label)=>summaries.push({l,method,label});render=()=>{};");
 const a=source.indexOf('let stopCamera=null;'),b=source.indexOf("window.addEventListener('pagehide'",a);run(source.slice(a,b));
 context.l={id:7,revision:2,current_generation:1,product_name:'Part',type:'pick',planned_quantity:5,unit_of_measure:'pieces',logical_code:'A'};
 return {context,run,frames,commands,summaries,buttons,counts:()=>({stopped,removed})};
}
test('simulated camera frame verifies then opens summary, stops stream and never sends a movement',async()=>{
 const s=scanner();await s.run('scanQR(l)');await s.frames.shift()();assert.deepEqual(s.commands.map(c=>c.action),['verify']);assert.equal(s.summaries[0].method,'camera');assert.equal(s.counts().stopped,1);assert.equal(s.counts().removed,1);
});
test('camera closing before permission resolves still releases the late stream without submitting',async()=>{
 const s=scanner();let grant;s.context.navigator.mediaDevices.getUserMedia=()=>new Promise(r=>grant=r);const pending=s.run('scanQR(l)');s.buttons['[data-close-camera]'].onclick();let stops=0;grant({getTracks:()=>[{stop(){stops++;}}]});await pending;assert.equal(stops,1);assert.equal(s.commands.length,0);assert.equal(s.summaries.length,0);
});
test('wrong simulated QR stays in camera with error and cannot unlock Finish',async()=>{
 const s=scanner();s.run("immediate=async()=>{throw new Error('Wrong QR');}");await s.run('scanQR(l)');await s.frames.shift()();assert.equal(s.summaries.length,0);assert.equal(s.buttons['.scan-feedback'].textContent,'Wrong QR');s.buttons['[data-close-camera]'].onclick();assert.equal(s.counts().stopped,1);
});

test('an unresolved camera permission prompt does not keep arrival submission locked or prevent manual Finish',async()=>{
 const {context,run}=client();let handler;
 context.rootCapture=(name,fn)=>{if(name==='submit')handler=fn;};
 run("root.addEventListener=rootCapture;saveDraft=async()=>{};store=async(name,mode,fn)=>fn({getAll:()=>[]});immediate=async()=>({status:'ready',message:'Ready'});refresh=async()=>{};render=()=>{};findLine=()=>({id:7});");
 context.FormData=class{constructor(){return [['lineId','7'],['revision','1']];}};
 const a=source.indexOf('let submitting=false;'),b=source.indexOf("root.addEventListener('click'",a);run(source.slice(a,b));
 // Browser has not answered getUserMedia yet; the manual path must remain available.
 context.scanQR=()=>new Promise(()=>{});const button={disabled:false},feedback={classList:{add(){}},textContent:''};
 const f={dataset:{workAction:'acquire'},querySelector:s=>s==='.form-feedback'?feedback:button};
 await handler({target:{closest:()=>f},preventDefault(){}});assert.equal(run('submitting'),false);
});


function activationClient(){
 const c=client(),records=new Map(),sent=[],visits=[];c.context.records=records;c.context.sent=sent;
 c.context.window={history:{pushState:(state,title,url)=>visits.push(url)}};
 c.context.fetch=async(url,options)=>{sent.push({url,body:options.body});return {ok:true,json:async()=>({status:'recorded',taskId:65,generation:3,message:'Ready'})};};
 c.run(`snapshot.tasks=[{id:65,assignee_id:1,assignment_state:'started',assignment_generation:3,progress_token:'progress',lines:[{id:7,task_id:65,revision:2,current_generation:3,binding_revision:4,planned_quantity:3,execution_state:'ready',canAct:true,reports:[]}]}];online=true;store=async(name,mode,fn)=>fn({getAll:()=>[...records.values()],put:o=>records.set(o.id,o)});refresh=async()=>{};render=()=>{};fetchDialogTask=async()=>snapshot.tasks[0];`);
 return {...c,records,sent,visits};
}
test('Start, Resume and self-create each enter active work in the same document after one explicit POST',async()=>{
 for(const action of ['start','resume','create']){const c=activationClient();assert.equal(c.run('workActive(snapshot.tasks[0])'),false);await c.run(`beginActivation('${action}',{taskId:65})`);assert.equal(c.sent.length,1);assert.equal(c.sent[0].url,'/api/work/'+action);assert.equal(c.run('workActive(snapshot.tasks[0])'),true);assert.match(c.visits[0],/^\/tasks\/65/);assert.equal(c.run('activationPending()'),undefined);}
 assert.equal(activationClient().run('activeWork'),null,'a new document starts passive');
});
test('unknown activation is never background replayed; explicit retry preserves exact request bytes',async()=>{
 const c=activationClient();let lost=true;c.context.fetch=async(url,options)=>{c.sent.push({url,body:options.body});if(lost)throw new TypeError('lost response');return {ok:true,json:async()=>({status:'recorded',taskId:65,generation:3,message:'Ready'})};};
 await assert.rejects(c.run("beginActivation('resume',{taskId:65})"),/lost response/);assert.equal([...c.records.values()][0].state,'activation-unknown');assert.equal(c.run('activeWork'),null);
 await c.run('sync()');assert.equal(c.sent.length,1);await assert.rejects(c.run("beginActivation('create',{})"),/saved Start/);
 lost=false;await c.run('deliverActivation(outbox[0])');assert.equal(c.sent.length,2);assert.equal(c.sent[0].body,c.sent[1].body);assert.equal(c.run('workActive(snapshot.tasks[0])'),true);
});
test('definitive activation rejection frees the task for a corrected new request',async()=>{
 const c=activationClient();c.context.fetch=async()=>({ok:false,status:400,json:async()=>({error:'Stale instructions'})});await assert.rejects(c.run("beginActivation('resume',{taskId:65})"),/Stale/);assert.equal([...c.records.values()][0].state,'not-applied');assert.equal(c.run('activationPending()'),undefined);assert.equal(c.run('taskHasSavedUpdate(snapshot.tasks[0])'),false);
});
test('old-dataset unknown activation is preserved without blocking current work or rewriting retry identity',async()=>{
 const c=activationClient();c.context.old={id:'old',partition:'test:1',action:'create',state:'activation-unknown',input:{site:'test',dataset:'old-data',actorId:1,requestId:'old'}};c.run('records.set(old.id,old);outbox=[old]');const frozen=JSON.stringify(c.context.old.input);
 await assert.rejects(c.run('deliverActivation(old)'),/another account, warehouse or dataset/);assert.equal(c.sent.length,0);assert.equal(JSON.stringify(c.context.old.input),frozen);assert.equal(c.run('activationPending()'),undefined);
 await c.run("beginActivation('create',{})");assert.equal(c.sent.length,1);assert.equal(c.records.get('old').state,'activation-unknown');assert.match(c.run('queueEntry(old)'),/Preserved from another warehouse dataset/);assert.doesNotMatch(c.run('queueEntry(old)'),/data-retry-activation/);
});
test('account and warehouse mismatches cannot deliver a saved activation',async()=>{
 for(const patch of ["actorId:2","site:'other'"]){const c=activationClient();c.run(`outbox=[{id:'saved',partition:key(),action:'resume',state:'activation-unknown',input:{site:'test',dataset:'data',actorId:1,${patch}}}]`);const frozen=c.run('JSON.stringify(outbox[0].input)');await assert.rejects(c.run('deliverActivation(outbox[0])'),/another account/);assert.equal(c.sent.length,0);assert.equal(c.run('JSON.stringify(outbox[0].input)'),frozen);}
});
test('offline activation saves no new intent and passive Refresh light is rejected',async()=>{
 const c=activationClient();c.run('online=false');await assert.rejects(c.run("beginActivation('resume',{taskId:65})"),/Reconnect/);assert.equal(c.records.size,0);c.run("online=true;path='/tasks/65'");await assert.rejects(c.run('refreshActiveLight()'),/Resume this task/);assert.equal(c.sent.length,0);
});
test('legacy queued start/create require explicit retry while saved physical evidence still syncs',async()=>{
 const c=activationClient();for(const action of ['start','create','report'])c.records.set(action,{id:action,partition:'test:1',action,state:'local',input:{site:'test',dataset:'data',actorId:1,requestId:action}});
 await c.run('sync()');assert.equal(c.records.get('start').state,'activation-unknown');assert.equal(c.records.get('create').state,'activation-unknown');assert.deepEqual(c.sent.map(x=>x.url),['/api/work/report']);
});
test('passive polls and reconnects never send a light or activation request',async()=>{
 const c=activationClient();c.context.window.scrollY=0;c.context.window.scrollTo=()=>{};c.run('let monitoring=false,submitting=false,pollDelay=5000;canRefresh=()=>false;patchLiveRows=()=>{};');c.run(source.slice(source.indexOf('async function backgroundRefresh(){'),source.indexOf("window.addEventListener('online'")));
 for(let i=0;i<3;i++)await c.run('backgroundRefresh()');c.run('online=false');await c.run('backgroundRefresh()');assert.equal(c.sent.length,0);assert.equal(c.run('activeWork'),null);
});
test('clear local data refuses to erase an unconfirmed activation receipt',async()=>{
 for(const state of ['activation-pending','activation-unknown']){const c=activationClient();let handler;c.context.capture=(name,fn)=>{if(name==='click')handler=fn;};c.run(`root.addEventListener=capture;outbox=[{id:'uncertain',partition:key(),state:'${state}',input:{}}]`);const a=source.indexOf("root.addEventListener('click'"),b=source.indexOf('let stopCamera=null;',a);c.run(source.slice(a,b));await handler({target:{closest:s=>s==='[data-forget]'?{}:null}});assert.match(c.run('notice'),/Unreceived updates remain/);assert.equal(c.run('outbox.length'),1);}
});

test('recovery dialog stays writable offline and after instruction changes, but keeps its original identity and restores focus',()=>{
 const c=client(),save={disabled:false},warning={},f={dataset:{workAction:'report'},elements:{}},opener={focused:false,focus(){this.focused=true;}};
 const d={dataset:{},open:false,querySelector:s=>s==='form'?f:warning,querySelectorAll:s=>s==='form'?[f]:[save],showModal(){this.open=true;},setAttribute(){}};c.context.document.activeElement=opener;c.context.document.querySelector('#work-app').querySelector=()=>d;c.context.task={id:66,assignee_id:1,assignment_generation:1,progress_token:'before',lines:[{id:7,task_id:66,revision:2,current_generation:1,canAct:true,unit_of_measure:'cases',logical_code:'A1',product_name:'Cases'}]};c.run('snapshot.tasks=[task];online=false;openTaskDialog(task,"recovery",7)');assert.equal(save.disabled,false);assert.equal(f._workIdentity.actorId,1);assert.match(d.innerHTML,/Actual quantity \(cases\)/);c.run('task.assignment_generation=2;task.progress_token="after";patchTaskDialog()');assert.equal(save.disabled,false);assert.equal(warning.hidden,false);assert.match(warning.textContent,/original draft/);c.run('snapshot.user.id=2;patchTaskDialog()');assert.equal(save.disabled,true);assert.equal(f._workIdentity.actorId,1);d.onclose();assert.equal(opener.focused,true);
});
function recoverySubmitClient(){
 const c=client(),records=new Map();let handler;const values={lineId:'7',revision:'2',assignmentGeneration:'1',cellId:'4',productId:'1',unit:'cases',direction:'pick',manual:'true',quantity:'2',reason:'Moved before reassignment'};
 const elements=Object.entries(values).map(([name,value])=>({name,value,type:['quantity','reason'].includes(name)?'text':'hidden'}));for(const e of elements)elements[e.name]=e;
 const button={disabled:false},feedback={textContent:'',classList:{add(){}}},f={dataset:{workAction:'report',draftKind:'difference'},_workIdentity:{site:'test',dataset:'data',actorId:1},_draftPath:'/tasks/66',elements,isConnected:true,querySelector:s=>s==='.form-feedback'?feedback:button};
 c.context.f=f;c.context.records=records;c.context.capture=(name,fn)=>{if(name==='submit')handler=fn;};c.context.FormData=class{constructor(){return Object.entries(values);}};
 c.run(`root.addEventListener=capture;online=false;snapshot.tasks=[{id:66,assignment_generation:2,lines:[{id:7,revision:3}]}];store=async(name,mode,fn)=>fn({getAll:()=>[...records.values()].filter(r=>r.partition),put:o=>records.set(o.id,o),delete:id=>records.delete(id)});render=()=>{};sync=async()=>{};`);
 c.run(source.slice(source.indexOf('let submitting=false;'),source.indexOf("root.addEventListener('click'")));
 return {...c,records,f,submit:()=>handler({target:{closest:()=>f},preventDefault(){}})};
}
test('late original-instruction recovery queues durably offline without rewriting revision, assignment or actor',async()=>{
 const c=recoverySubmitClient();await c.submit();const entry=[...c.records.values()].find(x=>x.action==='report');assert.ok(entry);assert.equal(entry.input.revision,'2');assert.equal(entry.input.assignmentGeneration,'1');assert.equal(entry.input.actorId,1);assert.equal(entry.input.site,'test');assert.equal(entry.input.dataset,'data');assert.equal(entry.input.quantity,'2');assert.equal(entry.input.manual,true);assert.equal(entry.state,'local');
});
test('changed account/dataset never applies an old recovery draft to new work, while preserving its original draft',async()=>{
 const c=recoverySubmitClient();const originalKey=c.run('draftKey(f)');c.run("snapshot.user.id=2;snapshot.dataset='new-data'");await c.submit();assert.equal([...c.records.values()].some(x=>x.action==='report'),false);assert.equal(c.run('drafts.get(draftKey(f)).quantity.value'),'2');assert.equal(c.run('draftKey(f)'),originalKey);assert.match(c.run('notice'),/original account/);
});
test('Start check is an explicit local dialog action with no network/light request',async()=>{
 const c=client();let click;c.context.capture=(name,fn)=>{if(name==='click')click=fn;};c.context.fetch=()=>{throw new Error('No request expected');};c.run("root.addEventListener=capture;snapshot.tasks=[{id:66,assignee_id:1,attention:1,lines:[]}];let opened=null;openTaskDialog=(t,mode)=>{opened={id:t.id,mode};};");c.run(source.slice(source.indexOf("root.addEventListener('click'"),source.indexOf('let stopCamera=null;')));await click({target:{closest:s=>s==='[data-task-details],[data-task-stop],[data-task-check],[data-record-moved]'?{dataset:{taskCheck:'66'}}:null}});assert.equal(c.run('opened.mode'),'check');assert.equal(c.run('activeWork'),null);
});

test('check reassignment/stop submission keeps a typed observation and never queues a management command',async()=>{
 for(const action of ['assignReview','stop']){
  const c=client();let handler,writes=0;
  c.context.capture=(name,fn)=>{if(name==='submit')handler=fn;};c.context.write=()=>{writes++;};
  c.run("root.addEventListener=capture;saveDraft=async()=>{};store=async()=>{write();return [];};patchTaskDialog=()=>{};");
  const start=source.indexOf('let submitting=false;'),end=source.indexOf("root.addEventListener('click'",start);c.run(source.slice(start,end));
  const observation={elements:{quantity:{value:'2'},note:{value:'Checked with Sam'}}},dialog={dataset:{mode:'check'},querySelectorAll:()=>[observation]},button={disabled:false},feedback={classList:{add(){}},textContent:''},form={dataset:{workAction:action},closest:()=>dialog,querySelector:s=>s==='.form-feedback'?feedback:button};
  await handler({target:{closest:()=>form},preventDefault(){}});assert.equal(writes,0);assert.match(feedback.textContent,/Save your observation first/);assert.equal(observation.elements.note.value,'Checked with Sam');assert.equal(observation.elements.quantity.value,'2');
 }
});
