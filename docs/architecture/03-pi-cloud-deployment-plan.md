# Pi, cloud access, and company isolation plan

Status: **future design requirements; cloud and multitenancy are not implemented**. Updated 17 September 2026. This document records the next deployment phase, not approval to implement, deploy, change networking, or merge it.

## What exists and what remains

| Capability | Current status |
| --- | --- |
| Local Node service with authoritative SQLite, operator/Admin roles, reservations, cell turns, reconciliation, and hardware adapter | Implemented on the development branch; see [local operations](../LOCAL-FIRST-OPERATIONS.md) |
| Browser offline shell and account/warehouse-scoped reports with stable request IDs | Implemented locally; this is not complete company isolation or cloud synchronization |
| Pi production installation, trusted local HTTPS, real phone/Wi-Fi/hardware acceptance | Deployment and physical acceptance still required |
| Vercel portal, secure Pi relay, durable cloud storage and synchronization | Planned below; unimplemented |
| Shared portal with enforced company isolation, device enrollment and company-scoped administration | Planned below; prerequisite to any multi-company cloud launch |
| Automatic Wi-Fi/mobile-data switching under one hostname | Design and device validation required; hosting the app twice does not provide this |

The local phase already establishes Pi authority and offline reporting semantics. Earlier architecture outlines describe the local application; they do not specify a complete cloud or tenant boundary. This plan adds those requirements explicitly. Existing local test results do not certify the future cloud system.

## Intended application and authority

Use the same application workflows and role permissions through both local and cloud access. On warehouse Wi-Fi, a phone reaches the local Pi, including when the warehouse has no internet. On mobile data or another internet connection, the phone reaches the Vercel portal, which sends authorized requests through a secure relay to that warehouse's Pi.

Each warehouse has one active authoritative Pi for inventory, reservations, cell turns, movement posting, and lights. The cloud maintains authorized read models, request queues, and delivery status; it never becomes a second stock writer. Multiple enrolled devices must not imply multiple simultaneous authorities. Replacement or standby Pi activation requires explicit ownership transfer and fencing of the previous device.

The Pi initiates an authenticated outbound encrypted connection to the relay. Remote browsers never obtain Pi credentials or direct hardware access. Every request still passes Pi business rules and authorization. A cloud acknowledgement of receipt is distinct from a Pi acceptance or committed movement receipt.

| Connection state | Required behavior |
| --- | --- |
| Phone on warehouse Wi-Fi; Pi and internet available | Local Pi handles work; cloud receives committed changes |
| Phone on warehouse Wi-Fi; warehouse internet unavailable | Local login, UI, assets, camera scanning, inventory and hardware workflows continue through Pi |
| Phone on mobile data; Pi reachable through relay | Cloud routes work to Pi; confirmation reflects the Pi's durable result |
| Phone on mobile data; Pi disconnected | Cloud labels readings stale with last authoritative update time and last contact; it cannot confirm stock movements, grant turns, or reserve stock |
| Phone cannot reach either endpoint | Cached work and provisional physical reports follow local offline rules; no new confirmed reservations |
| Internet or phone connection returns | Resume durable delivery and refresh state without repeating physical movements or posting twice |

If enabled, a cloud queue accepts only clearly labelled **unconfirmed requests** while Pi is disconnected. Separate an intent to start work from a report that physical work already occurred. Pending plans require fresh availability, authorization and expiry checks on Pi before acceptance; physical reports retain original evidence and may require supervisor review. No silent late execution of expired/cancelled plans, and no replay of stale light commands after a reconnect. Expose received, awaiting Pi, accepted/rejected, needs review, and committed states distinctly. Cached timestamps are not evidence that stock remains available.

## Company, membership, and device model

The shared portal serves multiple companies. The hierarchy is **company (tenant) → warehouse(s) → enrolled Pi(s)**, with an explicit active authority for each warehouse. Stable company and warehouse identifiers scope every business record, request, event, receipt and device binding. Product and cell identifiers may legitimately collide between companies.

Membership comes from trusted server-side invitation/enrollment and verified acceptance. A submitted company ID, URL, email domain, browser cache, or selectable company name never grants membership. Warehouse access is checked within the authorized company. A person may select only memberships the server has established; roles apply separately within each membership.

Operators retain their existing permissions within their authorized scope. Owners and supervisors use **Admin within their own company only**, subject to warehouse access policy. Company Admin never implies access to other companies. There is no implicit global company-admin role. Any future platform support access would need a separately specified, explicitly granted and audited mechanism.

Enforce company and warehouse authorization at both API and data-access boundaries, including direct calls and guessed object IDs. Apply the same checks to search, reports, exports, downloadable files, logs visible to customers, backup/restore, background jobs, queues, caches, event subscriptions, synchronization and device commands. Scope database lookups, relationships, uniqueness constraints, idempotency keys and storage paths; filtering a page or hiding a menu is insufficient. A role downgrade must affect server execution, not only the UI.

