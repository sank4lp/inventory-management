import { randomBytes } from "node:crypto";

import { withTransaction } from "../db.js";
import { createInventoryBalanceRepository } from "../repositories/inventory-balance-repository.js";
import { createProductRepository } from "../repositories/product-repository.js";
import { createTaskRepository } from "../repositories/task-repository.js";
import {
  assertSufficientBalance,
  normalizeItemsPerCell,
  normalizeNonNegativeQuantity,
  normalizePositiveQuantity,
} from "../domain/inventory/quantities.js";
import {
  planPickLines,
  planPutLines,
  planRecommendedMoveDestinations,
  PUT_CAPACITY_ERROR_MESSAGE as DOMAIN_PUT_CAPACITY_ERROR_MESSAGE,
} from "../domain/inventory/stock-planning.js";
import { nowIso } from "../shared/time.js";
import { ESP32_FIRMWARE_PROTOCOL } from "./firmware-constants.js";

export const PUT_CAPACITY_ERROR_MESSAGE = DOMAIN_PUT_CAPACITY_ERROR_MESSAGE;

function generateRegistrationKeyValue(role = "operator") {
  const prefix = role === "admin" ? "ADM" : "OP";
  const stamp = Date.now().toString(36).toUpperCase();
  const token = randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${stamp}-${token}`;
}

function displayQuantity(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(number).replace(/\.?0+$/, "");
}

function moveSuggestions(db, { productId, sourceCellId, quantity }) {
  const product = findProductOrThrow(db, Number(productId));
  const balances = createInventoryBalanceRepository(db);
  const itemsPerCell = normalizeItemsPerCell(product.items_per_cell);
  const requestedQuantity = normalizePositiveQuantity(quantity);
  const plan = planRecommendedMoveDestinations({
    sourceCellId,
    requestedQuantity,
    itemsPerCell,
    sameProductCells: balances.listSameProductMoveTargets(product.id, sourceCellId),
    emptyCells: balances.listEmptyMoveTargets(sourceCellId),
  });

  return {
    product,
    sourceCellId: plan.sourceCellId,
    requestedQuantity,
    destinations: plan.destinations,
    unresolvedQuantity: plan.unresolvedQuantity,
  };
}

function getActiveCell(db, cellId, message = "Selected cell is not active.") {
  const cell = db
    .prepare("SELECT * FROM cells WHERE id = ? AND active = 1")
    .get(Number(cellId));
  if (!cell) {
    throw new Error(message);
  }
  return cell;
}

function assertPutCellEligible(db, { productId, cellId }) {
  const cell = getActiveCell(db, cellId, "Selected put cell is not active.");
  const otherProduct = db
    .prepare(
      `
        SELECT p.sku
        FROM inventory_balances b
        JOIN products p ON p.id = b.product_id
        WHERE b.cell_id = ?
          AND b.product_id != ?
          AND b.available_quantity > 0
        LIMIT 1
      `,
    )
    .get(Number(cellId), Number(productId));

  if (otherProduct) {
    throw new Error(
      `Cell ${cell.logical_code} already contains ${otherProduct.sku}. Choose an empty cell or a cell with the same product.`,
    );
  }

  return cell;
}

function getPickCellAvailability(db, { productId, cellId }) {
  const cell = db
    .prepare(
      `
        SELECT
          c.*,
          b.id AS balance_id,
          COALESCE(b.available_quantity, 0) AS available_quantity
        FROM cells c
        LEFT JOIN inventory_balances b
          ON b.cell_id = c.id AND b.product_id = ?
        WHERE c.id = ? AND c.active = 1
      `,
    )
    .get(Number(productId), Number(cellId));

  if (!cell) {
    throw new Error("Selected pick cell is not active.");
  }

  return cell;
}

function buildCellAnomalies(db) {
  const cells = db
    .prepare(
      `
        SELECT
          c.id AS cell_id,
          c.logical_code,
          p.id AS product_id,
          p.sku,
          p.name,
          p.items_per_cell,
          COALESCE(b.available_quantity, 0) AS available_quantity
        FROM cells c
        JOIN inventory_balances b ON b.cell_id = c.id
        JOIN products p ON p.id = b.product_id
        WHERE c.active = 1 AND b.available_quantity > 0
        ORDER BY c.row_number, c.column_number, p.name
      `,
    )
    .all();

  const grouped = new Map();
  for (const row of cells) {
    const key = row.cell_id;
    const entry = grouped.get(key) || {
      cellId: row.cell_id,
      logicalCode: row.logical_code,
      products: [],
    };
    entry.products.push({
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      totalQuantity: Number(row.available_quantity),
      itemsPerCell: Number(row.items_per_cell),
    });
    grouped.set(key, entry);
  }

  const anomalies = [];

  for (const cell of grouped.values()) {
    if (cell.products.length > 1) {
      const moveProduct = [...cell.products].sort((a, b) => a.totalQuantity - b.totalQuantity)[0];
      const suggestion = moveSuggestions(db, {
        productId: moveProduct.productId,
        sourceCellId: cell.cellId,
        quantity: moveProduct.totalQuantity,
      });
      anomalies.push({
        key: `mixed-${cell.cellId}-${moveProduct.productId}`,
        type: "mixed_cell",
        severity: "warning",
        cellId: cell.cellId,
        logicalCode: cell.logicalCode,
        title: `${cell.logicalCode} has mixed products`,
        description: `${cell.products.map((item) => `${item.sku} (${item.totalQuantity})`).join(", ")}`,
        actionSummary: `Move ${moveProduct.sku} from ${cell.logicalCode} into its own cell(s).`,
        productId: moveProduct.productId,
        productSku: moveProduct.sku,
        productName: moveProduct.name,
        quantityToMove: moveProduct.totalQuantity,
        recommendedMoves: suggestion.destinations,
        unresolvedQuantity: suggestion.unresolvedQuantity,
      });
    }

    for (const product of cell.products) {
      if (product.totalQuantity > product.itemsPerCell) {
        const excessQuantity = product.totalQuantity - product.itemsPerCell;
        const suggestion = moveSuggestions(db, {
          productId: product.productId,
          sourceCellId: cell.cellId,
          quantity: excessQuantity,
        });
        anomalies.push({
          key: `overflow-${cell.cellId}-${product.productId}`,
          type: "over_capacity",
          severity: "alert",
          cellId: cell.cellId,
          logicalCode: cell.logicalCode,
          title: `${product.sku} exceeds ideal capacity in ${cell.logicalCode}`,
          description: `Stored ${product.totalQuantity}, ideal ${product.itemsPerCell}`,
          actionSummary: `Move the excess ${product.sku} quantity out of ${cell.logicalCode}.`,
          productId: product.productId,
          productSku: product.sku,
          productName: product.name,
          quantityToMove: excessQuantity,
          recommendedMoves: suggestion.destinations,
          unresolvedQuantity: suggestion.unresolvedQuantity,
        });
      }
    }
  }

  return anomalies;
}

export function listProducts(db, search = "") {
  return createProductRepository(db).list(search);
}

export function getProductDetail(db, productId) {
  return createProductRepository(db).getDetail(productId);
}

export function createProduct(db, input) {
  const required = [
    ["sku", "SKU is required."],
    ["name", "Product name is required."],
    ["brand", "Brand is required."],
    ["unit_of_measure", "Unit of measure is required."],
  ];

  for (const [field, message] of required) {
    if (!String(input[field] || "").trim()) {
      throw new Error(message);
    }
  }

  const itemsPerCell = normalizeItemsPerCell(input.items_per_cell || 12);
  const normalizedProduct = {
    sku: input.sku.trim().toUpperCase(),
    name: input.name.trim(),
    brand: input.brand.trim(),
    category: input.category?.trim() || null,
    variant: input.variant?.trim() || null,
    unit_of_measure: input.unit_of_measure.trim(),
    description: input.description?.trim() || null,
    preferred_storage_strategy: input.preferred_storage_strategy?.trim() || "closest-cell-first",
    items_per_cell: itemsPerCell,
    active: input.active === "0" ? 0 : 1,
  };

  const products = createProductRepository(db);
  const existing = products.findAnyBySku(normalizedProduct.sku);
  if (existing && Number(existing.active) === 1) {
    throw new Error("A product with that SKU already exists.");
  }

  if (existing) {
    return products.restore(existing.id, normalizedProduct);
  }

  return products.create(normalizedProduct);
}

export function removeProduct(db, productId) {
  return withTransaction(db, () => {
    const products = createProductRepository(db);
    const product = products.findById(productId);
    if (!product) {
      throw new Error("Product not found.");
    }

    const totals = products.stockTotals(product.id);
    const remainingStock =
      Number(totals?.total_available || 0) + Number(totals?.total_reserved || 0);
    if (remainingStock > 0) {
      throw new Error(
        "Product stock must be 0 before it can be removed. Create a Pick task to remove stock first.",
      );
    }

    const result = products.deactivate(product.id);
    if (result.changes === 0) {
      throw new Error("Product not found.");
    }

    return {
      ...product,
      active: 0,
    };
  });
}

export function updateProductDetails(db, input) {
  const productId = Number(input.productId);
  const required = [
    ["name", "Product name is required."],
    ["brand", "Brand is required."],
    ["unit_of_measure", "Unit of measure is required."],
  ];

  for (const [field, message] of required) {
    if (!String(input[field] || "").trim()) {
      throw new Error(message);
    }
  }

  const products = createProductRepository(db);
  const product = products.findById(productId);
  if (!product) {
    throw new Error("Product not found.");
  }

  return products.updateDetails(product.id, {
    name: input.name.trim(),
    brand: input.brand.trim(),
    category: input.category?.trim() || null,
    variant: input.variant?.trim() || null,
    unit_of_measure: input.unit_of_measure.trim(),
    description: input.description?.trim() || null,
    preferred_storage_strategy: input.preferred_storage_strategy?.trim() || product.preferred_storage_strategy || "closest-cell-first",
  });
}

function findProductOrThrow(db, productId) {
  const product = createProductRepository(db).findById(productId);
  if (!product) {
    throw new Error("Product not found.");
  }
  return product;
}

export function getTask(db, taskId) {
  return createTaskRepository(db).get(taskId);
}

export function listRecentTasks(db, limit = 10) {
  return createTaskRepository(db).listRecent(limit);
}

export function listRecentTasksForUser(db, user, limit = 10) {
  return createTaskRepository(db).listRecentForUser(user, limit);
}

export function listRecentTasksForProfileUser(db, userId, limit = 10) {
  return createTaskRepository(db).listRecentForProfileUser(userId, limit);
}

export function allocatePick(db, { userId, productId, quantity, preferredCellId = null }) {
  const requestedQuantity = normalizePositiveQuantity(quantity);
  const product = findProductOrThrow(db, Number(productId));
  const balances = createInventoryBalanceRepository(db);
  const lines = planPickLines({
    product,
    requestedQuantity,
    balances: balances.listPickCandidates(product.id, preferredCellId),
  });

  return withTransaction(db, () => {
    const tasks = createTaskRepository(db);
    const task = tasks.createPendingReviewTask({
      type: "pick",
      summary: `${product.sku} pick (${requestedQuantity} ${product.unit_of_measure})`,
      createdBy: userId,
      lines,
    });
    tasks.updateSummary(
      task.id,
      `Pick ${displayQuantity(requestedQuantity)} ${product.unit_of_measure} of ${product.sku}`,
    );
    return tasks.get(task.id);
  });
}

export function planPut(db, { userId, productId, quantity, preferredCellId = null }) {
  const requestedQuantity = normalizePositiveQuantity(quantity);
  const product = findProductOrThrow(db, Number(productId));
  const balances = createInventoryBalanceRepository(db);
  const itemsPerCell = normalizeItemsPerCell(product.items_per_cell);
  if (preferredCellId) {
    assertPutCellEligible(db, { productId: product.id, cellId: preferredCellId });
  }
  const lines = planPutLines({
    product,
    requestedQuantity,
    itemsPerCell,
    preferredCell: balances.getPreferredPutCell(preferredCellId, product.id),
    sameProductCells: balances.listSameProductPutCells(product.id, preferredCellId),
    emptyCells: balances.listEmptyPutCells(product.id, preferredCellId),
  });

  return withTransaction(db, () => {
    const tasks = createTaskRepository(db);
    const task = tasks.createPendingReviewTask({
      type: "put",
      summary: `${product.sku} put (${requestedQuantity} ${product.unit_of_measure})`,
      createdBy: userId,
      lines,
    });
    tasks.updateSummary(
      task.id,
      `Put ${displayQuantity(requestedQuantity)} ${product.unit_of_measure} of ${product.sku}`,
    );
    return tasks.get(task.id);
  });
}

export function cancelTask(db, { taskId }) {
  const task = getTask(db, Number(taskId));
  if (!task) {
    throw new Error("Task not found.");
  }

  if (task.status === "completed") {
    throw new Error("Completed tasks cannot be cancelled.");
  }

  if (task.status === "cancelled") {
    throw new Error("Task is already cancelled.");
  }

  return withTransaction(db, () => {
    const tasks = createTaskRepository(db);
    tasks.updateStatus(task.id, "cancelled");
    return tasks.get(task.id);
  });
}

export function completeTask(db, { taskId, actualQuantities, actualCellIds, userId, note }) {
  const task = getTask(db, Number(taskId));
  if (!task) {
    throw new Error("Task not found.");
  }

  if (task.status === "completed") {
    throw new Error("Task is already completed.");
  }

  if (task.status === "cancelled") {
    throw new Error("Cancelled tasks cannot be completed.");
  }

  return withTransaction(db, () => {
    const balances = createInventoryBalanceRepository(db);
    const tasks = createTaskRepository(db);
    const touchedCellIds = new Set();

    for (const line of task.lines) {
      const actualValue = actualQuantities[line.id] ?? line.planned_quantity;
      const actualQuantity = normalizeNonNegativeQuantity(actualValue, "Actual quantity values must be zero or greater.");
      const exceptionQuantity = Math.max(0, Number(line.planned_quantity) - actualQuantity);
      const targetCellId = Number(actualCellIds?.[line.id] || line.cell_id);

      if (task.type === "pick") {
        const pickCell = getPickCellAvailability(db, {
          productId: line.product_id,
          cellId: targetCellId,
        });

        if (actualQuantity > Number(pickCell.available_quantity)) {
          throw new Error(
            `Cell ${pickCell.logical_code} only has ${Number(pickCell.available_quantity)} item(s) left for ${line.sku}. Choose another eligible cell or reduce the quantity.`,
          );
        }

        tasks.updateLineActual({
          lineId: line.id,
          actualQuantity,
          exceptionQuantity,
          note: note || null,
          cellId: targetCellId,
        });

        if (actualQuantity > 0) {
          balances.decrease(pickCell.balance_id, actualQuantity);
        }
        touchedCellIds.add(targetCellId);

        if (actualQuantity > 0) {
          db.prepare(
            `
              INSERT INTO transactions (
                type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
              )
              VALUES ('pick', ?, ?, ?, ?, ?, ?, ?)
            `,
          ).run(
            line.product_id,
            targetCellId,
            -actualQuantity,
            userId,
            task.id,
            note || "Pick confirmation",
            nowIso(),
          );
        }
      } else if (task.type === "put") {
        assertPutCellEligible(db, {
          productId: line.product_id,
          cellId: targetCellId,
        });

        tasks.updateLineActual({
          lineId: line.id,
          actualQuantity,
          exceptionQuantity,
          note: note || null,
          cellId: targetCellId,
        });

        const targetBalance = balances.getOrCreate(line.product_id, targetCellId);
        balances.increase(targetBalance.id, actualQuantity);
        touchedCellIds.add(targetCellId);

        if (actualQuantity > 0) {
          db.prepare(
            `
              INSERT INTO transactions (
                type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
              )
              VALUES ('put', ?, ?, ?, ?, ?, ?, ?)
            `,
          ).run(
            line.product_id,
            targetCellId,
            actualQuantity,
            userId,
            task.id,
            note || "Put confirmation",
            nowIso(),
          );
        }
      }
    }

    tasks.updateStatus(task.id, "completed");

    return {
      task: tasks.get(task.id),
      anomalies: detectAnomalies(db).filter((anomaly) => touchedCellIds.has(anomaly.cellId)),
    };
  });
}

export function updatePendingPutPlan(db, { taskId, allocations, note = null }) {
  const task = getTask(db, Number(taskId));
  if (!task) {
    throw new Error("Task not found.");
  }

  if (task.type !== "put") {
    throw new Error("Only PUT tasks can be adjusted this way.");
  }

  if (task.status === "completed") {
    throw new Error("Completed tasks cannot be adjusted.");
  }

  if (task.status === "cancelled") {
    throw new Error("Cancelled tasks cannot be adjusted.");
  }

  const productId = task.lines[0]?.product_id;
  if (!productId) {
    throw new Error("Task has no product lines to adjust.");
  }

  const nextAllocations = [];
  const seenCells = new Set();

  for (const allocation of allocations || []) {
    const cellId = Number(allocation.cellId);
    const quantity = normalizeNonNegativeQuantity(
      allocation.quantity,
      "Adjusted put quantities must be zero or greater.",
    );
    if (quantity <= 0) {
      continue;
    }
    if (!Number.isInteger(cellId) || cellId <= 0) {
      throw new Error("Choose a valid cell for each adjusted put line.");
    }
    if (seenCells.has(cellId)) {
      throw new Error("Each adjusted put cell can appear only once.");
    }
    assertPutCellEligible(db, { productId, cellId });
    seenCells.add(cellId);
    nextAllocations.push({ cellId, quantity });
  }

  if (!nextAllocations.length) {
    throw new Error("Add at least one cell with a quantity greater than zero.");
  }

  return withTransaction(db, () => {
    const tasks = createTaskRepository(db);
    tasks.deleteLines(task.id);
    for (const allocation of nextAllocations) {
      tasks.addPutPlanLine(task.id, {
        productId,
        cellId: allocation.cellId,
        quantity: allocation.quantity,
        note: note || null,
      });
    }
    tasks.touchTask(task.id);
    return tasks.get(task.id);
  });
}

export function correctCompletedTask(
  db,
  { taskId, actualQuantities, actualCellIds, userId, note },
) {
  const task = getTask(db, Number(taskId));
  if (!task) {
    throw new Error("Task not found.");
  }

  if (task.status !== "completed") {
    throw new Error("Only completed tasks can be corrected.");
  }

  return withTransaction(db, () => {
    const balances = createInventoryBalanceRepository(db);
    const tasks = createTaskRepository(db);
    const touchedCellIds = new Set();

    for (const line of task.lines) {
      const previousQuantity = Number(line.actual_quantity);
      const nextQuantity = Number(actualQuantities[line.id] ?? previousQuantity);
      const nextCellId = Number(actualCellIds?.[line.id] || line.cell_id);

      if (!Number.isFinite(nextQuantity) || nextQuantity < 0) {
        throw new Error("Corrected quantities must be zero or greater.");
      }

      const oldBalance = balances.getOrCreate(line.product_id, line.cell_id);

      if (task.type === "pick") {
        const nextPickCell = getPickCellAvailability(db, {
          productId: line.product_id,
          cellId: nextCellId,
        });
        const nextAvailable =
          Number(nextPickCell.available_quantity) +
          (Number(nextCellId) === Number(line.cell_id) ? previousQuantity : 0);

        if (nextAvailable < nextQuantity) {
          throw new Error(
            `Cell ${nextPickCell.logical_code} no longer has enough stock to apply this correction safely.`,
          );
        }

        balances.increase(oldBalance.id, previousQuantity);

        db.prepare(
          `
            INSERT INTO transactions (
              type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
            )
            VALUES ('adjustment', ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          line.product_id,
          line.cell_id,
          previousQuantity,
          userId,
          task.id,
          note || `Correction reversal for task #${task.id}`,
          nowIso(),
        );

        const nextBalance = balances.getOrCreate(line.product_id, nextCellId);
        balances.decrease(nextBalance.id, nextQuantity);

        db.prepare(
          `
            INSERT INTO transactions (
              type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
            )
            VALUES ('adjustment', ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          line.product_id,
          nextCellId,
          -nextQuantity,
          userId,
          task.id,
          note || `Correction applied for task #${task.id}`,
          nowIso(),
        );

        touchedCellIds.add(Number(line.cell_id));
        touchedCellIds.add(nextCellId);
      } else if (task.type === "put") {
        assertPutCellEligible(db, {
          productId: line.product_id,
          cellId: nextCellId,
        });

        assertSufficientBalance(
          oldBalance,
          previousQuantity,
          `Cell ${line.logical_code} no longer contains the previously recorded quantity, so this correction cannot be applied safely.`,
        );

        balances.decrease(oldBalance.id, previousQuantity);

        db.prepare(
          `
            INSERT INTO transactions (
              type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
            )
            VALUES ('adjustment', ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          line.product_id,
          line.cell_id,
          -previousQuantity,
          userId,
          task.id,
          note || `Correction reversal for task #${task.id}`,
          nowIso(),
        );

        const newBalance = balances.getOrCreate(line.product_id, nextCellId);
        balances.increase(newBalance.id, nextQuantity);

        db.prepare(
          `
            INSERT INTO transactions (
              type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
            )
            VALUES ('adjustment', ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          line.product_id,
          nextCellId,
          nextQuantity,
          userId,
          task.id,
          note || `Correction applied for task #${task.id}`,
          nowIso(),
        );

        touchedCellIds.add(Number(line.cell_id));
        touchedCellIds.add(nextCellId);
      }

      const nextExceptionQuantity = Math.max(0, Number(line.planned_quantity) - nextQuantity);
      tasks.updateLineActual({
        lineId: line.id,
        actualQuantity: nextQuantity,
        exceptionQuantity: nextExceptionQuantity,
        note: note || line.note,
        cellId: nextCellId,
      });
    }

    return {
      task: tasks.get(task.id),
      anomalies: detectAnomalies(db).filter((anomaly) => touchedCellIds.has(anomaly.cellId)),
    };
  });
}

