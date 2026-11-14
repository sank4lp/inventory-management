#!/usr/bin/env python3
"""Repeat real packaged setup without resetting the warehouse; disposable Pi only."""
import hashlib,json,os,pathlib,sqlite3,subprocess,time,urllib.request,urllib.error
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):raise SystemExit('Disposable check only')
root=pathlib.Path('/var/lib/lytguide-test');base='http://127.0.0.1:3311';cookie=None

def call(path,body=None,headers=None):
 h={'Connection':'close',**({'Cookie':cookie} if cookie else {}),**(headers or {})}
 if body is not None:h.update({'Content-Type':'application/json','Origin':base})
 try:
  with urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=h),timeout=30) as r:return r.headers,json.load(r)
 except urllib.error.HTTPError as error:
  error.detail=error.read().decode();raise

def authorize(resume=False):
 global cookie
 command=['/usr/lib/lytguide-test/setup-authorize']+(['--resume'] if resume else [])
 url=subprocess.check_output(command,env={**os.environ,'PKEXEC_UID':'1000'},text=True).strip()
 for _ in range(100):
  try:
   h,_=call('/setup-api/unlock',{'token':url.split('#')[1]});cookie=h['Set-Cookie'].split(';')[0];return
  except urllib.error.URLError as error:
   if isinstance(error,urllib.error.HTTPError):raise
   time.sleep(.1)
 raise AssertionError('Setup unavailable')

def state():return call('/setup-api/status')[1]
def action(name,**values):
 s=state();call('/setup-api/action',{'action':name,'revision':s['state']['revision'],**values})
 for _ in range(1200):
  s=state()
  if not s['job']['running']:
   if s['job']['error']:raise AssertionError(s['job']['error'])
   return s
  time.sleep(.1)
 raise AssertionError('Action timed out')

def snapshot():
 db=sqlite3.connect(root/'data/inventory.db')
 try:return {table:db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall() for table in ['users','products','cells','controllers','inventory_balances','tasks','location_labels']}
 finally:db.close()

# Add nonempty synthetic stock so preservation is checked against real records,
# not merely an empty newly created database.
db=sqlite3.connect(root/'data/inventory.db')
if not db.execute('SELECT 1 FROM products').fetchone():
 cell=db.execute('SELECT id FROM cells ORDER BY id LIMIT 1').fetchone()[0]
 product=db.execute("INSERT INTO products(sku,name,brand,unit_of_measure,items_per_cell,created_at) VALUES('REOPEN-QA','Setup preservation product','QA','pieces',10,datetime('now'))").lastrowid
 db.execute('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,4,0)',(product,cell));db.commit()
db.close()
before=snapshot();cert=(root/'caddy/pki/authorities/local/root.crt').read_bytes();key=(root/'caddy/pki/authorities/local/root.key').read_bytes();profile=pathlib.Path('/etc/lytguide-test/recovery-encryption.json').read_bytes()
completed=json.loads((root/'setup/state.json').read_text());assert completed['completedAt']
authorize();s=state();assert s['state']['step']=='choose' and not s['state']['done'] and s['state']['mode'] is None and not s['state']['completedAt'];assert s['state']['revision']>completed['revision'];assert not (root/'setup-pending').exists();assert snapshot()==before
print('PASS explicit desktop Setup launch restarts the entire checklist, preserving warehouse and trust',flush=True)
old_cookie=cookie;authorize()
try:call('/setup-api/status',headers={'Cookie':old_cookie})
except urllib.error.HTTPError as error:assert error.code==401
else:raise AssertionError('Previous setup session remains authorised')
for name in ['.setup-lock','restore-in-progress.json']:
 marker=root/name;marker.write_text('qa-reopen-guard')
 revision=state()['state']['revision']
 try:
  try:authorize()
  except urllib.error.HTTPError as error:assert 'maintenance' in error.detail
  else:raise AssertionError('Restart allowed during maintenance')
  assert state()['state']['revision']==revision
 finally:marker.unlink()
db=sqlite3.connect(root/'data/inventory.db');db.execute("INSERT OR REPLACE INTO app_metadata(key,value,updated_at) VALUES('firmware_busy','qa-reopen',datetime('now'))");db.commit();db.close()
try:
 try:authorize()
 except urllib.error.HTTPError as error:assert 'firmware' in error.detail
 else:raise AssertionError('Restart allowed during firmware update')
finally:
 db=sqlite3.connect(root/'data/inventory.db');db.execute("DELETE FROM app_metadata WHERE key='firmware_busy'");db.commit();db.close()
try:action('choose',mode='configure')
except AssertionError as error:assert 'stopped work' in str(error)
else:raise AssertionError('Existing setup accepted without stopping consent')
action('choose',mode='configure',pauseExisting=True);s=action('system');address=s['network']['addresses'][0]['address'];action('network',address=address,addressReserved=True)
revision=state()['state']['revision'];authorize(resume=True);assert state()['state']['revision']==revision and state()['state']['step']=='account'
assert call('/setup-api/refresh')[1]['state']['revision']==revision
print('PASS browser refresh/internal resume preserve the current step; explicit reopen starts again',flush=True)
s=state();existing=s['existingWarehouse'];assert existing['username']
action('account',warehouseName=existing['warehouseName'],username=existing['username']);action('phones',piOnly=True);action('hardware',simulation=True,simulationConfirmed=True);action('locations');action('finish')
assert snapshot()==before,'Repeating setup changed warehouse records';assert (root/'caddy/pki/authorities/local/root.crt').read_bytes()==cert;assert (root/'caddy/pki/authorities/local/root.key').read_bytes()==key;assert not (root/'setup-pending').exists();assert pathlib.Path('/etc/lytguide-test/recovery-encryption.json').read_bytes()==profile
assert 'Icon=lytguide' in pathlib.Path('/usr/share/applications/com.lytguide.Warehouse.desktop').read_text();assert 'Name=LytGuide\n' in pathlib.Path('/usr/share/applications/com.lytguide.Warehouse.desktop').read_text();assert pathlib.Path('/usr/share/icons/hicolor/scalable/apps/lytguide.svg').exists()
print('PASS all existing-warehouse steps repeated, data/accounts/QR/certificate preserved, no firmware upload; branded launcher installed',flush=True)
