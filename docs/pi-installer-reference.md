# Pi installer technical reference

For installation steps, use [the short installation guide](pi-test-installer.md). This document is for troubleshooting and development.

This testing build targets **64-bit ARM64 Raspberry Pi OS Desktop Bookworm (Debian 12) and Trixie (Debian 13)**. One kit detects the installed OS and uses its own matching dependency set, sharing the same application. Other releases and 32-bit systems are rejected with an explicit message. The Mac builds the installer; the Pi runs the application, database and hardware tools. Windows packaging, licensing and activation remain deferred. This test installer has no copy protection.

## Install without internet

Use the **complete offline kit**, rather than copying just its `.deb`. The kit includes the application, Node, Caddy, ESP32 compiler/SDK and the matching Debian OS dependency packages, including the dedicated Electron runtime libraries and local administrator prompt components. No Git, npm or separate Node installation is required on the Pi.

1. Use Raspberry Pi OS Desktop Bookworm or Trixie on the card. Create its normal OS desktop account. Allow at least **10 GB free space** for installing the kit, extracted tools and recovery space.
2. Copy and extract the complete `LytGuide-Pi-arm64-…tar.gz` kit onto the Pi, for example using USB storage. Keep the `packages` folder and `suites` file together with the installer.
3. Open **Install LytGuide.run**, choose Execute if prompted, and approve the Pi administrator prompt. If the file manager opens the file as text, open a terminal in that folder and run:

   ```sh
   sh "Install LytGuide.run"
   ```

4. **Shed Setup** opens. Choose **New shed** or **Replace Raspberry Pi**, then follow the guided steps below. You can reopen it from the Pi application menu.

The installer verifies the kit checksums and uses a temporary local package repository containing only the detected OS dependencies and shared application. It does not use the Pi's internet repositories or change its configured repository list. Matching dependencies can be installed or upgraded within the existing OS release; it never performs a Bookworm-to-Trixie upgrade. It refuses package removals. The kit is a local test artifact, not a publisher-signed release; transfer it from a trusted source.

Early OS/architecture and checksum failures are shown in the terminal and saved to `/var/log/lytguide-offline-install.log`; APT failures include the log's last lines. To see the error directly, run `sudo sh ./install.sh` in the extracted kit folder, then `sudo tail -n 60 /var/log/lytguide-offline-install.log`. The older Trixie-only kits cannot install on Bookworm. Do not bypass their version check or mix their dependencies with Bookworm.

A router is still required for phone/tablet access. The router itself does not need an internet connection. Reserve the Pi's private IP in the router's DHCP settings; the wizard explains this step but cannot configure arbitrary router brands for you.

## New shed

| Step | What to do |
| --- | --- |
| Check Pi | Resolve any OS, storage, date/time, backup-volume or offline-tool warnings. |
| Shed Wi-Fi | Use the existing Ethernet/Wi-Fi connection, or connect to Wi-Fi from Setup. Select the Pi's address and reserve it in the router. |
| Administrator & recovery | Name the shed, choose its administrator username/password and a separate recovery password. Save that recovery password somewhere other than this SD card. |
| Phones & tablets | Connect to the same router, scan the setup QR, compare the certificate fingerprint with the Pi, install/trust the certificate and test the camera. You can explicitly defer phones for a Pi-only test. |
| Controllers | Use the embedded guided controller setup and included offline firmware tools. Select the correct RS485 adapter and verify controller replies. An explicit simulated-light option is available for software testing. |
| Locations & QR codes | Light each output, scan its sticker, enter the location name and shed/rack details, then save. Existing Manage Locations and label tools are embedded in Setup. |
| Ready | Check the summary. Finish creates a protected SD-card recovery copy before enabling normal shed work. |

A new shed starts **without sample products, controllers, locations or stock**. The chosen administrator is the only initial user. Add real products, people and opening stock through the application. The graphical setup service listens only on the Pi's loopback interface, requires a local administrator approval and does not expose its privileged controls to phones.

The Administrator step also lets an existing shed change its administrator username and password. This edits the same account, preserving its ID, role, task assignments and history. A nonempty administrator password can be short, including `1234`; leaving both password fields blank keeps the existing password. Duplicate usernames and mismatched confirmations are rejected. Changed credentials invalidate that administrator's old sign-in sessions and are audited without recording the password. The separate backup recovery password and phone certificate are preserved.

