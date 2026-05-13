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
  quantitiesMatch,
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

  const products = createProductRepository(db);
  const existing = products.findBySku(input.sku);
  if (existing) {
    throw new Error("A product with that SKU already exists.");
  }

  return products.create({
    sku: input.sku.trim(),
    name: input.name.trim(),
    brand: input.brand.trim(),
    category: input.category?.trim() || null,
    variant: input.variant?.trim() || null,
    unit_of_measure: input.unit_of_measure.trim(),
    description: input.description?.trim() || null,
    preferred_storage_strategy: input.preferred_storage_strategy?.trim() || "closest-cell-first",
    items_per_cell: itemsPerCell,
    active: input.active === "0" ? 0 : 1,
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
    const plannedTotal = task.lines.reduce((sum, line) => sum + Number(line.planned_quantity), 0);

    if (task.type === "put") {
      const actualTotal = task.lines.reduce((sum, line) => {
        const actualValue = actualQuantities[line.id] ?? line.planned_quantity;
        return sum + normalizeNonNegativeQuantity(actualValue, "Put quantities must be zero or greater.");
      }, 0);
      if (!quantitiesMatch(actualTotal, plannedTotal)) {
        throw new Error(
          `Put quantities must total ${plannedTotal}. Current total is ${actualTotal}. Adjust the cells or cancel the task.`,
        );
      }
    }

    for (const line of task.lines) {
      const actualValue = actualQuantities[line.id] ?? line.planned_quantity;
      const actualQuantity = normalizeNonNegativeQuantity(actualValue, "Actual quantity values must be zero or greater.");

      if (task.type === "pick" && actualQuantity > Number(line.planned_quantity)) {
        throw new Error("Actual quantities cannot exceed planned quantities in this MVP.");
      }

      const exceptionQuantity = Math.max(0, Number(line.planned_quantity) - actualQuantity);
      const targetCellId =
        task.type === "put"
          ? Number(actualCellIds?.[line.id] || line.cell_id)
          : Number(line.cell_id);

      const targetCell = db.prepare("SELECT * FROM cells WHERE id = ?").get(targetCellId);
      if (!targetCell) {
        throw new Error("Selected cell not found.");
      }

      tasks.updateLineActual({
        lineId: line.id,
        actualQuantity,
        exceptionQuantity,
        note: note || null,
        cellId: targetCellId,
      });

      const plannedBalance = balances.getOrCreate(line.product_id, line.cell_id);

      if (task.type === "pick") {
        if (actualQuantity > Number(plannedBalance.available_quantity)) {
          throw new Error(
            `Cell ${line.logical_code} only has ${Number(plannedBalance.available_quantity)} item(s) left for ${line.sku}. Start a new pick task with the current stock.`,
          );
        }

        balances.decrease(plannedBalance.id, actualQuantity);
        touchedCellIds.add(Number(line.cell_id));

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
            line.cell_id,
            -actualQuantity,
            userId,
            task.id,
            note || "Pick confirmation",
            nowIso(),
          );
        }
      } else if (task.type === "put") {
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

  const expectedTotal = task.lines.reduce((sum, line) => sum + Number(line.planned_quantity), 0);
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
    const cell = db.prepare("SELECT id FROM cells WHERE id = ? AND active = 1").get(cellId);
    if (!cell) {
      throw new Error("Selected put cell is not active.");
    }
    seenCells.add(cellId);
    nextAllocations.push({ cellId, quantity });
  }

  if (!nextAllocations.length) {
    throw new Error("Add at least one cell with a quantity greater than zero.");
  }

  const nextTotal = nextAllocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
  if (!quantitiesMatch(nextTotal, expectedTotal)) {
    throw new Error(
      `Adjusted put quantities must total ${expectedTotal}. Current total is ${nextTotal}.`,
    );
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
      const nextCellId =
        task.type === "put"
          ? Number(actualCellIds?.[line.id] || line.cell_id)
          : Number(line.cell_id);

      if (!Number.isFinite(nextQuantity) || nextQuantity < 0) {
        throw new Error("Corrected quantities must be zero or greater.");
      }

      if (task.type === "pick" && nextQuantity > Number(line.planned_quantity)) {
        throw new Error("Corrected pick quantity cannot exceed planned quantity.");
      }

      const nextCell = db.prepare("SELECT * FROM cells WHERE id = ?").get(nextCellId);
      if (!nextCell) {
        throw new Error("Selected correction cell not found.");
      }

      const oldBalance = balances.getOrCreate(line.product_id, line.cell_id);
      const newBalance = balances.getOrCreate(line.product_id, nextCellId);

      if (task.type === "pick") {
        const reversibleAvailable = Number(oldBalance.available_quantity) + previousQuantity;
        if (reversibleAvailable < nextQuantity) {
          throw new Error(
            `Cell ${line.logical_code} no longer has enough stock to apply this correction safely.`,
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

        balances.decrease(oldBalance.id, nextQuantity);

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
          -nextQuantity,
          userId,
          task.id,
          note || `Correction applied for task #${task.id}`,
          nowIso(),
        );

        touchedCellIds.add(Number(line.cell_id));
      } else if (task.type === "put") {
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
        SELECT id, name, username, role, status, created_at
        FROM users
        ORDER BY role DESC, username
      `,
    )
    .all();
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

export function issueRegistrationKey(db, { keyValue, role, userId }) {
  const normalizedRole = role === "admin" ? "admin" : "operator";
  const normalized = String(keyValue || "").trim() || generateRegistrationKeyValue(normalizedRole);

  const result = db.prepare(
    `
      INSERT INTO registration_keys (key_value, role, status, expires_at, created_by, created_at)
      VALUES (?, ?, 'active', ?, ?, ?)
    `,
  ).run(
    normalized,
    normalizedRole,
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
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

    db.prepare(
      `
        UPDATE registration_keys
        SET status = 'used', used_by = ?, used_at = ?
        WHERE id = ?
      `,
    ).run(Number(result.lastInsertRowid), nowIso(), key.id);

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

export function listCellCatalog(db) {
  return db
    .prepare(
      `
        SELECT
          c.*,
          z.code AS zone_code,
          ctrl.controller_code,
          ctrl.address AS controller_address,
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
          COUNT(CASE WHEN c.active = 1 THEN c.id END) AS mapped_cells
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

    if (cells.length > 0) {
      const placeholders = cells.map(() => "?").join(", ");
      db.prepare(
        `
          UPDATE cells
          SET
            controller_id = NULL,
            hardware_channel = NULL,
            mapping_status = 'unmapped',
            active = 1
          WHERE id IN (${placeholders})
        `,
      ).run(...cells.map((cell) => Number(cell.id)));
    }

    db.prepare(
      `
        DELETE FROM controllers
        WHERE id = ?
      `,
    ).run(controller.id);

    return {
      ...controller,
      deleted: true,
      detachedCellCount: cells.length,
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
    occupiedQuantity: Number(cell.occupied_quantity || 0),
    reservedQuantity: Number(cell.reserved_quantity || 0),
    balanceRows: Number(counts.balanceRows || 0),
    taskLines: Number(counts.taskLines || 0),
    transactions: Number(counts.transactions || 0),
    deviceEvents: Number(counts.deviceEvents || 0),
  };
}

export function deleteCell(db, { cellId, deleteDataConfirmed = false } = {}) {
  return withTransaction(db, () => {
    const impact = getCellDeletionImpact(db, cellId);
    if (impact.hasData && !deleteDataConfirmed) {
      throw new Error("This cell has stock, task history, or hardware events. Confirm deleting associated data first.");
    }

    const id = Number(cellId);
    db.prepare("DELETE FROM device_events WHERE cell_id = ?").run(id);
    db.prepare("DELETE FROM transactions WHERE cell_id = ?").run(id);
    db.prepare("DELETE FROM task_lines WHERE cell_id = ?").run(id);
    db.prepare("DELETE FROM inventory_balances WHERE cell_id = ?").run(id);
    db.prepare("DELETE FROM cells WHERE id = ?").run(id);

    return {
      ...impact,
      deleted: true,
    };
  });
}

function retireEmptyMappingCell(db, cellId) {
  if (cellHasStock(db, cellId)) {
    throw new Error("Move stock out of the current mapped cell before replacing it.");
  }

  if (cellHasHistory(db, cellId)) {
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
    ).run(Number(cellId));
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
    return 0;
  }

  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `
      UPDATE cells
      SET
        controller_id = NULL,
        hardware_channel = NULL,
        mapping_status = 'unmapped',
        active = 1
      WHERE id IN (${placeholders})
    `,
  ).run(...ids);
  return ids.length;
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
    } else if (logicalCode != null) {
      const nextLogicalCode = normalizeLogicalCode(logicalCode);
      targetCell = db.prepare("SELECT * FROM cells WHERE logical_code = ?").get(nextLogicalCode) || null;
      if (!targetCell) {
        db.prepare(
          `
            UPDATE cells
            SET
              logical_code = ?,
              hardware_channel = ?,
              mapping_status = 'mapped',
              active = 1,
              last_mapped_at = ?,
              mapped_by = ?
            WHERE id = ?
          `,
        ).run(nextLogicalCode, channel, nowIso(), mappedBy, sourceCell.id);
        return db.prepare("SELECT * FROM cells WHERE id = ?").get(sourceCell.id);
      }
    } else {
      targetCell = sourceCell;
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

    db.prepare("UPDATE controllers SET active = 0 WHERE firmware_version = ? AND id != ?").run(
      "sim-0.1",
      controllerId,
    );
    db.prepare(
      `
        UPDATE cells
        SET active = 0
        WHERE controller_id IN (SELECT id FROM controllers WHERE active = 0)
      `,
    ).run();

    const mappingSummary = {
      preserved: 0,
      created: 0,
      detached: 0,
      moduleCount: count,
      needsVerification: true,
    };

    const overflowCells = db
      .prepare("SELECT id FROM cells WHERE controller_id = ? AND hardware_channel > ?")
      .all(controllerId, count);
    mappingSummary.detached += detachCellsForManualOperation(
      db,
      overflowCells.map((cell) => cell.id),
    );

    const activeCellIds = [];
    for (let channel = 1; channel <= count; channel += 1) {
      const defaultLogicalCode = `Z1-R1-C${String(channel).padStart(2, "0")}`;
      const existingControllerCell = db
        .prepare("SELECT * FROM cells WHERE controller_id = ? AND hardware_channel = ?")
        .get(controllerId, channel);
      const reusableDefaultCell = db
        .prepare(
        `
          SELECT c.*
          FROM cells c
          LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
          WHERE c.logical_code = ?
            AND (c.controller_id = ? OR ctrl.active = 0 OR c.controller_id IS NULL)
        `,
        )
        .get(defaultLogicalCode, controllerId);
      const existingCell = existingControllerCell || reusableDefaultCell;

      if (existingCell) {
        db.prepare(
          `
            UPDATE cells
            SET
              zone_id = ?,
              row_number = 1,
              column_number = ?,
              controller_id = ?,
              hardware_channel = ?,
              mapping_status = 'mapped',
              active = 1,
              last_mapped_at = COALESCE(last_mapped_at, ?),
              mapped_by = COALESCE(mapped_by, ?)
            WHERE id = ?
          `,
        ).run(zoneId, channel, controllerId, channel, now, configuredBy, existingCell.id);
        activeCellIds.push(Number(existingCell.id));
        mappingSummary.preserved += 1;
        continue;
      }

      const logicalCode = availableLogicalCode(db, defaultLogicalCode, code, channel);
      const inserted = db.prepare(
        `
          INSERT INTO cells (
            logical_code, zone_id, row_number, column_number, controller_id,
            hardware_channel, mapping_status, active, capacity, last_mapped_at, mapped_by
          )
          VALUES (?, ?, 1, ?, ?, ?, 'mapped', 1, 12, ?, ?)
        `,
      ).run(logicalCode, zoneId, channel, controllerId, channel, now, configuredBy);
      activeCellIds.push(Number(inserted.lastInsertRowid));
      mappingSummary.created += 1;
    }

    if (activeCellIds.length > 0) {
      const placeholders = activeCellIds.map(() => "?").join(", ");
      const staleCells = db
        .prepare(
        `
          SELECT id
          FROM cells
          WHERE controller_id = ?
            AND id NOT IN (${placeholders})
        `,
        )
        .all(controllerId, ...activeCellIds);
      mappingSummary.detached += detachCellsForManualOperation(
        db,
        staleCells.map((cell) => cell.id),
      );
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
