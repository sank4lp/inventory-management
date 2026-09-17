# Company-controlled warehouse sharing specification

Status: **required future capability; not implemented or acceptance-tested**. This supplements the [Pi/cloud deployment plan](../architecture/03-pi-cloud-deployment-plan.md). It is a design and implementation specification, not authorization to implement or deploy. Company isolation and company-configurable warehouse sharing block multi-company cloud readiness until designed, implemented and tested.

## Requirements and proposed starting policy

One company may operate multiple warehouses and enrolled Pis. The company must be able to keep warehouses separate, share selected data within explicitly configured groups, or share selected data across all its warehouses. **Cross-company isolation is mandatory and cannot be disabled by any sharing mode.** The hierarchy remains company → warehouse → enrolled Pi, with one active stock authority per warehouse; groups are company-owned policies over warehouses, not new stock owners.

Proposed conservative starting policy, **pending product/company approval**: start in Separate mode, retain explicit user warehouse assignments, and require company-admin opt-in for each shared data category and audience. Neither this default nor detailed retention/offline limits have been approved merely by documenting them. The required capability is company choice among all three modes; a fixed separate-only implementation does not satisfy it.

## Four independent decisions

| Dimension | Contract |
| --- | --- |
| Replication and visibility | Policy specifies which data categories from which warehouses may be replicated to which cloud/Pi destinations, and which assigned users may read them. Replication to a Pi does not make that data public to everyone using the Pi. |
| User actions | Warehouse assignments, role and explicit action grants determine what a user may do at each target warehouse. Read access or shared availability never grants reserve, pick, put, transfer, correct, administer or light-control permission. |
| Physical stock | Every balance, reservation, movement, task allocation and light command retains its physical warehouse identity and its authoritative Pi. A group or company aggregate is a read model, not a pooled ledger. |
| Catalog and configuration ownership | Each shared catalog/configuration object has a declared owning scope, authoritative writer and version. Sharing a catalog does not transfer stock, merge matching product codes, or share device secrets and local calibration. |

Company admins manage sharing centrally within their company, with warehouse assignments and existing operator/Admin permissions visible in the policy editor. Owners and supervisors remain company-scoped Admin; which assigned Admins may change company-wide policy versus only administer assigned warehouses must be explicitly configured. No operator automatically receives access to every warehouse. A company-wide policy manager's administrative visibility must be explicit and audited, not an inferred cross-company privilege.

## Modes and group semantics

| Mode | Replication/visibility eligibility | Actions and stock |
| --- | --- | --- |
| Separate | Warehouse-owned data stays within its warehouse scope, apart from explicitly authorized company administration and required platform processing. No cross-warehouse operational sharing rule is implied. | Assigned roles operate each warehouse independently. |
| Groups | Admin chooses group members, allowed categories, source/recipient warehouses and user audiences. A warehouse may belong to several groups only under an explicitly approved overlap policy. | Each action still needs a grant at the specific target warehouse and its Pi receipt. |
| All | For each enabled category, all warehouses of the company are eligible sources/recipients under the configured policy. User audiences and assignments still constrain access. | No automatic action grant and no merging of ledgers. New-warehouse inclusion must be defined and previewed at onboarding. |

Model explicit grants, not one global `shared` boolean. Each grant identifies company, policy version, category, source scope, recipient scope, user/role audience and permitted operation. For symmetric group sharing the editor may generate grants in both directions; the stored authorization still evaluates the actual source and recipient. Define whether All dynamically includes future warehouses or requires a policy amendment; proposed conservative behavior is explicit onboarding approval, still pending product approval.

For an example company with groups {W1, W2} and {W2, W3}, W1 must not gain W3 data merely through W2. Every object retains its original source warehouse/scope; a replica at W2 cannot be relabelled as W2 data and forwarded. Union across a user's or warehouse's multiple group memberships is allowed only when the overlap policy explicitly approves the precise resulting grants. Without that approval, reject the ambiguous policy change; do not invent a transitive grant or arbitrarily pick one group. Hard tenant boundaries, revocation and explicit deny restrictions take precedence over allow grants. Validate effective access, rather than relying on group names.

