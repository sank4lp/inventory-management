# My Work and Start check cleanup

Built on `c9acd7e` on `public-product-development`. The prior searchable selectors, task context/dialogs, explicit task activation and product stock summaries are preserved.

## My Work

The table now orders columns as Task, Product name, Quantity, Progress, Assigned by, **Assigned to**, Assigned time, Action and Deadline. Empty states span nine columns. Horizontal scrolling remains available at narrow sizes, and the table minimum width accounts for the extra column. The marked action cell survives live row patching and is no longer tied to a column number.

The Action column has its explicit Start/Resume or Start check control; **More is removed**. Decline is still reachable for an untouched offered assignment through task detail → Stop remaining work → Decline task. It is not confused with cancellation of self-created untouched work. Existing task detail handback and stop controls remain available.

## Start check

The popup has responsive tables for Task, Assigned to, Assigned by, Assigned time, Product name, Quantity, Completed, Remaining and Progress. Deadline, return reason/note/person/time and pending movement evidence are shown where available. Pending evidence retains its entered quantity, original performer, entry author, note/review reason and timestamp.

Every time in this popup is explicitly formatted with `Asia/Kolkata`, independently of the warehouse/browser default, and labeled IST. A short timezone caption makes that explicit. The safety instruction is **Check only — do not move stock**. Opening the popup or expanding Stop performs no command, movement, turn acquisition or LED activation.

The desktop/tablet summary has two compact tables side by side; phone layouts stack them. Details and actions use readable 14px type with at least 44px action targets. The popup is up to 820px wide, scrolls within the viewport, and avoids the legacy table styles that previously clipped or split header labels. Return/evidence context remains visible in the popup rather than being moved to a separate history screen.

## Stop and reassignment

**Stop remaining work** sits beside Save observation for verifier. It opens one inline panel per task, outside the observation forms. The panel shows completed/remaining progress once, a brief preservation note, a required stop confirmation and Confirm stop. Handback is a secondary disclosure with the necessary reason and optional note. There are no nested forms or repeated panel IDs when a task has multiple pending locations. No zero-movement cancellation claim is shown for quantity-check work.

Stop, handback and decline now validate a supplied progress token on the server in addition to the existing generation check. This is backward-compatible with older callers without that field. New forms supply it. A physical report or verification can change progress without changing assignment generation, so an old confirmation is rejected rather than acting on outdated displayed quantities. Receipt replay still returns the original result. Fresh stopping retains recorded movement and unresolved evidence; the existing service only releases eligible untouched instructions.

Users with assignment permission see one **New operator** searchable dropdown and an accessible tick button named **Save new operator**. It excludes the current assignee and inactive/ineligible people, uses the existing safe state-specific assignment route, and retains generation/progress guards. A plain Assigned to summary is visible without assignment permission.

Assignment controls share the same task lookup across current, returned and watched tasks. Blank/current selection, revoked permission, changed identity, stale generation/progress, a pending command, or loss of check ownership keeps Save locked. The general popup patch cannot re-enable an invalid assignment Save. A stale popup retains its original draft/version and asks the user to reopen the latest task.

A typed observation—including an entered zero—blocks reassignment/stop/handback with the short message: **Save your observation first, or clear it before changing this task.** Its fields remain intact and no management command is queued. Existing scoped durable draft/outbox handling continues to apply. This avoids closing a check popup over an unfinished observation.

## Verification

Full suite: **301/301 tests passed**, zero failures. `git diff --check` passes. Added regressions cover:

- Labeled summary, IST despite a UTC warehouse setting, permission-gated new operator/tick control and a single independent stop panel.
- Watched-task lookup; blank/same-assignee, permission-revocation and reassignment locks without changing the draft generation.
- Actual submit-handler rejection of stop/reassignment while observation text exists, with no outbox write and retained text/quantity.
- Stale stop/handback progress rejection, idempotent fresh replay, retained settled performer/quantity, unchanged movement ledger and unresolved evidence.
- Updated table expectations and preservation of the marked action cell after its column moved.

GET-only synthetic browser checks exercised production render functions, the shared combobox and the inline Stop toggle. Choosing Sam with Arrow Down + Enter enabled the accessible tick; no assignment was submitted. Stop expanded/collapsed with focus and `aria-expanded` updated, exposing the current-progress confirmation without a command. Escape closed the popup and returned focus to Start check. The fixture prevents submissions and rejects non-GET requests. No real warehouse inventory, login, hardware or Pi operation occurred.

Evidence in `docs/evidence/check-popup-cleanup/`:

- `check-desktop.png`: corrected desktop summary, labels and IST context.
- `check-phone-summary.png`: stacked labeled summary at 390×844.
- `check-phone-actions.png`: single operator selector/tick and paired observation/stop actions.
- `check-phone-stop.png`: compact expanded confirmation and secondary handback path.
- `check-tablet-actions.png`: complete popup at 820×1180.
- `my-work-desktop.png`, `my-work-actions.png`: requested column order and action column without More.

The fixture remains reproducible with `node scripts/searchable-select-browser-fixture.mjs`, using `/preview?mode=check` and `/preview?mode=table` on port 3221. Temporary browser tab closed; viewport reset.

## Local delivery

Service-worker cache is v24. Simulator preview refreshed at http://localhost:3213/work using the existing disposable data directory `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`, with `HARDWARE_ADAPTER=simulator`. Process session: **37339**; log: `/private/tmp/my-work-preview.log`. Read-only checks returned the expected unauthenticated 302 for Work and 200 for the client script. GET-only fixture session: **34661**.

Scoped local commit only; no push or merge. The coordinating chat retains publication responsibility.
