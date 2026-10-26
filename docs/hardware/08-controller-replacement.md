# Replace an ESP32 without remapping cells

The logical controller lives in the application database. Its ESP32 is replaceable hardware. Replacement preserves the controller ID, name, RS485 address, logical output numbers, cell IDs/names, QR identities, inventory and history. Only the physical USB identity, firmware version and maintenance timestamps change. The LED chain and wiring order must remain unchanged for this workflow; physical layout changes need a separate routing edit.

## Save the setup before a future failure

After a successful firmware flash, the app reads the complete controller configuration over USB and saves a replacement profile in its database automatically. A profile includes physical count, logical span, the full routing table and revision. A host-side checksum detects damaged saved profiles, and critical database backups include them.

To refresh a profile from a working board:

1. Resolve outstanding work and stop active utility displays.
2. Isolate the controller for maintenance and connect the original ESP32 by USB to the host running the app. The original must run the current USB-maintenance firmware.
3. Open Hardware → Controller setup and use Disconnect/Attach to select its USB port.
4. Under Controller action, select **Replace / update [controller name]**.
5. Click **Save connected controller’s setup**. This reads and saves its count and routing; it does not flash the board or change cell mappings.
6. Confirm the successful backup message before disconnecting the original board.

Older addressed simple-matrix firmware through v13 had fixed identity routing. For those known versions, the existing registered module count reconstructs the route without needing a live old board. Runtime-routing firmware with no saved profile is refused: a dead board's custom routing cannot be recovered by guessing from its cell count. Older v14 builds without USB maintenance need their configuration migrated before relying on this replacement workflow.

Whenever a future controller editor changes the route/count, it must refresh this host profile after verified readback and before completing maintenance. External changes made outside the app are not automatically backed up.

## Replace the board

1. Deploy the updated app and current firmware source on the controlling host. A pinned offline toolchain manifest must match protocol v14.
2. Switch off power. Disconnect the old ESP32 from the LED/RS485 wiring and power so it cannot share the replacement's address on the bus.
3. Connect a compatible replacement ESP32 to the host by USB, isolated from the external 5V rail and LED data connection during flashing.
4. In Controller setup, complete **Disconnect → Attach** to select the new board's USB port.
5. Choose **Replace / update [the original controller]** under Controller action. Name and physical module count fill automatically and cannot be edited in this mode.
6. Confirm that the old board is disconnected and the LED chain is unchanged. Select the correct board target, then click **Flash and restore controller**.
7. Wait for upload, restore and configuration readback to finish. The app preserves the original address and loads the complete saved routing into the new board's NVS. It does not create new cells or rebuild mappings.
8. Disconnect USB. With external power off, reconnect the existing LED/RS485 wiring to the corresponding pins on the replacement. Turn power on.
9. Use the controller's **Ping** to verify communication and LED operation. No cell reassignment or QR pairing is needed.

The controller is left offline in the database after USB verification, until RS485 health checking confirms communication through the warehouse bus. Successful upload alone is not treated as proof that routing or bus wiring works.

The same replacement/update mode can refresh firmware on the existing board when its saved profile is available. It preserves the logical controller and routing in the same way.

## Verification and recovery

The new board is compiled with an initial count of zero. A blank replacement starts with outputs disabled, then receives its saved configuration over USB. A used board may retain prior NVS data: the app reads its current revision, explicitly replaces its routing if needed, and verifies a fresh checksummed response. The original board and replacement must not both be connected to the RS485 bus with the same address.

USB maintenance accepts only exactly addressed `config-status` and `configure` commands. Replies go to USB, not onto the RS485 bus. Ordinary LED commands are rejected over USB. Configuration replies echo a random nonce and carry a checksum, so stale/wrong-controller or corrupted responses cannot verify a replacement. The app rechecks the selected USB identity before upload and pauses normal hardware commands while maintenance owns the controller.

A lost restore acknowledgement triggers readback. If the complete routing/count match, the job can complete; otherwise it fails without changing the registered board identity or cell mappings. The app also checks authorization and controller/mapping revisions before committing replacement metadata.

Before uploading a replacement, a durable `controller_replacement_pending:<controllerId>` record retains its source profile and selected device. Failures keep that record and the original profile. A retry reads and reconciles the actual board rather than assuming the failed attempt did nothing. The maintenance lock includes a process owner; after an interrupted process is confirmed no longer running, the lock can be released while recovery records remain intact. A lock with a live or unknown owner is not cleared automatically.

Source profiles are stored in `app_metadata` as `controller_profile:<controllerId>`. They are not stored solely on the ESP32. If both the original board and every database/profile backup are lost, arbitrary custom routing cannot be recovered automatically.

## Automated and physical checks

The replacement tests cover gap-preserving routing restoration, unchanged cell/stock/history records, stable logical controller/address, physical board identity changes, host backups, lost acknowledgements, upload/restore failures, damaged responses/profiles, missing backup, permissions, stale USB selection, legacy fixed routing, new provisioning and maintenance exclusion. Native tests execute the actual firmware's configuration parser and USB response/checksum logic.

An actual ESP32 toolchain build and physical replacement test are still required. The current development environment does not have Arduino CLI installed; test sessions emulate serial hardware and do not claim a physical flash occurred.
