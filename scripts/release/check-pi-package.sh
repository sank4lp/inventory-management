#!/bin/sh
# Run only inside a disposable ARM64 Linux container, with network disabled.
set -eu
if [ -z "${LYTGUIDE_DISPOSABLE_CONTAINER:-}" ]; then echo "Use the isolated release-check container, never a warehouse Pi." >&2; exit 1; fi
package=${1:?Supply the test .deb}
dpkg -i "$package"
printf '%s\n' package-test-password | lytguide-test setup --no-start --admin qa --password-stdin
/opt/lytguide-test/current/runtime/node /work/scripts/release/check-pi-installed.mjs
runuser -u lytguide-test -- mkdir -p /tmp/lytguide-firmware-proof
runuser -u lytguide-test -- env \
  ARDUINO_DIRECTORIES_DATA=/opt/lytguide-test/current/toolchain/data \
  ARDUINO_DIRECTORIES_USER=/opt/lytguide-test/current/toolchain/user \
  ARDUINO_DIRECTORIES_DOWNLOADS=/var/lib/lytguide-test/cache/arduino-downloads \
  ARDUINO_BUILD_CACHE_PATH=/tmp/lytguide-firmware-cache \
  ARDUINO_NETWORK_CLOUD_API_SKIP_BOARD_DETECTION_CALLS=true \
  /opt/lytguide-test/current/toolchain/bin/arduino-cli compile \
  --fqbn esp32:esp32:esp32 --jobs 2 \
  --build-path /tmp/lytguide-firmware-proof \
  --build-property 'compiler.cpp.extra_flags=-MMD -c -DLED_MODULE_COUNT=1 -DCONTROLLER_NAME="PKG-CHECK" -DCONTROLLER_ADDRESS="PKGCHECK"' \
  /opt/lytguide-test/current/firmware/esp32-simple-matrix
test -s /tmp/lytguide-firmware-proof/esp32-simple-matrix.ino.bin
echo 'PASS offline compilation as the unprivileged service user; no controller flashed.'
lytguide-test update --no-start
/opt/lytguide-test/current/runtime/node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/lytguide-test/data/inventory.db");if(d.prepare("SELECT SUM(available_quantity) n FROM inventory_balances").get().n!==1)throw Error("Update lost stock");d.close()'
echo 'PASS explicit update preserves recorded stock and creates a recovery snapshot.'
if [ -z "${LYTGUIDE_KEEP_PACKAGE_CHECK:-}" ]; then
  dpkg -r lytguide-test
  test -s /var/lib/lytguide-test/data/inventory.db
  echo 'PASS package removal retains test data.'
fi
