# Replace an ESP32 without remapping cells

The logical controller lives in the application database. Its ESP32 is replaceable hardware. Replacement preserves the controller ID, name, RS485 address, logical output numbers, cell IDs/names, QR identities, inventory and history. Only the physical USB identity, firmware version and maintenance timestamps change. Existing LEDs keep their order. The editor also supports appending LEDs or removing unused outputs from the end of the chain, with a separate confirmation. Arbitrary rewiring needs a separate routing edit.

## Save the setup before a future failure

After a successful firmware flash, the app reads the complete controller configuration over USB and saves a replacement profile in its database automatically. A profile includes physical count, logical span, the full routing table and revision. A host-side checksum detects damaged saved profiles, and critical database backups include them.

The update screen automatically reuses this saved profile. There is no manual **Save connected controller’s setup** step. If the verified profile is missing or damaged, updating stays blocked until the saved setup is recovered; location mappings are not reset or guessed.

Older addressed simple-matrix firmware through v13 had fixed identity routing. For those known versions, the existing registered module count reconstructs the route without needing a live old board. Runtime-routing firmware with no saved profile is refused: a dead board's custom routing cannot be recovered by guessing from its cell count. Older v14 builds without USB maintenance need their configuration migrated before relying on this replacement workflow.

Whenever a future controller editor changes the route/count, it must refresh this host profile after verified readback and before completing maintenance. External changes made outside the app are not automatically backed up.

## Replace the board

1. Deploy the updated app and current firmware source on the controlling host. A pinned offline toolchain manifest must match protocol v15.
2. Switch off power. Disconnect the old ESP32 from the LED/RS485 wiring and power so it cannot share the replacement's address on the bus.
3. Connect a compatible replacement ESP32 to the host by USB, isolated from the external 5V rail and LED data connection during flashing.
4. In Hardware → Controller Health, click **Edit** beside the original controller, then follow **Disconnect → Attach** to select the new board's USB port.
5. Check the Configure screen. Choose Update firmware / LED count or Replace ESP32. The logical controller name stays fixed. The physical LED count is filled from the verified profile and can be edited. Click Next.
6. Confirm the controller is isolated for maintenance and the LED chain is unchanged, then click **Update firmware**. The board target uses the configured application default.
7. Wait for upload, restore and configuration readback to finish, then acknowledge the success dialog. A failed job instead opens a failure dialog with recovery instructions. The app preserves the original address and loads the complete saved routing into the new board's NVS. It does not create new cells or rebuild mappings.
8. Disconnect USB. With external power off, reconnect the existing LED/RS485 wiring to the corresponding pins on the replacement. Turn power on.
9. Use the controller's **Ping** to verify communication and LED operation. No cell reassignment or QR pairing is needed.

The controller is left offline in the database after USB verification, until RS485 health checking confirms communication through the warehouse bus. Successful upload alone is not treated as proof that routing or bus wiring works.

The same Edit flow refreshes firmware on the existing board without discarding tasks when the ROM chip identity matches the registered ESP32 and the saved LED count and order are unchanged. The app verifies the current routing before upload, restores and verifies it afterward, and preserves cell bindings, reservations, task progress and pending movement entries. It pauses hardware commands during maintenance and requests the current task lights again after verification; delivery waits for RS485 reconnection. When a different ESP32 is selected and work is outstanding, the task dialog offers **Keep work and use this controller**. This explicitly preserves existing tasks, reservations, pending entries and location mappings on the same logical controller while its physical board changes. The saved LED count and order must remain unchanged, and the old board must be disconnected. Failed uploads/restores retain the work and keep LED guidance held until a verified retry succeeds. Layout changes still require the existing work safeguards.

## Verification and recovery

The new board is compiled with an initial count of zero. A blank replacement starts with outputs disabled, then receives its saved configuration over USB. A used board may retain prior NVS data: the app reads its current revision, explicitly replaces its routing if needed, and verifies a fresh checksummed response. The original board and replacement must not both be connected to the RS485 bus with the same address.

USB maintenance accepts only exactly addressed `config-status` and `configure` commands. Replies go to USB, not onto the RS485 bus. Ordinary LED commands are rejected over USB. Configuration replies echo a random nonce and carry a checksum, so stale/wrong-controller or corrupted responses cannot verify a replacement. The app rechecks the selected USB identity before upload and pauses normal hardware commands while maintenance owns the controller.

A lost restore acknowledgement triggers readback. If the complete routing/count match, the job can complete; otherwise it fails without changing the registered board identity or cell mappings. The app also checks authorization and controller/mapping revisions before committing replacement metadata.

Before uploading a replacement, a durable `controller_replacement_pending:<controllerId>` record retains its source profile and selected device. Failures keep that record and the original profile. A controller with an unverified upload stays held for LED commands until a verified retry; other work data is retained. The receipt records whether uploading started so a failed upload can be retried even if USB configuration status is temporarily unavailable. A retry reads and reconciles the actual board rather than assuming the failed attempt did nothing. The maintenance lock includes a process owner; after an interrupted process is confirmed no longer running, the lock can be released while recovery records remain intact. A lock with a live or unknown owner is not cleared automatically.

