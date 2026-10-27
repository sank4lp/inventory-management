# My work redesign — verification handoff

Scope: Work → My work only, based on `3d4bac2` on `public-product-development`. Team work, Needs review, History, task execution, Finish semantics, stock accounting and command handlers are unchanged. This change is for local review; do not treat it as pushed or deployed.

## Result

- “What’s your next move?” shows the oldest actionable own task by immutable original creation time (`tasks.started_at`), even when it is outside the current 100-row page. Assignment time does not reset this priority. Review/received reports, closed work and other owners cannot become the next task.
- The catalogue-style table uses seven columns: Product name, Quantity, Progress, Assigned by, Assigned time, Action, Deadline. Newest assignments sort first, with task ID descending as the deterministic tie-break. Reassignment time is shown separately from original creation priority.
- Fixed Pick stock / Put stock actions are capability-gated and restricted to My work. Desktop positioning follows the existing 288 px sidebar and 113 rem shell. Bottom padding and safe-area spacing protect the last row. Native dialogs appear above the footer.
- More opens the applicable Decline, Cancel task or Stop remaining work confirmation. Decline is only available for untouched assigned offers. Existing server commands and safeguards remain authoritative.
- Routine tools and device recovery are under Work tools in the sub-navigation. Offline warnings, saved updates requiring attention and genuine review status remain visible.
- Live updates insert new assignments at the top and preserve a focused/edited row, its original generation, modal draft and horizontal scroll. Removal/reordering of a protected row waits until editing is released. Retained Start buttons disable for changed generation, ownership, completion, review, capability/actionability or offline state, with “Task unavailable. View its details.” Focused next-task and action-dialog controls also reject stale state.
- Service-worker cache advances from v14 to v15.

## Automated verification

`npm test`: **212 passed, 0 failed**. This includes 210 tracked tests plus two pre-existing unrelated untracked Pi health-check tests. The focused Work suites passed 32 tests. `git diff --check` passed.

Added coverage exercises server assignment order and tie-breaks, late reassignment, globally oldest actionable work beyond pagination, review and capability exclusions; compact row/action rendering; live insertion and deferred stale-row removal; and retained Start/next-task/dialog staleness while preserving original generation. Existing accounting, offline queue, timing, permissions and execution tests remain green.

## Browser evidence and limits

Screenshots in `docs/evidence/my-work-redesign/` use synthetic data in a **GET-only renderer fixture** at `http://127.0.0.1:3214/fixture`, not warehouse records. The fixture imports the actual application shell, CSS, rendering functions, dialog opener and live patch function, with small fixture-only click/draft wiring; all submissions are prevented and the server rejects non-GET methods. It serves the production mobile navigation script and brand assets. It has no authentication or warehouse command endpoints.

Verified at 320×640, 390×844, short 390×500, 820×1180, 1440×1000 and 1920×1080:

- Compact single-line rows, horizontal table scrolling, collapsed phone navigation, visible next-task prompt and bottom stock actions.
- At 320 px, document width stayed within the viewport; last row bottom was 503.84 px and footer top 563 px after scrolling to the end.
- At 1920 px, sidebar right and footer left both measured 336.5 px; footer stayed within the centered shell.
- At 390×500, native dialog occupied y=16…484 and stayed above the footer. Both confirmation and Keep task remained reachable. This is a reduced-height viewport check, not a physical mobile-keyboard test.
- Opened and closed Decline via More. Typed “Preserve this draft while new work arrives.” A fixture timer inserted MRE Pack first without a reload; Combat Boots remained the oldest top prompt, and the input retained its text and focus with the dialog open. Reopening retained the draft.
- Work tools opened and exposed manual movement, history and nested device recovery links.

Evidence: `desktop.jpg`, `wide-desktop.jpg`, `phone.jpg`, `phone-dialog.jpg`, `small-phone-bottom.jpg`, `tablet.jpg`. Fixture content and production files were current for these checks; no command submission is implied by these screenshots.

The actual isolated application at `http://127.0.0.1:3213` was restarted with its existing simulator fixture. Its browser session was logged out. **Automatic approval review rejected signing into the disposable `second` operator account**, stating that trusted messages did not authorize that account sign-in. The requested clarification remains pending. There was no retry or alternate sign-in. Consequently, this pass does not claim authenticated populated-page or command-submission browser coverage. Independent verification can use an already authorized session. Previous denials concerning additional disposable Pick creation and stocktake Start also remain pending and were not retried.

## Local review state

Only the seven application/test files and this handoff/evidence belong to the change. Unrelated `.DS_Store`, assets/deploy/output/tmp and Pi recovery files/tests are excluded. No physical hardware, warehouse stock records, network settings, account permissions or warehouse commands were changed by browser verification. The existing isolated simulator preview and GET-only fixture remain available for independent review.