You can close Setup and reopen it to continue. The chosen administrator username is retained if its first service-start check fails and you retry. Successfully completed steps are saved on the Pi; unsubmitted passwords are not. While setup is pending, ordinary shed operations are blocked. Commissioning pages remain available for the authenticated administrator, including on a connected tablet.

## Replace Raspberry Pi

1. Keep the failed/old Pi **powered off**, including during network setup. Install the same or a newer offline kit on a new Pi/card.
2. Choose **Replace Raspberry Pi**. Check the Pi and select the shed network address. Use the old reserved IP where possible.
3. Choose a `.lytbackup` recovery file and enter the recovery password. **Check backup** shows its date and product/location/user/task counts before restoration. Confirm the backup and that the old Pi is off, then restore.
4. Test phones and the RS485 adapter/controllers. Existing controller, bin and QR mappings are restored; do not add those controllers or pair every sticker again.
5. Finish Setup to make a fresh protected copy and open the shed. Sign in with the **accounts/passwords from the backup**, without creating a throwaway administrator.

Restore preserves stock, accounts, roles, product/location settings, controller definitions, QR mappings, tasks and archived history **as of the backup**. Unfinished work is marked for review; recorded stock is not guessed or silently changed. Old browser sessions are invalidated. Hardware starts in simulator mode until the replacement connection is checked. Any physical movements after the backup must be reconciled before further work.

### Restore or reset from the backup

The replacement wizard defaults to **Restore everything**. Two additional choices are available after checking the backup:

| Choice | Active shed data afterward |
| --- | --- |
| Restore everything | Existing records are restored; unfinished work needs review |
| Clear stock & work | Products, people, roles, invitations and settings remain; balances, reservations, tasks, stocktakes and movement history start empty |
| Start fresh | Products and previous accounts are removed; a new administrator is required |

For either reset, **Keep controller registrations, bin names and QR mappings** is an independent checkbox, checked by default. Keeping it preserves controller addresses, routing profiles, location hierarchy/details, QR bindings and the shed identity embedded in printed LightGuide stickers. Business-data generation and sessions are renewed independently. Clearing it starts without registered controllers or locations; the setup screen offers the previous controller names/addresses as temporary reconnection suggestions. Reconnect them and commission locations/QR labels again. The temporary suggestions are removed at Finish. Stocktake schedule settings are retained for Clear stock & work, but are disabled when location setup is cleared so old scopes cannot start work against new bins.

A reset requires its own confirmation and leaves the supplied backup unchanged. A new database is built and checked in staging, then activated through the same rollback/interrupted-restore protections as normal recovery. Backups and rollback copies are retained: this resets the active shed, not a secure erasure of all historical files on the disk. Network configuration, protected recovery password and restored phone certificate identity remain deployment settings. Enter/check opening stock before resuming shed operations after a reset.

### Existing controller firmware stays on the ESP32

Replacing the Pi, restoring a backup and either data reset do **not** flash the controllers. The Controllers step distinguishes two choices after selecting the RS485 adapter with **Use this adapter**. **Keep existing LED setup** opens read-only reconnection: choose a controller from the backup, or enter its saved RS485 address, then use **Check & connect**. The app reads its firmware and LED configuration and registers it without upload, erase or configuration-write commands. With registrations retained, use Controller health instead of adding a duplicate. This path also exists in Settings → Hardware.

**Set up as fresh controller** is for blank ESP32s or deliberately reused boards. Connect the ESP32's own USB data cable; the RS485 adapter is not a flashing port. Enter its name/count and explicitly confirm replacing its saved LED setup at the final step. The app uploads with outputs initially disabled, reads a nonce/checksum-verified configuration, applies sequential routing with revision checks when needed and verifies full readback before registration. Prior NVS settings from another controller address can be replaced only through this confirmed path. Existing shed products, people and other controllers are unchanged. A known registered board must use Edit; fresh setup cannot silently reset it. A lost configure ACK is resolved by readback, not an assumed failure or success. Invalid responses and failed persistence leave it unregistered. This overwrites only controller LED configuration, not the entire ESP32 flash/NVS partition.

After a successful upload, **Add another controller** restarts USB detection for the next ESP32; the wizard refreshes its saved-controller count. Several boards can share a USB bridge serial such as `0001`. The installer reads the ESP32's ROM MAC using the already bundled offline tool before compilation, checks it again before upload, and retains that verified board identity with its controller. A known physical board cannot be registered twice. For older registrations without a saved ROM identity, a shared USB serial requires confirming that a different ESP32 is connected; the app also probes the old controller address over USB and refuses fresh setup if it answers. Controller identities survive backups and resets that retain hardware.

