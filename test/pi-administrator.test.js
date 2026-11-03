import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase} from '../src/db.js';
import {hashPassword,verifyPassword,createSessionCookie,getSessionUser} from '../src/services/auth.js';
import {administratorPassword,updateAdministrator} from '../scripts/release/administrator.mjs';

function fixture(t){
 const cwd=process.cwd(),root=mkdtempSync(join(tmpdir(),'lytguide-administrator-'));process.chdir(root);
 const db=createDatabase({hashPassword,bootstrapAdmin:{name:'Warehouse owner',username:'owner',password:'original-password'},allowDevAuthSeeds:false,allowDemoInventorySeed:false});
 db.prepare("INSERT INTO users(name,username,password_hash,role,status,created_at) VALUES(?,?,?,'operator','active',?)").run('Other operator','operator2',hashPassword('operator-password'),new Date().toISOString());
 const admin=db.prepare("SELECT * FROM users WHERE username='owner'").get();
 t.after(()=>{db.close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});});return {db,admin,root};
}
test('administrator passwords accept 1234 and other short nonempty values',()=>{
 for(const value of ['1234','1','a','a'.repeat(200)])assert.equal(administratorPassword(value),value);
 for(const value of ['',undefined,null,1234,'a'.repeat(201)])assert.throws(()=>administratorPassword(value),/administrator password/);
});
test('renaming the administrator and setting 1234 preserves account identity, roles, task history and other users',t=>{
 const {db,admin}=fixture(t),before=db.prepare('SELECT * FROM users WHERE id!=? ORDER BY id').all(admin.id);
 db.prepare("INSERT INTO tasks(type,status,summary,created_by,started_at,last_touched_at) VALUES('pick','planned','Existing assignment',?,'2026-11-01','2026-11-01')").run(admin.id);
 const tasks=db.prepare('SELECT * FROM tasks').all(),cookie=createSessionCookie(admin).split(';')[0];
 assert.ok(getSessionUser({headers:{cookie}},db));
 updateAdministrator(db,{userId:admin.id,username:'newowner',password:'1234'});
 const updated=db.prepare('SELECT * FROM users WHERE id=?').get(admin.id);
 assert.equal(updated.username,'newowner');assert.equal(updated.name,admin.name);assert.equal(updated.role_id,admin.role_id);assert.equal(updated.role,admin.role);
 assert.ok(verifyPassword('1234',updated.password_hash));assert.ok(!verifyPassword('original-password',updated.password_hash));assert.equal(updated.session_version,admin.session_version+1);
 assert.equal(getSessionUser({headers:{cookie}},db),null);assert.ok(getSessionUser({headers:{cookie:createSessionCookie(updated).split(';')[0]}},db));
 assert.deepEqual(db.prepare('SELECT * FROM tasks').all(),tasks);assert.deepEqual(db.prepare('SELECT * FROM users WHERE id!=? ORDER BY id').all(admin.id),before);
 const audit=JSON.parse(db.prepare("SELECT payload FROM system_events WHERE event_type='administrator_credentials_changed'").get().payload);
 assert.deepEqual(audit,{userId:admin.id,previousUsername:'owner',username:'newowner',passwordChanged:true});
});
test('blank password keeps the existing password, unchanged details are a no-op, and conflicting usernames cannot change credentials',t=>{
 const {db,admin}=fixture(t);
 assert.equal(updateAdministrator(db,{userId:admin.id,username:'owner',password:''}).changed,false);
 assert.equal(db.prepare('SELECT session_version FROM users WHERE id=?').get(admin.id).session_version,admin.session_version);
 updateAdministrator(db,{userId:admin.id,username:'renamed',password:''});
 assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.id).password_hash,admin.password_hash);
 const before=db.prepare('SELECT * FROM users WHERE id=?').get(admin.id),other=db.prepare('SELECT * FROM users WHERE id!=? LIMIT 1').get(admin.id);
 assert.throws(()=>updateAdministrator(db,{userId:admin.id,username:other.username.toUpperCase(),password:'1234'}),/already in use/);
 assert.throws(()=>updateAdministrator(db,{userId:other.id,username:'not-admin',password:'1234'}),/no longer available/);
 assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(admin.id),before);
});
test('fresh warehouse bootstrap accepts 1234 without demo stock or extra users',()=>{
 const cwd=process.cwd(),root=mkdtempSync(join(tmpdir(),'lytguide-short-password-'));
 const entry=new URL('../scripts/release/bootstrap.mjs',import.meta.url);
 try{
  const result=spawnSync(process.execPath,[fileURLToPath(entry)],{cwd:root,input:JSON.stringify({action:'initialise',username:'newowner',password:'1234',blankWarehouse:true}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const db=new DatabaseSync(join(root,'data/inventory.db'));
  try{const user=db.prepare('SELECT * FROM users').get();assert.equal(user.username,'newowner');assert.ok(verifyPassword('1234',user.password_hash));assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n,0);}finally{db.close();}
 }finally{process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
});
test('packaged credential bootstrap waits for a short-lived database writer instead of failing immediately',async t=>{
 const {db,admin,root}=fixture(t);
 const holder=spawn(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('data/inventory.db');db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');setTimeout(()=>{db.exec('COMMIT');db.close();},500);`],{cwd:root,stdio:['ignore','pipe','pipe']});
 t.after(()=>holder.kill());await once(holder.stdout,'data');
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/release/bootstrap.mjs',import.meta.url))],{cwd:root,input:JSON.stringify({action:'administrator',userId:admin.id,username:'changedowner',password:'1234'}),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(db.prepare('SELECT username FROM users WHERE id=?').get(admin.id).username,'changedowner');assert.ok(verifyPassword('1234',db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.id).password_hash));
});
