import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
export const ELECTRON_VERSION='45.1.0';
export const ELECTRON_LINUX_SHA256='64b78d93d1129ab805cdc0f2710f446716afbe814a1d08e639dab3175d2285a1';
export const DESKTOP_DEPENDENCIES='libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libcups2 | libcups2t64, libdrm2, libxkbcommon0, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libgbm1, libasound2 | libasound2t64, libx11-6, libxcb1, libxext6, dbus-user-session';
export async function stageDesktop({project,archive,target,version}){
  if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==ELECTRON_LINUX_SHA256)throw new Error('Official Electron archive checksum mismatch.');
  mkdirSync(target,{recursive:true});
  execFileSync('python3',['-c',`import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in archive.infolist():
  path=(root/item.filename).resolve()
  if not path.is_relative_to(root):raise SystemExit('Unsafe runtime archive')
 archive.extractall(root)
`,archive,target]);
  renameSync(join(target,'electron'),join(target,'lytguide-desktop'));chmodSync(join(target,'lytguide-desktop'),0o755);chmodSync(join(target,'chrome_crashpad_handler'),0o755);chmodSync(join(target,'chrome-sandbox'),0o4755);
  rmSync(join(target,'resources/default_app.asar'),{force:true});
  const app=join(target,'resources/app'),assets=join(target,'resources/lytguide-assets');mkdirSync(app,{recursive:true});mkdirSync(assets,{recursive:true});
  await build({absWorkingDir:project,entryPoints:['src/desktop/main.mjs'],outfile:join(app,'main.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],minify:true,legalComments:'eof',sourcemap:false,logLevel:'warning'});
  writeFileSync(join(app,'package.json'),JSON.stringify({name:'lytguide',productName:'LytGuide',desktopName:'com.lytguide.Warehouse.desktop',version:'0.1.0',lytguideBuild:version,main:'main.cjs'})+'\n');
  for(const name of ['loading.html','icon.png'])copyFileSync(join(project,'src/desktop',name),join(assets,name));
  if(!existsSync(join(target,'LICENSE'))||!existsSync(join(target,'LICENSES.chromium.html')))throw new Error('The bundled desktop runtime is missing its licence notices.');
}
