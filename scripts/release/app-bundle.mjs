import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {isBuiltin} from 'node:module';
import {join} from 'node:path';

export const APP_ENTRIES = [
  ['uninstall','scripts/release/uninstall-entry.mjs'],
  ['server','src/server.js'],
  ['control','scripts/release/control.mjs'],
  ['bootstrap','scripts/release/bootstrap.mjs'],
  ['verify','scripts/release/verify.mjs'],
  ['watchdog','scripts/release/watchdog.mjs'],
  ['wizard-server','scripts/setup/entry.mjs'],
  ['wizard-authorize','scripts/setup/authorize.mjs'],
  ['wizard-system','scripts/setup/system.mjs'],
];

// Browser libraries are shipped as local assets rather than Node imports.
const BROWSER_LIBRARIES = {
  jsqr:{source:'node_modules/jsqr/dist/jsQR.js',asset:'public/client/vendor/jsQR.js'},
};
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function assertBundledImports(metafile, name) {
  for (const output of Object.values(metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path)) {
        throw new Error(`${name} needs an external runtime dependency: ${dependency.path}. Bundle it before making an offline installer.`);
      }
    }
  }
}

export function runtimeDependencyManifest(project, bundles) {
  const pkg=JSON.parse(readFileSync(join(project,'package.json'),'utf8'));
  const lock=JSON.parse(readFileSync(join(project,'package-lock.json'),'utf8'));
  const dependencies=[];
  for (const name of Object.keys(pkg.dependencies || {}).sort()) {
    const modulePath=`node_modules/${name}`;
    const installed=join(project,modulePath,'package.json');
    const locked=lock.packages?.[modulePath];
    if (!locked || !existsSync(installed) || JSON.parse(readFileSync(installed,'utf8')).version!==locked.version) {
      throw new Error(`Runtime dependency ${name} is missing or differs from package-lock.json. Run npm ci on the build computer.`);
    }
    const includedIn=Object.entries(bundles).filter(([,meta])=>Object.keys(meta.inputs).some(path=>path.startsWith(`${modulePath}/`))).map(([name])=>`app/${name}.cjs`);
    const browser=BROWSER_LIBRARIES[name];
    if (browser) {
      const source=join(project,browser.source),asset=join(project,browser.asset);
      if (!existsSync(asset) || digest(source)!==digest(asset)) throw new Error(`Offline browser dependency ${name} is missing or outdated: ${browser.asset}`);
      includedIn.push(browser.asset);
    }
    if (!includedIn.length) throw new Error(`Runtime dependency ${name} is not included in the offline application.`);
    dependencies.push({name,version:locked.version,integrity:locked.integrity,includedIn});
  }
  return {schemaVersion:1,dependencies};
}

export async function buildAppBundles({project,output}) {
  const bundles={};
  for (const [name,entry] of APP_ENTRIES) {
    const result=await build({absWorkingDir:project,entryPoints:[entry],outfile:join(output,`${name}.cjs`),bundle:true,platform:'node',format:'cjs',target:'node24',minify:true,legalComments:'eof',sourcemap:false,metafile:true,logLevel:'warning'});
    assertBundledImports(result.metafile,name);
    bundles[name]=result.metafile;
  }
  return runtimeDependencyManifest(project,bundles);
}
