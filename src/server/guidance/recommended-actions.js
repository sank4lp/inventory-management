export function recommendationGuidanceTask(form = {}) {
  return {
    id: null,
    type: "recommended_move",
    summary: form.reason || "Recommended action move",
  };
}

export function recommendationGuidanceLines(cells, { sourceCellId, targetCellId, quantity }) {
  const moveQuantity = Number(quantity);
  if (!Number.isFinite(moveQuantity) || moveQuantity <= 0) {
    throw new Error("Move quantity must be greater than zero before lighting cells.");
  }

  const sourceCell = cells.find((entry) => entry.id === Number(sourceCellId));
  const targetCell = cells.find((entry) => entry.id === Number(targetCellId));
  if (!sourceCell) {
    throw new Error("Source cell was not found.");
  }
  if (!targetCell) {
    throw new Error("Choose a target cell before sending the light signal.");
  }

  return [
    {
      ...sourceCell,
      cell_id: sourceCell.id,
      planned_quantity: moveQuantity,
      guidance_color: "green",
      guidance_role: "pick_source",
    },
    {
      ...targetCell,
      cell_id: targetCell.id,
      planned_quantity: moveQuantity,
      guidance_color: "red",
      guidance_role: "put_target",
    },
  ];
}

export function uniqueGuidanceLines(lines) {
  const byTarget = new Map();
  for (const line of lines) {
    const color = line.guidance_color || "manual";
    const key = `${line.controller_id || "manual"}:${line.hardware_channel || line.cell_id}:${color}`;
    const existing = byTarget.get(key);
    if (!existing) {
      byTarget.set(key, { ...line });
      continue;
    }
    existing.planned_quantity =
      Number(existing.planned_quantity || 0) + Number(line.planned_quantity || 0);
  }
  return Array.from(byTarget.values());
}
