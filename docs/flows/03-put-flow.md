# Put Flow

## Goal

Guide an operator to place incoming or returning inventory into the correct cell(s) and record the placement accurately.

## Primary user path

1. User logs in
2. User selects **Put** from home screen
3. User searches for the product
4. If product does not exist, user can create it
5. User enters quantity and any required item details
6. System selects target cell(s)
7. UI shows the target cells and planned quantities
8. Relevant cells light up in **blue**
9. Operator places the items physically
10. System gathers confirmation
11. Final review screen is auto-filled
12. User approves or corrects the actual placed quantities and may change the final destination cell
13. System records transactions and updates balances

## Product lookup behavior

The Put screen should allow:
- product search,
- selection from existing catalog,
- quick creation of a new product if missing.

## Placement strategy (current recommendation)

### Phase-1 default
Use the product's configured **items per cell** value together with **closest available logical cell first**.

Recommended ordering:
- zone ascending
- row ascending
- column ascending

Example:
- `Z1-R1-C01` is considered before `Z1-R1-C02`
- `Z1-R1-C27` is considered before `Z1-R2-C01`

Current confirmed software behavior:
- refill partially filled cells for the same product first,
- then open new cells in ascending logical order,
- try to minimize the total number of cells used for the put.

### Design note
This should be implemented as a modular placement strategy so it can later be replaced by:
- preferred-cell strategy,
- category-aware strategy,
- size/weight-aware strategy,
- frequency-based optimization,
- admin-configurable rules.

### Near-term evolution after phase-1 default
After the basic closest-cell-first strategy, the next practical strategy should be:
- keep the same item type close together,
- if one cell can hold only part of the incoming stock, place the remaining stock in nearby cells,
- prefer extending an existing nearby cluster for that item type rather than scattering it across distant cells.

Example:
- if one cell can hold 3 shoes and 21 shoes need to be placed,
- the system should prefer 7 nearby cells instead of 7 distant cells.

## Multi-cell put-away

If a full quantity should be split across multiple cells, the system should plan explicit placement quantities.

Example:
- Cell A receives 4
- Cell B receives 3
- Cell C receives 1

The UI should show this clearly and the task should be confirmed cell by cell or through a final review screen.

## Ideal capacity vs. real-world override

The system should treat **items per cell** as the ideal software rule, not an absolute hard block.

That means:
- the software should warn if the entered result would exceed the ideal capacity,
- the software should still allow the operator to save the real result,
- the affected cell should later appear in **recommended actions** for follow-up cleanup.

## Mixed-product cells

The software should also allow multiple different products to be stored in one cell when the operator confirms that this is what actually happened.

This is not the ideal layout, so the software should:
- save the real result,
- highlight the mixed cell as an anomaly,
- suggest follow-up redistribution through recommended actions.

## Confirmation model

### Button-assisted
If cell buttons are integrated:
- operator presses the button after placing items,
- system records physical confirmation,
- final screen is pre-filled.

### Screen-assisted
If physical confirmation is unavailable:
- operator returns to the screen,
- confirms actual placement,
- edits any mismatches.

## Final review screen rule

The Put flow should always end with an auto-filled final review screen before inventory changes are fully committed.

This screen should allow:
- confirming suggested cell allocations,
- correcting actual placed quantities,
- changing the final destination cell,
- recording exceptions,
- committing the final result to the database.

## Put exceptions

- preferred cell is full,
- cell is blocked/inactive,
- product metadata missing,
- operator placed quantity differently than suggested,
- operator placed quantity in a different cell than suggested,
- operator intentionally overfilled a cell,
- operator mixed multiple small products in one cell,
- light/button/controller failure,
- user needs admin override.

## Data changes

The Put flow should affect:
- product catalog (if item is newly created),
- task records,
- cell inventory balances,
- transaction logs,
- audit trail.

## Current implementation direction

- Operators may override final cell choice during review.
- Admins may later change **items per cell** for a product, and the next put should then use the updated value.
- Non-ideal placements should be corrected through recommended actions rather than being blocked outright.