For a warehouse-owned read, authorize the authenticated user's company membership, active warehouse context, source-to-recipient sharing grant (or same-warehouse access), category/audience restriction, and read permission. For a mutation, require company membership, assignment and action permission at the target warehouse, valid authority/device binding and Pi business validation. Selection of a readable aggregate never authorizes a mutation. Company/group-owned catalog objects require permission at their owning scope instead of a fabricated physical warehouse.

## Per-category scope

The following is a **proposed initial policy to review**, not an approved universal default. The schema must allow company choices without relaxing mandatory security boundaries.

| Category | Proposed behavior and required semantics |
| --- | --- |
| Product catalog | Start warehouse-owned; explicitly opt into group/company catalogs. Use immutable scoped product IDs, explicit mappings and recorded unit conversions; matching names/SKUs do not silently merge products. Assign one catalog writer/owner and use expected-version checks. Conflicting offline edits become proposals/conflicts, not last-write-wins overwrites. |
| Balances and availability | Share read models only for permitted source warehouses. Include source warehouse, authoritative version and last update per component. Show stale/unknown components in totals; do not label a sum as currently reservable stock. |
| Tasks and audit history | Share only authorized categories and fields, preserving source warehouse, original actor, policy version and immutable evidence. Cross-warehouse visibility does not grant task editing or correction. Separate audit visibility from broader task summaries where needed. |
| Identity and membership | Share only the minimum authorized display/audit identity fields; full user lists and sensitive membership administration require explicit permissions. Password hashes, session tokens and device credentials must never enter generic group replication. |
| Settings and configuration | Explicitly distinguish company/group business templates from warehouse-owned cell mappings, hardware addresses, calibration and local security settings. Define inheritance/version and local overrides before sharing a template; never replicate live device commands as configuration. |
| Files, exports, logs and backups | Apply the originating records' tenant, source and category restrictions to derived artifacts and downloads. Protect logs and backups separately; a group report must not leak excluded warehouse rows, identities or counts. |

Decide catalog authority placement separately from stock authority: a cloud catalog service, or a designated owner Pi, are design options. A single owner with offline edit proposals is the conservative proposal; final ownership and offline edit availability remain open. Local work must retain a usable accepted catalog snapshot while internet is down. Product ownership changes and catalog merges require explicit mapping, provenance and versioned migration; never rewrite historical quantities or original unit evidence.

## Stock authority and cross-warehouse transfers

Sharing aggregate availability does not allow two disconnected Pis to reserve the same units. Pi W1 can commit only W1 ledger effects; Pi W2 can commit only W2 effects. A remote action is pending until the authoritative target Pi durably accepts it. Multi-warehouse allocation, if offered, consists of separately identified warehouse allocations with partial-failure handling; it cannot pretend to be one atomic shared reservation while a Pi is unreachable.

A cross-warehouse movement is a durable transfer, not two unrelated stock edits. Transfers remain within one company for this feature. Define immutable transfer/line/shipment IDs, source and destination warehouse, scoped product mapping, original units/conversions, requested quantity, per-shipment dispatched quantity, per-receipt accepted quantity and attributable evidence. Both ends hold durable linked records with independent idempotent receipts.

| Transfer stage | Authoritative effect and recovery rule |
| --- | --- |
| Requested / source reserved | Source Pi validates actor and quantity and reserves source stock. Destination capacity/acceptance may be required by the final workflow, but cloud receipt alone performs neither ledger effect. |
| Dispatched / in transit | Source Pi atomically records the dispatched amount and source ledger reduction with a durable shipment event. Released unused reservation and remaining lines are explicit. In-transit quantity is tracked separately from either warehouse's available stock. |
| Partially received / received | Destination Pi links each accepted quantity to the shipment and atomically records destination credit plus receipt. Cumulative accepted quantity cannot exceed the authoritative dispatched amount; duplicates return the prior result. Partial, damaged, missing and excess physical quantities remain separately evidenced. |
| Closed / discrepancy / return | Close only reconciled quantities. Resolve shortages or unmatched/excess reports explicitly; a return is a linked reverse physical movement. Before dispatch, cancel/release reservations normally. After dispatch, cancellation cannot recreate source stock automatically. |

If shipment evidence is unavailable at receipt time, capture the physical receipt provisionally for reconciliation; do not create an unverified second credit. Conversely, a source movement performed before successful electronic posting remains physical evidence to reconcile, not permission to repeat shipment. Lost acknowledgements, restarts and reordered source/destination events resume using the same IDs. Preserve goods in transit during interruption; report dispatched, received and unresolved quantities separately. Do not claim an atomic transaction across offline Pis.

