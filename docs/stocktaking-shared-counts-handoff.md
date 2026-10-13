# Shared stocktaking and immediate counts

Implemented locally on `public-product-development`. This extends the existing Stocktaking tab and its local Raspberry Pi data model. No cloud, installer, tenancy, Pick/Put screen or production-data changes are included.

## Operator flow

1. Choose Whole warehouse, Shed / Shelf or Product. Existing single-location and product-at-location links remain supported. Product counts can include additional locations and leave other products in mixed cells unchanged.
2. Select counters and optionally a due date. Several eligible counters can share an area. Managers can assign different remaining warehouses or shelves within a run.
3. Scan a location QR in a popup, or select the location manually. The popup retains Back, Close, a manual fallback and the small Wrong / undetected location? action.
4. The claimed location turns orange. Enter each physical quantity, including an explicit zero, or use Accept current counts for the displayed values. Empty locations require an explicit empty confirmation.
5. Save applies known product counts immediately, records the before/after quantity, counter and receipt, then advances to the next available location in the displayed order. A matching count is audited without inventing a stock movement.
6. Completed locations turn blue. Completing the entire run does not end its LED display. A manager can use End LED display without losing counts or clearing another task's lights.

## Ownership and stock safety

- Yellow and blue are passive stocktake progress. They do not reserve a cell or obstruct Pick/Put.
- Orange owns only the location being counted. Other locations remain usable. Already active Pick/Put at that location finishes before counting can start.
- Pick/Put temporarily replaces idle yellow/blue with its existing task display. When its cell work finishes, the current stocktake marker and current quantity return.
- A waiting count does not prevent the already active Pick/Put from posting its movement.
- A user can hold one counted location at a time. Shared-area claims are transactional and generation checked. Finish or pause the current location before claiming another.
- Direct movement posting is guarded at the active counted location. The count's own audited correction is allowed.
- Repeated receipts cannot post a correction twice. Changed stock, units, labels, mapping, dataset or assignment cannot silently overwrite a fresh balance. Stale live saves stay on the device and request pause/fresh count; late evidence is retained without posting against new instructions.
- A physical correction can flag now-infeasible reservations for high-priority task review. The corrected count itself does not require quantity approval.
- Count discrepancies do not establish their cause. Optional reported reasons remain distinct from verified reasons. Damaged/expired goods are included while physically present; unidentified goods retain their existing condition-check flow. Already saved known quantities are not presented as another correction to approve.
- A newer stocktake display replaces progress ownership only on its selected cells. Ending an older display cannot clear a newer display, and ending the newer display does not resurrect obsolete markers.

## LED delivery

Background yellow/blue writes and cleanup yield between cells. Each queued write rechecks its current generation, hardware binding and utility-display ownership before sending. Orange and active task guidance retain priority. Failed background writes remain undelivered for maintenance retries; offline-to-online controller transitions request current guidance again. Mixed-cell quantities alternate in the stocktake state's color. Software delivery acknowledgement is not proof of a physical LED or a physical count.

## Upgrade

Adds shared-counter membership, persistent progress ownership and run display settings. Future saves on existing runs use immediate counting; migration does not apply historical observations or create adjustment transactions. Historical evidence and guarded review actions remain available.

## Verification

- Full automated suite after QR reassignment and compact-location/search refinements: 577 passed, zero failed or skipped.
- Fifteen new stocktaking workflow regressions cover hierarchy/product scopes, shared claims, immediate audited corrections, duplicate receipts, persistent blue/end, active-work handoff, stale counts, reservation priority, QR scope, restart, stale background sends, failed-send retry, unidentified goods and migration without historical posting.
- Browser simulator checks: create a warehouse run, correct Combat Boots from 3 to 2, accept the next location unchanged, advance to the following location, pause/release, identify manually from the scan popup, and select multiple counters. The stored count and correction audit were inspected.
- Responsive checks at actual page widths 332, 393, 794 and 1336 pixels showed no document overflow. Phone counting keeps Recorded, Actual and Unit together. Results retain audit and review tools behind compact disclosures.
- The existing development preview is preserved. All browser writes were against an isolated simulator database, not the customer's Pi.

## Remaining decision and field checks

- Unknown/unassigned customer QR stickers can be assigned inline by users with the existing QR-management permission and physical confirmation. Already-bound QR reassignment is handled only in Manage Locations: the original cell's current QR must be checked and replaced first, then the released QR must be scanned and confirmed at the intended destination. Stocktaking shows the blocked-assignment disclaimer and a Manage Locations link. See `location-qr-reassignment-handoff.md`.
- Verify on the real Pi and warehouse network: camera permission/QR decoding on iPhone and Android, yellow/orange/blue visibility, mixed-cell number alternation, simultaneous counters, Pick/Put handoff, explicit display ending, controller power cycle and delivery retry, and behaviour when a phone loses connection.
- Work is uncommitted and has not been pushed.

## Compact location cards and search

- Location cards fit their content instead of stretching into squares. Shared sizing keeps visible cards equal across shelves at each viewport, including mixed-product cells, empty cells and edit mode. All product figures, history and LED/work actions remain available. Detail-page summaries use the same compact spacing.
- Stocktake runs show scanning/manual counting and a location search, with no location rows until a nonblank search. Matching is case-insensitive and partial across location names/codes and shelf/warehouse descriptions. Clearing search hides results; an unmatched query shows a short empty state.
- Product-scope location choices also appear only after search. Hiding a choice does not uncheck it or remove it from the saved scope. Warehouse restrictions still disable ineligible choices.
- Searching and live status updates replace only the result list, preserving the current count draft. Unchanged results are retained; changed results retain table scroll position and the origin link.
- Simulator browser checks confirmed uniform dimensions and no clipping at phone and desktop widths, mixed products across separate shelves, edit controls, movement-history access, empty/matching/no-match searches and a typed physical quantity remaining unchanged while searching.
