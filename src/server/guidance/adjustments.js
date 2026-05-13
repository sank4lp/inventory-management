function formatQuantityForLed(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export function adjustmentPreviewTask({ userId }) {
  return {
    id: null,
    type: "adjustment",
    summary: "Adjustment quantity preview",
    created_by: userId,
  };
}

export function adjustmentQuantityGuidance(cells, { cellId, lines }) {
  const cell = cells.find((entry) => Number(entry.id) === Number(cellId));
  if (!cell) {
    throw new Error("Choose a cell before lighting the quantity.");
  }

  const quantities = lines
    .map((line) => String(line.absoluteQuantity || "").trim())
    .filter(Boolean)
    .map((value) => {
      const quantity = Number(value);
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new Error("Adjustment quantities must be zero or greater before lighting the LED.");
      }
      return quantity;
    });

  if (!quantities.length) {
    throw new Error("Enter at least one adjustment quantity before lighting the LED.");
  }

  const displayQuantity = formatQuantityForLed(
    quantities.reduce((sum, quantity) => sum + quantity, 0),
  );

  return {
    cell,
    displayQuantity,
    lines: [
      {
        cell_id: cell.id,
        logical_code: cell.logical_code,
        controller_id: cell.controller_id,
        controller_code: cell.controller_code,
        controller_address: cell.controller_address,
        hardware_channel: cell.hardware_channel,
        planned_quantity: displayQuantity,
        guidance_color: "amber",
      },
    ],
  };
}
