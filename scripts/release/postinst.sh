#!/bin/sh
set -eu
[ "$1" = configure ] || exit 0
if [ "$(uname -m)" != aarch64 ]; then echo "This package needs 64-bit Raspberry Pi OS (arm64)." >&2; exit 1; fi
case "$(. /etc/os-release; printf '%s' "$ID")" in
  debian|raspbian) ;;
  *) echo 'This build requires Raspberry Pi OS / Debian.' >&2; exit 1;;
esac
case "$(. /etc/os-release; printf '%s' "$VERSION_CODENAME")" in
  bookworm|trixie) ;;
  *) echo 'This build supports Raspberry Pi OS Bookworm (Debian 12) and Trixie (Debian 13).' >&2; exit 1;;
esac
root=/opt/lytguide-test
state=/var/lib/lytguide-test
config=/etc/lytguide-test
version=$(cat /usr/lib/lytguide-test/release-id)
case "$version" in ''|*[!0-9A-Za-z.+~:-]*|*..*) echo "Invalid release version" >&2; exit 1;; esac
for path in "$root" "$state" "$config" "$state/data" "$state/caddy" "$state/recovery"; do
  if [ -L "$path" ]; then echo "Refusing an unexpected symlink at $path." >&2; exit 1; fi
done
if [ -d "$root" ] && [ ! -f "$root/.lytguide-test-installation" ] && [ -n "$(ls -A "$root")" ]; then
  echo "Refusing to replace an unmanaged /opt/lytguide-test directory." >&2; exit 1
fi
getent group dialout >/dev/null || groupadd --system dialout
for name in lytguide-test lytguide-test-web; do
  if ! getent passwd "$name" >/dev/null; then useradd --system --user-group --no-create-home --home-dir "$state" --shell /usr/sbin/nologin "$name"; fi
  if [ "$(id -u "$name")" -ge 1000 ]; then echo "A desktop account already uses $name; refusing to change it." >&2; exit 1; fi
done
usermod -a -G dialout lytguide-test
install -d -m 0755 "$root" "$root/releases" "$state" "$config"
touch "$root/.lytguide-test-installation"
install -d -o lytguide-test -g lytguide-test -m 0700 "$state/data" "$state/cache"
if [ ! -f "$state/cache/arduino-inventory.yaml" ]; then
  install -o lytguide-test -g lytguide-test -m 0600 /dev/null "$state/cache/arduino-inventory.yaml"
fi
install -d -o lytguide-test-web -g lytguide-test-web -m 0700 "$state/caddy"
install -d -o root -g root -m 0700 "$state/recovery"
release="$root/releases/$version"
staged="$root/releases/.incoming-$$"
trap 'rm -rf "$staged"' EXIT HUP INT TERM
if [ ! -d "$release" ]; then
  required=$(cat /usr/lib/lytguide-test/unpacked-bytes)
  free_kb=$(df -Pk "$root" | awk 'NR==2 {print $4}')
  if [ "$free_kb" -lt "$((required / 1024 + 524288))" ]; then echo "Not enough free space to extract the offline tools. Free disk space before retrying." >&2; exit 1; fi
  mkdir -m 0755 "$staged"
  tar -xzf /usr/lib/lytguide-test/release.tar.gz --no-same-owner -C "$staged"
  ln -s "$state/data" "$staged/data"
  "$staged/runtime/node" "$staged/app/verify.cjs" "$staged"
  # Arduino's inventory is mutable metadata, not a compiler or customer database.
  ln -s "$state/cache/arduino-inventory.yaml" "$staged/toolchain/data/inventory.yaml"
  mv "$staged" "$release"
else
  expected=$(cat /usr/lib/lytguide-test/release-manifest.sha256)
  actual=$(sha256sum "$release/release.json" | cut -d ' ' -f 1)
  if [ "$actual" != "$expected" ]; then echo "This version already identifies a different release. Build with a new --version; the active release was not replaced." >&2; exit 1; fi
  "$release/runtime/node" "$release/app/verify.cjs" "$release"
fi
# Extraction deliberately avoids inheriting ownership/privilege metadata. After
# every file has passed the release hash check, install Electron's supported
# root-owned sandbox helper with the exact required permissions.
sandbox="$release/desktop/chrome-sandbox"
if [ ! -f "$sandbox" ] || [ -L "$sandbox" ]; then
  echo "The LytGuide desktop sandbox is missing or invalid. Reinstall the complete kit." >&2
  exit 1
fi
chown root:root "$sandbox"
chmod 4755 "$sandbox"
# Activation is explicit. Existing test services keep their current release.
ln -s "$release" "$root/.candidate-$$"
mv -Tf "$root/.candidate-$$" "$root/candidate"
if [ ! -e "$root/current" ]; then ln -s "$release" "$root/current"; fi
if [ -d /run/systemd/system ]; then systemctl daemon-reload; fi
echo "LytGuide installed. Open LytGuide Warehouse Setup from the Pi application menu."
echo "For an existing test installation, run: sudo lytguide-test update"
echo "Your existing inventory-management service and warehouse data were not changed."
