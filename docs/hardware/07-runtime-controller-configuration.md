# Runtime controller configuration and cell lifecycle

## Delivered scope

The simple-matrix firmware now advertises `simple-matrix-v14-rs485-addressed`. It supports 0–64 physical 8×8 LED modules and 64 stable logical output slots. Module count and logical-to-physical routing can be changed over RS485 and saved in NVS without reflashing again. `LED_MODULE_COUNT` supplies only the first-boot default when there is no saved record. Existing saved configuration takes precedence on subsequent boots and firmware updates.

The app's protocol constant is updated and `controller-configuration.js` builds/validates configuration frames. The application now sends and verifies configuration frames over USB for controller replacement and firmware updates, preserving the existing database mappings. A general editor for changing physical count/routing is still pending. See [controller replacement](08-controller-replacement.md). Cell merge, dimensions, stock transfer/removal choices, dynamic controller editing and one-cell-to-multiple-output database bindings remain application work. Do not physically rearrange a live chain until the maintenance workflow can reconcile firmware routing and database state.

The existing mapped-location deletion dialog now reminds users to bridge data OUT from the previous module to data IN on the next module, with power off, when physically removing a module from the middle. Removing the final module needs no bridge. Deleting a software cell alone does not require physically removing its LED. Reuse this notice in the future LED-detach/manual-cell workflow.

## Stable identities and examples

Cell identity/QR, logical LED output, and physical chain position are separate concepts. The controller stores only the last two; it does not store inventory, dimensions or cell names.

With 20 outputs, logical slots 1–20 initially route to physical positions 1–20.

- Remove the module at position 11: slot 11 becomes disabled (`0`); logical slots 12–20 route to physical positions 11–19. The logical span remains 20 and the physical count becomes 19. No cell needs renaming or renumbering.
- Insert a new module at physical position 4: assign it an unused logical slot (such as 21) and shift physical destinations of existing slots at/after position 4 by one. Existing cell-to-logical-output bindings remain intact.
- A removed LED can leave its cell active in manual mode; this is a database decision, independent of physical routing.
- A merged cell can address one or several existing logical slots using group commands. The app must implement that one-to-many binding; do not alias two logical slots to one physical module.

`modules` in ping/status is the logical span (highest enabled logical slot), preserving existing address-range checks. `physicalModules` is the chain length. A disabled slot within the span rejects commands. The future editor must use the routing table to distinguish disabled slots; it must not generate or map placeholder cells for them just because they fall within the span.

## Configuration protocol

Only an exact, addressed command is accepted. Broadcast and unaddressed writes are rejected.

```
to ADDRESS config-status
to ADDRESS configure REQUEST EXPECTED_REVISION PHYSICAL_COUNT ROUTING CRC
```

- REQUEST: 16 lowercase hexadecimal characters, unique for each change.
- EXPECTED_REVISION: eight lowercase hexadecimal characters representing the revision read from config-status. The firmware increments it once after a successful update. Stale revisions and revision overflow are rejected.
- PHYSICAL_COUNT: decimal 0–64; 0 disables all outputs without erasing cell records in the application.
- ROUTING: 128 lowercase hexadecimal characters, one two-digit physical position for each of the 64 logical slots. `00` disables a slot. Every physical position 1 through PHYSICAL_COUNT must appear exactly once. Duplicates, missing physical positions and out-of-range entries reject the entire request.
- CRC: CRC-32/ISO-HDLC over uppercase ADDRESS, ` configure `, then the exact space-separated REQUEST through ROUTING fields. This covers the destination, operation, expected revision, module count and routing together.

The JSON acknowledgement includes type `ack`, command `configure`, address, request, revision and physicalModules. `config-status` accepts an optional 16-character request nonce and returns address, request, revision, physicalModules, logicalModules, full routing, maxModules, fault and checksum. The checksum covers uppercase address, ` config-status `, request (or `-`), eight-digit hexadecimal revision, decimal physical count, routing, and fault as `0`/`1`, separated by single spaces. Ping/status additionally advertise runtimeConfig:1, physicalModules, configRevision and configFault.

