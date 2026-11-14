import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CAPABILITIES, OPERATOR_CAPABILITIES, ADMIN_CAPABILITIES} from '../src/modules/access/catalog.js';
import {permissionGroups,permissionPresentation} from '../src/modules/access/permission-presentation.js';
import {formSignature,requiredPermissions} from '../public/client/roles.js';
import {confirmationMarkup} from '../public/client/ui-template.js';
import {createDatabase} from '../src/db.js';
import {hashPassword} from '../src/services/auth.js';
import {PAGE_MODULES,PERSISTENT_MODULES} from '../public/client/navigation.js';
import {page} from '../src/render.js';
import {accessRoutes} from '../src/modules/access/routes.js';

test('shared head modules remain mounted so role navigation does not fall back to full reloads',()=>{
  const html=page({title:'Fixture',user:{id:1,name:'Admin',role:'admin'},content:''});
  const sources=[...html.matchAll(/<script type="module" src="([^"]+)"/g)].map(match=>match[1]);
  assert.ok(sources.includes('/client/camera-zoom.js'));
  for(const source of sources) assert.ok(PAGE_MODULES.has(source)||PERSISTENT_MODULES.has(source),source);
  assert.ok(PERSISTENT_MODULES.has('/client/camera-zoom.js'));
});

test('job-based permission presentation retains every capability and its original boundaries',()=>{
  const groups=permissionGroups(CAPABILITIES);
  const shown=groups.flatMap(group=>group.permissions);
  assert.equal(new Set(shown.map(permission=>permission.id)).size,CAPABILITIES.length);
  assert.equal(shown.length,CAPABILITIES.length);
  for(const permission of CAPABILITIES) {
    const display=shown.find(item=>item.id===permission.id);
    assert.deepEqual(display.requires,permission.requires);
    assert.equal(display.restricted,permission.restricted);
    assert.equal(display.operator,permission.operator);
    assert.ok(display.label);
  }
  assert.equal(permissionPresentation(CAPABILITIES.find(p=>p.id==='work.execute')).label,'Do my assigned work');
  assert.equal(requiredPermissions(CAPABILITIES,new Set(OPERATOR_CAPABILITIES)).length,0);
  assert.equal(requiredPermissions(CAPABILITIES,new Set(ADMIN_CAPABILITIES)).length,0);
  assert.ok(shown.filter(permission=>permission.primary).length<shown.length);
});

test('role and assignment draft comparison detects changed values and clears when restored',()=>{
  const baseline=[['name','Operator copy'],['cap_work.view','on'],['cap_work.pick','on']];
  assert.equal(formSignature(baseline),formSignature([...baseline].reverse()));
  assert.notEqual(formSignature(baseline),formSignature([['name','New name'],...baseline.slice(1)]));
  assert.notEqual(formSignature(baseline),formSignature(baseline.slice(0,2)));
  assert.equal(formSignature([['userId','7'],['roleId','operator']]),formSignature([['roleId','operator'],['userId','7']]));
  assert.notEqual(formSignature([['userId','7'],['roleId','operator']]),formSignature([['userId','7'],['roleId','admin']]));
});

test('leaving unsaved edits offers Stay/Leave while action confirmations still require their checkbox',()=>{
  const leave=confirmationMarkup({title:'Unsaved changes',message:'Leave without saving?',label:'Leave page',cancelLabel:'Stay here',requireCheck:false});
  assert.match(leave,/Stay here/);
  assert.match(leave,/Leave page/);
  assert.doesNotMatch(leave,/data-ui-confirmed|data-ui-accept disabled/);
  const action=confirmationMarkup({title:'Disable key',label:'Disable key'});
  assert.match(action,/data-ui-confirmed/);
  assert.match(action,/data-ui-accept disabled/);
});

test('role page orders its cards and keeps less common permissions editable inside More permissions',async()=>{
  process.chdir(mkdtempSync(join(tmpdir(),'lyt-role-ui-')));
  const db=createDatabase({hashPassword});
  const user=db.prepare("SELECT * FROM users WHERE role='admin'").get();
  const response={body:'',writeHead(code){this.status=code;},end(body){this.body=body;}};
  await accessRoutes({method:'GET'},response,new URL('http://warehouse/settings/roles?copy=operator'),user,{db});
  assert.equal(response.status,200);
  const roles=response.body.indexOf('<h2>Roles</h2>');
  const assign=response.body.indexOf('<h2>Assign a role</h2>');
  const create=response.body.indexOf('<h2>Create a role from Operator</h2>');
  assert.ok(roles>=0&&roles<assign&&assign<create);
  assert.match(response.body,/More permissions/);
  assert.match(response.body,/data-role-assignment/);
  const boot=JSON.parse(response.body.match(/<script id="role-catalog" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(boot.catalog.map(permission=>permission.id),CAPABILITIES.map(permission=>permission.id));
  const checked=[...response.body.matchAll(/data-capability="([^"]+)" checked/g)].map(match=>match[1]);
  assert.deepEqual(checked.sort(),[...OPERATOR_CAPABILITIES].sort());
  assert.equal([...response.body.matchAll(/data-capability="/g)].length,CAPABILITIES.length);
  db.close();
});
