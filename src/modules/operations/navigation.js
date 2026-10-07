import {can,workTabs,currentWorkTab} from '../access/catalog.js';
import {escapeHtml as e} from '../../render.js';
export function workNavigation(user,current=''){
 return `<nav class="work-views" aria-label="Work views">${workTabs(user).map(({href,label})=>`<a href="${href}" ${href===currentWorkTab(current)?'aria-current="page"':''}>${e(label)}</a>`).join('')}</nav>`;
}
export function locationNavigation(user,current='/cells'){
 return `<nav class="work-views" aria-label="Location views">${can(user,'locations.view')?`<a href="/cells" ${current==='/cells'?'aria-current="page"':''}>Locations</a>`:''}${can(user,'locations.labels')?`<a href="/labels" ${current==='/labels'?'aria-current="page"':''}>Location Labels</a>`:''}</nav>`;
}
