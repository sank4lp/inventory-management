#!/bin/sh
# Release preparation in an ARM64 Linux build container, never at app startup.
set -eu
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != aarch64 ]; then
  echo "Prepare this toolchain in Linux ARM64 (the Mac release command uses Docker)." >&2
  exit 1
fi
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
bundle="$project_dir/output/release-cache/firmware-linux-arm64"
mkdir -p "$bundle/bin" "$bundle/data" "$bundle/user"
archive="$project_dir/output/release-cache/arduino-cli_1.3.1_Linux_ARM64.tar.gz"
if [ ! -f "$archive" ]; then
  curl -fL --retry 3 --max-time 180 -o "$archive.new" https://github.com/arduino/arduino-cli/releases/download/v1.3.1/arduino-cli_1.3.1_Linux_ARM64.tar.gz
  mv "$archive.new" "$archive"
fi
printf '%s  %s\n' cf4f668b1add7a20310d79e83a1f3eb148031f95e5673d9171c65f5e9a126a94 "$archive" | sha256sum -c -
tar -xzf "$archive" -C "$bundle/bin" arduino-cli LICENSE.txt
export ARDUINO_DIRECTORIES_DATA="$bundle/data"
export ARDUINO_DIRECTORIES_USER="$bundle/user"
export ARDUINO_UPDATER_ENABLE_NOTIFICATION=false
index=https://espressif.github.io/arduino-esp32/package_esp32_index.json
"$bundle/bin/arduino-cli" core update-index --additional-urls "$index"
"$bundle/bin/arduino-cli" core install esp32:esp32@3.0.7 --additional-urls "$index"
"$bundle/bin/arduino-cli" lib install 'Adafruit NeoPixel@1.12.4'
node_bin="$project_dir/output/release-cache/node-v24.22.1-linux-arm64/bin/node"
node_archive="$project_dir/output/release-cache/node-v24.22.1-linux-arm64.tar.xz"
if [ ! -f "$node_archive" ]; then
  curl -fL --retry 3 --max-time 180 -o "$node_archive.new" https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.xz
  mv "$node_archive.new" "$node_archive"
fi
printf '%s  %s\n' dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e "$node_archive" | sha256sum -c -
if [ ! -x "$node_bin" ]; then
  tar -xJf "$node_archive" -C "$project_dir/output/release-cache" node-v24.22.1-linux-arm64/bin/node node-v24.22.1-linux-arm64/LICENSE
fi
"$node_bin" "$project_dir/scripts/prepare-firmware-bundle.mjs" "$bundle" linux arm64
echo "Offline ARM64 firmware toolchain is ready."
