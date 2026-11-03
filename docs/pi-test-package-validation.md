# Raspberry Pi offline setup validation — 3 November 2026

## Current artifacts

| Artifact | Value |
| --- | --- |
| Application | `output/pi-test/lytguide-test_0.1.0~test.20261103.5_arm64.deb` |
| Application size | 1,312,991,910 bytes |
| Application SHA-256 | `7d9e848a4af496bc52c4f1e371a160a29164bab2ff64b23314b9c149326a3aec` |
| Complete offline kit | `output/pi-test/offline/LytGuide-Pi-arm64-0.1.0~test.20261103.5.tar.gz` |
| Offline kit size | 1,509,616,747 bytes |
| Offline kit SHA-256 | `edbc1c8d5b36ee678c9a23842caa894fb88452645a40b1b67bda0e016c36abbb` |
| Single-file uninstaller | `output/pi-test/Uninstall LytGuide.run` · 23,317 bytes |
| Uninstaller SHA-256 | `451b12bf0fb18aabc6b1c944f253dbf199a04047b0127981359972688db16461` |
| OS targets | Raspberry Pi OS Desktop Bookworm (Debian 12) and Trixie (Debian 13), ARM64 |
| Included OS dependencies | Separate repositories: 219 Bookworm and 223 Trixie ARM64/all packages; checked package indexes and SHA-256 manifests. Shared application stored once |
| Source base | `e191a2580bcbd4b2339dbd7019dd748d47825919`, `public-product-development`, including the preserved working-tree changes |
| Activation/licensing | Deferred; this testing build has no copy protection |

Use the complete kit for installation without internet. The `.deb` alone does not carry the external OS dependency packages. The kit includes the dedicated Electron application and its runtime dependencies; customers do not need Chromium, Git, npm or a separately installed Node runtime. See [the setup guide](pi-test-installer.md).

## Controller commissioning and recovery — build 20261103.5

All **837 regression tests passed**, with zero failures or skips. This release adds explicit Update firmware / LED count and Replace ESP32 choices, editable physical counts with safe end-of-chain resizing, durable maintenance status, restart recovery, configuration error messages, and controller selection/defer controls in Warehouse Setup. Boards can be added sequentially using the same USB cable, including bridges with duplicate factory serials. Existing locations, QR identities, inventory, assignments and history stay attached to the logical controller.

Flashing uses a slower 115200 upload speed and a bounded ten-minute compilation allowance. USB confirmation waits for boot and handles partial writes, fragmented JSON, missing acknowledgements and firmware errors. ROM MAC is checked before compiling, before uploading and again afterward; the last identity check resets the board, then verifies that its complete setup persisted. A damaged original application can be reflashed using its verified host profile. A healthy but unexpectedly changed route is refused rather than silently overwritten. Unverified uploads retain a recovery hold through further failed retries; compile failures release their hold.

Verification performed:

- Source native Electron clicks: four fresh LED locations save/advance; two boards sharing one USB serial add sequentially; a desktop count increase and a phone-sized replacement preserve logical controller identity. The serial controller is a transport double, not a physical ESP32.
- Real ARM64 offline Arduino toolchain: ESP32 firmware compiled with networking disabled. CLI 1.3.1, ESP32 core 3.0.7 and NeoPixel 1.12.4; sketch 321,217 bytes, static memory 43,200 bytes. Upload-speed override support checked against the bundled CLI.
- Real Linux pseudo-terminal: serial flags, dropped first request, fragmented responses, nonce matching and immediate configuration-error propagation. Reusable probe: `test/fixtures/pi-package/controller-serial-check.mjs.fixture` (container-only).
- Clean Trixie ARM64 complete-kit installation with OS dependency packages and no internet; new-warehouse wizard, local HTTPS and encrypted recovery copies passed on the preceding candidate with identical installer logic. Final .5 installed and updated this existing warehouse successfully; all 26,189 release files verified. Accounts, locations and certificate identity compared unchanged before any subsequent test fixtures added controllers.
- Final installed native ARM64 application: real Controller Health form/redirect and background fetch passed, with missing/null/foreign origins still rejected.
- Final archive: safe paths, complete gzip CRC, all 453 payload hashes, SHA-256 sidecar and executable Install/Uninstall launchers passed. Both Bookworm and Trixie dependency sets remain included; this turn's installed runtime check used Trixie.

Evidence is retained under `/private/tmp/lytguide-controller-audit/`. The superseded .4 candidate created in this turn was removed; .5 is the deliverable. No development commit, push, unrelated worktree cleanup or warehouse deployment was performed.

**Field validation remains required:** actual Pi USB/BOOT/reset behavior, RS485 bus wiring and unique powered addresses, real LED counts/order, power cycling and unplug/retry scenarios. Software checks cannot eliminate cable, power or board faults and do not claim a physical firmware upload occurred here.

## Controller form origin fix — build 20261103.3

All **815 regression tests passed**, zero failed or skipped. A real Chromium test reproduced the reported message before the fix: native navigation POSTs from the same-origin controller iframe sent `Origin: null` under Setup's `Referrer-Policy: no-referrer`. Background fetch POSTs sent the proper local origin, explaining why some controller actions worked while others failed.

Setup now applies `Referrer-Policy: same-origin` to its own responses and proxied controller pages/redirects. This retains same-origin form identity while withholding referrers from foreign origins. **Origin validation was not relaxed:** loopback/Host checks, OS-authorized one-use grants, strict HttpOnly cookies, route restrictions and rejection of missing/null/foreign origins remain intact. Tests also verify that upstream response headers cannot reinstate the incompatible policy.

The native browser fixture verifies both localhost and 127.0.0.1, real form submissions and their redirects, background fetches, and rejection of an untrusted same-site page posting a null origin. The installed Trixie ARM64 native app reproduced the failure on build 20261103.2 and then passed the same real Controller Health form after updating to 20261103.3. Its background request worked, and authenticated requests with missing/null/foreign origins remained blocked. Hardware was simulated; no real firmware or LED was changed.

The update preserved user IDs/password hashes/roles, controller registrations, cell names/QR mappings and the phone certificate. **All 26,189 installed release files verified.** The combined archive passed CRC, path checks, every payload checksum, executable installer/uninstaller checks and its independent SHA-256. Close Setup before updating and reopen it afterward: an already loaded document retains its previous referrer policy. Apply `sudo lytguide-test update` and restart `lytguide-test-setup.service` after installation. No firmware flash or certificate reinstallation is needed for this fix.

