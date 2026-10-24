# LightGuide company and Pi onboarding plan

Status: **workflow proposal and future implementation requirements; not implemented**. This extends the [Pi/cloud deployment plan](../architecture/03-pi-cloud-deployment-plan.md) and [company-controlled warehouse sharing specification](02-company-warehouse-sharing.md). This update changes documentation only; it does not authorize implementation, deployment, installation, networking changes or merging.

## User requirements versus recommendations

The user requires a shared LightGuide website as the onboarding/download portal: the provider supplies an initial company code; the company registers its first warehouse/Pi, chooses Separate / Groups / All, and downloads a local Pi package that hosts the app and controls warehouse hardware. Later warehouses and Pis join the same company. If a group is omitted, use the company's configured default group. Cross-company isolation and warehouse stock authority remain mandatory.

The invitation design, installer format, detailed screen sequence, status names and security mechanisms below are **design recommendations to validate**, not claims that the user has finalized every choice. In particular, no first-company sharing/visibility default has been approved. Require a deliberate company policy choice and preview; the earlier conservative Separate proposal is not automatic consent.

## Proposed portal journey

1. **Activate company.** The intended first admin opens LightGuide, signs in or creates a verified account, and redeems the provider's initial company invitation/code. Show the company identity before acceptance. Atomically activate the company and its first authorized admin membership; keep provider provisioning distinct from company operational administration.
2. **Choose company policy.** Explain Separate, Groups and All, then collect category scopes, warehouse/user assignments and a company default group. Preview effective visibility and actions. The first-company default group can be created/named here with an explicit policy; its name must not imply company-wide access. Confirm the deliberate choice before activation of sharing.
3. **Register warehouse.** Enter warehouse name and relevant local setup information. Resolve an omitted group to the configured default, show that resolution and resulting access, and confirm. First-time onboarding may present warehouse and first-Pi setup together, while creating distinct warehouse and device records.
4. **Add Pi and download.** For an authorized warehouse, create an enrollment session and download the appropriate versioned installation package plus setup instructions. Present a short-lived device enrollment method separately from the generic package. Show whether this is a new warehouse's first Pi, an additional non-authoritative device or replacement of an existing authority.
5. **Install locally.** An operator installs on the Pi or images its storage, configures its network locally, and starts the installer/enrollment flow. The installer verifies package integrity, checks the supported OS/hardware and persistent storage, then exchanges enrollment credentials over an authenticated connection. Initial enrollment/bootstrap requires internet access in this proposed workflow.
6. **Synchronize and commission.** Download only authorized initial data, provision local login/assets/service startup and trusted local access, and complete hardware/serial mapping and tests. Show checkpoints and actionable errors on both portal and local setup UI.
7. **Ready.** Mark operational readiness only when the defined local installation, scope, authority and hardware checks succeed. Company admins subsequently use **Add Warehouse**, **Add Pi** or **Replace Pi** from their existing authenticated membership; they do not reuse the initial company code.

## Default group is not a sharing mode

The fallback to a company-configured default group is a user requirement. A group and Separate / Groups / All are different concepts. Resolve the fallback server-side within the authenticated company and record the resolved group ID and policy revision; never accept a company/group ID as proof of membership.

| Selected mode | Omitted group behavior |
| --- | --- |
| Separate | Assign the configured default for organization, but Separate overrides group sharing. It grants no cross-warehouse operational visibility or actions. |
| Groups | Resolve to the configured default group and preview exactly which categories, warehouses and assigned users become visible/actionable under its existing grants. Require confirmation before enrollment uses this scope. |
| All | Resolve the administrative group as required, while company-wide sharing follows explicit category/audience policy and warehouse assignments. Group fallback adds no further grant. |

If no valid default exists, pause to have an authorized company admin configure one; do not substitute all warehouses or create a broadly shared group silently. If the default or effective policy changes between preview and confirmation, refresh the preview and require confirmation of changed access. During enrollment use the confirmed policy revision subject to current authorization, and re-evaluate on policy changes; never bootstrap an obsolete broader scope. Additional/overlapping group membership follows the explicit overlap rules in the sharing specification.

## Recommended invitation and device credential lifecycle

