# Product picker stock summary

Built on `944d271`. Self Pick, self Put and Assign Work now share a compact product field with a bracketed stock summary. The assignment page retains its simple selector rather than adding another search field. Product/quantity/button widths stay aligned; the summary wraps inside the product field.

## Meaning of the figures

The new authenticated, non-cached `GET /api/work/productStock?productId=…` reads the live database:

- **Recorded**: sum of recorded inventory balances, including pick-reserved stock and stock in inactive/blocked locations. This is not a physical-count guarantee.
- **Pick reserved**: held `pick` reservations from `work_reservations`, not the denormalized `reserved_quantity` field.
- **Available**: sum of non-negative per-location recorded stock minus held pick reservations, excluding inactive locations, controlled-condition reviews, product/location discrepancies, pending physical reports, and uncertain exclusive turns. This is dependable stock for planning a pick. A known busy turn can still require waiting on arrival.
- **Incoming**: held `put` reservations for this product, shown separately. These do not increase recorded stock or reduce pick stock.
- **Put space** (Put only): compatible usable-location capacity minus current occupancy and all incoming put reservations. Other-product occupancy/incoming plans make a location incompatible. This follows existing product-capacity planning semantics.

All figures use the displayed product unit. The expanded panel leads with per-location reservation task links, followed by a short conditional unavailable-stock note. Full definitions are inside a separate small help disclosure. The count explicitly means location reservations, not unique tasks. Details are limited to 100 rows; totals cover all held reservations. No stock-read method reconciles guidance, reserves inventory, creates a receipt, acquires a turn, or changes a balance. Submission remains authoritative and runs the existing planner/permissions again. The displayed availability is deliberately conservative around uncertain reports/turns, even where the existing planner has a narrower discrepancy check.

## Permissions and task management

The service re-reads the current actor and requires work view plus Pick, Put or assignment capability. Invalid/inactive products and revoked/inactive users are rejected. Aggregate planning totals include everybody's reservations. Only `work.team` permits team task/location/assignee details. Without it, the response contains only currently assigned own task rows; assignment permission alone does not grant team visibility. Filters are on the server, before serialization.

Reservation links are ordinary `/tasks/:id` GET links. The explicit Start/Resume separation from `944d271` remains intact. Admin task inspection already exposes Stop remaining work for another operator's live reservation and the existing reassignment flow. Stop releases untouched reservations; started/uncertain work goes through quantity review. Reassignment rejects active or uncertain physical instructions. Returned/verified work retains its existing remaining-quantity update flow. There is no new shortcut for editing the quantity of active physical work, and no management mutation is performed from the stock panel. No additional management action was necessary for this request.

## Client freshness, loading and recovery

Selecting a product or changing Pick/Put initiates a fresh read-only request and shows a real rotating CSS spinner with an accessible loading status and `aria-busy`. Reduced-motion users get a static dotted indicator with the same status text. Empty selection hides the panel. Preselected/restored forms load their product after draft restoration. Reads never enter the command outbox.

Responses are scoped to actor, warehouse, dataset, effective planning/team capabilities and product. A rapid A → B → A selection starts a fresh A request; an older A result cannot replace it. Prior-role cached or in-flight team detail cannot paint after a capability downgrade. Loss of all planning rights removes the panel. Identity/product mismatches show an unavailable state instead of counts.

Counts are kept only in document memory, always labeled with the server check time. Existing polling refreshes them after 30 seconds without replacing form fields or edits. Active requests are shared during ordinary polling. Explicit selection/retry supersedes them. Open reservation details survive stock refresh and page rendering. Loading hides the previous counts; errors show Retry stock check; offline hides counts and does not request data. The offline event clears these transient reads, and successful reconnect explicitly refreshes the selected product. None of these paths lights LEDs. Database authority still validates creation/assignment.

## Verification

Full suite: **277/277 passed**, zero failures. Final render/disclosure ordering was followed by **41/41 focused client/render tests**. Whitespace check passed.

New server tests cover reservation-source math, incoming versus stock/capacity, other-product incompatibility, authorization and own/team privacy, no-store routing, invalid/current actor checks, inactive/discrepant/uncertain exclusions, released reservations, partial actual settlement, and passive admin inspection followed by the existing safe stop. A SQLite `total_changes()` comparison and injected hardware spy show no writes or guidance from repeated reads. New client tests cover loading/no-store requests, rapid selection and stale responses, blank selection, retry/offline/periodic refresh, retained edits/disclosure state, identity mismatch, assignment Put space and capability downgrade.

Evidence under `docs/evidence/product-stock-summary/`:

- `stock-read.json`: real service responses from disposable seeded databases. Admin sees all three held rows; operator sees one own row with the same aggregate figures. Database changes during reads: zero.
- `pick-phone.jpg`, `put-tablet.jpg`: self-creation at 390×844 and 820×1180.
- `loading-phone.jpg`, `assign-put-phone.jpg`, `assign-desktop.jpg`: shared assignment picker with loading and loaded states, including desktop alignment.
- `reservations-phone.jpg`: settled expanded task links before explanatory help.
- `expanded-layout.json`: phone DOM measurements confirm the summary ends at 440.85 px and the list begins at 448.85 px (8 px gap), with no overlap.

Browser checks used a GET-only synthetic fixture with actual production render functions, styles and navigation; delayed synthetic responses made the spinner observable. No browser login, warehouse POST, hardware or Pi operation occurred. Temporary tab closed; viewport reset. Screenshots use synthetic Packing Cases data, while database evidence uses the disposable seeded product and units.

## Local delivery

Service worker cache is v21. The isolated simulator has been restarted at http://localhost:3213/work, process session **2837**, using the existing disposable data directory `/private/var/folders/7j/tj6x994918vdsby3cnhkfz440000gn/T/lytguide-preview-nMJMOX` and `/private/tmp/my-work-preview.log`. GET-only stock fixture remains on port 3219, session 44940. This task makes a scoped local commit only; no push or merge.