Fresh controller outputs are inactive until named and physically confirmed. The setup-only snapshot includes those outputs and their actual description revisions; normal Locations still excludes them. Saving names activates that bin, preserves its identity, stores its shed/rack details and automatically lights the next LED. Required-field feedback appears in the setup panel. Returning from Locations to Controllers clears the setup displays before controller maintenance can begin.

The address must be known from the backup or controller label; unknown bus addresses are not guessed. An offline controller or an unverified firmware/configuration response leaves it unregistered and unchanged. New/blank ESP32s and deliberate upgrades use the separate **Flash a new controller** / **Update firmware** paths. Read-only reconnection requires controller-management permission independently of permission to flash firmware. Physical RS485/LED verification remains necessary.

### A timeout after applying fresh LED setup

If upload/hash verification succeeds, the initial USB configuration is read, and the board stops responding just after **Applying the confirmed fresh LED setup**, use build `20261029.5` or later. Earlier kits bundled NeoPixel 1.12.3 with ESP32 core 3.0.7. Its ESP-IDF 5 RMT driver allocates `numBytes × 8 × 4` bytes on the loop stack: four 8×8 RGB matrices need 24,576 bytes, exceeding the default 8,192-byte loop stack. The official NeoPixel 1.12.4 release moves the buffer to checked heap allocation. The corrected archive and driver hash are pinned and verified during release preparation; the runtime rejects older bundled LED libraries before upload.

Install and activate the corrected package, restart Shed Setup, then flash the controller again through the confirmed Fresh path (or Edit for a registered controller). Replacing the host package alone does not change firmware already flashed on an ESP32. A failed unregistered Fresh attempt can be repeated after the host update; shed records are retained. Do not treat a timeout as confirmation of routing. Physical flash/LED verification remains necessary.

Protected backups carry the shed certificate identity. Restoring it keeps the original authority, so existing phones should remain trusted; test the actual phones. A different private IP still needs to be opened on each device. Older unprotected testing backups can be imported, but they do not carry the certificate identity: Setup asks for a new recovery password and the phones need the replacement certificate trusted once.

Restoring over an already configured test installation requires everyone to stop work. Existing physical work must be resolved first. Restoration retains a rollback copy and uses an interruption guard; an interrupted or failed restore must be resolved before starting the app. A working old installation is not a live failover partner—never run both Pis against the same controllers.

## Get the recovery file from a failed Pi

On the Pi's SD card, automatic recovery copies are placed in **LYTGUIDE-RECOVERY** on the existing FAT boot partition (`/boot/firmware`, or supported older `/boot` layouts). That partition normally appears as **bootfs** in Finder. No Linux partition reader, repartitioning or boot-file changes are required.

Setup makes the first copy and a dedicated timer refreshes it every **15 minutes**. The newest **two successful copies** are retained. Each includes a consistent SQLite snapshot with committed WAL changes and archived history. A failed copy keeps the prior good copy. Individual copies are limited to 128 MiB and preserve 128 MiB free space on the boot volume; insufficient capacity is reported rather than deleting unrelated boot files. Check the latest successful timestamp and keep an independent off-card copy.

New wizard backups are **encrypted and authenticated**. The recovery password is needed to restore, not to create each automatic copy. Certificate private keys are included only inside protected backups, never in the application package, Git or the public phone certificate download. A lost recovery password cannot be recovered from the installer. Data encrypted on a failed card is inaccessible without it; a completely damaged card also requires an independent external backup.

For an extra copy on a healthy Pi:

```sh
sudo lytguide-test backup --output /home/admin/warehouse.lytbackup
lytguide-test status
```

Existing legacy command-line installations without a configured recovery password still create data-only unprotected backups. Do not mistake those for the new protected wizard flow.

## Phone certificate setup

The wizard shows a QR and a public-only download page at `http://PI-IP:8444`. Business sign-in stays at `https://PI-IP:8443`. Compare the certificate fingerprint on the trusted Pi before trusting it on a phone.

- **iPhone/iPad:** install the profile in Settings → General → VPN & Device Management, then enable it in General → About → Certificate Trust Settings.
- **Android:** Security settings → Install a certificate → CA certificate. Menu names vary by manufacturer.

Do not bypass certificate warnings. Trust only the certificate belonging to your shed. The public certificate endpoint does not serve the application database or private keys. Correct the Pi date/time before creating/restoring certificates. Normal operation and local certificate renewal do not require internet, but an offline Pi without a reliable clock may need its date corrected after a power loss.

