# Local-first multi-operator release

The warehouse Node service and SQLite database are the authority. This release has no cloud relay, remote synchronization service, or automatic Wi-Fi/mobile-data routing. Desktop, Android browsers and iPhone browsers use the same responsive application and role permissions. Supervisors and owners use the existing Admin role.

The [Pi/cloud and company isolation plan](architecture/03-pi-cloud-deployment-plan.md) specifies the future shared portal, remote relay, offline boundaries and acceptance gates. These are unimplemented requirements. Existing account/warehouse browser separation is not complete cloud multitenancy; future owners and supervisors are Admin only within their own company.

## Operating flow

1. Pick / Put reserves the full planned quantity atomically, without taking a light or cell turn.
2. At the cell, scan its printed QR or type its logical code. The first valid arrival obtains an exclusive turn. A busy cell is not overwritten. Shared-consumable cells have independent quantity holds and neutral locator guidance; the phone gives the action and quantity.
3. Confirm the actual for each cell, including explicit zero when nothing moved. Blank is not zero. A partial confirmation releases only that allocation's unused hold. Other allocations remain independent.
4. Correct an earlier record from the settled allocation, even while other cells remain open. A physical return is a new movement, not a correction.
5. An unstarted put allocation can be replanned. The old allocation remains auditable; an old screen's actual report cannot post the replacement plan's quantity.

Historical correction quantities retain their original unit. Stock deltas use the recorded conversion chain and the net difference, rather than reversing the full original movement.

## Connectivity and recovery

The public offline shell and own cached work use a service worker and IndexedDB. Actual reports are saved before transmission, under a stable request ID and the signed-in account/warehouse identity. Plans and supervisor actions also retain their request IDs across lost responses. A received report may still need review; “saved on this device” does not mean stock was posted. Account changes never send the previous account's queue under the new account.

During a disconnect, continue saved allocations or record new physical work provisionally under the warehouse's manual procedure. Offline Pick and Put open completed-movement capture; they do not reserve stock or grant a new exclusive turn. A generated original reference stays with the draft until it is saved; reuse that reference on any paper record. Unreserved work is received for supervisor verification. Reconnect, return to the app, or press Send saved reports / refresh. Do not repeat the physical movement. If device storage fails, the interface does not claim that a report was saved.

All unresolved situations go to Pending confirmations. Restart and inactivity preserve reservations and create verification cases; they never silently cancel or assume zero. Admin enters a verified actual, records how it was verified, or keeps the case open. Admin selects a verified performer from existing accounts (including inactive historical accounts), or explicitly leaves the performer unknown. Operators can report only their own performance. Known performer, authenticated reporter, resolver, source reference and original reports remain separate evidence; a supervisor verification creates a new report without relabeling the original. Linking an open allocation to a previously posted movement requires an explicit confirmation that it fully accounts for that allocation. The link closes only its own reservation and turn without posting stock again; corrections must target the original movement. A later conflicting phone report becomes a review case and can be reconciled as a net correction without posting the movement twice.

A dead phone can be replaced to view the task and report known work; a new device cannot simply take over an uncertain exclusive turn. Admin resolves its prefilled allocation. A count while work continues is an observation, not a balance replacement. Review the movement history before making a separately verified correction. Verified actuals that exceed book stock or capacity remain visible as discrepancies; other reservations are not silently reduced.

For work that begins without any usable device, use a numbered movement slip:

| Original reference | Time | Performer (or unknown) | Pick / put / count | Product | Cell | Actual quantity + unit | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

For an older unreserved movement, enter its original unit and time. The supervisor sees the recorded conversion factor and explicitly verifies the current-unit accounting quantity. If reliable conversion history is unavailable or exceeds supported precision, the supervisor must establish the current-unit quantity from evidence and record its provenance. Original quantities, units and references remain intact. Quantities support up to six decimal places; verified shortages retain other claims and create discrepancies.

Enter the **same original reference** in Record completed movement when a device is available. Existing references prevent repeat posting. Ordinary phone disconnections do not require slips.

## Isolated development preview

Run `npm run preview` (or `PREVIEW_PORT=3211 npm run preview`) from the repository. It creates a new temporary data directory, forces simulator hardware, and prints its local URL. Demo accounts are `admin/admin123` and `operator/operator123`. This launcher never points the service at the repository’s warehouse data.

## Local deployment

Use a current Node runtime supporting `node:sqlite`, install with `npm ci`, and run one application process with persistent local storage. Back up before first deployment. Schema changes are additive; unfinished older tasks move to explicit verification. Never run the development fixture seeds on a production database.

