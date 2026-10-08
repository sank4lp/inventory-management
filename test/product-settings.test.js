import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createSessionCookie} from '../src/services/auth.js';
import {createAccessService} from '../src/modules/access/service.js';
import {OPERATOR_CAPABILITIES} from '../src/modules/access/catalog.js';

test('combined product settings require confirmation, save atomically and respect separate edit/capacity permissions',async()=>{
 process.env.NO_SERVER_LISTEN='1';process.env.HARDWARE_ADAPTER='simulator';process.env.DEMO_INVENTORY_SEED='1';
 process.chdir(mkdtempSync(join(tmpdir(),'lightguide-product-settings-')));
 const {requestHandler}=await import('../src/server.js'),{getAppState}=await import('../src/server/app-state.js');
 const state=getAppState(),{db}=state;
 const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get(),op=db.prepare("SELECT * FROM users WHERE role='operator'").get();
 const p=state.catalogService.createProduct({actor:admin,sku:'SETTINGS-TEST',name:'Original',brand:'Original Brand',unit_of_measure:'pieces',items_per_cell:6});
 const current=()=>db.prepare('SELECT * FROM products WHERE id=?').get(p.id);
 const call=async(user,body)=>{
  const request=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(request,{method:'POST',url:`/products/${p.id}/settings`,headers:{host:'localhost',cookie:createSessionCookie(user),'content-type':'application/json',accept:'application/json'}});
  const response={statusCode:200,headers:{},body:'',writeHead(status,headers){this.statusCode=status;this.headers=headers;},end(value=''){this.body+=value;}};
  await requestHandler(request,response);return {...response,value:JSON.parse(response.body)};
 };
 const input={edit_details:'1',name:'Updated',brand:'Updated Brand',unit_of_measure:'pieces',description:'New description',category:'Uniforms',variant:'Large',items_per_cell:8};
 try{
  assert.equal((await call(admin,input)).statusCode,400);assert.equal(current().name,'Original');
  assert.equal((await call(admin,{...input,confirmed:'1',items_per_cell:0})).statusCode,400);assert.equal(current().name,'Original','invalid capacity rolls back details');assert.equal(current().items_per_cell,6);
  assert.equal((await call(admin,{...input,confirmed:'1',unit_of_measure:'boxes'})).statusCode,400);assert.equal(current().unit_of_measure,'pieces','unit changes still require migration');
  assert.equal((await call(op,{...input,confirmed:'1'})).statusCode,400);assert.equal(current().name,'Original');
  const saved=await call(admin,{...input,confirmed:'1'});assert.equal(saved.statusCode,200);assert.match(saved.value.redirectUrl,new RegExp(`/products/${p.id}`));assert.equal(current().name,'Updated');assert.equal(current().items_per_cell,8);assert.equal(current().category,'Uniforms');assert.equal(current().description,'New description');
  const access=createAccessService({db});const capacityRole=access.saveRole(admin,{name:'Capacity editor',capabilities:[...OPERATOR_CAPABILITIES,'products.capacity']});access.assign(admin,{userId:op.id,roleId:capacityRole});
  assert.equal((await call(op,{confirmed:'1',items_per_cell:10})).statusCode,200);assert.equal(current().items_per_cell,10);
  assert.equal((await call(op,{...input,confirmed:'1'})).statusCode,400);assert.equal(current().name,'Updated');assert.equal(current().items_per_cell,10);
  const detailsRole=access.saveRole(admin,{name:'Details editor',capabilities:[...OPERATOR_CAPABILITIES,'products.edit']});access.assign(admin,{userId:op.id,roleId:detailsRole});
  assert.equal((await call(op,{...input,confirmed:'1',name:'Should roll back'})).statusCode,400);assert.equal(current().name,'Updated','missing capacity permission rolls back already validated details');
  const details={...input,confirmed:'1',name:'Details only'};delete details.items_per_cell;
  assert.equal((await call(op,details)).statusCode,200);assert.equal(current().name,'Details only');assert.equal(current().items_per_cell,10);
 }finally{state.hardwareService.dispose?.();db.close();}
});
