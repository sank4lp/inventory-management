# Compact My Work and review actions

Implemented on `public-product-development`, 30 September 2026. No remote push in this change.

## Delivered behavior

- My Work has a compact filter toolbar. **Filters** is a column dropdown (Task, Product, Status, Progress and State). Selected columns appear as compact inline inputs and wrap as needed; their × removal buttons appear on hover/focus and remain visible on phones. Requested, Completed, Remaining and Progress have no Min/Max filter controls. Retired numeric filters in old links are ignored by My Work refresh and removed on Apply/sorting; **Apply** remains disabled until those values differ from the applied query. **See only review items** updates immediately without applying any other draft filter. Existing sorting, pagination and query filters remain available; Unit supports ascending/descending sorting.
- Task rows are compact, with separate **Unit** and **Action** columns. Small screens scroll the table horizontally; the toolbar wraps only when its controls cannot fit. Touch buttons retain usable targets.
- Review keeps both green options visible while editing movement or assignment. Drafts survive switching options and popup Back. Red **Discard** stays at the bottom. Discard asks for confirmation that work has stopped and current recorded totals are final, then uses the existing version-checked task closure operation. It does not erase movement history.
- Authorized admins/delegated verifiers can use **Select**, individual checkboxes or current-page select-all, then **Discard All**. The confirmation table shows product and recorded quantity, task, assignee, and Remove / Update Task / Review actions. Rows with recorded movement are highlighted. Nested assignment and review return to the batch; successful closure removes only the completed item.
- Bulk closure submits an independently durable, idempotent request for every confirmed task, using its assignment/progress/closure versions. Changed tasks remain for review. A lost receipt stays in the existing outbox and stops further batch submission until connectivity is restored. Permissions, account/dataset identity and unresolved local movements are checked before sending.
- Popup Back and browser Back navigate the same stack. Switching editing choices replaces that editing step rather than creating a long Back chain. Draft persistence failures keep the popup open. Forward to a task closed since it was opened shows read-only history. History itself cannot execute a mutation.

## Validation

- Full suite: **378 passed, 0 failed** (`node --test`). Includes all prior accounting, assignment, permissions, task-closure, stocktake and display-ownership coverage.
- Eleven new focused tests cover unapplied filter drafts, immediate review filtering, filter failure, capability-scoped selection, persistent review choices, current-state discard, moved-row highlighting, stale batch versions, partial batch results, lost receipt replay, identity checks, and Back/Forward navigation.
- Real browser testing used a disposable simulator on port 3213, separate from the user's preview data. Checked both filter behaviors, switching movement/assignment while retaining an entered quantity, nested assignment save, partial movement closure, bulk discard, single discard and browser Back. No console errors observed.
- Database verification of those browser actions: closed tasks 1 and 2 retain zero recorded movement and zero held reservations; task 3 retains its 0.5 recorded movement and has zero held reservations. No real inventory or hardware was used.
- Checked narrow phone (approximately 320 CSS pixels), tablet (768 CSS pixels), and desktop layouts. Phone/tablet dialogs fit their viewport without internal horizontal overflow; task tables retain horizontal scrolling. Temporary viewport overrides were reset.
- `git diff --check` passed. Screenshots: `docs/evidence/compact-work-review/review-phone.png` and `inline-filters.png`. The inline toolbar measured 35px against a 46px task row on desktop; it wraps on narrow screens. Add/remove, pending Apply, immediate review-only filtering, and preset progress filtering were verified in the browser.

## Preview and boundaries

The existing simulator at `http://localhost:3210/work` was restarted with its existing isolated demo database preserved. The separate `http://localhost:3213/work` demo preview is also running for review of the filter update. The changes are ready for review there. Real Raspberry Pi, camera, UART/LED and warehouse Wi-Fi verification are outside this UI change and were not performed.

## Review action layout

The two green review choices share one row with equal-width columns and centered labels. Discard spans the full row below them. Single-task discard confirmation and both Discard All placements also use full-width, centered buttons. Long labels wrap without clipping, and the two green choices share the same row height.

Verified narrow phone (approximately 325 CSS pixels) and desktop (1492 CSS pixels) layouts: green choices remain side by side with equal widths; Discard fills the available row. Verified the bulk confirmation button fills its content width and has centered text without submitting any task changes. Viewport overrides were reset. This was a CSS-only adjustment; browser layout checks and `git diff --check` passed. Screenshot: `docs/evidence/compact-work-review/review-action-rows.png`.

## Final filter choices

The filter picker now contains only Task, Product, Status, Progress and State. Unit remains a table column, but no longer has a filter. Progress is a select with Any, 0–25%, 25–50%, 50–75%, and 75–100%. No numeric Min/Max inputs are exposed. Bands use the displayed percentage: lower bounds inclusive, upper bounds exclusive except 100%, so 25% appears only in 25–50%, 50% in 50–75%, and 75%/100% in 75–100%. Progress above 100% remains visible with no progress filter.