Transfers between otherwise separate warehouses must be an explicit company-approved action policy, not a side effect of visibility sharing. Limit shared transfer evidence to authorized participants. Destination acceptance rules, partial shipment/cancellation UX, allowable discrepancies and whether transfers outside groups are permitted remain product decisions.

## Policy versions, migration, and disconnected devices

Persist policy revisions and membership changes transactionally with audit actor, prior/new versions, explicit approved effective grants and an outbox event. Reject updates based on stale versions. Preview added/removed visibility and actions before activation. Use versioned replication subscriptions, cursors and cache authorization metadata so a policy change cannot leave old broad queries active under a new narrow scope.

Prepare snapshots/backfills for newly allowed categories with scoped source identity and resumable checkpoints. On connected services, apply authorization restrictions immediately at policy activation; a backfill must never broaden permissions ahead of activation. Install each Pi's accepted policy and projection changes transactionally, then acknowledge that version. Track per-device applied versions and catch-up state; there is no claim of an atomic fleet-wide cutover during outages. Restarts/retries must not mix tenants, duplicate records or expose a partially migrated scope.

On group removal or device reassignment, stop new delivery, invalidate connected sessions/subscriptions as appropriate, and schedule purge or retention of replicated data under the company's explicit policy. Audit and unresolved physical evidence may need restricted retention. Previously delivered exports, backups and an offline Pi cannot be promised immediate remote erasure. Show outstanding device acknowledgements and residual-data status; re-enrollment into another company requires controlled data/credential removal and verification before activation.

Each company must choose and approve offline permission validity, expiry behavior, locally permitted administration and revocation handling. A disconnected Pi cannot know a new cloud policy immediately. Continuing local work with an accepted cached policy and requiring immediate central revocation are incompatible guarantees during an outage. Expose the accepted policy version/age and limits; do not present delayed revocation as instantaneous. Longer outages and expired permissions need an explicit restricted/manual operating procedure, not an invented default timeout.

Preserve movements performed under an authorized offline policy with original company, warehouse, group context (if relevant), actor, event time, units, request ID and policy version. Reconciliation verifies the evidence and applies/reviews it at the original stock authority without re-attributing it to the new group/company. Policy changes cannot erase real physical history. Pending future intents, in contrast, must be reauthorized before execution and may be rejected. Explicitly distinguish delayed delivery of a Pi-committed movement from a never-authorized queued command.

Enroll devices with company/warehouse bindings, generation and active-authority state; scope all snapshots and replay accordingly. Replacement, restored backup and cloned-device scenarios require authority fencing. Because an offline former Pi may still serve local users and hardware, changing a cloud flag alone cannot fence it. Before activating a replacement, prove the old authority is stopped/quarantined or use an approved lease scheme with understood outage limits; otherwise block promotion. Specify how physical hardware is fenced as well as database writes. Dataset restore increments appropriate generations and reconciles outstanding receipts without replaying old reservations or lights.

For the existing single-company, single-warehouse installation, migrate into explicit company/warehouse/device and policy records while retaining role assignments, balances, reservations, historical IDs and unresolved reports. Do not auto-enroll it into other companies or shared groups. Validate before/after ledger totals and pending work, retain recoverable backups, and exercise rollback without creating a second active writer.

## Proposed schema and service contracts

Logical entities to design early: companies; warehouses; users and company memberships; warehouse assignments/action grants; enrolled devices and authority generations; sharing policies/revisions; groups/memberships; category grants and catalog ownership; scoped products/mappings; warehouse ledgers/reservations; transfers/shipments/receipts; durable requests/events/receipts/cursors; scoped projection checkpoints; audit and purge/retention acknowledgements. Exact database schema remains to be designed, with same-company foreign keys and uniqueness/idempotency constraints enforced at the data boundary.

Policy preview/update APIs return effective read/action changes and require an expected revision. Read APIs and export jobs receive server-derived authorization scope; never accept a browser-supplied group or tenant as authority. Mutation APIs target one warehouse or declared catalog owner and carry stable request IDs. Sync validates credential-bound company/warehouse/device, source ownership, policy revision, authority/dataset generation and allowed replication destinations; receivers reject mismatched messages and handle legitimate retries idempotently. Policy distribution requires authenticated versioned acknowledgements; client timestamps alone cannot establish policy authorization.

