import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync,symlinkSync,readdirSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {parseBackupAnswer,uninstallWarehouse,removeManagedBackups} from '../scripts/release/uninstall.mjs';
import {discoverBackups,stageDetectedBackup,publicBackups} from '../scripts/release/backup-discovery.mjs';

function fixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lytguide-uninstall-'))),paths={install:join(root,'app'),state:join(root,'state'),config:join(root,'config'),retained:join(root,'retained'),backupDirectories:[join(root,'backups')]},directory=paths.backupDirectories[0];
 for(const dir of [...Object.values(paths).filter(value=>typeof value==='string'),directory,join(paths.state,'data'),join(paths.state,'recovery')])mkdirSync(dir,{recursive:true});
 writeFileSync(join(paths.install,'.lytguide-test-installation'),'managed');writeFileSync(join(paths.config,'config.json'),JSON.stringify({warehouseName:'Test',recoveryDirectory:directory}));
 const db=new DatabaseSync(join(paths.state,'data/inventory.db'));db.exec('CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT)');db.close();
 const events=[],logs=[];const run=(command,args)=>{events.push([command,...args].join(' '));if(command==='systemctl'&&args[0]==='is-active')return args[1]==='lytguide-test.service'?'active':'inactive';return '';};
 const backup=async()=>{assert.ok(events.some(e=>e.startsWith('systemctl stop ')));assert.ok(existsSync(join(paths.state,'data/inventory.db')));events.push('backup');const path=join(directory,'LytGuide-20261031T120000-abcdef12.lytbackup');writeFileSync(path,'verified-copy');return {path};};
 const options={run,paths,backup,locate:()=>directory,cleanProfiles:()=>events.push('profiles'),cleanupSystem:()=>events.push('system-clean'),stopDesktop:()=>events.push('desktop-stop'),log:value=>logs.push(value)};
 t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,paths,directory,events,logs,options};
}

