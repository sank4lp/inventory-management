#!/usr/bin/env python3
"""Reject an incomplete identity without replacing the last good card backup."""
import json,os,pathlib,subprocess
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):raise SystemExit('Disposable check only')
root=pathlib.Path('/var/lib/lytguide-test');card=pathlib.Path('/boot/firmware/LYTGUIDE-RECOVERY')
before={p.name:p.read_bytes() for p in card.glob('*.lytbackup')};assert before
key=root/'caddy/pki/authorities/local/root.key';saved=key.with_suffix('.qa-saved');key.rename(saved)
try:
 result=subprocess.run(['lytguide-test','backup'],capture_output=True,text=True)
 assert result.returncode!=0 and 'incomplete' in result.stderr,(result.stdout,result.stderr)
 assert before=={p.name:p.read_bytes() for p in card.glob('*.lytbackup')}
 assert 'incomplete' in json.loads((root/'recovery-status.json').read_text())['lastError']
finally:saved.rename(key)
subprocess.run(['lytguide-test','backup'],check=True)
print('PASS missing certificate identity rejected; prior recovery files retained; retry works after repair')