Expose the Pi through a warehouse hostname and a trusted HTTPS endpoint. The local DNS/router must continue resolving it when the internet is down. Camera access, service-worker installation and offline reload require a secure context: localhost works for development; an ordinary HTTP LAN IP is not enough for phone camera/offline installation. Provision a certificate trusted by the actual phones through the site's managed certificate process. Do not bypass certificate warnings.

Example reverse-proxy shape (use the site's hostname and trusted certificate paths):

```caddyfile
warehouse.example.internal {
    tls /etc/warehouse/tls/cert.pem /etc/warehouse/tls/key.pem
    reverse_proxy 127.0.0.1:3000
}
```

Use production authentication configuration and unique administrator credentials. Restrict the service to the warehouse network; cloud/public internet access is outside this release. Account deactivation revokes old sessions even if the account is later reactivated. POST authentication is checked after the body has arrived, and work commands check the account again inside the transaction.

## Hardware and maintenance

Use one application writer for an RS485 port. The adapter has an exclusive process lock and disposal of old timers/descriptors. Guidance intents have generations so superseded commands cannot clear newer work. Utility displays/tests are paused during active work. Ambiguous physical mappings fail into manual guidance. Changing mappings, units, capacity, deleting affected records, adjustments and moves are guarded while relevant work is unresolved. Firmware maintenance prevents new plans/arrivals while running.

Phone actuals are authoritative. A successful book receipt is independent of hardware delivery. The simulator is useful for software verification and is not proof of delivery to physical LEDs. Validate real controllers, power failure and stale-display behavior before using the system operationally.

## Backups, restore and retention

Normal backup creation remains available. Live restore is intentionally unavailable once multi-operator evidence exists. Business-history archival retains workflow evidence and idempotency receipts during this pilot; ordinary operational logs retain their existing policy.

For disaster recovery: stop the service and hardware writer, preserve the current database/WAL and every unreceived device queue, and restore only into an isolated validation directory first. Reconcile the ledger and unresolved physical work. Before reconnecting clients to a restored database, rotate `dataset_generation` and invalidate existing sessions; retain `warehouse_identity` only for the same warehouse. Earlier queued reports must enter review, never fresh automatic execution. A qualified administrator must verify identities and missing allocations rather than reusing task numbers blindly. There is no one-click live recovery promise in this pilot.

## Validation boundary

All 115 automated tests pass. They cover reservations, per-cell actuals, duplicate/lost-response retry, first-arrival locking, shared cells, partial redistribution, supervisor shortages, stale plans, restart, account revocation, unit-aware/net corrections, transaction rollback, ledger reporting, QR encoding/decoding and hardware command guards.

An isolated simulator preview was exercised with two separate operator browser sessions and an Admin session. Browser checks included typed location arrival, busy feedback, partial actual, server outage, saved queue surviving offline reload, supervisor resolution, explicit zero, keep-pending and put replanning. Rendered mobile (320 and 390 px) and desktop (1440 px) screens were inspected.

Real phone camera scanning, iPhone/Android home-screen installation, warehouse roaming, real RS485 delivery and physical power-loss behavior still require site acceptance. QR decoder round-trip and typed-code tests are not camera tests.


Additional recovery validation covered fractional historical-unit manual reports, unsupported mappings with explicit provenance, immutable original attribution, inactive performers, operator impersonation rejection, stale compatibility HTTP forms and wrong-warehouse receipt replay. Browser testing kept a saved report pending across a warehouse-identity change and same-browser account switch, then recovered it under the originating account and warehouse. A rendered supervisor flow verified the original and accounting quantities and selected performer.

Retained mobile screens checked include product search/detail/settings, location search/detail, reports and time filters, configuration/controller health/location management, admin settings and task detail/correction access. A completed legacy zero-quantity task was viewed and corrected on phone; the display and edit form preserve zero instead of substituting the original plan. Demo-only product capacity, location rename, timeout save and simulator health actions succeeded. Operator navigation and reports/location/own-task access were checked separately. A catalog grid overflow was corrected; wide data tables remain contained horizontal scrollers. These are browser checks, not physical phone installation/camera or controller acceptance.

Final integration validation passed all 115 tests, including explicit duplicate-allocation closure with independent reservations, inactivity clear delivery/retry, preservation of a newer exclusive turn and continued shared locator guidance. The bounded reviewer repair phase also exercised offline capture, reload and reconciliation in a disposable simulator. The preserved main preview was restarted on the final implementation and its connected inbox and movement forms were checked.
