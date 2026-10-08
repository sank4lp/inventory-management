# Phase 1 workflow handoff

**Ready for Phase 2: YES — Phase 1 software acceptance is complete.**

Date: 28 September 2026. This gate covers the local application and simulated hardware. It does **not** certify Pi/tablet camera, warehouse networking, physical labels or controllers; those remain Phase 4 field checks. No release branch was merged and no production data was changed.

## Revision and inputs

- Branch: `public-product-development`.
- Baseline: `b5e59cf741d3e1285d31956cfbd614a9945267a7`.
- Main implementation: `df93b81`.
- Verified implementation revision: `329dc137c8627840bd104582834328c14bc62afb`, including retained handback notes and stale-reviewer protection. This handoff is the following documentation commit.
- Inputs: the 28 September authorized Phase 1 work package in `LightGuide-UX-and-navigation-plan.md`, and `LightGuide-feature-map.md`, both in `/Users/sankalprajpoot/Documents/Codex/2026-09-16/realtime-voice-chat/`.
- Preparation, baseline findings and deployment assumptions: [phase-1-contracts.md](phase-1-contracts.md).
- Existing `.DS_Store`, `assets/`, `deploy/`, `output/`, `tmp/`, Pi recovery documentation/scripts and `test/pi-healthcheck.test.js` were preserved outside these commits. The existing port 3210 preview was not modified.

## Completed behaviors

The operator flow is: create or open assigned work → Start assigned work → human directions → **I'm at this location** → eligible turn and camera → verified QR summary → explicit **Finish**. Arrival and scanning do not post stock. Manual completion opens the same quantity summary and submits the same accounting command, retaining a short manual reason. Closing the camera does not declare zero or stop physical work. Late camera permission results release the unused stream.

The screen focuses on one location, with other locations and earlier plans available separately. Quantities remain editable until Finish. Actuals are not silently capped at the plan: a three-plus-two plan can record four-plus-one. Only untouched instructions can shrink automatically; working or uncertain instructions remain independent. A partial cell actual closes that cell's unperformed remainder. The task shows recorded and remaining requested quantities, with completed, partly stopped, zero cancelled or unresolved outcomes.

Team work has assignment, operator search/workload summaries, all-task and needs-assignment views, filters, Start/Decline, handback, reassignment and audited deadline changes. Zero-workload and ineligible accounts remain visible to admins; only eligible active accounts can receive work. Assignment and Start reserve/accept work without taking a cell turn. Operator access is scoped to current or historical own work; viewing does not grant execution rights. Admins cannot execute an operator's assigned location merely because they can view it.

Creator, assigner, current assignee, physical performer, authenticated reporter and verifying reviewer remain distinct. Completion and throughput use actual performer attribution; mixed or unknown performers are not credited to the creator. Assignment history includes decline reason/note and preserves previous owners and deadlines.

Overdue warnings are stored per task, defaulting to 120 elapsed minutes for new tasks. Admins can change or disable the new-task rule, or explicitly change an individual deadline with a reason. Start, refresh, decline, reassignment and restart do not reset it. Overdue does not cancel work or release stock. Inactivity review remains a separate setting. A server clock earlier than task creation is surfaced as invalid rather than displayed as reliable elapsed time.

The review inbox separates unknown quantities from zero, starts with blank verified actual/method, shows assignment/report attribution, provides quantity shortcuts, and supports verification, unable-to-verify, resolve-and-stop, and explicit linking to posted movements. Recent matches are immediately available; **Search full movement history** searches older matching records by reference, person or ISO date. Results are bounded to 100 with a refine-search message, scoped to cell/product/action, and never selected or merged automatically.

Drafts, summaries, immutable commands and receipts survive refresh. Commands queued during an in-flight sync are delivered by the waiting sync. Lost responses retry the same request. Cross-account requests are refused by both client and server; other-account evidence remains stored. Offline stop/decline/cancel requests are visibly awaiting warehouse confirmation, never presented as released holds. A small banner outside Work exposes unsent reports without delivering them under another account. Product/location shortcuts preserve their return context and saved scroll position.

## Data and integration contracts

### Migration and state

`APP_SCHEMA_VERSION` is **7**. Migration is additive in `src/modules/operations/schema.js`; it preserves workflow-v2 ledger/reservation/settlement machinery and legacy task status constraints.

| Resource | Phase 1 additions / meaning |
| --- | --- |
| `tasks` | `assignee_id`, `assigned_by`, `assigned_at`, `assignment_generation`, `assignment_state`, `assignment_source`, `due_at`, fixed `requested_quantity`, `outcome`, `instruction_note`, `stop_requested` |
| `task_lines` | `instruction_snapshot`, `instruction_owner`, `assignment_generation`; existing `revision` remains the instruction concurrency boundary |
| `task_assignment_events` | Append-only actor, previous/current assignee, generation, event, timestamp and payload |
| `work_instruction_history` | Original description/instruction and assignee per line/revision, used to recognize late former-owner evidence |
| `work_reports` | `case_revision` for concurrent review; existing quantity-known, performer, reporter, resolver and immutable payload remain authoritative |

