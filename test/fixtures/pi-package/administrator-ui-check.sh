#!/bin/sh
set -eu
[ "${LYTGUIDE_DISPOSABLE_CONTAINER:-}" = 1 ] || exit 1
clone=/tmp/lytguide-administrator-ui-runtime
cp -a /opt/lytguide-test/current/desktop "$clone"
printf 'require("/work/test/fixtures/desktop/administrator-ui.cjs.fixture");\n' > "$clone/resources/app/main.cjs"
/tmp/lytguide-display/lib/ld-linux-aarch64.so.1 --library-path /tmp/lytguide-display/lib /tmp/lytguide-display/bin/Xvfb :97 -screen 0 1280x1000x24 -nolisten tcp -ac >/tmp/lytguide-administrator-display.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT HUP INT TERM
n=0
while [ ! -S /tmp/.X11-unix/X97 ]; do n=$((n+1)); [ "$n" -lt 50 ] || { cat /tmp/lytguide-administrator-display.log; exit 1; }; sleep .1; done
setup_url=$(PKEXEC_UID=1000 /usr/lib/lytguide-test/setup-authorize)
runuser -u desktopqa -- dbus-run-session -- env DISPLAY=:97 LYTGUIDE_SETUP_TEST_URL="$setup_url" "$clone/lytguide-desktop"
