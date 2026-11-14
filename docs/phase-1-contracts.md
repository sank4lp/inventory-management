# Phase 1 preparation and implementation contracts

Prepared 28 September 2026. Baseline: `b5e59cf741d3e1285d31956cfbd614a9945267a7`, branch `public-product-development`; 123/123 baseline tests pass. No AGENTS.md was found in the checkout or ancestor directories. Existing `.DS_Store`, assets, output, tmp, deploy and Pi recovery files are unrelated and preserved. Existing preview is isolated at 127.0.0.1:3210; implementation uses a separate isolated simulator fixture.

## State and command decisions

- Preserve workflow v2 and its ledger, reservations, settlements, receipts and review records. Add an explicit task outcome without rebuilding the legacy task-status CHECK constraint. Closed partial work is stopped, zero work cancelled; completion means requested quantity fulfilled with no unresolved report.
- Persist current assignee and assignment generation separately from creator. Immutable task events retain assignment, response and deadline changes. Legacy ownership migrates from creator without fabricating assigner/time/deadline. Execution belongs to the assignee; admin review is a separate action.
- Assignment/Start never acquires a cell turn. Arrival acquires under current owner, generation and line revision. QR verification only returns evidence for the summary. Finish and manual Finish use the same report command and inventory transaction.
- Reports preserve original cell, quantity, unit, instruction revision, assignment generation, actor and method. Late reports by prior assignees enter review. A stable request identity replays its receipt; a changed payload cannot reuse it. A settlement is unique per line. No scan posts stock.
- Cancel requires current revision and explicit zero for started work; pending evidence prevents release. Stop returns untouched holds, sends unknown active work to review, preserves actuals. Reassign only eligible untouched remaining work; unresolved/active work must be resolved first. Server ownership cannot revoke physical offline work.
- Requested quantity remains fixed. Actual splits can differ; remaining requirement is derived from settled actuals. Never revise another active line silently. Replanning and reassignment validate stock/capacity atomically.
- Deadline is persisted once from the assignment warning rule; changes apply only to new tasks. Reassignment/decline/refresh do not reset it. Inactivity retains its separate existing setting. Deadline changes require audited admin intent.
- Stable cell ID and QR token/revision remain authoritative. Configurable field definitions and values supply directions. Hardware mapping remains in existing cells/controller mapping with additive version/verification metadata, not a second mapping authority. No physical verification is invented by migration.

## Preparation: deployment feasibility, not field acceptance

Candidate: 64-bit Raspberry Pi OS on an ARM64 Pi; Node >=22.13 is required by this checkout (including node:sqlite). Existing firmware path uses Arduino CLI and the ESP32 toolchain; simulator is available locally. Actual Pi model/OS, serial devices, toolchain versions, memory and connected-device capacity must be validated on equipment in Phase 4. No Pi or trusted-camera test LAN is available to this chat.

The agreed HTTPS candidate is a warehouse hostname under an owned domain, local DNS resolving to the Pi, and DNS-validated publicly trusted certificates with a renewal process. A managed CA is a separate managed-device option. The backend stays loopback; later Pi installation owns the HTTPS frontend, DNS/router dependencies and `inventory-management.service` lifecycle. This is an unverified deployment proposal from the agreed plan, not a claim of compatibility or a change to the work Mac. Real camera permissions, WAN outage, extender roaming, controller acknowledgement and physical sticker placement remain field checks.

## Verification plan

Extend transactional tests for stale plans, duplicate/lost receipts, two users, assignment/Start/Decline/reassign races, unchanged deadlines, four-plus-one splits, zero/partial/unknown stop, manual Finish, wrong/revoked QR, late evidence and prior-user attribution. Exercise actual UI and responsive 320px/phone/tablet/desktop states. Validate saved drafts, immutable outbox requests and account partitions. Keep simulation evidence distinct from real camera/hardware validation. Final readiness is recorded only in phase-1-workflows-handoff.md after the checks pass.
