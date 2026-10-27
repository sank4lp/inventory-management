# Compact Review task card

Built on `22b0a25` on `public-product-development`. This is a UI-only refinement; no backend or hardware code changed.

The popup title and accessible name are always **Review task**. The visible “Check only — do not move stock” instruction and the Check evidence summary rows are removed from this popup. Underlying evidence and task detail/history attribution remain intact.

One uniform summary table replaces the two independent tables. Desktop/tablet rows use consistent 18% label / 32% value columns, repeated across the row. Phone rows stack each label/value pair with aligned columns. Task, Product name, Assigned to/by/time, Deadline, Quantity, Completed, Remaining, Progress and applicable return metadata remain visible. Dates use Asia/Kolkata and include IST. The short timezone caption has an explicit full-width block layout on phones; the initial narrow-caption rendering issue was corrected and the phone evidence recaptured.

The permission-gated **New operator** searchable selector and accessible **Save new operator** tick sit in the header at the right on desktop/tablet and wrap below the title on phones. Its compact helper paragraph is removed; the normal task detail helper remains. The exact heading **Align task with actual movement** follows the summary table.

Initial focus goes to the Review task heading (`tabindex="-1"` with autofocus and explicit focus after opening), not a text field. Browser checks confirmed heading focus after opening at desktop and phone sizes, and Tab reaches the visible New operator combobox. This avoids requesting text entry immediately on phones. Physical-device keyboard behavior was not tested.

Observation forms, inline Stop, verified remaining-work planning, permission checks, generation/progress locks and unsaved observation safeguards are preserved. Opening the popup or expanding Stop performs no management or physical movement command. Service-worker cache advances to v25.

## Validation

- Full suite: **302/302 passed** (`/private/tmp/review-card-full.log`).
- After the final heading-focus adjustment: **72/72 focused UI, client-reliability and searchable-selector tests passed** (`/private/tmp/review-card-final-focused.log`). The later CSS-only caption fix was verified in the browser.
- `git diff --check` passed.
- Regression coverage checks the fixed title, single summary table, consistent column classes, header assignment, exact movement heading, absent popup evidence/helper text, retained task-detail evidence and verified-followup action.
- GET-only synthetic fixture exercised production rendering at desktop, 820×1180 tablet and 390×844 phone sizes. Initial heading focus and the accessible popup name were checked. Keyboard search/Arrow Down/Enter chose Sam and enabled the tick without submitting. Inline Stop exposed its required confirmation checkbox and handback disclosure. No assignment, observation or Stop was submitted.

Evidence in `docs/evidence/review-task-card/`:

- `desktop.png`: header control, uniform summary and movement heading.
- `tablet.png`: complete popup with its actions.
- `phone.png`: wrapped header and aligned summary, corrected caption.
- `phone-actions.png`: readable observation fields and reachable actions.
- `phone-stop.png`: expanded inline confirmation.

The existing fixture rejects non-GET requests and prevents submissions. No authenticated warehouse state, real stock, hardware or Pi was touched. Browser tab closed and viewport reset. Reproduce with `node scripts/searchable-select-browser-fixture.mjs` and `/preview?mode=check` on port 3221 (existing fixture session 34661).

## Local delivery

Simulator preview refreshed at http://localhost:3213/work with `HARDWARE_ADAPTER=simulator`, using disposable data directory `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`. Process session: **80575**. Log: `/private/tmp/my-work-preview.log`. Read-only checks returned the expected Work 302 and client script 200.

Scoped local commit only; no push or merge. The coordinating chat retains publication responsibility.