## Editable administrator credentials — build 20261103.2

All **814 Node regression tests passed**, with zero failures or skips. The new cases cover short passwords (including 1234), account-ID/role/task-history preservation, old-session invalidation, blank-password retention, duplicate usernames, operator-target rejection, fresh blank-warehouse bootstrap, fresh reset credentials and a transient writer lock. The credential bootstrap and setup readers use the standard five-second SQLite busy timeout. Recovery encryption password validation is separate and unchanged.

The actual installed Bookworm ARM64 Setup API and CLI created a warehouse with a four-character password, renamed the existing administrator and set 1234, accepted the new HTTPS sign-in and rejected the old username/password. Mismatched confirmations and an occupied username were rejected; an injected service-start failure restored the prior credentials. A further username-only change with blank password retained its existing hash. Historical task/account IDs, the other operator, the phone certificate and the recovery-encryption profile were preserved. Setup state/configuration/audit did not contain the passwords. The local OS approval and loopback-only setup access are unchanged.

The packaged Trixie native application exercised the real Administrator form: existing credentials are editable, there is no minimum-length guidance, a confirmation mismatch stays on the form, and 1234 saves successfully. Screenshots at 1280px and 390px were inspected: output/pi-test/administrator-desktop.png and administrator-mobile.png. **All 26,189 installed release files verified on Bookworm and Trixie.**

**GUI-test limitation:** the isolated Bookworm native window exited with signal 133 before drawing this form, including after starting the container's system message bus. Its main desktop bundle and executable have identical SHA-256 hashes to build 20261103.1; no desktop-runtime workaround was shipped. The Bookworm installed credential/login flow passed, and the Trixie native form passed. This does not confirm actual Pi graphics/desktop startup.

The final complete kit passed gzip CRC, safe-path checks, all payload checksums, executable-launcher checks and independent archive SHA-256 verification. Both installer and self-contained uninstaller are included. Existing installations can install this kit, run `sudo lytguide-test update`, restart `lytguide-test-setup.service`, and reopen Warehouse Setup. At Administrator, enter the new username and optionally a new password; no uninstall or data reset is needed.

## Controller and fresh-location setup fixes — build 20261103.1

The full **804-test regression suite passed** with zero failures or skips. The final offline-kit regression also passed after asserting executable permissions for both launchers and install.sh inside the archive.

Two reproduced defects are covered:

- Newly configured LED outputs are inactive placeholders, absent from normal Locations. The old setup form therefore submitted revision zero instead of the output's real revision, and the server rejected Save. The setup-only snapshot now includes the actor's inactive controller outputs, without publishing them as ordinary locations. Native mouse-click tests save four fresh cells and advance automatically; valid existing cell names remain prefilled. Required-field errors are visible, QR can be deferred, and returning to Controllers releases setup lights first.
- Different ESP32 boards can share a USB bridge serial. Registration now verifies the board's ROM MAC through the checked offline esptool, verifies it again before upload, and keeps this identity with its controller. Three different boards using the same USB serial register separately in integration tests; a repeated physical board and a board swap during compilation are rejected before upload. Legacy shared-serial records require confirmation of a different connected board and a probe of the old address. The successful-upload dialog offers Add another controller and refreshes the outer wizard's controller count.

The actual native client was exercised against synthetic USB devices and the real firmware service, with two sequential controller additions through the full on-screen wizard. A packaged Trixie ARM64 native-window test, with renderer sandbox enabled and a test-only virtual display, verified fresh inactive LED creation, optional QR, visible validation, real Save clicks, next-output advancement, retained per-LED drafts, reversible number/Ping/Locate controls, pause/continue and 1280px/390px layouts. Screenshots: output/pi-test/setup-fix-desktop.png and setup-fix-mobile.png.

The final package updated Bookworm ARM64 from build 20261031.6 while preserving locations, catalog, user credentials/roles and the phone certificate. It also installed using the offline Trixie dependency repository. **All 26,189 installed release files verified on both OS targets.** The bundled ESP32 ROM tool imports and runs offline on both Python environments. Service/network/card discovery and USB hardware were test doubles; initial container-only service/display fixture restrictions were corrected for the checks, without weakening the shipped app sandbox.

The complete archive passed gzip CRC, path checks, all **453 payload checksums**, executable-launcher checks and its independent SHA-256 comparison. It contains Install LytGuide.run and the unchanged self-contained Uninstall LytGuide.run. Existing installations should close the app/Setup windows, install the kit, apply `sudo lytguide-test update`, restart `lytguide-test-setup.service`, and reopen Warehouse Setup. No uninstall or warehouse reset is required.

Physical ESP32 ROM communication/flashing, RS485 wiring, LEDs, real Pi graphics/boot, cameras, phones and SD-card recovery remain field validation. No real controller was flashed in these checks.

## Complete uninstall and detected-backup restore — build 20261031.6

All **796 regression tests passed**, zero failed or skipped. Tests cover default-No backup retention, explicit Yes deletion, snapshot-before-purge ordering, blocked firmware/interrupted restore cases, backup failure preserving the installation, designated-directory discovery, stale/symlink rejection, checked staging without moving originals, safe removal of managed copies, retained uninstall copies surviving normal rotation, Yes/No installer choices, native file input availability and self-contained executable packaging. Existing warehouse workflow tests remain in the full suite.

The final `.deb` installed offline on Bookworm and Trixie ARM64, and **26,189** release files verified on each target. A standalone uninstaller also removed the previous installed build using its existing runtime and saved its protected database, QR/hardware mappings and phone authority. A deliberately missing certificate key blocked backup and prevented uninstall, leaving data and the application present.

The exact final uninstaller then removed a configured Bookworm installation with the default Enter/No answer, keeping all previous portable copies and a fresh `LytGuide-Uninstall-*.lytbackup`. After reinstalling the final package, Setup discovered the retained file. API checks exercised dismissing the suggestion, restarting Setup, choosing Yes with automatic staging after network checks, choosing another detected file, uploading an independently selected file, wrong-password rejection, successful inspection and explicit restoration. Source backup files remained byte-for-byte unchanged.

