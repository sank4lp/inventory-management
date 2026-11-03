#!/bin/sh
# Disposable-container-only Linux mount checks. Never run on a warehouse Pi.
set -eu
[ "${LYTGUIDE_DISPOSABLE_CONTAINER:-}" = 1 ] || exit 1
[ "$(id -u)" = 0 ] || exit 1
case "${1:-}" in
 boot-before)
  test ! -e /boot/firmware/LYTGUIDE-RECOVERY
  unshare --mount /bin/sh -eu -c '
   mount --bind /boot/firmware /boot/firmware
   mount -o remount,bind,ro /boot/firmware
   python3 - <<PY
import errno,pathlib
try:pathlib.Path("/boot/firmware/LYTGUIDE-RECOVERY").mkdir()
except OSError as error:assert error.errno==errno.EROFS
else:raise AssertionError("Expected read-only boot protection")
print("PASS reproduced first-boot failure before the writable exception exists")
PY
  '
  ;;
 boot-after)
  test -d /boot/firmware/LYTGUIDE-RECOVERY
  unshare --mount /bin/sh -eu -c '
   mount --bind /boot/firmware /boot/firmware
   mount --bind /boot/firmware/LYTGUIDE-RECOVERY /boot/firmware/LYTGUIDE-RECOVERY
   mount -o remount,bind,ro /boot/firmware
   python3 - <<PY
import errno,os,pathlib
p=pathlib.Path("/boot/firmware/LYTGUIDE-RECOVERY/.permission-check")
p.write_text("owned backup folder writable");p.unlink()
try:pathlib.Path("/boot/firmware/unrelated-boot-file").write_text("not allowed")
except OSError as error:assert error.errno==errno.EROFS
else:raise AssertionError("Other boot files must stay protected")
print("PASS prepared recovery folder writable; surrounding boot partition remains read-only")
PY
  '
  ;;
 compile)
  unshare --mount /bin/sh -eu -c '
   mount --bind /tmp /tmp
   mount -o remount,bind,ro /tmp
   if runuser -u lytguide-test -- /opt/lytguide-test/current/runtime/node -e '\''require("node:fs").mkdtempSync("/tmp/blocked-build-")'\'' 2>/dev/null; then
    echo "Expected compiler temporary-folder restriction" >&2; exit 1
   fi
   mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
   mount --bind /opt/lytguide-test /opt/lytguide-test
   mount -o remount,bind,ro /opt/lytguide-test
   runuser -u lytguide-test -- env \
    HOME=/var/lib/lytguide-test XDG_CACHE_HOME=/var/lib/lytguide-test/cache \
    ARDUINO_DIRECTORIES_DATA=/opt/lytguide-test/current/toolchain/data \
    ARDUINO_DIRECTORIES_USER=/opt/lytguide-test/current/toolchain/user \
    ARDUINO_DIRECTORIES_DOWNLOADS=/var/lib/lytguide-test/cache/arduino-downloads \
    ARDUINO_BUILD_CACHE_PATH=/tmp/firmware-cache \
    ARDUINO_NETWORK_CLOUD_API_SKIP_BOARD_DETECTION_CALLS=true \
    /opt/lytguide-test/current/toolchain/bin/arduino-cli compile \
    --fqbn esp32:esp32:esp32 --jobs 2 --build-path /tmp/firmware-proof \
    --build-property '\''compiler.cpp.extra_flags=-MMD -c -DLED_MODULE_COUNT=1 -DCONTROLLER_NAME="PKG-CHECK" -DCONTROLLER_ADDRESS="PKGCHECK"'\'' \
    /opt/lytguide-test/current/firmware/esp32-simple-matrix
   test -s /tmp/firmware-proof/esp32-simple-matrix.ino.bin
   echo "PASS offline ESP32 compilation with read-only installed tools and a private writable temporary filesystem"
  '
  ;;
 *) exit 1;;
esac
