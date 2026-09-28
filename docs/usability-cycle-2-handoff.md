# Usability cycle 2 — local review handoff

Base: `fea1e5a` (Cycle 1 independently accepted). This commit is the bounded Cycle 2 review unit. It is ready for independent retesting, not yet counted as a verified second cycle. No push, merge, deployment or change to the published Pi snapshot `2e0e3f1` was performed. `c9dea86` and `2e0e3f1` remain ancestors.

## Changes

- Untouched offered assignments show Start and Decline without a competing Stop in the operator row or details. Self-created cancellation, started/partial stops and an administrator's controls for another person's work remain available. Genuine attention, recorded quantities, started lines and reports prevent classification as an untouched offer. No assignment, inventory or uncertainty rules were changed.
- Routine live monitoring updates row facts, timestamps and counts without adding the technical polling paragraph or replacing a meaningful notice. Connection failures have a separate visible status. Edited cells, action forms, assignment generations, focus and scroll retain their existing protections; new/changed rows still update.
- Count comparisons and both initial/search candidate labels show Counting time unknown when `counted_at` is absent. Received time is explicitly separate. No timestamp is synthesized or persisted, and count-link accounting is unchanged.
- Other evidence exposes and requires a nonblank description, including when restoring a draft whose description panel was collapsed. Ordinary methods retain an optional secondary note. Client and service reject label-only/whitespace Other evidence. Quantity and performer are not inferred, and I'm not sure remains a separate pending action.
- Task filters display Active/Finished while retaining `open`/`closed` query values. Timing supports Hours/Minutes with display conversion and draft restoration, using the existing service conversion. Missing updates during started work remains a separate minutes setting. Existing deadlines stay unchanged when defaults are saved.
- Offline asset cache advanced to v12 for the changed Work client.

## Verification

Final full suite: **194 passed, 0 failed, 0 skipped**. [Test log](usability-cycle-2-evidence/tests.txt). Eight new regressions cover the action choices, count timestamps, evidence validation and draft restoration, quiet monitoring, timing conversion and existing deadlines. Service fixtures verify rejected Other evidence creates no transaction, keep-pending remains available, valid ordinary/described evidence posts exactly once, and new deadlines use the requested interval. Existing accounting, role, generation, outbox, stocktaking and hardware-adapter regressions passed.

Actual browser checks used the existing disposable loopback simulator at port 3213, with its separate temporary database:

- Signed in as the operator assigned Task 2. The 390 px phone row showed Start/Decline; details had one Start form and zero Stop forms. No task action was submitted. [Phone offer](usability-cycle-2-evidence/offered-phone.png).
- Kept an unsaved Pick search focused across 99 seconds. The update time advanced; notice stayed empty; exact search, focus and 210.5 px scroll stayed unchanged. [Measurements](usability-cycle-2-evidence/quiet-polling.json).
- As administrator, changed only unsaved timing inputs: 2 Hours → 120 Minutes, reloaded the draft, then changed back to 2 Hours. Inactivity stayed 5 minutes. No Save was submitted. [Measurements](usability-cycle-2-evidence/timing-conversion.json), [phone timing](usability-cycle-2-evidence/timing-phone.png).
- Inspected the Active/Finished filter options and captured Team work at a verified 1440 px desktop width. [Desktop filters](usability-cycle-2-evidence/filters-desktop.png). Temporary viewport overrides were reset, and the main preview remains open with the administrator signed in.

Populated review browser evidence is **read-only renderer-fixture evidence**, not live warehouse resolution. A temporary static server on port 3214 rendered the actual Work rendering functions and CSS with synthetic unknown-quantity/count-overlap/duplicate candidates. Its forms could not submit, it had no warehouse/database routes, and the page was labelled Read-only review fixture. The temporary tab was closed and server stopped after inspection.

- Selecting Other evidence opened a required, initially invalid description. Switching to Spoke with operator made it optional and retained typed text. Quantity stayed blank and performer stayed unknown. [Control measurements](usability-cycle-2-evidence/verification-controls.json), [390 px phone evidence](usability-cycle-2-evidence/other-evidence-phone.png).
- The count comparison showed recorded 10 → counted 8 pairs, a 2-pair pick, Counting time unknown and a separately labelled Received time; the candidate label preserved the same distinction. [390 px phone count comparison](usability-cycle-2-evidence/count-time-phone.png), [desktop review](usability-cycle-2-evidence/review-desktop.png), [fixture data](usability-cycle-2-evidence/review-fixture-data.json).

## Limits and next step

Automatic approval review previously rejected the additional disposable Pick creation for cancellation testing and stocktake Start. The coordinator's existing approval request remains pending; neither action was retried or bypassed. This cycle created no warehouse workflow state. Read-only fixtures do not certify end-to-end browser resolution or physical counting. Earlier successful Pick/Finish and duplicate-resolution browser evidence remains described in the baseline handoff.

Physical Pi/ESP32, real QR/camera/light operation, hardware flashing and field network checks remain pending. Cycle 3/4 findings were not implemented here. Independently retest this stable commit before counting Cycle 2 or selecting the next batch. Unrelated workspace files, including Pi recovery work, are excluded from the commit.
