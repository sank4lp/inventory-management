import {randomUUID} from 'node:crypto';
import {ADMIN_CAPABILITIES,OPERATOR_CAPABILITIES,can,assertCan,fullAdministrator,validateCapabilities} from './catalog.js';
import {withTransaction} from '../../db.js';
export function migrateAccess(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS access_roles(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,capabilities_json TEXT NOT NULL,builtin INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS access_events(id INTEGER PRIMARY KEY,actor_id INTEGER,event_type TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  for(const table of ['users','registration_keys'])if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='role_id'))db.exec(`ALTER TABLE ${table} ADD COLUMN role_id TEXT REFERENCES access_roles(id)`);
  for(const [id,name,caps] of [['admin','Admin',ADMIN_CAPABILITIES],['operator','Operator',OPERATOR_CAPABILITIES]])db.prepare('INSERT OR IGNORE INTO access_roles(id,name,capabilities_json,builtin) VALUES(?,?,?,1)').run(id,name,JSON.stringify(caps));
  for(const table of ['users','registration_keys']) {
    db.exec(`UPDATE ${table} SET role_id=role WHERE role_id IS NULL;
      CREATE TRIGGER IF NOT EXISTS ${table}_default_role AFTER INSERT ON ${table} WHEN NEW.role_id IS NULL BEGIN UPDATE ${table} SET role_id=NEW.role WHERE id=NEW.id; END;`);
  }
}
export function effectiveUser(db,user) {
  if(!user)return null;
  const roleId=user.role_id||db.prepare('SELECT role_id FROM users WHERE id=?').get(user.id)?.role_id||user.role;
  const role=db.prepare('SELECT * FROM access_roles WHERE id=?').get(roleId);
  return {...user,role_id:roleId,role_name:role?.name||'Unavailable role',capabilities:role?JSON.parse(role.capabilities_json):[],role_revision:role?.revision||0};
}
export function currentActor(db,actor,capability) {
  const row=db.prepare('SELECT id,name,username,role,role_id,status,session_version,created_at,last_active_at FROM users WHERE id=?').get(Number(actor?.id));
  if(!row||row.status!=='active'||actor?.session_version!=null&&row.session_version!==actor.session_version){const e=new Error('Your session is no longer active. Sign in again; pending reports remain available for review.');e.statusCode=403;throw e;}
  const current=effectiveUser(db,row);if(capability)assertCan(current,capability);return current;
}
export function auditAccess(db,actor,type,target,payload) {db.prepare('INSERT INTO access_events(actor_id,event_type,target,payload,created_at) VALUES(?,?,?,?,?)').run(actor?.id||null,type,String(target),JSON.stringify(payload),new Date().toISOString());}
export function protectLastAdmin(db,target,nextRoleId,nextStatus=target.status) {
  const users=db.prepare("SELECT * FROM users WHERE status='active'").all();
  if(!users.some(u=>fullAdministrator(effectiveUser(db,u.id===target.id?{...u,role_id:nextRoleId,status:nextStatus}:u))))throw new Error('At least one active full administrator is required.');
}
export function createAccessService({db}) {
  const admin=actor=>{const a=currentActor(db,actor,'access.manage');if(!fullAdministrator(a))throw new Error('A full administrator is required.');return a;};
  return {
    roles(actor){currentActor(db,actor,'people.view');return db.prepare('SELECT * FROM access_roles ORDER BY builtin DESC,name').all().map(r=>({...r,capabilities:JSON.parse(r.capabilities_json),users:db.prepare('SELECT COUNT(*) n FROM users WHERE role_id=?').get(r.id).n}));},
    saveRole(actor,input){return withTransaction(db,()=>{const a=admin(actor),caps=validateCapabilities(input.capabilities||[]),name=String(input.name||'').trim();if(!name||name.length>70)throw new Error('Use a role name between 1 and 70 characters.');const old=input.id?db.prepare('SELECT * FROM access_roles WHERE id=?').get(input.id):null;if(input.id&&!old)throw new Error('Role not found.');if(old?.builtin)throw new Error('Copy a default role to customize it. Default roles remain available.');if(old&&old.revision!==Number(input.revision))throw new Error('This role changed. Refresh before saving.');const id=old?.id||randomUUID();
      const users=db.prepare("SELECT * FROM users WHERE role_id=?").all(id);
      db.prepare('INSERT INTO access_roles(id,name,capabilities_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,capabilities_json=excluded.capabilities_json,revision=revision+1').run(id,name,JSON.stringify(caps));
      if(users.some(u=>u.status==='active'))protectLastAdmin(db,users[0],id);
      auditAccess(db,a,'role_saved',id,{before:old,after:{name,capabilities:caps},affectedUsers:users.map(u=>u.id)});return id;});},
    assign(actor,{userId,roleId}){return withTransaction(db,()=>{const a=admin(actor),target=db.prepare('SELECT * FROM users WHERE id=?').get(Number(userId));if(!target||!db.prepare('SELECT 1 FROM access_roles WHERE id=?').get(roleId))throw new Error('Choose an existing person and role.');protectLastAdmin(db,target,roleId);db.prepare('UPDATE users SET role_id=? WHERE id=?').run(roleId,target.id);auditAccess(db,a,'role_assigned',target.id,{before:target.role_id,after:roleId});return effectiveUser(db,{...target,role_id:roleId});});},
    audit(actor){admin(actor);return db.prepare('SELECT e.*,u.name actor_name FROM access_events e LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.id DESC LIMIT 200').all();},
  };
}
