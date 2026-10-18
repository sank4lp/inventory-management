# Raspberry Pi service recovery

The existing `inventory-management.service` starts the app after boot and has
`Restart=always`. That restarts a process that exits, but it cannot detect a
process that is still running and no longer answering HTTP requests.

This repository includes a separate systemd timer that checks
`http://127.0.0.1:3000/login` every minute. It waits 15 seconds and checks a
second time before restarting the existing service. It does nothing while the
service is intentionally stopped. It does not start a second copy of the app or
change its RS485 settings.

## Returning after a long break

A sign-in session expires 12 hours after login; that does not stop the Pi
service. The app returns an expired open tab to Sign In when its timer runs,
when the browser wakes up, or when the next action/API request detects expiry.
Saved drafts and pending movement/count receipts stay on the device. Page
loads have a 15-second deadline instead of waiting indefinitely; when a
controlled browser reload cannot reach the server, its cached saved-work page
can be used.

A native reload that cannot load even `/login` is a different issue from an
expired session. Before restarting, run these read-only checks on the Pi:

```sh
curl --max-time 10 --silent --output /dev/null --write-out 'Local app HTTP %{http_code}, %{time_total}s\n' http://127.0.0.1:3000/login
systemctl show inventory-management.service -p ActiveState -p SubState -p Restart -p NRestarts -p RuntimeMaxUSec
sudo journalctl -u inventory-management.service --since '26 hours ago' --no-pager -n 80
systemctl status inventory-management-healthcheck.timer --no-pager
```

A fast HTTP 200 means the app is responding locally; check Caddy, the router
connection and the affected browser next. A timeout means the app is not
answering locally. The service state, restart count and journal help determine
whether it exited, was killed, or stayed alive without responding. A running
Pi does not require a daily restart. Enable the recovery timer below if it has
not already been installed; its presence in Git does not enable it on the Pi.

## Install on the Pi

Make sure this version of the repository is present at
`/home/admin/inventory-management`, then run on the Pi:

```sh
cd /home/admin/inventory-management
sh scripts/install-pi-watchdog.sh
```

The installer requires `sudo`, `curl`, and the existing
`inventory-management.service`. It enables the timer without restarting the
running app.

## Verify

```sh
systemctl status inventory-management.service inventory-management-healthcheck.timer --no-pager
curl --max-time 10 --silent --output /dev/null --write-out 'Local app HTTP %{http_code}, %{time_total}s\n' http://127.0.0.1:3000/login
sudo systemctl start inventory-management-healthcheck.service
sudo journalctl -u inventory-management-healthcheck.service -n 20 --no-pager
```

The manual check should complete without restarting a healthy app. To inspect
a morning failure before a restart, record the time and run:

```sh
uptime -s
curl --max-time 10 --silent --output /dev/null --write-out 'Local app HTTP %{http_code}, %{time_total}s\n' http://127.0.0.1:3000/login
systemctl status inventory-management.service --no-pager -l
sudo journalctl -u inventory-management.service -u inventory-management-healthcheck.service --since today --no-pager -n 100
```

If the local HTTP check succeeds while the browser keeps loading, investigate
the browser and its cached site data. If the Pi itself loses power or its
network connection, this service check cannot prevent that interruption.

## Browser asks to unlock the keyring

The `Unlock Keyring` popup can come from Chromium's password storage after
desktop auto login. It does not mean the Node service failed to start. The
separate Inventory browser launcher uses its own profile and Chromium's
`--password-store=basic` setting, so it does not need to unlock the existing
Chromium profile's keyring. Install it as the Pi's `admin` desktop user:

```sh
cd /home/admin/inventory-management
sh scripts/install-pi-browser.sh
```

This adds an Inventory Management application shortcut and opens it maximized
after the next desktop login. After pulling a launcher update, run this installer
again to update the installed shortcut and autostart entry. Close the Inventory
browser window and reopen Inventory Management from the application menu to use
the updated window size immediately. The existing Chromium browser and the
running app are not restarted. Sign in to the Inventory site once in the new browser profile. Do not
save passwords in that profile: Chromium's `basic` password store is
unencrypted. If a keyring popup still appears, the regular Chromium profile
or another desktop application may also be starting. Inspect which application
requests the keyring before changing anything else.

To undo the browser launcher:

```sh
rm ~/.local/share/applications/inventory-management-browser.desktop ~/.config/autostart/inventory-management-browser.desktop
```

## Remove the watchdog

```sh
sudo systemctl disable --now inventory-management-healthcheck.timer
sudo rm /etc/systemd/system/inventory-management-healthcheck.service /etc/systemd/system/inventory-management-healthcheck.timer /usr/local/libexec/inventory-management-healthcheck
sudo systemctl daemon-reload
```
