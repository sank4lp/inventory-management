# Responsive UI contract and validation

The shared screen layer is `public/responsive.css`, loaded after the legacy page
and operator styles. It also ships with the offline page and service-worker cache.
Changes to this layer must be checked in both the desktop pages and operator work.

## Layout and controls

- Body and editable fields use 16px text; labels and ordinary buttons use 14px.
  Secondary information stays at 12–14px. Headings have bounded sizes rather than
  growing continuously with a large monitor.
- Ordinary controls have a common 44px minimum height on desktop and 48px on
  narrow/coarse-pointer layouts. Card buttons retain their larger content-driven
  height; checkboxes have a larger surrounding label target.
- Button labels can wrap. Icon controls, custom dropdown toggles, report filters,
  disclosures, and navigation follow the same control system.
- Forms and headers wrap within their available content width. Content stays
  bounded on wide monitors. Phone summary cards use two columns; tables scroll
  within their own panels rather than widening the page.
- On-screen reports keep readable table/chart sizes and allow contained scrolling.
  Paper-format previews and print media retain the separate report-format rules.
- Dialogs overlay navigation and scroll within short viewports. Phone report
  popovers appear as bounded sheets so their actions remain reachable.
- Status colours use readable foregrounds on light backgrounds. Colour does not
  replace the status text.

## Browser verification — 25 September 2026

Checked in the isolated simulator preview, using actual measured CSS viewport
widths. No warehouse database, network configuration, or physical hardware changed.

| Pages | Widths (CSS pixels) | Result |
| --- | --- | --- |
| Overview, catalogue/detail, locations/detail, reports, devices, backups, admin, user detail, product fields, profile, pending confirmations, labels, movement history, recommendations | 320, 768, 1024, 1440, 1920, 2560, 3840 | 112 checks; no page-level horizontal overflow |
| My work, Pick, Put, active task, completed-movement form, movement history, labels | 320, 390, 600, 601, 700, 701, 768, 820, 1020, 1021, 1280, 1440, 1920, 2560, 3840 | 105 checks; no page-level horizontal overflow |
| Catalogue, locations, reports, admin, product fields, backups | 600, 700, 701, 820, 1020, 1021, 1100, 1101, 1280 | 54 breakpoint checks; no page-level horizontal overflow |
| Sign-in, registration, offline page | 320, 768, 1440, 3840 | 12 checks; no page-level horizontal overflow |

Additional visual and interaction checks covered all eight report selections on a
390px viewport, report filters, the format editor, Add Product, controller setup,
location mapping, the embedded report editor at 1024px, and phone navigation with
More tools and Escape. Add Product and the format editor remained scrollable at
667×375. Representative screenshots were inspected for typography, wrapping,
contrast, placement, and readable internal table/chart scrolling.

A simulator operator task was planned, started with the printed location code,
and closed with an explicit zero actual. The task recorded zero and released the
reservation. Automatic tests pass (121), including an integration check that the
online/offline pages load the shared styles and the service worker caches their
stylesheet dependencies.

This verifies browser layouts and simulated workflows, not every possible device
or content combination. Physical Android/iPhone camera, keyboard, browser zoom,
warehouse roaming, and print output remain deployment acceptance checks. CSS-pixel
widths differ from physical display pixels on high-density devices.
