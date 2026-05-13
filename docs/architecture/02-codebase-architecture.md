# Codebase Architecture

## Shape

The app is a local-first modular monolith. It is one deployable Node process with clear internal layers so inventory workflows can grow without turning route handlers, page renderers, or SQL modules into catch-all files.

## Layers and Folders

### Frontend/UI

- `src/server/pages/`: server-rendered page modules grouped by feature.
- `src/render.js`: shared HTML shell, navigation, formatting, and common render helpers.
- `public/app.js`: browser entrypoint that wires page behavior.
- `public/client/`: reusable browser-side primitives shared by multiple page behaviors.

UI code should render data, collect user input, wire interactions, and call backend endpoints. Inventory rules such as pick allocation, put placement, capacity validation, and stock mutation do not belong in UI code.

### Backend/HTTP

- `src/server.js`: request orchestration and route dispatch.
- `src/server/app-state.js`: application composition and dependency wiring.
- `src/server/http/`: response helpers, request-body parsing, and auth guards.
- `src/server/forms/`: form payload parsing and normalization at the HTTP boundary.
- `src/server/guidance/`: HTTP-facing guidance helpers for LED instructions that are not core stock rules.
- `src/server/static-assets.js`: static asset serving.

Route handlers should stay thin: check auth, parse request input, call one application service, then render or redirect. Reusable HTTP behavior belongs under `src/server/http` or `src/server/forms`.

### Application Services

- `src/services/`: use-case services that coordinate domain logic, repositories, hardware, logging, startup checks, backups, and tokens.
- `src/services/inventory.js`: compatibility facade for existing imports while inventory workflows continue moving into narrower domain/repository modules.

Services own use cases such as create product, plan pick, plan put, confirm task, correct task, apply recommended action, register user, issue key, or configure controller. Services should depend on repository/domain contracts rather than embedding new SQL or UI details.

### Domain

- `src/domain/inventory/`: framework-free inventory rules.

Domain modules should accept plain objects and return plain objects. They should not know about HTTP, HTML, SQLite, sessions, hardware adapters, or page rendering. Examples:

- `quantities.js`: shared quantity and capacity validation.
- `stock-planning.js`: pick allocation, put placement, and recommended-move planning.

When adding new inventory rules, start here if the rule can be expressed without persistence or framework concerns.

### Data Access

- `src/db.js`: SQLite connection, schema initialization, migrations, and seed data.
- `src/repositories/`: SQL access grouped by persistence concern.

Repositories hide query details from application services. Current repositories cover products, inventory balances, and tasks. New SQL for those concerns should go into the existing repository. New persistence areas should get a focused repository instead of adding raw queries to routes or UI.

### Shared/Common

- `src/shared/`: small cross-layer helpers with a clear purpose.

Keep shared modules narrow. Avoid dumping unrelated helpers into a generic utilities file.

## Extension Rules

### Add a New Inventory Workflow

1. Put pure rules in `src/domain/inventory`.
2. Add or extend a repository under `src/repositories` for needed persistence.
3. Add a service method under `src/services`.
4. Add route handling in `src/server.js` or a future route module.
5. Add page rendering under `src/server/pages` and browser wiring under `public/app.js` or `public/client`.
6. Add domain tests first, then workflow tests against a fresh database.

### Change Pick or Put Placement

Update `src/domain/inventory/stock-planning.js` first. Keep repository query ordering explicit and deterministic, then test the strategy with plain domain tests and the database-backed workflow tests.

### Add Product Fields

Update schema/migration and seed handling in `src/db.js`, persistence in `src/repositories/product-repository.js`, validation/service behavior in `src/services/catalog.js` or `src/services/inventory.js`, and rendering in `src/server/pages/products.js`.

### Add Routes or Form Actions

Use `src/server/http/auth-guards.js`, `src/server/http/responses.js`, and `src/server/forms` rather than duplicating parsing, redirects, flash handling, or authorization checks.

## Current Tradeoff

Some legacy controller, cell-mapping, and admin SQL still lives behind the inventory facade while the highest-risk stock workflows have been moved behind repositories and domain rules. Keep migrating those areas by concern as they change; avoid adding new broad functions to `src/services/inventory.js`.
