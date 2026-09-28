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
