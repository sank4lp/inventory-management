# Explicit Start and Resume

This supersedes the automatic opening/tab-return/reconnect behavior in `4af4e6e` and `docs/resume-guidance-handoff.md`. The pre-arrival guidance, returned-work, reassignment, review and location-details behavior remains in place.

## Operator behavior

- Opening a task through Details, its product link, history, a URL, reload or restored browser history is passive inspection. It shows **Task details**, **Location**, and **Resume task** (or **Start task** for an offered assignment). Healthy recovery forms are collapsed; evidence and observation remain accessible.
- Explicit Start/Resume submits one saved request, then loads the confirmed task and enters **Active work** in the same document. Self-created work follows the same direct entry path. No second Resume is required.
- My Work and next-task Start/Resume controls are forms; their product/detail links stay passive. Active work shows **Go to**, **Refresh light**, and the separate arrival/scan/Finish sequence. An unavailable or busy location uses Location instead of Go to.
- The active context is held only in memory for the confirmed task, assignment generation, actor/warehouse and dataset. No URL or storage marker activates work. Reload/back-forward restoration loses that context. Tab return and reconnect refresh facts without requesting lights. Selecting another location inside active work keeps the active context without another light request.
- There is no global paused state and inspection does not clear another worker's display. Previously lit LEDs may remain visible; inspection requests no new lighting.

## Resume contract and safeguards

`POST /api/work/resume` uses existing authentication, command receipts and transactions. It requires the current assignee with execution permission, started/open/non-review-follow-up work, current assignment generation and progress token, plus the exact eligible line/revision/binding set. The instructions array may be serialized JSON by the form.

Resume refreshes every eligible ready/working location using the existing display election and immutable cell/guidance-generation/line claims. Pending physical evidence excludes its location. A healthy sibling remains eligible. Another worker's display or exclusive turn is never taken; shared cells retain LOC guidance. Closed tasks, stale ownership/instructions/mapping, controller maintenance and review-follow-up tasks cannot activate execution. Start returns its resulting generation; self-create returns its initial generation so the client can validate the subsequent task read.

Resume does not acquire a turn, mark arrival, verify a scan, report movement, alter stock/reservations, create instruction snapshots or change physical task/line records. Arrival and Finish remain separate actions. GETs, snapshot reads and normal polling do not request light delivery. Resume/Refresh light delivery is scoped to the returned claims; no global restore was added. Receipt replay for Start/self-create/Resume/Refresh light returns the saved result without another hardware flush. Existing maintenance may retry an already-authorized hardware delivery that failed; this is distinct from replaying a deferred client activation intent.

## Lost responses and offline behavior

Start/Resume/self-create is online-only. Its durable request records the original request ID and actor/site/dataset/device fields before delivery. It is sent once per explicit click. A transport/5xx ambiguity remains `activation-unknown` and blocks another current-dataset activation until the saved request is explicitly retried. The retry sends exactly the same frozen input and receives the same receipt if the original committed. Background sync never delivers these states; legacy queued Start/self-create entries are converted to explicit-retry status. Existing physical-evidence sync is unchanged.

A definite validation/permission rejection becomes `not-applied`, allowing a corrected new request. A saved activation from another dataset/account/warehouse is never rewritten or sent under the new identity. Old-dataset evidence stays visible and exportable but does not block current-dataset activation. Clearing local data refuses to erase pending/unknown activation receipts. The account-scoped saved-work notice on other pages includes both new states and remains read-only.

If the POST succeeds but the following GET fails or finds changed ownership/generation/dataset, the confirmed result is retained and the client stays out of active work. The operator opens current details and explicitly resumes as appropriate. Old receipts from before this release may lack a generation and therefore cannot activate a new document by inference.

## Validation and evidence

`npm test`: **266/266 passed**, zero failures. Focused client tests cover direct entry, passive document defaults, exact lost-response retry, definite rejection, frozen identity, dataset rollover, offline refusal, legacy queue migration, passive polling/reconnect and retention of unknown receipts. UI tests cover passive vs active controls, stale live controls and dataset-safe task reads. Backend tests cover all four self/assigned Pick/Put combinations, exact eligible sets, stale requests, wrong actor, uncertainty/healthy siblings, review follow-up, closed work and display ownership. The previous stock, review, return, assignment and coordinator regression suite remains green.

`docs/evidence/explicit-task-activation/captured-rs485.json` captures the real RS485 adapter through its injected write transport against disposable databases. All four combinations show both initial and explicit Resume commands for cell 1 quantity 3 and cell 2 quantity 2 (green Pick, red Put), empty inspection/replay command lists, zero ledger entries and zero exclusive turns. Physical-state assertions additionally compare tasks, lines, ledger, reservations, turns and reports.

`passive-phone.jpg` and `active-phone.jpg` show production renderer/CSS at 390×844 through an isolated GET-only synthetic fixture. Its active example explicitly supplies synthetic in-memory context; that preview parameter is not part of the application. No browser sign-in, warehouse mutation, real hardware or Pi operation was performed. Temporary tabs were closed and viewport reset.

Firmware finding remains unchanged: in `digit 1 "3" green 120 20`, `120` is parsed as speed, **not a light TTL**. The digit branch uses the task display path, which resets test/locate expiration fields. No firmware changes were made. Captured transport output does not prove physical illumination or deployed wiring/firmware health; an authorized on-device check remains deferred.

## Local delivery

The existing isolated simulator is refreshed at http://localhost:3213/work (process session 27251). Its data remains under `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`; log `/private/tmp/my-work-preview.log`. GET-only synthetic fixture: port 3218, session 76168. Service worker cache is v20. Local commit only; no push or merge by this task.
