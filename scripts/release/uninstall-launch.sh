#!/bin/sh
set -eu
case "${1:-}" in ''|--terminal) ;; *) echo 'Run Uninstall LytGuide without extra options.' >&2; exit 1;; esac
kit=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -t 0 ] && [ "${1:-}" != --terminal ]; then
 exec x-terminal-emulator -T 'Uninstall LytGuide' -e /bin/sh "$kit/$(basename -- "$0")" --terminal
fi
result=0
if [ ! -f /opt/lytguide-test/.lytguide-test-installation ]; then
 echo 'LytGuide is not installed. Existing backups were kept.'
else
 runtime=/opt/lytguide-test/current/runtime/node
 [ -x "$runtime" ] || runtime=/opt/lytguide-test/candidate/runtime/node
 if [ -f "$kit/uninstall.cjs" ] && [ -f "$kit/portable-backup.py" ]; then
  program="$kit/uninstall.cjs"
  if [ -f "$kit/SHA256SUMS" ]; then
   (cd "$kit"; awk '$2 == "uninstall.cjs" || $2 == "portable-backup.py"' SHA256SUMS | sha256sum -c -) || exit 1
  fi
 else
  program=/opt/lytguide-test/candidate/app/uninstall.cjs
 fi
 if [ ! -x "$runtime" ] || [ ! -f "$program" ]; then
  echo 'Use Uninstall LytGuide.run from the latest complete kit. The installed runtime is missing; repair the installation first if needed.' >&2
  exit 1
 fi
 if [ "$(id -u)" = 0 ]; then "$runtime" "$program" || result=$?; else sudo "$runtime" "$program" || result=$?; fi
fi
if [ "${1:-}" = --terminal ]; then printf '\nPress Enter to close. '; read answer || true; fi
exit "$result"
