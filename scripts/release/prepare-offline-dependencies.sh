#!/bin/sh
# Build-time downloads only, inside the isolated matching ARM64 OS environment.
set -eu
[ "$(dpkg --print-architecture)" = arm64 ] || { echo 'ARM64 build environment required.' >&2; exit 1; }
suite=$(. /etc/os-release; printf '%s' "$VERSION_CODENAME")
case "$suite" in bookworm|trixie) ;; *) echo 'A matching Bookworm or Trixie build environment is required.' >&2; exit 1;; esac
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
destination="$project_dir/output/release-cache/offline-electron-$suite-arm64"
mkdir -p "$destination/partial"
apt-get update -qq
case "$suite" in trixie) audio=libasound2t64;; *) audio=libasound2;; esac
status_file=$(mktemp)
trap 'rm -f "$status_file"' EXIT HUP INT TERM
# Resolve against an EMPTY installed-package status: dependencies already in
# this build container must not disappear from the offline kit.
DEBIAN_FRONTEND=noninteractive apt-get \
 -o "Dir::State::status=$status_file" -o "Dir::Cache::archives=$destination" \
 --download-only --no-install-recommends -y install \
 libc6 libstdc++6 libusb-1.0-0 python3 python3-serial systemd passwd util-linux coreutils tar \
 pkexec polkitd network-manager dbus-user-session \
 libgtk-3-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 "$audio" libx11-6 libxcb1 libxext6
rm -f "$destination/lock"
rmdir "$destination/partial" 2>/dev/null || true
cd "$destination"
dpkg-scanpackages . /dev/null > Packages
python3 - "$suite" <<'PY'
import hashlib,json,pathlib,subprocess,sys
files=[]
for path in sorted(pathlib.Path('.').glob('*.deb')):
 architecture=subprocess.check_output(['dpkg-deb','-f',str(path),'Architecture'],text=True).strip()
 if architecture not in ('arm64','all'):raise SystemExit('Wrong architecture: '+str(path))
 files.append({'filename':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size})
pathlib.Path('dependencies.json').write_text(json.dumps({'suite':sys.argv[1],'architecture':'arm64','files':files},indent=2)+'\n')
print(str(len(files))+' checked offline dependencies prepared.')
PY
