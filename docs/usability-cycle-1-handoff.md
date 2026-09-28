# Usability Cycle 1 handoff

28 September 2026. Reviewed baseline: `57ab309`. Branch: `public-product-development`. The commit containing this handoff is ready for the coordinator's independent retest; this document does not count that retest as complete. No push, merge, deployment, production-data change, physical-device action or Mac networking change was performed.

## Four-item batch delivered

1. **Discoverable task actions.** A single set of operator Start/Decline/Continue/Cancel controls now lives beside the product in the first semantic table cell. All columns remain available by scrolling. The manager's searchable reassignment form and Save stay in the rightmost Actions cell. Offered own assignments lead with Start; the product link still opens details. There are no duplicated execution forms or IDs. Live updates preserve any cell containing focused/edited controls, including the new first-column forms, and still preserve the manager editor.
2. **Honest finished state.** Completed, stopped and cancelled task pages lead with their distinct outcome and Back to My work. Original deadline remains in Task details and assignment history. Reassignment is rendered only when its form exists. Completed/cancelled tasks have no empty reassignment disclosure; stopped tasks with a remaining quantity retain their existing reassignment path. Uncertain tasks do not receive the completed treatment.
3. **Searchable explicit product selection.** Pick, Put, assignment and completed-movement forms share name/SKU search with an accessible native select and visible selected quantity unit. Searching never selects a result automatically or removes the existing chosen product. Recovery starts with explicit product/location placeholders unless intentionally prefilled or restored from its draft. Current product, preferred location, quantity and return link carry into recovery. Context-specific drafts prevent an older plain Pick draft from overwriting a request opened from Products/Locations. Each separate recovery draft has its own stable generated reference; returning to the same draft keeps that reference.
4. **Simpler completed-movement form.** Movement, product/location, actual quantity and What happened lead. Performer attribution stays distinct and available where permitted. Original reference, original unit and earlier time remain editable under Earlier work or paper records. A generated reference is already populated, while clearing a required field still opens its containing disclosure on validation. Blank time remains unknown; blank original unit still uses the selected product unit. Count observation remains reachable and explicitly does not replace the stock balance. Frozen outbox requests, command IDs, stored history and server accounting/authorization behavior are unchanged.

Offline cache version is v11 for the updated Work client.

## Browser checks actually performed

Used the existing isolated simulator on `127.0.0.1:3213`; only sign-in, navigation and unsaved form interactions were performed in this cycle. Signed in as the existing disposable `third` operator to inspect task 2, then restored the admin session. No Start, Decline, Cancel, Pick creation, recovery submission or stocktake action was submitted.

- At 390×844, existing operator task 2 showed Start and Decline next to Combat Boots at horizontal scroll 0. Phone/tablet/desktop checks at widths 390/820/1440 found one Start form, located in the first column, with no page-wide overflow. [Phone actions](usability-cycle-1-evidence/operator-actions-phone.png), [measurements](usability-cycle-1-evidence/task-widths.json).
- Completed task 3 showed Completed, recorded 1 / remaining 0, and Back to My work without an empty reassignment control. Original deadline remains in its details. [Phone result](usability-cycle-1-evidence/completed-phone.png).
- Product search by SKU then a different name retained the chosen Combat Boots at all three widths. A separate prefilled Pick test intentionally switched to Canteen, entered a nonmatching search, and reloaded: Canteen, quantity 2 and preferred Z1-R1-C02 survived. [Width checks](usability-cycle-1-evidence/product-search-widths.json).
- Followed Already moved the stock into recovery and verified Canteen, Z1-R1-C02, quantity 2 and Back to stock `/cells/2`. Opening recovery without context showed blank product and location choices. Inspected the primary form and optional historical details without submitting. [Prefill fields](usability-cycle-1-evidence/recovery-prefill.json), [phone recovery](usability-cycle-1-evidence/recovery-phone.png).
- Typed an unsaved decline note into the new first-column form. The first check exposed a scroll shift when the monitoring notice was updated after scroll restoration. The order was corrected. A repeat check over **35 seconds** retained the exact note, `note` focus, page position **589.5 px** and table scroll **0 px**. The temporary note was cleared without submission. [Before/finding/fixed measurements](usability-cycle-1-evidence/first-column-draft.json).

The preview is left signed in as admin. Responsive viewport overrides were reset. Ordinary preview drafts remain disposable; none are production inventory evidence.

## Automated checks

**186 passed, 0 failed, 0 skipped** in the final full suite. [Test log](usability-cycle-1-evidence/tests.txt). Syntax and diff whitespace checks also passed.

Five new meaningful regressions cover: one set of first-column execution forms and retained manager assignment; completed versus stopped/uncertain eligibility; search retention and explicit recovery choices/prefills; preserving first-column drafts and scroll restoration after the monitoring notice; and independent draft/reference identities with current form values carried into recovery. Existing assignment, partial/unknown movement, offline receipt/replay, count, role, ledger, location setup and firmware tests remain passing.

## Approval and field limits

The previously requested approval for an additional disposable Pick/cancel sequence and stocktake start is still pending. Pending is not approval. Those actions were not retried or bypassed in this cycle. This cycle verifies their rendered controls and automated accounting behavior, not a new browser execution of the blocked flows. The baseline's completed Pick/Finish and duplicate-review evidence remains valid and separate.

Physical Pi/ESP32, serial/RS485, real camera/QR, adjacent-light and warehouse Wi-Fi checks remain pending as recorded in the earlier handoffs. Unrelated `.DS_Store`, assets/deploy/output/tmp and Pi maintenance files remain outside this commit. The coordinator's cycle ledger was not edited.