export function markPhysicalConfirmation(db, lineId) {
  const tasks = createTaskRepository(db);
  const line = tasks.findLineWithCell(lineId);

  if (!line) {
    throw new Error("Task line not found.");
  }

  tasks.markLinePhysicalConfirmed(line.id);
  return tasks.findLineWithCell(line.id);
}

export function createAdjustment(db, { productId, cellId, quantityDelta, userId, reason, lines }) {
  const cell = db.prepare("SELECT * FROM cells WHERE id = ?").get(Number(cellId));
  if (!cell) {
    throw new Error("Cell not found.");
  }

  if (!String(reason || "").trim()) {
    throw new Error("Adjustment reason is required.");
  }

  const incomingLines =
    Array.isArray(lines) && lines.length
      ? lines
      : [{ productId, quantityDelta }];

  const normalizedLines = incomingLines.map((line, index) => {
    const lineProductId = Number(line.productId);

    if (!lineProductId) {
      throw new Error(`Choose a product for adjustment line ${index + 1}.`);
    }

    const hasAbsoluteQuantity =
      line.absoluteQuantity !== undefined && String(line.absoluteQuantity).trim() !== "";

    if (hasAbsoluteQuantity) {
      const absoluteQuantity = Number(line.absoluteQuantity);
      if (!Number.isFinite(absoluteQuantity) || absoluteQuantity < 0) {
        throw new Error(`Final quantity for line ${index + 1} must be zero or greater.`);
      }

      return {
        product: findProductOrThrow(db, lineProductId),
        absoluteQuantity,
      };
    }

    const delta = Number(line.quantityDelta);
    if (!Number.isFinite(delta) || delta === 0) {
      throw new Error(`Adjustment delta for line ${index + 1} must be non-zero.`);
    }

    return {
      product: findProductOrThrow(db, lineProductId),
      delta,
    };
  });

  const seenProductIds = new Set();
  for (const line of normalizedLines) {
    if (seenProductIds.has(line.product.id)) {
      throw new Error(`Product ${line.product.sku} appears more than once in this adjustment batch.`);
    }
    seenProductIds.add(line.product.id);
  }

  return withTransaction(db, () => {
    const balances = createInventoryBalanceRepository(db);
    let appliedCount = 0;

    for (const line of normalizedLines) {
      const balance = balances.getOrCreate(line.product.id, cell.id);
      const delta =
        line.absoluteQuantity !== undefined
          ? Number(line.absoluteQuantity) - Number(balance.available_quantity)
          : Number(line.delta);

      if (delta === 0) {
        continue;
      }

      if (Number(balance.available_quantity) + delta < 0) {
        throw new Error(
          `Adjustment for ${line.product.sku} would make the cell quantity negative.`,
        );
      }

      balances.increase(balance.id, delta);

      db.prepare(
        `
          INSERT INTO transactions (
            type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
          )
          VALUES ('adjustment', ?, ?, ?, ?, NULL, ?, ?)
        `,
      ).run(line.product.id, cell.id, delta, userId, reason.trim(), nowIso());
      appliedCount += 1;
    }

    if (appliedCount === 0) {
      throw new Error("No adjustment was needed because the entered quantities already match the current values.");
    }
  });
}

