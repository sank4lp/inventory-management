# Product Catalog Flow

## Goal

Allow products to be registered in advance so operators do not need to create full product definitions every time they perform a Put operation.

## Why this flow matters

The system should distinguish between:
- **product master data** (what the item is), and
- **inventory state** (where and how much of it exists).

## Core catalog actions

- create a product
- search a product with live filtering while typing
- edit product details
- archive/deactivate a product
- define preferred storage guidance
- review where the product is currently stored

## Recommended minimum product fields

### Mandatory in phase 1
- SKU / code
- product name
- category
- size / variant when applicable
- unit of measure
- brand
- items per cell
- active/inactive status

### Required when applicable
- category
- size / variant when the item type requires it

### Recommended but optional in early phase 1
- description
- barcode
- preferred cell or placement rule
- reorder threshold

## Validation rules

- Product code / SKU is required and must be unique.
- Product name is required and cannot be blank.
- Brand is required.
- Unit of measure is required.
- Items per cell is required and must be a positive number.
- Active/inactive status is required.
- Quantity is not a product-master field, but it is mandatory in Pick and Put transaction flows.
- If a category requires size/variant, that field must be provided before the product can be used operationally.

## Example flow: create product

1. User opens the catalog screen
2. User uses the distinctive **Add Product** button
3. A modal-style form opens on top of the catalog instead of replacing the catalog view
4. User enters required fields
5. System validates uniqueness rules
6. Product is saved
7. Product becomes searchable in Pick, Put, and catalog flows

## Product detail behavior

- Clicking a product opens a product detail view.
- The detail view shows which cells currently contain that product and how much is in each cell.
- Each listed cell can expose direct **Pick** and **Put** actions.

## Cell search behavior

- The software supports cell search from the Locations flow.
- Opening a cell detail view shows which products are currently present in that cell.
- The Locations list and cell detail view expose direct **Pick** and **Put** actions for each cell.
- A location-started **Pick** only offers products currently stocked in that location.
- This allows users to inspect a location from either direction: product-to-cells or cell-to-products.

## Items-per-cell rule

- `items per cell` is the ideal packing rule for automatic planning.
- Admins can change it later from the catalog or product detail area.
- If the value changes after stock has already been stored, the next put should use the updated value and aim for the minimum number of cells by refilling same-product cells first.
