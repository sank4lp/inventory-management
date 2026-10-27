# Phase 2 stocktaking, navigation and location setup handoff

**Ready for Phase 3: YES — local software and simulator acceptance complete.**

Date: 28 September 2026. Branch: `public-product-development`. Baseline: `c9dea86` (completed Phase 1 handoff), verified as an ancestor. Work was performed only after the Phase 1 writer completed. No release branch, merge, push, physical controller or production database was changed.

Inputs: the integrated LightGuide UX/navigation plan, especially sections 3–5, 11, 19 and 20; its baseline feature map; and `docs/phase-1-workflows-handoff.md`. Delivery followed 2A stocktaking, 2B navigation/display coordination, then 2C commissioning. This is an internal development record. Customer instructions are in [warehouse-guide.md](warehouse-guide.md).

## Completed behavior

### Stocktaking

- Dedicated primary area owns schedule, persisted due runs, assignment, counting, difference review and results. Locations, Work tools, reminders and Reports lead into the same resources. Location-origin counting retains a Back link.
- Weekly, monthly and custom cadence; explicit first/next date and warehouse timezone; monthly calendar anchor with short-month handling; next-date preview; pause affects future occurrences. Restart deduplication and one active scheduled occurrence prevent duplicate campaigns. Missed dates remain visible through the overdue run instead of creating a pile of assignments.
- Whole-warehouse or selected scope includes empty and manual locations, with searchable configured descriptions. Scope snapshots, explicit additions/exclusions, due-date changes, assignment generations, handback and incomplete closure are retained. Counts create no Pick/Put reservations.
- Each identified location gets a fresh immutable baseline: physical book/on-shelf balances, original units, balance version, ledger boundary, reservations and unresolved work. Actual quantities start blank; explicit zero, extra catalog products, unknown goods and mixed products remain distinct. Matching counts retain evidence without a movement.
- Review distinguishes counter explanation and verified reason. Approval requires evidence, authority and a stable baseline inside an immediate transaction. A six/five count posts minus one once; duplicates or concurrent stale review cannot repeat it. Changed stock/work requires recheck. Recount keeps earlier evidence; linking posted movements makes no second stock change.
- Expired/damaged goods still present remain in physical totals. A controlled-review flag prevents fresh allocation/acquisition at that location and retains actual work for review. Release requires verified disposition/usability evidence and resolved issued work, then a fresh count. There is no automatic disposal, expiry detection or invented write-off.
- Late physical reports and corrections to earlier settled work are checked against count settlements. An exact product/unit/direction/delta link can account for the movement without reposting it; separate later work requires explicit verification. Original reports and ledger entries remain intact.
- Account/warehouse-partitioned cached counts, drafts and immutable request IDs survive reload and reconnect. Per-request durable storage prevents one stale tab from erasing another tab's queue. A request added while refresh runs is drained through the same receipt flow. Rejected evidence remains available; export preserves the original payload.
- Non-blocking badges count actionable runs. Submitted counts stop demanding action from their counter while authorized reviewers retain their own pending status. Offline status is marked stale. No email, push or assistant automation was created.
- Results expose coverage, original difference/units, counter/time, review evidence and correction/movement references. Adjustment Audit links back to originating observations. Shared results filters/print never post stock or add incompatible units.

### Navigation and display coordination

Five primary areas: Work, Products, Locations, Stocktaking, Reports. Settings is separate for administrators; account/profile/device help are separate utilities. Mobile Menu retains keyboard/focus behavior.

| Baseline feature area | Retained destination / change |
| --- | --- |
| My Work | Work → My work, assigned instructions, saved receipt/device recovery tools |
| Pending Confirmations | Work → Needs review, including count-correction overlap checks |
| Overview | Work → Overview / Team work; warehouse overview and space suggestions remain in Work tools |
| Pick | Work entry points and product/location contextual actions; same execution commands |
| Put | Work entry points and contextual actions; same arrival, actuals, replan and correction paths |
| Products | Catalog category filters, printable lists, search, details, capacity/product administration and scoped quantity displays |
| Locations | Daily browse/search/filter, contents, read-only QR lookup, Pick/Put/Check stock, locator/quantity actions; technical details secondary |
| Reporting | All eight existing reports retained in Stock/Operations/Checks, plus shared Stocktake differences; report appearance has one canonical editor |
| Configuration | Settings → Hardware retains controller health, firmware, setup/mapping; Locations → Manage and Location setup add commissioning |
| Backups | Settings → Backups & recovery retains creation, restore, schedule, retention and compaction |
| Admin | Settings → People & access, System, Product fields & units; unsafe baseline-free count form replaced by guarded Stocktaking |
| Profile | Account → Profile; admin user profiles and activity/task links retained |

