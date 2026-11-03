#!/bin/sh
set -eu

service=inventory-management.service
url=http://127.0.0.1:3000/login

# An intentionally stopped service may be undergoing maintenance.
if ! systemctl is-active --quiet "$service"; then
  exit 0
fi

if curl --fail --silent --show-error --max-time 10 --output /dev/null "$url"; then
  exit 0
fi

# A controller probe or database operation can briefly delay the page.
sleep 15
if ! systemctl is-active --quiet "$service"; then
  exit 0
fi
if curl --fail --silent --show-error --max-time 10 --output /dev/null "$url"; then
  exit 0
fi

echo "Inventory app failed two local HTTP checks; restarting $service" >&2
systemctl restart "$service"