Pi credentials are issued through authenticated enrollment and bound to a company, warehouse, device and enrollment generation. Validate that binding on every connection and message. Use authenticated message integrity, request/event IDs, sequencing and generation checks to reject cross-company messages and stale or malicious replay. Legitimate transport retries may return the original receipt but must not execute again. Revoke/rotate credentials, terminate stale connections and fence former authorities. Device reassignment must not carry old queues, credentials, files, or warehouse data into the new company.

Offline storage and service-worker behavior must be reviewed for the shared portal: partition private data and queues by company, warehouse, user and dataset generation; keep the public shell free of private responses. Logout, company/warehouse changes and session switching must not display another identity's data or submit its queue under the new session. Preserve unresolved reports under their original identity for authorized recovery without exposing them to the next user. Do not put customer-specific authenticated responses in a shared public CDN cache.

Choose and validate one durable cloud isolation model before implementation: a shared database with enforced tenant policies and scoped constraints, or dedicated company databases. Either choice still requires API, storage, event and job isolation. Define scoped backups, restores, migrations and audit access. Migrate the existing local installation into an explicit company and warehouse, mapping users, historical records, receipts and pending reports without assuming a universal default tenant. Back up and validate the migration before connecting it to the shared portal.

Offline membership is a design decision, not an automatic promise of instant revocation. Local authentication must work without cloud availability using securely provisioned local credentials and the last accepted membership policy. Specify offline validity, local administrative revocation, conflict handling, and what happens when a cloud revocation cannot yet reach Pi. Recheck authorization when queued actions execute. Record and test the resulting availability/revocation tradeoff before launch.

## Durable delivery and recovery contract

- Persist the Pi's committed business change and outgoing event atomically. Retain cloud-to-Pi requests durably before acknowledging cloud receipt. Record receiver effects and deduplication receipts atomically before acknowledging completion.
- Carry stable tenant/warehouse, dataset/enrollment generation, request/event ID, original reporter, acting user, operation type and protocol version. Never trust browser-supplied identity or role without server validation.
- Use per-authority event sequencing, durable acknowledged cursors, gap detection and replay. Deduplicate retries; reject ID reuse with a different payload. Handle delayed and reordered messages without overwriting newer state.
- Resume with bounded retry/backoff after disconnects, process restarts or lost acknowledgements. Retry the same logical request ID. Preserve pending reports across browser and relay restarts.
- Rebuild cloud projections from an authorized snapshot plus subsequent events when replay history is insufficient. Dataset restoration or authority transfer must invalidate incompatible old commands and cursors rather than silently merging histories.
- Keep Pi-confirmed receipts distinct from cloud delivery receipts. Reconcile ambiguous outcomes using the original ID before offering another attempt. Preserve immutable physical evidence and route conflicts to review.
- Define retention, queue capacity, expiry, backpressure, encryption, recovery objectives and observability before implementation. Test full queues and unavailable durable storage; never report durable receipt when persistence failed.

The existing local idempotency and browser outbox are foundations for this protocol, not proof that these end-to-end guarantees already exist.

## Same hostname, local independence, and sessions

Prefer one public custom hostname with warehouse-local DNS resolving it to the local service, and public DNS resolving it to the cloud portal. Serve trusted HTTPS with a valid certificate for that hostname on both paths. Certificate provisioning, secure key storage, renewal and outage tolerance require an installation plan. The earlier local-only hostname example is not a finished public-cloud configuration.

Validate this design on the actual supported Android/iPhone browsers and installed app mode. Private/encrypted DNS (DoH), browser and OS DNS caches, existing connections, captive portals and Wi-Fi/mobile-data routing can keep a phone on an unexpected endpoint. A shared hostname alone cannot guarantee immediate seamless switching. Make endpoint/warehouse identity and connection state visible, and provide an understandable retry or fallback path if automatic switching is unreliable. Do not claim success until the switching tests pass.

Define compatible session validation, secure cookies, CSRF/origin checks, app versions and service-worker updates across Pi and cloud. A session or queued report must remain bound to its original company, warehouse and user as the endpoint changes. Reauthentication may be necessary; it must preserve pending evidence and must not broaden permissions. Local DNS returning one warehouse Pi must not expose other companies or accidentally route another warehouse's requests to it; the local service rejects mismatched bindings. The shared portal needs an explicit authorized warehouse selector and an unavailable-state flow for other sites during local outages.

