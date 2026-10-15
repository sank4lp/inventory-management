#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Linux ]; then
  echo "Run this setup on the Raspberry Pi, not the development Mac." >&2
  exit 1
fi
if [ "$(id -u)" != 0 ]; then
  echo "Run with sudo on the Pi: sudo sh scripts/install-pi-lan.sh 192.168.1.140" >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "Supply the Pi's reserved IP: sudo sh scripts/install-pi-lan.sh 192.168.1.140 [HTTPS port] [app port]" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node is not available to sudo. Use the existing Node executable: sudo /path/to/node scripts/pi-lan.mjs install --address $1" >&2
  exit 1
fi

# Package installation is explicit; the script never changes package repositories,
# firewall rules, router settings, app environment, database or browser trust.
for required in /usr/bin/caddy curl openssl ss; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "Install prerequisites on the Pi first (internet needed once):" >&2
    echo "sudo apt-get update && sudo apt-get install caddy curl openssl iproute2" >&2
    echo "Then run this setup again. No setup changes were made." >&2
    exit 1
  fi
done

cd "$project_dir"
node scripts/pi-lan.mjs install --address "$1" --port "${2:-443}" --app-port "${3:-3000}"
node scripts/pi-lan.mjs certificate --address "$1" --port "${2:-443}" --app-port "${3:-3000}"