Source profiles are stored in `app_metadata` as `controller_profile:<controllerId>`. They are not stored solely on the ESP32. If both the original board and every database/profile backup are lost, arbitrary custom routing cannot be recovered automatically.

## Automated and physical checks

The replacement tests cover gap-preserving routing restoration, unchanged cell/stock/history records, stable logical controller/address, physical board identity changes, host backups, lost acknowledgements, upload/restore failures, damaged responses/profiles, missing backup, permissions, stale USB selection, legacy fixed routing, new provisioning and maintenance exclusion. Native tests execute the actual firmware's configuration parser and USB response/checksum logic.

Regression tests use transport doubles and the actual firmware parser compiled natively. The installer includes the pinned offline ARM64 toolchain. Real USB upload, RS485 wiring, power and LED operation still require checks on a Pi with physical ESP32s; simulated success does not claim a physical flash occurred.

## Add versus Edit

**Add Controller** opens only new-controller setup. **Edit** in the controller health row opens maintenance for that specific controller. Configure shows controller name, LED modules, serial port, added device and other devices/manual refresh. Back/Next sit at the top; on phones they stay at the top while scrolling as two individual controls, without a full-width overlay. The final action is explicitly labelled Flash controller or Update firmware. The old numbered module chips are removed.


## Controller maintenance safeguards

### Git-based Pi service

The older `inventory-management.service` installation uses its existing Arduino CLI and installed ESP32 core. It does not require the installable application's offline bundle. For ROM identity checks, the host asks that CLI for the selected board's tool properties and runs its `esptool` using the same service account and environment. Custom Arduino data/user directories remain supported; the app does not search another user's home directory, select an unrelated tool version or download tools at runtime.

After updating the Git checkout, restart `inventory-management.service` to load this compatibility fix. If Arduino cannot expose its tool, check `ARDUINO_CLI_PATH` and the ESP32 core installed for that service account. For the installable application, an explicitly configured `FIRMWARE_TOOLCHAIN_ROOT` still requires the checked bundle; a missing, corrupt or incompatible bundle is never bypassed through legacy discovery.

### Shared protections

- One USB cable can serve each board in turn. The bridge serial/path is a connection label; ROM MAC is the board identity. Two CP2102 bridges reporting `0001` can be distinct controllers. A registered chip cannot be added under another controller, and explicit Update refuses a different known chip.
- The final check reads the chip again, resets it, then verifies that the complete LED setup survived the reset. Upload exit status or a missing ACK alone never establishes success.
- USB sessions wait for firmware boot, disable inherited hardware/software flow control, retry nonce-bound reads, assemble partial writes and fragmented JSON, and show firmware configuration errors immediately. Upload uses 115200 baud; compilation has a bounded ten-minute allowance on the Pi.
- Growing the chain preserves logical outputs, cells, names, QR codes and stock; new outputs remain unassigned for location setup. Shrinking refuses an output with a location, QR binding, stock or referenced history. Unmap those tail outputs first. Layout changes are blocked while warehouse work is outstanding.
- Maintenance status is saved on disk. Browser polling reconnects to its existing job after a temporary connection failure. A failed compile releases the controller. An upload whose final setup is uncertain keeps that logical controller held, including across failed retries and service restarts, until a verified retry succeeds.
- Registering a new board and saving its profile/identity are one database transaction. Nothing is registered if the checks or database commit fail. Controller health remains offline until the separate RS485 check succeeds.
- The setup screen supports checking one, several or all saved controllers. Deferred controllers are explicitly listed and remain unverified; no firmware or mapping is silently reset. Location setup can also be saved and continued later.

### Recovery matrix

| Scenario | Expected outcome |
| --- | --- |
| Wrong RS485 port or stale USB selection | Refuse before compiling/uploading; re-detect the ESP32. |
| Another registered ESP32, or swapped board while compiling | Refuse before upload; keep both controllers and their locations. |
| Duplicate bridge serial on the next board | Read ROM MAC; allow a distinct chip without overwriting the previous controller. |
| Missing/damaged saved profile | Read the original board’s setup using the editor, or recover the warehouse backup; do not guess custom routing. |
| Compile/toolchain/permission/disk failure | Explain recovery; preserve data; release pre-upload maintenance. |
| Failed connection/upload, power loss or unplug | No success; keep uncertain-upload hold and verified source profile for retry. |
| Configuration storage/allocation/revision/checksum error | Surface the ESP32 error; do not register or change database mappings. |
| Lost configure ACK | Read the full setup; accept only matching verified configuration. |
| Setup lost after reset | Fail final verification; do not claim the controller is ready. |
| Browser refresh or temporary network failure | Reconnect to the existing job; do not start a second flash. |
| Pi/app restart during upload | Mark the interrupted job; keep recovery receipts and controller hold. |
| User/role/mapping changes mid-job | Recheck authorization and setup before upload and database commit. |
| One unavailable controller among several | Select the controllers to verify now and explicitly defer the others. |

Physical faults cannot be prevented by software. Do not promise failure-free flashing: verify a real new board, count change, same-board update, replacement and an interrupted/retried upload before warehouse deployment.
