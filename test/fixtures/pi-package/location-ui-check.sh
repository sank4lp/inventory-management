#!/bin/sh
set -eu
[ "${LYTGUIDE_DISPOSABLE_CONTAINER:-}" = 1 ] || exit 1
/opt/lytguide-test/current/runtime/node --input-type=module <<'JS'
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {configureControllerModules} from '/work/src/services/inventory.js';
const db=new DatabaseSync('/var/lib/lytguide-test/data/inventory.db'),code=('UI-QA-'+randomUUID().slice(0,8)).toUpperCase();
configureControllerModules(db,{controllerCode:code,controllerAddress:code,moduleCount:4});
db.prepare("UPDATE controllers SET heartbeat_status='online',last_seen_at=? WHERE controller_code=?").run(new Date().toISOString(),code);
writeFileSync('/tmp/lytguide-ui-controller',code);db.close();
JS
clone=/tmp/lytguide-location-ui-runtime
rm -rf "$clone"
cp -a /opt/lytguide-test/current/desktop "$clone"
printf 'require("/work/test/fixtures/desktop/location-setup-ui.cjs.fixture");\n' > "$clone/resources/app/main.cjs"
/tmp/lytguide-display/lib/ld-linux-aarch64.so.1 --library-path /tmp/lytguide-display/lib /tmp/lytguide-display/bin/Xvfb :97 -screen 0 1280x1000x24 -nolisten tcp -ac > /tmp/lytguide-display.log 2>&1 &
display_pid=$!
trap 'kill "$display_pid" 2>/dev/null || true' EXIT HUP INT TERM
attempt=0
while [ ! -S /tmp/.X11-unix/X97 ]; do
 attempt=$((attempt+1)); [ "$attempt" -lt 50 ] || { cat /tmp/lytguide-display.log; exit 1; }; sleep .1
done
lytguide_test_setup_url=$(PKEXEC_UID=1000 /usr/lib/lytguide-test/setup-authorize)
runuser -u desktopqa -- dbus-run-session -- env DISPLAY=:97 LYTGUIDE_SETUP_TEST_URL="$lytguide_test_setup_url" LYTGUIDE_UI_CONTROLLER="$(cat /tmp/lytguide-ui-controller)" "$clone/lytguide-desktop"
