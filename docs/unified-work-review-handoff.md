# Unified My Work and Review handoff

Baseline: `0f020a4`, branch `public-product-development`. Changes are local; no push or merge.

## Behavior

- My Work has one table: Task, Product, Requested, Completed, Remaining, Status, Progress, State. Eligible own work and permitted returned/review work appear once. Text, numeric range, state and review-only filters and ascending/descending sorts run on the server before the 100-row page boundary. Sort ties use task ID. State sorts by its displayed labels: Needs Review, Task Completed, Task In Progress, Task Not Started for A–Z, with the reverse for Z–A. The next-task prompt uses original creation events independently of table sorting.
- State has Needs Review, Task Not Started, Task In Progress and Task Completed. Status distinguishes clean returns needing assignment from quantity checks, and stopped/cancelled from fully completed work. Remaining is unmet task quantity, including on partial closure; completed tasks have no executable work. Progress is actual/requested, never forced to 100%. Late evidence brings finalized work into Needs Review while its closure stays immutable.
- Review opens with Back, compact IST metadata and two choices. Align uses final per-location totals for this task, the shared actuals editor, existing audited closure/aggregate-resolution commands, verifier attestation and stocktake accounting controls. Finalized tasks link to retained late-evidence reconciliation instead of reopening.
- Assignment has its own Back, metadata, searchable assigned-to field, intended remaining quantity, and a deadline choice: Keep current, Set duration from now, or No deadline. A new duration defaults to eight hours; changing units retains the typed number. Save returns to refreshed Review after a receipt confirms acceptance.
- Unresolved assignment changes record responsibility, intended remaining work and deadline without changing physical reports, reservations or settled attribution. Execution remains blocked until verification. Verified followup can explicitly plan the intended remainder. The new nullable `tasks.review_remaining_quantity` column stores this intent, and is included in progress-version checks.
- Drafts and durable requests stay bound to their original task/account/dataset. Nested Back saves first; storage errors leave the step open. Rejected or lost submissions retain the draft. Retries send the same request. Role, generation, progress and closure-token checks remain enforced.

## Verification

- Full suite: **366 passed, 0 failed** (`npm test`). Subsequent focused assignment/client/closure run: **59 passed, 0 failed**. The final State-sort correction passed all five unified-work regression tests, including both directions across all four states and stable ties. Syntax and whitespace checks passed.
- New regression coverage includes a 125-row dataset with numeric ordering and ranges before pagination, scope isolation and deduplication, preserved/changed/removed deadlines, stale or unauthorized assignment rejection, immutable closure, unchanged physical evidence and holds, verified intended remainder, nested Back, storage failure, rejected/lost receipts and exact retry payloads.
- Coordinating reviewer independently reported nine task/query/closure scenario groups passing, plus twelve existing LED and multi-operator scenario groups. Real browser checks in disposable simulator 3213 confirmed clean reassignment, refreshed Review, final-total closure and reservation release. Desktop table layout was checked. Read-only responsive checks at 320, 390 and 768 pixels passed. Table scrolling stays inside its container; movement headings wrap at word boundaries and units stay beside quantity. Both dialog save paths remain reachable by vertical scrolling. The narrow Remove control uses an accessible × with a 44-pixel target. Final 320-pixel movement and 390-pixel assignment layouts were also visually checked in this writer chat. Browser Back retained edited movement totals when reopening Align, and entering 30 then choosing Minutes retained 30.
- GET-only fixture: `scripts/searchable-select-browser-fixture.mjs`, port 3221. Use `/preview?mode=table`, `/preview?mode=check&step=check-align`, or `/preview?mode=check&step=check-assignment`. Submissions are prevented, and non-GET requests rejected. No warehouse command or authentication endpoint is exposed by this fixture.

## Preview

The existing user-facing isolated preview at `http://localhost:3210/work` was refreshed in its original temporary fixture, preserving that fixture's database. Its process was verified as simulator/development/demo-only before restart. New PID: **87438**. Startup reported healthy database and RS485 simulator, and a read-only login-page request returned HTTP 200. No original warehouse database or physical hardware was used. Port 3213 is the coordinating reviewer's separate disposable simulator.

## Exact uncommitted files

- `public/client/work.js`
- `public/work.css`
- `scripts/searchable-select-browser-fixture.mjs`
- `src/modules/operations/queries.js`
- `src/modules/operations/schema.js`
- `src/modules/operations/service.js`
- `test/my-work-review.test.js` (new)
- `test/work-client-reliability.test.js`
- `test/work-refinement.test.js`
- `test/work-ui.test.js`
- `docs/unified-work-review-handoff.md` (new)
- `docs/evidence/unified-work-review/review-desktop.png` (new)
- `docs/evidence/unified-work-review/table-desktop.png` (new)
- `docs/evidence/unified-work-review/review-phone.png` (new)

Desktop and phone screenshots were captured by the coordinating reviewer and copied unchanged into the evidence directory.