## Portal and local UI

Proposed company-admin entry: **Separate / Groups / All**, followed by category controls, warehouse members, user audiences and independent action permissions. Before saving, preview concrete examples of who can see which warehouse's catalog, quantities, tasks and identities, and who can actually perform each action. Show new-warehouse behavior, overlapping grants, affected offline devices, pending backfills and revocation limits. Block ambiguous overlap changes until explicitly resolved.

Both portal and local UI show only authorized warehouse/scope choices, with clearly labelled local versus remote and timestamped data. Remote totals do not replace the current physical work location. A stale remote warehouse cannot become locally actionable through a selector. Hide unavailable configuration controls from operators while enforcing the same rules at APIs. Switching company/group/warehouse preserves pending reports under their original identity and cannot send them in the new context.

## Acceptance matrix — required, not yet run

| Scenario | Required result |
| --- | --- |
| Company A versus B | Identical product/cell/group IDs, direct APIs and forged scopes never cross companies in any mode, including company-admin sessions. |
| Separate | W1 and W2 keep independent operational visibility and ledger ownership; explicitly authorized company administration remains scoped and audited. |
| Selected groups | Members see only allowed categories/sources; outside warehouses and unassigned operators remain excluded; readable data does not grant actions. |
| Overlapping groups | {W1,W2}/{W2,W3} never creates a transitive W1↔W3 grant; ambiguous union is rejected until specifically approved; explicit deny/revocation wins. |
| All-company sharing | Enabled categories reach eligible company warehouses; assignments and action permissions still apply; onboarding follows the selected future-warehouse policy. |
| Offline concurrent picks | Local Pis reserve only their own units; stale shared totals and retries cannot reserve or deduct the same source stock twice. |
| Transfers | Partial dispatch/receipt, lost acknowledgements, duplicate/reordered events, missing shipment evidence, shortages, excess, cancellation and return recover without double debit/credit or lost in-transit evidence. |
| Delayed sync and policy changes | Add/remove groups or category grants during an outage and backfill; accepted-version/expiry rules hold, revoked connected access stops, old physical evidence reconciles under its original identity, future intents are reauthorized. |
| Shared catalog conflicts | Concurrent and offline edits, colliding SKUs, ownership changes and unit edits trigger version/mapping rules and preserve historical quantities. |
| Device lifecycle | Clone, replace, restore and reassign Pi; no second active stock/hardware authority, cross-company replay or accidental replay of old commands. |
| Derived surfaces and session switching | Search, aggregate counts, exports, files, logs, backups, caches, events and browser queues obey category/source/user scopes before and after switching or revocation. |
| Migration | One-company/one-warehouse upgrade preserves balances, reservations, IDs, receipts and pending evidence; interrupted migration/rollback remains recoverable and isolated. |

Run these alongside the deployment plan's outage, phone switching, 100-client application load and separate physical warehouse tests. Company-configurable segregation remains a launch blocker until all required modes and failure cases pass.

## Decisions to resolve before implementation

1. Approve the initial Separate/category defaults; specify company-policy-admin versus warehouse-admin assignments and operator action grants.
2. Define category audiences, directed/symmetric group grants, overlap approval and deny precedence, plus inclusion of future warehouses in All mode.
3. Choose catalog/configuration ownership, writer placement, inheritance/override rules, unit mapping and conflict handling.
4. Approve offline validity/expiry, local revocation, retention/purge/export policies and the operational procedure when devices cannot acknowledge a change.
5. Specify transfer authorization outside groups, destination acceptance, partial/discrepancy resolution and in-transit recovery.
6. Finalize schema/storage isolation, transaction boundaries for migration/backfill, policy revision protocol, authority fencing/leases and replacement evidence.

Implementation order after separate authorization: tenant/warehouse schema and authorization foundation → compatible local migration → policy preview/versioning and all three modes → catalog ownership and scoped replication → durable transfers and device lifecycle recovery → adversarial/offline/load testing → assisted deployment and user-led physical acceptance. Complete these gates before shared multi-company cloud launch; this documentation update performs none of those implementation or deployment steps.
