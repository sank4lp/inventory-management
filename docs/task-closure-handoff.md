# Final actual-movement task closure

Original closure implementation was saved as `3fb1bad`; this table/attestation refinement builds on that commit, on `public-product-development`. Scoped local delivery only; no push or merge. Existing task activation, assignment, observation, handback, decline and physical reporting flows remain available.

**Refinement status:** scoped changes are ready for coordinating review and local save. No push or merge was performed here.

## User flow

Every Stop remaining work entry point now uses the same aggregate closure form, including task detail, team task rows and the Review task inline panel. No UI submits the older conservative `stop` command. The compact task summary retains people, IST times, deadline and requested/completed/remaining progress. Recorded task totals appear per location; untouched plans are shown as zero, never assumed moved.

The exact termination question has mutually exclusive Yes/No radios with neither selected initially. Yes confirms recorded totals. No reveals editable final totals with one searchable location picker per row, zero allowed, and add/remove controls. Omitted locations become zero for this task. These quantities describe total task movement at each cell, not extra movement or the location's entire stock. Closure and aggregate review share a semantic table with Actual location, Actual quantity, Unit and Remove columns. Each row has one searchable location control. Quantity and unit remain adjacent at desktop, tablet and phone widths; dropdowns can extend beyond the narrow location cell without clipping.

The footer actions are **Close task** and **Send for review**. **Back** dismisses the Stop popup. Handback/decline remain separate secondary actions. Opening dialogs, editing rows and expanding Stop acquire no turn and issue no hardware command.

## Accounting and authorization

`task-closure.js` runs inside the existing command transaction and receipt envelope. It validates current actor/warehouse/dataset, assignment generation, task/evidence progress and the displayed accounting-unit token. Unrelated task activity does not invalidate an open dialog; actual balances, other reservations, capacity, active locations and stocktake/condition boundaries are checked atomically at submission.

Final actual totals are compared with this task's settled totals. Only the signed differences are appended to the inventory ledger. Existing ledger entries and report evidence are not overwritten. Settlement totals and line revisions advance with explicit before/after reconciliation events. For pick 10 / recorded 4, confirming Yes keeps the deduction at 4 and releases the remaining 6. Entering 3 posts only +1. Relocation corrects both cells. Put uses the opposite sign. All task reservations and turns are released after successful closure; competing task claims remain intact.

Existing settlements retain their original report and performer attribution. Newly reconciled rows are not automatically attributed to an earlier worker: where attribution is ambiguous, the performer remains unknown, with the closer/reviewer and original records retained. Explicitly closed tasks cannot be reopened by the legacy partial-task reassignment route.

Own closure is scoped by `work.stop`, now labeled “Confirm actual totals and close own task.” It does not grant general inventory adjustment or review authority. Only the current assignee can use the ordinary closure route. An original worker can reconcile their own earlier unknown quantity by explicitly entering final actuals; Yes alone cannot silently treat uncertainty as zero. Check-only recipients and other-performer evidence require a verifier.

Authorized team users may submit a closure for review. Direct verified team closure additionally requires `work.teamStop`, `review.resolve` and `review.stop`, an explicit checkbox confirming all workers stopped and actual totals were verified. The checkbox starts unchecked. The two final-total verification text questions are removed. A supervisor resolving a genuine shortage/capacity/mixed-product conflict records a discrepancy while retaining other tasks' reservations. Controlled stock still requires its condition review first. Unreliable unit history is rejected rather than guessed; supported historical factors are audited with the closure.

## Review and late evidence

Send for review saves one aggregate case with all proposed totals, sets the task to Needs review, stops further execution and preserves held reservations and existing evidence. It appears in the administrator's returned work / quantity-check table and pending-review flow. It is never reported as a successful closure. Review task shows the aggregate totals and verifier link rather than treating that aggregate as a single-cell observation.

The verifier can edit final totals and finalize the aggregate, or keep it pending. Original individual evidence remains reviewable; resolving it invalidates the old aggregate progress token. Evidence for another product, direction or unit must be resolved first. A stocktake-accounted difference can be explicitly linked per location: cell, product, accounting unit, direction and unused correction amount are validated, and no second stock posting occurs. A separate difference requires explicit verification that it was outside overlapping count corrections. The UI offers recent approved counts; the command validates any supplied link against the actual record.

Late phone reports after closure/request are retained for review without posting stock again. Receipt replay returns the original accepted result without repeating corrections. Aggregate-case markers are created internally; ordinary movement input cannot forge them.

## Drafts and device status

Actual rows, radio choice and typed values are durably drafted. A closure request is persisted before delivery, retried with its frozen identity/payload, and reported successful only after warehouse acceptance. Rejected, stale, offline or lost-response attempts retain the draft and actionable error. Unsynced task movements and outstanding manual evidence block closure. Existing observation drafts also block management actions until saved or cleared.

