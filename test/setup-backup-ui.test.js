import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function ui(data){
 const nodes=Object.fromEntries(['#content','#actions','#message','#steps'].map(key=>[key,{innerHTML:'',textContent:'',hidden:false,insertAdjacentHTML(where,value){this.innerHTML=where==='afterbegin'?value+this.innerHTML:this.innerHTML+value;}}]));
 const context=vm.createContext({document:{querySelector:key=>nodes[key]||null},Date,JSON});
 const code=readFileSync(new URL('../scripts/setup/ui/wizard.js',import.meta.url),'utf8').split("document.addEventListener('change'")[0];vm.runInContext(code,context);context.input=data;vm.runInContext('data=input;render()',context);return nodes['#content'].innerHTML;
}
const found={id:'a'.repeat(64),name:'LytGuide-Uninstall-20261031T120000-1234abcd.lytbackup',modifiedAt:'2026-10-31T12:00:00Z',directory:'/boot/firmware/LYTGUIDE-RECOVERY'};
test('Get started offers explicit Yes/No for a detected backup and keeps ordinary new/existing setup choices available',()=>{
 const base={state:{step:'choose',done:[]},detectedBackups:[found],hasWarehouse:false};const html=ui(base);assert.match(html,/Shed backup found/);assert.match(html,/Yes, restore backup/);assert.match(html,/No, continue without restoring/);assert.match(html,/data-choose="new"/);
 assert.doesNotMatch(ui({...base,state:{...base.state,backupPromptDismissed:true}}),/data-restore-detected/);assert.doesNotMatch(ui({...base,detectedBackups:[]}),/Shed backup found/);
});
test('Restore offers detected-file selection and the native file picker together; both require backup inspection and explicit restore confirmation',()=>{
 const html=ui({state:{mode:'replace',step:'backup',done:[],backupFile:{name:found.name,bytes:123}},detectedBackups:[found]});
 assert.match(html,/Backups found on this Pi/);assert.match(html,/data-select-detected/);assert.match(html,/Browse this Pi for another backup/);assert.match(html,/id="backup-file" type="file" accept=".lytbackup"/);assert.match(html,/Check backup/);assert.match(html,/name="restoreConfirmed"/);
});
test('existing warehouse Administrator step permits new username and optional new password without length guidance',()=>{
 const html=ui({state:{mode:'configure',step:'account',done:[]},hasWarehouse:true,hasRecoveryPassword:true,existingWarehouse:{username:'owner',administratorId:7,warehouseName:'Warehouse'}});
 assert.match(html,/name="username"[^>]*value="owner"/);assert.match(html,/name="administratorId" value="7"/);
 assert.match(html,/name="adminPassword" type="password"/);assert.match(html,/name="adminConfirm" type="password"/);
 assert.doesNotMatch(html,/Administrator already created|Password guidance|12 characters|minlength/);assert.match(html,/Leave password blank/);
});
