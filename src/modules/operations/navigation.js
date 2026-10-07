import {can} from '../access/catalog.js';
import {escapeHtml as e} from '../../render.js';
export function workNavigation(user,current=''){
 const tabs=[['/work','My Work','work.view'],['/work/overview','Assign Work','work.assign'],['/work/history','History','work.view'],['/work/task-history','Task History','work.view'],['/record-movement','Record Movement','work.report'],['/recommended-actions','Recommended Actions','work.view']];
 return `<nav class="work-views" aria-label="Work views">${tabs.filter(([, ,cap])=>can(user,cap)).map(([href,label])=>`<a href="${href}" ${href===current?'aria-current="page"':''}>${e(label)}</a>`).join('')}</nav>`;
}
export function locationNavigation(user,current='/cells'){
 return `<nav class="work-views" aria-label="Location views">${can(user,'locations.view')?`<a href="/cells" ${current==='/cells'?'aria-current="page"':''}>Locations</a>`:''}${can(user,'locations.labels')?`<a href="/labels" ${current==='/labels'?'aria-current="page"':''}>Location Labels</a>`:''}</nav>`;
}
