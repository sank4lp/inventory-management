#!/usr/bin/env python3
"""Exercise the real packaged setup API in disposable ARM64 containers."""
import hashlib,http.client,json,os,pathlib,re,subprocess,sys,time,urllib.request,urllib.error,ssl
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):sys.exit('Disposable check only')
reset_mode=next((a.split('=',1)[1] for a in sys.argv if a.startswith('--reset-mode=')),'restore');keep_hardware='--clear-hardware' not in sys.argv
mode=sys.argv[1];root=pathlib.Path('/var/lib/lytguide-test');runtime='/opt/lytguide-test/candidate/runtime/node'
secret='test-recovery-only-password-2026';adminpass='test-admin-only-password-2026'
base='http://127.0.0.1:3311';cookie=None

def call(path,body=None,raw=None,headers=None):
 h={'Connection':'close'}
 if cookie:h['Cookie']=cookie
 if body is not None:h.update({'Content-Type':'application/json','Origin':base});raw=json.dumps(body).encode()
 if raw is not None:h['Origin']=base
 h.update(headers or {})
 request=urllib.request.Request(base+path,data=raw,headers=h)
 try:
  with urllib.request.urlopen(request,timeout=30) as response:return response.headers,response.read()
 except urllib.error.HTTPError as error:
  error.detail=error.read().decode();print('HTTP failure '+path+': '+error.detail,flush=True);raise

def authorize(resume=False):
 global cookie
 grant=subprocess.check_output(['/usr/lib/lytguide-test/setup-authorize']+(['--resume'] if resume else []),env={**os.environ,'PKEXEC_UID':'1000'},text=True).strip()
 token=grant.split('#')[1]
 assert pathlib.Path('/boot/firmware/LYTGUIDE-RECOVERY').is_dir(),'First-run authorization must prepare recovery storage before the service starts'
 for i in range(100):
  try:
   headers,result=call('/setup-api/unlock',{'token':token});cookie=headers['Set-Cookie'].split(';')[0];return
  except urllib.error.URLError:time.sleep(.1)
 raise AssertionError('Setup did not start')
authorize()

def status():return json.loads(call('/setup-api/status')[1])
def action(name,**kw):
 s=status();call('/setup-api/action',{'action':name,'revision':s['state']['revision'],**kw})
 for i in range(1200):
  s=status()
  assert all(secret_value not in json.dumps(s) for secret_value in [secret,adminpass,'test-new-admin-password-2026']),'secret leaked in status'
  if not s['job']['running']:
   if s['job']['error']:raise AssertionError(name+': '+s['job']['error'])
   print(name+' -> '+s['state']['step'],flush=True);return s
  time.sleep(.2)
 raise AssertionError(name+' timed out')

if status()['state']['step']=='choose':
 if mode=='new':
  assert not (root/'data/inventory.db').exists(),'Installer shipped an existing warehouse database'
  assert not pathlib.Path('/etc/lytguide-test/config.json').exists()
  assert not (root/'caddy/pki/authorities/local/root.key').exists()
  files=json.loads(pathlib.Path('/opt/lytguide-test/current/release.json').read_text())['files']
  assert not any(f['path'].endswith(('.lytbackup','/inventory.db','/inventory.sqlite')) or f['path'].startswith(('data/','recovery/','pki/')) for f in files),'Installer contains warehouse recovery data'
  print('PASS installer is fresh: no warehouse data, backup, administrator or certificate identity',flush=True)
 action('choose',mode=mode,pauseExisting=True)
