#!/bin/sh
set -eu
case "${1:-}" in
  remove|deconfigure)
    if [ -d /run/systemd/system ]; then
      systemctl stop lytguide-test-watchdog.timer lytguide-test-watchdog.service lytguide-test-setup.service lytguide-test-backup.timer lytguide-test-backup.service lytguide-test-web.service lytguide-test.service || true
      systemctl disable lytguide-test-watchdog.timer lytguide-test-backup.timer lytguide-test-web.service lytguide-test.service || true
    fi
    ;;
esac
