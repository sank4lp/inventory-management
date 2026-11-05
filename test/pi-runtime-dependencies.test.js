import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {assertBundledImports,buildAppBundles,runtimeDependencyManifest} from '../scripts/release/app-bundle.mjs';

const project=fileURLToPath(new URL('..',import.meta.url));
test('offline bundle guard allows Node builtins but rejects a runtime package left external',()=>{
  const meta=imports=>({outputs:{'server.cjs':{imports}}});
  assert.doesNotThrow(()=>assertBundledImports(meta([{path:'node:sqlite',external:true},{path:'fs',external:true}]),'server'));
  assert.throws(()=>assertBundledImports(meta([{path:'xlsx',external:true}]),'server'),/external runtime dependency: xlsx/);
  assert.throws(()=>assertBundledImports(meta([{path:'./missing.cjs',external:true}]),'server'),/external runtime dependency/);
});

test('runtime manifest refuses missing, version-mismatched or omitted production libraries',()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-dependency-guard-'));
  try {
    writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{xlsx:'locked'}}));
    writeFileSync(join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/xlsx':{version:'0.20.3'}}}));
    const bundles={server:{inputs:{'node_modules/xlsx/xlsx.js':{}}}};
    assert.throws(()=>runtimeDependencyManifest(root,bundles),/missing or differs/);
    mkdirSync(join(root,'node_modules/xlsx'),{recursive:true});
    writeFileSync(join(root,'node_modules/xlsx/package.json'),' {"version":"0.18.5"}');
    assert.throws(()=>runtimeDependencyManifest(root,bundles),/missing or differs/);
    writeFileSync(join(root,'node_modules/xlsx/package.json'),' {"version":"0.20.3"}');
    assert.throws(()=>runtimeDependencyManifest(root,{}),/not included/);
    assert.deepEqual(runtimeDependencyManifest(root,bundles).dependencies[0].includedIn,['app/server.cjs']);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('actual release bundles include Excel/QR and start without node_modules or development data',async()=>{
  const root=mkdtempSync(join(tmpdir(),'lytguide-offline-runtime-'));
  try {
    const manifest=await buildAppBundles({project,output:join(root,'app')});
    const installed=JSON.parse(readFileSync(join(project,'package.json'),'utf8')).dependencies;
    assert.deepEqual(manifest.dependencies.map(d=>d.name).sort(),Object.keys(installed).sort());
    for(const name of ['xlsx','qrcode'])assert.ok(manifest.dependencies.find(d=>d.name===name).includedIn.includes('app/server.cjs'));
    assert.deepEqual(manifest.dependencies.find(d=>d.name==='jsqr').includedIn,['public/client/vendor/jsQR.js']);
    assert.equal(existsSync(join(root,'node_modules')),false);
    assert.equal(existsSync(join(root,'data')),false);
    const run=spawnSync(process.execPath,['--no-global-search-paths','-e',"require('./app/server.cjs'); console.log('OFFLINE_BUNDLE_STARTED'); process.exit(0)"],{
      cwd:root,encoding:'utf8',timeout:15000,
      env:{PATH:process.env.PATH,HOME:root,NODE_PATH:'',NODE_ENV:'production',SESSION_SECRET:'dependency-check-only',HARDWARE_ADAPTER:'simulator',NO_SERVER_LISTEN:'1',DEMO_INVENTORY_SEED:'0',WAREHOUSE_LAYOUT_SEED:'0',CATALOG_DEFAULT_SEED:'0',BOOTSTRAP_ADMIN_USERNAME:'packagecheck',BOOTSTRAP_ADMIN_PASSWORD:'test-only-package-password'},
    });
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/OFFLINE_BUNDLE_STARTED/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
