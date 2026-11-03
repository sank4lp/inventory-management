import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {createHardwareService} from '../src/services/hardware.js';
import {connectExistingController} from '../src/services/existing-controllers.js';
import {loadControllerProfile} from '../src/services/controller-profiles.js';
import {groupChecksum} from '../src/services/hardware-adapters/group-protocol.js';
import {routeAllowed} from '../src/modules/access/routes-policy.js';

function fixture({version=15,badChecksum=false,wrongAddress=false}={}){
  const root=mkdtempSync(join(tmpdir(),'existing-controller-')),cwd=process.cwd();process.chdir(root);
  const db=createDatabase({hashPassword,allowDevAuthSeeds:false,allowWarehouseSeeds:false,allowCatalogSeeds:false,allowDemoInventorySeed:false}),admin=db.prepare('SELECT * FROM users').get();
  const routing=Array.from({length:64},(_,i)=>version===13?(i<3?i+1:0):i===0?1:i===2?2:i===3?3:0),map=routing.map(v=>v.toString(16).padStart(2,'0')).join('');let pending='';const writes=[];
  const hardware=createHardwareService({db,logger:{info(){},warn(){},error(){},debug(){}},config:{hardwareAdapter:'rs485',rs485InterCommandDelayMs:0,rs485WriteRepeatDelayMs:0,rs485WriteLine:line=>{
    writes.push(line.trim());const tokens=line.trim().split(' ');
    if(tokens[2]==='ping')pending=JSON.stringify({type:'pong',address:wrongAddress?'OTHER':'KEEP',controller:'EXISTING',protocol:`simple-matrix-v${version}-rs485-addressed`,modules:version===13?3:4,configFault:false})+'\n';
    if(tokens[2]==='config-status'){
      const request=tokens[3],payload=`KEEP config-status ${request} 00000007 3 ${map} 0`;
      pending=JSON.stringify({type:'controller-config',address:'KEEP',request,revision:7,physicalModules:3,logicalModules:4,routing:map,fault:false,checksum:badChecksum?'00000000':groupChecksum(payload)})+'\n';
    }
  },rs485ReadWindow:()=>{const result=pending;pending='';return result;}}});
  return {db,admin,hardware,writes,routing,connect:()=>connectExistingController({db,hardwareService:hardware},{controller_name:'EXISTING',controller_address:'KEEP'},admin),end(){hardware.dispose();db.close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});}};
}
for(const version of [13,15])test(`existing v${version} firmware is registered with read-only commands and its saved routing`,()=>{
  const f=fixture({version});try{
    const controller=f.connect();assert.equal(controller.address,'KEEP');assert.deepEqual(loadControllerProfile(f.db,controller).routing,f.routing);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inventory_balances').get().n,0);
    assert.ok(f.writes.length);assert.ok(f.writes.every(line=>/^to KEEP (?:ping|config-status [a-f0-9]{16})$/.test(line)),f.writes.join('\n'));
    if(version===15)assert.equal(f.db.prepare('SELECT 1 FROM cells WHERE controller_id=? AND hardware_channel=2').get(controller.id),undefined);
    const n=f.writes.length;assert.throws(()=>f.connect(),/already registered/);assert.equal(f.writes.length,n);
  }finally{f.end();}
});
for(const option of [{badChecksum:true},{wrongAddress:true},{version:99}])test(`unverified existing controller ${JSON.stringify(option)} stays unregistered and unflashed`,()=>{
  const f=fixture(option);try{assert.throws(()=>f.connect());assert.equal(f.db.prepare('SELECT COUNT(*) n FROM controllers').get().n,0);assert.ok(f.writes.every(line=>!/(configure|flash|erase|upload)/.test(line)));}finally{f.end();}
});
test('connecting controllers requires controller permission, independently of firmware-flash permission',()=>{
  const user={capabilities:['hardware.view','hardware.controllers']};
  assert.equal(routeAllowed(user,'GET','/devices/sections/controller-connect'),true);
  assert.equal(routeAllowed(user,'POST','/devices/controller-connect'),true);
  assert.equal(routeAllowed(user,'POST','/api/firmware/flash'),false);
  assert.equal(routeAllowed({capabilities:['hardware.view']},'POST','/devices/controller-connect'),false);
});
