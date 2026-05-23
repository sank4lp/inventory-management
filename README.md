# Inventory Management App

Phase-1 local-first software implementation based on the docs in `docs/`.

## Features

- Controlled registration and login
- Product catalog
- Product-level `items per cell` capacity, editable by admin
- Live software-rendered search and combobox pickers with no OS-native dropdown dependency
- Pick and put task planning
- Final review and confirmation for every task
- Inventory balances and immutable transactions
- Admin adjustments, registration key control, and user access suspension
- Task correction mode with owner-or-admin edit permissions
- Recommended actions for mixed-product cells and over-capacity cells
- Device, controller, and cell mapping visibility
- Launch-priority reports with custom datetime ranges and quick presets from 1 hour to previous month
- RS485 hardware command simulation via `stdout`
- Seeded with a simple army-warehouse-style sample catalog; stock quantities start empty by default

## Run

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Seeded access

- Admin user: `admin` / `admin123`
- Operator user: `operator` / `operator123`
- Registration key: `INVITE-OP-2026`

## Notes

- Data is stored locally in `data/inventory.db`.
- Controller/light actions are simulated and printed to server `stdout` with an `[RS485-SIM]` prefix.
- Runtime configuration is controlled with environment variables:
  - `NODE_ENV`
  - `SESSION_SECRET`
  - `HARDWARE_ADAPTER` (`simulator`, `degraded`, or `rs485`)
  - `WAREHOUSE_SITE_ID`
  - `LOG_LEVEL`
  - RS485 guidance burst vars: `RS485_GUIDANCE_BURST_REPEATS` (default `3`) and `RS485_GUIDANCE_BURST_DELAY_MS` (default `0`) resend active LED guidance across the full task plan to reduce missed LED updates.
  - LED brightness policy vars: `LED_DAY_BRIGHTNESS_PERCENT` (default `20`), `LED_NIGHT_BRIGHTNESS_PERCENT` (default `8`), `LED_DAY_START_HOUR` (default `6`), `LED_NIGHT_START_HOUR` (default `18`)
  - `DEMO_INVENTORY_SEED=1` if you explicitly want sample stock quantities for a throwaway demo database
  - optional production bootstrap admin vars: `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME`
- The seeded catalog includes items like combat boots, field uniforms, helmets, gloves, canteens, batteries, ration packs, medical pouches, and other field gear.
- The software does not use a reservation step for stock. Inventory is either still present in the cell or it has been picked.
- Put planning uses each product's `items per cell` value and tries to reuse partially filled cells first so the next put uses the minimum number of cells.
- Operators may still record real-world exceptions such as mixed-product cells or over-capacity cells; the software allows the action, then flags it under **Recommended actions**.
- Recommended actions suggest what to move, from which cell, and into which target cells, while still allowing the user to edit the suggestion before applying it.
- Server-rendered UI code is intended to stay organized by feature/domain with shared helpers for reusable rendering logic, so future edits remain understandable and scalable.
- On startup, the app now runs integrity checks, validates runtime config, clears stale hardware guidance for unfinished tasks, and records recovery events for the admin system view.
- If `HARDWARE_ADAPTER=degraded`, the app stays usable in manual guidance mode and records skipped hardware actions instead of failing task execution.

## Architecture

The codebase is organized as a local-first modular monolith with explicit UI, HTTP, service, domain, data-access, and shared layers. See `docs/architecture/02-codebase-architecture.md` for folder responsibilities and extension rules.
