import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createSessionCookie} from '../src/services/auth.js';
import {uiDialog,uiDialogButton,uiDisclosure} from '../src/server/ui.js';

test('optional Settings dialogs retain labelled Back/Close controls and escaped identifiers',()=>{
 const html=uiDialog('test','Schedule <backup>','<form></form>');
 assert.match(html,/data-ui-panel-dialog/);assert.match(html,/aria-labelledby="test-title"/);
 assert.match(html,/Schedule &lt;backup&gt;/);assert.equal((html.match(/data-ui-close-dialog/g)||[]).length,2);
 assert.doesNotMatch(uiDialog('restore','Restore','Body',{dismissible:false}),/dialog-dismiss/);
 assert.match(uiDialogButton('test','Open'),/type="button".*data-ui-open-dialog="test"/);
 assert.match(uiDisclosure('Details','Body'),/<details class="ui-panel ui-disclosure"><summary>Details<\/summary>/);
});

test('Settings tables preserve product field submissions, backup safeguards and read-only access',async()=>{
 process.env.NO_SERVER_LISTEN='1';process.env.HARDWARE_ADAPTER='simulator';process.env.DEMO_INVENTORY_SEED='1';
 process.chdir(mkdtempSync(join(tmpdir(),'lyt-settings-pages-')));
 const {requestHandler}=await import('../src/server.js'),{getAppState}=await import('../src/server/app-state.js');
 const state=getAppState(),{db}=state;const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
 const call=async(method,path,form={},user=admin)=>{
  const request=Readable.from(method==='POST'?[Buffer.from(new URLSearchParams(form).toString())]:[]);
  Object.assign(request,{method,url:path,headers:{host:'localhost',cookie:createSessionCookie(user),accept:'text/html','content-type':'application/x-www-form-urlencoded'}});
  const response={statusCode:200,headers:{},body:'',writeHead(code,headers){this.statusCode=code;this.headers=headers;},end(body=''){this.body+=body;}};
  await requestHandler(request,response);return response;
 };
 try {
  const page=await call('GET','/admin/product-fields');assert.equal(page.statusCode,200);
  const fields=db.prepare('SELECT * FROM product_field_definitions').all();
  for(const field of fields){
   const id='product-field-'+field.id;
   assert.ok(page.body.includes('id="'+id+'" method="post" action="/admin/product-fields/'+field.id+'"'));
   for(const name of ['visible','searchable','filterable','reportable','required','active'])assert.ok(page.body.includes('form="'+id+'" type="checkbox" name="'+name+'"'),field.field_key+': '+name);
   assert.ok(page.body.includes('type="submit" form="'+id+'"'));
  }
  assert.match(page.body,/data-ui-open-dialog="add-product-field"/);assert.match(page.body,/name="confirmed" value="1" required|id="unit-migration"/);
  const category=fields.find(f=>f.system_role==='category');
  const save=await call('POST','/admin/product-fields/'+category.id,{label:'Product category',sort_order:'42',visible:'1',searchable:'1',filterable:'1',reportable:'1',active:'1'});
  assert.equal(save.statusCode,302);const saved=db.prepare('SELECT * FROM product_field_definitions WHERE id=?').get(category.id);assert.equal(saved.label,'Product category');assert.equal(saved.sort_order,42);assert.equal(saved.searchable,1);assert.equal(saved.required,0);
  await call('POST','/backups/create');const backups=await call('GET','/backups');
  assert.match(backups.body,/data-ui-open-dialog="backup-schedule"/);assert.match(backups.body,/data-ui-open-dialog="restore-backup-0"/);
  assert.match(backups.body,/name="confirm_restore"[^>]*pattern="RESTORE"[^>]*required/);
  assert.match(backups.body,/data-row-collapser data-row-limit="5"/);assert.doesNotMatch(backups.body,/aria-label="Close Restore database"/);
  assert.match(backups.body,/action="\/backups\/schedule"/);assert.match(backups.body,/action="\/backups\/retention"/);assert.doesNotMatch(backups.body,/>Restore Notes</);
  assert.match((await call('GET','/settings/system')).body,/ui-disclosure.*Recent recovery actions/);
  const {createAccessService}=await import('../src/modules/access/service.js');const access=createAccessService({db});const operator=db.prepare("SELECT * FROM users WHERE role='operator'").get();
  const role=access.saveRole(admin,{name:'Settings reader',capabilities:['hardware.view','backups.view']});const reader=access.assign(admin,{userId:operator.id,roleId:role});
  const readOnly=await call('GET','/backups',{},reader);assert.equal(readOnly.statusCode,200);assert.doesNotMatch(readOnly.body,/action="\/backups\/(create|schedule|restore|retention)"/);
  const hardware=await call('GET','/devices',{},reader);assert.equal(hardware.statusCode,200);assert.match(hardware.body,/Location mappings/);assert.doesNotMatch(hardware.body,/controller-test|controller-delete|controller-ping/);
 } finally {state.hardwareService.dispose?.();db.close();}
});
