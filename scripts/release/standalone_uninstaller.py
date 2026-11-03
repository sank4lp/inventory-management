"""Build one portable executable shell script from version-matched uninstall assets."""
import base64,gzip,hashlib,json,pathlib

HEADER='''#!/bin/sh
set -eu
case "${1:-}" in ''|--terminal) ;; *) echo 'Run Uninstall LytGuide without extra options.' >&2; exit 1;; esac
if [ ! -t 0 ] && [ "${1:-}" != --terminal ]; then
 script=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
 exec x-terminal-emulator -T 'Uninstall LytGuide' -e /bin/sh "$script" --terminal
fi
work=$(mktemp -d /tmp/lytguide-uninstall.XXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
python3 - "$0" "$work" <<'LYTGUIDE_UNPACK'
import base64,gzip,hashlib,json,pathlib,sys
source=pathlib.Path(sys.argv[1]).read_bytes().split(b'\\n__LYTGUIDE_UNINSTALL_PAYLOAD__\\n',1)[1]
files=json.loads(gzip.decompress(base64.b64decode(source,validate=False)))
expected={'uninstall.cjs','portable-backup.py','Uninstall LytGuide.run','SHA256SUMS'}
if set(files)!=expected:raise SystemExit('Invalid LytGuide uninstaller. Download a fresh copy.')
for name,item in files.items():
 data=base64.b64decode(item['data'],validate=True)
 if hashlib.sha256(data).hexdigest()!=item['sha256']:raise SystemExit('Damaged uninstaller. Download a fresh copy.')
 path=pathlib.Path(sys.argv[2],name);path.write_bytes(data);path.chmod(0o700 if name.endswith('.run') else 0o600)
LYTGUIDE_UNPACK
result=0
/bin/sh "$work/Uninstall LytGuide.run" "$@" || result=$?
exit "$result"
__LYTGUIDE_UNINSTALL_PAYLOAD__
'''

def generate(program,helper,launcher,output):
 raw={'uninstall.cjs':pathlib.Path(program).read_bytes(),'portable-backup.py':pathlib.Path(helper).read_bytes(),'Uninstall LytGuide.run':pathlib.Path(launcher).read_bytes()}
 raw['SHA256SUMS']=''.join(hashlib.sha256(raw[name]).hexdigest()+'  '+name+'\n' for name in ['uninstall.cjs','portable-backup.py']).encode()
 files={name:{'data':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest()} for name,data in raw.items()}
 payload=base64.b64encode(gzip.compress(json.dumps(files,separators=(',',':')).encode(),mtime=0)).decode()
 target=pathlib.Path(output);target.write_text(HEADER+payload+'\n');target.chmod(0o755)
