# Physical planning, quantity controls, task search and LED counts

## Delivered behavior

- Quantity controls on work, recovery, movement and stocktake screens increment by one. Duration inputs retain their existing units and fractional duration support. Existing stored fractional quantities are not rounded or rewritten.
- Pick and Put planning use physical stock/space while protecting started work, including paused started work. Unstarted offers and claims already awaiting review may yield; a review on one line does not make an actively executing sibling line yield.
- When a newer plan competes with an unstarted offer, first attempt to replan that older offer to other suitable cells. This preserves its assignee, deadline, requested quantity and historical instructions. The relocation protects all other non-review offers to avoid silently displacing another offer in turn.
- If the older work no longer fits, keep its original reservation and any physical evidence, mark it Needs Review with high priority, and add a Recommended Action linking both task numbers. The supervisor can check, update or close it. The application never assumes stock moved and never automatically deletes that task. A displaced task cannot start while its review remains unresolved.
- Space for More uses the same usable-capacity policy as ordinary Put planning. Reservation totals and links remain visible; Physical Free Space remains in reservation details to distinguish raw space from space blocked by active work or location checks. Total Capacity remains the physical measure.
- Task History search uses a parameterized substring match on Task ID. Searching 99 matches 99, 199 and 990, subject to the user's existing access. Missing matches show an empty table. The exact task-history popup retains its existing access checks.
- Show Quantities displays on-shelf quantities rather than quantities minus Pick reservations. Each mixed-cell product uses its own on-shelf number in the alternating display. Active-task override/restore behavior is unchanged.

## Why Put could previously fail

The previous Put planner deducted all held Put reservations, including unstarted offers and review work, while the headline stock summary showed physical free space. It also protected location condition/count checks and avoided incompatible mixed-product locations. Therefore a headline physical-space total did not necessarily mean that much space was usable by the planner. The policy and headline usable-space calculation now agree.

The customer's Raspberry Pi database was not accessed. The precise cause for its ammo-24 rejection cannot be established from aggregate totals alone.

## Verification

- Full suite: 493 passed, zero failed/skipped, including existing workflow, access, task closure and display regressions.
- Regression fixture: 83 on shelf, nine 15-unit cells (135 capacity), 52 physical free space, an unstarted Pick reservation of 23 and Put reservation of 7. A new Put of 7 succeeds without changing physical inventory at creation. Active work remains protected.
- Pick and Put displacement tests cover high priority, recommendations, request replay, unchanged inventory at creation, protected active work, preserved review evidence and active sibling lines, mixed-product incoming offers, and safe relocation of older offers.
- Task-ID tests cover partial matches, no matches, # prefix, invalid input, API/bootstrap behavior and role boundaries.
- Display tests cover on-hand vs. reserved counts, controller text commands and mixed-cell alternation.
- Browser checks on the existing isolated simulator preview: Quantity 7 increments to 8; missing Task ID 99 shows No matching history and zero matching; matching Task ID 6 shows only its events. No browser console warnings/errors were observed.
- The preview was restarted on localhost:3210 with its existing demo database and simulator; its data differs from the customer's Pi. No demo inventory was replaced to manufacture the 83-unit scenario.

## Remaining field checks

Actual Raspberry Pi firmware, serial delivery and physical LED output still require warehouse testing. No database migration, remote push or production service restart was performed.
