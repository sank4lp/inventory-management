import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';

export const INSTALL_ROOT='/opt/lytguide-test';
export const STATE_ROOT='/var/lib/lytguide-test';
export const CONFIG_ROOT='/etc/lytguide-test';
export const APP_USER='lytguide-test';
export const WEB_USER='lytguide-test-web';
export const APP_SERVICE='lytguide-test.service';
export const WEB_SERVICE='lytguide-test-web.service';

export function validateReleaseVersion(value) {
  if(!/^\d[0-9A-Za-z.+~:-]{0,75}$/.test(value)||value.includes('..'))throw new Error('Use a valid version without paths or spaces.');
  return value;
}
export function validateTestConfig(value) {
  const config={...value};
  for(const key of ['appPort','httpsPort'])if(!Number.isInteger(config[key])||config[key]<1024||config[key]>65535)throw new Error('Test ports must be from 1024 to 65535.');
  if(config.appPort===config.httpsPort)throw new Error('App and HTTPS ports must be different.');
  if(!['simulator','rs485'].includes(config.hardware))throw new Error('Choose simulator or rs485 hardware.');
  if((config.hardware==='rs485'||config.serialPort)&&!/^\/dev\/[A-Za-z0-9._/-]+$/.test(config.serialPort||''))throw new Error('Supply a /dev serial port.');
  if(!/^[a-f0-9]{64}$/.test(config.sessionSecret||''))throw new Error('A per-installation session secret is required.');
  if(!/^[A-Za-z0-9-]{1,100}$/.test(config.siteId||''))throw new Error('Invalid test site identity.');
  if(config.recoveryDirectory!=null&&!['/boot/firmware/LYTGUIDE-RECOVERY','/boot/LYTGUIDE-RECOVERY'].includes(config.recoveryDirectory))throw new Error('Invalid SD-card recovery folder.');
  if(config.blankWarehouse!=null&&typeof config.blankWarehouse!=='boolean')throw new Error('Invalid shed mode.');
  if(config.warehouseName!=null&&(typeof config.warehouseName!=='string'||!config.warehouseName.trim()||config.warehouseName.length>80||/[\r\n\0]/.test(config.warehouseName)))throw new Error('Use a shed name of 1–80 characters.');
  if(config.enrollPort!=null&&(!Number.isInteger(config.enrollPort)||config.enrollPort<1024||config.enrollPort>65535||[config.appPort,config.httpsPort].includes(config.enrollPort)))throw new Error('Choose a separate certificate-download port from 1024–65535.');
  return config;
}
export function runtimeEnvironment(config) {
  validateTestConfig(config);
  return [
    '# LytGuide test package; credentials are never stored here.',
    'NODE_ENV=production',`PORT=${config.appPort}`,`SESSION_SECRET=${config.sessionSecret}`,
    `WAREHOUSE_SITE_ID=${config.siteId}`,`HARDWARE_ADAPTER=${config.hardware}`,
    `RS485_SERIAL_PORT=${config.serialPort||''}`,'DEMO_INVENTORY_SEED=0',
    ...(config.blankWarehouse?['WAREHOUSE_LAYOUT_SEED=0','CATALOG_DEFAULT_SEED=0']:[]),
    `FIRMWARE_TOOLCHAIN_ROOT=${INSTALL_ROOT}/current/toolchain`,
    `ARDUINO_CLI_PATH=${INSTALL_ROOT}/current/toolchain/bin/arduino-cli`,
    `ARDUINO_DIRECTORIES_DOWNLOADS=${STATE_ROOT}/cache/arduino-downloads`,
    `ESP32_SKETCH_PATH=${INSTALL_ROOT}/current/firmware/esp32-simple-matrix`,
    `HOME=${STATE_ROOT}`,`XDG_CACHE_HOME=${STATE_ROOT}/cache`,
    `LYTGUIDE_SETUP_PENDING_FILE=${STATE_ROOT}/setup-pending`,
    'LOG_LEVEL=info','',
  ].join('\n');
}
export function serviceUnit(web=false) {
  return `# LytGuide test package
[Unit]
Description=LytGuide Test${web?' local HTTPS':' application'}
After=network.target${web?` ${APP_SERVICE}`:''}

[Service]
Type=simple
User=${web?WEB_USER:APP_USER}
Group=${web?WEB_USER:APP_USER}
${web?'':`SupplementaryGroups=dialout\nEnvironmentFile=${CONFIG_ROOT}/runtime.env\nExecStartPre=/usr/lib/lytguide-test/check-restore.sh\n`}WorkingDirectory=${web?`${STATE_ROOT}/caddy`:`${INSTALL_ROOT}/current`}
ExecStart=${web?`${INSTALL_ROOT}/current/runtime/caddy run --config ${CONFIG_ROOT}/Caddyfile --adapter caddyfile`:`${INSTALL_ROOT}/current/runtime/node ${INSTALL_ROOT}/current/app/server.cjs`}
Restart=always
RestartSec=3
TimeoutStopSec=25
UMask=0077
NoNewPrivileges=true
${web?'':'PrivateTmp=true\n'}ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${web?`${STATE_ROOT}/caddy`:STATE_ROOT}
${web?`Environment=HOME=${STATE_ROOT}/caddy\nEnvironment=XDG_DATA_HOME=${STATE_ROOT}/caddy\nEnvironment=XDG_CONFIG_HOME=${STATE_ROOT}/caddy\n`:''}
[Install]
WantedBy=multi-user.target
`;
}
export function listReleaseFiles(root) {
  const result=[];
  function walk(dir) {
    for(const name of readdirSync(dir).sort()) {
      const path=join(dir,name),rel=relative(root,path),stat=lstatSync(path);
      if(rel==='data'||rel==='release.json'||rel==='toolchain/data/inventory.yaml')continue;
      if(stat.isDirectory())walk(path);
      else if(stat.isFile()||stat.isSymbolicLink()) {
        const target=realpathSync(path),inside=relative(realpathSync(root),target);
        if(inside.startsWith('..')||resolve(target)===resolve(root))throw new Error(`Release symlink escapes the package: ${rel}`);
        result.push({path:rel.split(sep).join('/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
      } else throw new Error(`Unsupported release file: ${rel}`);
    }
  }
  walk(root);return result;
}
export function verifyRelease(root) {
  const base=realpathSync(root),manifest=JSON.parse(readFileSync(join(base,'release.json'),'utf8'));
  validateReleaseVersion(manifest.version);
  if(manifest.platform!=='linux'||manifest.arch!=='arm64'||manifest.licensing!=='test-unlicensed')throw new Error('Not a Raspberry Pi ARM64 test package.');
  const actual=listReleaseFiles(base);
  if(JSON.stringify(actual)!==JSON.stringify(manifest.files))throw new Error('Package files differ from the integrity manifest. Reinstall the test package.');
  return manifest;
}
