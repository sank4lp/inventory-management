import assert from "node:assert/strict";
import test from "node:test";

import {
  planPickLines,
  planPutLines,
  planRecommendedMoveDestinations,
  PUT_CAPACITY_ERROR_MESSAGE,
} from "../src/domain/inventory/stock-planning.js";

test("pick planning allocates stock in candidate order and rejects insufficient quantity", () => {
  const product = { id: 42 };
  const balances = [
    { cell_id: 1, available_quantity: 2 },
    { cell_id: 2, available_quantity: 4 },
  ];

  assert.deepEqual(planPickLines({ product, requestedQuantity: 5, balances }), [
    { product_id: 42, cell_id: 1, planned_quantity: 2, guidance_color: "green" },
    { product_id: 42, cell_id: 2, planned_quantity: 3, guidance_color: "green" },
  ]);

  assert.throws(
    () => planPickLines({ product, requestedQuantity: 7, balances }),
    /Insufficient stock/,
  );
});

test("put planning fills preferred cell, same-product cells, then empty cells", () => {
  const product = { id: 42 };

  assert.deepEqual(
    planPutLines({
      product,
      requestedQuantity: 8,
      itemsPerCell: 5,
      preferredCell: { cell_id: 1, same_product_quantity: 4, occupied_quantity: 4 },
      sameProductCells: [{ cell_id: 2, available_quantity: 2 }],
      emptyCells: [{ cell_id: 3 }, { cell_id: 4 }],
    }),
    [
      { product_id: 42, cell_id: 1, planned_quantity: 1, guidance_color: "red" },
      { product_id: 42, cell_id: 2, planned_quantity: 3, guidance_color: "red" },
      { product_id: 42, cell_id: 3, planned_quantity: 4, guidance_color: "red" },
    ],
  );

  assert.throws(
    () =>
      planPutLines({
        product,
        requestedQuantity: 11,
        itemsPerCell: 5,
        preferredCell: null,
        sameProductCells: [],
        emptyCells: [{ cell_id: 3 }, { cell_id: 4 }],
      }),
    new RegExp(PUT_CAPACITY_ERROR_MESSAGE),
  );
});

test("put planning can prioritize multiple preferred cells before fallback cells", () => {
  const product = { id: 42 };

  assert.deepEqual(
    planPutLines({
      product,
      requestedQuantity: 7,
      itemsPerCell: 5,
      preferredCells: [
        { cell_id: 4, same_product_quantity: 3, occupied_quantity: 3 },
        { cell_id: 1, same_product_quantity: 4, occupied_quantity: 4 },
      ],
      sameProductCells: [
        { cell_id: 4, available_quantity: 3 },
        { cell_id: 2, available_quantity: 1 },
      ],
      emptyCells: [{ cell_id: 3 }],
    }),
    [
      { product_id: 42, cell_id: 4, planned_quantity: 2, guidance_color: "red" },
      { product_id: 42, cell_id: 1, planned_quantity: 1, guidance_color: "red" },
      { product_id: 42, cell_id: 2, planned_quantity: 4, guidance_color: "red" },
    ],
  );
});

test("recommended move planning reports unresolved quantity when no destination has room", () => {
  const plan = planRecommendedMoveDestinations({
    sourceCellId: 5,
    requestedQuantity: 9,
    itemsPerCell: 4,
    sameProductCells: [{ cell_id: 2, logical_code: "Z1-R1-C02", available_quantity: 3 }],
    emptyCells: [{ cell_id: 3, logical_code: "Z1-R1-C03" }],
  });

  assert.equal(plan.sourceCellId, 5);
  assert.deepEqual(plan.destinations, [
    {
      targetCellId: 2,
      targetLogicalCode: "Z1-R1-C02",
      quantity: 1,
      currentQuantity: 3,
      idealCapacity: 4,
    },
    {
      targetCellId: 3,
      targetLogicalCode: "Z1-R1-C03",
      quantity: 4,
      currentQuantity: 0,
      idealCapacity: 4,
    },
  ]);
  assert.equal(plan.unresolvedQuantity, 4);
});
