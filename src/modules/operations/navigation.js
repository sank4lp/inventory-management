import {can} from '../access/catalog.js';
import {escapeHtml as e} from '../../render.js';
export function locationNavigation(user,current='/cells'){
 return `<nav class="work-views" aria-label="Location views">${can(user,'locations.view')?`<a href="/cells" ${current==='/cells'?'aria-current="page"':''}>Locations</a>`:''}${can(user,'locations.labels')?`<a href="/labels" ${current==='/labels'?'aria-current="page"':''}>Location Labels</a>`:''}</nav>`;
}