Quantity UI distinguishes on shelf, reserved and available to pick. Product, location and entire-warehouse scope is explicit. Mixed, fractional, oversized and uncertain quantities never become a misleading summed LED number. Exact values remain on the phone.

Utility displays have persisted owner, scope, fingerprint, targets, controller/binding snapshots and a two-minute lifetime. Retry retrieves the same receipt without replaying old commands. Only the owner may stop it. Active Work guidance has priority; delayed clears cannot erase a changed mapping or newer work generation. Mapping changes wait for active utility displays to finish. UI refreshes status and keeps uncertain network responses explicit.

Recommendations still show editable suggestions, targets and green/red preview guidance, but actual picked and put quantities are separate blank inputs. Partial/interrupted results are retained for review through the existing movement service. Neither a suggestion nor an LED command posts stock. This intentionally supersedes the old direct Apply behavior.

### Location setup

- Reuses stable location IDs, field definitions/values, label registry, description revisions and binding revisions introduced by Phase 1.
- Admin field editor supports labels, text/number/select, options, required/enabled, ordering and use in travel directions. Stable field keys preserve old values and issued descriptions. Missing newly required values are flagged without disabling safe existing operations.
- Controller preparation, unique unbound QR batches, label enrollment/replacement/revocation, a separate manual-location path, and readable location/detail editing are available in one setup workspace.
- Persisted owner/controller/generation sessions select declared outputs. Light first, identify the sticker, fill fields, explicitly confirm the physical check, then bind atomically and advance. Existing location stock/history stays on the same identity.
- Duplicate/wrong/revoked labels, stale generations/field definitions, changed controller configuration, concurrent ownership and outstanding Work all fail safely. Skip/retry, previous output, re-light, edit, continue later, close and draft recovery are supported. Only physically confirmed, received bindings count as verified.

## Compatibility and persistence contracts

Schema is **8**. New tables: `stocktake_schedules`, `stocktake_runs`, `stocktake_items`, `stocktake_attempts`, `stocktake_observations`, `stocktake_settlements`, `stocktake_events`, `stocktake_receipts`, `stocktake_cell_versions`, `stocktake_condition_reviews`, `stocktake_movement_links`, `display_requests`, `location_setup_sessions`, `location_setup_events`, `location_setup_receipts`. Balance-version triggers detect intervening changes. An additive `accounted_delta` migration supports partial late corrections. Historical setup controller references are retained independently of later controller deletion.

Stocktaking mutations use `/api/stocktaking/:action`; commissioning uses `/api/location-setup/:action`; display requests use `/api/displays/start`, `/status`, `/stop`. Commands validate current account/role, site/dataset where applicable, immutable fingerprint receipt and relevant generation/revision. Never recreate saved evidence under a new identity. Review is admin-only by default; counting and execution remain separate authorities.

Existing Work IndexedDB `lytguide-work` version 1, its cache/outbox stores, frozen report payloads and account partitions remain unchanged. Service-worker cache is v8 and includes the count offline shell/assets. It does not clear Work evidence. Stocktake storage is `lightguide-stocktaking-v1` plus `lightguide-stocktake-request:<site>:<user>:<id>` durable entries. Setup drafts are account/site/session-generation scoped. Guidance, receipts and snapshots remain local to the warehouse.

Legacy old clear requests without ownership receipts fail safely. Old `/admin` anchors route to their new canonical destinations. Old baseline-free adjustment submission fails with a Stocktaking link/instruction. Low-level historical service helpers remain for compatibility; the HTTP workflow cannot use them to bypass current count review.

## Final Phase 1 compatibility audit

Reviewed the complete baseline diff, especially Work execution/review, setup guards, hardware dispatch, inventory writes, navigation, report rendering and offline assets. No Phase 1 schema, assignment history, actor attribution, deadline contract, exclusive/shared turn, QR/manual Finish boundary, work outbox or frozen command identity was removed. New count-boundary/controlled-condition checks retain evidence for review instead of discarding or silently settling it. Count-based late correction updates task progress after the settled actual changes.