export function dashboardStats(db) {
  return {
    products: db.prepare("SELECT COUNT(*) AS count FROM products WHERE active = 1").get().count,
    cells: db.prepare("SELECT COUNT(*) AS count FROM cells WHERE active = 1").get().count,
    controllers: db.prepare("SELECT COUNT(*) AS count FROM controllers WHERE active = 1").get().count,
    openTasks: db
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status NOT IN ('completed', 'cancelled')")
      .get().count,
    transactions: db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count,
  };
}

export function detectAnomalies(db) {
  return buildCellAnomalies(db);
}

export function getRecommendedActions(db) {
  return detectAnomalies(db).map((anomaly) => {
    const cell = db.prepare("SELECT id, logical_code FROM cells WHERE id = ?").get(anomaly.cellId);
    return {
      ...anomaly,
      sourceCell: cell,
    };
  });
}

export function listUsers(db) {
  return db
    .prepare(
      `
        SELECT id, name, username, role, status, created_at, last_active_at
        FROM users
        ORDER BY role DESC, username
      `,
    )
    .all();
}

export function updateUserLastActive(db, userId, activeAt = nowIso()) {
  const cutoff = new Date(new Date(activeAt).getTime() - 60 * 1000).toISOString();
  db.prepare(
    `
      UPDATE users
      SET last_active_at = ?
      WHERE id = ?
        AND (
          last_active_at IS NULL
          OR last_active_at < ?
        )
    `,
  ).run(activeAt, Number(userId), cutoff);
}

