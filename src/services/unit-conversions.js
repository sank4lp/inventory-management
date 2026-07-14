import { createHash } from "node:crypto";

import { withTransaction } from "../db.js";

function nowIso() {
  return new Date().toISOString();
}

function assertAdmin(actor) {
  const id = Number(actor?.id ?? actor?.userId);
  if (!Number.isInteger(id) || id <= 0 || actor?.role !== "admin") {
    throw new Error("Only an admin can migrate a product unit.");
  }
  return id;
}

function normalizedUnit(value, label) {
  const unit = String(value || "").replace(/\s+/g, " ").trim();
  if (!unit) {
    throw new Error(`${label} is required.`);
  }
  if (unit.length > 48) {
    throw new Error(`${label} must be 48 characters or fewer.`);
  }
  return unit;
}

function normalizedFactor(value) {
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("Conversion factor must be a number greater than zero.");
  }
  return factor;
}

function normalizedPrecision(value) {
  const precision = Number(value ?? 3);
  if (!Number.isInteger(precision) || precision < 0 || precision > 8) {
    throw new Error("Precision must be a whole number from 0 to 8.");
  }
  return precision;
}

function roundQuantity(value, factor, precision) {
  return Number((Number(value || 0) * factor).toFixed(precision));
}

function conversionSnapshot(db, productId) {
  const product = db
    .prepare(
      `
        SELECT id, sku, name, unit_of_measure, items_per_cell
        FROM products
        WHERE id = ? AND active = 1
      `,
    )
    .get(Number(productId));
  if (!product) {
    throw new Error("Product not found.");
  }

  const balances = db
    .prepare(
      `
        SELECT id, available_quantity, reserved_quantity
        FROM inventory_balances
        WHERE product_id = ?
        ORDER BY id
      `,
    )
    .all(product.id);
  const openTaskLines = db
    .prepare(
      `
        SELECT
          tl.id,
          tl.planned_quantity,
          tl.actual_quantity,
          tl.exception_quantity,
          COALESCE(tl.unit_of_measure, ?) AS unit_of_measure,
          t.status
        FROM task_lines tl
        JOIN tasks t ON t.id = tl.task_id
        WHERE tl.product_id = ?
          AND t.status IN ('planned', 'in_progress', 'pending_review')
        ORDER BY tl.id
      `,
    )
    .all(product.unit_of_measure, product.id);
  const history = db
    .prepare(
      `
        SELECT
          SUM(CASE WHEN t.status IN ('completed', 'cancelled') THEN 1 ELSE 0 END) AS task_line_count,
          (SELECT COUNT(*) FROM transactions tr WHERE tr.product_id = ?) AS transaction_count
        FROM task_lines tl
        JOIN tasks t ON t.id = tl.task_id
        WHERE tl.product_id = ?
      `,
    )
    .get(product.id, product.id);

  return {
    product,
    balances,
    openTaskLines,
    history: {
      taskLineCount: Number(history?.task_line_count || 0),
      transactionCount: Number(history?.transaction_count || 0),
    },
  };
}

function totals(snapshot) {
  return snapshot.balances.reduce(
    (result, row) => ({
      available: result.available + Number(row.available_quantity || 0),
      reserved: result.reserved + Number(row.reserved_quantity || 0),
    }),
    { available: 0, reserved: 0 },
  );
}