A second complete round trip used an actual HTTPS sign-in and Pick workflow to record **1 of 3** items before uninstall, rather than relying only on seeded rows. The final package was uninstalled, reinstalled and restored again. Comparisons preserved physical stock and reservation cache totals, user password hashes/roles/status, location and QR records, stable controller configuration, movement transactions, task requested/actual quantities and the phone certificate authority. The controller heartbeat timestamp legitimately refreshes after restart and is excluded from that comparison. Unfinished work remains for review under the existing recovery rules.

The installed native Electron Setup window passed at **1280×960** and **390×844**, with no page-width overflow: detected-backup prompt, No choice, another detected selection and an actual native file-input upload via the desktop test protocol. Images: `output/pi-test/backup-found-desktop.png`, `backup-found-mobile.png`, `backup-browse-desktop.png` and `backup-browse-mobile.png`. The real file selected through the input was retained. A clean new-warehouse path kept the old uninstall backup unchanged across three later normal backups.

The single-file executable was copied alone to Trixie and run with explicit Y. A test-only unavailable-boot-volume simulation verified a fresh protected fallback copy at `/var/backups/lytguide` before package/data/config removal; managed SD and Linux recovery copies were then deleted. An unrelated manual export in the user's home remained. No ESP32 flash or erase command is involved.

Final application, kit and executable hashes were independently checked. The kit passed gzip CRC and tar structure checks, ordinary-user GNU tar extraction, executable-permission checks and every extracted-file checksum. The exported one-file uninstaller matches the executable inside the complete kit. Repeatable fixtures: `uninstall-check.py`, `restore-discovery-check.py`, `backup-selection-ui-check.sh` and `test/fixtures/desktop/backup-selection-ui.cjs.fixture`.

These checks use disposable ARM64 OS targets, synthetic warehouse data and test service/volume doubles. Actual Pi desktop authorisation, real SD-card/Finder behavior, USB/RS485/firmware and the previously reported app-startup issue still require field validation. The production native runtime and graphics settings are unchanged.

## LED tabs and commissioning controls — build 20261031.5

All **785 regression tests passed**, with zero failures or skips, against the final production source. New tests cover four-LED save/advance and wrap to LED 1; non-sequential verified routing; one selected red Locate output with other outputs dark; optional yellow module numbers plus red flicker at 500 ms; all-output Locate and five-second green Ping with restoration; stale/replayed actions; failed delivery; skipped/revisited cells; changed controller configuration; and preservation of older wizard checkpoints. Failed flicker delivery stops rapid retries and prevents physical verification until Re-Light succeeds.

The final kit installed with networking disabled on Bookworm and Trixie ARM64, then activated on an isolated test LAN with no internet. Update comparisons preserved all synthetic users, products, cell records, inventory balances, QR bindings and the phone certificate authority. On both OS versions an older-format commissioning checkpoint with LED 1 saved and LED 2 selected survived the update: resuming retained the same session and verified cell, lit LED 2, then saved LED 2 and advanced to LED 3. The new profile-aware fingerprint is adopted without erasing valid legacy progress; a genuinely changed configuration remains guarded. Repeatable fixture: `test/fixtures/pi-package/location-upgrade-check.py`.

A clean Trixie target exercised fresh new-warehouse setup, local HTTPS, protected recovery, deferral, Setup service restart and later QR assignment before the final compatibility patch, then received the exact final kit offline. Its actual bundled Electron Setup window passed the complete UI fixture again against the final installed files: four scrollable LED tabs, automatic save/advance, separate per-output drafts, visible inline errors, optional QR controls, reversible display modes, timed Ping restoration, selected-tab scrolling, and Go back / Save and continue for unfinished locations. At 1280×960 and 390×844 there was no page-width overflow or clipped LED-tab content. Images: `output/pi-test/led-tabs-setup-desktop.png` and `led-tabs-setup-mobile.png`. The tab-height override is scoped to commissioning selectors; existing task screens retain their styles. Virtual-display software rendering is test-only.

Every one of the **26,188** installed release files verified on all three final targets. The final `.deb` and kit SHA-256 sidecars were independently checked. The kit passed gzip CRC, tar structure, ordinary-user GNU tar extraction and all extracted-file checksums. UI/API fixtures and the full suite remain in the repository. No warehouse data or certificate private key is included in the installer. The dedicated application, controller firmware and existing recovery safeguards remain intact.

These are software/container checks using synthetic data and simulated LEDs. Physical Pi boot/graphics, the previously reported startup crash, USB/RS485 delivery, actual 500 ms flicker, LED order/brightness, camera and warehouse Wi-Fi still require field validation. No new firmware protocol or physical-Pi graphics workaround is introduced by this change.

## Location setup and optional QR assignment — build 20261031.1

All **776 regression tests passed**, with no failures or skips. The complete kit installed offline again in isolated Bookworm and Trixie ARM64 targets. Each installation completed the real new-warehouse wizard, including local HTTPS and protected recovery, then passed the new deferred-location API checks. All **26,188** release files verified unchanged on both targets afterward.

**Set up locations later** allows unfinished cell setup to be deferred before Finish. **Assign QR later** saves an explicitly observed LED binding and the cell name/warehouse/shelf without requiring a camera. Existing QR assignments remain unchanged, and unscanned identities remain QR-pending even after schema migration. Setup sessions retain their next output when paused. The step’s lights are released when the location step is left; reopening Setup offers **Continue location setup** without repeating network/account commissioning. Hardware/controller and recovery checks remain mandatory outside explicit simulation mode.

Installed API fixtures verified finishing a deferred step, restarting the Setup service, returning to the next output, preserving the saved names/mappings and phone authority, and assigning a customer QR later through the normal location API without changing the hardware binding. Stock/history preservation, ownership, stale revisions, idempotent saves, QR replacement and count/work guards remain in the regression suite. These tests use synthetic controllers and the simulator, not physical RS485/LEDs.

The actual bundled Electron runtime also exercised the installed Setup interface: direct resume, switching the QR-required controls on/off, saving a cell with no camera/QR, and finishing later. Desktop (1280×960) and phone-width (390×844) renders had no page-width overflow. Screenshots: `output/pi-test/location-setup-desktop.png` and `location-setup-mobile.png`. Virtual display/software rendering are test-only; no new graphics workaround is shipped.

The new tar.gz passed independent SHA-256, gzip CRC and tar-structure checks. GNU tar extracted it as an ordinary user in the Bookworm target, and every extracted file passed the kit checksum manifest. Test records: `test/fixtures/pi-package/location-deferral-check.py`, `location-ui-check.sh` and `test/fixtures/desktop/location-setup-ui.cjs.fixture`.

