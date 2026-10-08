# Task and location history

Implemented on `public-product-development`, 1 October 2026.

## User experience

- Work navigation now contains My work, Assign Work (permission dependent), and History. The Needs Review sub-tab is removed; review handling remains in My work. Existing direct review URLs remain available for compatibility.
- History reuses the compact My work table: Task, Product, Unit, Requested, Completed, Remaining, Status, Progress, State, Action. Sorting, the five column filters, immediate review-only filtering, and 20/50/100 pagination work within History. Default page size is 50. My history retains current and earlier assignments; users with team access can select Team history.
- The task number and History button open a read-only popup. Its summary matches the existing review summary. Below it is a chronological event table with IST timestamps, step, actor/assignee, location, quantity/unit, and details. Back/Escape/browser Back return to the originating view. Long timelines paginate at 100 events without silently truncating older entries.
- Every location card and location detail heading has a clock/history icon with the accessible label and tooltip “history of movement in this bin/cell”. It opens a movement table with timestamp, task, product, movement type, signed stock delta, historical unit, performed by, recorded by, and note. It paginates at 50 movements, newest first, and supports popup/browser Back.
- Tables scroll horizontally on small displays; summaries adapt to available width.

## Data and boundaries

`src/modules/operations/history.js` builds on-demand read models from assignment events, work events, instruction snapshots, reports, and the append-only movement ledger. No replacement database, inventory migration, balance rewrite, light command or task-start action is required to read either timeline.

Existing logs were split across these stores. New logging fills gaps for self-start, explicit resume, QR verification, review transition and task completion. These events remain within the existing transactional/idempotent command path, so a retried command does not append a duplicate event. Location completion is logged before task completion.

Reported/observed quantities are distinct from actual ledger movements. Only ledger rows represent stock changes; timeline quantities must not be summed. Corrections remain visible rather than overwriting earlier movements. Ledger units and unknown performer identity are preserved. Instruction-time location/unit data is used where available for non-ledger events.

Task history uses the existing work permission and task ownership rules. Cell history requires location access and reveals all movements only with team-work access; other users see entries they recorded or performed. Direct endpoints enforce the same rules. Client reads reject responses belonging to a different account/warehouse/dataset.

Older tasks can show only events and times that were actually recorded. A legacy review with no transition timestamp is explicitly labelled. Missing old resume/scan events are not invented or backfilled. Current location/product/person names may reflect later renames where the old event did not snapshot them.

## Verification

- Full Node test suite: 398 tests passed.
- Additional focused rerun after the final historical-unit/API checks: 13 tests passed.
- Tests cover per-cell multi-location movement, QR verification, replay-safe resume logging, return/reassignment/review, previous-assignee access, unauthorized access, read-only database state, historical units and unknown performers, timeline/bin pagination, sorting/filter scope, UI escaping and read-only controls.
- Browser checks on isolated simulator preview: History table and popup, team-scope filter application, browser Back, location card history popup, and narrow-screen containment with horizontally scrollable tables.
- A completed multi-cell demonstration task with return, reassignment and review was added only to the isolated port-3213 preview. Port-3210 customer preview data was preserved.
- No physical hardware, camera permission, Raspberry Pi installation or warehouse Wi-Fi changes were made or claimed tested by this task.

No commit or push was requested for this change.
