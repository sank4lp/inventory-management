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

# Begin after the normal packaged new-warehouse fixture has completed.
authorize();assert state()['state']['step']=='choose' and state()['canResumeLocations']
cert=hashlib.sha256((root/'caddy/pki/authorities/local/root.crt').read_bytes()).hexdigest();before=records()
action('resumeLocations');assert state()['state']['step']=='locations';assert records()==before
# Entire location setup can be postponed; no QR is needed to finish commissioning.
action('locations',deferLocations=True);action('finish');assert state()['state']['completedAt'];assert not (root/'setup-pending').exists();assert records()==before
print('PASS location setup can be deferred and finished without changing existing data or phone trust',flush=True)
# Use an actual simulator-backed controller, never real serial hardware.
authorize();action('resumeLocations')
db=sqlite3.connect(root/'data/inventory.db');controller=db.execute("INSERT INTO controllers(zone_id,controller_code,address,module_count,active,heartbeat_status,last_seen_at,cell_start_column,cell_end_column) VALUES((SELECT id FROM zones ORDER BY id LIMIT 1),'LOCATION-QA','LOCATION-QA',3,1,'online',datetime('now'),1,3)").lastrowid;db.commit();db.close()
command('start',controllerId=controller)
for number in [1,2]:
 current=selected();assert current['output']==number
 light=command('light',sessionId=current['id'],generation=current['generation']);assert any(target['status']=='sent' for target in light['targets'])
 command('bind',sessionId=current['id'],generation=current['generation'],fieldSignature=snapshot()['fieldSignature'],displayName='Deferred QR Cell '+str(number),warehouseName='QA Warehouse',travelInstructions='Shelf Five',qrLater=True,physicalConfirmed=True)
assert state()['counts']['qrPending']>=2
current=selected();assert current['output']==3;command('light',sessionId=current['id'],generation=current['generation'])
action('locations',deferLocations=True);assert selected()['output']==3 and selected()['display_id'] is None
action('finish');before=records();subprocess.run(['systemctl','restart','lytguide-test-setup.service'],check=True);authorize();assert state()['canResumeLocations'];action('resumeLocations');assert selected()['output']==3;assert records()==before
for cell in snapshot()['cells']:
 if cell['display_name'].startswith('Deferred QR Cell '):assert cell['qrScannedAt'] is None and cell['binding_verified_at']
print('PASS saved LED bindings survive finish, setup service restart and direct resume at the next output; QR remains pending',flush=True)
current=selected();command('light',sessionId=current['id'],generation=current['generation']);command('bind',sessionId=current['id'],generation=current['generation'],fieldSignature=snapshot()['fieldSignature'],displayName='Deferred QR Cell 3',warehouseName='QA Warehouse',travelInstructions='Shelf Five',qrLater=True,physicalConfirmed=True)
# The normal phone/tablet API assigns the sticker later without altering mapping.
current=selected();command('pause',sessionId=current['id'],generation=current['generation'])
cell=next(cell for cell in snapshot()['cells'] if cell['display_name']=='Deferred QR Cell 1');old_mapping=(cell['controller_id'],cell['hardware_channel'],cell['binding_revision'])
command('assignQr',cellId=cell['id'],labelId=cell['label_id'],labelRevision=cell['label_revision'],label='PHONE-ASSIGNED-QR-ONE',confirmed=True)
updated=next(row for row in snapshot()['cells'] if row['id']==cell['id']);assert updated['qrScannedAt'] and updated['qrValue']=='PHONE-ASSIGNED-QR-ONE';assert (updated['controller_id'],updated['hardware_channel'],updated['binding_revision'])==old_mapping
# Readiness is independent of scanning; this synthetic manual location is not LED-mapped,
# so explicitly defer it while leaving all three verified outputs intact.
action('locations',deferLocations=True);action('finish');assert not (root/'setup-pending').exists();assert hashlib.sha256((root/'caddy/pki/authorities/local/root.crt').read_bytes()).hexdigest()==cert
print('PASS later QR assignment preserves the verified mapping and phone certificate; all new location details remain saved',flush=True)
