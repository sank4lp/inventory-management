# Usability follow-up baseline

28 September 2026. This bounded follow-up builds on local commit `04c30be` on `public-product-development`. It is the stable baseline for the requested four subsequent review/fix/retest rounds, not one of those rounds. No push, merge, deployment, network configuration or physical-device change was made. The original published Pi snapshot remains `2e0e3f1`.

## Implemented

- Team task tabs wrap as whole words: Active, Needs assignment, Overdue, History. The duplicate Team heading and explanatory paragraph are removed. Filters are collapsed with their current state in the summary. The first task is visible in the 390-pixel phone capture. Table rows and horizontal access to actions remain intact.
- Product names lead task rows and task detail headings; SKU and task number are secondary. Stored task summaries and original quantities are unchanged.
- Role creation starts from Operator by default; starting empty remains explicit. Checkbox labels stay together with a touch target and visible focus. Missing access is listed, including transitive prerequisites, before the user chooses **Include the required access listed above**. Nothing is added merely by choosing an action. Server validation, full-admin requirements, revisions and last-admin guards are unchanged.
- Current stocktakes precede schedule administration. Custom interval is visible/enabled only for Custom. Warehouse timezone comes from the existing schedule or warehouse metadata and appears as a summary, with intentional timezone editing under a disclosure. The following date is previewed without changing the stored anchor/date. Location selection appears only for selected-location scope.
- Normal count forms lead with physical totals. Unexpected products, damaged/expired quantities, notes and historical counting time are secondary disclosures. Items physically present remain in the total even when awaiting a pick or damaged. Busy-location guidance says to save the observed count and have a supervisor arrange another count after movement ends. Blank counting time remains **unknown**; the UI does not manufacture a current or historical timestamp.
- Setup shows Light → Scan → Name/details → Save and next. QR strings/manual entry, batch enrollment and replacement are secondary. A successful decode confirms that a sticker was read, focuses the name, and still requires the existing separate physical-light confirmation. Failed camera access opens the manual fallback. Label printing uses “unused stickers”; token lists stay in details.
- Broad report-to-entry word replacement is removed. Routine review guidance is derived from the case state; original reason and user notes remain verbatim in Entry details. Queue delivery/checking messages describe the next action, and original server details remain available separately. Analytical Reports is unchanged. Review filters are collapsed and the page title is consistently Needs review.
- Offline asset cache advanced to v10 so updated screens replace the earlier cached versions.

## Actual browser evidence and approval limits

All browser writes below used the already isolated preview at `127.0.0.1:3213`, temporary working directory/database `lytguide-preview-nMJMOX`. Read-only process checks showed that temporary database, a loopback listener, simulator health messages and no serial-device handle. No production database was used.

**Verified through the normal browser interface:**

1. Created simulator Pick task 3 for one pair of Combat Boots. Arrived at Z1-R1-C02, used the camera/manual fallback, inspected the actual quantity and pressed Finish. The result showed **Completed**, recorded 1 and remaining 0. [Completion capture](phase-3-evidence/pick-completed-followup.png).
2. Entered duplicate test evidence for that completed pair, inspected the populated review case, selected the existing human-readable saved movement, used View saved entry, and resolved with Use this saved entry. The case disappeared with “no stock was posted again.” Read-only database verification showed exactly one transaction, one posted entry and one duplicate entry. The historical task summary was not rewritten. [Populated duplicate capture](phase-3-evidence/duplicate-review-followup.png), [accounting result](phase-3-evidence/duplicate-accounting-followup.json).
3. The duplicate entry contained the note `Simulator duplicate check: original report says "report the picked pair".` Its wording was preserved exactly in Entry details.
4. Checked whole-word Team tabs and first-task visibility at 390×844. [Phone Team](phase-3-evidence/team-phone-followup.png).
5. In an unsaved Operator-copy draft, selected team assignment, saw the required Team viewing access listed, and explicitly included it. No role was saved in this follow-up. Checked checkbox/label alignment and focus at phone width. The earlier committed browser evidence still covers saving Operator-plus-hardware-view and denied controls. [Phone role editor](phase-3-evidence/role-editor-phone-followup.png).
6. Changed unsaved schedule drafts between Weekly, Monthly and Custom: October 31 previews November 7, November 30 and November 10 for a ten-day interval, respectively. Custom interval is hidden for the first two; timezone input remains behind its disclosure. No schedule was saved. [Measurements](phase-3-evidence/schedule-followup.json).
7. Inspected normal label printing on a phone: no token list or raw QR field dominates the page. [Labels](phase-3-evidence/labels-phone-followup.png).

