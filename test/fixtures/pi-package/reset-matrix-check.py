#!/usr/bin/env python3
"""Run replacement choices against synthetic data in a disposable packaged Pi test.

Requires the package service doubles and /transfer protected-backup fixtures used
by wizard-check.py. Never run against a customer's installation.
"""
import json,os,pathlib,sqlite3,subprocess
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):raise SystemExit('Disposable test only')
root=pathlib.Path('/var/lib/lytguide-test')
# All operations below are scoped to synthetic warehouses in this disposable container.
source=(pathlib.Path('/transfer/warehouse.lytbackup').read_bytes())
identity=None
cases=[('restore',True),('clear-work',True),('clear-work',False),('fresh',True),('fresh',False)]
for index,(mode,hardware) in enumerate(cases):
 if index:
  subprocess.run(['systemctl','stop','lytguide-test-setup.service'],check=True)
  (root/'setup/state.json').unlink()
 args=['python3','/work/test/fixtures/pi-package/wizard-check.py','replace']
 if mode!='restore':args+=['--reset-mode='+mode]
 if not hardware:args+=['--clear-hardware']
 subprocess.run(args,check=True)
 db=sqlite3.connect(root/'data/inventory.db')
 site=db.execute("SELECT value FROM app_metadata WHERE key='warehouse_identity'").fetchone()[0]
 if index==0:identity=site
 elif hardware:assert site==identity,'Keeping cell QR setup must keep the original warehouse identity'
 else:assert site!=identity,'Clearing setup uses a fresh warehouse identity'
 assert not db.execute("SELECT value FROM app_metadata WHERE key='setup_reconnect_candidates'").fetchall()
 assert not db.execute('PRAGMA foreign_key_check').fetchall()
 db.close()
 assert pathlib.Path('/transfer/warehouse.lytbackup').read_bytes()==source,'Source recovery file changed'
 print('PASS packaged case '+mode+' hardware='+str(hardware),flush=True)
 # Verify authentication against the resulting account over authority-verified HTTPS.
 import http.cookiejar,ssl,urllib.request,urllib.parse
 config=json.loads(pathlib.Path('/etc/lytguide-test/config.json').read_text());origin='https://'+config['address']+':8443'
 jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/transfer/root.crt')))
 user='resetowner' if mode=='fresh' else 'recoveredowner';password='test-new-admin-password-2026' if mode=='fresh' else 'test-admin-only-password-2026'
 request=urllib.request.Request(origin+'/login',data=urllib.parse.urlencode({'username':user,'password':password}).encode(),headers={'Origin':origin})
 with opener.open(request) as response:assert urllib.parse.urlparse(response.url).path=='/work';response.read()
 if mode=='restore':
  subprocess.run(['python3','/work/test/fixtures/pi-package/login-check.py'],check=True)
  subprocess.run(['python3','/work/test/fixtures/pi-package/always-on-check.py'],check=True)
print('PASS all packaged restore/reset combinations, retained QR identity, source backup unchanged and verified sign-in',flush=True)
