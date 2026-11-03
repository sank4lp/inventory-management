#!/usr/bin/env python3
"""Service orchestration double for disposable containers without systemd PID 1."""
import json
import os
import pathlib
import pwd
import signal
import subprocess
import sys
import time

if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):
    sys.exit('This helper is only for the disposable package-check container.')
state = pathlib.Path('/tmp/lytguide-service-check')
state.mkdir(exist_ok=True)
args = sys.argv[1:]
if not args:
    sys.exit(0)
command, *services = args
if command == 'show':
    service=services[0]
    pidpath=state/(service+'.pid')
    pid=int(pidpath.read_text()) if pidpath.exists() else 0
    alive=False
    if pid:
        try:alive='\nState:\tZ' not in pathlib.Path('/proc',str(pid),'status').read_text()
        except OSError:pass
    started=state/(service+'.started')
    print('ActiveState='+('active' if alive else 'inactive'))
    print('MainPID='+str(pid if alive else 0))
    print('ActiveEnterTimestampMonotonic='+(started.read_text() if started.exists() else '0'))
    sys.exit(0)
if command == 'daemon-reload':
    sys.exit(0)

def running(service):
    if service.endswith('.timer'):
        return (state / (service + '.active')).exists()
    path = state / (service + '.pid')
    if not path.exists():
        return False
    try:
        pid = int(path.read_text())
        status = pathlib.Path('/proc', str(pid), 'status').read_text()
        return '\nState:\tZ' not in status
    except (OSError, ValueError):
        return False

for service in services:
    enabled = state / (service + '.enabled')
    pidfile = state / (service + '.pid')
    if command == 'is-active':
        print('active' if running(service) else 'inactive')
        sys.exit(0 if running(service) else 3)
    if command == 'is-enabled':
        print('enabled' if enabled.exists() else 'disabled')
        sys.exit(0 if enabled.exists() else 1)
    if command == 'enable':
        enabled.touch()
        continue
    if command == 'disable':
        enabled.unlink(missing_ok=True)
        continue
    if command in ('stop', 'restart'):
        if service.endswith('.timer'):
            (state / (service + '.active')).unlink(missing_ok=True)
            if command == 'stop':
                continue
        if running(service):
            os.killpg(int(pidfile.read_text()), signal.SIGTERM)
            for _ in range(100):
                if not running(service):
                    break
                time.sleep(0.05)
            if running(service):
                os.killpg(int(pidfile.read_text()), signal.SIGKILL)
        pidfile.unlink(missing_ok=True)
    if command in ('start', 'restart') and not running(service):
        if service.endswith('.timer'):
            (state / (service + '.active')).touch()
            continue
        if service not in ('lytguide-test.service', 'lytguide-test-web.service', 'lytguide-test-setup.service'):
            sys.exit('Only test services can start in this helper.')
        if service == 'lytguide-test.service':
            guard = pathlib.Path('/usr/lib/lytguide-test/check-restore.sh')
            if guard.exists():
                subprocess.run([str(guard)], check=True)
            failure = state / 'fail-next-app-start'
            if failure.exists():
                failure.unlink()
                sys.exit('Deliberate isolated service-start failure')
        web = service.endswith('-web.service')
        setup = service.endswith('-setup.service')
        account = pwd.getpwnam('root' if setup else 'lytguide-test-web' if web else 'lytguide-test')
        root = pathlib.Path('/opt/lytguide-test/candidate' if setup else '/opt/lytguide-test/current')
        env = dict(os.environ)
        if setup:
            pathlib.Path('/run/lytguide-test-setup').mkdir(mode=0o700,exist_ok=True)
            invocation = [str(root / 'runtime/node'), str(root / 'app/wizard-server.cjs')]
        elif web:
            env.update(HOME='/var/lib/lytguide-test/caddy', XDG_DATA_HOME='/var/lib/lytguide-test/caddy', XDG_CONFIG_HOME='/var/lib/lytguide-test/caddy')
            invocation = [str(root / 'runtime/caddy'), 'run', '--config', '/etc/lytguide-test/Caddyfile', '--adapter', 'caddyfile']
        else:
            for line in pathlib.Path('/etc/lytguide-test/runtime.env').read_text().splitlines():
                if line and not line.startswith('#'):
                    key, value = line.split('=', 1)
                    env[key] = value
            invocation = [str(root / 'runtime/node'), str(root / 'app/server.cjs')]
        def demote():
            os.initgroups(account.pw_name, account.pw_gid)
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
        with open(state / (service + '.log'), 'ab') as log:
            child = subprocess.Popen(invocation, cwd='/var/lib/lytguide-test/caddy' if web else root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, preexec_fn=demote, start_new_session=True)
        pidfile.write_text(str(child.pid))
        (state / (service + '.started')).write_text(str(int(time.monotonic()*1000000)))

