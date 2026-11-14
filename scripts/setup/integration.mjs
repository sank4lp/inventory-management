import {INSTALL_ROOT,STATE_ROOT} from '../release/pi-package.mjs';
export function setupServiceUnit(){return `[Unit]
Description=LytGuide warehouse setup
After=NetworkManager.service local-fs.target
Wants=NetworkManager.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_ROOT}/candidate
ExecStart=${INSTALL_ROOT}/candidate/runtime/node ${INSTALL_ROOT}/candidate/app/wizard-server.cjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
RuntimeDirectory=lytguide-test-setup
RuntimeDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
ProtectHome=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${STATE_ROOT} /etc/lytguide-test ${INSTALL_ROOT} /run/lytguide-test-setup -/boot/firmware/LYTGUIDE-RECOVERY -/boot/LYTGUIDE-RECOVERY /etc/NetworkManager/system-connections
`;}
export function setupPolkitPolicy(){return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN" "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig><vendor>LytGuide</vendor><action id="com.lytguide.setup">
<description>Set up the local LytGuide shed</description><message>Administrator authorisation is required to set up LytGuide on this Raspberry Pi.</message>
<defaults><allow_any>no</allow_any><allow_inactive>no</allow_inactive><allow_active>auth_admin_keep</allow_active></defaults>
<annotate key="org.freedesktop.policykit.exec.path">/usr/lib/lytguide-test/setup-authorize</annotate>
</action></policyconfig>\n`;}
