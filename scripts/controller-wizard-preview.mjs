// Isolated, synthetic preview. Firmware uploads and backups are deliberately unavailable.
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {createLocationPages} from '../src/server/pages/locations.js';
import {setRuntimeContext} from '../src/server/runtime-context.js';
const repo=dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(mkdtempSync(join(tmpdir(),'controller-wizard-preview-')));
const db=createDatabase({hashPassword});
const controller=configureControllerModules(db,{controllerCode:'SHELF-A',controllerAddress:'BENCH-A',moduleCount:4,configuredBy:1});
const user=db.prepare("SELECT * FROM users WHERE role='admin'").get();
const device={path:'/dev/ttyUSB1',deviceIdentity:'preview-esp32',deviceName:'ESP32',recommended:true,newlyConnected:true};
const bridge={path:'/dev/ttyUSB0',deviceIdentity:'preview-rs485',deviceName:'RS485 adapter',recommended:false};
const options={arduinoCli:{available:true},defaultFqbn:'esp32:esp32:esp32',moduleCount:{min:1,max:64},portStatus:'Ready',lastConfiguration:null,controllerFlashRecords:[{controllerId:controller.id,controllerName:controller.controller_code,moduleCount:4,physicalModuleCount:4,replacementReady:true}]};
setRuntimeContext({firmwareService:{getFlashOptions:()=>options}});
const pages=createLocationPages({db}),source=readFileSync(join(repo,'public/app.js'),'utf8');
const firmware=source.slice(source.indexOf('function firmwareStageLabel('),source.indexOf('const activeCounts = new Map();'));
const workspace=source.slice(source.indexOf('function wireConfigurationWorkspace()'),source.indexOf('function cleanMappingLabel('));
const boot=`function onPage(target,event,handler){target.addEventListener(event,handler);}function wireLedCommandForms(){}function wireCellMappingForm(){}function wireCellDeleteForms(){}function wireRowCollapsers(){}\n${firmware}\n${workspace}\nwireConfigurationWorkspace();`;
let scans=0;
createServer((req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');
  if(req.method!=='GET'){res.writeHead(405);res.end('Synthetic preview cannot upload firmware.');return;}
  if(url.pathname==='/desktop'){
   res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#eef3f0;overflow:hidden"><iframe title="Desktop controller preview at 1280 pixels" src="/devices#controller-edit-${controller.id}" width="1280" height="1080" style="border:0;transform:scale(.31);transform-origin:top left"></iframe></body></html>`);return;
  }
  if(url.pathname==='/devices'){
   scans=0;let html=pages.renderDevices(user,null).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
   html=html.replace('</body>',`<script type="module" src="/client/mobile-nav.js"></script><script type="module" src="/client/mobile-layout.js"></script><script type="module" src="/client/ui-template.js"></script><script type="module">${boot}</script></body>`);res.setHeader('Content-Type','text/html');res.end(html);return;
  }
  if(url.pathname==='/devices/sections/controller-setup'){res.setHeader('Content-Type','text/html');res.end(pages.renderDeviceConfigSection('controller-setup',{controllerId:url.searchParams.get('controller_id')}));return;}
  if(url.pathname==='/api/firmware/options'){scans++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...options,ports:scans===1?[bridge]:[bridge,device],esp32Ports:scans===1?[]:[device]}));return;}
  const root=join(repo,'public'),path=resolve(root,url.pathname.slice(1));
  if(!path.startsWith(root+'/')){res.writeHead(404);res.end();return;}
  const mime=path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':path.endsWith('.svg')?'image/svg+xml':'image/png';
  res.setHeader('Content-Type',mime);res.end(readFileSync(path));
 }catch(error){res.writeHead(500);res.end(error.message);}
}).listen(3224,'127.0.0.1',()=>console.log('Synthetic controller preview http://127.0.0.1:3224/devices'));
