import {APP_SERVICE,WEB_SERVICE,INSTALL_ROOT,STATE_ROOT,CONFIG_ROOT} from './pi-package.mjs';
export const WATCHDOG_SERVICE='lytguide-test-watchdog.service';
export const WATCHDOG_TIMER='lytguide-test-watchdog.timer';
export const WATCHDOG_POLICY={failures:3,startupGraceMs:90000,cooldownMs:180000,windowMs:900000,maxRestarts:3};
export function healthDecision(previous,{bootId,now,services,blocked=null},policy=WATCHDOG_POLICY){
  const old=previous?.bootId===bootId?previous:{services:{}};
  const state={bootId,checkedAt:new Date().toISOString(),services:{},blocked};const restart=[];
  for(const current of services){
    const prior=old.services?.[current.name]||{};
    const history=(prior.restarts||[]).filter(at=>at<=now&&now-at<policy.windowMs);
    const next={...current,failures:0,restarts:history};state.services[current.name]=next;
    if(blocked||current.skip){next.reason=blocked||current.skip;continue;}
    if(!['active','failed'].includes(current.activeState)){next.reason='Service is stopped or starting';continue;}
    if(current.activeState==='active'&&now-current.startedAt<policy.startupGraceMs){next.reason='Starting';continue;}
    if(current.healthy===true){next.reason='Healthy';continue;}
    next.failures=(prior.pid===current.pid?prior.failures||0:0)+1;next.reason='Waiting for repeated failed checks';
    if(next.failures<policy.failures)continue;
    if(history.length&&now-history.at(-1)<policy.cooldownMs){next.reason='Recovery cooldown';continue;}
    if(history.length>=policy.maxRestarts){next.reason='Recovery rate limit';continue;}
    restart.push(current.name);next.reason='Recovery requested';
  }
  return {state,restart};
}
export function watchdogUnits(){return {service:`[Unit]
Description=LytGuide automatic service recovery
After=network.target
ConditionPathExists=${CONFIG_ROOT}/config.json

[Service]
Type=oneshot
User=root
ExecStart=${INSTALL_ROOT}/current/runtime/node ${INSTALL_ROOT}/current/app/watchdog.cjs
TimeoutStartSec=100
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${STATE_ROOT}
`,timer:`[Unit]
Description=Check LytGuide service responsiveness

[Timer]
OnBootSec=90sec
OnUnitInactiveSec=30sec
AccuracySec=2sec
Unit=${WATCHDOG_SERVICE}

[Install]
WantedBy=timers.target
`};}
export function desktopAutostart(){return `[Desktop Entry]
Type=Application
Name=LytGuide
Comment=Open the warehouse when the Pi desktop starts
Exec=/usr/bin/lytguide-test autostart
TryExec=/usr/bin/lytguide-test
Icon=lytguide
StartupWMClass=com.lytguide.Warehouse
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;}
export async function waitForDesktopApp({readUrl,isPending,probe,launch,sleep,now=Date.now,timeoutMs=180000}){
  if(isPending())return {opened:false,reason:'Setup is not complete'};
  const url=readUrl();if(!url)return {opened:false,reason:'Not installed'};
  if(!/^http:\/\/localhost:\d+\/work$/.test(url))throw new Error('Invalid local shed address');
  const until=now()+timeoutMs;
  while(now()<until){
    if(isPending())return {opened:false,reason:'Setup is in progress'};
    try{await probe(url.replace('/work','/login'));await launch(url);return {opened:true};}catch{}
    await sleep(2000);
  }
  return {opened:false,reason:'Shed is not ready yet; open LytGuide from the menu later'};
}
