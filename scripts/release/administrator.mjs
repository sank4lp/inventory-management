import {withTransaction} from '../../src/db.js';
import {hashPassword} from '../../src/services/auth.js';
import {administratorPassword} from './account-password.mjs';
export {administratorPassword} from './account-password.mjs';

// Local, OS-authorized setup changes credentials on the existing account.
// Keeping its ID preserves task ownership, permissions and historical references.
export function updateAdministrator(db,{userId,username,password}={}){
  if(!Number.isSafeInteger(Number(userId))||Number(userId)<1||!/^[A-Za-z0-9._-]{1,80}$/.test(username||''))throw new Error('Choose the existing administrator and enter a valid username.');
  if(password!==undefined&&password!=='')administratorPassword(password);
  return withTransaction(db,()=>{
    const user=db.prepare("SELECT * FROM users WHERE id=? AND role='admin' AND status='active'").get(Number(userId));
    if(!user)throw new Error('This administrator is no longer available. Reopen Setup and try again.');
    if(db.prepare('SELECT 1 FROM users WHERE id!=? AND username=? COLLATE NOCASE').get(user.id,username))throw new Error('That username is already in use. Choose a different username.');
    const passwordChanged=typeof password==='string'&&password.length>0,changed=user.username!==username||passwordChanged;
    if(!changed)return {userId:user.id,username,changed:false};
    db.prepare('UPDATE users SET username=?,password_hash=?,session_version=session_version+1 WHERE id=?').run(username,passwordChanged?hashPassword(password):user.password_hash,user.id);
    db.prepare('INSERT INTO system_events(event_type,status,message,payload,created_at) VALUES(?,?,?,?,?)').run('administrator_credentials_changed','info','Administrator sign-in updated during local shed setup.',JSON.stringify({userId:user.id,previousUsername:user.username,username,passwordChanged}),new Date().toISOString());
    return {userId:user.id,username,changed:true};
  });
}