export function getUserProfile(db, userId) {
  const profile = db
    .prepare(
      `
        SELECT id, name, username, role, status, created_at, last_active_at
        FROM users
        WHERE id = ?
      `,
    )
    .get(Number(userId));
  if (!profile) {
    return null;
  }

  const activity = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM tasks WHERE created_by = ?) AS tasks_created,
          (SELECT COUNT(*) FROM tasks WHERE created_by = ? AND status = 'completed') AS tasks_completed,
          (SELECT COUNT(*) FROM transactions WHERE user_id = ?) AS transactions_recorded,
          (
            SELECT MAX(COALESCE(completed_at, started_at))
            FROM tasks
            WHERE created_by = ?
          ) AS last_task_at,
          (
            SELECT MAX(created_at)
            FROM transactions
            WHERE user_id = ?
          ) AS last_transaction_at
      `,
    )
    .get(profile.id, profile.id, profile.id, profile.id, profile.id);

  return {
    ...profile,
    activity: {
      tasksCreated: Number(activity.tasks_created || 0),
      tasksCompleted: Number(activity.tasks_completed || 0),
      transactionsRecorded: Number(activity.transactions_recorded || 0),
      lastTaskAt: activity.last_task_at || null,
      lastTransactionAt: activity.last_transaction_at || null,
    },
  };
}

export function listRegistrationKeys(db) {
  return db
    .prepare(
      `
        SELECT rk.*, u.username AS created_by_username
        FROM registration_keys rk
        LEFT JOIN users u ON u.id = rk.created_by
        ORDER BY rk.id DESC
      `,
    )
    .all();
}

export function issueRegistrationKey(db, { keyValue, role, userId, usagePolicy = "single_use" }) {
  const normalizedRole = role === "admin" ? "admin" : "operator";
  const normalized = String(keyValue || "").trim() || generateRegistrationKeyValue(normalizedRole);
  const normalizedUsagePolicy =
    normalizedRole === "operator" && usagePolicy === "global" ? "global" : "single_use";
  const expiresAt =
    normalizedUsagePolicy === "global"
      ? null
      : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(
    `
      INSERT INTO registration_keys (key_value, role, status, usage_policy, usage_count, expires_at, created_by, created_at)
      VALUES (?, ?, 'active', ?, 0, ?, ?, ?)
    `,
  ).run(
    normalized,
    normalizedRole,
    normalizedUsagePolicy,
    expiresAt,
    userId,
    nowIso(),
  );

  return db
    .prepare("SELECT * FROM registration_keys WHERE id = ?")
    .get(result.lastInsertRowid);
}

export function revokeRegistrationKey(db, { keyId }) {
  const key = db
    .prepare("SELECT * FROM registration_keys WHERE id = ?")
    .get(Number(keyId));

  if (!key) {
    throw new Error("Registration key not found.");
  }

  if (key.status !== "active") {
    throw new Error("Only active registration keys can be revoked.");
  }

  db.prepare("UPDATE registration_keys SET status = 'revoked' WHERE id = ?").run(key.id);

  return db
    .prepare("SELECT * FROM registration_keys WHERE id = ?")
    .get(key.id);
}

export function registerUser(db, { registrationKey, name, username, password, hashPassword }) {
  const key = db
    .prepare(
      `
        SELECT *
        FROM registration_keys
        WHERE key_value = ?
      `,
    )
    .get(String(registrationKey || "").trim());

  if (!key) {
    throw new Error("Registration key not found.");
  }

  if (key.status !== "active") {
    throw new Error("Registration key is not active.");
  }

  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    throw new Error("Registration key has expired.");
  }

  if (!String(name || "").trim() || !String(username || "").trim() || !String(password || "").trim()) {
    throw new Error("Name, username, and password are required.");
  }

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim());
  if (existing) {
    throw new Error("Username is already in use.");
  }

  return withTransaction(db, () => {
    const result = db
      .prepare(
        `
          INSERT INTO users (name, username, password_hash, role, status, created_by, created_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
        `,
      )
      .run(
        name.trim(),
        username.trim(),
        hashPassword(password.trim()),
        key.role,
        key.created_by,
        nowIso(),
      );

    if (key.usage_policy === "global") {
      db.prepare(
        `
          UPDATE registration_keys
          SET usage_count = usage_count + 1, used_by = ?, used_at = ?
          WHERE id = ?
        `,
      ).run(Number(result.lastInsertRowid), nowIso(), key.id);
    } else {
      db.prepare(
        `
          UPDATE registration_keys
          SET status = 'used', usage_count = 1, used_by = ?, used_at = ?
          WHERE id = ?
        `,
      ).run(Number(result.lastInsertRowid), nowIso(), key.id);
    }

    return db
      .prepare(
        "SELECT id, name, username, role, status FROM users WHERE id = ?",
      )
      .get(Number(result.lastInsertRowid));
  });
}

export function authenticateUser(db, { username, password, verifyPassword }) {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim());
  if (!user || user.status !== "active") {
    throw new Error("Invalid username or password.");
  }

  if (!verifyPassword(password, user.password_hash)) {
    throw new Error("Invalid username or password.");
  }

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    status: user.status,
  };
}

export function setUserStatus(db, { userId, status, actingUserId }) {
  const nextStatus = String(status || "").trim().toLowerCase();
  if (!["active", "inactive"].includes(nextStatus)) {
    throw new Error("User status must be active or inactive.");
  }

  const targetUser = db
    .prepare("SELECT id, name, username, role, status FROM users WHERE id = ?")
    .get(Number(userId));
  if (!targetUser) {
    throw new Error("User not found.");
  }

  if (nextStatus === "inactive") {
    if (Number(targetUser.id) === Number(actingUserId)) {
      throw new Error("You cannot suspend your own account.");
    }

    if (targetUser.role === "admin") {
      const remainingActiveAdmins = db
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM users
            WHERE role = 'admin' AND status = 'active' AND id != ?
          `,
        )
        .get(targetUser.id).count;

      if (Number(remainingActiveAdmins) < 1) {
        throw new Error("At least one active admin account is required.");
      }
    }
  }

  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(nextStatus, targetUser.id);

  return db
    .prepare("SELECT id, name, username, role, status FROM users WHERE id = ?")
    .get(targetUser.id);
}