**The separately reported physical-Pi app-startup crash is still unresolved.** This build does not claim to fix it; the requested Pi crash log is still needed. Real Pi desktop/graphics, camera, controller/RS485, Wi-Fi and SD-card checks remain required.

## Dedicated application validation — build 20261030.1

| Check | Evidence |
| --- | --- |
| Full regression suite | **772 passed**, zero failed, zero skipped, with the final production source and package scripts |
| Native desktop runtime | Official Electron 45.1.0 Linux ARM64 archive verified against its pinned SHA-256; app executable, native menus, branded icon and separate app profile bundled. No Chromium app-mode invocation |
| Offline installation | Exact final kit installed in clean Debian 12 and Debian 13 ARM64 containers with networking disabled. Native dependencies resolved from each selected OS repository; no Chromium package installed |
| Package integrity | All **26,188** release files passed verification on each installation, including after the actual native application tests |
| Sandbox helper | Final post-install verifies the release, then explicitly sets the root-owned sandbox helper to mode 4755. Both exact installs checked. No `--no-sandbox` switch or disabled renderer sandbox |
| Commissioning | Both installed targets completed the new-warehouse setup API and then repeated the existing-warehouse checklist. Synthetic product/stock, users, location/QR data, recovery profile and phone CA/key remained unchanged |
| Repeat Setup | Explicit reopen starts at Get started and invalidates older setup sessions. Refresh/internal resume retain the current step; restore/firmware/maintenance guards prevent unsafe restarts |
| Interrupted commissioning | Trixie injected account-start failure, service restart and retry retained the selected administrator and completed successfully |
| Real app window | Both OS targets ran the actual packaged ARM64 executable as a normal user on a virtual X display. Real production sign-in through the form retained a Secure localhost session and fully rendered My Work before capture; Products, Locations, Stocktaking, History and System also opened authenticated |
| Native integration | Actual Electron renderer had no Node/process access; context isolation and sandbox enabled. Synthetic video permission allowed, microphone denied, user-gesture clipboard write allowed/read denied, PDF rendering and CSV download passed |
| Startup and handoff | Actual startup, Linux application identity and single-instance reopen passed. Authorized Setup uses a separate memory-only cookie partition; finishing opens/reloads the app internally, including from the pending-setup screen. Unsaved Stay/Leave behavior passed |
| Service continuity | Closing the app left the actual installed warehouse backend responding. Exact installed Node/Caddy freeze/recovery tests, maintenance safeguards and intentional-stop protection passed again on both OS releases |
| Removal | Removing the final Bookworm package removed its launchers and privilege bits on retained sandbox helpers, while preserving warehouse records, administrator, certificate identity and recovery keys |
| Artifacts | Independently recomputed application and complete-kit sizes/SHA-256 values match the sidecars. The installer guide is the same short text used in the installed package and START HERE file |

Native checks are retained in `test/fixtures/desktop/*.cjs.fixture`, `test/fixtures/pi-package/native-window-check.sh` and `native-remove-check.py`. Screenshot: `output/pi-test/standalone-app.png` (actual installed runtime, synthetic warehouse). The `.fixture` extension prevents integration entry points being executed as ordinary Node unit tests.

Virtual-display tools and the test user were isolated test infrastructure, not part of the customer installer. Bookworm additionally installed standard Xvfb/X11/font test tools after the offline installer check; this added 44 packages with **zero upgrades/removals** of the installed app dependencies, then internet was disconnected again. Trixie used a separate matching display-tool bundle. Container namespace permissions allowed testing the real Electron sandbox; the application sandbox itself was never disabled. These environments cannot prove an actual Pi desktop session, GPU/Wayland behavior, Polkit prompt or real systemd boot.

Validation caught a sandbox-helper permission problem in rejected build `20261029.8`; it was not delivered. The fixed `20261030.1` installer explicitly repairs the helper after integrity verification and passed both final installs. Test-harness corrections included dual-stack fake local servers, a normal desktop message bus, and submitting the real sign-in form instead of a manual URL-navigation POST. They did not change production authentication or remove its Secure cookie flag.

No customer Pi or physical ESP32 was accessed. The previously reported USB controller-confirmation failure is still a separate field issue; this desktop packaging change does not claim to resolve it. The field-validation checklist below remains required. Windows packaging and licensing remain deferred.

## Earlier wizard validation (through build 20261029.7)

The following matrix records the prior wizard/recovery baseline. Its regression coverage remains in the 772-test suite; physical checks and older packaged integration runs are not presented as new physical-device validation.

