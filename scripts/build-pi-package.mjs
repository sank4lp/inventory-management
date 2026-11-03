#!/usr/bin/env node
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {listReleaseFiles,serviceUnit,validateReleaseVersion} from './release/pi-package.mjs';
import {recoveryUnits} from './release/card-recovery.mjs';
import {setupServiceUnit,setupPolkitPolicy} from './setup/integration.mjs';
import {watchdogUnits,desktopAutostart} from './release/always-on.mjs';
import {desktopEntry} from './release/desktop.mjs';
import {ELECTRON_VERSION,ELECTRON_LINUX_SHA256,DESKTOP_DEPENDENCIES,stageDesktop} from './release/electron-bundle.mjs';
import {SUPPORTED_OS_SUITES} from './release/supported-os.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),flag=name=>{const i=args.indexOf(name);return i===-1?null:args[i+1];};
for(let i=0;i<args.length;i+=2)if(!['--version','--output','--toolchain'].includes(args[i])||!args[i+1])throw new Error('Use --version VERSION, --output FOLDER or --toolchain FOLDER.');
const version=validateReleaseVersion(flag('--version')||'0.1.0~test.20261027.1');
const output=resolve(flag('--output')||join(project,'output/pi-test'));
if(existsSync(join(output,`lytguide-test_${version}_arm64.deb`)))throw new Error('That build version already exists. Pass --version with a new test version.');
const cache=join(project,'output/release-cache');
const toolchain=resolve(flag('--toolchain')||join(cache,'firmware-linux-arm64'));
const epoch=Number(execFileSync('git',['show','-s','--format=%ct','HEAD'],{cwd:project,encoding:'utf8'}).trim());
const stage=join(output,`.build-${process.pid}`),release=join(stage,'release'),debRoot=join(stage,'deb'),control=join(stage,'control');
const downloads=[
  {file:`electron-v${ELECTRON_VERSION}-linux-arm64.zip`,url:`https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-arm64.zip`,algorithm:'sha256',hash:ELECTRON_LINUX_SHA256},
  {file:'node-v24.22.1-linux-arm64.tar.xz',url:'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.xz',algorithm:'sha256',hash:'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e'},
  {file:'caddy_2.11.7_linux_arm64.tar.gz',url:'https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_arm64.tar.gz',algorithm:'sha512',hash:'3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e'},
];
function run(cmd,a,options={}){return execFileSync(cmd,a,{cwd:project,stdio:'inherit',...options});}
function write(path,text,mode=0o644){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text,{mode});chmodSync(path,mode);}
function copy(source,destination){mkdirSync(dirname(destination),{recursive:true});copyFileSync(source,destination);}
function checkedDownload(item){const path=join(cache,item.file);if(!existsSync(path)){run('curl',['-fL','--retry','3','--max-time','240','-o',`${path}.new`,item.url]);copyFileSync(`${path}.new`,path);rmSync(`${path}.new`);}const actual=createHash(item.algorithm).update(readFileSync(path)).digest('hex');if(actual!==item.hash)throw new Error(`Official download checksum mismatch: ${item.file}`);return path;}
mkdirSync(output,{recursive:true});mkdirSync(cache,{recursive:true});
if(!existsSync(join(toolchain,'toolchain.json')))throw new Error('Prepare the offline ARM64 firmware toolchain first. See docs/pi-test-installer.md.');
const toolManifest=JSON.parse(readFileSync(join(toolchain,'toolchain.json'),'utf8'));
if(toolManifest.platform!=='linux'||toolManifest.arch!=='arm64')throw new Error('The firmware toolchain must target Linux ARM64, not the Mac.');
if(existsSync(stage))throw new Error('Build folder already exists.');
mkdirSync(release,{recursive:true});mkdirSync(debRoot,{recursive:true});mkdirSync(control,{recursive:true});
try {
  const electronArchive=checkedDownload(downloads[0]),nodeArchive=checkedDownload(downloads[1]),caddyArchive=checkedDownload(downloads[2]);
  await stageDesktop({project,archive:electronArchive,target:join(release,'desktop'),version});
  const extracted=join(stage,'extracted');mkdirSync(extracted);
  run('tar',['-xJf',nodeArchive,'-C',extracted,'node-v24.22.1-linux-arm64/bin/node','node-v24.22.1-linux-arm64/LICENSE']);run('tar',['-xzf',caddyArchive,'-C',extracted]);
  copy(join(extracted,'node-v24.22.1-linux-arm64/bin/node'),join(release,'runtime/node'));chmodSync(join(release,'runtime/node'),0o755);
  copy(join(extracted,'caddy'),join(release,'runtime/caddy'));chmodSync(join(release,'runtime/caddy'),0o755);
  copy(join(extracted,'node-v24.22.1-linux-arm64/LICENSE'),join(release,'notices/Node-LICENSE'));
  copy(join(extracted,'LICENSE'),join(release,'notices/Caddy-LICENSE'));
  for(const [name,entry] of [['uninstall','scripts/release/uninstall-entry.mjs'],['server','src/server.js'],['control','scripts/release/control.mjs'],['bootstrap','scripts/release/bootstrap.mjs'],['verify','scripts/release/verify.mjs'],['watchdog','scripts/release/watchdog.mjs'],['wizard-server','scripts/setup/entry.mjs'],['wizard-authorize','scripts/setup/authorize.mjs'],['wizard-system','scripts/setup/system.mjs']]){
    await build({absWorkingDir:project,entryPoints:[entry],outfile:join(release,`app/${name}.cjs`),bundle:true,platform:'node',format:'cjs',target:'node24',minify:true,legalComments:'eof',sourcemap:false,logLevel:'warning'});
  }
  copy(join(project,'scripts/release/portable-backup.py'),join(release,'app/portable-backup.py'));
  cpSync(join(project,'scripts/setup/ui'),join(release,'setup-ui'),{recursive:true});
  copy(join(project,'public/brand/lytguide-icon.svg'),join(release,'setup-ui/icon.svg'));
  // Allowlisted assets only: no development database, .env, Git metadata or test exports.
  cpSync(join(project,'public'),join(release,'public'),{recursive:true,filter:src=>!['.DS_Store'].includes(src.split('/').pop())&&!src.split('/').pop().startsWith('._')});
  cpSync(join(project,'firmware/esp32-simple-matrix'),join(release,'firmware/esp32-simple-matrix'),{recursive:true,filter:src=>!['build','.DS_Store'].includes(src.split('/').pop())&&!src.split('/').pop().startsWith('._')});
  console.log('Staging offline firmware tools…');
  cpSync(toolchain,join(release,'toolchain'),{recursive:true,verbatimSymlinks:true,filter:src=>!['staging','inventory.yaml','toolchain.json','.DS_Store'].includes(src.split('/').pop())});
  // Regenerate against staged files after removing downloaded archive caches.
  run(process.execPath,['scripts/prepare-firmware-bundle.mjs',join(release,'toolchain'),'linux','arm64']);
  const production=Object.entries(JSON.parse(readFileSync(join(project,'package-lock.json'),'utf8')).packages).filter(([name,info])=>name.startsWith('node_modules/')&&!info.dev&&existsSync(join(project,name)));
  for(const [modulePath] of production){
    const name=modulePath.replace('node_modules/','').replaceAll('/','-'),moduleDir=join(project,modulePath);
    for(const entry of readdirSync(moduleDir))if(/^licen[cs]e/i.test(entry)&&lstatSync(join(moduleDir,entry)).isFile())copy(join(moduleDir,entry),join(release,`notices/${name}-${entry}`));
  }
  write(join(release,'notices/README.txt'),'LytGuide test build. Third-party software retains its own licences. Arduino CLI, ESP32 core and bundled tools/libraries include their licence files in toolchain/. This test package is not copy-protected or production-licensed. No customer data is included.\n');
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8'}).trim();
  const dirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:project,encoding:'utf8'}).trim());
  const manifest={name:'LytGuide Test',version,platform:'linux',arch:'arm64',supportedOsSuites:SUPPORTED_OS_SUITES,licensing:'test-unlicensed',sourceCommit,sourceIncludesUncommittedChanges:dirty,nodeVersion:'24.22.1',caddyVersion:'2.11.7',desktop:{runtime:'electron',version:ELECTRON_VERSION,sha256:ELECTRON_LINUX_SHA256},firmware:{cli:toolManifest.cliVersion,core:toolManifest.coreVersion,neoPixel:toolManifest.libraryVersion},files:listReleaseFiles(release)};
  write(join(release,'release.json'),JSON.stringify(manifest,null,2)+'\n');
  const packageLib=join(debRoot,'usr/lib/lytguide-test');mkdirSync(packageLib,{recursive:true});
  console.log('Compressing the Raspberry Pi application and offline compiler…');
  run('python3',['scripts/release/make-archives.py','tar',release,join(packageLib,'release.tar.gz'),'--epoch',String(epoch)]);
  write(join(packageLib,'release-id'),version+'\n');
  write(join(packageLib,'release-manifest.sha256'),createHash('sha256').update(readFileSync(join(release,'release.json'))).digest('hex')+'\n');
  write(join(packageLib,'unpacked-bytes'),String(manifest.files.reduce((n,file)=>n+statSync(join(release,file.path)).size,0))+'\n');
  write(join(packageLib,'check-restore.sh'),'#!/bin/sh\nif [ -e /var/lib/lytguide-test/restore-in-progress.json ]; then\n echo "Restore interrupted. Keep hardware off; run sudo lytguide-test restore-rollback." >&2\n exit 1\nfi\n',0o755);
  write(join(packageLib,'setup-authorize'),'#!/bin/sh\nset -eu\nexec /opt/lytguide-test/candidate/runtime/node /opt/lytguide-test/candidate/app/wizard-authorize.cjs "$@"\n',0o755);
  write(join(debRoot,'usr/bin/lytguide-test'),'#!/bin/sh\nset -eu\nexec /opt/lytguide-test/candidate/runtime/node /opt/lytguide-test/candidate/app/control.cjs "$@"\n',0o755);
  copy(join(project,'scripts/release/uninstall-launch.sh'),join(debRoot,'usr/bin/lytguide-uninstall'));chmodSync(join(debRoot,'usr/bin/lytguide-uninstall'),0o755);
  write(join(debRoot,'usr/share/applications/com.lytguide.Uninstall.desktop'),'[Desktop Entry]\nType=Application\nName=Uninstall LytGuide\nExec=/usr/bin/lytguide-uninstall\nIcon=lytguide\nTerminal=false\nCategories=Settings;\n');
  write(join(debRoot,'lib/systemd/system/lytguide-test.service'),serviceUnit());
  write(join(debRoot,'lib/systemd/system/lytguide-test-web.service'),serviceUnit(true));
  const recovery=recoveryUnits();
  write(join(debRoot,'lib/systemd/system/lytguide-test-backup.service'),recovery.service);
  write(join(debRoot,'lib/systemd/system/lytguide-test-backup.timer'),recovery.timer);
  write(join(debRoot,'lib/systemd/system/lytguide-test-setup.service'),setupServiceUnit());
  const watchdog=watchdogUnits();
  write(join(debRoot,'lib/systemd/system/lytguide-test-watchdog.service'),watchdog.service);
  write(join(debRoot,'lib/systemd/system/lytguide-test-watchdog.timer'),watchdog.timer);
  write(join(debRoot,'etc/xdg/autostart/lytguide-test.desktop'),desktopAutostart());
  write(join(debRoot,'usr/share/polkit-1/actions/com.lytguide.setup.policy'),setupPolkitPolicy());
  copy(join(project,'public/brand/lytguide-icon.svg'),join(debRoot,'usr/share/icons/hicolor/scalable/apps/lytguide.svg'));
  write(join(debRoot,'usr/share/applications/com.lytguide.Warehouse.desktop'),desktopEntry());
  write(join(debRoot,'usr/share/applications/com.lytguide.Setup.desktop'),desktopEntry({setup:true}));
  if(existsSync(join(project,'docs/pi-test-installer.md')))copy(join(project,'docs/pi-test-installer.md'),join(debRoot,'usr/share/doc/lytguide-test/pi-test-installer.md'));
  write(join(control,'control'),`Package: lytguide-test\nVersion: ${version}\nSection: misc\nPriority: optional\nArchitecture: arm64\nMaintainer: LytGuide development\nDepends: libc6 (>= 2.28), libstdc++6, libusb-1.0-0, python3, python3-serial, systemd, passwd, util-linux, coreutils, tar, pkexec, polkitd, network-manager, ${DESKTOP_DEPENDENCIES}\nDescription: LytGuide local Raspberry Pi test application\n Bundled runtime, local HTTPS, offline ESP32 tools and guided warehouse setup.\n No activation required. Configure explicitly after installation.\n`);
  for(const name of ['postinst','prerm','postrm']){copy(join(project,`scripts/release/${name}.sh`),join(control,name));chmodSync(join(control,name),0o755);}
  const artifact=join(output,`lytguide-test_${version}_arm64.deb`);
  run('python3',['scripts/release/make-archives.py','deb',debRoot,artifact,'--control',control,'--epoch',String(epoch)]);
  copy(join(release,'app/uninstall.cjs'),artifact+'.uninstall.cjs');
  copy(join(release,'app/portable-backup.py'),artifact+'.portable-backup.py');
  const checksum=createHash('sha256').update(readFileSync(artifact)).digest('hex');
  write(`${artifact}.sha256`,`${checksum}  ${artifact.split('/').pop()}\n`);
  write(join(output,'release-info.json'),JSON.stringify({...manifest,files:undefined,artifact:artifact.split('/').pop(),sha256:checksum},null,2)+'\n');
  console.log(`Built ${artifact}\nSHA256 ${checksum}`);
}finally{rmSync(stage,{recursive:true,force:true});}