Do not infer completion from `tasks.status` alone: compatibility storage still uses `pending_review` for open work and `cancelled` for closed short work. Use the service's `outcome`, attention, recorded/remaining quantities and assignment state. Completion means the request is fulfilled without unresolved evidence. A returned untouched task has no assignee and `needs_assignment`, not a phantom inactivity case.

Legacy tasks gain creator-as-assignee and their existing planned requirement where recoverable. Migration does not invent assigner, assignment time, deadline, event history, performer or physical verification. Existing pending legacy instructions continue through the existing review adoption path. Old POST planning forms fail safely; old confirmation forms require explicit actuals and enter review rather than posting current replacement plans.

### Commands, reports and access

- Reuse `createOperationsService().command(actor, action, input)` and `/api/work/:action`. Its immediate transaction, actor checks, immutable fingerprint receipt, origin identity and per-line settlement prevent duplicate stock writes.
- Retain `requestId`, `actorId`, `site`, `dataset` and `deviceId` from the original command. Do not regenerate an offline command into a new owner's or replacement line's identity. A changed payload cannot reuse a receipt key.
- Line commands carry `lineId`, `revision`, `assignmentGeneration`, cell, product, direction and unit. Task ownership commands use `taskId` and `generation`; review commands use `reportId` and `caseRevision`.
- Added actions: `start`, `decline`, `reassign`, `stop`, `deadline`, `timing`, `askReview`, `verify`, `locationDetails`. Existing `report`, `manual`, `resolve`, `correct`, `cancel`, `replan`, `mode` and `reconcile` remain the shared paths.
- `verify` only validates arrival/current turn/current label. `report` performs both QR and ordinary manual Finish accounting. Manual completion uses `method: 'manual'` with `manualReason`; `manual: true` instead denotes recovery/difference evidence for review.
- A prior assignee's late physical report is retained for review. It cannot execute the replacement plan. Resolving old superseded instructions also makes replacement work uncertain where necessary; it does not erase other reservations or pretend the old worker stopped.
- Only untouched, evidence-free lines can release directly. Active or uncertain handoff blocks reassignment until physical work is resolved. Overdue and server-side ownership changes cannot revoke offline physical activity.
- `GET /api/work/snapshot` supplies scoped tasks, capabilities, team directory, timing, pending cases and recent posted evidence. `GET /api/work/movements?reportId=…&q=…` is admin-only and searches matching full history. It is read-only.
- `src/modules/operations/access.js` defines the small default-role Work boundary. Execute belongs to active admin/operator accounts; assign, team view, review and timing belong to admins. Phase 3 custom roles must preserve server-side checks and evidence access.

### Locations and hardware

Reuse `describeLocation()` and `saveLocationDescription()` in `src/modules/operations/location-contract.js`.

- Stable `cells.id`, `logical_code`, label token/revision and controller/output binding are separate from `display_name`, `travel_instructions` and descriptive fields.
- `location_field_definitions` supports stable field keys, text/number/select type, options, required/enabled flags, order, directions use and revision. `location_field_values` stores values by cell/key. Do not add a second Shed/Shelf model.
- `location_labels` records token/revision, unbound/bound/revoked state and optional cell binding/provenance. Existing labels migrate as bound without invented binding operator/time. Deleted cells revoke their registry entry and retain the retired identity.
- Existing cells created through older paths can validate their current token before the registry has been populated on restart; Phase 2 commissioning should create/update the registry transactionally. Revoked or mismatched registered tokens fail.
- `description_revision` protects editing; instruction snapshots preserve the description issued for old work. Updating a name does not rewrite past instructions or stock identity.
- Existing `controller_id`/`hardware_channel` remain the hardware mapping authority. Changes bump `binding_revision` and clear `binding_verified_at/by`. No migration claims a physical light was checked.
- Phase 2 owns field-definition editing, required-field setup validation, printed-label lifecycle and complete commissioning sessions. Coordinate setup/utility lights through the existing hardware coordinator; do not bypass active work ownership or introduce a second controller map.

### Browser compatibility

IndexedDB remains `lytguide-work` version 1 with `cache` and `outbox`; service-worker asset cache is v7. Summary/draft keys include site, account, instruction revision/generation and form context. No upgrade clears unsent reports. Exports and local clearing remain account scoped, and clearing is refused while unreceived evidence exists. Preserve these keys and frozen outbox payloads when Phase 2 changes navigation.

## Verification evidence

**Final `npm test`: 137 passed, 0 failed, 0 skipped.** Baseline was 123 passed. Full final output: [automated-tests.txt](phase-1-evidence/automated-tests.txt). `git diff --check` passed. Final preview console inspection returned no errors.