| Check | Evidence |
| --- | --- |
| Full regression suite | **768 passed**, zero failed, zero skipped, after the final application changes |
| Reset choices | All four combinations of Clear stock & work / Start fresh and retained / cleared controller-cell-QR setup passed database and packaged-wizard checks; full restore remains the default |
| Fresh controller reuse | Blank/previously used boards use an explicitly confirmed setup path; seven new tests cover saved-layout faults, different healthy routing, missing confirmation, permissions, registered-board refusal, damaged replies, failed persistence and lost ACK readback |
| Existing controller connection | Read-only RS485 tests cover verified v13/v15 responses, routing gaps, permissions, duplicates, wrong addresses, invalid checksums and unsupported firmware; no upload, erase or configuration-write commands |
| OS packaging regression checks | Three new tests cover explicit tested-OS support, shared application/separate repositories and checksums, duplicate sets, changed dependencies and unsupported releases. Existing installer/recovery/wizard checks, including the Python portable-recovery wrapper, remain in the full suite |
| Offline dependency preparation | Each OS's signed Debian repositories resolved ARM64 dependencies against an empty installed-package status, so preinstalled build-image dependencies were not omitted |
| Real offline installation | The same final kit installed on Debian 12 and Debian 13 with networking set to `none`. Missing NetworkManager, polkit/pkexec, python3-serial and Chromium were installed from the selected local OS set; a third independent Bookworm installation verified replacement |
| Final package integrity | Exact `.deb` installed on both OS releases; all 26,113 release files passed integrity verification independently |
| New-warehouse path | On both OS releases the exact kit completed choose → system → network → administrator/recovery → phones → controllers → locations → finish through its real setup HTTP API |
| Clean warehouse | Before commissioning, no sample products, cells, controllers, inventory balances, tasks or default operator; only the selected administrator. A base internal zone permits adding the first location |
| Real commissioning routes | Authenticated embedded controller setup section and location snapshot worked; added the first manual location through the actual location setup API |
| First-boot filesystem protection | Reproduced failure to create the recovery folder under a read-only boot mount. The packaged local authorization helper prepares it before starting the service; Linux mount-namespace checks confirm that folder is writable while other boot files remain protected |
| First-setup retry | Injected initial application startup failure after creating the administrator, restarted the setup service and authorized again; the chosen username survived and retry completed successfully |
| Compiler permissions | Actual bundled ESP32 sketch compiled as the application user with installed tools bound read-only and a private writable temporary filesystem. Result: 321,121-byte sketch, no controller flashed, no internet |
| Incomplete certificate identity | Removed the root key in the disposable warehouse, checked that backup failed and retained every prior card backup, restored the key and confirmed successful retry |
| Controller readiness | Regression checks reject missing, malformed, old, future and offline controller replies; an old online label alone cannot pass readiness |
| Completed setup | A completed wizard rejects requests to reopen earlier commissioning steps without re-entering a setup lifecycle |
| Pending-setup gate | Main app `/work` redirected to setup waiting while pending; normal stock mutation was blocked. Authenticated setup proxy could not perform stock operations even after Finish |
| Local HTTPS | Bundled Caddy served actual app login using certificate verification; the isolated certificate-download endpoint served only the public DER certificate |
| Protected recovery | New-warehouse Finish created password-protected SD-card recovery copies; automatic creation did not require entering the password again |
| Replacement path | Independent installation completed choose → system → network → restore → phones → controllers → finish, using an encrypted export from the source installation |
| Wrong password | Backup inspection rejected the wrong password; protected payload was not accepted |
| Failed restore activation | Injected an app-start failure after certificate/data replacement. Restore reported failure, restored the previous certificate/configuration/data and cleared its interruption marker; retry then succeeded |
| Stock and task recovery | The transferred snapshot retained the known physical stock total of 4 and the original account; unfinished task became `needs_review`, without changing recorded stock |
| Certificate continuity | Restored root certificate bytes exactly matched the source. HTTPS at the replacement's different private IP verified using the source authority, without bypassing TLS verification |
| Actual restored sign-in | Original owner/password signed in over real verified HTTPS. Verified 19 main pages, client assets and generated QR SVG, recorded a Put, completed a Pick automatically and replayed the original Put request without double counting; final stock returned to 4 |
| Secret handling | Setup status responses did not contain administrator/recovery test passwords. Unit checks cover public-key-only automatic encryption, wrong password, modified ciphertext and temporary-file cleanup |
| Local setup security | One-use local authorization grant, strict loopback Host/Origin checks, HttpOnly SameSite setup session and serialized jobs tested through an actual HTTP server |
| Service definitions | `systemd-analyze verify` passed all seven app, HTTPS, recovery, setup and responsiveness-check service/timer definitions |
| Unresponsive application | Sent SIGSTOP to the real packaged Node process; the packaged watchdog restarted it, restored actual database readiness and preserved recorded inventory |
| Unresponsive HTTPS | Sent SIGSTOP to actual Caddy; the watchdog restarted only HTTPS. App PID, stock and certificate authority were unchanged; verified HTTPS worked afterward |
| Safe recovery boundaries | Live firmware owner, pending setup, interrupted restore and the configuration lock prevented recovery restarts. An intentional app stop remained stopped |
| Desktop startup contract | Packaged autostart command, invoked as a normal desktop user, launched the correct maximized URL/profile using a recording browser double. Pending setup suppressed it. No real desktop session was simulated |
| Visual inspection | Both entry paths, the check/network steps and administrator/recovery form inspected in the browser. Screenshot: `output/pi-test/setup-wizard.png` |
| Source consistency | `git diff --check` passed; unrelated existing application/controller edits preserved |

The source and replacement used different container-only private IPs. No host ports were published and no customer's Pi was contacted. Tests selected the wizard's explicit **simulated lights** option; they did not fake a successful physical hardware check.

The container service helper started the actual packaged Node/Caddy processes under their dedicated users. Service management, NetworkManager discovery and FAT-mount discovery were test doubles, because the containers do not have a Pi desktop, real systemd boot, Wi-Fi adapter or SD card. These helpers are test fixtures and are not shipped. The offline installer check initially exposed the test helper's absence from APT's restricted executable path; putting the helper at that path fixed the harness. No production installer workaround was introduced for this.

Integration testing also found and corrected the public certificate endpoint's Caddy block syntax, status polling while a fresh database is being created, the controller wizard's hash-based route and the base zone needed to commission an empty warehouse. The current artifacts contain those corrections. Revalidation also corrected first-boot recovery-folder creation, the app service temporary filesystem for compilation, validation of controller reply timestamps, rejection of backups missing the phone identity, and preservation of the selected administrator on retry. The Trixie-only `20261028` kits are superseded; use the universal `20261029.7` kit for Bookworm or Trixie.

## Prior packaging/recovery coverage retained

The preceding `20261027.5` installer was tested for actual offline ARM64 firmware compilation using the same bundled SDK versions, packaged inventory Pick/Put and idempotent requests, release activation rollback, legacy hardware ownership refusal, snapshot/WAL and archived-history recovery, corrupt/unsafe archives, dead-process lock recovery, interrupted-restore boot guard and newest-two card-copy rotation with size/free-space limits. Those source tests remain in the full suite. Those earlier builds used Node 24.22.1, Caddy 2.11.7, Arduino CLI 1.3.1, ESP32 core 3.0.7 and NeoPixel 1.12.3. The current build upgrades NeoPixel to 1.12.4 as described below. No ESP32 was physically flashed in these checks.

The new wizard's backups are encrypted/authenticated and include the warehouse certificate identity. Legacy data-only command-line backups remain supported; they are unprotected unless a recovery password profile has been configured and cannot preserve an authority they did not contain. The installer itself contains no customer database, recovery password, private warehouse CA or development repository.

## Field validation still required

