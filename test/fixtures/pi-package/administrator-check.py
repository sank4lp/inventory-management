#!/usr/bin/env python3
"""Real packaged Setup/CLI/login flow; disposable ARM64 containers only."""
import hashlib,http.client,json,os,pathlib,sqlite3,ssl,subprocess,time,urllib.request,urllib.error,urllib.parse
assert os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER')=='1'
base='http://127.0.0.1:3311';root=pathlib.Path('/var/lib/lytguide-test');cookie=''
recovery='test-recovery-password-for-administrator-check'

def request(path,body=None):
 headers={'Cookie':cookie,'Connection':'close'};data=None
 if body is not None:headers.update({'Content-Type':'application/json','Origin':base});data=json.dumps(body).encode()
 with urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers=headers),timeout=45) as response:return response.headers,json.loads(response.read())
def authorize():
 global cookie
 url=subprocess.check_output(['/usr/lib/lytguide-test/setup-authorize'],env={**os.environ,'PKEXEC_UID':'1000'},text=True).strip()
 for attempt in range(100):
  try:headers,_=request('/setup-api/unlock',{'token':url.split('#')[1]});cookie=headers['Set-Cookie'].split(';')[0];return
  except urllib.error.URLError:time.sleep(.1)
 raise AssertionError('Setup did not start')
def status():return request('/setup-api/status')[1]
def action(name,expect_error=None,**values):
 request('/setup-api/action',{'action':name,'revision':status()['state']['revision'],**values})
 for attempt in range(1500):
  current=status();assert not any(key in current['state'] for key in ['adminPassword','adminConfirm','recoveryPassword','newAdminPassword'])
  if not current['job']['running']:
   error=current['job']['error']
   if expect_error:assert error and expect_error.lower() in error.lower(),error
   else:assert not error,error
   return current
  time.sleep(.1)
 raise AssertionError('Setup action timed out')
def start_path(existing=False):
 authorize();current=request('/setup-api/refresh')[1];assert all(item['ok'] for item in current['facts']['checks']),current['facts']
 action('choose',mode='configure' if existing else 'new',pauseExisting=True);action('system')
 address=current['network']['addresses'][0]['address'];action('network',address=address,addressReserved=True);return address
def query(sql,*args):
 connection=sqlite3.connect(root/'data/inventory.db')
 try:return connection.execute(sql,args).fetchall()
 finally:connection.close()
def login(username,password):
 ca=ssl.create_default_context(cafile=str(root/'caddy/pki/authorities/local/root.crt'))
 connection=http.client.HTTPSConnection(address,8443,context=ca,timeout=20)
 try:
  connection.request('POST','/login',urllib.parse.urlencode({'username':username,'password':password}),{'Content-Type':'application/x-www-form-urlencoded'})
  response=connection.getresponse();response.read();return response.getheader('Set-Cookie','')
 finally:connection.close()

address=start_path()
action('account',warehouseName='Credential QA',username='initialowner',adminPassword='4321',adminConfirm='4321',recoveryPassword=recovery,recoveryConfirm=recovery,recoverySaved=True)
assert 'session=' in login('initialowner','4321');assert query('SELECT username FROM users')==[('initialowner',)]
assert query('SELECT COUNT(*) FROM products')==[(0,)]
owner_id=query('SELECT id FROM users')[0][0]
with sqlite3.connect(root/'data/inventory.db') as connection:
 connection.execute("INSERT INTO tasks(type,status,summary,created_by,started_at,last_touched_at) VALUES('pick','completed','Keep this historical task',?,'2026-11-01','2026-11-01')",(owner_id,))
 connection.execute("INSERT INTO users(name,username,password_hash,role,status,created_at) SELECT 'Other operator','occupied',password_hash,'operator','active','2026-11-01' FROM users WHERE id=?",(owner_id,))
connection.close()
tasks=query('SELECT * FROM tasks');other=query("SELECT * FROM users WHERE username='occupied'")
cert=root/'caddy/pki/authorities/local/root.crt';cert_hash=hashlib.sha256(cert.read_bytes()).hexdigest()
profile=pathlib.Path('/etc/lytguide-test/recovery-encryption.json');profile_bytes=profile.read_bytes()
start_path(existing=True)
current=status();assert current['existingWarehouse']['administratorId']==owner_id
values={'warehouseName':'Credential QA','administratorId':owner_id,'username':'updatedowner','adminPassword':'1234','adminConfirm':'1234'}
action('account',expect_error='do not match',**{**values,'adminConfirm':'different'})
assert query('SELECT username FROM users WHERE id=?',owner_id)==[('initialowner',)]
action('account',expect_error='already in use',**{**values,'username':'occupied'})
assert query('SELECT username FROM users WHERE id=?',owner_id)==[('initialowner',)]
pathlib.Path('/tmp/lytguide-service-check/fail-next-app-start').touch()
action('account',expect_error='Deliberate',**values)
assert query('SELECT username FROM users WHERE id=?',owner_id)==[('initialowner',)]
action('account',**values)
assert 'session=' in login('updatedowner','1234')
assert 'session=' not in login('updatedowner','4321')
assert 'session=' not in login('initialowner','4321')
assert query('SELECT * FROM tasks')==tasks;assert query("SELECT * FROM users WHERE username='occupied'")==other
assert query('SELECT COUNT(*) FROM users')==[(2,)]
assert hashlib.sha256(cert.read_bytes()).hexdigest()==cert_hash;assert profile.read_bytes()==profile_bytes
hashed=query('SELECT password_hash FROM users WHERE id=?',owner_id)[0][0]
action('back',step='account')
action('account',**{**values,'username':'renamedowner','adminPassword':'','adminConfirm':''})
assert query('SELECT password_hash FROM users WHERE id=?',owner_id)==[(hashed,)]
assert 'session=' in login('renamedowner','1234');assert query('SELECT * FROM tasks')==tasks
for event in query("SELECT payload FROM system_events WHERE event_type='administrator_credentials_changed'"):
 assert not any(key in json.loads(event[0]) for key in ['password','password_hash','adminPassword'])
assert 'adminPassword' not in json.loads((root/'setup/state.json').read_text())
assert 'adminPassword' not in json.loads(pathlib.Path('/etc/lytguide-test/config.json').read_text())
print('PASS packaged new warehouse accepts 4-character password; existing administrator can be renamed and set to 1234; old login fails; blank keeps password; task/account identity, other users, certificate and recovery key preserved; mismatch, duplicate and failed-start rollback checked; no secrets in setup state/config/audit')
