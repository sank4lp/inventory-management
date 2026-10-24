# Locate and Ping restoration

## Behavior

- Locate sends the existing inward red matrix ripple for 300,000 ms. Its button becomes green “Locating”; clicking it again stops the owned display.
- Ping sends the existing outward green ripple for 5,000 ms and resets its inline button afterward.
- Shared inline controls cover mapped location cards, location details, product/location utilities, adjustments and dynamically rendered task cards. Controller and cell hardware tests also use Ping.
- The local master implementation was compared read-only. It uses the firmware’s `locate` and `blink` commands. Those command paths are reused; durations are updated from its older defaults to the requested five minutes and five seconds.
- Utility Locate no longer sends yellow LOC text. Ping no longer redirects to the quantity-display page.

## Ownership and recovery

Existing permission, task override confirmation and stocktaking protection remain. Patterns do not change inventory. When a pattern stops or expires, valid task guidance is restored. Display receipts and generation/binding checks prevent stale clears from erasing newer work. Managed Locate expiry uses the coordinator rather than an unguarded adapter timer. Navigation clears only the current owned display and removes page timers/listeners.

## Verification

- Full Node suite: 495 passed, 0 failed, 0 skipped.
- Added coverage for exact RS485 commands, five-minute Locate expiry, five-second Ping expiry, task restoration, replay safety and unchanged inventory.
- Preview uses isolated demo data and simulated hardware. Locations verified: Locate changes to green Locating, repeat click returns to Locate, Ping changes to Pinging then resets after five seconds, and both remain on the same page. No browser warnings/errors were observed.
- Browser navigation tests cover shared Ping/Locate controls and cleanup without duplicate handlers.

## Field validation

Real Raspberry Pi serial output, visible matrix animation and firmware build/flash were not performed here. Existing firmware already parses the restored commands and their durations. Verify the red inward and green outward animations on the installed controller firmware after deployment.

## Maximum brightness follow-up

All app lighting actions now resolve to 100% brightness, including restored patterns, Pick/Put guidance, quantity/capacity displays, stocktaking and setup. Legacy day/night settings are ignored and removed from runtime configuration. Simulator and hardware event payloads report `maximum`.

Both firmware sketches now default to maximum brightness; the current sketch’s idle heartbeat also uses full red. App-command brightness takes effect after updating/restarting the Pi service; firmware defaults and idle heartbeat require flashing the updated sketch. Real LED intensity and firmware compilation/flashing remain unverified here (Arduino CLI is unavailable locally).

Validation: 62 focused checks passed; the full suite passed 496 tests with zero failures/skips. RS485 command checks cover Pick, Put, quantity display, Locate and Ping at noon and night with legacy lower-brightness values supplied. Ownership/expiry/restoration regression tests remain passing. The isolated simulator preview was restarted on port 3210 with the new policy.

## Inline Ping and Products follow-up

- Hardware mapping Ping buttons now use the shared inline cell control instead of submitting the older hidden form. Controller Ping also uses an inline receipt with preview, stop and five-second expiry. These controls show Pinging and allow an early stop. Hardware-test permission is retained for controller Ping.
- The standalone quantity-display screen is removed. Old bookmarks return to the normal product/location pages; current controls no longer navigate there. Recommended Actions retains its own status/stop controls.
- Warehouse-wide Show All Quantities sends numeric 0 to empty mapped locations, whether they have no balance row or an explicit zero balance. It remains enabled even if every product is out of stock. Existing ownership and uncertainty protections remain.
- Products adds Show In Stock Products Only. Selecting either stock checkbox clears the other; search remains available.
- Product status summaries use an available-width container with three columns above 900px, two up to 900px and one up to 580px. Print controls remain available on each entry.

Validation: full suite 498 passed, zero failed/skipped. Focused checks cover controller Ping JSON receipts, early stop, repeated navigation, empty-cell zero commands, product search with stock filtering and retired-page redirects without inventory changes. Browser checks verified mapping Ping stays at /devices#cell-mapping, returns to Ping after expiry and stops on a second click. Stock checkbox exclusivity, all three summary layouts and print controls were checked in the isolated preview. No browser warnings/errors observed. Actual Pi/LED verification remains a field check.
