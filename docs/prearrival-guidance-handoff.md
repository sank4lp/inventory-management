# Pre-arrival Pick/Put guidance correction

Base: `a8328ac`, branch `public-product-development`. Preserve My work, Assign Work and Pi recovery changes. Local commit only; root publishes after independent verification.

## Correction

Self-started Pick/Put and an operator accepting **Start** now send guidance for all safe planned ready cells before **I'm at this location**. An admin merely offering an assignment sends no task light. Exclusive cells show the planned Pick quantity in green or Put quantity in red; shared cells retain yellow `LOC` and each operator follows their own on-screen quantity.

Display ownership uses the existing durable `work_guidance` generation, independently of `cell_turns`. Lighting does not change a ready line to working, fill `started_at`/`device_id`, emit `location_ready`, record an actual, or post stock. Arrival retains its existing priority: a later-created task may arrive first and take the physical turn, replacing the display-only hint. Scan/manual verification and explicit Finish accounting are unchanged.

A reconciliation step runs after each committed command and on existing maintenance sweeps. It retains a valid ready display owner, gives actual arrival priority, and promotes waiting ready guidance when ownership is released. Line-specific uncertainty blocks unsafe exclusive-cell guidance without suppressing a healthy sibling cell in the same task. Shared healthy participants retain the locator. Return, cancel, reassign, replan, settlement, stop, inactivity and remaining-quantity rebalance all reconcile the desired light. Old task cleanup cannot blindly clear a newer owner's generation. Untouched pre-arrival work still does not become inactivity/physical evidence merely because it was lit or overdue.

Utility quantities, setup lights and legacy direct hardware utilities now recognize pre-arrival guidance as active. A pending task clear also blocks utility takeover until delivered. Existing utility expiry generation checks and adapter locator-timer cancellation protect newer task lights. Hardware writes verify the current guidance generation, captured mapping revision/controller configuration, and the actual target cell/controller/channel/address.

## Restart and delivery

Startup explicitly restores active safe guidance. Existing already-started ready tasks from before this update are eligible for restoration; merely offered or unaccepted legacy tasks are not newly started by recovery. Existing startup uncertainty handling for working/legacy instructions runs first. Normal construction of a service during the 30-second maintenance sweep does **not** replay delivered lights. Failed sends remain pending and retry on maintenance or subsequent commands.

The phone now shows a short sent, waiting, shared-locator or manual status before arrival. “Sent” is a command delivery result, not a physical LED acknowledgement. Offline hints say status may have changed. The live patch updates only the hint text while preserving focused controls, input drafts and the arrival→scan→Finish flow. Sent quantity text includes the current planned quantity. Service-worker cache advances to v17.

## Verification

Final full suite: **229/229 passed**. `git diff --check` passed. Eight new service/hardware tests and one UI regression cover:

- Actual RS485 adapter commands captured through `rs485WriteLine`, for all four self/accepted-assignment × Pick/Put cases. Two cells receive quantities 3 and 2 before arrival, e.g. `to GUIDE digit 1 "3" green 120 20` and the corresponding red Put commands. Offered-only assignments remain dark. Zero arrival turns, reports or movements are created.
- Contention, later-arrival priority, settlement promotion and cleanup that cannot erase another owner.
- Exclusive uncertainty, independently usable sibling cells and shared locator continuity.
- Return/cancel/replan cleanup and untouched inactivity safety.
- Utility/setup exclusion, old utility expiry, stale guidance generation and changed mapping rejection.
- Explicit restart restoration, repeated maintenance instances without replay, failed-delivery retry.
- Remaining-plan quantity change/clear after verified actuals; an older real-adapter locator timer cannot clear the new quantity display.
- Guidance hint updates with a focused draft, including waiting/shared/offline/closed transitions without exposing Finish early.

Existing workflow, assignment, display, stocktaking, timeout, accounting and UI regressions remain green. Root separately reported that its four-case two-cell wire probe and independent full regression run passed.

## UI evidence and remaining physical check

GET-only synthetic fixture: `http://127.0.0.1:3216/guidance`. It uses production rendering/live-patch functions and styles, with no warehouse command handler. At 390×844, a scheduled synthetic light handover changed the visible hint from sent to waiting while “Keep this draft while the light changes.” and focus in the reason field were preserved. The arrival button remained available; no arrival or report was submitted. Evidence is in `docs/evidence/prearrival-guidance/ready-phone.jpg` and `live-waiting-phone.jpg`.

No real Pi/RS485 bus, LED, account sign-in or warehouse command was used in this pass. On the Pi after updating/restarting, physically verify both Pick and Put quantities/colours before arrival, two-cell plans, assigned-task acceptance, shared locator behavior, contention and clearing/promotion after completion/cancel. Command capture cannot confirm LED wiring, controller firmware reception or physical output.

The isolated simulator preview at `http://127.0.0.1:3213` was restarted with the final code. The read-only guidance fixture remains available on 3216; earlier read-only fixtures remain untouched. Browser viewport was reset and the temporary tab closed. Prior browser approval limitations were not retried or bypassed. No push, hardware configuration or network changes were made. Stop implementation after this local scoped commit for root review/publication.
