import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {configureControllerModules} from '../src/services/inventory.js';
import {createLocationPages} from '../src/server/pages/locations.js';
import {setRuntimeContext} from '../src/server/runtime-context.js';

function fixture(t){
 process.chdir(mkdtempSync(join(tmpdir(),'controller-wizard-')));
 const db=createDatabase({hashPassword}),controller=configureControllerModules(db,{controllerCode:'SHELF-A',controllerAddress:'KEEP-A',moduleCount:4});
 const pages=createLocationPages({db}),user=db.prepare("SELECT * FROM users WHERE role='admin'").get();
 setRuntimeContext({firmwareService:{getFlashOptions:()=>({arduinoCli:{available:true},defaultFqbn:'esp32:esp32:esp32',moduleCount:{min:1,max:64},lastConfiguration:{assignedModules:[1,2,3,4]},controllerFlashRecords:[{controllerId:controller.id,replacementReady:true,physicalModuleCount:4}]})}});
 t.after(()=>{setRuntimeContext({firmwareService:null});db.close();});
 return {db,controller,pages,user};
}
test('Add is exclusively new-controller setup with no replacement picker, board field or module chips',t=>{
 const f=fixture(t),html=f.pages.renderDeviceConfigSection('controller-setup');
 assert.match(html,/<h2>Add a new controller<\/h2>/);
 assert.match(html,/name="replacement_controller_id" value=""/);
 assert.doesNotMatch(html,/<select|Board FQBN|Replace \/ update|module-chip|data-firmware-modules|Module 1/);
 assert.match(html,/<input type="hidden" name="fqbn"/);
 assert.match(html,/Other serial devices \/ Manual refresh/);
 assert.match(html,/data-firmware-forward/);assert.match(html,/data-firmware-back/);
});
test('Edit is bound to the clicked controller and preserves its mapping without a target selector',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT * FROM cells ORDER BY id').all();
 const html=f.pages.renderDeviceConfigSection('controller-setup',{controllerId:String(f.controller.id)});
 assert.match(html,/<h2>Edit SHELF-A<\/h2>/);
 assert.match(html,new RegExp(`name="replacement_controller_id" value="${f.controller.id}"`));
 assert.match(html,/name="controller_name"[^>]*value="SHELF-A" readonly/);
 assert.match(html,/name="module_count"[^>]*value="4" readonly/);
 assert.doesNotMatch(html,/<select|data-firmware-modules|Board FQBN/);
 assert.match(html,/data-firmware-controller-backup/);
 assert.deepEqual(f.db.prepare('SELECT * FROM cells ORDER BY id').all(),before);
 assert.throws(()=>f.pages.renderDeviceConfigSection('controller-setup',{controllerId:999999}),/no longer available/);
});
test('controller rows expose Edit only to users with firmware permissions',t=>{
 const f=fixture(t),html=f.pages.renderDevices(f.user,null);
 assert.match(html,new RegExp(`href="#controller-edit-${f.controller.id}" data-controller-edit="${f.controller.id}"`));
 const viewOnly={...f.user,capabilities:['hardware.view','hardware.test']};
 assert.doesNotMatch(f.pages.renderDevices(viewOnly,null),/data-controller-edit=/);
});