## Reliability and maintenance contract

Configuration is refused while any mapped output has an active static/scroll display, ping or locate. Stop displays and tasks through the application's ownership-aware maintenance workflow first. Firmware cannot know whether inventory work remains active in the database. Stop new commands during reconfiguration and verify each physical output before resuming work. Old unversioned display commands must not be queued or replayed across a maintenance session; the future application must enforce this, especially if reusing a previously assigned logical slot.

The firmware validates the complete route and allocates the replacement pixel buffer before persisting anything. Failed memory allocation or storage leaves the current configuration active. It persists one complete, checksummed NVS record before swapping the live routing. The most recent configuration request ID and payload checksum are persisted with that record, so retrying the same request after a lost acknowledgement or reboot does not write flash or reset displays again. Reusing its ID for a different payload is rejected. Older requests are rejected by the revision check. Group-ping duplicate history is retained across live configuration changes.

A malformed, corrupt, wrong-owner or unavailable saved record disables outputs and reports configFault rather than guessing mappings. Recovery requires explicit verified configuration; a controller with a reported fault is not accepted as healthy by the app's hardware probe. Configuration persistence is bound to the compiled controller address, so changing controller identity deliberately requires recovery/reprovisioning.

If an acknowledgement is lost, the future editor must read config-status and compare the full routing, count and revision before committing database mappings. Future configuration edits must also refresh the verified host-side replacement profile after readback, using `saveControllerProfile`; otherwise a later replacement would restore outdated routing. Do not interpret a transport timeout as proof that configuration was rejected, blindly overwrite the database, or send a different configuration with a stale revision. Firmware NVS and the host database cannot form one atomic transaction; use a durable pending maintenance record and reconcile it after interruption.

The RX buffer is increased before serial startup to accommodate complete frames during LED refreshes. Storage uses the ESP32 core's built-in Preferences library; no extra downloadable firmware library was added. References: [Espressif Preferences API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/preferences.html), [Espressif serial API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/serial.html).

## Application workflow to implement next

1. **Merge/resize:** retain inventory/history identities or explicitly move balances to a surviving cell; retain aliases for old labels as appropriate. Store a positive decimal capacity factor, including 1.5× or 2×, and optional internal usable dimensions with explicit units. Store product dimensions/orientation constraints separately. Product capacity is an estimate based on fit, packing orientation, clearance and optionally weight, with a manual override; volume division alone is insufficient. Handle rounding of whole items explicitly.
2. **Remove a cell:** show confirmation for an empty cell. For stocked cells, offer a guided transfer with editable destinations/quantities, an audited stock adjustment with a clear total-inventory warning, or LED detachment while preserving the manual cell and its stock. Verify real moves before changing balances. Preserve history rather than erasing transaction records. Block or resolve active tasks/stocktakes first.
3. **Insert/remove a module:** stage the old and proposed routing, explain the wiring change, stop affected operations, configure the controller with revision checks, read it back, verify LEDs, then commit/reconcile mappings. Preserve all unaffected cell names and QR identities. New cells get new stable identities; removing cell 11 never renumbers 12–20.

## Verification

Native C++ tests compile and exercise the actual sketch with fake serial, pixels, time and NVS. They cover host/firmware checksum agreement, 20-module provisioning, middle removal, insertion at position 4, disabled slots, duplicate/stale requests, reboot persistence, allocation/storage failures, active-display rejection, broadcast rejection, corrupted storage, explicit recovery and zero-module configuration. Grouped-ping tests continue to verify synchronized refresh and retry suppression.

An actual ESP32 build and physical test remain necessary. The Arduino toolchain is not installed in the current development environment. Update any pinned offline toolchain manifest to protocol v14 before using the existing flashing workflow. Test power interruption/recovery and routing verification on the bench before enabling a controller editor.