**Automatic approval review blocked two further browser submissions:**

- Creating a second Pick for untouched cancellation: “This submits a new Pick that reserves stock and creates non-trivial application state; the user has not specifically authorized creating another task, even in the simulator.” The whole submitted tool call was rejected; the second Pick was not created.
- Starting a stocktake: “Starting the stocktake changes non-trivial operational state and begins physical count workflow; the user has not specifically authorized this consequential simulator action.” A one-location disposable stocktake had been created successfully, but Start and all dependent count actions were not executed.

Neither rejection was bypassed through another interface. The temporary preview retains the pending count. Approval is still needed for those remaining browser acceptance actions. The earlier blanket Pick/Finish limitation is now narrowed: one complete Pick/Finish succeeded, while the additional cancellation and count sequence remain blocked.

## Scenario coverage matrix

| Requested scenario | Evidence / remaining limit |
| --- | --- |
| Sign in, My work, Pick, arrive, scan/manual, actual, completion | Earlier sign-in/personal landing checks plus this browser Pick/manual/Finish pass. Real camera and physical travel remain site checks. |
| Decline → returned row → search person → reassign, no unrelated review | Earlier browser pass and current automated regression pass. |
| Untouched cancellation, known partial stop, genuine unknown movement | Existing automated state/accounting regressions pass. Additional browser cancellation was blocked; no new browser claim for partial/unknown cases. |
| Lost connection, waiting/saved/needs check and reconnect | Automated outbox/rendering and durable replay/accounting coverage retained. Live phone network loss/reconnect was not newly exercised; Mac networking was unchanged. |
| Assignee editing while updates arrive, paging, older active work | Earlier live draft/focus/scroll evidence plus automated 100-row paging/older-active checks retained. |
| Populated supervisor review, person filters, duplicate and count overlap | Real populated duplicate browser pass here; missing-quantity, composed person filters and numerical count overlap/one stock write covered automatically. Browser count-overlap preparation depends on the blocked count start. |
| Ordinary, mixed, empty, busy and damaged-item count | Service scenarios and new count-form collection/visibility tests pass. Browser count start blocked; none of these are claimed as newly browser-completed. |
| Weekly / Monthly / Custom | Browser applicability and next-date previews pass; existing persistence/calendar tests pass. Unsaved browser drafts only. |
| Two adjacent lights, successful scan, unreadable fallback | Existing setup binding/uniqueness/display tests and new successful-decode/failed-camera interaction test pass. No physical adjacent-light or camera signoff. |
| Operator plus hardware view on phone, prerequisites and denials | Earlier save/assignment/denial browser evidence, new phone alignment and explicit prerequisite draft interaction, automated direct denials and last-admin checks. |

## Automated validation and next review

Final suite: **181 passed, 0 failed, 0 skipped**. [Full follow-up test log](phase-3-evidence/usability-final-tests.txt). Added focused tests cover explicit prerequisite inclusion with no unrelated grants; weekly/monthly/custom applicability and calendar preview; normal/empty/busy count presentation with explicit unknown/earlier time; unchanged user-authored review wording; and successful setup decoding versus failed camera fallback. Existing accounting, access, stocktaking, locations, offline/replay and firmware regressions passed.

This baseline preserves all earlier functionality. The next four sequential product-manager rounds should begin from the commit containing this file and review the corrected screens independently. Continue with one application writer. Preserve unrelated `.DS_Store`, assets/deploy/output/tmp and Pi maintenance files. The physical Pi/Linux ARM64 offline toolchain, USB/RS485, flashing, reconnect, actual lights and camera checks listed in the original handoff remain pending.