The separate top Saved updates panel is removed. Unconfirmed/failed device requests have a short visible status with access to details and retry in secondary device help. Accepted review receipts live in the task/review workflow and secondary receipt details, with no top saved-update warning. The account-wide notice likewise excludes accepted review receipts. Export/recovery/outbox storage is preserved. Service-worker cache is v27. When restoring dynamic rows, the saved `_actuals` list takes precedence over older indexed control values, preventing duplication or loss after removing the first row.

## Command contract

- `closeTask` / `sendTaskReview`: existing request/site/dataset/actor/device identity, `taskId`, `generation`, `progressToken`, `closureToken`, `currentStatus: "yes" | "no"`; No also takes `actuals: [{cellId, quantity}]`. No duplicate cells; at least one row, maximum 200; zero and six-decimal quantities are accepted within existing quantity bounds.
- Direct verified closure adds `verifiedClosure: true`, `workerStopped: true`, with the permissions above. No verification text is required.
- Aggregate review uses `resolve` with `reportId`, `caseRevision`, fresh task/generation/progress/closure fields, `currentStatus: "no"`, `actuals`, `workerStopped: true`. No verification text is required. Optional `countLinks: { [cellId]: observationId }` accounts for approved count differences; `afterCountVerified: true` explicitly verifies separate differences. Existing `keepOpen` retains the case.

Both verified routes require strict boolean `workerStopped === true` and audit “Checkbox attestation: all workers have stopped and the actual totals are verified.” Optional legacy `verification` text is retained as additional verification. No specific method is invented. Send for review accepts an unchecked attestation without recording this confirmation. Ordinary movement-review verification requirements remain unchanged.

## Verification and preview

Original closure full suite (before this refinement): **331/331 passed**, zero failures, `/private/tmp/task-closure-full.log`. Earlier affected UI/client/service checks passed **92/92**. Coordinating review independently passed **20** service scenario groups, `/private/tmp/task-closure-independent.log`. `git diff --check` passes.

Coverage includes pick/put current totals, corrections, zero, multiple cells, redistribution, reservation release, wrong actor/permission, stale identity/version, unrelated activity, conflicting reservations, supervisor discrepancy resolution, original-worker uncertainty, transferred checks, review inbox/replay, late phone evidence, count overlap/linking without double posting, unit-history rejection, accepted-review status, durable closure submission, lost receipt retry, rejection/offline drafts, retained supervisor reconciliation drafts and unsynced movement guards.

GET-only synthetic browser evidence in `docs/evidence/task-closure/` covers desktop, 820×1180 tablet and 390×844 phone; title focus, neither answer selected, Yes/No switching, retained row values, searchable keyboard selection, add/remove rows, adjacent quantity/unit layout, reachable footer/Back, and the Review task inline entry. No browser submission or authenticated stock mutation occurred. Temporary tab closed; viewport reset. Physical phone keyboards, scanners and hardware require later field acceptance; none were used here.

Simulator refreshed at http://localhost:3213/work using the existing disposable directory `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`, `HARDWARE_ADAPTER=simulator`. Session **65173**, log `/private/tmp/my-work-preview.log`; read-only checks returned Work 302 and client asset 200. GET-only fixture session **38780**, port 3221, `/preview?mode=stop` or `mode=check`.


### Table and checkbox refinement verification

Current focused backend/UI/client suite: **101/101 passed**, `/private/tmp/closure-table-focused.log`; searchable-select checks: **7/7 passed**, `/private/tmp/closure-table-searchable.log`. Syntax and `git diff --check` pass. Independent coordinating review passed **8** disposable-database scenario groups in `/private/tmp/closure-checkbox-independent.log` (pick/put × direct/review × absent/legacy text), including rejection rollback, audit attestation, reservation release and idempotent replay. No full-suite rerun was needed for this scoped refinement.

Added regression coverage checks checkbox-only direct/review closure, undefined/false/string/number attestation rejection, optional legacy evidence preservation, unverified review submission, ordinary movement-review evidence, semantic table/shared unchecked checkbox, and authoritative row restoration after first-row removal. Existing durable draft, lost-response and rejected-request coverage remains green.

New GET-only synthetic browser evidence is in `docs/evidence/task-closure-table/`: `tablet-draft.png`, `phone-table.png`, `phone-dropdown.png`, `phone-review-dropdown.png`, and `desktop-review.png`. Checked 1366×1000 desktop, 820×1180 tablet and 390×844 phone. Location search/keyboard selection, add/remove, Yes/No value retention and save/restore in both forms work. A three-row closure restored A-02=2 and A-03=3 after removing the first row, without duplication. The phone location dropdown fits from x=37 to x=297; page content width is 375 within a 390 viewport. Quantity/unit remain adjacent; footer actions and Back are reachable. Temporary tab closed and viewport reset. The “Save and restore preview draft” button appears only in this synthetic fixture and uses production draft save/restore with in-memory storage; it is not a product control.

Current simulator session **35310**, port 3213, uses the same disposable directory and simulator adapter above. Current GET-only fixture session **95983**, port 3221; `mode=team-stop` and `mode=closure-review` exercise the two refined forms. No stock commands, authenticated browser mutations, physical keyboard/scanner or hardware checks were performed.
