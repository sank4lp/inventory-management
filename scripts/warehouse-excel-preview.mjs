// Disposable Excel-import preview. Every record and LED response is synthetic.
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {saveControllerProfile} from '../src/services/controller-profiles.js';
import {createOperationsService} from '../src/modules/operations/service.js';
import {createLocationSetupService} from '../src/modules/locations/service.js';
import {locationSetupRoutes} from '../src/modules/locations/routes.js';
import {createDisplayCoordinator} from '../src/services/display-coordinator.js';
import {createHardwareService} from '../src/services/hardware.js';
import {createStocktakingService} from '../src/modules/stocktaking/service.js';
import {stocktakingRoutes} from '../src/modules/stocktaking/routes.js';
import {createBackupService} from '../src/services/backups.js';
import {createWarehouseExcelService} from '../src/modules/excel/service.js';
import {warehouseExcelRoutes} from '../src/modules/excel/routes.js';
import {warehouseExcelBuffer} from '../src/services/warehouse-excel.js';
import {effectiveUser} from '../src/modules/access/service.js';
const repo=dirname(dirname(fileURLToPath(import.meta.url))),root=mkdtempSync(join(tmpdir(),'excel-preview-'));
process.chdir(root);
const db=createDatabase({hashPassword,allowDemoInventorySeed:false}),user=effectiveUser(db,db.prepare("SELECT * FROM users WHERE role='admin'").get());
const c=configureControllerModules(db,{controllerCode:'CTRL1',controllerAddress:'QA-ONLY',moduleCount:4,configuredBy:user.id}),controller=db.prepare('SELECT * FROM controllers WHERE id=?').get(c.id);
saveControllerProfile(db,controller,{physicalCount:4,logicalCount:4,routing:Array.from({length:64},(_,i)=>i<4?i+1:0),revision:1});
db.prepare("UPDATE controllers SET heartbeat_status='online' WHERE id=?").run(c.id);
const operationsService=createOperationsService({db}),hardwareService=createHardwareService({db,config:{hardwareAdapter:'simulator'},logger:{info(){},warn(){}}}),displayCoordinator=createDisplayCoordinator({db,hardwareService,operationsService}),locationSetupService=createLocationSetupService({db,operationsService,displayCoordinator}),stocktakingService=createStocktakingService({db,operationsService});
const backupService=createBackupService({getDb:()=>db,reloadAppState(){}}),warehouseExcelService=createWarehouseExcelService({db,locationSetupService,stocktakingService,backupService});
const state={db,operationsService,displayCoordinator,locationSetupService,stocktakingService,backupService,warehouseExcelService};
const map=locationSetupService.snapshot(user).ledControllers.find(v=>v.id===c.id);
const cellId=locationSetupService.command(user,'saveLedMappings',{requestId:crypto.randomUUID(),controllerId:c.id,revision:map.revision,rows:[{physical:1,name:'Z1-R1-C01'}]}).cellIds[0];
db.prepare('DELETE FROM inventory_balances').run();
db.prepare('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(1,?,8,0)').run(cellId);
const product=db.prepare('SELECT * FROM products WHERE id=1').get();
const file=join(root,'Excel-review-test.xlsx');
writeFileSync(file,warehouseExcelBuffer({mappingRows:[['A','CTRL1',1],['B','CTRL1',2]],stockRows:[[product.sku,product.name,'A',5,product.unit_of_measure,product.items_per_cell,product.brand],['NEW-EXCEL','Test new product','B',6,'pieces',10,'Test']]}));
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');req.parsedForm={};
    if(url.pathname==='/phone'){
      res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:0;background:#e9efeb"><iframe title="Phone import" src="/warehouse-excel" width="390" height="844" style="border:0"></iframe></body></html>');return;
    }
    if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;req.parsedForm=JSON.parse(body);}
    if(url.pathname==='/api/session'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({userId:user.id,remainingMs:3600000}));return;}
    if(url.pathname==='/api/displays/stop'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(displayCoordinator.stop(user,req.parsedForm.displayId)));return;}
    if(warehouseExcelRoutes(req,res,url,user,state)||await locationSetupRoutes(req,res,url,user,state)||await stocktakingRoutes(req,res,url,user,state))return;
    const publicRoot=join(repo,'public'),path=resolve(publicRoot,url.pathname.slice(1));if(!path.startsWith(publicRoot+'/'))throw new Error('Not found');
    res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':path.endsWith('.svg')?'image/svg+xml':'image/png');res.end(readFileSync(path));
  }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
}).listen(3226,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:3226/warehouse-excel',file,root})));