test('backup deletion defaults to No, accepts only explicit Y/Yes, and rejects ambiguous answers',()=>{
 for(const value of ['',undefined,'N','no',' n '])assert.equal(parseBackupAnswer(value),false);
 for(const value of ['Y','yes',' YES '])assert.equal(parseBackupAnswer(value),true);
 assert.throws(()=>parseBackupAnswer('maybe'),/Enter Y or N/);
});
test('uninstall snapshots the stopped warehouse before package removal and retains latest and older backups by default',async t=>{
 const f=fixture(t);writeFileSync(join(f.directory,'LytGuide-20261030T120000-1234abcd.lytbackup'),'older');writeFileSync(join(f.paths.state,'recovery','prior.sqlite'),'prior restore point');
 const result=await uninstallWarehouse({...f.options,confirm:async()=>parseBackupAnswer('')});
 assert.ok(existsSync(result.backupPath));assert.equal(readFileSync(result.backupPath,'utf8'),'verified-copy');assert.ok(existsSync(join(f.directory,'LytGuide-20261030T120000-1234abcd.lytbackup')));
 assert.ok(f.events.indexOf('backup')<f.events.indexOf('dpkg --purge lytguide-test'));
 for(const key of ['install','state','config'])assert.equal(existsSync(f.paths[key]),false);
 assert.equal(readdirSync(f.paths.retained).filter(name=>name.startsWith('uninstall-recovery-')).length,1);
});
test('explicit Y still creates a fresh backup first, then deletes managed backups while preserving unrelated files',async t=>{
 const f=fixture(t);writeFileSync(join(f.directory,'customer-note.txt'),'keep');writeFileSync(join(f.directory,'manually-exported.lytbackup'),'keep manual export');
 const result=await uninstallWarehouse({...f.options,confirm:async()=>true});assert.equal(result.backupPath,null);assert.ok(f.events.includes('backup'));
 assert.equal(readdirSync(f.directory).some(name=>name.startsWith('LytGuide-')),false);assert.equal(readFileSync(join(f.directory,'customer-note.txt'),'utf8'),'keep');assert.ok(existsSync(join(f.directory,'manually-exported.lytbackup')));
});
test('snapshot failure aborts uninstall, keeps warehouse/config/package and restores previously running services',async t=>{
 const f=fixture(t);await assert.rejects(()=>uninstallWarehouse({...f.options,confirm:async()=>true,backup:async()=>{throw Error('Disk full');}}),/Disk full.*stopped/);
 for(const key of ['install','state','config'])assert.ok(existsSync(f.paths[key]));assert.equal(f.events.includes('dpkg --purge lytguide-test'),false);assert.ok(f.events.includes('systemctl start lytguide-test.service'));
});
test('active firmware work, interrupted restore and unowned installation are protected before deletion',async t=>{
 const f=fixture(t),db=new DatabaseSync(join(f.paths.state,'data/inventory.db'));db.exec("INSERT INTO app_metadata VALUES('firmware_busy','job')");db.close();
 await assert.rejects(()=>uninstallWarehouse({...f.options,confirm:async()=>false}),/firmware/);assert.equal(f.events.some(e=>e.startsWith('systemctl stop ')),false);
 writeFileSync(join(f.paths.state,'restore-in-progress.json'),'{}');await assert.rejects(()=>uninstallWarehouse({...f.options,confirm:async()=>false}),/interrupted/);rmSync(join(f.paths.state,'restore-in-progress.json'));
 rmSync(join(f.paths.install,'.lytguide-test-installation'));await assert.rejects(()=>uninstallWarehouse({...f.options,confirm:async()=>false}),/not a managed/);
});
test('discovery offers newest files from only designated folders; selecting stages a copy and rejects changed files, links and arbitrary paths',t=>{
 const f=fixture(t),first=join(f.directory,'older.lytbackup'),latest=join(f.directory,'latest.lytbackup');writeFileSync(first,'old');writeFileSync(latest,'new');utimesSync(first,new Date(0),new Date(0));symlinkSync(latest,join(f.directory,'linked.lytbackup'));writeFileSync(join(f.directory,'notes.txt'),'no');
 const found=discoverBackups([f.directory]);assert.equal(found.length,2);assert.equal(found[0].name,'latest.lytbackup');assert.equal(publicBackups(found)[0].path,undefined);
 const staged=stageDetectedBackup(found[0].id,join(f.root,'uploads'),{directories:[f.directory]});assert.equal(readFileSync(staged.path,'utf8'),'new');assert.ok(existsSync(latest));
 writeFileSync(latest,'changed');assert.throws(()=>stageDetectedBackup(found[0].id,join(f.root,'uploads'),{directories:[f.directory]}),/changed|available/);assert.throws(()=>stageDetectedBackup('/etc/passwd',join(f.root,'uploads'),{directories:[f.directory]}),/Choose/);
 const linked=join(f.root,'linked-dir');symlinkSync(f.directory,linked);assert.deepEqual(discoverBackups([linked]),[]);
});
test('linked backup entries never cause deletion outside their designated directory',t=>{
 const f=fixture(t),outside=join(f.root,'outside');writeFileSync(outside,'keep');symlinkSync(outside,join(f.directory,'LytGuide-20261031T120000-1234abcd.lytbackup'));removeManagedBackups(f.directory);assert.equal(readFileSync(outside,'utf8'),'keep');
});

test('an uninstall recovery copy survives later normal backup rotation for a newly installed warehouse',t=>{
 const f=fixture(t),source=join(f.root,'source');writeFileSync(source,'test archive bytes');
 const publish=purpose=>{const run=spawnSync('python3',['scripts/release/portable-backup.py'],{input:JSON.stringify({action:'publish',source,directory:f.directory,...(purpose?{purpose,retainAll:true}:{})}),encoding:'utf8'});assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout);};
 const retained=publish('uninstall');assert.match(retained.filename,/^LytGuide-Uninstall-/);
 for(let i=0;i<4;i++)publish();assert.ok(existsSync(join(f.directory,retained.filename)));assert.equal(readdirSync(f.directory).filter(name=>/^LytGuide-\d/.test(name)).length,2);
 removeManagedBackups(f.directory);assert.equal(existsSync(join(f.directory,retained.filename)),false);
});
