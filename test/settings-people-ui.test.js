import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createDatabase} from '../src/db.js';
import {hashPassword, createSessionCookie, getSessionUser} from '../src/services/auth.js';
import {issueRegistrationKey, registerUser, listUsers, getUserProfile} from '../src/services/inventory.js';
import {createAdminService} from '../src/services/admin.js';
import {createAccessService, migrateAccess, effectiveUser} from '../src/modules/access/service.js';
import {OPERATOR_CAPABILITIES} from '../src/modules/access/catalog.js';
import {createAdminPages} from '../src/server/pages/admin.js';
import {createProfilePages} from '../src/server/pages/profile.js';
import {confirmationMarkup} from '../public/client/ui-template.js';

test('shared Settings confirmations escape account data and require explicit acceptance', () => {
  const markup=confirmationMarkup({title:'Disable <key>',label:'Disable',message:'Confirm this change?',facts:[['Name','<script>unsafe()</script>']],danger:true});
  assert.match(markup,/class="review-task-header"/);
  assert.match(markup,/data-ui-back/);
  assert.match(markup,/data-ui-confirmed/);
  assert.match(markup,/data-ui-accept disabled/);
  assert.match(markup,/&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup,/<script>|dialog-dismiss/);
});

function fixture() {
  process.chdir(mkdtempSync(join(tmpdir(), 'lyt-settings-people-')));
  const db = createDatabase({hashPassword});
  const admin = db.prepare("SELECT * FROM users WHERE role='admin'").get();
  const operator = db.prepare("SELECT * FROM users WHERE role='operator'").get();
  const access = createAccessService({db});
  const roleId = access.saveRole(admin, {name:'Floor technician', capabilities:[...OPERATOR_CAPABILITIES,'hardware.view']});
  const register = (key, username) => registerUser(db, {registrationKey:key.key_value, name:username, username, password:'test-password-only', hashPassword});
  return {db, admin, operator, roleId, access, register};
}

test('single and multiple-user invitations retain the issuing time for each account and respect disabling', () => {
  const f = fixture();
  const shared = issueRegistrationKey(f.db, {role:f.roleId, usagePolicy:'global', userId:f.admin.id});
  const issued = '2026-01-02T09:00:00.000Z';
  f.db.prepare('UPDATE registration_keys SET created_at=? WHERE id=?').run(issued, shared.id);
  const first = f.register(shared, 'First technician');
  const second = f.register(shared, 'Second technician');
  for (const person of [first, second]) {
    const row = listUsers(f.db).find(entry=>entry.id===person.id);
    assert.equal(row.registration_key_id, shared.id);
    assert.equal(row.key_issued_at, issued);
    assert.equal(row.key_usage_policy, 'global');
    assert.equal(row.role_id, f.roleId);
    assert.equal(getUserProfile(f.db,person.id).invited_by_name, f.admin.name);
  }
  assert.notEqual(first.id, second.id);
  assert.equal(f.db.prepare('SELECT usage_count FROM registration_keys WHERE id=?').get(shared.id).usage_count, 2);
  const cookie = createSessionCookie(first);
  createAdminService({db:f.db}).revokeRegistrationKey({actor:f.admin, keyId:shared.id});
  assert.throws(()=>f.register(shared, 'Late technician'), /not active/);
  assert.equal(getSessionUser({headers:{cookie}},f.db).id, first.id);
  assert.equal(listUsers(f.db).find(person=>person.id===first.id).key_issued_at, issued);

  const single = issueRegistrationKey(f.db, {role:f.roleId,userId:f.admin.id});
  assert.equal(single.usage_policy, 'single_use');
  const individual = f.register(single, 'Single technician');
  assert.equal(getUserProfile(f.db, individual.id).registration_key_id, single.id);
  assert.throws(()=>f.register(single,'Another single technician'),/not active/);
  // Multiple-user use follows the selected role, including Admin; it is not
  // silently downgraded to Operator or changed to single use.
  const adminKey = issueRegistrationKey(f.db,{role:'admin',usagePolicy:'global',userId:f.admin.id});
  assert.equal(adminKey.usage_policy,'global');
  assert.equal(effectiveUser(f.db,f.register(adminKey,'Additional admin')).role_id,'admin');
  f.db.close();
});

test('existing invitation audit backfills all shared-key users without guessing unknown accounts', () => {
  const f=fixture();
  const key=issueRegistrationKey(f.db,{role:f.roleId,usagePolicy:'global',userId:f.admin.id});
  const first=f.register(key,'Legacy first'),second=f.register(key,'Legacy second');
  f.db.exec('UPDATE users SET registration_key_id=NULL');
  migrateAccess(f.db);
  migrateAccess(f.db);
  assert.equal(getUserProfile(f.db,first.id).registration_key_id,key.id);
  assert.equal(getUserProfile(f.db,second.id).registration_key_id,key.id);
  assert.equal(getUserProfile(f.db,f.admin.id).registration_key_id,null);
  // Older single-user keys can be recovered from used_by if no access audit exists.
  const single=issueRegistrationKey(f.db,{role:'operator',userId:f.admin.id});
  const legacy=f.register(single,'Before audit');
  f.db.prepare('DELETE FROM access_events WHERE event_type=\'onboarded\' AND target=?').run(String(legacy.id));
  f.db.prepare('UPDATE users SET registration_key_id=NULL WHERE id=?').run(legacy.id);
  migrateAccess(f.db);
  assert.equal(getUserProfile(f.db,legacy.id).registration_key_id,single.id);
  f.db.close();
});

