import {join} from 'node:path';

// The packaged LytGuide executable owns its windows. No installed browser or
// browser app-mode flags participate in app, Setup or automatic startup.
export function desktopWindowArgs({setup=false,resume=false}={}){
  if(resume&&!setup)throw new Error('Only Setup can resume its saved step.');
  return [setup?(resume?'--lytguide-resume':'--lytguide-setup'):'--lytguide-work'];
}
export function desktopEnvironment(environment){const clean={...environment};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','CHROME_DEVEL_SANDBOX'])delete clean[key];return clean;}
export function desktopExecutable(root){return join(root,'desktop/lytguide-desktop');}
export function desktopEntry({setup=false}={}){return `[Desktop Entry]
Type=Application
Name=${setup?'LytGuide Warehouse Setup':'LytGuide'}
Comment=${setup?'Set up the warehouse from the beginning':'Open the local warehouse application'}
Exec=/usr/bin/lytguide-test ${setup?'wizard':'open'}
TryExec=/usr/bin/lytguide-test
Icon=lytguide
StartupWMClass=com.lytguide.Warehouse
Terminal=false
Categories=Office;${setup?'Settings;':''}
`;}
