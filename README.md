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
- Admin adjustments and registration key issuing
- Task correction mode with owner-or-admin edit permissions
- Recommended actions for mixed-product cells and over-capacity cells
- Device, controller, and cell mapping visibility
- Launch-priority reports
- RS485 hardware command simulation via `stdout`
- Seeded with a simple army-warehouse-style sample inventory

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
- The seeded catalog includes items like combat boots, field uniforms, helmets, gloves, canteens, batteries, ration packs, medical pouches, and other field gear.
- Put planning uses each product's `items per cell` value and tries to reuse partially filled cells first so the next put uses the minimum number of cells.
- Operators may still record real-world exceptions such as mixed-product cells or over-capacity cells; the software allows the action, then flags it under **Recommended actions**.
- Recommended actions suggest what to move, from which cell, and into which target cells, while still allowing the user to edit the suggestion before applying it.
