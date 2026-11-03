# Raspberry Pi access from phones on warehouse Wi-Fi

The Pi runs the existing app, database and hardware connection. Phones use the
same application through a separate local HTTPS service. Internet is needed
for downloading setup dependencies initially, but is not needed for ordinary
warehouse work or local certificate renewal afterward.

The first setup uses the Pi's reserved IP address, so it does not depend on
router DNS or internet DNS. Example for this site: `https://192.168.1.140`.
A friendly local hostname can be added after the IP-based test is working.

## Before running

- Pi and phone must be on the same reachable local network. The Pi can use
  Ethernet or Wi-Fi. Extenders must bridge that network. Guest/client isolation
  must not block phone-to-Pi traffic.
- Reserve `192.168.1.140` for the Pi in the router's DHCP settings. The installer
  checks the address is currently assigned; it cannot make the router reserve it.
- Keep the existing `inventory-management.service` running. The default app
  port is 3000. The script does not alter that service, Node environment, database,
  serial configuration or app working directory.
- Set the Pi's date/time correctly before first setup. An incorrect clock can
  make certificates appear expired or not yet valid. Verify with `timedatectl`.
  For sites that may reboot without internet, verify RTC/clock retention on the
  actual Pi as part of acceptance.
- Use real operator/admin credentials. For operational deployment, keep
  `NODE_ENV=production` and a persistent `SESSION_SECRET` in the existing app
  service. Never replace its configuration with a demo environment.

## Run on the Pi

SSH from the development machine:

```sh
ssh admin@192.168.1.140
```

Pull the setup files from the development branch before installing:

```sh
cd /home/admin/inventory-management
git switch public-product-development
git pull --ff-only origin public-product-development
```

Keep any local recovery files. If Git reports a conflicting local file, resolve
that conflict before continuing; do not delete the local files or reset the repository.

From the repository (or the standalone setup folder), install dependencies once:

```sh
sudo apt-get update
sudo apt-get install caddy curl openssl iproute2
```

The Debian Caddy package may start its own default `caddy.service`. The setup
does not modify or stop it. It adds `inventory-management-lan.service` with its
own configuration and certificate storage. If another service uses HTTPS port
443, setup refuses to replace it; use port 8443 instead.

```sh
cd /home/admin/inventory-management
sudo sh scripts/install-pi-lan.sh 192.168.1.140
```

This performs checks, validates the web-server configuration, starts the separate
HTTPS service, verifies the response using the actual local root certificate,
and exports **only the public certificate** to:

```text
/home/admin/lightguide-warehouse-root.cer
```

On a Pi where Node is installed only under the user's version manager and sudo
cannot find it, first run `command -v node`, then use that returned absolute path:

```sh
node_bin="$(command -v node)"
"$node_bin" --version
sudo "$node_bin" scripts/pi-lan.mjs install --address 192.168.1.140 && \
  sudo "$node_bin" scripts/pi-lan.mjs certificate --address 192.168.1.140
```

Stop if the version command fails. Certificate export runs only after installation
succeeds. The wrapper prints this explanation if Node is unavailable to sudo.

Read-only preflight and subsequent verification:

```sh
sudo node scripts/pi-lan.mjs check --address 192.168.1.140
sudo node scripts/pi-lan.mjs verify --address 192.168.1.140
systemctl status inventory-management.service inventory-management-lan.service --no-pager
```

For a different HTTPS/app port, pass both to the wrapper:

```sh
sudo sh scripts/install-pi-lan.sh 192.168.1.140 8443 3000
```

Then use `https://192.168.1.140:8443`, and add `--port 8443` to check/verify commands.
When the IP changes, rerun setup with the new assigned address. Certificate
authority storage is retained, so previously enrolled devices do not need a new
root certificate. Update the bookmark and router reservation. Do not erase the
certificate storage directory during routine updates.

## Share the public certificate through Git