export function listCells(db) {
  return db
    .prepare(
      `
        SELECT
          c.*,
          z.code AS zone_code,
          ctrl.controller_code,
          ctrl.address AS controller_address,
          ctrl.active AS controller_active,
          ctrl.heartbeat_status AS controller_health,
          ctrl.module_count AS controller_module_count,
          COALESCE(SUM(b.available_quantity), 0) AS occupied_quantity,
          COALESCE(SUM(b.reserved_quantity), 0) AS reserved_quantity,
          (
            SELECT COUNT(*)
            FROM inventory_balances balance_count
            WHERE balance_count.cell_id = c.id
              AND (balance_count.available_quantity != 0 OR balance_count.reserved_quantity != 0)
          ) AS balance_record_count,
          (SELECT COUNT(*) FROM task_lines tl_count WHERE tl_count.cell_id = c.id) AS task_line_count,
          (SELECT COUNT(*) FROM transactions tr_count WHERE tr_count.cell_id = c.id) AS transaction_count,
          (SELECT COUNT(*) FROM device_events event_count WHERE event_count.cell_id = c.id) AS device_event_count,
          COALESCE(
            GROUP_CONCAT(
              CASE
                WHEN b.available_quantity > 0 AND p.sku IS NOT NULL
                THEN p.sku || ' (' || CAST(b.available_quantity AS TEXT) || ')'
              END,
              ', '
            ),
            ''
          ) AS inventory_summary
        FROM cells c
        JOIN zones z ON z.id = c.zone_id
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        LEFT JOIN inventory_balances b ON b.cell_id = c.id
        LEFT JOIN products p ON p.id = b.product_id
        WHERE c.active = 1
        GROUP BY c.id
        ORDER BY ctrl.id, c.hardware_channel, c.row_number, c.column_number
      `,
    )
    .all();
}

function ensureOnlineControllerModuleRows(db) {
  const controllers = db
    .prepare(
      `
        SELECT *
        FROM controllers
        WHERE active = 1
          AND heartbeat_status = 'online'
          AND COALESCE(module_count, 0) > 0
        ORDER BY id
      `,
    )
    .all();

  for (const controller of controllers) {
    const moduleCount = Number(controller.module_count || 0);
    for (let channel = 1; channel <= moduleCount; channel += 1) {
      const existing = db
        .prepare("SELECT id FROM cells WHERE controller_id = ? AND hardware_channel = ?")
        .get(controller.id, channel);
      if (existing) {
        continue;
      }

      createModulePlaceholder(
        db,
        {
          controller_id: controller.id,
          controller_code: controller.controller_code,
          hardware_channel: channel,
          zone_id: controller.zone_id,
          row_number: 1,
          column_number: channel,
          capacity: 12,
        },
        controller.configured_by || null,
      );
    }
  }
}

export function listCellCatalog(db) {
  ensureOnlineControllerModuleRows(db);

  return db
    .prepare(
      `
        SELECT
          c.*,
          z.code AS zone_code,
          ctrl.controller_code,
          ctrl.address AS controller_address,
          ctrl.active AS controller_active,
          ctrl.heartbeat_status AS controller_health,
          ctrl.module_count AS controller_module_count,
          COALESCE(SUM(b.available_quantity), 0) AS occupied_quantity,
          COALESCE(SUM(b.reserved_quantity), 0) AS reserved_quantity,
          (
            SELECT COUNT(*)
            FROM inventory_balances balance_count
            WHERE balance_count.cell_id = c.id
              AND (balance_count.available_quantity != 0 OR balance_count.reserved_quantity != 0)
          ) AS balance_record_count,
          (SELECT COUNT(*) FROM task_lines tl_count WHERE tl_count.cell_id = c.id) AS task_line_count,
          (SELECT COUNT(*) FROM transactions tr_count WHERE tr_count.cell_id = c.id) AS transaction_count,
          (SELECT COUNT(*) FROM device_events event_count WHERE event_count.cell_id = c.id) AS device_event_count,
          COALESCE(
            GROUP_CONCAT(
              CASE
                WHEN b.available_quantity > 0 AND p.sku IS NOT NULL
                THEN p.sku || ' (' || CAST(b.available_quantity AS TEXT) || ')'
              END,
              ', '
            ),
            ''
          ) AS inventory_summary
        FROM cells c
        JOIN zones z ON z.id = c.zone_id
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        LEFT JOIN inventory_balances b ON b.cell_id = c.id
        LEFT JOIN products p ON p.id = b.product_id
        GROUP BY c.id
        ORDER BY c.logical_code
      `,
    )
    .all();
}

export function searchCells(db, search = "") {
  const pattern = `%${search.trim()}%`;
  return db
    .prepare(
      `
        SELECT
          c.id,
          c.logical_code,
          c.hardware_channel,
          COALESCE(SUM(b.available_quantity), 0) AS occupied_quantity
        FROM cells c
        LEFT JOIN inventory_balances b ON b.cell_id = c.id
        WHERE c.active = 1 AND c.logical_code LIKE ?
        GROUP BY c.id
        ORDER BY c.row_number, c.column_number
      `,
    )
    .all(pattern);
}

export function getCellDetail(db, cellId) {
  const cell = db
    .prepare(
      `
        SELECT
          c.*,
          ctrl.controller_code,
          ctrl.address AS controller_address,
          z.code AS zone_code
        FROM cells c
        JOIN zones z ON z.id = c.zone_id
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        WHERE c.id = ? AND c.active = 1
      `,
    )
    .get(Number(cellId));

  if (!cell) {
    return null;
  }

  const products = db
    .prepare(
      `
        SELECT
          p.id AS product_id,
          p.sku,
          p.name,
          p.brand,
          p.unit_of_measure,
          COALESCE(b.available_quantity, 0) AS available_quantity
        FROM inventory_balances b
        JOIN products p ON p.id = b.product_id
        WHERE b.cell_id = ? AND b.available_quantity > 0
        ORDER BY p.name
      `,
    )
    .all(Number(cellId));

  return {
    ...cell,
    products,
  };
}

export function listControllers(db) {
  return db
    .prepare(
      `
        SELECT
          ctrl.*,
          z.code AS zone_code,
          COUNT(
            CASE
              WHEN c.active = 1
                AND c.mapping_status = 'mapped'
                AND c.hardware_channel IS NOT NULL
              THEN c.id
            END
          ) AS mapped_cells
        FROM controllers ctrl
        JOIN zones z ON z.id = ctrl.zone_id
        LEFT JOIN cells c ON c.controller_id = ctrl.id
        WHERE ctrl.active = 1
        GROUP BY ctrl.id
        ORDER BY ctrl.id
      `,
    )
    .all();
}

const VALID_CONTROLLER_HEALTH_STATUSES = new Set(["online", "offline", "unknown"]);

function normalizeControllerHealthStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return VALID_CONTROLLER_HEALTH_STATUSES.has(status) ? status : "unknown";
}

export function updateControllerHealth(db, { controllerId, status }) {
  const normalizedStatus = normalizeControllerHealthStatus(status);
  const now = nowIso();
  const result = db
    .prepare(
      `
        UPDATE controllers
        SET
          heartbeat_status = ?,
          last_seen_at = CASE WHEN ? = 'online' THEN ? ELSE last_seen_at END
        WHERE id = ? AND active = 1
      `,
    )
    .run(normalizedStatus, normalizedStatus, now, Number(controllerId));

  if (result.changes === 0) {
    throw new Error("Controller not found.");
  }

  return db.prepare("SELECT * FROM controllers WHERE id = ?").get(Number(controllerId));
}

export function deleteController(db, { controllerId }) {
  return withTransaction(db, () => {
    const controller = db
      .prepare("SELECT * FROM controllers WHERE id = ?")
      .get(Number(controllerId));

    if (!controller) {
      throw new Error("Controller not found.");
    }

    const cells = db.prepare("SELECT * FROM cells WHERE controller_id = ?").all(controller.id);
    db.prepare("UPDATE device_events SET controller_id = NULL WHERE controller_id = ?").run(controller.id);

    const detachedModules = detachCellsForManualOperation(
      db,
      cells.map((cell) => Number(cell.id)),
    );

    db.prepare(
      `
        DELETE FROM controllers
        WHERE id = ?
      `,
    ).run(controller.id);

    return {
      ...controller,
      deleted: true,
      detachedCellCount: detachedModules.detached,
      removedModuleCount: detachedModules.removed,
    };
  });
}

function normalizeLogicalCode(value) {
  const logicalCode = String(value || "").trim().toUpperCase();
  if (!logicalCode) {
    throw new Error("Cell name is required.");
  }
  if (!/^[A-Z0-9._:-]+$/.test(logicalCode)) {
    throw new Error("Cell name can use letters, numbers, dot, dash, underscore, or colon.");
  }
  return logicalCode;
}

function cellHasStock(db, cellId) {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM inventory_balances
        WHERE cell_id = ?
          AND (available_quantity != 0 OR reserved_quantity != 0)
      `,
    )
    .get(Number(cellId));
  return Number(row?.count || 0) > 0;
}

function cellHasHistory(db, cellId) {
  const row = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM task_lines WHERE cell_id = ?) AS task_lines,
          (SELECT COUNT(*) FROM transactions WHERE cell_id = ?) AS transactions
      `,
    )
    .get(Number(cellId), Number(cellId));
  return Number(row?.task_lines || 0) > 0 || Number(row?.transactions || 0) > 0;
}

function cellHasOperationalHistory(db, cellId) {
  const row = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM task_lines WHERE cell_id = ?) AS taskLines,
          (SELECT COUNT(*) FROM transactions WHERE cell_id = ?) AS transactions,
          (SELECT COUNT(*) FROM device_events WHERE cell_id = ?) AS deviceEvents
      `,
    )
    .get(Number(cellId), Number(cellId), Number(cellId));
  return (
    Number(row?.taskLines || 0) > 0 ||
    Number(row?.transactions || 0) > 0 ||
    Number(row?.deviceEvents || 0) > 0
  );
}

function availableModulePlaceholderCode(db, controllerCode, hardwareChannel) {
  const normalizedControllerCode = String(controllerCode || "CONTROLLER")
    .toUpperCase()
    .replace(/[^A-Z0-9._:-]+/g, "-");
  const base = `UNASSIGNED-${normalizedControllerCode}-M${String(hardwareChannel).padStart(2, "0")}`;
  let candidate = base;
  let suffix = 2;
  while (db.prepare("SELECT id FROM cells WHERE logical_code = ?").get(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createModulePlaceholder(db, cell, deletedBy = null) {
  if (!cell.controller_id || !cell.hardware_channel) {
    return null;
  }

  const result = db
    .prepare(
      `
        INSERT INTO cells (
          logical_code, zone_id, row_number, column_number, controller_id,
          hardware_channel, mapping_status, active, capacity, last_mapped_at, mapped_by
        )
        VALUES (?, ?, ?, ?, ?, ?, 'unmapped', 0, ?, NULL, ?)
      `,
    )
    .run(
      availableModulePlaceholderCode(db, cell.controller_code, cell.hardware_channel),
      cell.zone_id,
      cell.row_number,
      cell.column_number,
      cell.controller_id,
      cell.hardware_channel,
      cell.capacity || 12,
      deletedBy,
    );

  return db.prepare("SELECT * FROM cells WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function getCellDeletionImpact(db, cellId) {
  const id = Number(cellId);
  const cell = db
    .prepare(
      `
        SELECT
          c.*,
          ctrl.controller_code,
          ctrl.address AS controller_address,
          COALESCE(SUM(b.available_quantity), 0) AS occupied_quantity,
          COALESCE(SUM(b.reserved_quantity), 0) AS reserved_quantity
        FROM cells c
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        LEFT JOIN inventory_balances b ON b.cell_id = c.id
        WHERE c.id = ? AND c.active = 1
        GROUP BY c.id
      `,
    )
    .get(id);

  if (!cell) {
    throw new Error("Cell not found.");
  }

  const counts = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM inventory_balances WHERE cell_id = ?) AS balanceRows,
          (SELECT COUNT(*) FROM task_lines WHERE cell_id = ?) AS taskLines,
          (SELECT COUNT(*) FROM transactions WHERE cell_id = ?) AS transactions,
          (SELECT COUNT(*) FROM device_events WHERE cell_id = ?) AS deviceEvents
      `,
    )
    .get(id, id, id, id);
  const hasData =
    Number(cell.occupied_quantity || 0) !== 0 ||
    Number(cell.reserved_quantity || 0) !== 0 ||
    Number(counts.balanceRows || 0) > 0 ||
    Number(counts.taskLines || 0) > 0 ||
    Number(counts.transactions || 0) > 0 ||
    Number(counts.deviceEvents || 0) > 0;

  return {
    cell,
    hasData,
    hasStock:
      Number(cell.occupied_quantity || 0) !== 0 || Number(cell.reserved_quantity || 0) !== 0,
    occupiedQuantity: Number(cell.occupied_quantity || 0),
    reservedQuantity: Number(cell.reserved_quantity || 0),
    balanceRows: Number(counts.balanceRows || 0),
    taskLines: Number(counts.taskLines || 0),
    transactions: Number(counts.transactions || 0),
    deviceEvents: Number(counts.deviceEvents || 0),
  };
}

export function deleteCell(db, { cellId, deletedBy = null } = {}) {
  return withTransaction(db, () => {
    const impact = getCellDeletionImpact(db, cellId);
    if (impact.hasStock) {
      throw new Error("Move all stock out of this cell before deleting it.");
    }

    const id = Number(cellId);
    db.prepare("DELETE FROM inventory_balances WHERE cell_id = ?").run(id);
    const placeholder = createModulePlaceholder(db, impact.cell, deletedBy);
    const hasHistory = cellHasOperationalHistory(db, id);

    if (hasHistory) {
      db.prepare(
        `
          UPDATE cells
          SET
            active = 0,
            controller_id = NULL,
            hardware_channel = NULL,
            mapping_status = 'unmapped'
          WHERE id = ?
        `,
      ).run(id);
    } else {
      db.prepare("DELETE FROM cells WHERE id = ?").run(id);
    }

    return {
      ...impact,
      deleted: true,
      preservedHistory: hasHistory,
      modulePlaceholder: placeholder,
    };
  });
}