Compact chips have separate labels and inputs, consistent heights, and wrap without page overflow. Filter changes still require Apply; review-only remains immediate. Old unit and numeric-range URL filters are removed from My Work requests and new sorting/apply links.

Latest validation: 70 focused query/client/UI tests passed, including a new range-boundary and operator-scope regression check. Browser verification confirmed 0% tasks under 0–25%, a 25% completed task under 25–50% with All states, pending edits until Apply, no console errors, and clean 325px/wide layouts. The toolbar stays about 35px high when the chips fit on one line. Both preview services were refreshed with their demo data preserved. Screenshot: `docs/evidence/compact-work-review/progress-filters.png`.

## Filter toolbar alignment

Filters, Apply and Select now share equal 76 × 30 CSS-pixel dimensions (38px tall for coarse pointers), in that order. The review-only checkbox and label align to the right of the same row. At widths too narrow to fit both groups, the review-only control wraps and stays right-aligned. Selected filter inputs appear in a separate compact row below, so they cannot interrupt the three primary controls. Adding and removing filters retains their activation and Apply behavior.

Validation: 93 existing client/UI/review tests passed; JavaScript syntax and `git diff --check` passed. Browser verification covered add/remove, draft Apply, equal control dimensions and right alignment on desktop, and no toolbar overflow at 325 CSS pixels. The existing preview at port 3210 displays the update. Screenshot: `docs/evidence/compact-work-review/filter-control-row.png`.

## Dropdown values and items per page

Column filters now use native dropdowns populated from the tasks displayed on the current page, not from the full product catalogue. Task choices show number and Pick/Put; duplicate product/status/state values are listed once. Current tasks / All states remain available, and Progress retains the four agreed percentage bands. An applied or draft choice remains selected when live changes remove its last visible row. To select values from another page, navigate there first or increase the page size.

Selections use exact matching, so selecting a task or product cannot also include similarly named values. Existing text-search URLs remain supported. Column choices still wait for Apply; review-only still applies immediately.

Items per page offers 20, 50 (default), and 100. A change applies immediately, resets to page one, and preserves unapplied column-filter drafts. The server validates the sizes, filters/sorts before pagination and clamps out-of-range pages. Page links retain the size and display the correct row limit. An unsuccessful size change restores the prior selection.

Validation: 383 tests passed, including new exact-match, permission-scope, page-boundary/default/invalid-size and draft-preservation coverage. The existing 100-row checks now explicitly select 100. Browser checks covered actual dropdown values, exact task/product filtering, 20/50/100 selections, draft Apply, filter removal, and phone/desktop overflow. Both simulator previews keep their existing demo databases. Screenshot: `docs/evidence/compact-work-review/dropdown-filters.png`.

## Simplified movement review

Removed the always-present Stocktake overlap disclosure from My Work → Review → Align With Actual Physical Movement. The quantity/location table, stopped-worker confirmation, save, review routing and Discard remain. Server accounting checks are unchanged; exceptional count reconciliation is still accessible through the existing original-evidence link. Verified the rendered popup and passed 93 existing UI/review/task-closure tests, including stocktake double-post prevention. Screenshot: `docs/evidence/compact-work-review/review-without-overlap.png`.

## Final physical review saves (2026-10-01)

- Review → Align With Actual Physical Movement has one final Save Movement and Close Task action; Send for review is removed from this editor.
- The client waits for an explicit `recorded` + `closed` receipt. Rejected quantities remain editable in the open dialog, with an actionable error. Validation failures do not become device-help queue warnings.
- A lost response retains a frozen, account/site/dataset-scoped request and exposes Retry save in the popup (and the page after closing/reloading). It is never background-submitted as a new review. Retrying reuses the original idempotency key and payload. No new movement is allowed for that task while the result is uncertain.
- Final closure validates stock and physical capacity atomically before any ledger writes, including supervisor saves. Actual movement may override competing reservations, while preserving those other tasks' claims and flagging their discrepancy. Impossible stock/capacity changes keep the task and its reservations open. Existing unit conversion, stale-instruction, stock-count double-accounting and permission checks remain enforced.
- Successful closure reconciles the task's pending evidence, updates actual totals, releases its reservations and light turns, and removes it from current work. History is retained. A receipt remains authoritative if only the subsequent page refresh fails.
- Validation: full suite 392/392 passing; focused client checks rerun after the final inline success-message change. Browser test on isolated simulator port 3213 rejected 99,999 rolls against 11.5 recorded stock without closing the dialog. Correcting to 11 succeeded despite another task's 1-roll hold: stock became 0.5, the closed task's hold was released, the other hold remained, no pending review was created, and the closed task disappeared from current work. A second test rejected 1 against 0.5, then accepted 0.25 with immediate “Movement saved. Task closed.” confirmation. Database rows and ledger deltas were inspected. No production stock or hardware was used.
- Evidence: `docs/evidence/compact-work-review/physical-review-error.png`, `docs/evidence/compact-work-review/physical-review-saved.png`.