Local login, required scripts/styles/fonts, scanner library, offline shell, DNS and HTTPS serving must not depend on the internet, a cloud login callback or a CDN. Test a fresh supported phone loading and authenticating against Pi while warehouse internet is disconnected, as well as an already cached session. Camera permission and trusted HTTPS remain physical device acceptance items. An uncached phone with no connection to either service cannot be promised a working app.

## Vercel constraints checked for this plan

As checked on 17 September 2026, Vercel Functions support WebSockets in public beta. Connections end at the function duration limit; reconnects can reach another instance, and deployments may overlap. Relay design therefore needs reconnect/resubscription and durable shared state plus routing from each warehouse request to its active Pi connection. In-memory connection maps alone are insufficient. Evaluate Vercel-hosted WebSockets with an appropriate routing/backplane design against an external managed or separately hosted relay before selecting the production topology. See [WebSocket documentation](https://vercel.com/docs/functions/websockets) and the [public beta announcement](https://vercel.com/changelog/websocket-support-is-now-in-public-beta).

Duration limits depend on plan, runtime and configuration, including beta options. Recheck the selected plan during implementation rather than assuming a permanently open socket. See [function limits](https://vercel.com/docs/functions/limitations).

The current file-backed SQLite database remains on persistent Pi storage. Vercel function filesystems do not provide a durable shared SQLite database across instances. Select a durable cloud database for tenant metadata, queues, receipts and read models; evaluate remote database services on their own guarantees. See [Vercel's SQLite guidance](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel).

## Required acceptance evidence

These are future tests, not completed results. Record browser/device versions, deployment versions, topology, timestamps and expected/observed outcomes. Select measurable latency, recovery-time and queue-capacity targets before running the load campaign.

| Scenario | Required evidence |
| --- | --- |
| Local online | Authorized operator/Admin workflows reach the correct Pi; reservations, movements and lights reflect Pi decisions |
| Warehouse internet outage | Fresh local login/assets/camera plus ongoing work function without cloud; local reports remain durable |
| Mobile data, Pi online | Remote requests receive Pi receipts; concurrent local/remote contention respects one stock and turn authority |
| Mobile data, Pi offline | Stale timestamps visible; queued items stay unconfirmed; no new reservation, confirmed movement or hardware success |
| Switch networks mid-task | Test before submit, after submit/before acknowledgement, during scanning and with unsent reports; no lost report, duplicated movement or wrong identity; exercise DNS/DoH/cache and installed app behavior |
| Duplicate/reordered delivery and restarts | Lost acknowledgements, replay, gaps, delays, full queues, relay function expiry, Pi restart and cloud redeploy recover with one business effect and preserved evidence |
| Cloud catch-up | After a sustained outage, replay/snapshot yields Pi-consistent authorized views; stale state remains labelled until caught up |
| Authentication and roles | Login/logout, expiry, role changes, revoked devices and offline membership rules tested on both endpoints; queue execution reauthorized |
| Company A versus B | Colliding item/cell IDs, guessed IDs and direct API requests cannot cross boundaries; test search, reports, exports/files, logs, caches, event subscriptions, queues and remote lights/device commands |
| Device lifecycle and identity switching | Replayed old credentials, wrong tenant/warehouse envelopes, device reassignment, dataset restore, reconnect and browser company/session switches cannot expose or submit another company's data |
| 100-client application load | Simulate 100 concurrent clients with a defined local/remote mix, contention, outages and retry bursts; measure errors/latencies, Pi resource use and queue recovery; verify stock invariants and tenant isolation |
| Physical site acceptance | Separately test real phones, warehouse Wi-Fi coverage/congestion/roaming, camera, trusted certificates, Pi power/restart and real lights/buttons/RS485; simulated client load does not establish Wi-Fi capacity |

Company isolation is a release gate for multi-company cloud launch, not a later optional enhancement. The user performs final physical warehouse acceptance; automated and simulator checks support that decision but do not replace it.

## Open decisions and delivery gates

1. Resolve the cloud database/isolation model, tenant migration, invitation and warehouse membership policies, device enrollment/revocation, and offline permission validity.
2. Choose relay topology, Vercel plan/runtime, durable routing/backplane, authority fencing, protocol versioning, retention and recovery targets. Specify the request/event contracts before implementation.
3. Validate hostname/DNS/HTTPS provisioning, endpoint selection and cross-endpoint session behavior on target phones. Define a visible fallback if seamless switching cannot be assured.
4. Implement the cloud and tenant work in a separately authorized phase; add adversarial, recovery and load tests covering the matrix above. Local release readiness is not cloud readiness.
5. After readiness, assist the user with Vercel and Pi deployment, persistent storage/backups, service startup, credentials, certificates and rollback procedures. No deployment or network changes occur as part of this planning update.
6. Complete user-led physical acceptance and capture outstanding limitations before production launch. Keep branch review and any eventual merge as a separate gate; this plan does not merge or advance baseline branches.