function retireEmptyMappingCell(db, cellId) {
  const cell = db.prepare("SELECT * FROM cells WHERE id = ?").get(Number(cellId));
  if (!cell) {
    return "missing";
  }

  if (Number(cell.active) === 1 || cellHasHistory(db, cellId)) {
    db.prepare(
      `
        UPDATE cells
        SET
            controller_id = NULL,
            hardware_channel = NULL,
            mapping_status = 'unmapped',
            active = ?
          WHERE id = ?
        `,
    ).run(Number(cell.active) === 0 ? 0 : 1, Number(cellId));
    return "detached";
  }

  db.prepare("UPDATE device_events SET cell_id = NULL WHERE cell_id = ?").run(Number(cellId));
  db.prepare("DELETE FROM inventory_balances WHERE cell_id = ?").run(Number(cellId));
  db.prepare("DELETE FROM cells WHERE id = ?").run(Number(cellId));
  return "deleted";
}

function detachCellsForManualOperation(db, cellIds) {
  const ids = cellIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) {
    return { detached: 0, removed: 0 };
  }

  const placeholders = ids.map(() => "?").join(", ");
  const cells = db.prepare(`SELECT * FROM cells WHERE id IN (${placeholders})`).all(...ids);
  let detached = 0;
  let removed = 0;

  for (const cell of cells) {
    if (Number(cell.active) === 1) {
      db.prepare(
        `
          UPDATE cells
          SET
            controller_id = NULL,
            hardware_channel = NULL,
            mapping_status = 'unmapped',
            active = 1
          WHERE id = ?
        `,
      ).run(Number(cell.id));
      detached += 1;
      continue;
    }

    db.prepare("UPDATE device_events SET cell_id = NULL WHERE cell_id = ?").run(Number(cell.id));
    db.prepare("DELETE FROM inventory_balances WHERE cell_id = ?").run(Number(cell.id));
    db.prepare("DELETE FROM cells WHERE id = ?").run(Number(cell.id));
    removed += 1;
  }

  return { detached, removed };
}

export function createCell(db, { logicalCode, capacity = 12, createdBy = null } = {}) {
  const code = normalizeLogicalCode(logicalCode);
  const cellCapacity = Number(capacity || 12);
  if (!Number.isFinite(cellCapacity) || cellCapacity <= 0) {
    throw new Error("Cell capacity must be a positive number.");
  }

  const existing = db.prepare("SELECT * FROM cells WHERE logical_code = ?").get(code);
  if (existing) {
    if (Number(existing.active) === 0 && existing.controller_id == null) {
      db.prepare(
        `
          UPDATE cells
          SET
            active = 1,
            capacity = ?,
            mapping_status = 'unmapped',
            mapped_by = COALESCE(mapped_by, ?)
          WHERE id = ?
        `,
      ).run(cellCapacity, createdBy, existing.id);
      return db.prepare("SELECT * FROM cells WHERE id = ?").get(existing.id);
    }
    throw new Error("A cell with this name already exists.");
  }

  const zoneId = getOrCreateZone(db);
  const result = db
    .prepare(
      `
        INSERT INTO cells (
          logical_code, zone_id, row_number, column_number, controller_id,
          hardware_channel, mapping_status, active, capacity, last_mapped_at, mapped_by
        )
        VALUES (?, ?, 1, 0, NULL, NULL, 'unmapped', 1, ?, NULL, ?)
      `,
    )
    .run(code, zoneId, cellCapacity, createdBy);

  return db.prepare("SELECT * FROM cells WHERE id = ?").get(Number(result.lastInsertRowid));
}

export function updateCellMapping(
  db,
  { cellId, hardwareChannel, logicalCode = null, targetCellId = null, mappedBy },
) {
  const channel = Number(hardwareChannel);
  if (!Number.isFinite(channel) || channel <= 0) {
    throw new Error("Hardware channel must be a positive number.");
  }

  return withTransaction(db, () => {
    const sourceCell = db.prepare("SELECT * FROM cells WHERE id = ?").get(Number(cellId));
    if (!sourceCell) {
      throw new Error("Mapped module not found.");
    }

    if (!sourceCell.controller_id) {
      throw new Error("Choose a mapped LED module before assigning a cell.");
    }

    let targetCell = null;
    if (targetCellId) {
      targetCell = db.prepare("SELECT * FROM cells WHERE id = ?").get(Number(targetCellId));
      if (!targetCell) {
        throw new Error("Selected cell was not found.");
      }
      if (Number(targetCell.active) !== 1) {
        throw new Error("Selected cell is not active. Choose an active cell from the list.");
      }
    } else if (logicalCode != null) {
      const nextLogicalCode = normalizeLogicalCode(logicalCode);
      targetCell = db.prepare("SELECT * FROM cells WHERE logical_code = ?").get(nextLogicalCode) || null;
      if (!targetCell) {
        throw new Error("Add this location before assigning it to an LED module.");
      }
      if (Number(targetCell.active) !== 1) {
        throw new Error("Selected cell is not active. Add this location before assigning it to an LED module.");
      }
    } else {
      throw new Error("Choose a location to assign this LED module.");
    }

    const now = nowIso();
    if (Number(targetCell.id) === Number(sourceCell.id)) {
      db.prepare(
        `
          UPDATE cells
          SET
            hardware_channel = ?,
            mapping_status = 'mapped',
            active = 1,
            last_mapped_at = ?,
            mapped_by = ?
          WHERE id = ?
        `,
      ).run(channel, now, mappedBy, sourceCell.id);
      return db.prepare("SELECT * FROM cells WHERE id = ?").get(sourceCell.id);
    }

    const targetHasDifferentModule =
      targetCell.controller_id &&
      targetCell.hardware_channel &&
      (Number(targetCell.controller_id) !== Number(sourceCell.controller_id) ||
        Number(targetCell.hardware_channel) !== channel);
    if (targetHasDifferentModule) {
      const displacedModule = db
        .prepare(
          `
            SELECT c.*, ctrl.controller_code
            FROM cells c
            LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
            WHERE c.id = ?
          `,
        )
        .get(targetCell.id);
      createModulePlaceholder(db, displacedModule, mappedBy);
    }

    db.prepare(
      `
        UPDATE cells
        SET
          controller_id = ?,
          hardware_channel = ?,
          mapping_status = 'mapped',
          active = 1,
          last_mapped_at = ?,
          mapped_by = ?
        WHERE id = ?
      `,
    ).run(sourceCell.controller_id, channel, now, mappedBy, targetCell.id);

    retireEmptyMappingCell(db, sourceCell.id);
    return db.prepare("SELECT * FROM cells WHERE id = ?").get(targetCell.id);
  });
}

function getOrCreateZone(db, code = "Z1", name = "Main Zone") {
  const existing = db.prepare("SELECT id FROM zones WHERE code = ?").get(code);
  if (existing) {
    return existing.id;
  }

  const result = db
    .prepare("INSERT INTO zones (code, name, sort_order) VALUES (?, ?, ?)")
    .run(code, name, 1);
  return Number(result.lastInsertRowid);
}

function nextDefaultControllerCode(db) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM controllers WHERE firmware_version != ?").get("sim-0.1");
  return `ESP32-${String(Number(row?.count || 0) + 1).padStart(2, "0")}`;
}

