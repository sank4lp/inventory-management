# Task context, check entry and secondary dialogs

Built on `99d934f` on `public-product-development`. Opening a task now exposes the return/check context before the operator takes action. Stop, history and movement recovery use native dialogs. The main Needs Review case workflow and the product stock summary remain in place.

## Task behavior

The detail screen shows status, requested/completed/remaining quantities, current assignee, assignment author/time, return author/time/reason/note, and original performer/entry author. Pending evidence shows its entered quantity (or unknown quantity), original note, current review reason and entry time. Settled movements retain performer/reporter attribution. History retains assignment events, deadline and remaining-quantity changes.

Opening, refreshing or inspecting the task remains passive. Own executable work has the existing explicit Start/Resume control. Unassigned returned work says it must be assigned first. Administrators inspecting another person's task do not gain physical execution controls.

An assigned worker with pending evidence—including the original assignee before handover—gets **Start check**. This only opens the observation dialog. It does not start physical execution, create an active-work context, acquire a turn, or issue LED commands. The original-assignee service path now accepts an observation on their own task with existing evidence. Observations retain receipt replay and generation checks; new clients also supply the progress token. Saving an observation skips hardware guidance flushing. Verified handover exposes the existing Plan verified remaining work action only once pending evidence is resolved; unverified follow-up cannot bypass this through reassignment.

## Assignment and secondary actions

The task's Assigned to area has a searchable eligible-active-person selector and explicit Save, gated by assignment permission. Search and select have distinct accessible names. Save remains disabled for the current person, blank selection, stale progress/generation, offline state or a pending command. It routes to `reassign`, `updateReturned` or `assignReview` according to task state. Server validation rejects an unchanged assignee and requires the exact progress token for this editor. Returned updates retain the existing remaining quantity; quantity checks transfer responsibility without rewriting original performer or completed movements.

Two secondary bottom buttons open **Stop remaining work** and **Task details and history**. Stop consolidates handback and cancellation/stopping choices, preserving separate semantics: untouched cancellation requires a zero-movement confirmation; handback preserves work and requests reassignment; started/uncertain movement remains subject to review. Native modal behavior confines focus; Escape and Close restore it to the opener. Long phone dialogs scroll internally.

**Record what I moved** opens a dedicated recovery dialog with actual quantity/unit, location and reason. No duplicate inline recovery form remains. Existing allocation revision, product, direction, unit and assignment generation are frozen into the original form.

## Offline evidence and drafts

Recovery remains writable when the connection fails or the assignment changes. Late evidence keeps its original instructions, goes into the durable outbox, and follows the existing review process. This is intentionally different from management and observation forms, which lock on stale/offline state. Changing actor, warehouse or dataset prevents submission under the new identity while preserving the original draft.

Draft identities now include dataset and assignment generation, and forms retain the actor/site/dataset/path from when they were rendered. Dataset-less legacy draft keys are retained rather than automatically restored into a potentially different dataset. **Download saved updates and drafts** includes the current account's saved drafts, including those legacy entries, alongside its outbox; users can recover their text without silently attaching it to new instructions.

## Tables and access

My Work and Returned work have separate product and task links. Product names link to `/products/:id` only with `products.view`; task labels such as `#66 · Pick` link to passive details. Redundant View check actions are removed. My Work now has eight columns, with matching empty-state colspan and width. Live row patching preserves the marked action cell rather than a brittle column index, so adding Task cannot replace a focused action/draft.

## Verification and evidence

Final full suite: **288/288 passed**, zero failures; `git diff --check` passed. New coverage includes original-owner and transferred check entry, no physical state/hardware effects from observation, receipt replay, stale/wrong-owner checks, unchanged/inactive assignment rejection, completed performer preservation, service-to-render pending attribution and original notes, product permissions, focused action-cell preservation, dialog focus, frozen offline recovery, and cross-account/dataset submission prevention.

Screenshots in `docs/evidence/task-screen-refinement/` use a GET-only synthetic fixture rendering production client functions and CSS. All browser form submissions were prevented. No authenticated warehouse browser mutations, real hardware or Pi operations occurred.

- `check-phone.png`: explicit Start check and labeled assignment controls at 390×844.
- `check-dialog-phone.png`: observation-only modal with do-not-repeat instructions.
- `recovery-dialog-phone.png`: entered synthetic quantity/reason, original unit and location; no submission.
- `stop-dialog-phone.png`: separate handback and stop choices inside the scrollable modal.
- `returned-tablet.png`: unassigned returned task at 820×1180, no Start control, visible return context and bottom actions.
- `history-dialog-tablet.png`: performer, event, deadline and remaining history.
- `tables-desktop.png`, `tables-desktop-lower.png`: separate Product/Task links and horizontal table scrolling at the normal desktop viewport.

Escape was checked for Start check and Stop; Close was checked for recovery, with focus returned to each opener. The temporary browser tab was closed and the viewport override reset. Screenshot fixtures cover presentation; service/client tests cover authority, replay, stale state and durable evidence.

## Local delivery

Service-worker cache is v22. The isolated simulator was refreshed at http://localhost:3213/work using the existing disposable data directory `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`. Current process session: **21064**; log: `/private/tmp/my-work-preview.log`. Startup confirms the simulator adapter and healthy SQLite integrity; a read-only GET returned the expected unauthenticated 302. No real hardware adapter was enabled.

This task ends with a scoped local commit. Push/merge remains with the coordinating chat.
