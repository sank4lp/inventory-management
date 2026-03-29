# Product Overview

## Purpose

This document defines the product context for the warehouse inventory management system.

It is the anchor document for all later software, hardware, architecture, and technical specification documents.

## Product vision

Build a warehouse inventory system that:
- helps operators quickly **pick** and **put** items,
- uses a local software interface at the warehouse entry point,
- guides the operator to the correct storage cell using **lights**,
- records inventory movements accurately,
- supports user authentication, auditability, reporting, and future hardware expansion.

## Physical warehouse model

Current planning assumption:

- Rack layout: **27 columns × 3 rows**
- Total storage cells: **81**
- Each cell is a physical inventory location
- Operator station is located at the **entry of the warehouse**

### Recommended location naming approach

Use logical location IDs that do not depend on wiring details.

Example format:
- `Z1-R1-C01`
- `Z1-R1-C02`
- `Z1-R3-C27`

Where:
- `Z1` = zone 1
- `R1..R3` = row
- `C01..C27` = column

This allows the software to reason about inventory locations even if hardware wiring changes later.

## Primary user roles

### 1. Operator

An operator uses the system to:
- log in,
- pick inventory,
- put inventory,
- confirm actions,
- view only the information needed to complete a task.

### 2. Admin

An admin uses the system to:
- manage users,
- control registration access,
- review and correct inventory through audit-safe adjustments,
- manage products,
- manage devices and mapping,
- access analytics and reports.

### 3. Installer / Maintainer

This role may be represented by an admin in phase 1.

Responsibilities include:
- onboarding controllers,
- testing zones,
- mapping physical cells to software cells,
- diagnosing hardware failures.

## Core business actions

### Pick

The operator requests one or more items to remove from inventory.

The system should:
- find matching stock,
- allocate quantities to exact cells,
- guide the operator using screen instructions and cell lighting,
- confirm the movement,
- update inventory and logs.

### Put

The operator requests to store one or more items into inventory.

The system should:
- identify the product or create it if needed,
- choose a target cell or cells,
- guide the operator using screen instructions and cell lighting,
- confirm the movement,
- update inventory and logs.

### Real-world exception handling

Phase 1 should allow the operator to record what actually happened, even when it does not match the ideal layout.

Examples:
- more items may be placed in one cell than the configured ideal **items per cell** value,
- multiple different small products may be stored in one cell,
- the operator may override the suggested destination cell during final review.

The software should still save the real result, then flag the cell for follow-up under **recommended actions**.

## Product goals

### Operational goals

- Reduce confusion in the warehouse
- Make picking and put-away faster
- Keep cell-level inventory accurate
- Support multiple users safely
- Provide auditable movement history

### Product goals

- Run locally on Raspberry Pi in phase 1
- Be simple enough for kiosk-style warehouse operation
- Be modular enough to scale later
- Support future controller onboarding and zone expansion
- Generate usable reports for upper management

## Phase 1 scope

Phase 1 should support:

- user authentication and controlled registration,
- home screen with **Pick** and **Put** primary actions,
- live product and cell search from the home screen,
- product search and product creation,
- product detail and cell detail lookup,
- pick task creation and pick confirmation,
- put-away task creation and put confirmation,
- recommended actions for mixed or over-capacity cells,
- correction mode for completed tasks,
- inventory transaction logging,
- admin management,
- zone/controller onboarding,
- cell mapping and testing,
- basic analytics and printed reports.

## Explicit non-goals for the first draft

These may be added later, but they should not block initial documentation:

- multi-warehouse support,
- mobile application,
- advanced route optimization,
- ERP/WMS integrations,
- automated barcode/RFID validation,
- high-availability distributed runtime.

## Key design principles

1. **Inventory should be task-driven.**
   - The system should allocate specific cells and quantities before work begins.

2. **The operator should mostly confirm, not type.**
   - Screens should be auto-filled whenever possible.

3. **Physical and digital state must stay aligned.**
   - Every physical movement should result in a recorded transaction or an exception.

4. **Corrections must be auditable.**
   - Users should create adjustment entries, not silently overwrite history.

5. **Hardware guidance should complement the UI, not replace it.**
   - The screen tells the user what and how much.
   - Lights tell the user where.

6. **Placement logic should be modular.**
   - Cell-selection logic should live behind a replaceable service/module boundary so it can evolve later without rewriting unrelated parts of the system.

## Confirmed product decisions

- Every inventory task should end with a **final review screen**, even if cell buttons are used.
- Pick tasks should activate **all allocated cells at once**.
- Reports are considered **launch-critical**.
- Placement logic should be configurable later and should be implemented in a modular, plug-and-play style.
- After the initial closest-cell-first behavior, placement logic should also support **keeping the same type of items clustered in nearby cells**.
- The initial printed management reports at launch can be limited to the four core reports already defined.
- Users should be able to correct completed tasks, but only the original task owner or an admin should be allowed to edit that task.
- Admins should be able to change the ideal **items per cell** value for a product after the product is already in use.

## Recommended mandatory product attributes for phase 1

When the documents ask, "What product attributes are mandatory in phase 1?", the intent is:

> What minimum set of item details must exist so the product can be created, searched, picked, put away, and reported on correctly?

Recommended minimum product-master fields:

- **Product code / SKU**
- **Product name**
- **Brand**
- **Unit of measure** (pairs, pieces, boxes, etc.)
- **Items per cell**
- **Active status**

Recommended contextual/conditional product fields:

- category
- variant / size if applicable

Recommended but optional in early phase 1:

- description
- barcode
- preferred storage location rule
- reorder threshold

### Validation rules to apply in phase 1

#### Product master validation
- **Product name** is required and cannot be blank.
- **Product code / SKU** is required and must be unique.
- **Brand** is required.
- **Unit of measure** is required.
- **Items per cell** is required and must be a positive number.
- **Active status** is required.
- **Variant / size** is required when the product category demands it.

#### Inventory operation validation
- **Quantity** is required for Pick and Put workflows.
- Quantity must be a valid positive number.
- Unit of measure used during a transaction must match the product’s configured unit of measure.

## Major open questions

- What exact clustering rules should define when similar items should stay near one another?
- What printer format details should be supported first, such as paper size and header/footer layout?
