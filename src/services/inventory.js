import { withTransaction } from "../db.js";
import { ESP32_FIRMWARE_PROTOCOL } from "./firmware-constants.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive number.");
  }
  return quantity;
}

function normalizeNonNegativeQuantity(value, message = "Quantity values must be zero or greater.") {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(message);
  }
  return quantity;
}

function quantitiesMatch(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.000001;
}

function normalizeItemsPerCell(value) {
  const capacity = Number(value);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error("Items per cell must be a positive number.");
  }
  return capacity;
}

function assertSufficientBalance(balance, quantity, message) {
  if (Number(balance.available_quantity) < Number(quantity)) {
    throw new Error(message);
  }
}

function sumCellOccupancy(db, cellId) {
  const row = db
    .prepare(
      `
        SELECT COALESCE(SUM(available_quantity), 0) AS total_quantity
        FROM inventory_balances
        WHERE cell_id = ?
      `,
    )
    .get(Number(cellId));
  return Number(row?.total_quantity || 0);
}

function moveSuggestions(db, { productId, sourceCellId, quantity }) {
  const product = findProductOrThrow(db, Number(productId));
  const itemsPerCell = normalizeItemsPerCell(product.items_per_cell);
  const requestedQuantity = normalizeQuantity(quantity);

  const sameProductCells = db
    .prepare(
      `
        SELECT
          c.id AS cell_id,
          c.logical_code,
          COALESCE(b.available_quantity, 0) AS available_quantity
        FROM cells c
        JOIN inventory_balances b ON b.cell_id = c.id
        WHERE b.product_id = ? AND c.active = 1 AND c.id != ?
        ORDER BY COALESCE(b.available_quantity, 0) DESC,
                 c.row_number,
                 c.column_number
      `,
    )
    .all(Number(productId), Number(sourceCellId));

  const emptyCells = db
    .prepare(
      `
        SELECT
          c.id AS cell_id,
          c.logical_code
        FROM cells c
        LEFT JOIN inventory_balances b
          ON b.cell_id = c.id AND b.available_quantity > 0
        WHERE c.active = 1
          AND b.id IS NULL
          AND c.id != ?
        ORDER BY c.row_number, c.column_number
      `,
    )
    .all(Number(sourceCellId));

  let remaining = requestedQuantity;
  const destinations = [];

  for (const cell of sameProductCells) {
    if (remaining <= 0) {
      break;
    }
    const currentQuantity = Number(cell.available_quantity);
    const room = itemsPerCell - currentQuantity;
    if (room <= 0) {
      continue;
    }
    const quantityToMove = Math.min(room, remaining);
    destinations.push({
      targetCellId: cell.cell_id,
      targetLogicalCode: cell.logical_code,
      quantity: quantityToMove,
      currentQuantity,
      idealCapacity: itemsPerCell,
    });
    remaining -= quantityToMove;
  }

  for (const cell of emptyCells) {
    if (remaining <= 0) {
      break;
    }
    const quantityToMove = Math.min(itemsPerCell, remaining);
    destinations.push({
      targetCellId: cell.cell_id,
      targetLogicalCode: cell.logical_code,
      quantity: quantityToMove,
      currentQuantity: 0,
      idealCapacity: itemsPerCell,
    });
    remaining -= quantityToMove;
  }

  return {
    product,
    sourceCellId: Number(sourceCellId),
    requestedQuantity,
    destinations,
    unresolvedQuantity: remaining,
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
  const pattern = `%${search.trim()}%`;
  return db
    .prepare(
      `
        SELECT
          p.*,
          COALESCE(SUM(b.available_quantity), 0) AS total_available
        FROM products p
        LEFT JOIN inventory_balances b ON b.product_id = p.id
        WHERE p.sku LIKE ? OR p.name LIKE ? OR p.brand LIKE ?
        GROUP BY p.id
        ORDER BY p.name
      `,
    )
    .all(pattern, pattern, pattern);
}

export function getProductDetail(db, productId) {
  const product = db
    .prepare(
      `
        SELECT
          p.*,
          COALESCE(SUM(b.available_quantity), 0) AS total_available
        FROM products p
        LEFT JOIN inventory_balances b ON b.product_id = p.id
        WHERE p.id = ?
        GROUP BY p.id
      `,
    )
    .get(Number(productId));

  if (!product) {
    return null;
  }

  const locations = db
    .prepare(
      `
        SELECT
          c.id AS cell_id,
          c.logical_code,
          c.hardware_channel,
          COALESCE(b.available_quantity, 0) AS available_quantity
        FROM inventory_balances b
        JOIN cells c ON c.id = b.cell_id
        WHERE b.product_id = ? AND b.available_quantity > 0
        ORDER BY c.row_number, c.column_number
      `,
    )
    .all(Number(productId));

  return {
    ...product,
    locations,
  };
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

  const existing = db
    .prepare("SELECT id FROM products WHERE sku = ?")
    .get(input.sku.trim());
  if (existing) {
    throw new Error("A product with that SKU already exists.");
  }

  const result = db
    .prepare(
      `
        INSERT INTO products (
          sku, name, brand, category, variant, unit_of_measure, description,
          preferred_storage_strategy, items_per_cell, active, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.sku.trim(),
      input.name.trim(),
      input.brand.trim(),
      input.category?.trim() || null,
      input.variant?.trim() || null,
      input.unit_of_measure.trim(),
      input.description?.trim() || null,
      input.preferred_storage_strategy?.trim() || "closest-cell-first",
      itemsPerCell,
      input.active === "0" ? 0 : 1,
      nowIso(),
    );

  return db.prepare("SELECT * FROM products WHERE id = ?").get(Number(result.lastInsertRowid));
}

function findProductOrThrow(db, productId) {
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
  if (!product) {
    throw new Error("Product not found.");
  }
  return product;
}

function getOrCreateBalance(db, productId, cellId) {
  const existing = db
    .prepare("SELECT * FROM inventory_balances WHERE product_id = ? AND cell_id = ?")
    .get(productId, cellId);

  if (existing) {
    return existing;
  }

  const result = db
    .prepare(
      `
        INSERT INTO inventory_balances (product_id, cell_id, available_quantity, reserved_quantity)
        VALUES (?, ?, 0, 0)
      `,
    )
    .run(productId, cellId);

  return db
    .prepare("SELECT * FROM inventory_balances WHERE id = ?")
    .get(Number(result.lastInsertRowid));
}

function taskLinesWithCells(db, taskId) {
  return db
    .prepare(
      `
        SELECT
          tl.*,
          p.sku,
          p.name AS product_name,
          p.brand,
          p.unit_of_measure,
          c.logical_code,
          c.hardware_channel,
          c.controller_id,
          ctrl.controller_code,
          ctrl.address AS controller_address
        FROM task_lines tl
        JOIN products p ON p.id = tl.product_id
        JOIN cells c ON c.id = tl.cell_id
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        WHERE tl.task_id = ?
        ORDER BY p.name, c.row_number, c.column_number
      `,
    )
    .all(taskId);
}

export function getTask(db, taskId) {
  const task = db
    .prepare(
      `
        SELECT
          t.*,
          u.name AS created_by_name,
          u.username AS created_by_username
        FROM tasks t
        JOIN users u ON u.id = t.created_by
        WHERE t.id = ?
      `,
    )
    .get(taskId);

  if (!task) {
    return null;
  }

  return {
    ...task,
    lines: taskLinesWithCells(db, taskId),
  };
}

export function listRecentTasks(db, limit = 10) {
  return db
    .prepare(
      `
        SELECT
          t.id,
          t.type,
          t.status,
          t.summary,
          t.started_at,
          t.completed_at,
          t.created_by,
          u.username AS created_by_username,
          (
            SELECT p.sku
            FROM task_lines tl
            JOIN products p ON p.id = tl.product_id
            WHERE tl.task_id = t.id
            ORDER BY tl.id
            LIMIT 1
          ) AS first_sku,
          (
            SELECT p.name
            FROM task_lines tl
            JOIN products p ON p.id = tl.product_id
            WHERE tl.task_id = t.id
            ORDER BY tl.id
            LIMIT 1
          ) AS first_product_name
        FROM tasks t
        JOIN users u ON u.id = t.created_by
        ORDER BY t.id DESC
        LIMIT ?
      `,
    )
    .all(limit);
}

export function listRecentTasksForUser(db, user, limit = 10) {
  if (user.role === "admin") {
    return listRecentTasks(db, limit);
  }

  return db
    .prepare(
      `
        SELECT
          t.id,
          t.type,
          t.status,
          t.summary,
          t.started_at,
          t.completed_at,
          t.created_by,
          u.username AS created_by_username,
          (
            SELECT p.sku
            FROM task_lines tl
            JOIN products p ON p.id = tl.product_id
            WHERE tl.task_id = t.id
            ORDER BY tl.id
            LIMIT 1
          ) AS first_sku,
          (
            SELECT p.name
            FROM task_lines tl
            JOIN products p ON p.id = tl.product_id
            WHERE tl.task_id = t.id
            ORDER BY tl.id
            LIMIT 1
          ) AS first_product_name
        FROM tasks t
        JOIN users u ON u.id = t.created_by
        WHERE t.created_by = ?
        ORDER BY t.id DESC
        LIMIT ?
      `,
    )
    .all(user.id, limit);
}

export function allocatePick(db, { userId, productId, quantity, preferredCellId = null }) {
  const requestedQuantity = normalizeQuantity(quantity);
  const product = findProductOrThrow(db, Number(productId));
  const preferredCell = preferredCellId
    ? db.prepare("SELECT id, logical_code FROM cells WHERE id = ? AND active = 1").get(Number(preferredCellId))
    : null;

  const balances = db
    .prepare(
      `
        SELECT
          b.product_id,
          b.cell_id,
          b.available_quantity,
          c.logical_code,
          c.hardware_channel,
          c.controller_id,
          c.row_number,
          c.column_number
        FROM inventory_balances b
        JOIN cells c ON c.id = b.cell_id
        WHERE b.product_id = ? AND c.active = 1 AND b.available_quantity > 0
        ORDER BY
          CASE WHEN c.id = ? THEN 0 ELSE 1 END,
          c.row_number,
          c.column_number
      `,
    )
    .all(product.id, preferredCell ? preferredCell.id : -1);

  const totalAvailable = balances.reduce((sum, row) => sum + Number(row.available_quantity), 0);

  if (totalAvailable < requestedQuantity) {
    throw new Error(
      `Insufficient stock. Requested ${requestedQuantity}, but only ${totalAvailable} is available.`,
    );
  }

  let remaining = requestedQuantity;
  const lines = [];
  for (const row of balances) {
    if (remaining <= 0) {
      break;
    }
    const freeQuantity = Number(row.available_quantity);
    const planned = Math.min(remaining, freeQuantity);
    if (planned <= 0) {
      continue;
    }
    lines.push({
      product_id: product.id,
      cell_id: row.cell_id,
      planned_quantity: planned,
      guidance_color: "green",
    });
    remaining -= planned;
  }

  return withTransaction(db, () => {
    const taskResult = db
      .prepare(
        `
          INSERT INTO tasks (type, status, summary, created_by, started_at)
          VALUES ('pick', 'pending_review', ?, ?, ?)
        `,
      )
      .run(
        `${product.sku} pick (${requestedQuantity} ${product.unit_of_measure})`,
        userId,
        nowIso(),
      );

    const taskId = Number(taskResult.lastInsertRowid);
    db.prepare("UPDATE tasks SET summary = ? WHERE id = ?").run(
      `Pick Action Initiated - Task #${taskId}`,
      taskId,
    );

    for (const line of lines) {
      db.prepare(
        `
          INSERT INTO task_lines (task_id, product_id, cell_id, planned_quantity, guidance_color)
          VALUES (?, ?, ?, ?, ?)
        `,
      ).run(
        taskId,
        line.product_id,
        line.cell_id,
        line.planned_quantity,
        line.guidance_color,
      );
    }

    return getTask(db, taskId);
  });
}

