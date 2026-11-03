# Guarded QR reassignment in Manage Locations

Implemented locally on `public-product-development`, following the confirmed original-cell-first workflow. The prior stocktaking work is preserved. No customer Pi data was accessed or changed.

## Flow

1. Scanning QR A while assigning a QR to cell B is blocked while QR A still belongs to cell A. A popup names both locations and tells the administrator to repair cell A first. There is no override or automatic swap.
2. In Manage Locations, select Set replacement QR at cell A. Go to A, scan or enter its current QR, confirm the original location, attach and scan a new unused replacement QR, and confirm the old sticker was replaced.
3. Save replacement QR updates A only. A keeps its inventory, location identity, LED mapping and movement history. QR A becomes available only for this recorded reassignment to B, not for arbitrary binding in stocktaking, setup or another cell.
4. Go to B, attach and scan QR A again, confirm its physical position and removal of B's old sticker, and Save QR. B keeps its own inventory and movement history. Its old QR B is retired.
5. Continue later retains the saved reassignment across reloads and restarts. The pending row in Manage Locations offers Continue and Cancel. Cancellation leaves A's replacement QR and B's current QR unchanged and retires the unused released QR; this is explicitly confirmed.

## Safeguards

- Existing QR-management permission is required for all three reassignment actions. Operators without it cannot perform them.
- The source QR must match its current registration. Both original and destination label identities/revisions are checked before the first save. The replacement must be distinct and unassigned.
- Source replacement waits for active counting and outstanding task work affecting either cell. Final assignment waits for conflicting work at B.
- The final save checks that A still has its recorded replacement QR and B still has its original expected QR. Changes by another administrator or a restored dataset cannot silently redirect the assignment.
- A pending QR and pending destination are unique. Ordinary assignment, replacement and guided setup cannot take a QR reserved by the staged flow.
- Request receipts prevent double application. Each stage is transactional and independently audited. No stock balances or movement transactions are changed.
- Normal standalone QR replacement still retires its old code. Reuse is restricted to the explicit staged reassignment.
- Physical placement remains a human confirmation; scanning a code does not prove where it is attached.
- Stocktaking's existing Wrong / undetected location? popup routes bound and pending QR conflicts to Manage Locations. Unknown/unassigned QR binding and manual counting remain available.

## Verification

- Full suite: 575 passed; zero failures or skipped tests.
- Added regressions cover blocked conflict details/HTTP 409, wrong source QR, missing physical confirmations, non-unique replacements, permissions, restart, replay, reserved-QR protection, source/destination changes, cancellation and active work protection.
- Browser simulator: assigned QR A and QR B to separate cells, attempted duplicate assignment, verified the warning, confirmed and relabelled A, closed/reloaded, resumed the pending row and assigned QR A to B. Both stock identities remained unchanged.
- The live camera path and actual sticker replacement still need verification on the Pi, iPhone and Android. The browser test used manual QR text in an isolated simulator database.
- Changes are local, uncommitted and not pushed.
