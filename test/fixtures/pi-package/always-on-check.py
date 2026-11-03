#!/usr/bin/env python3
"""Fault-injection checks against real packaged processes, disposable Pi only."""
import hashlib,hmac,json,os,pathlib,pwd,signal,sqlite3,ssl,subprocess,time,urllib.request
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):raise SystemExit('Disposable check only')
root=pathlib.Path('/var/lib/lytguide-test');services=pathlib.Path('/tmp/lytguide-service-check');config=json.loads(pathlib.Path('/etc/lytguide-test/config.json').read_text());app='lytguide-test.service';web='lytguide-test-web.service'
watch=['/opt/lytguide-test/current/runtime/node','/opt/lytguide-test/current/app/watchdog.cjs']
boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def pid(name):return int((services/(name+'.pid')).read_text())
def stocks():
 d=sqlite3.connect(root/'data/inventory.db')
 try:return d.execute('SELECT cell_id,product_id,available_quantity FROM inventory_balances ORDER BY cell_id,product_id').fetchall()
 finally:d.close()
def prepare_failure(name):
 (services/(name+'.started')).write_text('0');(root/'watchdog-status.json').write_text(json.dumps({'bootId':boot,'services':{name:{'pid':pid(name),'failures':2,'restarts':[]}}}))
def check():subprocess.run(watch,check=True,timeout=90)
def ready():
 url='http://127.0.0.1:'+str(config['appPort'])+'/_lytguide/ready';token=hmac.new(config['sessionSecret'].encode(),b'lytguide-local-readiness-v1',hashlib.sha256).hexdigest()
 for i in range(100):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'x-lytguide-probe':token}),timeout=1) as r:
    if r.status==200 and json.load(r)['ready']:return
  except Exception:time.sleep(.1)
 raise AssertionError('App not ready after recovery')
certificate=root/'caddy/pki/authorities/local/root.crt';certificate_before=certificate.read_bytes()
before=stocks();original=pid(app);prepare_failure(app);os.kill(original,signal.SIGSTOP)
try:check();assert pid(app)!=original,'Hung application not recovered';ready()
finally:
 try:os.kill(original,signal.SIGCONT)
 except ProcessLookupError:pass
assert stocks()==before;print('PASS hung application restarted; recorded stock unchanged',flush=True)
original_web=pid(web);stable_app=pid(app);prepare_failure(web);os.kill(original_web,signal.SIGSTOP)
try:check();assert pid(web)!=original_web;assert pid(app)==stable_app
finally:
 try:os.kill(original_web,signal.SIGCONT)
 except ProcessLookupError:pass
assert certificate.read_bytes()==certificate_before
for i in range(60):
 try:
  with urllib.request.urlopen('https://'+config['address']+':'+str(config['httpsPort'])+'/login',context=ssl.create_default_context(cafile=str(certificate)),timeout=1) as response:assert response.status==200;break
 except Exception:time.sleep(.1)
else:raise AssertionError('HTTPS did not recover')
assert stocks()==before;print('PASS hung HTTPS recovered without restarting the app or changing stock',flush=True)
# Firmware ownership is a deliberate safety fence, even when the app is stopped.
current=pid(app);d=sqlite3.connect(root/'data/inventory.db');d.execute("INSERT OR REPLACE INTO app_metadata(key,value,updated_at) VALUES('firmware_busy','qa-maintenance',datetime('now'))");d.execute("INSERT OR REPLACE INTO app_metadata(key,value,updated_at) VALUES('firmware_busy_owner',?,datetime('now'))",(json.dumps({'id':'qa-maintenance','pid':current}),));d.commit();d.close();prepare_failure(app);os.kill(current,signal.SIGSTOP)
try:check();assert pid(app)==current;assert 'firmware' in json.loads((root/'watchdog-status.json').read_text())['blocked'].lower()
finally:
 d=sqlite3.connect(root/'data/inventory.db');d.execute("DELETE FROM app_metadata WHERE key IN ('firmware_busy','firmware_busy_owner')");d.commit();d.close();os.kill(current,signal.SIGCONT)
print('PASS firmware maintenance prevents an unsafe recovery restart',flush=True)
for marker in ['setup-pending','restore-in-progress.json','.setup-lock']:
 path=root/marker;path.write_text(str(os.getpid()));prepare_failure(app);check();assert pid(app)==current;path.unlink()
print('PASS setup, restore and live maintenance lock defer watchdog recovery',flush=True)
subprocess.run(['systemctl','stop',app],check=True);check();assert not (services/(app+'.pid')).exists();subprocess.run(['systemctl','start',app],check=True);ready();assert stocks()==before
print('PASS intentional service stop is respected',flush=True)
# A stub browser records the exact launch contract; no display server is claimed.
try:pwd.getpwnam('desktopqa')
except KeyError:subprocess.run(['useradd','--create-home','--shell','/bin/sh','desktopqa'],check=True)
browser=pathlib.Path('/opt/lytguide-test/candidate/desktop/lytguide-desktop');saved=browser.with_suffix('.qa-real');browser.rename(saved)
log=pathlib.Path('/tmp/lytguide-desktop-open.json');log.unlink(missing_ok=True)
try:
 browser.write_text('#!/usr/bin/python3\nimport json,pathlib,sys\npathlib.Path("/tmp/lytguide-desktop-open.json").write_text(json.dumps(sys.argv[1:]))\n');browser.chmod(0o755)
 invoke=['runuser','-u','desktopqa','--','env','DISPLAY=:qa','/usr/bin/lytguide-test','autostart'];subprocess.run(invoke,check=True,timeout=20)
 for i in range(40):
  if log.exists():break
  time.sleep(.05)
 args=json.loads(log.read_text());assert args==['--lytguide-work']
 log.unlink();(root/'setup-pending').write_text('QA');subprocess.run(invoke,check=True,timeout=20);assert not log.exists();(root/'setup-pending').unlink()
finally:browser.unlink(missing_ok=True);saved.rename(browser);(root/'setup-pending').unlink(missing_ok=True)
assert (services/'lytguide-test-watchdog.timer.enabled').exists()
assert pathlib.Path('/etc/xdg/autostart/lytguide-test.desktop').exists()
print('PASS desktop startup opens the bundled desktop app as a normal user and waits during setup',flush=True)
print('PASS automatic recovery and desktop startup acceptance checks',flush=True)
