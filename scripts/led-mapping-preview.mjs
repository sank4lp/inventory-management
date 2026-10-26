// Disposable mapping preview: isolated temporary data and simulated hardware only.
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {saveControllerProfile} from '../src/services/controller-profiles.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createLocationSetupService} from '../src/modules/locations/service.js';
import {operationsRoutes} from '../src/modules/operations/routes.js';
import {locationSetupRoutes} from '../src/modules/locations/routes.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {createHardwareService} from '../src/services/hardware.js';
const repo=dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(mkdtempSync(join(tmpdir(),'led-mapping-preview-')));
const db=createDatabase({hashPassword,allowDemoInventorySeed:false}),user=db.prepare("SELECT * FROM users WHERE role='admin'").get();
const c=configureControllerModules(db,{controllerCode:'Shelf-A',controllerAddress:'TEST-A',moduleCount:20,configuredBy:user.id}),controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(c.id);
saveControllerProfile(db,controller,{physicalCount:20,logicalCount:20,routing:Array.from({length:64},(_,i)=>i<20?i+1:0),revision:1});
db.prepare("UPDATE controllers SET heartbeat_status='online' WHERE id=?").run(c.id);
const operationsService=createOperationsService({db}),hardwareService=createHardwareService({db,config:{hardwareAdapter:'simulator'},logger:{info(){},warn(){}}}),displayCoordinator=createDisplayCoordinator({db,hardwareService,operationsService}),locationSetupService=createLocationSetupService({db,operationsService,displayCoordinator});
const state={db,operationsService,displayCoordinator,locationSetupService};
const cmd=(action,input)=>locationSetupService.command(user,action,{requestId:crypto.randomUUID(),...input});
const revision=locationSetupService.snapshot(user).ledControllers.find(v=>v.id===c.id).revision;
cmd('saveLedMappings',{controllerId:c.id,revision,rows:[{physical:1,name:'Shelf A · Cell 01'},{physical:2,name:'Shelf A · Cell 02'}]});
const cell=locationSetupService.snapshot(user).cells.find(c=>c.display_name==='Shelf A · Cell 01');
db.prepare('INSERT OR REPLACE INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(1,?,7,0)').run(cell.id);
if(process.argv.includes('--blocking-work')){
 const command=(action,input)=>operationsService.command(user,action,{requestId:crypto.randomUUID(),...input});
 const task=command('create',{direction:'pick',productId:1,quantity:2}),line=operationsService.task(user,task.taskId).lines[0];
 command('acquire',{lineId:line.id,revision:line.revision,location:line.logical_code,deviceId:'preview'});
 command('create',{direction:'pick',productId:1,quantity:1});
 command('manual',{productId:1,cellId:cell.id,direction:'pick',quantity:1,unit:'pairs',reason:'Disposable preview entry; no physical movement',performerId:'unknown'});
}
createServer(async(req,res)=>{
 try{const url=new URL(req.url,'http://localhost');
  req.parsedForm={};if(req.method==='POST'){let body='';for await(const part of req)body+=part;req.parsedForm=JSON.parse(body);}
  if(url.pathname==='/api/displays/stop'){const result=displayCoordinator.stop(user,req.parsedForm.displayId);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
  if(url.pathname.startsWith('/api/work/')&&await operationsRoutes(req,res,url,user,state))return;
  if(await locationSetupRoutes(req,res,url,user,state))return;
  if(url.pathname==='/responsive'){res.setHeader('Content-Type','text/html');res.end(`<html><body style="margin:0;background:#e9efeb;display:flex;gap:20px;padding:16px;font:16px system-ui"><section style="width:700px"><h2>Desktop</h2><iframe title="Desktop mapping" src="/locations/manage?view=leds&controller=${c.id}" width="1280" height="1350" style="transform:scale(.54);transform-origin:top left;border:0"></iframe></section><section style="width:410px"><h2>Phone</h2><iframe title="Phone mapping" src="/locations/manage?view=leds&controller=${c.id}" width="410" height="740" style="border:0"></iframe></section></body></html>`);return;}
  if(url.pathname==='/desktop'){res.setHeader('Content-Type','text/html');res.end(`<iframe title="Desktop preview" src="/locations/manage?view=leds&controller=${c.id}" width="1280" height="1200" style="transform:scale(.31);transform-origin:top left;border:0"></iframe>`);return;}
  const root=join(repo,'public'),path=resolve(root,url.pathname.slice(1));if(!path.startsWith(root+'/')){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':path.endsWith('.svg')?'image/svg+xml':'image/png');res.end(readFileSync(path));
 }catch(error){res.writeHead(error.statusCode||400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message,code:error.code,scope:error.scope}));}
}).listen(3225,'127.0.0.1',()=>console.log(`Synthetic LED mapping http://127.0.0.1:3225/locations/manage?view=leds&controller=${c.id}`));