Use a single-use, expiring initial company invitation tied to the intended first verified admin. Verification must prove the intended identity, not merely possession of a company name or self-entered email. A stolen code alone must not activate an unrelated user's company membership. Define provider issuance, correction, expiry, revocation and recovery procedures before implementation; do not introduce a reusable company master code or implicitly grant provider staff operational access.

After activation, only authorized company admins with the appropriate warehouse/enrollment permission can issue a fresh single-use, expiring warehouse/device-bound enrollment credential. Recommended signed claims include issuer/audience, company, warehouse, enrollment-session/device binding, nonce/credential ID, allowed purpose, expiry and generation. Validate signature, issuer, audience, scope, expiry and server-side revocation/consumption state; a valid signature alone does not prove the credential is still usable. Rate-limit issuance and redemption, audit outcomes without logging secrets, and allow admins to revoke pending enrollments.

The installer should generate a unique device key locally and prove possession. Bind its public key to the enrollment session through an authenticated pairing/admin confirmation step before activation; finalize that mechanism during security design. Atomically consume the credential and bind the unique device identity, company, warehouse and authority status. Concurrent or repeated redemption cannot create another device identity. A lost response must be recoverable by the same bound device through an authenticated enrollment-status/recovery operation; token reuse must not become a second issuance path.

Signed bearer credentials can still be stolen before use; constrain exposure through short validity, authenticated pairing, masked handling and revocation. The generic installer contains no permanent device credentials, company data, session secrets or reusable company key. Keep temporary credentials out of URLs, analytics, logs and shell history. Store permanent device keys securely on the enrolled Pi; transport and rotate credentials through a separately specified lifecycle.

## Installation and local independence

Recommend a signed, versioned installer for explicitly supported Raspberry Pi OS releases and Pi models/architectures as the first packaging approach. Publish compatible versions, integrity/signature verification instructions and supported upgrade/rollback paths. A pre-imaged SD card or appliance image is a later option with its own secure first-boot identity process. Exact OS/version support, signing-key distribution, update policy and packaging format remain open decisions.

Downloading from a browser does not install a Pi service, image a disk, grant serial access or control hardware. The website must clearly guide the required local installation or disk-imaging action, its target device and any local administrative privileges. Wi-Fi SSID/password are configured locally using the chosen OS/installer procedure; they are neither company identity nor enrollment credentials, and are not uploaded as part of company enrollment.

Before operational Ready, provision persistent local storage, local authentication and role data, all required UI/scanner assets, service startup after reboot, local hostname resolution and trusted HTTPS. Verify operation on a supported phone after disconnecting internet. Configure permitted serial/device access, map warehouse cells/controllers and perform bounded light/button/hardware checks. Simulator completion is distinguishable from real hardware acceptance. Preserve the deployment plan's separate user-led physical acceptance gate.

Initial internet enrollment/bootstrap is an explicit prerequisite of this proposal; an offline enrollment method would be a separately designed future procedure, not an implicit capability of the download. A newly downloaded but unenrolled Pi must report that it needs internet or admin recovery. This does not change the requirement that an already provisioned local warehouse continue through later internet outages under its approved offline policy.

## Provisioning status and recovery

Proposed statuses are **Pending → Awaiting device → Enrolling/syncing → Hardware setup → Ready**, with a visible Paused/Needs attention condition and last successful checkpoint. Keep company invitation status distinct from warehouse/device provisioning. Persist state transitions, attempts, bound identity, policy revision and snapshot cursor so retries resume the same enrollment rather than creating duplicate warehouses or identities.

| Checkpoint | Completion and failure behavior |
| --- | --- |
| Pending | Authorized admin confirms warehouse, mode/group resolution, scope and device intent. No authoritative device is implicitly granted by saving a form. |
| Awaiting device | Installation/enrollment instructions issued; expired/revoked credentials can be replaced through authorized administration without recreating the warehouse. |
| Enrolling/syncing | Verify device binding, install compatible schema, authenticate, and stage a scoped consistent snapshot plus subsequent deltas. Verify completeness before making data active. Interrupted download or lost reply resumes from durable checkpoints. |
| Hardware setup | Confirm local login, hostname/HTTPS, startup, hardware mapping and tests; show failed checks with corrective steps. Do not send arbitrary commissioning commands to a different warehouse. |
| Ready | Correct authority and current accepted scope established, required local checks completed and results recorded. Keep ongoing connection/health state separate: a later internet outage is not a new enrollment. |

