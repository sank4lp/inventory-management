# Assign Work — verification handoff

Base: local My work commit `012e3a3`, preserved on `public-product-development`. This change is local only; no push or deployment.

## User-visible result

Team work is now **Assign Work**, still at `/work/overview`. Its normal content is one always-open form: Pick/Put toggle, Product, Quantity, Assigned to, Due in plus Minutes/Hours/Days, and **Assign Task**. Fresh forms default to **8 Hours**. Product names include codes/units; people include usernames to distinguish duplicate names. Admins, operators and custom-role accounts are listed. Inactive users and people without execution permission remain visible as disabled options with short reasons. Empty product/eligibility states disable submission.

The page has no active-task table, status tabs, workload cards, advanced fields or redundant search fields. Routine connection/device tools use the compact sub-navigation Work tools disclosure. Actual offline, saved-request and error notices remain visible. After success the assigner stays on this form with “Task assigned to [name].” The draft clears and the new form starts at 8 Hours. Ordinary self-created Pick/Put still opens its execution task.

## Deadline, receipt and access behavior

- New `assign` commands reuse the existing reservation/creation transaction and receipt machinery. Duration is calculated from the server's `assigned_at`, in elapsed minutes, hours or days. Valid total duration is **1 minute through 365 days**, including fractional hours/days. UI min/max values follow the unit. Missing both duration fields defaults to 8 Hours; malformed, blank, incomplete, non-finite, zero, negative, too-short and excessive inputs reject with no task/reservation/receipt left behind.
- Original request identity and payload persist in the existing outbox. Successful retries return the stored task/result without recomputing a deadline; changed payloads under the same identity reject. Pending/unknown assignment outcomes lock new assignments, including saved legacy `create` requests carrying an assignee. The submit handler also checks the lock, and errors cannot re-enable a known-pending assignment.
- Existing `create` API behavior, self-started defaults, existing task deadlines and inactivity/review timing are unchanged. The separate `assign` command gives this form its explicit duration independently of the legacy global timer. Initial duration selection requires assignment permission; existing absolute deadline overrides still require `work.deadline`. Assign Work does not accept an absolute `dueAt` override.
- Navigation, direct page admission, assignment snapshot and command require `work.assign`. Creation also checks the selected actual direction (`work.pick` or `work.put`) on the server. The new form uses explicit `assign` permission rather than inferring creation permission from both radio options in its HTML.
- `work.assign` now requires `work.view`, independently of `work.team`. No stored role grants are rewritten. Assignment-only roles receive dropdown identities/eligibility but no team workload counts. Existing team/review visibility retains those counts. A role without team visibility can reassign only tasks it is already authorized to read. Existing generation, assignee eligibility, owner execution, reservation, decline, audit and movement checks remain in force.
- The timing-settings copy now identifies the legacy default and explicitly says Assign Work uses its chosen form duration; inactivity copy and behavior stay separate.

## Existing monitoring access

**History → Team history** (`/work/history?scope=team`) contains the existing task filters, active/needs-assignment/overdue/history views, workload disclosure, deadline controls and timing link, gated by `work.team`. Reassignment remains on task details and the existing monitoring rows. Personal History remains the default. Explicit team-scoped snapshot requests require team permission.

For authorized assigners with team visibility, old filtered `/work/overview?...` links redirect to the corresponding team History scope, preserving filter parameters. The unfiltered path opens Assign Work. Team-view-only users access monitoring through History and do not gain access to the assignment URL. The warehouse overview shortcut follows the same permissions. My work's design and execution flow, Needs review, Stocktaking and main navigation layout are preserved.

## Verification

Final `npm test`: **220 passed, 0 failed** (218 tracked tests plus two pre-existing unrelated untracked Pi health-check tests). `git diff --check` passed. New/updated tests cover:

- 8-hour default with disabled global timer; minute/hour/day conversion, fractional units and year limit; self-created and prior task preservation.
- Invalid duration rollback, immutable deadline/result on replay, and changed-payload rejection.
- Assignment-only custom roles, independent Pick/Put rights, direct HTTP page/API admission, forbidden team scope and absolute deadline overrides.
- All account types, duplicate identities, inactive/non-executor rejection, assignment-only workload privacy and scoped reassignment.
- Simple form rendering, fresh default, unit bounds, direction disabling, empty states, legacy/new pending locks, successful non-redirecting submission, and retained History monitoring.
- Role prerequisite preview updated for assignment's independent work-view requirement; timing copy regression.

Browser checks used the **GET-only synthetic fixture** at `http://127.0.0.1:3215/assign`. It serves the production shell, styles, brand/mobile navigation, actual work renderer and production change handler, with in-memory draft wiring and all submission effects blocked. It reads current source for each page load. Variants `?mode=pick-only` and `?mode=empty` expose a restricted custom role and empty products. This is form/layout evidence, not authenticated warehouse submission evidence.

Verified desktop 1440×1000, phone 390×844, small phone 320×640 and tablet 820×1180. Pick/Put selection, distinct product code selection, eligible custom-role selection and 0.5 Days worked. Disabled user options were visible. The pick-only role had an enabled Pick, disabled Put and usable form without team navigation. Zero Minutes was below the input minimum (min=1, max=525600). The empty-product state disabled Assign Task. At 320 px, document width was 305 px with no horizontal overflow; the final button was fully reachable after ordinary vertical scrolling. Browser console reported no errors during the toggle check.

Screenshots in `docs/evidence/assign-work/`: `desktop-default.jpg`, `desktop-filled.jpg`, `phone-default.jpg`, `small-phone-bottom.jpg`, `tablet-pick-only.jpg`. No task was submitted in the browser.

## Independent review state

Shared browser viewport was reset; the temporary assignment tab was closed. The existing isolated simulator at `http://127.0.0.1:3213` was restarted with the final backend. The new GET-only fixture on **3215**, and prior My work fixture on **3214**, remain available. Listening processes were confirmed for all three ports after restart (3213 PID 42002, 3215 PID 41988, 3214 PID 30467 at verification time). Exit 130 entries refer to replaced processes, not these running previews.

No new sign-in was attempted, no warehouse commands were submitted through the browser, and prior approval limits remain untouched. No real hardware/data, network settings or account permission records were changed. Automated tests use disposable databases. Unrelated `.DS_Store`, assets/deploy/output/tmp and Pi recovery files/tests are excluded from the commit. Stop implementation after the scoped local commit for root's independent review; do not push.
