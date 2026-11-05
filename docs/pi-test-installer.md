# Install LytGuide on Raspberry Pi

You need **64-bit Raspberry Pi OS Desktop Bookworm (Debian 12) or Trixie (Debian 13)** and **10 GB free space**. One installer detects the OS and selects its included components. Connect the Pi and phone/tablet to the same router. **Internet is not required.**

The complete kit includes the app, Excel and QR libraries, Node runtime, desktop app, HTTPS server and ESP32 tools. No `npm install` is needed on the Pi. Use a newly built kit for new features; an older downloaded installer does not update when Git changes.

## Install

1. Copy the complete offline kit to the Pi using a USB drive, then extract it.
2. Open **Install LytGuide.run**, choose **Execute**, and enter the Pi's administrator password when asked.
3. **Warehouse Setup** opens. Choose one of the two options below.

If the installer opens as text, open a terminal in its folder and run:

```sh
sh "Install LytGuide.run"
```

## New warehouse

1. Follow the wizard's network steps. Reserve the Pi's address in the router so it stays the same.
2. Create the warehouse administrator and recovery password. **Save the recovery password separately from the SD card.**
3. Connect your phone. At Controllers, select the RS485 adapter, then choose **Keep existing LED setup** or **Set up as fresh controller**. Fresh setup uses the ESP32 USB cable and asks before replacing its saved LED settings. Use **Add another controller** after each successful upload to repeat with the same USB cable. Use **Controller health → Edit** to update firmware, replace an ESP32 or change its LED count. Select the controllers to check now; explicitly leave the others for later.
4. Select each LED tab, enter its cell details and save. Choose **Assign QR later** if using the Pi without a camera. **Continue** asks before saving unfinished setup for later.

## Replace Raspberry Pi

1. Keep the old Pi switched off. On your Mac, open its SD card → **bootfs → LYTGUIDE-RECOVERY** and copy the newest `.lytbackup` file to the new Pi.
2. Choose **Replace Raspberry Pi**, select the backup, enter the recovery password and check its date before restoring.
3. Choose **Restore everything**, **Clear stock & work**, or **Start fresh**. For a reset, choose whether to keep controller/cell/QR setup. Start fresh creates a new administrator.
4. Verify phone and controller connections, then finish. Choose **Keep existing LED setup** to reconnect already-flashed controllers using their saved addresses.

Stock returns to the backup date. Check any physical movements made after it.

## Connect the phone

Scan the wizard's QR, download the certificate and compare its fingerprint with the Pi.

- **iPhone/iPad:** install it in Settings → General → VPN & Device Management. Enable it in General → About → Certificate Trust Settings.
- **Android:** Security → Install a certificate → CA certificate. Menu names vary.

Open the warehouse link shown in the wizard.

## Check before use

For a new warehouse, add a product first. Test one Put, then one Pick, the camera and the correct LEDs. Reboot and open **LytGuide** from the Pi's application menu.

The app starts at boot and opens when the Pi desktop starts. Automatic checks recover an unresponsive service.

Backups run every **15 minutes**. Keep an extra copy off the SD card.

Open **LytGuide** from the Pi menu. Its dedicated desktop app and Setup runtime are included; no browser installation is needed. Open **LytGuide Warehouse Setup** to repeat setup from the beginning. Use **Continue location setup** to return directly to unfinished cell assignments. On a phone/tablet, assign QR codes in **Settings → Hardware → Manage Locations**. Existing data stays until you explicitly choose a reset while restoring a backup.

## Uninstall or reinstall

Open **Uninstall LytGuide.run** from the latest kit, or **Uninstall LytGuide** in the Pi menu. It saves the latest warehouse backup first. At **Delete backups too? [y/N]**, press Enter to keep them. Enter Y only to delete those backups as well.

Reinstall normally. Setup offers any retained backup found on the Pi: choose **Yes** to restore it, or **No** for normal setup. You can also browse for another `.lytbackup` file. Restoring a protected copy needs its recovery password.
