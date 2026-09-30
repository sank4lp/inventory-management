# Independent implementation review — 4df525e

Reviewed commit: `4df525eebe931aa761629f502b5b31b45914bd29` on 17 September 2026. Source was copied into `/private/tmp/inventory-review-approved-0uugiy6h`; all executable checks ran against isolated databases and mock/simulator hardware. Shared preview, implementation files, branches, and real inventory/hardware were not changed. This Markdown document is the only project file created by the reviewer.

**Result: two reproduced P1 defects and one P1 offline requirement gap remain. The current suite passes all 111 tests, but does not cover the two reproduced failure paths. This is not release approval.**

## Open findings

### 1. P1 — Duplicate resolution removes the inbox item while leaving its allocation and exclusive turn locked

Source: [duplicate resolution](/Users/sankalprajpoot/Documents/Personal/inventory-management/src/modules/operations/service.js), lines 282–287.

Reproduction: settle one pick; acquire a second pick at the same product/cell; submit the second line as a manual report; as admin, link that report to the first posted movement using `dismissDuplicate` with a verification reason.

Actual: response says recorded, pending report count becomes 0, but the second line remains `working`, its reservation remains held at 1, its cell turn remains `uncertain=1`, and its task remains `attention=1`. The inbox gives no remaining item through which to resolve this state, and the exclusive cell is blocked.

Expected: an explicit decision about the allocation remains available until its reservation, execution state, turn, and task status are consistent with the duplicate disposition. Merely hiding the report must not leave invisible unresolved work.

Fix guidance: either require and atomically apply an allocation disposition when linking a duplicate, or leave a visible resolution item for that disposition. Do not post stock again or silently infer unknown physical quantities. Test same-request replay, reservation release or explicit preservation, next-operator acquisition, and inbox/task consistency.

### 2. P1 — Inactivity queues a hardware clear but never delivers it from the maintenance timer

Sources: [inactivity handling](/Users/sankalprajpoot/Documents/Personal/inventory-management/src/modules/operations/service.js), lines 492–506; [maintenance timer](/Users/sankalprajpoot/Documents/Personal/inventory-management/src/server/app-state.js), lines 60–63.

Reproduction: acquire a cell; advance the inactivity check ten minutes; issue no later work command. The controlled hardware fixture records only `activate`. The guidance row contains `{"action":"clear"}` with `delivered=0`; one pending verification report exists.

Actual: the maintenance timer calls only the inactivity function. Flushing happens on startup or after commands, so stale physical guidance can remain until another command or restart. Ordinary snapshot refreshes do not flush it.

Expected: after marking a turn uncertain, its obsolete guidance is cleared without requiring unrelated user activity, while the reservation remains held for verification.

Fix guidance: flush after the inactivity transaction commits and provide bounded retries for undelivered guidance. Preserve generation checks and never clear a newer valid turn. Add a timer-level test with no subsequent API mutation, plus failed-clear/retry and newer-generation protection tests. Physical RS485 acknowledgement and display behavior still need hardware validation.

### 3. P1 — Offline instructions still restrict physical work to preallocated tasks

Sources: [offline banner](/Users/sankalprajpoot/Documents/Personal/inventory-management/public/client/work.js), line 69; [offline action handling](/Users/sankalprajpoot/Documents/Personal/inventory-management/public/client/work.js), lines 101–105.

Current interface says “Continue only known, preallocated work.” New planning actions require reconnection. The completed-movement recorder does save manual reports offline, but the instruction contradicts the agreed continuity-first requirement for new physical work on a usable device.

Expected: cached work is available, and new physical work can continue provisionally with a durable original movement reference and later supervisor reconciliation. No fresh authoritative reservation or exclusive turn should be implied while disconnected; paper is the fallback when there is no usable device.

Fix guidance: explicitly explain and expose the provisional manual path from offline Pick/Put, using the existing recorder where suitable. Remove the preallocated-only instruction. Verify in a browser that a user with no preallocated task can save the provisional report, reload offline, reconnect, and reconcile once without claiming an offline exclusive turn. This finding is based on source/interface behavior; a fresh browser replay was not performed in this review pass.

## Original findings now resolved

| Original finding | Current evidence |
| --- | --- |
| Product removal bypasses incoming put reservations | `removeProduct` now invokes a product-scoped outstanding-work guard. The original reproduction is rejected before deactivation. |
| Paper-first posting exhausts stock and strands the matching phone report | Stock 1 → 0, phone report recorded, held reservation 0, exactly one transaction. Origin lookup now precedes a new debit check. |
| Different late actual cannot be resolved | Recorded 1 then verified late actual 2 produces stock 48 from initial 50, with pending count 1 → 0. |
| Late review rewrites the historical conversion timestamp | Completion timestamp remains unchanged. After ×25 conversion, correcting original actual 1 → 2 produces 1,200 from 1,225 current units. |

Earlier superseded-snapshot concerns were also checked: wrong-product reports remain pending without debiting either product; a superseded allocation's original physical put can be verified without applying its replacement plan; the paper-first case with spare stock posts once. These are not presented as open defects.

## Validation and limits

- Full current suite: **111 passed, 0 failed**, run with server listening disabled and simulator hardware in the isolated copy.
- Evidence: `/private/tmp/inventory-review-approved-0uugiy6h/review-suite.log` and `review-probes.log`.
- Reproduction harness: `/private/tmp/inventory-review-approved-0uugiy6h/review-probes.mjs`. The original product-deactivation probe intentionally reaches the newly added rejection; its stack trace in the log is evidence that the guard now blocks the operation.
- No real device tests, camera/QR phone tests, RS485 reconnect/power-cycle tests, or shared-preview interactions were performed. Hardware-only checks remain separate from the demonstrated software timer defect.
- This was a targeted recheck of the completed review, not an assertion that every workflow or later commit has been independently approved.

The review is complete for this commit. The implementation owner can address the three open items; targeted verification is needed afterward.
