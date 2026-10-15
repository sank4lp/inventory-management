# Task returns, quantity-check assignment and location details

Implemented on top of `e648cbd`, for local review before publication.

## User-facing behavior

- Task page H1/browser title is `Task #65 - Pick 9mm Ammo Case` (Put uses Put). Active location heading is `Go to Z1-R1-C01`, followed by useful captured directions without the duplicate location code. SKU, product and planned quantity/unit remain.
- Manage Locations Add Location accepts optional Shed / shelf details. Existing rows have a separate Save details form using the same travel-instructions/description-revision contract; configurable attributes, stable cell/label identity and issued instruction snapshots remain intact. The commissioning and location-detail forms use the same label/model. New instructions capture updated descriptions.
- An owned open task, including self-created or needs-review work, has a visible Stop and hand back remaining work button. The dialog asks for a reason and optional note. Offered tasks still show Decline. Untouched plans release safely; actuals and uncertain physical work remain. Existing manual movement reporting remains available.
- My Work retains own task table, FIFO next task and fixed Pick/Put footer. Admin/delegated staff additionally see a paginated returned-work/quantity-check table. The query is independent of the own-task page and includes plain Needs Review tasks, even if not returned. Explicitly closed safe returns leave the action queue but remain in history; uncertain cases stay visible.
- Acknowledge targets a specific return event and records who saw it. It does not alter stock, reservation, generation, assignment or case resolution, and does not remove returned work.
- Update task opens in place: completed cells/performers, remaining default, editable positive remaining quantity, eligible operator search and preserved due date. Changing due is explicit and separately permission-checked. Requested total becomes retained completed quantity plus chosen remaining. Physically uncertain tasks instead offer Assign quantity check; quantity editing/replanning waits for verification.
- Needs Review also exposes Assign / update task. Older cases outside the current 100 task rows load via an authorized, bounded task lookup which rejects account/site mismatch.
- After review assignment, the recipient sees Check what moved and an observation form. Cells say Check / Originally planned; arrival, Start, cancellation/replanning and direct non-verifier corrections are blocked by the service. Observations identify the checker, not a presumed performer. The table retains returner identity and shows the current check assignee.
- A verifier must confirm the original worker stopped when resolving a transferred check. Once all checks are resolved, the assigned operator can Plan verified remaining work, then Start the new offered plan. Resuming preserves the admin's assigned-by and assigned-time provenance. Original-device late movement evidence still reaches review under its original reporter/performer.
- Device-local saved/failed updates remain separate in a compact Saved updates table with the existing retry/recovery actions.

## Command and data contract

All commands retain the existing transactional receipt/fingerprint, actor/site/dataset and permission checks.

- `handBack`: `taskId`, `generation`, `reason`, optional `note`; broadens the existing decline machinery to self-created work.
- `acknowledgeReturn`: `taskId`, `generation`, `returnEventId`; `work.assign` and existing task read scope. The additive `work_return_acknowledgements` table has one row per return event; only the first acknowledgement adds an assignment audit event.
- `updateReturned`: `taskId`, `generation`, `returnEventId`, `progressToken`, `remainingQuantity`, `assigneeId`, optional `reason`; optional `changeDue: true` + `dueAt` requires `work.deadline`. Uses normal planning/reservations/history and blocks active/uncertain lines.
- `assignReview`: `taskId`, `generation`, `progressToken`, `assigneeId`, optional `reason`; `work.assign` and existing task read scope. Requires pending review evidence. It transfers follow-up ownership, preserves due, line revisions, issued instructions, reports, settlements, turns and reservations, and disables physical execution/guidance for the task.
- `observeReview`: `taskId`, `generation`, `lineId`, optional observed `quantity` (blank means unknown), required `note`; assigned active executor only. Adds a `review_observation` event, no stock report/performer inference. Task and pending-case views expose it to the verifier.
- Existing `resolve` requires `workerStopped: true` for a review-follow-up task (except keep-pending). Existing verifier permissions and accounting checks still apply.
- `resumeFollowup`: `taskId`, `generation`, `progressToken`; current assigned executor only, after verified handover and all physical uncertainty is resolved. Reuses ordinary reassign planning and emits `verified_work_resumed` without replacing admin assignment provenance.
- Additive task columns: `review_followup` and `review_handover_verified`, default 0.
- `progress_token` hashes assignment, requested quantity, deadline, stop/closure state, follow-up state, line revisions/states/actuals and review case state/revision. Quantity corrections without an assignment-generation bump invalidate open admin dialogs. Acknowledgement/observation alone does not invalidate a physical plan.
- `returnedTasks`/`returnedPage` use `returnedPage` query pagination, 100 rows per page. Global access requires `work.team`; assignment-only delegates see their existing created/previously-assigned task scope. Ordinary operators receive no other-user queue records. `reportId` filters Needs Review to an exact case across pagination.
- Modal live updates keep focused drafts/version fields intact and disable stale submissions. The server independently rejects stale requests. Outbox physical-evidence guards apply to return/update/transfer/resume.

## Verification

Final full suite: **243/243 tests pass**, including all pre-arrival guidance tests. `git diff --check` passes.

New service coverage includes both Pick/Put partial completion and return; editable remainder retaining actuals, performer and deadline; acknowledgement no-effects/idempotency/later-event separation; receipt replay; stale correction token; uncertain and self return; all-page visibility and delegated privacy; both-direction review transfer, old-device evidence, observer/performer separation, explicit stopped-worker verification and safe remainder resumption; non-verifier correction blocking; location create/edit snapshot and attribute preservation; explicit closure versus pending uncertainty. UI coverage exercises dialog defaults, useful location subtitle, self/review hand-back, observation-only rendering, stale modal retention, and older-task/account-mismatch lookup.

GET-only synthetic browser fixtures used the actual production renderer, CSS and mobile navigation at 390×844 and 820×1180. Screenshots in `docs/evidence/returned-work/`: task title, full location card, valid enabled return dialog, update top and Save/Close bottom, compact My Work table, review-assignment dialog. No browser warehouse command, real hardware, Pi, network configuration or login flow was performed. Service behavior was exercised only in disposable test databases. Prior real-browser approval boundaries remain unchanged.

## Preview / handoff

- Existing isolated simulator restarted with final code: http://localhost:3213/work ; process session 94956; log `/private/tmp/my-work-preview.log`; data cwd `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`.
- GET-only synthetic screenshot preview: http://127.0.0.1:3217/preview ; session 42002; script `/private/tmp/returned-fixture.mjs`. Query examples `?page=task`, `?page=task&mode=return`, `?mode=update`, `?mode=review`. No mutation routes.
- Temporary screenshot tab closed and viewport reset. Existing preview tabs were preserved.
- Service worker cache advanced to v18 for updated UI.
- No push/publication from this task. Cross-chat message attempt was rejected by automatic approval review; no retry/workaround was used. Coordination can read this handoff and final result directly.