## Services, updates and isolation

| Item | Test installation |
| --- | --- |
| Desktop app | LytGuide, bundled Electron desktop executable and maximized window |
| First-run wizard | LytGuide Shed Setup, local administrator approval |
| App service | `lytguide-test.service`, localhost port 3310 |
| HTTPS service | `lytguide-test-web.service`, private IP port 8443 |
| Certificate download | Private IP port 8444, public certificate only |
| Recovery timer | `lytguide-test-backup.timer`, every 15 minutes |
| Setup service | `lytguide-test-setup.service`, loopback port 3311, idle expiry |
| Responsiveness checks | `lytguide-test-watchdog.timer`, every 30 seconds after a check finishes |
| Persistent data | `/var/lib/lytguide-test/data/` |
| Configuration | `/etc/lytguide-test/` |
| Versioned application | `/opt/lytguide-test/releases/` |

The existing `inventory-management.service`, database, certificates and watchdog are not imported, replaced or automatically stopped. Before enabling real hardware in the testing installer, explicitly stop and disable the old app and any watchdog; the installer refuses shared hardware ownership. Select the actual USB adapter, preferably its stable `/dev/serial/by-id/…` path. Firmware flashing still requires a physical USB connection and the correct port.

For updates, install the newer kit/package, finish physical work, then explicitly activate it:

```sh
sudo lytguide-test update
sudo systemctl restart lytguide-test-setup.service
lytguide-test open
```

Before updating, finish any firmware operation and close Shed Setup. Restarting the setup service once after activation ensures it runs the new version; rebooting also does this. If an older setup process remains, the new launcher refuses its one-use authorization rather than silently mixing builds or interrupting a controller job.

Package installation stages a candidate without replacing the running release automatically. Activation snapshots existing data and preserves configuration/certificates; failed startup attempts to restore the previous state. Retained releases and snapshots use disk space. Removal stops only test integration and preserves its data/configuration/recovery copies.

## Automatic startup and recovery

After successful setup, the application and HTTPS services start at boot and restart after a process exits. The Pi's desktop session launches the bundled LytGuide executable in its own maximized window, using a dedicated LytGuide application profile. No Chromium installation or browser app-mode launcher is used. This does not bypass the operating system login; the desktop app runs as the signed-in desktop user. Closing the window leaves the shed service available to phones and tablets.

The watchdog checks the real application/database response and the HTTPS route. It allows 90 seconds for startup, requires three failed checks, then restarts only the unresponsive service. Recovery attempts are limited to three in 15 minutes, at least three minutes apart. It respects an intentional service stop, setup/restore activity and controller firmware maintenance; a missing Wi-Fi address does not cause an application restart. Status is recorded in `/var/lib/lytguide-test/watchdog-status.json` and the service journal. Recovery never restores a backup, resets stock or assumes that a physical movement finished.

The installer contains no customer database, shed backup or private shed certificate. **New shed** on a fresh card creates an empty shed and the administrator selected in the wizard. **Replace Raspberry Pi** restores only the backup explicitly selected by the user. Installing an update on a used card preserves existing data.

## Build on the development Mac

```sh
npm run package:pi:test -- --version 0.1.0~test.20261031.1
```

Prepare dependencies inside each matching isolated Bookworm/Trixie ARM64 build environment with `scripts/release/prepare-offline-dependencies.sh`, then build the kit with `scripts/release/make-offline-kit.py`, passing `--dependencies output/release-cache/offline-electron-bookworm-arm64 --dependencies output/release-cache/offline-electron-trixie-arm64`. Each set is resolved against an empty package status; the package indexes remain separate. Exact build and validation evidence is recorded in [the validation record](pi-test-package-validation.md).

