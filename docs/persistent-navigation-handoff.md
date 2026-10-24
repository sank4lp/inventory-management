# Persistent navigation and notifications

LightGuide keeps the signed-in sidebar, page header and notification center mounted while internal page links load new main content. This is a shared application shell with page modules, rather than independently deployed microfrontends.

## Page ownership

`public/client/navigation.js` fetches same-origin HTML and mounts its main content. The server still enforces page permissions and supplies the page's current data. Each page module exports `mount()` and captures a `PageScope`. It must register window/document listeners through that scope, own its timers, and stop cameras or temporary display controls when disposed. Page modules are imported once and mounted again; old handlers and polling must not remain active. Mutations retain the existing receipt and retry rules. Leaving active Work awaits draft saving and the scoped light-pause acknowledgement. A failed pause prevents navigation.

Browser Back/Forward uses the shell for different pages. Task popup frames and active cell selection stay with Work; report hashes stay with Reports. External links, downloads, new tabs, authentication transitions and legacy pages with inline execution retain normal browser navigation. Changed account or warehouse/dataset identity requires a full document load. POST forms retain their existing behavior. Same-origin GET forms can load main content through the shell.

## Notifications

Stocktaking notifications use the run ID as their identity. A changing status updates the same notification rather than adding another. Dismissal and Clear all persist for the same warehouse, dataset and account in browser storage; they suppress that same run's reminder across reloads. A different run can notify. Older repeated stocktaking notifications are deduplicated when read. The ten-second toast timeout hides only the toast; explicit dismiss removes its history entry. Clear all is available in the bell panel. Clearing notifications does not cancel stocktaking or any warehouse work.

## Verification

Unit coverage checks dismissal persistence, clearing across tabs, migration, new run reminders, account isolation, scoped cleanup, read cancellation, unchanged mutation receipts, failed-pause guards, bounded timer cleanup and navigation URL eligibility. Existing workflow, camera, retry and permission tests continue to exercise the mounted modules.

Browser verification covers repeated Work subtab transitions, Products, Locations, Stocktaking, Reports, popup Back navigation, notification dismissal/reload and the isolated rapid-notification fixture. Real Pi lights, camera permissions and warehouse connectivity remain field checks; software verification uses the simulator or GET-only fixtures.

Validation on 2026-10-07: all 477 tests passed. The notification fixture passed all 12 browser checks. Settings and Roles retain the same application shell, and the mobile menu closes after navigation with a single bell retained. The mobile notification panel stays within the visible screen width.

Quantity navigation regression corrected on 2026-10-07: page disposal now removes binding flags retained on the document/body along with their scoped listeners. Quantity, location utility and legacy combo controls can therefore reconnect on every mount. Regression coverage executes quantity activation, toggling and cleanup across repeated Products/Locations mounts, including Show all, with no duplicate commands. All 479 tests passed; the final toggle-label correction also passed the targeted lifecycle/static/quantity tests. Browser checks with simulated hardware verified product quantities, Show all on both pages, task override confirmation and toggling off after content-only navigation. Service-worker cache version is v36.

Locate controls now use the same in-place display toggle, including Locations list/detail, task cards, hardware mapping and legacy adjustment screens. Stop sends the owned display receipt rather than an unscoped cell clear; page disposal also stops that owned display. Confirmed Pick/Put overrides restore current task guidance on stop/expiry, while stocktake lights and newer generations stay protected. All 482 tests passed, including Locate override/restoration, owner-only stop, expiry, stale cleanup and stocktake protection. Browser simulator checks verified list/detail toggles and repeated soft navigation without opening a display page. Hardware mapping/task/adjustment controls share that same delegated handler. Service-worker cache version is v37; real Pi checks remain separate.
