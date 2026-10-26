# Simultaneous LED ping

The app and `firmware/esp32-simple-matrix/esp32-simple-matrix.ino` support grouped ping in protocol `simple-matrix-v13-rs485-addressed`. A selected group of two or more cells on one controller is rendered in a single NeoPixel refresh, with one shared animation start time. Single-cell ping continues to use the individual command. Separate controllers receive separate groups; synchronization across controllers is not guaranteed. Other display actions retain their existing commands.

## Update and bench check

1. Deploy the updated application on the host that controls RS485.
2. Use the existing Hardware configuration firmware flash workflow to compile and upload the updated simple-matrix sketch. Preserve the correct module count, controller name/address and board target. For a pinned offline toolchain, regenerate its manifest with `scripts/prepare-firmware-bundle.mjs` for the new protocol before deploying the bundle; the pinned compiler/core/library versions are unchanged.
3. Restart the application after flashing to clear capability caches, or allow up to 60 seconds for capability refresh.
4. Ping all four outputs. All four should begin the outward green animation together and end after five seconds. Check individual ping, early Stop, automatic expiry and restoration of an overridden task light.
5. Verify a selected subset changes only its selected outputs. Check that active stocktake guidance remains protected.

Compilation on the actual ESP32 toolchain and physical checks are required at the bench. The native C++ test runs the actual sketch with fake timing, pixels and serial hardware; it does not validate the ESP32 toolchain, electrical installation or physical timing.

## Delivery and failure handling

The controller advertises `groupBlink: 1` in its ping/status response. Older controllers continue receiving individual commands after capability discovery. An unanswered probe does not trigger blind LED commands.

Wire format:

```
to ADDRESS blink-group REQUEST MASK green BRIGHTNESS DURATION CRC
```

`REQUEST` is a random 16-character hexadecimal ID. `MASK` has 64 hexadecimal digits: bit 0 of digit 0 selects output 1, bit 1 selects output 2, and so on through output 255. Unselected outputs are untouched. Brightness is 0–100; duration is 1–300000 milliseconds (the app uses 5000). CRC is an eight-digit lowercase CRC-32/ISO-HDLC over the uppercase controller address, a space, and the exact space-separated REQUEST through DURATION fields. Binding the checksum to the address prevents a corrupted address from applying the group to another controller.

The firmware validates the complete request, including every selected output and checksum, before modifying any LED state. It stages all selected modules, calls `pixels.show()` once, then acknowledges with controller address and request ID. The host accepts only a matching acknowledgement and retries an unconfirmed request up to three times. The firmware remembers the last eight request IDs/checksums, acknowledging duplicates without restarting their animation or reviving an expired ping. Reusing an ID with changed content is rejected. This cache is volatile across controller resets.

If acknowledgements remain missing, the app reports failure, stops the display, clears potentially affected targets and requests restoration of prior task guidance. Cleanup retains existing mapping, ownership and generation checks. Cleanup cannot guarantee delivery over a failed link; firmware expiry bounds the temporary ping to five seconds. No successful delivery is inferred from a successful serial write alone.

## Automated checks

`node --test test/grouped-ping.test.js test/location-group-displays.test.js test/location-setup-display.test.js test/cell-display-ownership.test.js`

The native firmware test needs a C++17 compiler (`CXX` or `c++`). It covers shared timing/single refresh, bad CRC, invalid group member, invalid duration, duplicate retries, ID collisions, selected subsets and delayed retries after expiry. Adapter tests cover acknowledgement matching, lost delivery/retry, legacy fallback and offline controllers. Integration tests cover scoped targeting, Stop, uncertain-delivery cleanup and unchanged task restoration.