s=json.loads(call('/setup-api/refresh')[1]);assert all(row['ok'] for row in s['facts']['checks']),s['facts']
if status()['state']['step']=='system':action('system')
address=s['network']['addresses'][0]['address']
if status()['state']['step']=='network':action('network',address=address,addressReserved=True)
if mode=='new':
 if '--retry-account' in sys.argv and status()['state']['step']=='account':
  pathlib.Path('/tmp/lytguide-service-check/fail-next-app-start').touch()
  try:action('account',warehouseName='Offline QA Warehouse',username='qaowner',adminPassword=adminpass,adminConfirm=adminpass,recoveryPassword=secret,recoveryConfirm=secret,recoverySaved=True)
  except AssertionError as problem:assert 'Deliberate' in str(problem),str(problem)
  else:raise AssertionError('Expected initial app-start failure')
  assert status()['state']['username']=='qaowner'
  subprocess.run(['systemctl','restart','lytguide-test-setup.service'],check=True);authorize(resume=True)
  assert status()['state']['username']=='qaowner','Chosen administrator lost on reopening Setup'
  print('PASS interrupted administrator setup retains the chosen username after reopening',flush=True)
 if status()['state']['step']=='account':action('account',warehouseName='Offline QA Warehouse',username='qaowner',adminPassword=adminpass,adminConfirm=adminpass,recoveryPassword=secret,recoveryConfirm=secret,recoverySaved=True)
 import sqlite3
 db=sqlite3.connect(root/'data/inventory.db')
 for table in ['products','cells','controllers','inventory_balances','tasks']:assert db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]==0,table
 assert db.execute('SELECT username FROM users').fetchall()==[('qaowner',)];db.close()
else:
 backup=pathlib.Path('/transfer/warehouse.lytbackup');call('/setup-api/backup-upload',raw=backup.read_bytes(),headers={'X-Backup-Name':backup.name,'Content-Type':'application/octet-stream'})
 try:action('inspect',recoveryPassword='incorrect-test-password')
 except AssertionError as problem:assert 'password' in str(problem).lower()
 else:raise AssertionError('Wrong recovery password accepted')
 s=action('inspect',recoveryPassword=secret);assert s['state']['backupSummary']['certificateIdentity'];assert s['state']['backupSummary']['protected']
 reset_args={} if reset_mode=='restore' else {'resetMode':reset_mode,'keepHardware':keep_hardware,'resetConfirmed':True,'newUsername':'resetowner','newAdminPassword':'test-new-admin-password-2026','newAdminConfirm':'test-new-admin-password-2026'}
 if reset_mode!='restore':
  try:action('restore',recoveryPassword=secret,restoreConfirmed=True,**{**reset_args,'resetConfirmed':False})
  except AssertionError as problem:assert 'Confirm' in str(problem)
  else:raise AssertionError('Reset accepted without explicit confirmation')
 before_cert=(root/'caddy/pki/authorities/local/root.crt').read_bytes()
 pathlib.Path('/tmp/lytguide-service-check/fail-next-app-start').touch()
 try:action('restore',recoveryPassword=secret,restoreConfirmed=True,**reset_args)
 except AssertionError as problem:assert 'Deliberate' in str(problem),str(problem)
 else:raise AssertionError('Expected restore-start failure')
 assert (root/'caddy/pki/authorities/local/root.crt').read_bytes()==before_cert,'Rollback changed the previous certificate'
 assert not (root/'restore-in-progress.json').exists()
 action('restore',recoveryPassword=secret,restoreConfirmed=True,**reset_args)
 original=pathlib.Path('/transfer/root.crt').read_bytes();assert original==(root/'caddy/pki/authorities/local/root.crt').read_bytes()
 import sqlite3
 db=sqlite3.connect(root/'data/inventory.db')
 if reset_mode=='restore':
  assert db.execute('SELECT SUM(available_quantity) FROM inventory_balances').fetchone()[0]==4
  assert db.execute("SELECT COUNT(*) FROM users WHERE username='recoveredowner'").fetchone()[0]==1
  assert db.execute("SELECT COUNT(*) FROM tasks WHERE outcome='needs_review'").fetchone()[0]>=1
 else:
  for table in ['inventory_balances','tasks','transactions','stocktake_runs','work_reports']:assert db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]==0,table
  assert db.execute('SELECT COUNT(*) FROM products').fetchone()[0]==(0 if reset_mode=='fresh' else s['state']['backupSummary']['counts']['products'])
  if reset_mode=='fresh':assert db.execute('SELECT username FROM users').fetchall()==[('resetowner',)]
  else:assert db.execute("SELECT COUNT(*) FROM users WHERE username='recoveredowner'").fetchone()[0]==1
  for table in ['controllers','cells']:assert db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]==(s['state']['backupSummary']['counts'][table] if keep_hardware else 0),table
  assert not db.execute('PRAGMA foreign_key_check').fetchall()
  print('PASS reset '+reset_mode+' hardware='+str(keep_hardware)+'; backup source identity and expected records verified',flush=True)
 db.close()
