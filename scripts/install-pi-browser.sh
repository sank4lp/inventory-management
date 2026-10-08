#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
launcher="$project_dir/deploy/desktop/inventory-management-browser.desktop"

if [ "$(id -un)" != admin ] || [ "$HOME" != /home/admin ]; then
  echo "Run this installer as the Pi desktop user admin, without sudo." >&2
  exit 1
fi
if [ ! -x /usr/bin/chromium ]; then
  echo "Chromium was not found at /usr/bin/chromium. No changes were made." >&2
  exit 1
fi

install -d -m 0755 "$HOME/.local/share/applications" "$HOME/.config/autostart"
install -m 0644 "$launcher" "$HOME/.local/share/applications/inventory-management-browser.desktop"
install -m 0644 "$launcher" "$HOME/.config/autostart/inventory-management-browser.desktop"

echo "Inventory browser launcher installed for admin. It will open after the next desktop login."
echo "The running browser and inventory service were not restarted."
