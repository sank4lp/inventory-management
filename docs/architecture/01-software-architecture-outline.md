# Software Architecture Outline

## Purpose

This document describes the software architecture that matches the current phase-1 implementation direction.

## Recommended architecture style

For phase 1, use a **local-first modular monolith**.

This means:
- one deployable application stack running locally on Raspberry Pi,
- clear internal separation of concerns,
- no need to introduce distributed services too early,
- ability to grow into a more modular system later.

This means the codebase should stay modular enough to evolve later without making the first release harder than necessary.

## Recommended high-level modules

### 1. UI / Kiosk module
Responsibilities:
- login and registration screens
- home screen
- pick/put flows
- reports and admin screens
- device and mapping screens
- product detail, cell detail, and recommended actions screens
- software-rendered comboboxes and live search behavior
- split page-rendering code by feature/domain where practical, with shared helper files for reusable UI pieces

### 2. Application / Domain module
Responsibilities:
- enforce business rules
- create pick/put tasks
- allocate cells
- validate corrections
- coordinate workflow state
- control task edit permissions for owner-or-admin correction mode

### 3. Inventory module
Responsibilities:
- maintain available balances
- apply transactions
- expose inventory queries
- detect mixed-product cells and over-capacity cells

### 4. Allocation and placement strategy module
Responsibilities:
- compute pick allocations across cells
- compute put-away cell recommendations
- allow strategy replacement later without rewriting the rest of the application
- support both closest-cell-first and future nearby-cluster strategies for similar items
- reuse partially filled same-product cells before opening new cells
- honor the current product `items per cell` value at the moment a new put is planned

### 5. Product catalog module
Responsibilities:
- manage product master data
- search/filter products
- validate product metadata
- expose product-to-cell and cell-to-product lookup views

### 6. User and access module
Responsibilities:
- user login
- password verification
- role-based authorization
- registration key validation

### 7. Hardware integration module
Responsibilities:
- send commands to controller blocks
- receive hardware events
- expose controller health to the app
- provide a fallback mode when hardware is unavailable
- support development simulation by writing RS485-style events to `stdout`

### 8. Reporting / analytics module
Responsibilities:
- aggregate transactions
- generate time-based reports
- provide print-ready report views
- support quick timeframe presets and custom datetime filters

### 9. Configuration / commissioning module
Responsibilities:
- manage zones/controllers
- store cell mappings
- drive testing and commissioning flows

## Deployment components

At runtime, the system includes:
- frontend process or frontend bundle,
- backend application process,
- database,
- hardware communication process or internal adapter.

## Recommended deployment direction for phase 1

### Option A: Local web app
- backend API runs on Raspberry Pi
- frontend runs in browser/kiosk mode locally
- easier cross-platform development on macOS and Linux

### Option B: Desktop UI
- single desktop application on Raspberry Pi
- potentially tighter kiosk control

### Recommendation
Prefer **Option A: local web app**.

Reason:
- easier iteration on macOS,
- easier deployment updates,
- easy UI portability,
- simple GitHub-based workflow.

## Database direction

### Phase-1 recommendation
Start with one of these:
- **SQLite** for simplest local deployment, or
- **PostgreSQL** if stronger concurrency/reporting needs are expected early.

Current implementation:
- **SQLite** is used for local storage.

## Integration boundaries

The hardware integration layer should be isolated so that:
- business logic does not depend on exact wire-level implementation,
- controller protocol can evolve independently,
- the system can simulate hardware during development.

## Key architecture principles

1. Modular monolith first
2. Local-first operation
3. Auditable transactions
4. Hardware abstraction layer
5. Configurable cell mapping
6. Clear separation between product catalog and inventory balances
7. Replaceable strategy modules for allocation/placement logic

## Current implementation notes

- The current app is a local web application with server-rendered HTML plus lightweight client-side JavaScript.
- Search-heavy controls are rendered by the software instead of OS-native widgets so the UI stays consistent across platforms.
- Task correction is handled as a first-class workflow rather than an ad hoc admin-only database edit.
- Stock handling is intentionally simplified so picks and puts operate against live available quantities without a separate reservation layer.
- Shared rendering and UI-building logic should live in helper modules, while page files should stay organized by feature/domain so both humans and coding agents can find the correct file quickly.
- Current code placement rules and extension guidance are documented in `docs/architecture/02-codebase-architecture.md`.
