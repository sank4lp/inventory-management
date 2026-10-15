# Single searchable dropdowns

Built on `bb29b4d` on `public-product-development`. The separate Find/Search field plus selection dropdown is now one searchable selection field throughout the work flows. Typing filters choices; choosing is explicit. Search alone never assigns work, changes stock or submits a form.

## Audit and coverage

The shared enhancement applies to:

- Task detail Assigned to; Update Task, returned/quantity-check assignment, and historical reassignment forms through `operatorPicker`.
- Product selection on self Pick, self Put, Assign Work and manual movement recording. Assign Work also uses it for Assigned to.
- Needs Review Assigned to and Performed by filters, retaining Everyone and Unknown / unassigned choices and inactive historical performers.
- Compare this count, using full authorized server count lookup by date/person/name.
- Matching saved entry, using full authorized movement history lookup by reference/person/date.

The audit also inspected `src/server/pages/shared.js`, server product/location/task pages, `public/app.js`, location setup and stocktaking. Existing server-rendered Product/Cell/Role pickers already have one integrated input via `comboBoxField` / `wireComboBoxes`; they retain their current behavior and receive no second handler. Product/location catalog searches, report-library searches and table filters query result lists rather than selecting one value. Stocktaking's location-scope and movement-evidence searches filter multiple checkboxes; those remain separate. Plain enum selects, count counters, location controller/attribute selectors and other single selects without a duplicate search input remain native. No paired search/select markers remain in `work.js`.

## Reusable control and form semantics

`public/client/searchable-select.js` progressively enhances `select[data-searchable]`. The original select keeps its name, ID, options, selected value, required and disabled properties. One visible input is exposed as a combobox, with a named listbox, expanded state, active option, option selection state, live result status and visible focus. The native select remains canonical for existing form serialization and business logic.

Typing immediately clears the old canonical ID. Matching text alone is not a selection, including in optional fields. Enter only chooses an explicitly highlighted option; Arrow Up/Down navigate, Tab closes without choosing, and Escape closes the list before a second Escape can close its enclosing dialog. Pointer selection closes the list without a wrapping label reopening it. Deleting the text clears an optional selection. Required unmatched text blocks native form submission. Disabled/hidden options cannot be selected, and options becoming unavailable invalidate the previous choice.

Dynamic dialogs and newly rendered forms are enhanced automatically. Select option/required/disabled mutations synchronize without replacing a focused query. Removed controls disconnect their observer and cancel work. Draft restoration initializes controls before restoring their text, then reconciles selected IDs and query text. Remote selected labels are retained in the existing scoped draft so a selection outside the snapshot's initial options can be restored. Count drafts also retain the selected comparison evidence, so restored explanatory quantities describe that selected count rather than the snapshot's default candidate. Existing site/account/dataset/generation/progress draft partitioning is unchanged. No schema or dependency installation was required.

The dropdown scrolls internally and opens upward when there is more usable room above it, taking an enclosing dialog and the visual viewport into account. It uses the local styles and no external CDN. The ordinary page shell and offline work shell load the module; service-worker cache v23 includes it.

## Server-backed search and freshness

Remote dropdowns search after a 250 ms debounce and show loading, empty, error and result-count states in the same panel. They retain the full existing server lookup and response bounds. Movement results at the 100-row limit tell the reviewer to refine the search. They never auto-select the first result. Reopening preserves a trusted current choice when it is outside the first result page; typing a new query clears that choice immediately.

Both lookup responses now include actor, warehouse and dataset identity. The client validates these against its snapshot and also guards capability identity, report ID/revision, abort status and whether the form still exists. This rejects another signed-in account's response even if the old page has not refreshed. A 15-second timeout bounds reads. New queries, closing and removed controls cancel previous work; generation checks prevent late responses from painting over current results. Requests are GET/no-store and never enter the command outbox. Existing service authorization and final review/assignment authority remain unchanged.

Selecting a product dispatches the same canonical input/change events used by the existing stock summary and unit hints. Clearing it hides the old product's summary. Existing assignment Save guards, permissions and all physical-work activation safeguards remain in place.

## Verification

Final full Node suite: **295/295 passed**, zero failures. This includes seven new tests for matching/validation, scoped full-history lookup, cross-account/site/dataset/capability/report/detached-form rejection, count candidate retention/restored comparison evidence, audit/offline integration and actual route identity/no-store behavior. Existing stock, receipt, task, offline and assignment tests pass. `git diff --check` passes.

Real browser DOM fixture: **25 checks passed**, including canonical FormData values, explicit keyboard selection, no selection from Enter/Tab alone, native invalid-form blocking, pointer selection, disabled and changed options, optional clear, dynamically inserted forms, selected/unselected draft restoration, remote current choice outside the first page, reversed response order, remote empty/error states and detached responses. Escape ordering was additionally checked in the production Update Task dialog. This is actual `enhanceSelect` interaction, not only helper tests.

Reproduce with `node scripts/searchable-select-browser-fixture.mjs`, then open `http://127.0.0.1:3221/test`. Visual routes are `/preview?mode=update`, `product`, `assignment`, and `returned`. The server accepts only GET and prevents all form submissions; production render functions/CSS and synthetic data are used. It does not log in, issue warehouse POSTs or operate real hardware.

Evidence in `docs/evidence/searchable-dropdowns/`:

- `browser-checks.png`: all 25 browser assertions.
- `update-task-phone.png`: one Assign to field filtering Sam inside the 390×844 modal.
- `product-phone.png`: one product field filtering by product name/code.
- `assignment-tablet.png`: the shared selector at 820×1180.
- `assignment-desktop.png`: upward-opening choices at the normal desktop viewport.

Temporary browser tabs were closed and viewport overrides reset. Screenshots are fixture evidence; backend state/authorization behavior is covered by the automated suite. No real hardware or Pi operation occurred.

## Local delivery

The isolated simulator was refreshed at http://localhost:3213/work using the existing disposable data directory `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX`. Process session: **54351**; log: `/private/tmp/my-work-preview.log`. Read-only verification returned the expected 302 for the unauthenticated work page and 200 for the new dropdown module. The GET-only fixture is on port 3221 (session **2785**).

Delivery is a scoped local commit only. The coordinating chat retains push/merge responsibility.