The installer creates this Pi's certificate authority on the Pi. There is no
shared certificate bundled in the repository: a certificate from another Pi or
a test run would not match this installation. After setup succeeds, the exported
public certificate can be committed from the Pi if it has GitHub push access:

```sh
cd /home/admin/inventory-management
openssl x509 -inform DER -in /home/admin/lightguide-warehouse-root.cer -noout -fingerprint -sha256
mkdir -p certificates
cp /home/admin/lightguide-warehouse-root.cer certificates/warehouse-192-168-1-140.cer
git add -- certificates/warehouse-192-168-1-140.cer
git commit -m "Add warehouse public trust certificate"
git push origin public-product-development
```

Only add this exported `.cer` file. The certificate's private keys and the
`/var/lib/inventory-management-lan` directory must remain on the Pi. Download
the committed public file on your development machine for phone enrollment;
Git does not install certificate trust on the phone automatically.

## Install the certificate on an iPhone

Transfer the exported certificate to the Mac (this installs no certificate on the Mac):

```sh
scp admin@192.168.1.140:/home/admin/lightguide-warehouse-root.cer ~/Downloads/
```

AirDrop this **public `.cer` file** to the iPhone. Accept/open it as a certificate
profile. If it arrives in Files instead, open the file there. Then:

1. Open **Settings → General → VPN & Device Management** (or **Profile Downloaded**).
2. Install the downloaded certificate profile. Follow the iPhone's device-passcode prompts.
3. Open **Settings → General → About → Certificate Trust Settings**.
4. Enable full trust for the installed **Caddy Local Authority** root certificate.
5. Join the same warehouse Wi-Fi and open `https://192.168.1.140` in Safari.
6. Sign in. When scanning from inside the app, allow Safari to use the camera.

Only trust the certificate exported from this Pi; the setup prints its SHA-256
fingerprint for checking. This trust enrollment is a deliberate phone setting,
not a browser warning to bypass. Do not use “Proceed anyway.” If Safari reports
a certificate warning, check profile installation, full trust, the URL and Pi time.