1. Install on an actual Pi OS Desktop Bookworm/Trixie card, open the launcher, approve the local administrator prompt, close/reopen Setup and reboot; confirm real service hardening, startup order and automatic maximized window after the desktop session starts. Confirm the watchdog timer is active and perform a controlled service-recovery check before production use.
2. Test actual Ethernet/Wi-Fi connection changes and router address reservation. Disconnect WAN and verify continued local phone/tablet work.
3. Trust the public certificate on real iPhone/Android devices, compare the fingerprint, test QR camera permissions and repeat on a replacement Pi using the protected identity.
4. Stop/disable any legacy hardware writer; select the real USB RS485 adapter. Test controller replies, offline USB flashing, routing, LED numbers/colors and scan/name/pair setup. Software simulation does not verify these.
5. Check the boot volume in Finder, successful-copy timestamps, available FAT space, automatic timer and an off-card backup. Perform a spare-Pi replacement and reconcile any movements after the snapshot.
6. Confirm Pi date/time after power loss. Correct it before creating/restoring certificates if the device lacks a reliable clock.

Container checks cannot certify camera, Wi-Fi coverage, FAT power-loss behavior, physical stock or real hardware readiness. The result is a verified **software testing installer**, awaiting those device checks. The additional Linux mount-namespace tests exercise the filesystem restrictions directly, but they do not replace real systemd boot and Polkit/desktop testing on a Pi.

## Repeated validation with the shorter guide

The user requested another complete pass. Build `20261028.6` was rebuilt with a 334-word installation guide; the same text is generated as `START HERE.txt` in the offline kit. Detailed support information is retained separately in [the technical reference](pi-installer-reference.md). No application behavior changed in this repeat.

Fresh ARM64 environments again passed all 734 regression tests, installation with networking disabled and setup dependencies absent, the new-warehouse path with injected startup failure/reopening, independent replacement with wrong-password and failed-activation rollback checks, original-authority HTTPS verification, 19 main pages and assets, actual recorded Put/completed Pick/replay, protected backup failure/repair checks and actual offline firmware compilation under the filesystem restrictions. All service definitions passed validation again.

The guide was extracted from the actual Debian package and compared byte-for-byte with the source; the kit's plain-text instructions also matched. The slim test OS intentionally excludes installed `/usr/share/doc` files, so an initial comparison at that installed path reported it missing. Direct package extraction verified that the guide is correctly shipped. The technical test logs retain this distinction.

The remaining real-device checks above still apply. The current package and complete kit checksums were verified after the repeat.

## Automatic startup and responsiveness recovery

Build `20261028.7` adds desktop autostart and bounded recovery for unresponsive application/HTTPS processes. The 352-word guide retains the simple installation steps and adds two sentences about startup. The installer still includes no warehouse data or backup; the new-warehouse fixture checks their absence before setup, then verifies empty products, cells, controllers, balances and tasks with only the chosen administrator. The replacement fixture explicitly supplies its synthetic encrypted backup.

Both installations of the exact final kit ran with networking disabled and missing setup dependencies/Chromium. Both wizard paths, interrupted administrator setup, wrong-password rejection, restore rollback, original-authority HTTPS, real sign-in/pages/assets, Pick/Put/replay, protected-backup failure/repair, protected boot-folder permissions and offline firmware compilation passed again. The replacement harness initially lacked `/run/systemd/system`; adding that directory to the disposable service double allowed the platform preflight to run. No installer change was made for that harness omission.

The responsiveness acceptance test uses actual packaged Node and Caddy processes, freezes each with SIGSTOP and invokes the shipped watchdog. It seeds two previous failures and an elapsed startup grace to avoid waiting through the production interval; separate unit tests exercise the actual three-failure, 90-second grace, three-minute cooldown and three-attempts-per-15-minute rules. Both recoveries retained the database; the HTTPS-only recovery also retained the running application PID and the exact authority bytes. A verified HTTPS request passed after recovery. Maintenance and intentional-stop safeguards passed.

