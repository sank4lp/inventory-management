# Final actual-movement task closure

Built on `d7b4033`, on `public-product-development`. Scoped local delivery only; no push or merge. Existing task activation, assignment, observation, handback, decline and physical reporting flows remain available.

**Commit status:** implementation and verification are complete, but changes remain uncommitted. Automatic approval review rejected the scoped local commit because the new accounting scope was authorized through the coordinating chat, and rejected a retry after reading that chat's original user request because retrieved tool output was not accepted as trusted authorization in this chat. No alternate commit mechanism was attempted. Direct approval is required here before committing.

## User flow

Every Stop remaining work entry point now uses the same aggregate closure form, including task detail, team task rows and the Review task inline panel. No UI submits the older conservative `stop` command. The compact task summary retains people, IST times, deadline and requested/completed/remaining progress. Recorded task totals appear per location; untouched plans are shown as zero, never assumed moved.

The exact termination question has mutually exclusive Yes/No radios with neither selected initially. Yes confirms recorded totals. No reveals editable final totals with one searchable location picker per row, zero allowed, and add/remove controls. Omitted locations become zero for this task. These quantities describe total task movement at each cell, not extra movement or the location's entire stock. Location, quantity and unit are inline on wide screens; on phones location stacks above the adjacent quantity/unit pair.

The footer actions are **Close task** and **Send for review**. **Back** dismisses the Stop popup. Handback/decline remain separate secondary actions. Opening dialogs, editing rows and expanding Stop acquire no turn and issue no hardware command.

## Accounting and authorization

`task-closure.js` runs inside the existing command transaction and receipt envelope. It validates current actor/warehouse/dataset, assignment generation, task/evidence progress and the displayed accounting-unit token. Unrelated task activity does not invalidate an open dialog; actual balances, other reservations, capacity, active locations and stocktake/condition boundaries are checked atomically at submission.

Final actual totals are compared with this task's settled totals. Only the signed differences are appended to the inventory ledger. Existing ledger entries and report evidence are not overwritten. Settlement totals and line revisions advance with explicit before/after reconciliation events. For pick 10 / recorded 4, confirming Yes keeps the deduction at 4 and releases the remaining 6. Entering 3 posts only +1. Relocation corrects both cells. Put uses the opposite sign. All task reservations and turns are released after successful closure; competing task claims remain intact.

Existing settlements retain their original report and performer attribution. Newly reconciled rows are not automatically attributed to an earlier worker: where attribution is ambiguous, the performer remains unknown, with the closer/reviewer and original records retained. Explicitly closed tasks cannot be reopened by the legacy partial-task reassignment route.

Own closure is scoped by `work.stop`, now labeled “Confirm actual totals and close own task.” It does not grant general inventory adjustment or review authority. Only the current assignee can use the ordinary closure route. An original worker can reconcile their own earlier unknown quantity by explicitly entering final actuals; Yes alone cannot silently treat uncertainty as zero. Check-only recipients and other-performer evidence require a verifier.

Authorized team users may submit a closure for review. Direct verified team closure additionally requires `work.teamStop`, `review.resolve` and `review.stop`, evidence text and confirmation that workers stopped. A supervisor resolving a genuine shortage/capacity/mixed-product conflict records a discrepancy while retaining other tasks' reservations. Controlled stock still requires its condition review first. Unreliable unit history is rejected rather than guessed; supported historical factors are audited with the closure.

## Review and late evidence

Send for review saves one aggregate case with all proposed totals, sets the task to Needs review, stops further execution and preserves held reservations and existing evidence. It appears in the administrator's returned work / quantity-check table and pending-review flow. It is never reported as a successful closure. Review task shows the aggregate totals and verifier link rather than treating that aggregate as a single-cell observation.

The verifier can edit final totals and finalize the aggregate, or keep it pending. Original individual evidence remains reviewable; resolving it invalidates the old aggregate progress token. Evidence for another product, direction or unit must be resolved first. A stocktake-accounted difference can be explicitly linked per location: cell, product, accounting unit, direction and unused correction amount are validated, and no second stock posting occurs. A separate difference requires explicit verification that it was outside overlapping count corrections. The UI offers recent approved counts; the command validates any supplied link against the actual record.

Late phone reports after closure/request are retained for review without posting stock again. Receipt replay returns the original accepted result without repeating corrections. Aggregate-case markers are created internally; ordinary movement input cannot forge them.

## Drafts and device status

Actual rows, radio choice and typed values are durably drafted. A closure request is persisted before delivery, retried with its frozen identity/payload, and reported successful only after warehouse acceptance. Rejected, stale, offline or lost-response attempts retain the draft and actionable error. Unsynced task movements and outstanding manual evidence block closure. Existing observation drafts also block management actions until saved or cleared.

The separate top Saved updates panel is removed. Unconfirmed/failed device requests have a short visible status with access to details and retry in secondary device help. Accepted review receipts live in the task/review workflow and secondary receipt details, with no top saved-update warning. The account-wide notice likewise excludes accepted review receipts. Export/recovery/outbox storage is preserved. Service-worker cache is v26.

## Command contract

- `closeTask` / `sendTaskReview`: existing request/site/dataset/actor/device identity, `taskId`, `generation`, `progressToken`, `closureToken`, `currentStatus: "yes" | "no"`; No also takes `actuals: [{cellId, quantity}]`. No duplicate cells; at least one row, maximum 200; zero and six-decimal quantities are accepted within existing quantity bounds.
- Direct verified closure adds `verifiedClosure: true`, `workerStopped: true` and `verification`, with the permissions above.
- Aggregate review uses `resolve` with `reportId`, `caseRevision`, fresh task/generation/progress/closure fields, `currentStatus: "no"`, `actuals`, `workerStopped: true` and `verification`. Optional `countLinks: { [cellId]: observationId }` accounts for approved count differences; `afterCountVerified: true` explicitly verifies separate differences. Existing `keepOpen` retains the case.

## Verification and preview

Full suite: **331/331 passed**, zero failures, `/private/tmp/task-closure-full.log`. Earlier affected UI/client/service checks passed **92/92**. Coordinating review independently passed **20** service scenario groups, `/private/tmp/task-closure-independent.log`. `git diff --check` passes.

Coverage includes pick/put current totals, corrections, zero, multiple cells, redistribution, reservation release, wrong actor/permission, stale identity/version, unrelated activity, conflicting reservations, supervisor discrepancy resolution, original-worker uncertainty, transferred checks, review inbox/replay, late phone evidence, count overlap/linking without double posting, unit-history rejection, accepted-review status, durable closure submission, lost receipt retry, rejection/offline drafts, retained supervisor reconciliation drafts and unsynced movement guards.

GET-only synthetic browser evidence in `docs/evidence/task-closure/` covers desktop, 820×1180 tablet and 390×844 phone; title focus, neither answer selected, Yes/No switching, retained row values, searchable keyboard selection, add/remove rows, adjacent quantity/unit layout, reachable footer/Back, and the Review task inline entry. No browser submission or authenticated stock mutation occurred. Temporary tab closed; viewport reset. Physical phone keyboards, scanners and hardware require later field acceptance; none were used here.

Simulator refreshed at http://localhost:3213/work using the existing disposable directory `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`, `HARDWARE_ADAPTER=simulator`. Session **65173**, log `/private/tmp/my-work-preview.log`; read-only checks returned Work 302 and client asset 200. GET-only fixture session **38780**, port 3221, `/preview?mode=stop` or `mode=check`.
