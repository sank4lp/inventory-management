#!/usr/bin/env python3
"""Actual installed setup API, synthetic controller and deferred QR; disposable CI only."""
import hashlib,json,os,pathlib,sqlite3,subprocess,time,urllib.request,urllib.error,uuid
if os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER')!='1':raise SystemExit('Disposable check only')
root=pathlib.Path('/var/lib/lytguide-test');base='http://127.0.0.1:3311';cookie=None

def call(path,body=None):
 headers={'Connection':'close',**({'Cookie':cookie} if cookie else {})}
 if body is not None:headers.update({'Content-Type':'application/json','Origin':base})
 try:
  with urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers),timeout=30) as response:return response.headers,json.load(response)
 except urllib.error.HTTPError as error:raise AssertionError(str(error.code)+' '+error.read().decode()) from error

def authorize():
 global cookie
 url=subprocess.check_output(['/usr/lib/lytguide-test/setup-authorize'],env={**os.environ,'PKEXEC_UID':'1000'},text=True).strip()
 headers,_=call('/setup-api/unlock',{'token':url.split('#')[1]});cookie=headers['Set-Cookie'].split(';')[0]

def state():return call('/setup-api/status')[1]
def action(name,**values):
 call('/setup-api/action',{'action':name,'revision':state()['state']['revision'],**values})
 for _ in range(900):
  current=state()
  if not current['job']['running']:
   if current['job']['error']:raise AssertionError(current['job']['error'])
   return current
  time.sleep(.1)
 raise AssertionError('Setup action did not finish')

def command(name,**values):return call('/api/location-setup/'+name,{'requestId':str(uuid.uuid4()),**values})[1]
def snapshot():return call('/api/location-setup/snapshot')[1]
def selected():return snapshot()['sessions'][0]
def records():
 db=sqlite3.connect(root/'data/inventory.db')
 try:return {table:db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall() for table in ['users','cells','location_labels','inventory_balances','products']}
 finally:db.close()

# Reinstall after default-No uninstall. Select found files and native-upload alternatives.
authorize();current=state();assert current['state']['step']=='choose' and not current['hasWarehouse']
original=pathlib.Path('/transfer/uninstall-backup-path').read_text();source=pathlib.Path(original);digest=hashlib.sha256(source.read_bytes()).hexdigest()
found=next(row for row in current['detectedBackups'] if row['name']==source.name)
action('skipDetectedBackup');assert state()['state']['backupPromptDismissed'];assert source.exists() and not state()['hasWarehouse']
authorize();assert not state()['state'].get('backupPromptDismissed')
action('choose',mode='replace',detectedBackupId=found['id']);action('system');address=state()['network']['addresses'][0]['address'];action('network',address=address,addressReserved=True)
assert state()['state']['step']=='backup' and state()['state']['backupFile']['name']==source.name
others=[row for row in state()['detectedBackups'] if row['id']!=found['id']]
if others:
 action('selectBackup',backupId=others[0]['id']);assert state()['state']['backupFile']['name']==others[0]['name']
# The browse control uploads bytes from any user-selected Pi file, without moving it.
request=urllib.request.Request(base+'/setup-api/backup-upload',data=source.read_bytes(),headers={'Connection':'close','Cookie':cookie,'Origin':base,'Content-Type':'application/octet-stream','X-Backup-Name':'manually-selected.lytbackup'})
with urllib.request.urlopen(request,timeout=60) as response:assert json.load(response)['state']['backupFile']['name']=='manually-selected.lytbackup'
action('selectBackup',backupId=found['id']);assert hashlib.sha256(source.read_bytes()).hexdigest()==digest
try:action('inspect',recoveryPassword='wrong-password')
except AssertionError as problem:assert 'password' in str(problem).lower()
else:raise AssertionError('Incorrect password was accepted')
secret='test-recovery-only-password-2026'
summary=action('inspect',recoveryPassword=secret);assert summary['state']['backupSummary']['protected'] and summary['state']['backupSummary']['certificateIdentity']
action('restore',recoveryPassword=secret,restoreConfirmed=True)
action('phones',piOnly=True);action('hardware',simulation=True,simulationConfirmed=True);action('finish')
assert state()['state']['completedAt'];assert hashlib.sha256(source.read_bytes()).hexdigest()==digest
print('PASS detected-backup No, Yes with automatic selection, choosing another detected copy, manual browse upload, wrong-password protection, restore and final setup',flush=True)
