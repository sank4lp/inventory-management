#!/bin/sh
# Real bundled runtime, isolated display tool and synthetic camera; disposable CI only.
set -eu
[ "${LYTGUIDE_DISPOSABLE_CONTAINER:-}" = 1 ] || exit 1
root=/opt/lytguide-test/current/desktop
clone=/tmp/lytguide-native-runtime-check
systemctl stop lytguide-test-setup.service
rm -rf "$clone"
cp -a "$root" "$clone"
test "$(stat -c %a "$clone/chrome-sandbox")" = 4755
if command -v Xvfb >/dev/null 2>&1; then
 Xvfb :97 -screen 0 1280x900x24 -nolisten tcp -ac > /tmp/lytguide-display.log 2>&1 &
else
 /tmp/lytguide-display/lib/ld-linux-aarch64.so.1 --library-path /tmp/lytguide-display/lib /tmp/lytguide-display/bin/Xvfb :97 -screen 0 1280x900x24 -nolisten tcp -ac > /tmp/lytguide-display.log 2>&1 &
fi
display_pid=$!
trap 'kill "$display_pid" 2>/dev/null || true' EXIT HUP INT TERM
attempt=0
while [ ! -S /tmp/.X11-unix/X97 ]; do
 attempt=$((attempt+1)); [ "$attempt" -lt 50 ] || { cat /tmp/lytguide-display.log; exit 1; }; sleep .1
done
id desktopqa >/dev/null 2>&1 || useradd --create-home --shell /bin/sh desktopqa
for fixture in native-check full-start production-ui; do
 printf 'require("/work/test/fixtures/desktop/%s.cjs.fixture");\n' "$fixture" > "$clone/resources/app/main.cjs"
 runuser -u desktopqa -- dbus-run-session -- env DISPLAY=:97 LYTGUIDE_DESKTOP_TEST_ROOT="$clone" LYTGUIDE_DESKTOP_PRODUCTION="$root/resources/app/main.cjs" "$clone/lytguide-desktop"
done
python3 - <<'PY'
import urllib.request
with urllib.request.urlopen('http://localhost:3310/login') as response:assert response.status==200
print('PASS closing the native application preserves the actual installed warehouse service')
PY
/opt/lytguide-test/current/runtime/node /opt/lytguide-test/current/app/verify.cjs /opt/lytguide-test/current
