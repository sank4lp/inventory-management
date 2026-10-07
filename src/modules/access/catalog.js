// Shared authorization vocabulary. Role names are labels, never privilege checks.
const groups = {
  Work: [
    ['work.view','View own and previously assigned work',true],
    ['work.team','View team work and workloads',false,['work.view']],
    ['work.pick','Create Pick work',true,['work.view']],
    ['work.put','Create Put work',true,['work.view']],
    ['work.execute','Execute own assignments, start, decline and hand back',true,['work.view']],
    ['work.stop','Confirm actual totals and close own task',true,['work.view']],
    ['work.correct','Report corrections to own records',true,['work.view']],
    ['work.report','Record completed physical movement',true,['work.view']],
    ['work.assign','Assign and reassign team work',false,['work.view']],
    ['work.deadline','Change task deadlines',false,['work.team']],
    ['work.teamStop','Stop team work with existing evidence safeguards',false,['work.team']],
    ['work.timing','Change work timing rules',false,['work.team']],
  ],
  Review: [
    ['review.view','See pending movement cases',false,['work.view']],
    ['review.resolve','Resolve verified movement',false,['review.view']],
    ['review.stop','Resolve and stop uncertain work',false,['review.resolve']],
    ['review.link','Link already recorded movements',false,['review.view']],
    ['review.reconcile','Clear verified discrepancies',false,['review.view']],
  ],
  Stocktaking: [
    ['count.view','View own and assigned counts',true],
    ['count.team','View team counts and differences',false,['count.view']],
    ['count.perform','Perform assigned counts',true,['count.view']],
    ['count.create','Create a count for yourself',true,['count.perform']],
    ['count.manage','Create, assign and manage team count runs',false,['count.team']],
    ['count.schedule','Change the count schedule',false,['count.team']],
    ['count.recount','Request a recount',false,['count.team']],
    ['count.approve','Approve corrections and link existing movements',false,['count.team']],
    ['count.condition','Resolve controlled condition review',false,['count.team']],
  ],
  Products: [
    ['products.view','View products and quantities',true],
    ['products.add','Add products and enter custom product values',true,['products.view']],
    ['products.edit','Edit product details',false,['products.view']],
    ['products.capacity','Change product capacity',false,['products.view']],
    ['products.remove','Remove eligible products',false,['products.view']],
    ['products.fields','Configure product fields and units',false,['products.view']],
  ],
  Locations: [
    ['locations.view','View locations and contents',true],
    ['locations.locate','Locate with lights',true,['locations.view']],
    ['locations.quantity','Display stock quantities',true,['locations.view','products.view']],
    ['locations.labels','View and print location labels',true,['locations.view']],
    ['locations.manage','Create and edit locations',false,['locations.view']],
    ['locations.fields','Configure location fields',false,['locations.manage']],
    ['locations.bind','Commission outputs and replace QR labels',false,['locations.manage','hardware.map']],
    ['locations.mode','Change shared or exclusive guidance',false,['locations.manage']],
  ],
  Reports: [
    ['reports.view','View and print warehouse report library',true],
    ['reports.format','Change shared report appearance',false,['reports.view']],
  ],
  Hardware: [
    ['hardware.view','View hardware configuration and health',false],
    ['hardware.test','Test controller lights and refresh health',false,['hardware.view']],
    ['hardware.map','Change hardware mappings',false,['hardware.view']],
    ['hardware.controllers','Add or remove controllers',false,['hardware.view']],
    ['hardware.flash','Compile and flash controller firmware',false,['hardware.controllers']],
  ],
  Administration: [
    ['people.view','View people and their activity',false],
    ['people.manage','Suspend and restore users',false,['people.view']],
    ['access.manage','Manage roles, assign access and issue invitations (full administrators only)',false,[],true],
    ['system.view','View system and recovery diagnostics',false],
    ['system.configure','Configure system preferences',false,['system.view']],
  ],
  Backups: [
    ['backups.view','View backup status and list',false],
    ['backups.create','Create a backup',false,['backups.view']],
    ['backups.restore','Restore a database',false,['backups.view']],
    ['backups.configure','Change backup schedule and retention',false,['backups.view']],
  ],
};
export const CAPABILITIES = Object.entries(groups).flatMap(([group,items])=>items.map(([id,label,operator,requires=[],restricted=false])=>({id,label,group,operator,requires,restricted})));
export const ADMIN_CAPABILITIES = CAPABILITIES.map(c=>c.id);
export const OPERATOR_CAPABILITIES = CAPABILITIES.filter(c=>c.operator).map(c=>c.id);
export function can(user, capability) { return !!user && (user.status===undefined||user.status==='active') && (user.capabilities || (user.role==='admin'?ADMIN_CAPABILITIES:user.role==='operator'?OPERATOR_CAPABILITIES:[])).includes(capability); }
export function fullAdministrator(user) { return ADMIN_CAPABILITIES.every(c=>can(user,c)); }
export function assertCan(user, capability) { if(!can(user,capability)){const error=new Error('This action is not permitted. Admin or an authorized role is required: '+(CAPABILITIES.find(c=>c.id===capability)?.label||capability)+'. Saved physical evidence remains available.');error.statusCode=403;throw error;}return user; }
export function validateCapabilities(values) {
  const selected=[...new Set(values)].sort();
  for(const id of selected){const c=CAPABILITIES.find(c=>c.id===id);if(!c)throw new Error('Unknown permission: '+id);for(const prerequisite of c.requires)if(!selected.includes(prerequisite))throw new Error(c.label+' requires '+CAPABILITIES.find(c=>c.id===prerequisite).label+'.');}
  if(selected.includes('access.manage')&&!ADMIN_CAPABILITIES.every(c=>selected.includes(c)))throw new Error('Role management and access grants are reserved for a full administrator. Copy Admin with all permissions to grant this authority.');
  return selected;
}
export const SETTINGS = [
  ['/settings/people','People & access','people.view'],['/settings/roles','Roles and Permissions','access.manage'],
  ['/devices','Hardware','hardware.view'],['/location-setup','Location setup','locations.manage'],
  ['/admin/product-fields','Product fields & units','products.fields'],['/backups','Backups & recovery','backups.view'],
  ['/work/timing','Timing settings','work.timing'],['/settings/system','System','system.view'],['/reports?format=1','Report appearance','reports.format'],
];
export function navigation(user) {return [['Work','/work','pick','work.view'],['Products','/products','products','products.view'],['Locations','/cells','locations','locations.view'],['Stocktaking','/stocktaking','reports','count.view'],['Reports','/reports','reports','reports.view']].filter(x=>can(user,x[3]));}

// Shared by the sidebar, Work tabs and cached mobile snapshots.
export const WORK_TABS = [
  {href:'/work',label:'My Work',permission:'work.view',capability:'view'},
  {href:'/work/overview',label:'Assign Work',permission:'work.assign',capability:'assign'},
  {href:'/work/history',label:'History',permission:'work.view',capability:'view'},
  {href:'/work/task-history',label:'Task History',permission:'work.view',capability:'view'},
  {href:'/record-movement',label:'Record Movement',permission:'work.report',capability:'report'},
  {href:'/recommended-actions',label:'Recommended Actions',permission:'work.view',capability:'view'},
];
export function workTabs(user){return WORK_TABS.filter(tab=>can(user,tab.permission));}
export function currentWorkTab(path){
  const pathname=String(path||'').split('?')[0];
  return WORK_TABS.find(tab=>tab.href===pathname)?.href||
    (/^\/tasks\/\d+$/.test(pathname)||['/pick','/put','/pending-confirmations'].includes(pathname)?'/work':
      pathname.startsWith('/recommended-actions')?'/recommended-actions':null);
}
