# Local-first multi-operator release

The warehouse Node service and SQLite database are the authority. This release has no cloud relay, remote synchronization service, or automatic Wi-Fi/mobile-data routing. Desktop, Android browsers and iPhone browsers use the same responsive application and role permissions. Supervisors and owners use the existing Admin role.

## Operating flow

1. Pick / Put reserves the full planned quantity atomically, without taking a light or cell turn.
2. At the cell, scan its printed QR or type its logical code. The first valid arrival obtains an exclusive turn. A busy cell is not overwritten. Shared-consumable cells have independent quantity holds and neutral locator guidance; the phone gives the action and quantity.
3. Confirm the actual for each cell, including explicit zero when nothing moved. Blank is not zero. A partial confirmation releases only that allocation's unused hold. Other allocations remain independent.
4. Correct an earlier record from the settled allocation, even while other cells remain open. A physical return is a new movement, not a correction.
5. An unstarted put allocation can be replanned. The old allocation remains auditable; an old screen's actual report cannot post the replacement plan's quantity.

Historical correction quantities retain their original unit. Stock deltas use the recorded conversion chain and the net difference, rather than reversing the full original movement.

## Connectivity and recovery

The public offline shell and own cached work use a service worker and IndexedDB. Actual reports are saved before transmission, under a stable request ID and the signed-in account/warehouse identity. Plans and supervisor actions also retain their request IDs across lost responses. A received report may still need review; “saved on this device” does not mean stock was posted. Account changes never send the previous account's queue under the new account.

During a disconnect, continue only known preallocated work under the warehouse's manual procedure. No new exclusive turn is granted offline. Unreserved work can be recorded as a provisional completed-movement report. Reconnect, return to the app, or press Send saved reports / refresh. Do not repeat the physical movement. If device storage fails, the interface does not claim that a report was saved.

All unresolved situations go to Pending confirmations. Restart and inactivity preserve reservations and create verification cases; they never silently cancel or assume zero. Admin enters a verified actual, records how it was verified, or keeps the case open. Known performer, reporter, resolver, source reference and original reports remain separate evidence. A later conflicting phone report becomes a review case and can be reconciled as a net correction without posting the movement twice.

A dead phone can be replaced to view the task and report known work; a new device cannot simply take over an uncertain exclusive turn. Admin resolves its prefilled allocation. A count while work continues is an observation, not a balance replacement. Review the movement history before making a separately verified correction. Verified actuals that exceed book stock or capacity remain visible as discrepancies; other reservations are not silently reduced.

For work that begins without any usable device, use a numbered movement slip:

| Original reference | Time | Performer (or unknown) | Pick / put / count | Product | Cell | Actual quantity + unit | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

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

All 105 automated tests pass. They cover reservations, per-cell actuals, duplicate/lost-response retry, first-arrival locking, shared cells, partial redistribution, supervisor shortages, stale plans, restart, account revocation, unit-aware/net corrections, transaction rollback, ledger reporting, QR encoding/decoding and hardware command guards.

An isolated simulator preview was exercised with two separate operator browser sessions and an Admin session. Browser checks included typed location arrival, busy feedback, partial actual, server outage, saved queue surviving offline reload, supervisor resolution, explicit zero, keep-pending and put replanning. Rendered mobile (320 and 390 px) and desktop (1440 px) screens were inspected.

Real phone camera scanning, iPhone/Android home-screen installation, warehouse roaming, real RS485 delivery and physical power-loss behavior still require site acceptance. QR decoder round-trip and typed-code tests are not camera tests.
