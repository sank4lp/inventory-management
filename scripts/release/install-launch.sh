#!/bin/sh
set -eu
kit=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(id -u)" = 0 ]; then echo 'Open this installer as the normal Pi desktop user.' >&2; exit 1; fi
exec x-terminal-emulator -T 'LytGuide installation' -e /bin/sh -c '
 if sudo /bin/sh "$1/install.sh"; then
  /usr/bin/lytguide-test wizard
 else
  printf "\nInstallation did not finish. See the error above.\nDetails: /var/log/lytguide-offline-install.log\nPress Enter to close."
  read answer
 fi
' lytguide-install "$kit"