function availableLogicalCode(db, preferred, fallbackPrefix, channel) {
  const preferredExisting = db.prepare("SELECT id FROM cells WHERE logical_code = ?").get(preferred);
  if (!preferredExisting) {
    return preferred;
  }

  const base = `${fallbackPrefix}-M${String(channel).padStart(2, "0")}`;
  let candidate = base;
  let suffix = 2;
  while (db.prepare("SELECT id FROM cells WHERE logical_code = ?").get(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function configureControllerModules(
  db,
  {
    controllerCode,
    controllerAddress,
    deviceIdentity,
    moduleCount,
    configuredBy = null,
    firmwareVersion = ESP32_FIRMWARE_PROTOCOL,
  },
) {
  const count = Number(moduleCount);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("LED module count must be a positive whole number.");
  }

  return withTransaction(db, () => {
    const zoneId = getOrCreateZone(db);
    const requestedCode = controllerCode ? normalizeLogicalCode(controllerCode) : "";
    const now = nowIso();
    const code = requestedCode || nextDefaultControllerCode(db);
    const existingByCode = db.prepare("SELECT * FROM controllers WHERE controller_code = ?").get(code);
    const existing = existingByCode || null;
    const address = controllerAddress
      ? normalizeLogicalCode(controllerAddress)
      : existing?.address || code;
    const addressConflict = db
      .prepare("SELECT id, controller_code FROM controllers WHERE address = ? AND id != ?")
      .get(address, existing?.id || 0);
    if (addressConflict) {
      throw new Error(`Controller RS485 id is already assigned to ${addressConflict.controller_code}.`);
    }

    let controllerId;
    if (existing) {
      controllerId = existing.id;
      db.prepare(
        `
          UPDATE controllers
          SET
            zone_id = ?,
            controller_code = ?,
            address = ?,
            firmware_version = ?,
            heartbeat_status = 'online',
            last_seen_at = ?,
            cell_start_column = 1,
            cell_end_column = ?,
            active = 1,
            device_identity = ?,
            module_count = ?,
            configured_at = ?,
            configured_by = ?
          WHERE id = ?
        `,
      ).run(
        zoneId,
        code,
        address,
        firmwareVersion,
        now,
        count,
        deviceIdentity || existing.device_identity || null,
        count,
        now,
        configuredBy,
        controllerId,
      );
    } else {
      const result = db
        .prepare(
        `
          INSERT INTO controllers (
            zone_id, controller_code, address, firmware_version, heartbeat_status,
            last_seen_at, cell_start_column, cell_end_column, active,
            device_identity, module_count, configured_at, configured_by
          )
          VALUES (?, ?, ?, ?, 'online', ?, 1, ?, 1, ?, ?, ?, ?)
        `,
        )
        .run(
          zoneId,
          code,
          address,
          firmwareVersion,
          now,
          count,
          deviceIdentity || null,
          count,
          now,
          configuredBy,
        );
      controllerId = Number(result.lastInsertRowid);
    }

    const mappingSummary = {
      preserved: 0,
      created: 0,
      detached: 0,
      removed: 0,
      moduleCount: count,
      needsVerification: true,
    };

    db.prepare("UPDATE controllers SET active = 0 WHERE firmware_version = ? AND id != ?").run(
      "sim-0.1",
      controllerId,
    );
    const inactiveControllerCells = db
      .prepare("SELECT id FROM cells WHERE controller_id IN (SELECT id FROM controllers WHERE active = 0)")
      .all();
    const inactiveDetached = detachCellsForManualOperation(
      db,
      inactiveControllerCells.map((cell) => cell.id),
    );
    mappingSummary.detached += inactiveDetached.detached;
    mappingSummary.removed += inactiveDetached.removed;

    const overflowCells = db
      .prepare("SELECT id FROM cells WHERE controller_id = ? AND hardware_channel > ?")
      .all(controllerId, count);
    const overflowDetached = detachCellsForManualOperation(
      db,
      overflowCells.map((cell) => cell.id),
    );
    mappingSummary.detached += overflowDetached.detached;
    mappingSummary.removed += overflowDetached.removed;

    const moduleCellIds = [];
    for (let channel = 1; channel <= count; channel += 1) {
      const existingControllerCell = db
        .prepare("SELECT * FROM cells WHERE controller_id = ? AND hardware_channel = ?")
        .get(controllerId, channel);

      if (existingControllerCell) {
        const isAssignedLocation = Number(existingControllerCell.active) === 1;
        db.prepare(
          `
            UPDATE cells
            SET
              zone_id = ?,
              row_number = 1,
              column_number = ?,
              controller_id = ?,
              hardware_channel = ?,
              mapping_status = ?,
              last_mapped_at = CASE WHEN ? = 1 THEN COALESCE(last_mapped_at, ?) ELSE last_mapped_at END,
              mapped_by = COALESCE(mapped_by, ?)
            WHERE id = ?
          `,
        ).run(
          zoneId,
          channel,
          controllerId,
          channel,
          isAssignedLocation ? "mapped" : "unmapped",
          isAssignedLocation ? 1 : 0,
          now,
          configuredBy,
          existingControllerCell.id,
        );
        moduleCellIds.push(Number(existingControllerCell.id));
        if (isAssignedLocation) {
          mappingSummary.preserved += 1;
        }
        continue;
      }

      const placeholder = createModulePlaceholder(
        db,
        {
          controller_id: controllerId,
          controller_code: code,
          hardware_channel: channel,
          zone_id: zoneId,
          row_number: 1,
          column_number: channel,
          capacity: 12,
        },
        configuredBy,
      );
      moduleCellIds.push(Number(placeholder.id));
      mappingSummary.created += 1;
    }

    if (moduleCellIds.length > 0) {
      const placeholders = moduleCellIds.map(() => "?").join(", ");
      const staleCells = db
        .prepare(
        `
          SELECT id
          FROM cells
          WHERE controller_id = ?
            AND id NOT IN (${placeholders})
        `,
        )
        .all(controllerId, ...moduleCellIds);
      const staleDetached = detachCellsForManualOperation(
        db,
        staleCells.map((cell) => cell.id),
      );
      mappingSummary.detached += staleDetached.detached;
      mappingSummary.removed += staleDetached.removed;
    }

    const controller = db.prepare("SELECT * FROM controllers WHERE id = ?").get(controllerId);
    return {
      ...controller,
      mappingSummary,
    };
  });
}

export function updateProductItemsPerCell(db, { productId, itemsPerCell }) {
  const capacity = normalizeItemsPerCell(itemsPerCell);
  const result = createProductRepository(db).updateItemsPerCell(productId, capacity);

  if (result.changes === 0) {
    throw new Error("Product not found.");
  }

  return getProductDetail(db, Number(productId));
}

export function applyRecommendedAction(
  db,
  { sourceCellId, productId, moves, userId, reason },
) {
  const product = findProductOrThrow(db, Number(productId));
  const sourceCell = db.prepare("SELECT * FROM cells WHERE id = ?").get(Number(sourceCellId));
  if (!sourceCell) {
    throw new Error("Source cell not found.");
  }

  const normalizedMoves = moves
    .map((move) => ({
      targetCellId: Number(move.targetCellId),
      quantity: Number(move.quantity),
    }))
    .filter((move) => Number.isFinite(move.quantity) && move.quantity > 0);

  if (!normalizedMoves.length) {
    throw new Error("At least one move is required.");
  }

  const totalQuantity = normalizedMoves.reduce((sum, move) => sum + move.quantity, 0);
  const balances = createInventoryBalanceRepository(db);
  const sourceBalance = balances.getOrCreate(product.id, sourceCell.id);
  if (Number(sourceBalance.available_quantity) < totalQuantity) {
    throw new Error("Source cell does not have enough quantity for this adjustment.");
  }

  return withTransaction(db, () => {
    balances.decrease(sourceBalance.id, totalQuantity);

    db.prepare(
      `
        INSERT INTO transactions (
          type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
        )
        VALUES ('adjustment', ?, ?, ?, ?, NULL, ?, ?)
      `,
    ).run(
      product.id,
      sourceCell.id,
      -totalQuantity,
      userId,
      reason || "Recommended action adjustment",
      nowIso(),
    );

    for (const move of normalizedMoves) {
      const targetCell = db.prepare("SELECT * FROM cells WHERE id = ?").get(move.targetCellId);
      if (!targetCell) {
        throw new Error("Target cell not found.");
      }
      assertPutCellEligible(db, {
        productId: product.id,
        cellId: targetCell.id,
      });

      const targetBalance = balances.getOrCreate(product.id, targetCell.id);
      balances.increase(targetBalance.id, move.quantity);

      db.prepare(
        `
          INSERT INTO transactions (
            type, product_id, cell_id, quantity_delta, user_id, task_id, reason, created_at
          )
          VALUES ('adjustment', ?, ?, ?, ?, NULL, ?, ?)
        `,
      ).run(
        product.id,
        targetCell.id,
        move.quantity,
        userId,
        reason || `Recommended action move from ${sourceCell.logical_code}`,
        nowIso(),
      );
    }
  });
}