Bootstrap only company/warehouse data and shared categories authorized by current policy. Use a consistent snapshot with an event boundary, followed by idempotent ordered delta catch-up; recheck authorization before exposing data. Stage privately, discard/quarantine newly disallowed data on connected devices and record any outstanding cleanup. Never copy another warehouse's physical stock into a fresh warehouse ledger. Shared stock views retain source ownership and timestamps; any legitimate opening balance is a separate attributable inventory procedure.

If the installer finds an existing database or device identity, stop the fresh-install path and offer explicit resume, supported upgrade, migration or restore choices. Do not silently overwrite, reseed, relabel or attach that database to the company in the current browser session. Preview source and target company/warehouse mappings, policy changes, inventory/history and unresolved reports; require authorized confirmation, a backup and compatibility/integrity checks for migration/restore. A failed or interrupted operation retains recoverable original data and checkpoints.

## Multiple Pis, replacement and restored devices

Adding a Pi does not necessarily create a warehouse. The initial supported stock topology remains **one authoritative Pi per warehouse**. An extra controller/non-authoritative device needs an explicitly supported role and restricted credential; do not silently treat it as another inventory writer or claim that every such topology is implemented.

Replace Pi is a distinct workflow: identify the prior authority, preserve its durable ledger and pending evidence, revoke/rotate enrollment and device credentials, transfer authority with a new generation, restore/migrate through verified mappings, and reconcile queued reports under their original identity. Do not erase old queues merely because a new device is installed. Track missing/unrecoverable evidence for review. A clone or restored image must not reuse authority credentials as a second active writer.

Cloud revocation alone cannot stop an offline former Pi from serving local users or hardware. Require proven shutdown/quarantine or a separately approved fencing/lease mechanism before replacement activation; block unsafe promotion when this cannot be established. Credential invalidation at cloud reconnect is necessary but does not establish local physical fencing. Apply the same rule to reinstall, restore and partial enrollment recovery.

## Acceptance cases — future tests

| Case | Required evidence |
| --- | --- |
| First company and later warehouses | Intended verified admin activates exactly one company; later additions use authorized membership and remain in that company. |
| Reused, stolen, expired or revoked credentials | Unintended identity/device, duplicate exchange, wrong audience and revoked/expired code fail safely; rate limits apply; no secrets enter logs/downloads. |
| Omitted group and every mode | Default resolves within the company; effective permissions shown; Separate grants no group access; Groups/All follow the approved category and assignment policy; missing default blocks safely. |
| Wrong tenant/warehouse/group | Forged portal fields, credentials and snapshot/event IDs never change device binding or disclose another scope. |
| Policy changes mid-enrollment | Changed preview, snapshot and delta scopes are revalidated; revoked scope is not exposed; setup resumes only under a valid accepted policy. |
| Interrupted enrollment and reinstall | Lost exchange replies, power failure, download/storage failure and rerun recover the same bound identity/checkpoint without overwriting an existing database. |
| Fresh warehouse versus migration | Fresh warehouse has no copied stock; explicit legacy mapping preserves ledger totals, roles, original IDs, receipts and unresolved evidence. |
| Restore, clone and replacement | Old/new authority cannot operate concurrently; queued data survives; revoked credentials and generations cannot replay old commands. |
| Initially offline and later offline | New unenrolled device clearly waits for initial internet; interrupted bootstrap resumes; enrolled Ready device supports tested local operation without internet. |
| Local readiness | Supported OS, package verification, reboot startup, phone hostname/HTTPS, local login/assets/scanner and actual hardware mapping/tests pass before operational Ready. |

## Open decisions and implementation gate

Confirm the invitation verification/recovery and pairing method; token lifetimes; provider provisioning permissions; package signing/trust and supported OS versions; local installation UX; default-group creation and approval; hardware readiness criteria; staged snapshot/upgrade/rollback details; local HTTPS provisioning; and authority-fencing procedure. All recommended defaults and security UX must be reviewed before implementation rather than silently treated as finalized user choices.

After separate authorization, build on the company/warehouse schema and authorization foundation, then implement invitation/policy preview, device enrollment and installer, scoped resumable bootstrap/migration, local commissioning and safe replacement. Exercise this matrix plus the sharing/deployment matrices before multi-company rollout. This document does not change the existing local release's implementation status.
