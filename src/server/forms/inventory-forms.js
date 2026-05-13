export function parseTaskReviewForm(form) {
  return {
    actualQuantities: Object.fromEntries(
      Object.entries(form)
        .filter(([key]) => key.startsWith("actual_") && !key.startsWith("actual_cell_"))
        .map(([key, value]) => [Number(key.slice(7)), value]),
    ),
    actualCellIds: Object.fromEntries(
      Object.entries(form)
        .filter(([key]) => key.startsWith("actual_cell_"))
        .map(([key, value]) => [Number(key.slice(12)), value]),
    ),
  };
}

export function parsePutPlanForm(form) {
  const byKey = new Map();

  for (const [key, value] of Object.entries(form)) {
    if (key.startsWith("plan_qty_")) {
      const suffix = key.slice("plan_qty_".length);
      byKey.set(suffix, {
        ...(byKey.get(suffix) || {}),
        quantity: value,
      });
    }
    if (key.startsWith("plan_cell_")) {
      const suffix = key.slice("plan_cell_".length);
      byKey.set(suffix, {
        ...(byKey.get(suffix) || {}),
        cellId: value,
      });
    }
  }

  return Array.from(byKey.values()).filter(
    (allocation) =>
      String(allocation.quantity || "").trim() || String(allocation.cellId || "").trim(),
  );
}

export function parseCellMappingForm(form) {
  return Object.entries(form)
    .filter(([key]) => key.startsWith("target_cell_id_"))
    .map(([key, targetCellId]) => {
      const sourceCellId = key.slice("target_cell_id_".length);
      return {
        sourceCellId,
        targetCellId,
        originalTargetCellId: form[`original_target_cell_id_${sourceCellId}`],
        hardwareChannel: form[`hardware_channel_${sourceCellId}`],
      };
    })
    .filter(
      (mapping) =>
        String(mapping.targetCellId || "").trim() &&
        String(mapping.hardwareChannel || "").trim() &&
        String(mapping.targetCellId) !== String(mapping.originalTargetCellId),
    );
}

export function parseAdjustmentLines(form) {
  const lineIndexes = Array.from(
    new Set(
      Object.keys(form)
        .map(
          (key) =>
            key.match(/^product_id_(.+)$/)?.[1] ||
            key.match(/^absolute_quantity_(.+)$/)?.[1] ||
            null,
        )
        .filter(Boolean),
    ),
  ).sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));

  return lineIndexes
    .map((index) => ({
      productId: form[`product_id_${index}`],
      absoluteQuantity: form[`absolute_quantity_${index}`],
    }))
    .filter(
      (line) =>
        String(line.productId || "").trim() || String(line.absoluteQuantity || "").trim(),
    );
}

export function parseRecommendedActionMoves(form) {
  return Object.entries(form)
    .filter(([key, value]) => key.startsWith("move_qty_") && String(value).trim())
    .map(([key, value]) => {
      const suffix = key.slice("move_qty_".length);
      return {
        index: suffix,
        quantity: value,
        targetCellId: form[`move_cell_${suffix}`],
      };
    });
}
