import {escapeHtml as e} from '../../render.js';
import {templatePage, uiPanel, uiTable, uiStatus} from '../../server/ui.js';
import {createAccessService, currentActor} from './service.js';
import {CAPABILITIES, SETTINGS} from './catalog.js';
import {permissionPresentation, permissionGroups} from './permission-presentation.js';
import {sendHtml, sendRedirect, appendFlash, getFlash} from '../../server/http/responses.js';

export async function accessRoutes(request, response, url, user, {db}) {
  if (!url.pathname.startsWith('/settings/roles')) return false;
  const service = createAccessService({db});
  currentActor(db, user, 'access.manage');
  if (request.method === 'POST') {
    const form = request.parsedForm;
    if (url.pathname.endsWith('/assign')) {
      service.assign(user, {userId:form.userId, roleId:form.roleId});
      sendRedirect(response, appendFlash('/settings/roles', 'Role assigned. Earlier work retains its original attribution.', 'success'));
    } else {
      const id = service.saveRole(user, {
        id:form.id||null, revision:form.revision, name:form.name,
        capabilities:CAPABILITIES.filter(c=>form['cap_'+c.id]==='on').map(c=>c.id),
      });
      sendRedirect(response, appendFlash('/settings/roles?edit='+id, 'Role saved. Existing sessions use the new permissions on their next request.', 'success'));
    }
    return true;
  }
  if (request.method !== 'GET') return false;
  const roles = service.roles(user);
  const selected = roles.find(role=>role.id===url.searchParams.get('edit'));
  const source = roles.find(role=>role.id===(url.searchParams.get('copy')||(!selected&&!url.searchParams.has('blank')?'operator':'')));
  const editing = selected&&!selected.builtin;
  const template = selected||source;
  const permissions = template?.capabilities||[];
  const people = db.prepare('SELECT id,name,username,role_id,status FROM users ORDER BY name').all();
  const roleList = uiTable([
    {key:'role',label:'Role'}, {key:'users',label:'People'}, {key:'permissions',label:'Permissions'}, {key:'action',label:'Action'},
  ], roles.map(role=>[
    `${e(role.name)}${role.builtin?'<small>Default</small>':''}`, String(role.users), String(role.capabilities.length),
    `<div class="ui-actions"><a class="ui-button ui-button-secondary" href="/settings/roles?copy=${e(role.id)}">Copy this role</a>${!role.builtin?`<a class="ui-button ui-button-secondary" href="/settings/roles?edit=${e(role.id)}">Edit permissions</a>`:''}</div>`,
  ]), {label:'Roles'});
  const permissionRow = capability => `<label class="role-capability"><input type="checkbox" name="cap_${capability.id}" value="on" data-capability="${capability.id}" ${permissions.includes(capability.id)?'checked':''}><span>${e(capability.label)}${capability.description?`<small>${e(capability.description)}</small>`:''}</span></label>`;
  const groups = permissionGroups(CAPABILITIES);
  const editor = `<form method="post" action="/settings/roles" data-role-editor class="ui-form ui-role-editor">
    <input type="hidden" name="id" value="${editing?e(selected.id):''}">
    <input type="hidden" name="revision" value="${editing?selected.revision:''}">
    <label>Role name<input name="name" required maxlength="70" value="${editing?e(selected.name):source?e(source.name+' copy'):''}"></label>
    <p class="muted">Choose what this person can do.</p>
    <div class="ui-permissions">${groups.map(group=>{
      const common=group.permissions.filter(capability=>capability.primary);
      const more=group.permissions.filter(capability=>!capability.primary);
      return `<details data-permission-group="${e(group.id)}"${group.id==='Work'?' open':''}><summary><span>${e(group.label)}</span><small data-permission-count>${group.permissions.filter(capability=>permissions.includes(capability.id)).length} allowed</small></summary>
        <div class="role-permission-list">${common.map(permissionRow).join('')}</div>
        ${more.length?`<details class="role-more-permissions"><summary><span>More permissions</span><small data-more-permission-count>${more.filter(capability=>permissions.includes(capability.id)).length} allowed</small></summary><div class="role-permission-list">${more.map(permissionRow).join('')}</div></details>`:''}
      </details>`;
    }).join('')}</div>
    <section class="role-access-preview" aria-live="polite"><h3>Access preview</h3><p data-role-preview></p><p data-role-prerequisites hidden></p><button type="button" class="secondary" data-include-required hidden>Add required permissions</button></section>
    <details class="ui-help"><summary>Help</summary><p>Start with Operator for everyday work, or Admin for full access. More permissions keeps the less common actions available. Changes to an existing role apply to everyone using it.</p><p>${editing?selected.users:0} people currently use this role. Seeing someone’s work does not allow doing their tasks.</p></details>
    <div class="ui-actions"><button data-save-role>Save role</button></div>
  </form>`;
  const assignments = uiTable([
    {key:'person',label:'Name'}, {key:'status',label:'Status'}, {key:'action',label:'Role'},
  ], people.map(person=>[
    `<a href="/admin/users/${person.id}">${e(person.name)}</a><small>${e(person.username)}</small>`, uiStatus(person.status),
    `<form method="post" action="/settings/roles/assign" class="ui-role-assignment" data-role-assignment><input type="hidden" name="userId" value="${person.id}"><label class="sr-only" for="role-${person.id}">Role for ${e(person.name)}</label><select id="role-${person.id}" name="roleId" data-searchable>${roles.map(role=>`<option value="${e(role.id)}" ${role.id===person.role_id?'selected':''}>${e(role.name)}</option>`).join('')}</select><button>Assign role</button></form>`,
  ]), {label:'Assign a role'});
  const history = service.audit(user).map(event=>`<article><strong>${e(event.actor_name||'System')} · ${e(event.event_type.replaceAll('_',' '))}</strong><p>${e(event.created_at)} · ${e(event.target)}</p><details><summary>Changed permissions and people</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${e(JSON.stringify(JSON.parse(event.payload),null,2))}</pre></details></article>`).join('')||'<p>No access changes yet.</p>';
  const content = `<div class="ui-toolbar"><a href="/settings">← Settings</a><a href="/settings/people">People &amp; access</a></div>
    ${uiPanel('Roles', roleList)}
    ${uiPanel('Assign a role', assignments)}
    ${uiPanel(editing?'Edit '+template.name:'Create a role'+(source?' from '+source.name:''), editor, {actions:'<div class="ui-actions"><a class="ui-button ui-button-secondary" href="/settings/roles?blank=1">Start with no permissions</a><a class="ui-button ui-button-secondary" href="/settings/roles?copy=operator">Copy Operator</a><a class="ui-button ui-button-secondary" href="/settings/roles?copy=admin">Copy Admin</a></div>'})}
    <details class="ui-panel ui-help"><summary>Access change history</summary>${history}</details>
    <script id="role-catalog" type="application/json">${JSON.stringify({catalog:CAPABILITIES.map(permissionPresentation),settings:SETTINGS}).replaceAll('<','\\u003c')}</script><script type="module" src="/client/roles.js"></script>`;
  sendHtml(response, templatePage({title:'Roles and Permissions', currentPath:'/settings/roles', user, flash:getFlash(url), content}));
  return true;
}
