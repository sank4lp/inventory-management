#!/usr/bin/env python3
"""Check packaged desktop dispatch as a normal user; Electron itself is tested separately."""
import json,os,pathlib,pwd,subprocess,time
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):raise SystemExit('Disposable check only')
try:pwd.getpwnam('desktopqa')
except KeyError:subprocess.run(['useradd','--create-home','--shell','/bin/sh','desktopqa'],check=True)
executable=pathlib.Path('/opt/lytguide-test/candidate/desktop/lytguide-desktop');pending=pathlib.Path('/var/lib/lytguide-test/setup-pending');saved=executable.with_suffix('.desktop-qa-real');log=pathlib.Path('/tmp/lytguide-native-dispatch.json');assert not pending.exists();executable.rename(saved)
try:
 executable.write_text('#!/usr/bin/python3\nimport json,pathlib,sys\npathlib.Path("/tmp/lytguide-native-dispatch.json").write_text(json.dumps(sys.argv[1:]))\n');executable.chmod(0o755)
 def invoke(command):
  log.unlink(missing_ok=True);subprocess.run(['runuser','-u','desktopqa','--','env','DISPLAY=:qa','/usr/bin/lytguide-test',command],check=True,timeout=20)
  for _ in range(100):
   if log.exists():break
   time.sleep(.05)
  return json.loads(log.read_text())
 assert invoke('open')==['--lytguide-work'];assert invoke('wizard')==['--lytguide-setup'];pending.write_text('Desktop test');assert invoke('open')==['--lytguide-resume']
 print('PASS installed menu commands dispatch app, fresh Setup and saved-step resume to the bundled executable, without a browser',flush=True)
finally:pending.unlink(missing_ok=True);executable.unlink(missing_ok=True);saved.rename(executable)