The desktop test replaces Chromium only inside the disposable container with a recording stub, runs autostart as a normal non-root user, checks the maximized app URL/profile and checks pending-setup suppression. XDG autostart support is documented by the [Raspberry Pi OS maintainers](https://www.raspberrypi.com/news/a-new-release-of-raspberry-pi-os/); actual Pi OS Desktop startup, window management and login behavior remain field checks. The installer does not change OS autologin settings.

The new focused always-on suite passed seven tests; all 741 tests passed in the full suite. All seven installed systemd definitions passed static verification. The exact Debian package's short guide and the kit's generated text matched the canonical guide; package and archive SHA-256 values above were recomputed. Test containers and their isolated network were removed after validation.

## One kit for Bookworm and Trixie

Field diagnostics showed that the user's Pi actually runs Debian 12 Bookworm ARM64. The older Trixie-only installer correctly stopped at its OS check, but did so before creating its log. Build `20261029.1` now contains one shared app and two independently prepared, checksummed dependency repositories. The installer reads the actual OS and exposes only its matching repository to APT. It keeps the existing OS release and rejects 32-bit systems, unsupported releases and missing dependency sets. Both the wizard's preflight and package post-install checks recognise Bookworm/Trixie. Future releases require an explicit compatibility update rather than being accepted by a minimum-version comparison.

The same complete archive was installed with networking disabled in three independent ARM64 containers: new Bookworm, new Trixie and replacement Bookworm. Both new-warehouse paths passed the empty-data assertions and interrupted-administrator retry. Package integrity and all seven systemd definitions passed on Debian 12/systemd 252 and Debian 13/systemd 257. Debian 12 retained libc 2.36/Python 3.11; Debian 13 retained libc 2.41/Python 3.13. No cross-release upgrade was performed.

Bookworm compiled the actual bundled ESP32 sketch as the service user, with installed tools read-only and writable private temporary storage; the result remained 321,121 bytes. The replacement imported a synthetic protected backup created by the earlier Trixie installation. It rejected a wrong password, rolled back an injected activation failure, restored the source authority unchanged, and passed verified HTTPS sign-in, all 19 pages/assets/QR, actual Put/Pick and replay without duplicate movement. Actual frozen-app/Caddy recovery, maintenance safeguards, intentional stop, non-root desktop launch and protected-backup failure/repair passed on Bookworm too.

Preflight failure tests verified that unsupported OS and incomplete-kit errors now appear both in the terminal and the persistent install log. During Bookworm dependency installation, a desktop package invoked the container's systemctl double with no arguments; the helper was extended to accept that harmless form. A package diversion preserves the helper during dependency updates. These changes are test-only and are not included in the installer.

All 744 regression tests passed, including three new OS/kit checks. The package guide and generated `START HERE.txt` match the canonical 366-word guide. The final application and universal-kit checksums were recomputed. All earlier Pi hardware, real boot/desktop, Wi-Fi, camera and Finder checks remain required on physical devices.

Bookworm package removal also passed: application commands and desktop autostart were removed, application/watchdog services stopped, and warehouse database/configuration were retained. The three disposable OS containers and their isolated LAN were removed after verification; unrelated containers and source changes were preserved.

## Replacement reset choices and existing controllers

Build `20261029.3` adds independent choices during **Replace Raspberry Pi** after inspecting a protected backup. Full restore remains the default. **Clear stock & work** keeps catalog, people, roles and settings while clearing balances, reservations, tasks, stocktakes and movement history. **Start fresh** creates a new catalog and administrator. Either reset can retain or clear controller registrations, location hierarchy and QR bindings. Neither choice uploads firmware. These are replacement-setup choices; this build does not add an in-place reset button to a completed warehouse wizard.

All 755 source tests passed. Four database cases verify both reset levels with hardware kept and cleared, new dataset identity, retained printed-QR warehouse identity when hardware is kept, account/catalog behavior, foreign-key integrity and an unchanged source. Six controller-connection tests use the actual RS485 adapter with synthetic wire responses. They verify exact-address read-only discovery, legacy/runtime configuration handling, routing gaps, separate management/flash permissions and safe refusal of invalid responses. The firmware sketch itself is unchanged.

The final complete kit was installed again from fresh Bookworm and Trixie ARM64 images with networking disabled. Each installed release passed all 26,112 integrity checks, all seven systemd definitions passed static verification, and the installed firmware sketch matched the source byte-for-byte. Trixie completed the new-warehouse wizard with interrupted-administrator retry. Bookworm then completed the real packaged setup API for full restore and all four reset combinations, with independent reset confirmation, wrong-password refusal, injected activation failure/rollback and successful retry. Each case authenticated its resulting old or new administrator over certificate-verified HTTPS, retained the source recovery file unchanged, passed foreign-key checks and removed temporary reconnection hints at Finish. Retained hardware also retained the identity used by existing printed QR stickers; clearing hardware created a fresh location identity.

The restored package additionally passed the 19-page/assets/QR login check, actual Put/Pick/replay and frozen-Node/Caddy recovery checks. The final short guide extracted from the `.deb` and the generated `START HERE.txt` both matched the canonical 398-word guide. Application and complete-kit SHA-256 values were recomputed after packaging. Screenshots `output/pi-test/reset-options.png` and `output/pi-test/reset-options-compact.png` show the reviewed wizard choices using synthetic preview data.

Reset construction uses a staged database and existing atomic activation/rollback protections. The supplied backup and previous target rollback copies remain available; resetting the active warehouse is not secure erasure of those historical files. Retained controllers are marked offline pending connection checks. Cleared hardware can be reconnected at its known saved address with **Connect existing controller**, without flashing; unknown addresses or incompatible replies require explicit intervention rather than an automatic flash fallback. Temporary old-controller suggestions disappear at Finish. Retained recurring stocktake schedules are disabled when their location setup is cleared.

The packaged wizard tests explicitly selected simulated lights. Real controller reconnection, physical RS485/LED behavior, real Pi boot/desktop, phone camera, Wi-Fi and Finder-readable SD recovery still require the field checks above. No customer warehouse was reset or physical controller flashed during validation.

The repeatable replacement matrix is retained in `test/fixtures/pi-package/reset-matrix-check.py`; it refuses to run without the disposable-container guard and requires the synthetic protected-backup/service fixtures. Both disposable test containers, their isolated network and the temporary browser preview were removed after verification. Unrelated containers and source changes were preserved.


## Explicit Keep / Fresh controller setup

Build `20261029.4` makes **Keep existing LED setup** and **Set up as fresh controller** the two visible choices in the installer’s Controllers step. The RS485 adapter is identified as the warehouse communication connection; the fresh path separately walks through the ESP32’s own USB cable. Keep uses read-only registration with its exact saved address; warehouse cell names, QR labels and stock require the warehouse backup. Fresh requires a separate checkbox at the final flash review and starts with outputs disabled. It reads and validates the current revision and full response before writing sequential LED routing, then verifies healthy readback before registration. This allows deliberately reusing boards whose saved NVS setup belongs to a former controller address. No whole-flash erase is introduced. A registered board must use Edit, and failed verification cannot register a new controller or alter other warehouse records.

All **762 tests passed**, with no failures or skips. The seven new controller tests cover faulted/healthy prior settings, explicit consent before any upload, wrong modes/permissions, registered-board protection, configuration checksum rejection before writes, failed configuration persistence, unchanged existing inventory/profile and successful readback after a lost configure acknowledgement. Existing replacement/task-preservation and read-only reconnection checks remain in the suite. The generic healthy-configuration error now distinguishes a mismatched response, a bad checksum and an unreadable saved LED setup.

The final complete kit installed from scratch without networking on both Bookworm and Trixie ARM64. Both exact installed releases passed all 26,112 file checks. Trixie completed the real new-warehouse setup API, including interrupted administrator setup and refusal of an unconfirmed fresh provisioning request. The Bookworm replacement checks exercise full restore and all four reset/hardware-retention combinations against the same synthetic protected backup, including rollback and original-certificate verified HTTPS. These are software checks; physical ESP32 upload/RS485/LED verification remains required.

The two installer choices, read-only form and fresh final confirmation were inspected through the browser. The fresh button stayed disabled until its confirmation was selected. The same controller form was reviewed at 390-pixel phone width. Evidence: `output/pi-test/controller-setup-choices.png` and `output/pi-test/fresh-controller-mobile.png`. The preview runs synthetic data and rejects uploads. Its inline-script test harness was changed to an external script so it obeys the unchanged installer Content Security Policy.

The short guide is 433 words, with matching plain-text kit instructions. Checksums above were recomputed for the actual `.deb` and complete archive. For an existing installation, package installation stages the candidate; `sudo lytguide-test update` activates it while preserving its database and certificate. Pending Warehouse Setup can then continue. Merely installing a candidate does not silently switch a running warehouse’s release.

All seven systemd definitions passed on both OS releases. The exact shipped guide, installed `public/app.js`, installer choices and unchanged firmware source matched their reviewed sources byte-for-byte. The replacement matrix also passed original-authority HTTPS sign-in, inventory Put/Pick/replay, frozen-app/Caddy recovery and maintenance safeguards. A Mac temporary-directory bind was empty inside Docker; copying the synthetic fixtures into the disposable container corrected the harness without an installer change. Temporary preview servers/tabs, both disposable OS containers and their isolated network were removed; unrelated work was preserved.


## Four-matrix timeout: actual LED-driver regression

A real-device report from build `20261029.4` showed successful upload/hash verification and initial USB configuration readback, followed by a timeout immediately after applying Fresh setup for **four** 8×8 RGB modules. The bundled Adafruit NeoPixel 1.12.3 ESP-IDF 5 driver placed its `numBytes × 8` RMT items on the Arduino loop stack. Four matrices require 24,576 bytes for that array alone, exceeding the bundled ESP32 core’s default 8,192-byte loop stack. This is a concrete defect matching the failure point; the supplied log does not itself contain a decoded crash backtrace.

Build `20261029.5` pins the official **NeoPixel 1.12.4** buffer-allocation fix while retaining ESP32 core 3.0.7 and the v15 wire protocol. Official release: https://github.com/adafruit/Adafruit_NeoPixel/releases/tag/1.12.4 . The Arduino library archive SHA-256 is `500c197880177c243f47a318815df9203a8541f30044ba5573151a024e937081`; the actual fixed `esp.c` hash `514d70194921cdb696a46ad266beb1cce1c91e41107cd5979c51a05ab424ddaf` is enforced during bundle preparation. The installed SDK manifest covers every library file, and the runtime rejects older bundled library versions before upload.

The new regression compiles the **unmodified upstream driver**, rather than replacing `show()` with the prior no-op pixel stub. The old IDF 5 source fails `-Werror=vla`; the fixed driver passes and executes with 1/4/20/64-matrix host-side buffers, verifies bit pulse encoding, handles a simulated failed allocation without transmission and recovers on retry. Peripheral/mutex calls are the test doubles. The host’s large heap does not certify the physical ESP32’s maximum chain capacity. The prior native sketch tests still cover routing, NVS persistence and USB/non-USB command boundaries.

All **764 tests passed**, with zero failures/skips. Two actual ESP32 firmware builds ran in a network-disabled Linux ARM64 container with the pinned SDK: initial count 0 for Fresh setup and count 4 for existing four-module startup. The Xtensa compiler’s stack-usage output reports **48 bytes, static**, for the corrected `espShow` in both builds. Sketch sizes are 321,197 and 321,237 bytes, with 43,200 bytes of global RAM. An initial instrumentation command omitted the SDK’s `-c` C flag and was corrected in the test command; the shipped application’s normal compile flags were unchanged. No hardware was flashed during these checks.

The current installer still preserves warehouse data and controller profiles. Installing/activating this host package alone does not update firmware already on an ESP32: the failed unregistered controller must be flashed again through confirmed Fresh setup with the corrected tools. A registered controller uses Edit to retain its profile. After a failed job, close Setup, install/activate the new host release, restart the Setup service and reopen it so both application and wizard use the new release. Real USB confirmation, RS485 and LED operation remain field checks.

The final `.5` complete kit installed without networking in fresh Bookworm and Trixie ARM64 environments. Both installed releases verified all 26,112 files and the exact fixed-driver hash/version in both manifests; the v15 sketch source itself is unchanged. All seven service definitions passed on both OS releases. Trixie completed new setup and its interrupted-account retry. Bookworm passed full restore and all four reset/hardware-retention combinations, source-backup immutability, retained printed-QR identity, wrong-password/failed-activation safeguards, original-authority HTTPS sign-in, Put/Pick/replay and watchdog recovery. Packaged setup also refused an unconfirmed Fresh flash before any upload. Both disposable containers and their private network were removed afterward. The separate compile container was automatically removed; unrelated work was preserved. The `.deb` and complete archive checksums above were independently recomputed.

## Desktop application and repeatable Setup — build 20261029.7

The installed menu item is now **LytGuide**, with the branded icon and application window identity. Main launch, Setup and desktop autostart use one shared window-argument builder: dedicated profiles, app mode without normal browser tabs/address bar, and maximized opening. The local service remains independent of the window so phones continue working after it closes.

Explicitly opening Warehouse Setup starts the complete checklist at Get started, after local administrator authorization. A page refresh or opening LytGuide during unfinished commissioning resumes its current step. Fresh authorization invalidates prior setup sessions and advances the revision; busy setup jobs, backup/restore locks and firmware jobs prevent a restart. The new **Set up existing warehouse** path walks system, network, existing administrator/recovery, phones, hardware, locations and Finish without deleting data or flashing a controller. Existing restore/reset options remain explicit and unchanged.

Both exact final kits installed with networking disabled on Bookworm and Trixie ARM64. Both completed new setup and a second full existing-warehouse setup through the actual packaged API. Checks compare nonempty product/stock records, users, locations/labels, certificate and private authority key, and recovery encryption profile before/after. Browser refresh/internal resume retained the step; explicit relaunch reset the checklist, rejected previous sessions and refused maintenance interruptions. Trixie also passed an injected administrator-start failure and retry. All 26,113 release files verified on both OS targets.

Both systems passed actual frozen-app/HTTPS recovery and maintenance/intentional-stop safeguards. Packaged manual app, explicit Setup, internal unfinished-app launch and autostart were invoked as an ordinary desktop user against recording browser/authorization doubles; their app URL, profiles, maximized settings and window identity were checked. All seven service definitions passed systemd validation. A supplementary desktop-file-validate command was unavailable in the slim containers; desktop-entry fields and installed branding are covered by source and installed-launch checks. No real Pi desktop or window manager is claimed. UI inspection of the existing-warehouse form is saved at `output/pi-test/repeat-setup.png`.

Validation caught a missing argument-forwarding clause in the privileged authorization shell wrapper. The intermediate 20261029.6 build was rejected and moved under `output/pi-test/rejected/20261029.6`; it was never delivered. Build 20261029.7 forwards the internal resume argument and passes the packaged retry/reopen checks. Runtime/build sources retain the original unrelated working-tree edits.

The separate physical ESP32 USB confirmation failure remains unresolved pending the user's latest upload log and installed-version check. The new app/setup behavior does not establish a hardware fix. Real Pi app-window appearance, Polkit prompt, boot/login, camera, RS485/LEDs, Wi-Fi and Finder recovery remain field checks.