[Raspberry Pi's OS documentation](https://www.raspberrypi.com/documentation/computers/os.html) distinguishes OS releases from Pi models. Future OS releases require matching dependencies and testing before being added to the supported list; a lower-bound version rule is not a compatibility guarantee.

Real Pi boot/desktop authorization, Wi-Fi changes, phone certificate/camera behavior, USB/RS485/LEDs and Finder visibility require field testing. Container/software checks do not certify these physical steps.

## Desktop application and repeating Setup

Open **LytGuide** in the Pi application menu. It runs the packaged Electron executable, with its own runtime, icon, application profile and native menus. It does not invoke an installed browser or use Chromium app mode. The shed interface is still built with web technology inside that dedicated runtime. Both the main app and Shed Setup use it; renderer Node access is disabled and the renderer sandbox stays enabled. Existing browser-based phone/tablet access remains available. The shed service stays running when the window closes, so local phones and tablets can continue using it.

Opening **LytGuide Shed Setup**, including running the graphical installer again, starts at **Get started**. It resets only the wizard checklist and invalidates other setup windows. Existing inventory, users, controller registrations, QR mappings, phone authority and recovery keys are kept. Choose **Set up existing shed** to repeat all checks without restoring data; **Replace Raspberry Pi** retains the explicit backup/reset choices. Firmware is never reflashed just because Setup is reopened.

Do not interrupt a restore or firmware job. Setup refuses a restart during these operations; beginning existing-shed configuration also requires work to be stopped. A page refresh keeps the current step. Opening the main LytGuide app while commissioning is unfinished continues the saved step; explicitly opening Shed Setup starts again.


## Optional location and QR setup

Activate an installed update and restart its idle setup service before continuing locations. **Continue location setup** on Get started or the completed wizard returns straight to this step; normal full setup still starts at Get started.

Select a controller and start/resume. A horizontal tab represents each physical LED in its verified routing order. Selecting one lights it with the existing red inward Locate pattern and makes the other outputs dark. **Show other LED numbers** keeps the other outputs yellow with their physical module numbers while the selected output flickers red at 500 ms intervals. **Show LED numbers**, **Ping all LEDs** (green outward, five seconds) and **Light all LEDs** (red inward) switch the controller-wide view. Ping restores the preceding view; choosing a tab or Re-Light returns to the selected output. Setup never takes over active Pick/Put or stocktake guidance.

Enter the name, shed and rack details and confirm the observed physical position. **Save and next light** saves and advances on the server, lights the next routed physical output and wraps back to LED 1 after the last output. Saved tabs are green. Older wizard checkpoints with the same controller configuration retain their saved verification and selected output when resumed. Fields are prefilled when revisiting a saved bin; browser drafts are kept per output. A failed save stays on the current LED and shows the reason beside the form. Hardware delivery failures do not claim the LED was verified; use Re-Light after restoring the connection.

**Assign QR later** saves the hardware binding without a camera or scan, preserving any QR already assigned. QR-pending bins stay visible in Manage Locations for a trusted phone/tablet to scan later. QR uniqueness, reassignment and stock-history safeguards remain in place.

**Not lighting / skip for now** leaves that output unfinished and advances. **Save and continue later** releases the controller's setup lights without losing saved bins or the selected output. The bottom **Continue** checks saved progress: unfinished locations require confirmation to save the current state and continue later. There is no separate Finish this setup session action. Unnamed/skipped outputs are never marked physically verified. Controller and protected recovery checks remain mandatory outside explicit simulation mode.

## Complete uninstall and reinstall recovery

Use **Uninstall LytGuide.run** in the complete kit or **Uninstall LytGuide** in the Pi application menu. The executable asks **Delete all LytGuide-managed backups too, including the new copy? [y/N]**. Enter keeps them; only Y/Yes deletes them. A latest consistent shed snapshot is created and checked before the installed package, services, application files, shed database, settings and normal desktop profiles are removed. A failed snapshot aborts deletion. Running firmware operations and interrupted restores must be finished first. ESP32 firmware and shared OS dependencies are not erased.

The latest uninstall copy is saved as `LytGuide-Uninstall-*.lytbackup` in the Mac-readable SD recovery folder, normally `/boot/firmware/LYTGUIDE-RECOVERY`. Its name excludes it from automatic backup rotation when a fresh shed is created later. If the boot recovery volume is unavailable, the copy is retained on the Linux disk at `/var/backups/lytguide`; this fallback is detected by Setup but is not directly readable in Finder. Older internal recovery points are also retained in root-only `uninstall-recovery-*` folders there. Y removes these application-managed copies as well; unrelated files, manual exports elsewhere and the downloaded installer are preserved.

The kit’s Uninstall LytGuide.run is self-contained and can be copied by itself. It extracts its checked program and backup helper temporarily, allowing it to remove earlier installed test builds using their existing Node runtime. It does not require the old CLI to already support `uninstall`. On reinstall, Get started offers an explicit Yes/No when a retained backup is found. Yes follows the replacement path and preselects that file after network checks. Restore also lists detected files and provides the native file picker to browse the Pi for any other `.lytbackup`. Selection stages a copy without moving the original; changed files and symbolic links are rejected. Recovery password, backup inspection and explicit restore confirmation remain required. No opens the usual new/existing setup choices and does not erase retained backups.
