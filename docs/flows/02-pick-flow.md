# Pick Flow

## Goal

Guide an operator to remove inventory accurately from the correct cells and record the movement with minimal manual effort.

## Core design rule

The pick flow is **task-driven**, not free-form.

That means the system should:
1. receive the user’s requested item(s) and quantity,
2. calculate exact source cells,
3. allocate quantities per cell,
4. guide the operator through those planned cells,
5. confirm actual results,
6. update inventory and logs.

## Primary user path

1. User logs in
2. User selects **Pick** from home screen or starts from the home search area
3. User searches for one or more products with the software-rendered searchable picker
4. User enters required quantity per product
5. System validates stock availability
6. System creates a pick task and task lines
7. System allocates specific cell quantities
8. UI shows:
   - product name / SKU
   - requested quantity
   - planned cells
   - quantity per cell
9. Relevant cells light up in **green**
10. Operator performs the physical pick
11. System gathers confirmation
12. Final review screen is auto-filled
13. User approves or edits actual quantities
14. System records transactions and updates balances

## Multi-cell allocation example

If the user requests 8 units and stock is distributed as:
- Cell A = 3
- Cell B = 3
- Cell C = 2

The system should not simply say “pick from any of these.”

Instead it should create a plan such as:
- pick 3 from Cell A
- pick 3 from Cell B
- pick 2 from Cell C

This makes the physical process and database state easier to keep aligned.

## Recommended guidance mode

### Confirmed phase-1 behavior
- all allocated cells should light up at once,
- all selected pick cells use **green** guidance,
- the screen must clearly show the quantity to pick from each lit cell,
- the task must still end on a final review screen,
- a **Find** action may be used to re-send the simulated RS485 light signal for a selected cell.

Optional enhancement later:
- distinguish the recommended immediate-next cell with a blink pattern while keeping all allocated cells lit.

## Confirmation options

### Option A: Button-assisted confirmation
When the operator presses the button at a lit cell:
- the system records that the operator reached that location,
- the current task line is pre-filled as completed or partially completed,
- the final review screen is updated.

### Option B: Screen-only confirmation fallback
If button integration is unavailable or fails:
- the operator returns to the screen,
- the system shows the planned pick,
- the operator confirms or corrects the actual quantities manually.

The software should support both, with button-assisted confirmation preferred.

## Final review screen rule

Even if button events are received successfully, the operator should still see a final auto-filled review screen before the task is committed.

This screen should allow:
- confirming the planned quantities as-is,
- correcting actual quantities,
- recording shortages or mismatches,
- completing the task with an auditable record.

Current screen behavior:
- the main task flow uses **Pick Task** and **Review Cells** sections,
- completed tasks can later be reopened in a separate correction mode,
- the correction entry point is shown as **Make Correction** in recent tasks.

## Multi-SKU job support

The system should allow a single pick job to contain multiple SKUs.

Recommended structure:
- one pick job
- multiple pick lines
- each line may expand into multiple cell allocations

## Partial completion flow

If the planned quantity cannot be fully picked from a cell:
- user records actual quantity picked,
- remaining quantity is recorded as an exception on that task,
- operator or admin can start a fresh follow-up task for any remaining need,
- all deviations are logged.

## Pick exceptions

Examples:
- item not found in the cell,
- quantity lower than expected,
- wrong product in cell,
- damaged stock,
- light not working,
- button not working,
- task interrupted midway.

## Data changes

The pick flow should affect:
- task records,
- available inventory,
- inventory transaction log,
- device event log,
- user activity log.

Current software behavior:
- stock is not reserved ahead of time,
- cancelling a pick task does not change stock,
- if stock has changed since the pick task was created, completion validates the live quantity again before subtracting inventory.
