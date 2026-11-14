import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopWindowArgs,desktopEntry,desktopEnvironment,desktopExecutable} from '../scripts/release/desktop.mjs';
import {initialSetupState,restartedSetupState,requireRevision,setupSteps,advance} from '../scripts/setup/model.mjs';
import {createSetupSessions} from '../scripts/setup/security.mjs';

test('app and Setup launch the bundled executable with mode flags and no installed-browser dependency',()=>{
  assert.deepEqual(desktopWindowArgs(),['--lytguide-work']);assert.deepEqual(desktopWindowArgs({setup:true}),['--lytguide-setup']);assert.deepEqual(desktopWindowArgs({setup:true,resume:true}),['--lytguide-resume']);assert.throws(()=>desktopWindowArgs({resume:true}));
  assert.equal(desktopExecutable('/opt/lytguide-test/candidate'),'/opt/lytguide-test/candidate/desktop/lytguide-desktop');
  for(const setup of [false,true]){const entry=desktopEntry({setup});assert.match(entry,/Icon=lytguide/);assert.match(entry,/Terminal=false/);assert.match(entry,/StartupWMClass=com\.lytguide\.Warehouse/);assert.doesNotMatch(entry,/web-browser|chromium|Name=LytGuide Test/);}
  const clean=desktopEnvironment({HOME:'/home/user',DISPLAY:':0',ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--inspect=0.0.0.0',NODE_PATH:'/unsafe'});assert.deepEqual(clean,{HOME:'/home/user',DISPLAY:':0'});
});
test('restarting Setup discards its completed checklist and restore choices, invalidates old revisions, and offers all steps for existing warehouses',()=>{
  const previous={...initialSetupState(),revision:41,mode:'replace',step:'finish',done:['choose','system','network','backup','phones','hardware','finish'],completedAt:new Date().toISOString(),uploadedBackup:{path:'/secret/backup'},backupSummary:{},address:'192.168.1.140',simulation:true,resetMode:'fresh',keepHardware:false};
  const fresh=restartedSetupState(previous);assert.equal(fresh.step,'choose');assert.equal(fresh.mode,null);assert.deepEqual(fresh.done,[]);assert.equal(fresh.completedAt,null);assert.equal(fresh.revision,42);
  for(const key of ['uploadedBackup','backupSummary','address','resetMode','keepHardware'])assert.equal(key in fresh,false);
  assert.throws(()=>requireRevision(fresh,{revision:41}),/another window/);
  assert.deepEqual(setupSteps('configure'),setupSteps('new'));
  assert.equal(advance({...fresh,mode:'configure',step:'network'},'network').step,'account');
});
test('only a fresh administrator launch restarts Setup and invalidates prior sessions; browser reload and internal resume preserve progress',async()=>{
  let restarts=0,deny=false;const grant={uid:1000,expiresAt:Date.now()+60000};
  const sessions=createSetupSessions({redeem:async()=>grant,onAuthorize(value){if(deny)throw Error('Firmware job is running');if(value.restart)restarts++;}});
  const first=await sessions.unlock('a'.repeat(64));assert.equal(restarts,0);assert.equal(sessions.actor('lytguide_setup='+first).uid,1000);
  grant.restart=true;deny=true;await assert.rejects(()=>sessions.unlock('b'.repeat(64)),/Firmware/);assert.equal(restarts,0);assert.equal(sessions.actor('lytguide_setup='+first).uid,1000);
  deny=false;const second=await sessions.unlock('c'.repeat(64));assert.equal(restarts,1);assert.throws(()=>sessions.actor('lytguide_setup='+first),/expired/);assert.equal(sessions.actor('lytguide_setup='+second).uid,1000);
  grant.restart=false;await sessions.unlock('d'.repeat(64));assert.equal(restarts,1);assert.equal(sessions.actor('lytguide_setup='+second).uid,1000);
});
