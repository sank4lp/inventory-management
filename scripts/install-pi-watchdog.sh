#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
service=inventory-management.service

if ! command -v systemctl >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "This installer needs systemd and curl on the Raspberry Pi." >&2
  exit 1
fi
if ! systemctl cat "$service" >/dev/null 2>&1; then
  echo "The existing $service was not found. No changes were made." >&2
  exit 1
fi

sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 "$project_dir/scripts/pi-healthcheck.sh" /usr/local/libexec/inventory-management-healthcheck
sudo install -m 0644 "$project_dir/deploy/systemd/inventory-management-healthcheck.service" /etc/systemd/system/inventory-management-healthcheck.service
sudo install -m 0644 "$project_dir/deploy/systemd/inventory-management-healthcheck.timer" /etc/systemd/system/inventory-management-healthcheck.timer
sudo systemctl daemon-reload
sudo systemctl enable --now inventory-management-healthcheck.timer

echo "Watchdog installed. The running app was not restarted."
systemctl status inventory-management-healthcheck.timer --no-pager --lines=0