test('people readers see account metadata without registration secrets or access management controls', () => {
  const f=fixture();
  const key=issueRegistrationKey(f.db,{keyValue:'PRIVATE-INVITATION',role:f.roleId,userId:f.admin.id});
  f.register(key,'Invited colleague');
  const role=f.access.saveRole(f.admin,{name:'People reader',capabilities:['people.view']});
  const reader=f.access.assign(f.admin,{userId:f.operator.id,roleId:role});
  const html=createAdminPages({db:f.db}).renderAdmin(reader,null,'people');
  assert.match(html,/Key issued \(IST\)|Last active \(IST\)|Joined \(IST\)/);
  assert.doesNotMatch(html,/PRIVATE-INVITATION|Generate key|action="\/admin\/users\/status"|action="\/admin\/registration-keys/);
  assert.throws(()=>issueRegistrationKey(f.db,{role:'admin',usagePolicy:'global',userId:reader.id}),/not permitted/);
  assert.throws(()=>createAdminService({db:f.db}).revokeRegistrationKey({actor:reader,keyId:key.id}),/not permitted/);
  const before=f.db.prepare('SELECT COUNT(*) n FROM access_events').get().n;
  assert.throws(()=>createAdminService({db:f.db}).revokeRegistrationKey({actor:f.admin,keyId:999999}),/not found/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM access_events').get().n,before);
  const profile=createProfilePages({db:f.db}).renderProfile(reader,null);
  assert.match(profile,/class="ui-facts"|Key issued|Invited by/);
  assert.doesNotMatch(profile,/PRIVATE-INVITATION/);
  f.db.close();
});

test('Settings routes share the opt-in template; main tabs remain unchanged and activity includes newer routes',async()=>{
  process.env.NO_SERVER_LISTEN='1';
  process.env.HARDWARE_ADAPTER='simulator';
  process.env.DEMO_INVENTORY_SEED='1';
  process.chdir(mkdtempSync(join(tmpdir(),'lyt-settings-http-')));
  const {requestHandler}=await import('../src/server.js');
  const {getAppState}=await import('../src/server/app-state.js');
  const {db}=getAppState();
  const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
  const operator=db.prepare("SELECT * FROM users WHERE role='operator'").get();
  async function call(method,path,user=admin,form={}) {
    const request=Readable.from(method==='POST'?[Buffer.from(new URLSearchParams(form).toString())]:[]);
    Object.assign(request,{method,url:path,headers:{host:'localhost',cookie:createSessionCookie(user),accept:'text/html','content-type':'application/x-www-form-urlencoded'}});
    const response={statusCode:200,headers:{},body:'',writeHead(code,headers){this.statusCode=code;this.headers=headers;},end(body=''){this.body+=body;}};
    await requestHandler(request,response);
    return response;
  }
  for(const path of ['/settings','/settings/people','/settings/roles','/settings/system','/devices','/location-setup','/locations/manage','/admin/product-fields','/backups','/work/timing','/profile','/admin/users/'+operator.id]) {
    const response=await call('GET',path);
    assert.equal(response.statusCode,200,path);
    assert.match(response.body,/class="ui-template"/,path);
    assert.match(response.body,/href="\/ui-template.css"/,path);
  }
  for(const path of ['/work','/products','/cells','/stocktaking','/reports']) {
    const response=await call('GET',path);
    assert.equal(response.statusCode,200,path);
    assert.doesNotMatch(response.body,/class="ui-template"|href="\/ui-template.css"/,path);
  }
  const denied=await call('GET','/settings/people',operator);
  assert.equal(denied.statusCode,302);
  const issued=await call('POST','/admin/registration-keys',admin,{role:'operator',usage_policy:'global',key_value:'HTTP-TEAM-INVITE'});
  assert.equal(issued.statusCode,302);
  assert.match(issued.headers.Location,/^\/settings\/people\?.*#registration-keys$/);
  assert.equal(db.prepare('SELECT usage_policy FROM registration_keys WHERE key_value=?').get('HTTP-TEAM-INVITE').usage_policy,'global');
  const duplicate=await call('POST','/admin/registration-keys',admin,{role:'operator',key_value:'HTTP-TEAM-INVITE'});
  assert.equal(duplicate.statusCode,302);
  assert.match(duplicate.headers.Location,/^\/settings\/people\?/);
  const stale='2000-01-01T00:00:00.000Z';
  db.prepare('UPDATE users SET last_active_at=? WHERE id=?').run(stale,admin.id);
  await call('GET','/api/work/snapshot');
  assert.equal(db.prepare('SELECT last_active_at FROM users WHERE id=?').get(admin.id).last_active_at,stale);
  await call('GET','/settings/people');
  assert.ok(db.prepare('SELECT last_active_at FROM users WHERE id=?').get(admin.id).last_active_at>stale);
  db.prepare('UPDATE users SET last_active_at=? WHERE id=?').run(stale,operator.id);
  await call('GET','/work',operator);
  assert.ok(db.prepare('SELECT last_active_at FROM users WHERE id=?').get(operator.id).last_active_at>stale);
});
