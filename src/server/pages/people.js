import {can} from '../../modules/access/catalog.js';
import {effectiveUser} from '../../modules/access/service.js';
import {listUsers, listRegistrationKeys} from '../../services/inventory.js';
import {escapeHtml as e, copyIcon, suspendIcon} from './shared.js';
import {uiPanel, uiTable, uiStatus, formatUiDate, uiConfirmation} from '../ui.js';

function userActions(viewer, person, roleName) {
  if (Number(viewer.id) === Number(person.id)) return '<span class="muted">Signed in</span>';
  if (!can(viewer, 'people.manage')) return '—';
  const active = person.status === 'active';
  const label = active ? 'Suspend' : 'Restore';
  const question = `${label} access for ${person.username}?`;
  return `<form method="post" action="/admin/users/status" ${uiConfirmation({title:label+' user',label,message:question,danger:active,facts:[['Name',person.name],['Username',person.username],['Role',roleName],['Status',active?'Active':'Suspended']]})}>
    <input type="hidden" name="user_id" value="${person.id}">
    <input type="hidden" name="status" value="${active ? 'inactive' : 'active'}">
    <button class="${active ? 'danger-button' : ''}">${label}</button></form>`;
}

function keyActions(key, roleName) {
  if (key.status !== 'active') return '—';
  const question = 'Disable this registration key? New users cannot use it. Existing users keep their access.';
  return `<div class="ui-actions">
    <button type="button" class="icon-button ghost-button" data-copy-value="${e(key.key_value)}" aria-label="Copy registration key ${e(key.key_value)}" title="Copy key">${copyIcon()}</button>
    <form method="post" action="/admin/registration-keys/revoke" ${uiConfirmation({title:'Disable key',label:'Disable key',message:question,danger:true,facts:[['Key',key.key_value],['Role',roleName],['Use',key.usage_policy==='global'?'Multiple users':'Single user'],['Registered',String(key.usage_count||0)]]})}>
      <input type="hidden" name="key_id" value="${key.id}">
      <button class="danger-button" aria-label="Disable registration key ${e(key.key_value)}">${suspendIcon()}Disable</button>
    </form></div>`;
}

export function renderPeopleAccess({db, user}) {
  const users = listUsers(db);
  const manage = can(user, 'access.manage');
  const roleLink = manage ? '<a class="ui-button ui-button-secondary" href="/settings/roles">Roles &amp; permissions</a>' : '';
  const usersTable = uiTable([
    {key:'person', label:'Name'}, {key:'role', label:'Role'}, {key:'status', label:'Status'},
    {key:'action', label:'Action'}, {key:'issued', label:'Key issued (IST)'},
    {key:'joined', label:'Joined (IST)'}, {key:'active', label:'Last active (IST)'},
  ], users.map(person => [
    `<a href="/admin/users/${person.id}"><strong>${e(person.name)}</strong></a><small>${e(person.username)}</small>`,
    e(effectiveUser(db,person).role_name), uiStatus(person.status), userActions(user,person,effectiveUser(db,person).role_name),
    `${e(formatUiDate(person.key_issued_at))}${person.key_issued_at ? `<small>${person.key_usage_policy === 'global' ? 'Multiple users' : 'Single user'}</small>` : ''}`,
    e(formatUiDate(person.created_at)), e(formatUiDate(person.last_active_at)),
  ]), {label:'Users'});
  const people = uiPanel('Users', usersTable, {id:'users', actions:roleLink});
  if (!manage) return people;

  const roles = db.prepare('SELECT id,name FROM access_roles ORDER BY builtin DESC,name').all();
  const invitation = uiPanel('Invite users', `<form method="post" action="/admin/registration-keys" class="ui-form">
    <div class="ui-invitation-fields">
      <label>Role<select name="role" required data-searchable data-placeholder="Choose a role">${roles.map(role => `<option value="${e(role.id)}"${role.id==='operator'?' selected':''}>${e(role.name)}</option>`).join('')}</select></label>
      <label>Custom key (optional)<input name="key_value" placeholder="Generated if left blank" maxlength="120" autocomplete="off"></label>
      <button type="submit">Generate key</button>
    </div>
    <div class="ui-form-footer"><label class="ui-check"><input type="checkbox" name="usage_policy" value="global">Registers multiple users</label></div>
    <details class="ui-help"><summary>Help</summary><p>Choose the role new users will receive. A single-user key works once and expires after 90 days. A multiple-user key works until you disable it. Disabling a key does not remove accounts already registered.</p></details>
  </form>`);
  const keys = listRegistrationKeys(db);
  const issued = uiPanel('Registration Keys', `<div class="copy-status" data-copy-status role="status" aria-live="polite"></div>${uiTable([
    {key:'key',label:'Key'}, {key:'role',label:'Role'}, {key:'type',label:'Use'},
    {key:'usage',label:'Registered'}, {key:'status',label:'Status'}, {key:'action',label:'Action'},
    {key:'issued',label:'Issued (IST)'}, {key:'by',label:'Issued by'}, {key:'date',label:'Expires (IST)'},
  ], keys.map(key => [
    `<code>${e(key.key_value)}</code>`,
    e(roles.find(role=>role.id===(key.role_id||key.role))?.name||key.role),
    key.usage_policy==='global'?'Multiple users':'Single user', e(String(key.usage_count||0)),
    uiStatus(key.status==='active'&&key.expires_at&&Date.parse(key.expires_at)<=Date.now()?'expired':key.status),
    key.expires_at&&Date.parse(key.expires_at)<=Date.now()?'—':keyActions(key,roles.find(role=>role.id===(key.role_id||key.role))?.name||key.role),
    e(formatUiDate(key.created_at)), e(key.created_by_username||'—'),
    key.expires_at?e(formatUiDate(key.expires_at)):'Until disabled',
  ]), {label:'Registration keys'})}`, {id:'registration-keys'});
  return `${people}${invitation}${issued}`;
}
