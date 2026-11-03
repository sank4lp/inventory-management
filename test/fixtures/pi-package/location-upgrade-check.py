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

# Simulate the stored checkpoint format used before LED tabs existed.
import sys
checkpoint=root/'legacy-setup-test.json'
if sys.argv[1]=='before':
 authorize()
 if state()['state']['step']=='choose':action('resumeLocations')
 for session in snapshot()['sessions']:
  if session['display_id']:command('pause',sessionId=session['id'],generation=session['generation'])
 db=sqlite3.connect(root/'data/inventory.db');controller=db.execute("INSERT INTO controllers(zone_id,controller_code,address,module_count,active,heartbeat_status,last_seen_at,cell_start_column,cell_end_column) VALUES((SELECT id FROM zones ORDER BY id LIMIT 1),'LEGACY-QA','LEGACY-QA',4,1,'online',datetime('now'),1,4)").lastrowid;db.commit();db.close()
 command('start',controllerId=controller)
 session=next(row for row in snapshot()['sessions'] if row['controller_id']==controller)
 command('bind',sessionId=session['id'],generation=session['generation'],fieldSignature=snapshot()['fieldSignature'],displayName='Saved before LED tabs',qrLater=True,physicalConfirmed=True)
 session=next(row for row in snapshot()['sessions'] if row['controller_id']==controller);assert session['output']==2
 command('pause',sessionId=session['id'],generation=session['generation'])
 db=sqlite3.connect(root/'data/inventory.db');row=db.execute('SELECT id,address,module_count,configured_at FROM controllers WHERE id=?',(controller,)).fetchone();db.execute('UPDATE location_setup_sessions SET controller_snapshot=? WHERE id=?',(json.dumps(row,separators=(',',':')),session['id']));db.commit();db.close()
 checkpoint.write_text(json.dumps({'controller':controller,'session':session['id'],'records':records(),'authority':hashlib.sha256((root/'caddy/pki/authorities/local/root.crt').read_bytes()).hexdigest()}))
 print('PASS prepared an older-wizard checkpoint with LED 1 saved and LED 2 pending',flush=True)
else:
 saved=json.loads(checkpoint.read_text());assert json.loads(json.dumps(records()))==saved['records'];assert hashlib.sha256((root/'caddy/pki/authorities/local/root.crt').read_bytes()).hexdigest()==saved['authority']
 authorize()
 if state()['state']['step']=='choose':action('resumeLocations')
 command('start',controllerId=saved['controller'])
 session=next(row for row in snapshot()['sessions'] if row['id']==saved['session']);assert session['output']==2 and session['lightReady'];assert len(json.loads(session['controller_snapshot']))==5
 cell=next(row for row in snapshot()['cells'] if row['display_name']=='Saved before LED tabs');assert cell['binding_verified_at']
 command('bind',sessionId=session['id'],generation=session['generation'],fieldSignature=snapshot()['fieldSignature'],displayName='Saved after LED tabs',qrLater=True,physicalConfirmed=True)
 session=next(row for row in snapshot()['sessions'] if row['id']==saved['session']);assert session['output']==3
 command('pause',sessionId=session['id'],generation=session['generation']);action('locations',deferLocations=True);action('finish')
 print('PASS final update preserves warehouse records, QR and phone trust, resumes the older checkpoint at LED 2, retains LED 1 verification, then saves and advances to LED 3',flush=True)
