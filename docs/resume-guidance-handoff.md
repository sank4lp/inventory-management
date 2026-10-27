# Start and resume location lights

Implemented on top of `f4d49d5` and the original pre-arrival fix `e648cbd`.

## Behavior

Initial self-created Pick/Put work and acceptance of assigned work already lit all eligible planned cells before arrival. The missing path was reopening/Continue for an already-started task: those pages only read the current snapshot, so an already-delivered guidance row was never sent again.

The task client now requests a fresh light for the **displayed active location** after loading current warehouse state. This covers initial task navigation, reopening/Continue, `?line=` location navigation, returning to a visible tab, browser back/forward cache restoration, and a successful reconnect after offline state. A small Refresh light button offers an explicit retry. A hidden/offline screen does not send the request. Ordinary background polling consumes no new light intent and does not repeatedly send already-delivered guidance.

Only the current assigned operator with execution permission can request it. Offered tasks remain dark until Start. Completed/stopped work, closed or uncertain allocations, and observation-only review assignments are rejected. A healthy sibling can still receive its own guidance. View-only/admin inspection of somebody else's task cannot relight it. Old rendered instruction revisions, assignment generations and physical binding revisions block the client request and are independently checked on the server.

The current display election remains authoritative: a request can resend only its own elected display, never take another task's display or active physical turn. Shared cells keep their existing LOC behavior. A busy or unavailable light leaves the operator following the screen. The request does not manufacture arrival, scan verification, movement, zero quantity, stock posting, reservation changes, new instruction snapshots or task activity timestamps.

Go-to wording now reflects eligibility. Offered/view-only and busy-light rows use Location; uncertain/review rows use Check. A live change updates heading/hint and disables stale arrival/light controls without replacing the focused recovery form or its draft.

## Contract and delivery

Authenticated POST `/api/work/guide` uses the existing command route and receipt machinery. Input:

- `requestId`, actor/site/dataset/device identity as for existing commands;
- `taskId`, `generation`, `lineId`, `revision`, `bindingRevision`.

The action validates task ownership, work.execute, started/open/non-review-follow-up state, allocation ownership/revision/binding, absence of pending physical evidence, and controller-maintenance state. It reconciles display election, marks only the selected owned row for resend, and returns the selected cell and immutable display claim (`cellId`, guidance generation, line ID). Delivery is limited to that claim; another cell's pending delivery is not replayed by this request. Receipt replay returns the prior result without another hardware flush. Failed delivery remains unconfirmed and can be retried by existing maintenance or a new explicit light request.

The line snapshot now exposes current `binding_revision`. The rendered card retains the binding revision of its issued instruction snapshot, plus its displayed assignment generation and line revision, so a live refresh cannot silently use a newly changed physical mapping while the old instructions remain on screen.

No GET route, task/snapshot read, or ordinary poll is a hardware write. No global restore was added. Service worker cache is v19.

## Firmware finding

`firmware/esp32-simple-matrix/esp32-simple-matrix.ino`, command parser around lines 1153–1175: the fifth token in `digit 1 "3" green 120 20` is parsed as scroll speed. The digit branch calls `showTaskModule` without that speed argument; it is **not a 120-second TTL**. `showTaskModule` clears test/locate expiration fields and uses static/scroll task display modes. No firmware timing behavior was changed.

## Validation

Full suite: **255/255 tests pass**. Whitespace diff check passes.

Captured actual RS485 adapter output is in `docs/evidence/resume-guidance/captured-rs485.json`, generated against disposable SQLite databases with the real adapter's injected write transport (no hardware connection). All four self/assigned Pick/Put cases show:

- initial commands for both planned cells before arrival;
- resume command for only selected cell 1 (`digit 1 "3" green 120 20` for Pick; red for Put);
- zero ledger postings and zero cell turns before and after.

Tests also cover the second selected location, already-working exclusive turn preservation, no replay on receipt/GET/polls, no unrelated pending delivery, wrong user/admin inspection, stale assignment/line/binding, stopped work, physical contention, uncertainty with healthy sibling, review-follow-up hold, shared LOC bursts, failed send remaining unconfirmed, offline/hidden deferral, successful reconnect, displayed-instruction mismatch, and live heading changes without draft replacement. Existing return/reassignment and pre-arrival tests remain green. Shared LOC tests preserve the adapter's existing repeated-write redundancy; it is not confused with repeated polling.

GET-only synthetic browser fixtures used actual production renderer/CSS/mobile navigation. `task-phone.jpg` shows Go to, quantity, guidance hint, separate Refresh light and arrival controls at 390×844. The live handover fixture's accessibility state changed Go to A-01 to Location A-01 with a waiting hint; `recovery-draft-phone.jpg` shows the retained open recovery field. No browser sign-in, warehouse mutation or real Pi/hardware operation was attempted. Viewport was reset and the temporary tab closed.

## Preview and deferred hardware checks

The existing isolated simulator remains on http://localhost:3213/work and was restarted with this change (process session 86457). Data remains under `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`; log `/private/tmp/my-work-preview.log`. Read-only rendering fixtures remain on ports 3216 and 3217. No push or merge from this task.

On the actual Pi, an authorized operator still needs to visually confirm digits/colors for fresh Pick/Put and Continue/reopen, selected alternate cell, reconnect after controller/network interruption, shared cells, and another operator holding the physical turn. Captured transport commands prove the software requests; they do not prove physical LED illumination or deployed firmware/wiring health.