export function planPut(db, { userId, productId, quantity, preferredCellId = null }) {
  const requestedQuantity = normalizeQuantity(quantity);
  const product = findProductOrThrow(db, Number(productId));
  const itemsPerCell = normalizeItemsPerCell(product.items_per_cell);
  const preferredCell = preferredCellId
    ? db
        .prepare(
          `
            SELECT
              c.id AS cell_id,
              c.logical_code,
              c.hardware_channel,
              c.controller_id,
              c.row_number,
              c.column_number,
              COALESCE(SUM(b.available_quantity), 0) AS occupied_quantity
            FROM cells c
            LEFT JOIN inventory_balances b ON b.cell_id = c.id
            WHERE c.id = ? AND c.active = 1
            GROUP BY c.id
          `,
        )
        .get(Number(preferredCellId))
    : null;

  const sameProductCells = db
    .prepare(
      `
        SELECT
          c.id AS cell_id,
          c.logical_code,
          c.hardware_channel,
          c.controller_id,
          c.row_number,
          c.column_number,
          COALESCE(b.available_quantity, 0) AS available_quantity
        FROM cells c
        JOIN inventory_balances b ON b.cell_id = c.id
        WHERE b.product_id = ? AND c.active = 1
        ORDER BY COALESCE(b.available_quantity, 0) DESC,
                 c.row_number,
                 c.column_number
      `,
    )
    .all(product.id)
    .filter((cell) => cell.cell_id !== Number(preferredCellId || 0));

  const emptyCells = db
    .prepare(
      `
        SELECT
          c.id AS cell_id,
          c.logical_code,
          c.hardware_channel,
          c.controller_id,
          c.row_number,
          c.column_number
        FROM cells c
        LEFT JOIN inventory_balances b
          ON b.cell_id = c.id AND b.available_quantity > 0
        WHERE c.active = 1
          AND b.id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM inventory_balances existing_product_balance
            WHERE existing_product_balance.cell_id = c.id
              AND existing_product_balance.product_id = ?
          )
        ORDER BY c.row_number, c.column_number
      `,
    )
    .all(product.id)
    .filter((cell) => cell.cell_id !== Number(preferredCellId || 0));

  let remaining = requestedQuantity;
  const lines = [];

  if (preferredCell && remaining > 0) {
    const preferredSameProduct = db
      .prepare(
        `
          SELECT
            COALESCE(available_quantity, 0) AS available_quantity
          FROM inventory_balances
          WHERE product_id = ? AND cell_id = ?
        `,
      )
      .get(product.id, preferredCell.cell_id);
    const currentQuantity = preferredSameProduct
      ? Number(preferredSameProduct.available_quantity)
      : Number(preferredCell.occupied_quantity || 0);
    const room = Math.max(0, itemsPerCell - currentQuantity);

    if (room > 0) {
      const planned = Math.min(remaining, room);
      lines.push({
        product_id: product.id,
        cell_id: preferredCell.cell_id,
        planned_quantity: planned,
        guidance_color: "red",
      });
      remaining -= planned;
    }
  }

  for (const cell of sameProductCells) {
    if (remaining <= 0) {
      break;
    }
    const currentQuantity = Number(cell.available_quantity);
    const room = itemsPerCell - currentQuantity;
    if (room <= 0) {
      continue;
    }

    const planned = Math.min(remaining, room);
    lines.push({
      product_id: product.id,
      cell_id: cell.cell_id,
      planned_quantity: planned,
      guidance_color: "red",
    });
    remaining -= planned;
  }

  for (const cell of emptyCells) {
    if (remaining <= 0) {
      break;
    }

    const planned = Math.min(remaining, itemsPerCell);
    lines.push({
      product_id: product.id,
      cell_id: cell.cell_id,
      planned_quantity: planned,
      guidance_color: "red",
    });
    remaining -= planned;
  }

  if (remaining > 0) {
    throw new Error("Not enough free cells are available for this product capacity.");
  }

  return withTransaction(db, () => {
    const taskResult = db
      .prepare(
        `
          INSERT INTO tasks (type, status, summary, created_by, started_at)
          VALUES ('put', 'pending_review', ?, ?, ?)
        `,
      )
      .run(
        `${product.sku} put (${requestedQuantity} ${product.unit_of_measure})`,
        userId,
        nowIso(),
      );

    const taskId = Number(taskResult.lastInsertRowid);
    db.prepare("UPDATE tasks SET summary = ? WHERE id = ?").run(
      `Put Action Initiated - Task #${taskId}`,
      taskId,
    );

    for (const line of lines) {
      db.prepare(
        `
          INSERT INTO task_lines (task_id, product_id, cell_id, planned_quantity, guidance_color)
          VALUES (?, ?, ?, ?, ?)
        `,
      ).run(
        taskId,
        line.product_id,
        line.cell_id,
        line.planned_quantity,
        line.guidance_color,
      );
    }

    return getTask(db, taskId);
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
    db.prepare(
      `
        UPDATE tasks
        SET status = 'cancelled', completed_at = ?
        WHERE id = ?
      `,
    ).run(nowIso(), task.id);

    return getTask(db, task.id);
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

      db.prepare(
        `
          UPDATE task_lines
          SET actual_quantity = ?, exception_quantity = ?, note = ?, cell_id = ?
          WHERE id = ?
        `,
      ).run(actualQuantity, exceptionQuantity, note || null, targetCellId, line.id);

      const plannedBalance = getOrCreateBalance(db, line.product_id, line.cell_id);

      if (task.type === "pick") {
        if (actualQuantity > Number(plannedBalance.available_quantity)) {
          throw new Error(
            `Cell ${line.logical_code} only has ${Number(plannedBalance.available_quantity)} item(s) left for ${line.sku}. Start a new pick task with the current stock.`,
          );
        }

        db.prepare(
          `
            UPDATE inventory_balances
            SET available_quantity = available_quantity - ?
            WHERE id = ?
          `,
        ).run(actualQuantity, plannedBalance.id);
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
        const targetBalance = getOrCreateBalance(db, line.product_id, targetCellId);
        db.prepare(
          `
            UPDATE inventory_balances
            SET available_quantity = available_quantity + ?
            WHERE id = ?
          `,
        ).run(actualQuantity, targetBalance.id);
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

    db.prepare(
      `
        UPDATE tasks
        SET status = 'completed', completed_at = ?
        WHERE id = ?
      `,
    ).run(nowIso(), task.id);

    return {
      task: getTask(db, task.id),
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
    db.prepare("DELETE FROM task_lines WHERE task_id = ?").run(task.id);
    for (const allocation of nextAllocations) {
      db.prepare(
        `
          INSERT INTO task_lines (
            task_id, product_id, cell_id, planned_quantity, guidance_color, note
          )
          VALUES (?, ?, ?, ?, 'red', ?)
        `,
      ).run(task.id, productId, allocation.cellId, allocation.quantity, note || null);
    }
    return getTask(db, task.id);
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

      const oldBalance = getOrCreateBalance(db, line.product_id, line.cell_id);
      const newBalance = getOrCreateBalance(db, line.product_id, nextCellId);

      if (task.type === "pick") {
        const reversibleAvailable = Number(oldBalance.available_quantity) + previousQuantity;
        if (reversibleAvailable < nextQuantity) {
          throw new Error(
            `Cell ${line.logical_code} no longer has enough stock to apply this correction safely.`,
          );
        }

        db.prepare(
          `
            UPDATE inventory_balances
            SET available_quantity = available_quantity + ?
            WHERE id = ?
          `,
        ).run(previousQuantity, oldBalance.id);

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

        db.prepare(
          `
            UPDATE inventory_balances
            SET available_quantity = available_quantity - ?
            WHERE id = ?
          `,
        ).run(nextQuantity, oldBalance.id);

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

        db.prepare(
          `
            UPDATE inventory_balances
            SET available_quantity = available_quantity - ?
            WHERE id = ?
          `,
        ).run(previousQuantity, oldBalance.id);

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

        db.prepare(
          `
            UPDATE inventory_balances
            SET available_quantity = available_quantity + ?
            WHERE id = ?
          `,
        ).run(nextQuantity, newBalance.id);

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
      db.prepare(
        `
          UPDATE task_lines
          SET actual_quantity = ?, exception_quantity = ?, note = ?, cell_id = ?
          WHERE id = ?
        `,
      ).run(nextQuantity, nextExceptionQuantity, note || line.note, nextCellId, line.id);
    }

    return {
      task: getTask(db, task.id),
      anomalies: detectAnomalies(db).filter((anomaly) => touchedCellIds.has(anomaly.cellId)),
    };
  });
}

export function markPhysicalConfirmation(db, lineId) {
  const line = db
    .prepare(
      `
        SELECT
          tl.*,
          c.logical_code,
          c.hardware_channel,
          c.controller_id,
          ctrl.controller_code,
          ctrl.address AS controller_address
        FROM task_lines tl
        JOIN cells c ON c.id = tl.cell_id
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        WHERE tl.id = ?
      `,
    )
    .get(lineId);

  if (!line) {
    throw new Error("Task line not found.");
  }

  db.prepare(
    `
      UPDATE task_lines
      SET physical_confirmed_at = ?, actual_quantity = CASE WHEN actual_quantity = 0 THEN planned_quantity ELSE actual_quantity END
      WHERE id = ?
    `,
  ).run(nowIso(), line.id);

  return db
    .prepare(
      `
        SELECT
          tl.*,
          c.logical_code,
          c.hardware_channel,
          c.controller_id,
          ctrl.controller_code,
          ctrl.address AS controller_address
        FROM task_lines tl
        JOIN cells c ON c.id = tl.cell_id
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        WHERE tl.id = ?
      `,
    )
    .get(line.id);
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
    let appliedCount = 0;

    for (const line of normalizedLines) {
      const balance = getOrCreateBalance(db, line.product.id, cell.id);
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

      db.prepare(
        `
          UPDATE inventory_balances
          SET available_quantity = available_quantity + ?
          WHERE id = ?
        `,
      ).run(delta, balance.id);

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
  const normalized = String(keyValue || "").trim();
  if (!normalized) {
    throw new Error("Registration key value is required.");
  }

  db.prepare(
    `
      INSERT INTO registration_keys (key_value, role, status, expires_at, created_by, created_at)
      VALUES (?, ?, 'active', ?, ?, ?)
    `,
  ).run(
    normalized,
    role === "admin" ? "admin" : "operator",
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    userId,
    nowIso(),
  );
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

export function updateCellMapping(db, { cellId, hardwareChannel, logicalCode = null, mappedBy }) {
  const channel = Number(hardwareChannel);
  if (!Number.isFinite(channel) || channel <= 0) {
    throw new Error("Hardware channel must be a positive number.");
  }

  const nextLogicalCode = logicalCode == null ? null : normalizeLogicalCode(logicalCode);
  if (nextLogicalCode) {
    const existing = db
      .prepare("SELECT id FROM cells WHERE logical_code = ? AND id != ?")
      .get(nextLogicalCode, Number(cellId));
    if (existing) {
      throw new Error("Another cell already uses that name.");
    }
  }

  db.prepare(
    `
      UPDATE cells
      SET
        logical_code = COALESCE(?, logical_code),
        hardware_channel = ?,
        mapping_status = 'mapped',
        last_mapped_at = ?,
        mapped_by = ?
      WHERE id = ?
    `,
  ).run(nextLogicalCode, channel, nowIso(), mappedBy, Number(cellId));
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
  const code = requestedCode || nextDefaultControllerCode(db);
  const now = nowIso();
  const existingByCode = db.prepare("SELECT * FROM controllers WHERE controller_code = ?").get(code);
  const existingByDevice =
    !requestedCode && deviceIdentity
      ? db.prepare("SELECT * FROM controllers WHERE device_identity = ? ORDER BY id DESC LIMIT 1").get(deviceIdentity)
      : null;
  const existing = existingByCode || existingByDevice || null;
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
  db.prepare("UPDATE cells SET active = 0 WHERE controller_id = ? AND hardware_channel > ?").run(
    controllerId,
    count,
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
  }

  if (activeCellIds.length > 0) {
    const placeholders = activeCellIds.map(() => "?").join(", ");
    db.prepare(
      `
        UPDATE cells
        SET active = 0
        WHERE controller_id = ?
          AND id NOT IN (${placeholders})
      `,
    ).run(controllerId, ...activeCellIds);
  }

  return db.prepare("SELECT * FROM controllers WHERE id = ?").get(controllerId);
  });
}

export function updateProductItemsPerCell(db, { productId, itemsPerCell }) {
  const capacity = normalizeItemsPerCell(itemsPerCell);
  const result = db
    .prepare(
      `
        UPDATE products
        SET items_per_cell = ?
        WHERE id = ?
      `,
    )
    .run(capacity, Number(productId));

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
  const sourceBalance = getOrCreateBalance(db, product.id, sourceCell.id);
  if (Number(sourceBalance.available_quantity) < totalQuantity) {
    throw new Error("Source cell does not have enough quantity for this adjustment.");
  }

  return withTransaction(db, () => {
    db.prepare(
      `
        UPDATE inventory_balances
        SET available_quantity = available_quantity - ?
        WHERE id = ?
      `,
    ).run(totalQuantity, sourceBalance.id);

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

      const targetBalance = getOrCreateBalance(db, product.id, targetCell.id);
      db.prepare(
        `
          UPDATE inventory_balances
          SET available_quantity = available_quantity + ?
          WHERE id = ?
        `,
      ).run(move.quantity, targetBalance.id);

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
