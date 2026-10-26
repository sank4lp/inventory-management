# Synchronized LED displays

Protocol `simple-matrix-v15-rs485-addressed` adds a shared, acknowledged display frame. Deploy the updated application and update each ESP32 through **Hardware → Edit → Update firmware**. Keep existing work and the same LED count/order. Saved routing and logical location mappings remain unchanged. If using a pinned offline toolchain bundle, regenerate its manifest with `scripts/prepare-firmware-bundle.mjs` for protocol v15 before flashing.

After reconnecting LED/RS485 wiring, refresh controller health. Its ping/status response must advertise `displayFrame: 1`. Earlier firmware only supports simultaneous grouped pings: it cannot apply the other displays together. The application retains the older delivery method for those controllers and reports that a firmware update is needed.

## Shared application interface

Every hardware service lighting operation automatically enters the same guarded frame transport, including a single-output operation. Wrap multiple operations in the synchronous `hardwareService.batchLedUpdates(callback)` boundary to update the selected outputs together. Inspect each returned result **after** the callback returns; confirmation happens when the batch commits. Nested batches join the outer boundary. A batch cannot cross an asynchronous boundary.

Use this interface for future functionality; do not add delays, call the serial transport directly, or build per-output retry loops. Existing text, task digits, blink, locate and clear primitives all use it. A new rendering primitive should extend the shared frame encoder and firmware validator together, preserving whole-frame validation and acknowledgement. The simulation adapter keeps the same hardware service interface.

The service still validates each target's display/task ownership, generation, mapping, maintenance hold and controller readiness before transmission. Controllers are independent: each receives one frame, and a failed controller does not cause successful controllers to be marked failed. Work and stocktake guidance is marked delivered only after acknowledgement. Unconfirmed display cleanup remains pending for retry. No task, inventory or location mapping is changed by batching.

## Wire format and reliability

`to ADDRESS display-frame REQUEST DATA CHECKSUM`

- `REQUEST`: 16 lowercase hex characters, unique per controller update.
- `DATA`: lowercase hex encoding of a byte count (1–64), then entries. Each entry contains channel (1 byte), mode (1), brightness percent (1), RGB (3), scroll speed milliseconds (2), animation duration milliseconds (4), flags (1), text length (1), and up to 55 printable ASCII text bytes. Integers use big-endian order. Modes are text=1, task digits=2, idle/clear=3, blink=4, locate=5. Flag 1 means scroll once for text.
- `CHECKSUM`: CRC-32/ISO-HDLC over `UPPERCASE_ADDRESS display-frame REQUEST DATA`.
- Confirmation echoes the address, request and checksum with `type: ack` and `command: display-frame`.

The firmware checks every entry, mapping and checksum before modifying any module. It renders all included outputs and calls `pixels.show()` once. Animation start times are shared; omitted outputs retain their state. Recent request IDs and checksums are remembered so a lost acknowledgement cannot restart or resurrect a display. ID reuse with different content is refused. Frames are exactly addressed and rejected over USB maintenance.

The app sends once, reads until the matching acknowledgement arrives, and retries the identical frame up to three times only when confirmation is missing. It does not add legacy repeat or per-output pauses on this path. A one-millisecond electrical turnaround guard lets the RS485 driver release the bus after its reply. Acknowledgement timeouts include serial transmission time and a complete 64-module refresh. Wrong-address, stale-request and wrong-checksum responses never confirm delivery. No unacknowledged modern frame falls back to blind legacy commands.

The input and serial receive buffers accommodate a complete 64-output frame, including 55-character text on every output. The persistent controller configuration format is unchanged.

## Verification

Automated checks execute the actual sketch with native stubs, verify one latch per frame, all-or-none rejection, omitted output preservation, retry deduplication and maximum frame size. Application/transport checks cover all display kinds, shared task guidance, failed delivery and safe cleanup. Hardware timing is still bounded by serial transmission and NeoPixel refresh; there is no intentional half-second per-output delay. Separate ESP32 controllers are sent sequentially on the RS485 bus and are not electrically simultaneous.

On the Raspberry Pi, flash v15, reconnect the same wiring and test Show quantity, Display LED number, cell names, locate, ping and Stop. Test an active PICK/PUT display override and confirm its original guidance returns. Also test a disconnected controller and a successful retry. Native tests do not replace a real ESP32 build and bench check.