All Phase 1-specific operation, assignment, flow, client reliability and UI tests are unchanged and run in the full suite. Legacy presentation/utility tests were updated where the approved interface changed: receipt ownership replaces metadata/URL flags, canonical report settings replace duplicated controls, guarded counting replaces the unsafe adjustment form, and recommendation actuals replace direct plan posting. Exact balances, scope, units, numeric/locator behavior, receipt replay and mapping protection have additional assertions.

## Verification

- **155 tests passed, 0 failed**, full `npm test`; final log: [automated-tests.txt](phase-2-evidence/automated-tests.txt).
- `git diff --check` clean; `c9dea86` is an ancestor; branch remains `public-product-development`.
- Service/client cases include six/six; six/five exactly once; excess/zero/blank; mixed/unknown/condition goods; reservations and movements during counting; late reports and settled corrections; recount/incomplete closure; monthly restart; assignment races; stale-tab receipt recovery; atomic pairing, duplicate labels, required fields, controller revision; display ownership/expiry/newer guidance; exact scoped balances and partial recommendation actuals.
- Isolated browser count: identified demo location, recorded 3 → 2 pairs, approved Unknown with independent-check evidence, verified reconciled results and one linked correction. Subsequent Pick 1 and Put 1 both completed through arrival → manual actual summary → explicit Finish, retaining directions and performer/reporter attribution. No real goods moved.
- Browser setup: lit output 1 in simulator, entered its existing unique sticker and readable name/directions, confirmed the simulated check, saved atomically; progressed to output 2 with 1/27 verified. This is software evidence only, not physical commissioning.
- Browser quantities: selected one location/product, showed exact on-shelf/reserved/available 2/0/2, received 1 numeric display, stopped only its owned request.
- Final responsive sweep: **33 screen/viewport checks**, all document widths fit. Phone 320, rotated 844×390, tablet 820×1180, desktop 1440×900 and wide 3840×2160. Main flows plus Settings/People/System/Hardware/Backups/Profile were covered. See [responsive-checks.json](phase-2-evidence/responsive-checks.json). Temporary viewport overrides reset.
- Customer terminology audit: rendered screens and product source contain no delivery-phase numbering in user copy. Existing matches are internal comments/logger identifiers only. README and the customer warehouse guide use feature names. Count print/results, labels, export name, reminders, errors and status text were inspected. Internal plans/tests/handoffs deliberately retain development terminology.
- Browser error log has no errors after the repaired earlier `params` reference; the historical pre-fix entry is not a current failure. Camera access was not granted; manual fallback worked. Mobile focus/Escape behavior remains covered by the unchanged client suite. This does not certify real-device zoom/camera behavior.

Screenshots: [approved count](phase-2-evidence/stocktake-approved.png), [Pick receipt](phase-2-evidence/work-pick-receipt.png), [Put receipt](phase-2-evidence/work-put-receipt.png), [setup progress](phase-2-evidence/tablet-location-setup.png), [phone quantity display](phase-2-evidence/phone-quantity-display.png), [phone catalog](phase-2-evidence/phone-products.png).

## Preview, exclusions and next acceptance

Preview: `http://127.0.0.1:3212`, isolated simulator and demo database under `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-oQEdmX`. It is left running for review. Existing previews 3210/3211 were not changed. Automated fixtures use temporary databases. The browser's first Put submission was blocked by automatic approval review; after verifying disposable fixture/simulator evidence, the same action was approved and completed. No action remains blocked.

Unrelated `.DS_Store`, `assets/`, `deploy/`, `output/`, `tmp/`, Pi recovery documentation/scripts and `test/pi-healthcheck.test.js` remain outside this implementation commit.

Phase 4 still owns actual Pi/tablet camera permissions and focus, QR print readability/sticker placement, physical output/color/value mapping, serial acknowledgements, power/restart behavior and warehouse-network acceptance. Phase 5 still owns concurrent warehouse pilot/scale and hardware-failure exercises. Simulator dispatch must never be presented as proof that a real lamp was observed or stock physically moved. No network, certificate, firewall, provisioning or firmware deployment was performed here.
