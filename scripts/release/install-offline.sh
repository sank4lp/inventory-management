#!/bin/sh
set -eu
export LC_ALL=C
[ "$(id -u)" = 0 ] || { echo 'Open Install LytGuide, or run this installer with sudo.' >&2; exit 1; }
log=/var/log/lytguide-offline-install.log
: > "$log"
message() { printf '%s\n' "$*" | tee -a "$log"; }
fail() { message "$*" >&2; exit 1; }
[ "$(dpkg --print-architecture)" = arm64 ] || fail 'This installer requires 64-bit Raspberry Pi OS (arm64).'
kit=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$kit"
suite=$(. /etc/os-release; printf '%s' "${VERSION_CODENAME:-unknown}")
os_id=$(. /etc/os-release; printf '%s' "${ID:-unknown}")
case "$os_id" in debian|raspbian) ;; *) fail "This build supports Raspberry Pi OS / Debian. Detected: $os_id.";; esac
case "$suite" in bookworm|trixie) ;; *) fail "This Pi runs $suite. This build supports Bookworm (Debian 12) and Trixie (Debian 13).";; esac
[ -f suites ] && grep -qx "$suite" suites || fail "This kit does not include $suite. Use the complete LytGuide Pi installer with matching OS components."
message "Detected $suite (arm64). Checking the offline installer files…"
if ! sha256sum -c SHA256SUMS >> "$log" 2>&1; then
 tail -n 14 "$log" >&2
 fail 'Installer files are missing or changed. Extract a fresh copy of the complete kit.'
fi
work=$(mktemp -d /var/tmp/lytguide-offline.XXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
chmod 0755 "$work"
mkdir -m 0755 "$work/repository" "$work/lists" "$work/lists/partial" "$work/archives" "$work/archives/partial"
cp "$kit"/packages/*.deb "$work/repository/"
cp "$kit/packages/$suite/"*.deb "$work/repository/"
cp "$kit/packages/$suite/Packages" "$work/repository/Packages"
printf 'deb [trusted=yes] file:%s/repository ./\n' "$work" > "$work/sources.list"
chmod 0644 "$work/sources.list" "$work/repository/"*
version=$(cat "$kit/version")
case "$version" in ''|*[!0-9A-Za-z.+~:-]*) echo 'Invalid package version.' >&2; exit 1;; esac
# Only the generated file:// source is visible to this APT invocation. Existing
# internet repositories, source lists and downloaded indexes are not changed.
apt_local() {
 apt-get -o "Dir::Etc::sourcelist=$work/sources.list" -o Dir::Etc::sourceparts=- \
  -o "Dir::State::lists=$work/lists" -o "Dir::Cache::archives=$work/archives" \
  -o Acquire::Languages=none -o Acquire::Retries=0 -o APT::Get::List-Cleanup=0 "$@"
}
message "Installing the included $suite components. Internet is not used…"
if ! apt_local update >> "$log" 2>&1; then
 tail -n 14 "$log" >&2
 fail "Could not read the offline components. Details: $log"
fi
set -- "lytguide-test=$version"
if ! DEBIAN_FRONTEND=noninteractive apt_local --no-remove --no-install-recommends -y install "$@" >> "$log" 2>&1; then
 tail -n 14 "$log" >&2
 fail "Installation could not finish. Details: $log"
fi
message 'LytGuide installed. Open Warehouse Setup from the Pi application menu.'
