# Location QR setup and scoped stocktaking handoff

Implemented on `public-product-development`. This change keeps the existing local warehouse data model and customer QR generation. Cloud hosting, tenancy, synchronisation and installer changes are outside this delivery.

## Delivered flow

1. Open Settings → Hardware → Manage Locations. The compact table shows Name, Shed/Shelf Name, Warehouse Name, QR Code, Mapped LED Module and Actions. Name/description edits, QR assignment and LED mapping are managed here. The separate Cell Mapping dashboard tile is removed; the old guarded mapping endpoint remains for compatibility.
2. Add or edit a location's name, travel instructions, warehouse name and configured fields. Stock, location identity and movement history stay with the location.
3. Assign QR opens a scanner/manual-entry popup. Accept either a LightGuide-generated label or an arbitrary customer sticker containing 1–300 readable characters. QR content is treated as an opaque identity, never a URL to navigate. Require the physical-location confirmation before saving. Duplicate and revoked stickers are rejected; errors leave the popup and draft open. Assigned stickers have a small thumbnail and a View/Update/Close popup; unassigned QR cells remain blank. QR generation and printing remain available.
4. Set up LEDs requires the controller's declared output count. Start setup lights the first eligible output. Scan the sticker beside it, enter the location details, confirm the observed output, and Save and next light. The next output is requested automatically. An unavailable light can be retried or skipped. Existing QR identities are preserved until explicit replacement. Prior physical-verification events backfill scanned status during upgrade; manual/generated identity alone does not assert that a sticker was scanned.
5. Show module displays the physical output number rather than stock, at the existing maximum brightness. It expires after two minutes or is stopped by Hide module/navigation. It cannot override task/count guidance. Mapping uses the existing guarded mapping rules and commits atomically with its request receipt; changes require physical revalidation.
6. Scan location QR from Locations opens a popup with products, quantity in this location, warehouse stock and available-to-pick stock. Product links, Open location and permitted Stocktake shortcuts are available. Unknown/replaced QR values do not navigate or change stock.
7. Products → Stocktake checks only that product in its recorded locations, with optional extra locations. A product's Stocktake link in a location popup scopes the check to that product in that location. The scoped count includes a zero baseline for an unexpected location, forbids unrelated product rows, and does not adjust other products in mixed cells. Existing permissions, discrepancy review, audit records and correction rules remain intact. Concurrent cell movement makes a count stale and requires a recount. Recurring warehouse stocktaking retains its existing schedule and scope rules.

## Verification

- Full `npm test`: **517 passed, 0 failed**.
- Nine added integration tests cover opaque customer QR identities, duplicate/revoked labels, permission checks, idempotent light-first binding, operator arrival/verification using customer QR, module-number display ownership, rich location lookup, guarded mapping with atomic receipts, product-only mixed-cell correction, stale-count rejection and scanned-state migration.
- Existing workflow, permissions, accounting, hardware-display and navigation regression tests remain in the full suite.
- `git diff --check` passed.
- Browser-tested in an isolated demo database with simulated hardware: add/edit location metadata, assign customer QR, duplicate rejection with popup retained, corrected retry, QR viewer, scan-to-inspect popup, product stocktake creation and product-only count form. Responsive layout checked at observed viewport widths of 388px, 1024px and 1910px. The management table scrolls horizontally without expanding the page; phone edit/view dialogs fit the viewport.
- Existing unrelated Active Assignments and role-scope work was preserved. No production database or real hardware was used for these checks.

## Field validation still required

Test on the Raspberry Pi with a real controller, LED modules and a phone/tablet: controller output order, physical module-number display, sequential light pairing, QR camera permission/decoding over the trusted warehouse HTTPS endpoint, existing printed labels, navigation cleanup, and stocktaking during actual concurrent warehouse movements. Configure the physical controller output count explicitly; existing mapping rows are not proof of that count.