# Main app work is blocked until Finish. The embedded commissioning route is available.
with urllib.request.urlopen('http://127.0.0.1:3310/work') as response:assert response.url.endswith('/setup-not-ready')
assert b'Phone connected' in urllib.request.urlopen('http://127.0.0.1:3310/setup-not-ready').read()
assert b'location-setup' in call('/locations/manage?view=setup')[1]
fresh_page=call('/devices/sections/controller-setup')[1]
assert b'name="controller_setup_mode" value="fresh"' in fresh_page
assert b'name="fresh_setup_confirmed" value="1" required' in fresh_page
assert b'Keep existing LED setup' in call('/wizard.js')[1] and b'Set up as fresh controller' in call('/wizard.js')[1]
if mode=='new' or reset_mode=='restore':
 try:call('/api/firmware/flash',raw=b'controller_setup_mode=fresh',headers={'Content-Type':'application/x-www-form-urlencoded'})
 except urllib.error.HTTPError as problem:assert 'Confirm that the saved LED setup' in problem.detail,problem.detail
 else:raise AssertionError('Fresh provisioning accepted without confirmation')
connect_page=call('/devices/sections/controller-connect')[1];assert b'Check &amp; connect' in connect_page or b'Check & connect' in connect_page;assert b'data-firmware-flash-form' not in connect_page
snapshot=json.loads(call('/api/location-setup/snapshot')[1])
if mode=='new':
 call('/api/location-setup/manual',{'requestId':'wizard-commissioning-cell','site':snapshot['site'],'dataset':snapshot['dataset'],'actorId':snapshot['user']['id'],'fieldSignature':snapshot['fieldSignature'],'displayName':'QA Cell','warehouseName':'Offline QA Warehouse','travelInstructions':'Shelf One'})
 assert len(json.loads(call('/api/location-setup/snapshot')[1])['cells'])==1
ca=ssl.create_default_context(cafile='/transfer/root.crt' if mode=='replace' else str(root/'caddy/pki/authorities/local/root.crt'))
with urllib.request.urlopen('https://'+address+':8443/login',context=ca) as response:assert response.status==200
with urllib.request.urlopen('http://'+address+':8444/root.cer') as response:assert response.headers.get_content_type()=='application/pkix-cert'
action('phones',piOnly=True);action('hardware',simulation=True,simulationConfirmed=True)
if mode=='new' or (reset_mode!='restore' and not keep_hardware):action('locations')
s=action('finish');assert s['state']['completedAt'];assert not (root/'setup-pending').exists()
try:action('back',step='network')
except AssertionError as problem:assert 'already complete' in str(problem)
else:raise AssertionError('Completed setup can no longer reopen commissioning actions')
files=sorted(pathlib.Path('/boot/firmware/LYTGUIDE-RECOVERY').glob('*.lytbackup'));assert files
assert files[-1].read_bytes().startswith(b'LYTGUIDE-SEALED-1\n')
# The privileged wizard session cannot perform stock mutations.
try:call('/api/work/report',{})
except urllib.error.HTTPError as error:assert error.code==404
else:raise AssertionError('Setup proxy accepted stock mutation')
print(json.dumps({'resetMode':reset_mode,'keepHardware':keep_hardware,'mode':mode,'address':address,'protectedCopies':len(files),'completed':True,'simulatedHardware':True}),flush=True)
