# Shared stocktaking and immediate counts

Implemented locally on `public-product-development`. This extends the existing Stocktaking tab and its local Raspberry Pi data model. No cloud, installer, tenancy, Pick/Put screen or production-data changes are included.

## Operator flow

1. Choose Whole warehouse, Shed / Shelf or Product. Existing single-location and product-at-location links remain supported. Product counts can include additional locations and leave other products in mixed cells unchanged.
2. Select counters and optionally a due date. Several eligible counters can share an area. Managers can assign different remaining warehouses or shelves within a run.
3. Scan a location QR in a popup, or select the location manually. The popup retains Back, Close, a manual fallback and the small Wrong / undetected location? action.
4. The claimed location turns orange. Enter each physical quantity, including an explicit zero, or use Accept current counts for the displayed values. Empty locations require an explicit empty confirmation.
5. Save applies known product counts immediately, records the before/after quantity, counter and receipt, then advances to the next available location in the displayed order. A matching count is audited without inventing a stock movement.
6. Completed locations turn blue while counting continues. The final completed location automatically ends the stocktake display and shows a completion popup. A manager can still explicitly show or end progress LEDs without losing counts or clearing another task's lights.
7. Leaving an active stocktake shows the progress-saved popup. Stay keeps counting; Leave releases only that browser's active cell. The last counter leaving pauses the stocktake and clears its remaining progress lights. Continuing the same run preserves its saved counts and restores the appropriate progress LEDs.

## Ownership and stock safety

- Yellow and blue are passive stocktake progress. They do not reserve a cell or obstruct Pick/Put.
- Orange owns only the location being counted. Other locations remain usable. Already active Pick/Put at that location finishes before counting can start.
- Pick/Put temporarily replaces idle yellow/blue with its existing task display. When its cell work finishes, the current stocktake marker and current quantity return.
- A waiting count does not prevent the already active Pick/Put from posting its movement.
- A user can hold one counted location at a time. Shared-area claims are transactional and generation checked. Finish or pause the current location before claiming another. Browser sessions are fenced by counter, run, cell and generation, so late departure or heartbeat requests cannot clear another counter or a newer session.
- Direct movement posting is guarded at the active counted location. The count's own audited correction is allowed.
- Repeated receipts cannot post a correction twice. Changed stock, units, labels, mapping, dataset or assignment cannot silently overwrite a fresh balance. Stale live saves stay on the device and request pause/fresh count; late evidence is retained without posting against new instructions.
- A physical correction can flag now-infeasible reservations for high-priority task review. The corrected count itself does not require quantity approval.
- Count discrepancies do not establish their cause. Optional reported reasons remain distinct from verified reasons. Damaged/expired goods are included while physically present; unidentified goods retain their existing condition-check flow. Already saved known quantities are not presented as another correction to approve.
- A newer stocktake display replaces progress ownership only on its selected cells. Ending an older display cannot clear a newer display, and ending the newer display does not resurrect obsolete markers.

## LED delivery

Background yellow/blue writes and cleanup yield between cells. Each queued write rechecks its current generation, hardware binding and utility-display ownership before sending. Orange and active task guidance retain priority. Failed background writes remain undelivered for maintenance retries; offline-to-online controller transitions request current guidance again. Mixed-cell quantities alternate in the stocktake state's color. Software delivery acknowledgement is not proof of a physical LED or a physical count.

## Upgrade

Adds shared-counter membership, persistent progress ownership, browser presence and run display/pause settings. Future saves on existing runs use immediate counting; migration does not apply historical observations or create adjustment transactions. Historical evidence and guarded review actions remain available. Historical zero balances stay in the baseline for conflict detection but need no visible counting row or synthetic observation; positive recorded quantities must still be explicitly counted, including zero when missing.

## Verification

Paused stocktakes and assigned work:

- A paused run exposes Resume on the Stocktaking list, its run screen, and each assignee's My Work entry. Passive viewing keeps the run paused with its LEDs off. Explicit Resume reacquires a fresh counting session and restores saved indicators without discarding completed counts.
- Assigned counts share the existing My Work table, filters, numeric sorting, pagination, and oldest eligible next-work selection. They use location counts for requested/completed/remaining and their own Stocktaking links. An internal negative read-model ID separates a stocktake from a Pick/Put task with the same number; positive run IDs remain unchanged in the database and Stocktaking API. Pick/Put editing, bulk discard and history are not reused for counts.
- Operators see their assigned counts; admins with team-count access can see assigned team runs. Shared completion is evaluated once on the run. It removes the active My Work entry for every assignee, including someone who performed no count. The polling update also removes a completed count row if it has focus. Audit records remain in Stocktaking history.
- Regression cases cover three shared assignees with two actual counters, outsider isolation, reassignment, retained progress across Resume, combined pagination/filters and colliding task/run numbers, and the browser presentation of a paused run.

- Full automated suite after the mobile count, session-pause, Resume and shared My Work assignment refinements: 593 passed, zero failed or skipped.
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

## Mobile counting and departures

- Scoped forms use full available width with no inherited form margins. Button pairs share their width and height, and searchable inputs and their arrows use the same control height. Phone counts place Product and Condition together, then Recorded, Actual and Unit in one aligned row. Optional condition fields expand below that row.
- Count rows include only positive recorded stock. An empty location has an explicit empty confirmation, while Found another product lets counters reintroduce a physically present product, including one with a historical zero balance. Product-only stocktakes restrict this choice to the selected product and never change other products. Adding/removing a found row updates the empty confirmation and table immediately.
- A 10-second heartbeat renews a 45-second browser lease. Ordinary app navigation awaits the owned-cell release; abrupt closure uses a keepalive departure request, with lease expiration as a fallback if it cannot be delivered. Heartbeats do not create receipt records, and late heartbeats cannot restart a left session. Existing hardware delivery retry remains responsible for clearing failed/offline displays.
- The custom popup applies to app navigation. Browsers cannot guarantee an application popup or a successful request on a force-close/power loss. Completed server counts and local drafts remain retained; an interrupted unfinished cell requires a fresh count after reacquiring it, rather than applying stale quantities to new stock.
- Completion ends progress indicators independently of the browser, preserving the stock correction and audit. Software checks cover protection of another counter, active Pick lights, stale pages, crossed identities, lease expiry, resume and final completion. Actual phone QR decoding and physical light delivery remain field checks.