Apple documents the separate full-trust step here:
[Trust manually installed certificate profiles](https://support.apple.com/en-us/102390).
Managed phones may require their organization's device administrator to install
the profile. The setup does not change trust on the Mac or Pi browser automatically.

For the Pi desktop, use the same HTTPS bookmark after importing this public root
certificate into its browser/system trust through the site's approved procedure.
The existing localhost page remains usable while this is configured.

## Android afterward

Copy the same public certificate to the Android device. Install it through the
device's certificate settings as a **CA certificate**, then open the same HTTPS
address in Chrome and permit camera access when requested. Menu names vary by
manufacturer/version (often Security → Encryption & credentials → Install a
certificate → CA certificate). Test certificate trust and scanning on the actual
Android phone; managed devices may restrict user-installed roots.

No separate Android app or database is required.

## Test before using for warehouse operations

Use an agreed test product/location and record the starting balance.

1. Open the app on the Pi and phone; sign in as the intended roles. Confirm both
   show the same records and permitted actions.
2. Start Pick/Put, check the actual LED, scan a printed location QR using the
   phone's camera, confirm the actual quantity, and verify the updated stock/task
   on the other screen. Test the manual scanning fallback too.
3. Disconnect **only the router's internet/WAN connection**. Keep the Pi/router
   powered and the warehouse Wi-Fi active. On a fresh Safari tab, reopen the app,
   sign in and repeat a test movement. This verifies full local access rather than
   only a cached page. Avoid interrupting unrelated users' internet during a live shift.
4. Test two phones and concurrent tasks. Verify updates, quantities, ownership,
   permissions and LED behavior on the real setup.
5. Reboot the Pi; confirm both services restart, the reserved IP stays the same,
   the clock is correct, HTTPS is trusted and the existing data remains.
6. Disconnect one phone's Wi-Fi. Its offline draft/cached work is provisional:
   a movement is not confirmed in the Pi database until the Pi accepts it. Reconnect
   and check one movement was recorded once. Use the app's existing recovery rules.
7. Record results for Pi OS, router/extender, iPhone/iOS and Android versions.

“Without internet” does not mean “without a connection to the Pi.” If Pi, router
or LAN fails, live confirmation cannot complete. Mobile data alone cannot reach
this local-only deployment.

The HTTPS address is a different browser origin from `http://localhost:3000`.
Finish/synchronize pending work on the old address before switching permanently.
Browser drafts and sessions do not migrate automatically; do not recreate a task
just because a different address has no cached draft.

## What the setup changes

- `/etc/inventory-management/lan.Caddyfile`: HTTPS only, bound to the chosen Pi
  IPv4 address, accepting clients from its local subnet.
- `/etc/systemd/system/inventory-management-lan.service`: dedicated web server,
  automatic startup and retry, limited to its own certificate storage.
- `/var/lib/inventory-management-lan`: persistent local certificate authority,
  generated and renewed without public certificate services/internet. Private
  keys stay here with restricted permissions; never put them in Git or share them.
- `/home/admin/lightguide-warehouse-root.cer`: exported public trust certificate.

It does not open router ports, change firewall rules, configure DNS, run an extra
inventory process, seed data or alter the original inventory service. Do not
forward its HTTPS port from the internet. If a firewall blocks access, allow the
chosen HTTPS port only from the warehouse LAN through your approved network setup.

Failed configuration/start/HTTPS verification restores the earlier managed web
configuration where possible and reports any recovery failure. The app itself
is never restarted by setup. Certificate storage is preserved for safe reruns.

Troubleshooting:

```sh
hostname -I
timedatectl
sudo journalctl -u inventory-management-lan.service -n 40 --no-pager
curl --noproxy '*' --max-time 10 http://127.0.0.1:3000/login -o /dev/null
sudo node scripts/pi-lan.mjs verify --address 192.168.1.140
```

- `reading input file: open -: no such file or directory`: pull the latest setup
  files and rerun installation. Older packaged Caddy versions require a file
  instead of stdin; preflight now uses a private temporary file and removes it
  on both success and failure. The configuration also avoids the newer
  `persist_config` Caddyfile option. A subsequent missing-certificate message means
  the failed installation never reached certificate creation; install first.
- Local app check fails: inspect the existing app service/port first.
- Pi HTTPS verification passes but phone cannot connect: check phone Wi-Fi, IP,
  port, guest/client isolation, extender mode and LAN firewall.
- Certificate error: verify the phone trust enrollment and Pi clock.
- HTTPS responds with 403: the phone is outside the permitted Pi subnet; check
  the warehouse network arrangement.
- Camera denied/unavailable: check trusted HTTPS and Safari camera permission;
  use manual confirmation while diagnosing. The Pi camera module is not needed.

To stop only phone HTTPS access while retaining the app and certificate identity:

```sh
sudo systemctl disable --now inventory-management-lan.service
```

## Verification boundary

Automated checks cover address/subnet/input restrictions, unrelated-file and
port protection, generated server configuration, loopback HTTPS proxy behavior
and the existing application regression suite. They do not certify a Raspberry
Pi installation, iPhone camera, router/extender, controller or WAN-loss test.

References: [Caddy installation](https://caddyserver.com/docs/install),
[Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https),
[browser camera secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Software verification for this change: **550 tests passed**, zero failures. The
opt-in proxy check (`scripts/check-pi-lan-proxy.mjs`, with `CADDY_BIN` set) passed
with official Caddy **2.6.2 and 2.11.7**, using a disposable
production-mode app and loopback only: validated TLS, untrusted-root rejection,
HTTPS login and secure session cookies, certificate export, the origin guard,
all 24 checked local resources, subnet enforcement despite a spoofed forwarding
header, and restart with the same certificate authority. Raspberry Pi/systemd
installation and real phone/network/hardware acceptance remain pending.