| Acceptance area | Evidence / result |
| --- | --- |
| Stale plans, wrong/early QR, duplicate or lost receipt, independent holds | Transactional operations tests; generated-QR decoder test; camera-frame simulation. No scan stock write, no retargeted replacement quantity, exact retry receipt. |
| Assignment, two users, Start, Decline, workloads and overdue | Admin/operator browser sessions and operations tests. Task 3 declined to Needs assignment, reassigned to admin, and completed with original 19:35:57 deadline. Start acquired no turn. |
| Partial handoff and late former-owner evidence | Operations tests verify remaining-only replan, preserved actual performer, generation conflicts, active-handoff refusal and late report review. |
| Pick/put, manual Finish, changed quantity, zero and stop | Browser Task 1 picked 4 against 5 and stopped partly; Task 4 put 2 and completed; Task 5 stopped untouched with zero movement. Tests verify 4+1 across two locations and explicit-zero cancellation. |
| Missing confirmation and reviewer actions | Browser Task 2 verified zero and stopped after unknown inactivity case. Task 6 retains unknown movement for demo review. Tests cover unknown/partial/duplicate-link resolution and concurrent case behavior. |
| Directions and contextual return | Browser edited Notebook shelf directions, then opened a cell-specific pick showing those directions and Back to stock. Tests cover custom attributes, preserved identities and revoked QR. |
| Durable browser state | Real browser quantity draft survived reload. Eight client reliability tests cover lost response, account partition, revision-bound summaries, camera cancellation/errors and queued-during-sync delivery. |
| Review search | Browser returned two explicit matching picks; regression finds a record older than the recent 500 and rejects operator access. |
| Migration and attribution | Tests cover legacy defaults, no invented assignment history, actor-bound commands, actual-performer throughput, rollback/clock-invalid display and retained reservations. |
| Responsive and keyboard | Live 320, 390, 768, 1024, 1440 and 3840px review layouts had no horizontal overflow; phone manual/Finish and tablet review/workloads exercised. Enter/Tab navigation and visible focus checked. |

Screenshots are from the isolated simulator, not physical warehouse verification:

- [Phone manual summary before Finish](phase-1-evidence/phone-summary.png)
- [Tablet partial receipt and performer](phase-1-evidence/tablet-partial-receipt.png)
- [Tablet unknown-quantity review](phase-1-evidence/tablet-review.png)
- [Tablet operator workloads](phase-1-evidence/tablet-workloads.png)
- [Desktop returned overdue task](phase-1-evidence/desktop-team-work.png)
- [Simulated 200% magnification with keyboard focus](phase-1-evidence/review-200-percent.png)

The embedded browser did not apply native zoom keyboard shortcuts. The 200% check used temporary CSS magnification, verified reachable controls/no horizontal overflow, then removed it. Viewport overrides were reset. Native browser zoom, OS text scaling, screen-reader speech and actual camera permissions still need representative-device checks. Camera frames are simulated in automated client tests; no claim of a real successful camera scan is made.

## Preview and continuation

Running isolated preview: **http://127.0.0.1:3211/work/overview**. It uses the simulator and demo accounts (`admin` / `admin123`, `operator` / `operator123`) in a disposable fixture, not customer data. The original preview remains on port 3210.

Fixture working directory: `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-uz7QYq`. Public assets link to this checkout. Preview log: `/private/tmp/lightguide-phase1-preview.log`.

To restart this same isolated fixture if needed:

```sh
cd /private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-uz7QYq
PORT=3211 HARDWARE_ADAPTER=simulator DEMO_INVENTORY_SEED=1 node --watch /Users/sankalprajpoot/Documents/Personal/inventory-management/src/server.js
```

Do not start another process on an occupied port. Existing startup safety marks ready/working tasks for review after a restart; this is preserved behavior, so source-watch restarts during a live demo can intentionally produce an uncertainty case. Closed and safely returned tasks do not acquire phantom cases. In this fixture only, assignment warning is 1 minute and inactivity review 60 minutes to demonstrate the distinct timers; application defaults are unchanged.

Useful demo records: `/tasks/1` partial four-of-five, `/tasks/2` verified zero, `/tasks/3` decline/reassignment/deadline history, `/tasks/4` completed put, `/tasks/5` untouched stop, `/tasks/6` unknown review. `/cells/26` has human directions. Task 6 is intentionally unresolved simulator evidence, not a software failure.

## Phase 2 inputs and remaining boundaries

Phase 2 may now implement Stocktaking, navigation and scan-based setup using these contracts. Keep one application writer for shared schema/accounting changes. Count observations must have their own session/baseline/correction model; they must not reserve pick/put stock or reuse movement Finish as an absolute stock overwrite. Existing generic count observations remain review evidence until the dedicated domain is implemented.

Full-history navigation/report pagination and broader custom-role boundaries remain later work; the current task snapshot/history lists can grow with warehouse history. The review movement search already queries full history with bounded responses. The clock warning detects demonstrable local timestamp inconsistency, not independent time synchronization; Pi time readiness must be validated in deployment.

No hardware/site acceptance is claimed. Phase 4 still needs the actual Pi/OS/runtime/firmware toolchain, controller and serial topology, representative tablets/browsers, an owned warehouse hostname and certificate/DNS method, clock readiness, printed labels and physical LED confirmation, WAN-loss and Wi-Fi-roaming tests. The work Mac's networking/trust policies were not changed. No installer, real LAN rollout, custom-role editor or broader navigation rewrite was included here.

Keep release integration subject to the user's existing review-before-merge requirement. These local development commits are the Phase 1 handoff; they have not been merged into `public-product` or `master`.
