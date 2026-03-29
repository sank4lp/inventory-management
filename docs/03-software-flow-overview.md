# Software Flow Overview

## Purpose

This document catalogs the main software flows and defines the shared rules across those flows.

## Top-level flow map

### Entry point
1. User arrives at warehouse entry station
2. User authenticates
3. User lands on home screen
4. User chooses an action

### Primary actions
- Pick
- Put
- Admin / Settings
- Reports / Analytics
- Device / Mapping / Maintenance

## Flow catalog

| Flow | Primary actor | Outcome |
| --- | --- | --- |
| Authentication and registration | Operator/Admin | User signs in or is created with controlled access |
| Pick flow | Operator | Inventory is removed from one or more cells and recorded |
| Put flow | Operator | Inventory is stored in one or more cells and recorded |
| Admin flow | Admin | Users, permissions, settings, and corrections are managed |
| Product catalog flow | Admin/Operator | Products are created and maintained before movements |
| Analytics flow | Admin/Management | Reports are viewed/exported |
| Device onboarding and zone management | Admin/Maintainer | Controllers and zones are registered and tested |
| Cell mapping and commissioning | Admin/Maintainer | Physical cells are mapped to logical cell IDs |

## Shared flow rules

### 1. Authentication rule
Except registration, all operational flows require an authenticated user.

### 2. Audit rule
Every inventory-affecting action must be traceable to:
- a user,
- a timestamp,
- a location,
- a product,
- a reason or task.

### 3. Auto-fill rule
Whenever possible, the system should auto-fill:
- product details,
- selected cells,
- planned quantities,
- suggested confirmation data.

### 4. Exception rule
Every major operational flow should support exceptions such as:
- insufficient quantity,
- wrong item found,
- cell inaccessible,
- controller or light failure,
- operator correction.
- over-capacity placement,
- mixed-product storage in one cell.

### 5. Hardware feedback rule
If lights/buttons are integrated in the workflow:
- light state changes should be visible in the UI,
- device errors should be surfaced,
- the system should fall back to manual guidance when hardware is unavailable.

### 6. Recommended action rule
If a user records a real-world result that violates the ideal layout rules, the software should:
- save the real result,
- flag the affected cell as an anomaly,
- show a recommended follow-up action on the home screen and in the recommended actions view.

## Shared task lifecycle

Recommended common lifecycle for pick/put style actions:

1. User initiates the action
2. System validates inputs
3. System computes allocation/placement plan
4. System creates a task
5. System activates guidance (screen + lights)
6. Operator performs physical work
7. Operator confirms or edits actual result
8. System records transactions
9. System completes task and updates inventory

## Confirmation model

The software should support two confirmation layers:

### Physical confirmation
- button press at the cell,
- device event recorded,
- used as strong evidence that the user reached the location.

### Final software confirmation
- auto-filled review screen,
- user approves or corrects quantities,
- database is finalized.

This review screen is a confirmed product requirement for phase 1.

This allows the product to support both current UI concepts and future hardware-assisted accuracy.

## Flow design direction

### Pick direction
Prefer **planned allocation** over “light all matching cells and let the operator decide freely.”

Current confirmed behavior:
- all allocated cells may be lit at once,
- the screen should still show the planned quantity allocation by cell,
- the final review screen remains mandatory.

### Put direction
Prefer **system-suggested placement** over fully manual cell selection, while still allowing controlled override.

Current confirmed behavior:
- the system suggests destination cells using the product's **items per cell** value,
- it should refill existing cells for the same product before opening new cells,
- the operator may still override the final destination cell and quantity during review.

### Placement direction
Placement rules should be implemented as a modular strategy/service boundary so that the logic can evolve without tightly coupling it to unrelated parts of the application.

Initial default strategy:
- choose the closest available logical cell first,
- use ascending logical order such as zone → row → column,
- allow replacement of this strategy later without changing the rest of the system.

Planned next strategy direction:
- prefer keeping the same type of items in nearby cells,
- when one cell cannot hold the full quantity, place spillover inventory in adjacent or nearby cells,
- continue extending that cluster as more inventory of the same type is added later.

## Current implementation direction

- The home screen exposes live search for both products and cells.
- Reports remain admin-focused, while operators use task, product, cell, and recommended-action flows.
- Completed tasks may be reopened in a separate edit / correction mode, but only by the task owner or an admin.
