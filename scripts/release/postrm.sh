#!/bin/sh
set -eu
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
case "${1:-}" in
  remove|purge)
    # Retained release folders are recovery material, not installed desktop
    # runtimes. Remove the privilege bit from their old sandbox helpers.
    if [ -f /opt/lytguide-test/.lytguide-test-installation ]; then
      find /opt/lytguide-test/releases -maxdepth 3 -type f -name chrome-sandbox -exec chmod a-s {} +
    fi
    echo "Test data, certificates, configuration and installed releases retained for recovery.";;
esac
