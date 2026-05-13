# Software Overview

## Purpose

This document defines the software system at a high level: what it should do, how it is expected to run, and what major modules it will contain.

## Deployment model

### Development

- Primary development machine: **macOS**
- Version control: **GitHub**
- Developers push code from macOS to GitHub

### Runtime

- Target runtime: **Linux on Raspberry Pi**
- Operator-facing software runs locally at the warehouse entry station
- The Raspberry Pi also coordinates hardware communication with the cell-light system

## Recommended software shape for phase 1

For phase 1, the software should be designed as a **local-first modular application**:

- a kiosk-style UI for operators and admins,
- an application layer that handles business rules,
- a database that stores products, users, locations, devices, tasks, and transactions,
- a hardware integration layer that talks to controller blocks.

Even if phase 1 is delivered as one deployable application, its modules should be designed so that important decision engines can be replaced later in a plug-and-play way.

## Major software capabilities

### 1. User and access management
- Registration with a controlled registration key
- Login and logout
- Role-based access control
- Admin management of users and permissions

### 2. Product catalog management
- Create products independent of stock movements
- Search products quickly during pick/put flows
- Store product metadata such as SKU, name, brand, size, category, preferred location rules, and ideal **items per cell**
- Enforce required fields such as product code, product name, brand, unit of measure, and active status

### 3. Inventory execution
- Pick flow
- Put flow
- Partial completion handling
- Exception handling
- Adjustment flow for corrections
- Final review/confirmation screen for every task

### 4. Inventory state management
- Available quantity per cell
- Confirmed movement history
- Audit-safe corrections
- Detection of mixed-product and over-capacity cells

### 5. Hardware guidance and control
- Light selected cells
- Change colors based on task type
- Receive cell confirmations from button events
- Show device/zone health

### 6. Placement and allocation logic
- Decide which cells should be used for Put tasks
- Decide how stock should be allocated across cells for Pick tasks
- Remain modular so logic can evolve later
- Prefer refilling partially filled cells for the same product before opening new cells

### 7. Configuration and commissioning
- Add/edit zones and controllers
- Map physical cells to logical locations
- Run test and maintenance modes

### 8. Analytics and reporting
- Hourly, daily, weekly, monthly, and yearly reports
- Movement trends
- Stock visibility
- User activity visibility
- Exception and audit visibility
- Print-ready report generation with custom time filters
- Quick timeframe buttons such as last 1 hour, last 3 hours, last 6 hours, last 12 hours, last 24 hours, previous day, previous week, and previous month

### 9. Recommended actions and anomaly handling
- Detect cells whose actual state does not match the ideal software rules
- Surface recommended follow-up actions in the recommended actions screen
- Allow a user to review and edit a suggested correction plan before applying it

## Recommended domain model

The following entities should exist in some form.

### User
- id
- name
- username
- password hash
- role
- status
- created by

### RegistrationKey
- id
- key value
- issued by
- status
- expiration

### Product
- id
- sku
- name
- brand
- description
- category
- size/variant
- barcode (optional later)
- preferred storage strategy
- items per cell

### CellLocation
- id
- logical code
- zone id
- row
- column
- physical mapping status
- active/inactive

### Device / Controller
- id
- zone id
- controller address
- firmware version
- heartbeat status
- last seen time

### InventoryBalance
- product id
- cell id
- available quantity

### InventoryTask
- id
- type (`pick`, `put`, `adjustment`, etc.)
- status
- created by
- started at
- completed at
- editable only by owner or admin once completed

### InventoryTaskLine
- task id
- product id
- cell id
- planned quantity
- confirmed quantity
- exception quantity

### InventoryTransaction
- id
- type
- product id
- cell id
- quantity delta
- user id
- task id
- timestamp
- reason

## High-level screen map

### Public/entry screens
- Login
- Registration

### Main app screens
- Overview dashboard
- Recommended actions screen
- Pick screen
- Put screen
- Review/confirmation screen
- Search/catalog screen
- Product detail screen
- Cell detail screen
- Reports screen
- Device/mapping screen
- Admin settings screen

## Key software rules

1. **Every inventory-changing action should create a task or a transaction.**
2. **Users should rarely type the final result manually.**
3. **The system should pre-fill confirmation data whenever possible.**
4. **Physical confirmation should enrich software confirmation, not replace audit logs.**
5. **Cell mapping should be configurable in software.**
6. **Hardware errors should be visible in the UI.**
7. **Ideal capacity rules may be exceeded in reality, but those exceptions must be highlighted clearly for follow-up.**
8. **Search and picker controls should be rendered by the app itself so the UI stays consistent across operating systems.**

## Phase 1 UX assumptions

- The screen remains the main place where quantities are displayed clearly.
- Lights indicate location and task state.
- Buttons may provide physical confirmation, but the system should still show a final review screen before committing inventory changes.
- For pick tasks, all allocated cells may be lit at once while the UI clearly shows the full planned allocation.
- Reports should be printable directly from the system after the user selects a timeframe.
- The home screen should stay focused on primary workflow buttons and recent tasks.
- Operators should search products and cells from the dedicated Products, Locations, Pick, and Put flows.
- Completed tasks may enter a separate correction mode rather than being overwritten silently.

## Current implementation direction

- Current implementation is a **local web app** with server-rendered HTML and lightweight in-app JavaScript enhancements.
- Current local storage uses **SQLite**.
- The current stock model is intentionally simple: there is no operational reservation concept in the software.
- Button events update task review state as supporting physical evidence, but the final review screen remains the actual commit point.
- The hardware layer is currently simulated by emitting RS485-style events to `stdout`.
