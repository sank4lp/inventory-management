# Inventory Management Documentation

This folder contains the working documentation set for the warehouse inventory system.

The current goal is to document the product clearly enough that you can:
- design and build the software in an iterative way,
- align hardware and software decisions early,
- hand individual documents to vendors, collaborators, or future developers,
- expand the system later without losing context.

## Current project baseline

- Warehouse layout: **27 columns × 3 rows = 81 cells**
- Operator station: **at the warehouse entry**
- Primary user actions: **Pick** and **Put**
- Runtime environment: **Linux on Raspberry Pi**
- Development environment: **macOS**
- Source control: **GitHub**
- Hardware guidance: **cell lights + software UI**
- Cell hardware baseline: **RGB light + button per cell**

## Recommended reading order

1. `01-product-overview.md`
2. `02-software-overview.md`
3. `03-software-flow-overview.md`
4. `flows/`
5. `hardware/`
6. `architecture/01-software-architecture-outline.md`
7. `tech-spec/01-software-tech-spec-outline.md`

## Document map

| File | Purpose |
| --- | --- |
| `01-product-overview.md` | Product scope, warehouse model, actors, goals, assumptions |
| `02-software-overview.md` | High-level software capabilities, modules, domain model, platform assumptions |
| `03-software-flow-overview.md` | Master flow catalog and shared flow rules |
| `flows/01-authentication-and-registration.md` | Registration, login, roles, access control |
| `flows/02-pick-flow.md` | Pick workflow, task allocation, confirmations, exceptions |
| `flows/03-put-flow.md` | Put-away workflow, item creation/search, location assignment, confirmation |
| `flows/04-admin-flow.md` | Admin permissions, user control, data corrections, system settings |
| `flows/05-product-catalog-flow.md` | Product master creation and management |
| `flows/06-analytics-flow.md` | Reporting and analytics flows |
| `flows/07-device-onboarding-and-zone-management.md` | Zone/controller onboarding and controller management |
| `flows/08-cell-mapping-and-commissioning.md` | Physical-to-logical cell mapping and test workflow |
| `hardware/01-hardware-overview.md` | Hardware topology, component placement, connectivity summary |
| `hardware/02-esp32-zone-controller.md` | ESP32 block responsibilities and connection outline |
| `architecture/01-software-architecture-outline.md` | Proposed software architecture direction |
| `tech-spec/01-software-tech-spec-outline.md` | Detailed spec template and decision backlog |

## Documentation principles

- Prefer **task-driven workflows** over free-form inventory edits.
- Treat the **screen as the quantity/source-of-truth interface**.
- Treat **lights as location guidance** and **buttons as physical confirmations**.
- Keep **audit trails immutable**; corrections should create adjustment records.
- Separate **logical cell IDs** from **physical wiring addresses**.
- Keep all docs in Markdown so they are easy to version in Git.

## Open topics for the next iteration

These documents are a strong starting draft, but several decisions are intentionally left open:

- final technology stack for frontend/backend/database,
- exact item/product data fields and validation rules,
- detailed confirmation UX between rack buttons and the mandatory final review screen,
- detailed allocation strategy for multi-cell picks and multi-cell put-away,
- offline/recovery behavior when hardware fails mid-task,
- final device protocol between Raspberry Pi and ESP32 blocks,
- exact analytics/report formats needed by management.

## Recently confirmed decisions

- Every task should end with a **final review / confirmation screen**.
- Pick tasks should light **all allocated cells at once**.
- Reports are **required at launch**, not deferred.
- Placement logic should remain **modular and replaceable**, so it can evolve without forcing changes across the whole system.
- Initial placement behavior can start with **closest available cell first**, using logical location order.
- Reports should support **custom timeframes** and **printing**, which introduces a printer into the hardware setup.
- A future placement strategy should support **grouping similar items in nearby cells** so related stock stays physically close together.
- The initial printed report set at launch can be the same four core reports already identified in the docs.
- Products should store an **items per cell** value that admins can edit later.
- Inventory is tracked as actual quantity in cells only; the current software does **not** use a reservation layer.
- The software should allow **mixed-product cells** and **over-capacity cells** when that is what actually happened, then highlight them for follow-up.
- The home screen should include **recommended actions** to help users clean up flagged cells.
- Search and picker controls should be **software-rendered**, not dependent on OS-native widgets.
- Reports should support quick presets from **last 1 hour** through **previous month**, plus custom datetime ranges that update all report sections consistently.

## Suggested next authoring order

1. Refine the **pick flow** and **put flow** first.
2. Lock the **software architecture direction**.
3. Convert the architecture outline into a real **technical specification**.
4. Expand the **hardware docs** only after the software-side workflows are agreed.
