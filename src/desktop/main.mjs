import * as electron from 'electron';
import {execFile} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {desktopTarget,originMatches,allowedRequest,externalLink,mediaAllowed,windowPreferences,launchMode} from './policy.mjs';

const CONFIG_ROOT='/etc/lytguide-test',STATE_ROOT='/var/lib/lytguide-test';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function authorize(resume){return new Promise((resolve,reject)=>execFile('pkexec',['/usr/lib/lytguide-test/setup-authorize',...(resume?['--resume']:[])],{encoding:'utf8',timeout:300000,maxBuffer:8192},(error,stdout,stderr)=>error?reject(new Error(String(stderr||'Setup authorisation was cancelled.').trim())):resolve(stdout.trim())));}
export function createDesktop({runtime=electron,readWorkUrl=()=>readFileSync(join(CONFIG_ROOT,'desktop-url'),'utf8').trim(),isPending=()=>!existsSync(join(CONFIG_ROOT,'config.json'))||existsSync(join(STATE_ROOT,'setup-pending')),authorizeSetup=authorize,request=fetch,ask,askSync,assetRoot,wait=delay}={}){
  const {app,BrowserWindow,Menu,dialog,shell,session}=runtime;
  const assets=assetRoot||join(dirname(app.getAppPath()),'lytguide-assets');
  const message=ask||((window,options)=>window?dialog.showMessageBox(window,options):dialog.showMessageBox(options));
  let workWindow=null,setupWindow=null,startingSetup=false,workStarting=null;
  const windows=new Set(),configuredSessions=new Set();
  function focus(window){if(window.isMinimized())window.restore();window.show();window.focus();}
  function makeWindow({partition,origin,title,parent}={}){
    const win=new BrowserWindow({width:1280,height:900,minWidth:360,minHeight:480,show:false,title,icon:join(assets,'icon.png'),backgroundColor:'#f4f7f5',autoHideMenuBar:true,...(parent?{parent}:{}),webPreferences:windowPreferences(partition)});
    windows.add(win);win.maximize();win.show();
    win.on('closed',()=>{windows.delete(win);if(workWindow===win)workWindow=null;if(setupWindow===win)setupWindow=null;});
    const ses=win.webContents.session;
    if(!configuredSessions.has(ses)){
      configuredSessions.add(ses);const approved=new Set();
      ses.setPermissionCheckHandler((contents,permission,requestingOrigin,details={})=>originMatches(requestingOrigin,origin)&&(permission==='clipboard-sanitized-write'||permission==='media'&&details.mediaType==='video'&&approved.has(origin)));
      ses.setPermissionRequestHandler(async(contents,permission,callback,details)=>{
        if(permission==='clipboard-sanitized-write'&&originMatches(details.requestingUrl||contents?.getURL()||'',origin)){callback(true);return;}
        if(!mediaAllowed(origin,details.requestingUrl||contents?.getURL()||'',permission,details)){callback(false);return;}
        if(approved.has(origin)){callback(true);return;}
        try{const result=await message(BrowserWindow.fromWebContents(contents),{type:'question',title:'Camera access',message:'Allow LytGuide to use the camera?',detail:'The camera is used to scan location QR codes.',buttons:['Allow camera','Cancel'],defaultId:0,cancelId:1});if(result.response===0)approved.add(origin);callback(result.response===0);}catch{callback(false);}
      });
      ses.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
        const localAsset=details.url.startsWith('file:')&&details.url===new URL('file://'+join(assets,'loading.html')).href;
        callback({cancel:!localAsset&&!allowedRequest(details.url,origin)});
      });
    }
    async function outside(url){const safe=externalLink(url);if(!safe)return;const result=await message(win,{type:'question',title:'Open link',message:'Open this link in your browser?',detail:safe,buttons:['Open link','Cancel'],defaultId:1,cancelId:1});if(result.response===0)await shell.openExternal(safe);}
    function navigate(event,url){
      if(originMatches(url,origin))return;
      event.preventDefault();
      let work;try{work=desktopTarget(readWorkUrl());}catch{}
      if(origin==='http://localhost:3311'&&work&&originMatches(url,work.origin)&&new URL(url).pathname==='/work'){
        if(isPending()){void message(win,{type:'info',title:'Finish Setup',message:'Finish Setup before opening the shed.'});return;}
        void openWork().then(()=>{if(!win.isDestroyed())win.close();});return;
      }
      void outside(url);
    }
    win.webContents.on('will-navigate',navigate);win.webContents.on('will-redirect',navigate);
    win.webContents.on('will-frame-navigate',event=>{if(!event.isMainFrame&&!originMatches(event.url,origin)&&event.url!=='about:blank')event.preventDefault();});
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.setWindowOpenHandler(({url})=>{
      if(!originMatches(url,origin)){void outside(url);return {action:'deny'};}
      // Reports, printing and existing task links retain their separate windows.
      const child=makeWindow({partition,origin,title:'LytGuide',parent:win});void child.loadURL(url);return {action:'deny'};
    });
    win.webContents.on('will-prevent-unload',event=>{const choice=askSync?askSync(win):dialog.showMessageBoxSync(win,{type:'question',title:'Unsaved changes',message:'Leave without saving?',detail:'Unsaved changes will be discarded. Recorded shed work stays saved.',buttons:['Stay','Leave'],defaultId:0,cancelId:0});if(choice===1)event.preventDefault();});
    win.webContents.on('render-process-gone',async()=>{if(win.isDestroyed())return;const choice=await message(win,{type:'error',title:'LytGuide',message:'This window stopped responding.',detail:'Your recorded shed work stays saved.',buttons:['Reload','Close'],cancelId:1});if(win.isDestroyed())return;if(choice.response===0)win.webContents.reload();else win.close();});
    return win;
  }
  async function showSetup({resume=false}={}){
    if(startingSetup){if(setupWindow)focus(setupWindow);return;}
    startingSetup=true;let win;
    try{
      const target=desktopTarget(await authorizeSetup(resume),{setup:true});
      const partition='setup-'+randomUUID(),ses=session.fromPartition(partition);
      const response=await request(target.origin+'/setup-api/unlock',{method:'POST',headers:{Origin:target.origin,'Content-Type':'application/json'},body:JSON.stringify({token:target.hash.slice(1)}),signal:AbortSignal.timeout(10000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Setup could not be opened.');
      const cookie=response.headers.get('set-cookie')?.match(/(?:^|;\s*)lytguide_setup=([a-f0-9]{64})/);
      if(!cookie)throw new Error('Setup did not return its authorisation. Reopen Shed Setup.');
      await ses.cookies.set({url:target.origin,name:'lytguide_setup',value:cookie[1],httpOnly:true,sameSite:'strict',path:'/',expirationDate:Date.now()/1000+1800});
      win=makeWindow({partition,origin:target.origin,title:'LytGuide Shed Setup'});const previous=setupWindow;setupWindow=win;
      await win.loadURL(target.origin+'/');if(previous&&!previous.isDestroyed())previous.close();
    }catch(error){if(win&&!win.isDestroyed())win.close();await message(setupWindow||workWindow,{type:'error',title:'Shed Setup',message:'Setup could not open.',detail:error.message});if(!windows.size)app.quit();}
    finally{startingSetup=false;}
  }
  async function openWork(){
    if(workStarting)return workStarting;
    workStarting=(async()=>{
      if(isPending()){await showSetup({resume:true});return;}
      if(workWindow&&!workWindow.isDestroyed()){if(new URL(workWindow.webContents.getURL()).pathname==='/setup-not-ready')await workWindow.loadURL(desktopTarget(readWorkUrl()).href);focus(workWindow);return;}
      let target;try{target=desktopTarget(readWorkUrl());}catch{await showSetup({resume:true});return;}
      const win=makeWindow({partition:'persist:warehouse',origin:target.origin,title:'LytGuide'});workWindow=win;
      await win.loadFile(join(assets,'loading.html'));
      while(!win.isDestroyed()){
        let ready=false;
        for(let attempt=0;attempt<20&&!win.isDestroyed();attempt++){
          try{const result=await request(target.origin+'/login',{signal:AbortSignal.timeout(2000)});await result.body?.cancel();if(result.ok){ready=true;break;}}catch{}
          await wait(500);
        }
        if(win.isDestroyed())return;
        if(ready){try{await win.loadURL(target.href);return;}catch{}}
        const result=await message(win,{type:'warning',title:'LytGuide',message:'The shed service is not responding.',detail:'Try again, or open Shed Setup to check this Pi.',buttons:['Try again','Shed Setup','Close'],defaultId:0,cancelId:2});
        if(result.response===1){await showSetup({resume:true});win.close();return;}if(result.response===2){win.close();return;}
      }
    })();try{await workStarting;}finally{workStarting=null;}
  }
  function menu(){Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{label:'LytGuide',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]}]:[]),
    {label:'File',submenu:[{label:'Shed Setup…',click:()=>void showSetup()},{type:'separator'},{role:'close'},...(process.platform==='darwin'?[]:[{role:'quit'}])]},
    {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'View',submenu:[{label:'Back',accelerator:'Alt+Left',click:()=>{const history=BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;if(history?.canGoBack())history.goBack();}},{label:'Forward',accelerator:'Alt+Right',click:()=>{const history=BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;if(history?.canGoForward())history.goForward();}},{type:'separator'},{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
    {label:'Window',submenu:[{role:'minimize'},{role:'zoom'}]},
  ]));}
  return {openWork,showSetup,menu,windows};
}
export async function startDesktop(options={}){
  const {app}=options.runtime||electron;
  if(process.getuid?.()===0)throw new Error('Open LytGuide as the Pi desktop user, without sudo.');
  if(process.platform==='linux')app.setDesktopName('com.lytguide.Warehouse.desktop');
  app.setName('LytGuide');app.setPath('userData',join(app.getPath('appData'),'LytGuide'));app.enableSandbox();
  const mode=launchMode(process.argv);
  if(!app.requestSingleInstanceLock({mode})){app.quit();return;}
  const controller=createDesktop(options);
  const launch=mode=>mode==='work'?controller.openWork():controller.showSetup({resume:mode==='resume'});
  app.on('second-instance',async(event,argv,cwd,data)=>{await app.whenReady();await launch(data?.mode||launchMode(argv));});
  app.on('window-all-closed',()=>app.quit());
  await app.whenReady();controller.menu();await launch(mode);return controller;
}
if(require.main===module)startDesktop().catch(error=>{electron.dialog.showErrorBox('LytGuide',error.message);electron.app.quit();});
