# Replace an ESP32 without remapping cells

The logical controller lives in the application database. Its ESP32 is replaceable hardware. Replacement preserves the controller ID, name, RS485 address, logical output numbers, cell IDs/names, QR identities, inventory and history. Only the physical USB identity, firmware version and maintenance timestamps change. The LED chain and wiring order must remain unchanged for this workflow; physical layout changes need a separate routing edit.

## Save the setup before a future failure

After a successful firmware flash, the app reads the complete controller configuration over USB and saves a replacement profile in its database automatically. A profile includes physical count, logical span, the full routing table and revision. A host-side checksum detects damaged saved profiles, and critical database backups include them.

To refresh a profile from a working board:

1. Stop physical work at the controller and stop active utility displays. When the same registered ESP32 is connected, existing tasks and pending entries can stay in the app; saving its unchanged setup does not require discarding them.
2. Isolate the controller for maintenance and connect the original ESP32 by USB to the host running the app. The original must run the current USB-maintenance firmware.
3. Open Hardware → Controller Health and click **Edit** beside the controller.
4. Follow Disconnect → Attach → Configure. The controller is already selected; check its USB port and choose Next.
5. On the final step, open **Save a setup backup** and click **Save connected controller’s setup**. This reads and saves its count and routing; it does not flash the board or change cell mappings.
6. Confirm the successful backup message before disconnecting the original board.

Older addressed simple-matrix firmware through v13 had fixed identity routing. For those known versions, the existing registered module count reconstructs the route without needing a live old board. Runtime-routing firmware with no saved profile is refused: a dead board's custom routing cannot be recovered by guessing from its cell count. Older v14 builds without USB maintenance need their configuration migrated before relying on this replacement workflow.

Whenever a future controller editor changes the route/count, it must refresh this host profile after verified readback and before completing maintenance. External changes made outside the app are not automatically backed up.

## Replace the board

1. Deploy the updated app and current firmware source on the controlling host. A pinned offline toolchain manifest must match protocol v15.
2. Switch off power. Disconnect the old ESP32 from the LED/RS485 wiring and power so it cannot share the replacement's address on the bus.
3. Connect a compatible replacement ESP32 to the host by USB, isolated from the external 5V rail and LED data connection during flashing.
4. In Hardware → Controller Health, click **Edit** beside the original controller, then follow **Disconnect → Attach** to select the new board's USB port.
5. Check the Configure screen. The controller name and physical module count are filled automatically and cannot be edited during a firmware update. Click Next.
6. Confirm the controller is isolated for maintenance and the LED chain is unchanged, then click **Update firmware**. The board target uses the configured application default.
7. Wait for upload, restore and configuration readback to finish. The app preserves the original address and loads the complete saved routing into the new board's NVS. It does not create new cells or rebuild mappings.
8. Disconnect USB. With external power off, reconnect the existing LED/RS485 wiring to the corresponding pins on the replacement. Turn power on.
9. Use the controller's **Ping** to verify communication and LED operation. No cell reassignment or QR pairing is needed.

The controller is left offline in the database after USB verification, until RS485 health checking confirms communication through the warehouse bus. Successful upload alone is not treated as proof that routing or bus wiring works.

The same Edit flow refreshes firmware on the existing board without discarding tasks when the detected USB identity matches the registered ESP32 and the saved LED count and order are unchanged. The app verifies the current routing before upload, restores and verifies it afterward, and preserves cell bindings, reservations, task progress and pending movement entries. It pauses hardware commands during maintenance and requests the current task lights again after verification; delivery waits for RS485 reconnection. When a different ESP32 is selected and work is outstanding, the task dialog offers **Keep work and use this controller**. This explicitly preserves existing tasks, reservations, pending entries and location mappings on the same logical controller while its physical board changes. The saved LED count and order must remain unchanged, and the old board must be disconnected. Failed uploads/restores retain the work and keep LED guidance held until a verified retry succeeds. Layout changes still require the existing work safeguards.

## Verification and recovery

The new board is compiled with an initial count of zero. A blank replacement starts with outputs disabled, then receives its saved configuration over USB. A used board may retain prior NVS data: the app reads its current revision, explicitly replaces its routing if needed, and verifies a fresh checksummed response. The original board and replacement must not both be connected to the RS485 bus with the same address.

USB maintenance accepts only exactly addressed `config-status` and `configure` commands. Replies go to USB, not onto the RS485 bus. Ordinary LED commands are rejected over USB. Configuration replies echo a random nonce and carry a checksum, so stale/wrong-controller or corrupted responses cannot verify a replacement. The app rechecks the selected USB identity before upload and pauses normal hardware commands while maintenance owns the controller.

A lost restore acknowledgement triggers readback. If the complete routing/count match, the job can complete; otherwise it fails without changing the registered board identity or cell mappings. The app also checks authorization and controller/mapping revisions before committing replacement metadata.

Before uploading a replacement, a durable `controller_replacement_pending:<controllerId>` record retains its source profile and selected device. Failures keep that record and the original profile. A controller with an unverified upload stays held for LED commands until a verified retry; other work data is retained. The receipt records whether uploading started so a failed upload can be retried even if USB configuration status is temporarily unavailable. A retry reads and reconciles the actual board rather than assuming the failed attempt did nothing. The maintenance lock includes a process owner; after an interrupted process is confirmed no longer running, the lock can be released while recovery records remain intact. A lock with a live or unknown owner is not cleared automatically.

Source profiles are stored in `app_metadata` as `controller_profile:<controllerId>`. They are not stored solely on the ESP32. If both the original board and every database/profile backup are lost, arbitrary custom routing cannot be recovered automatically.

## Automated and physical checks

The replacement tests cover gap-preserving routing restoration, unchanged cell/stock/history records, stable logical controller/address, physical board identity changes, host backups, lost acknowledgements, upload/restore failures, damaged responses/profiles, missing backup, permissions, stale USB selection, legacy fixed routing, new provisioning and maintenance exclusion. Native tests execute the actual firmware's configuration parser and USB response/checksum logic.

An actual ESP32 toolchain build and physical replacement test are still required. The current development environment does not have Arduino CLI installed; test sessions emulate serial hardware and do not claim a physical flash occurred.

## Add versus Edit

**Add Controller** opens only new-controller setup. **Edit** in the controller health row opens maintenance for that specific controller. Configure shows controller name, LED modules, serial port, added device and other devices/manual refresh. Back/Next sit at the top; on phones they stay at the top while scrolling as two individual controls, without a full-width overlay. The final action is explicitly labelled Flash controller or Update firmware. The old numbered module chips are removed.
