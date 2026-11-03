#!/usr/bin/env python3
"""Remove the exact native package without losing warehouse recovery data; CI only."""
import hashlib,os,pathlib,sqlite3,subprocess
if os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER')!='1':raise SystemExit('Disposable check only')
root=pathlib.Path('/var/lib/lytguide-test')
def records():
 db=sqlite3.connect(root/'data/inventory.db')
 try:return list(db.iterdump())
 finally:db.close()
protected=[pathlib.Path('/etc/lytguide-test/config.json'),root/'caddy/pki/authorities/local/root.crt',root/'caddy/pki/authorities/local/root.key',pathlib.Path('/etc/lytguide-test/recovery-encryption.json')]
before=records();digests={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
subprocess.run(['dpkg','--remove','lytguide-test'],check=True)
assert records()==before
for path,digest in digests.items():assert hashlib.sha256(path.read_bytes()).hexdigest()==digest,path
assert not pathlib.Path('/usr/bin/lytguide-test').exists()
assert not pathlib.Path('/usr/share/applications/com.lytguide.Warehouse.desktop').exists()
helpers=list(pathlib.Path('/opt/lytguide-test/releases').glob('*/desktop/chrome-sandbox'));assert helpers
for path in helpers:assert path.stat().st_mode&0o6000==0,path
print('PASS package removal: warehouse, accounts, certificate and recovery keys retained; launchers removed and retained sandbox helpers have no privilege bits')