function previewToken(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function previewProductUnitConversion(db, input) {
  assertAdmin(input.actor);
  const snapshot = conversionSnapshot(db, input.productId ?? input.product_id);
  const sourceUnit = normalizedUnit(snapshot.product.unit_of_measure, "Current unit");
  const targetUnit = normalizedUnit(input.targetUnit ?? input.target_unit, "Target unit");
  if (sourceUnit.toLowerCase() === targetUnit.toLowerCase()) {
    throw new Error("Choose a target unit different from the current unit.");
  }
  const factor = normalizedFactor(input.factor);
  const precision = normalizedPrecision(input.precision ?? input.precision_digits);
  const beforeTotals = totals(snapshot);
  const before = {
    productId: snapshot.product.id,
    sourceUnit,
    targetUnit,
    factor,
    precision,
    itemsPerLocation: Number(snapshot.product.items_per_cell),
    balances: snapshot.balances,
    openTaskLines: snapshot.openTaskLines,
    history: snapshot.history,
  };
  const after = {
    itemsPerLocation: roundQuantity(snapshot.product.items_per_cell, factor, precision),
    available: roundQuantity(beforeTotals.available, factor, precision),
    reserved: roundQuantity(beforeTotals.reserved, factor, precision),
    openTaskLines: snapshot.openTaskLines.length,
  };
  const token = previewToken({ before, after });

  return {
    token,
    product: snapshot.product,
    sourceUnit,
    targetUnit,
    factor,
    precision,
    before: {
      ...beforeTotals,
      itemsPerLocation: Number(snapshot.product.items_per_cell),
      openTaskLines: snapshot.openTaskLines.length,
    },
    after,
    history: snapshot.history,
    explanation: `1 ${sourceUnit} = ${factor} ${targetUnit}`,
  };
}

export function applyProductUnitConversion(db, input) {
  const createdBy = assertAdmin(input.actor);
  const preview = previewProductUnitConversion(db, input);
  if (!input.previewToken || input.previewToken !== preview.token) {
    throw new Error("Inventory changed after the preview. Review the conversion again before applying it.");
  }

  return withTransaction(db, () => {
    const snapshot = conversionSnapshot(db, preview.product.id);
    for (const balance of snapshot.balances) {
      db.prepare(
        `
          UPDATE inventory_balances
          SET available_quantity = ?, reserved_quantity = ?
          WHERE id = ?
        `,
      ).run(
        roundQuantity(balance.available_quantity, preview.factor, preview.precision),
        roundQuantity(balance.reserved_quantity, preview.factor, preview.precision),
        balance.id,
      );
    }

    for (const line of snapshot.openTaskLines) {
      db.prepare(
        `
          UPDATE task_lines
          SET planned_quantity = ?, actual_quantity = ?, exception_quantity = ?, unit_of_measure = ?
          WHERE id = ?
        `,
      ).run(
        roundQuantity(line.planned_quantity, preview.factor, preview.precision),
        roundQuantity(line.actual_quantity, preview.factor, preview.precision),
        roundQuantity(line.exception_quantity, preview.factor, preview.precision),
        preview.targetUnit,
        line.id,
      );
    }

    db.prepare(
      `
        UPDATE products
        SET unit_of_measure = ?, items_per_cell = ?
        WHERE id = ? AND unit_of_measure = ?
      `,
    ).run(
      preview.targetUnit,
      preview.after.itemsPerLocation,
      preview.product.id,
      preview.sourceUnit,
    );

    const afterSnapshot = conversionSnapshot(db, preview.product.id);
    db.prepare(
      `
        INSERT INTO product_unit_conversions (
          product_id, from_unit, to_unit, factor, precision_digits,
          preview_token, before_json, after_json, created_by, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      preview.product.id,
      preview.sourceUnit,
      preview.targetUnit,
      preview.factor,
      preview.precision,
      preview.token,
      JSON.stringify(snapshot),
      JSON.stringify(afterSnapshot),
      createdBy,
      nowIso(),
    );

    return {
      ...preview,
      applied: true,
      product: afterSnapshot.product,
    };
  });
}

export function listProductUnitConversions(db, productId = null) {
  return db
    .prepare(
      `
        SELECT puc.*, p.sku, p.name, u.username AS created_by_username
        FROM product_unit_conversions puc
        JOIN products p ON p.id = puc.product_id
        JOIN users u ON u.id = puc.created_by
        WHERE (? IS NULL OR puc.product_id = ?)
        ORDER BY puc.created_at DESC, puc.id DESC
      `,
    )
    .all(productId, productId);
}

export function createUnitConversionService({ db }) {
  return {
    preview(input) {
      return previewProductUnitConversion(db, input);
    },
    apply(input) {
      return applyProductUnitConversion(db, input);
    },
    list(productId = null) {
      return listProductUnitConversions(db, productId);
    },
  };
}
