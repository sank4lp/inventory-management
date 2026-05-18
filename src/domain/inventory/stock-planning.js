export const PUT_CAPACITY_ERROR_MESSAGE =
  "System is already full for this product. Eligible empty and same-product cells do not have enough remaining room.";

function inventoryLine(productId, cellId, plannedQuantity, guidanceColor) {
  return {
    product_id: productId,
    cell_id: cellId,
    planned_quantity: plannedQuantity,
    guidance_color: guidanceColor,
  };
}

export function planPickLines({ product, requestedQuantity, balances }) {
  const totalAvailable = balances.reduce(
    (sum, row) => sum + Number(row.available_quantity),
    0,
  );

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

    const availableQuantity = Number(row.available_quantity);
    const plannedQuantity = Math.min(remaining, availableQuantity);
    if (plannedQuantity <= 0) {
      continue;
    }

    lines.push(inventoryLine(product.id, row.cell_id, plannedQuantity, "green"));
    remaining -= plannedQuantity;
  }

  return lines;
}

export function planPutLines({
  product,
  requestedQuantity,
  itemsPerCell,
  preferredCell = null,
  sameProductCells,
  emptyCells,
}) {
  let remaining = requestedQuantity;
  const lines = [];

  if (preferredCell && remaining > 0) {
    const currentQuantity = preferredCell.same_product_quantity !== undefined
      ? Number(preferredCell.same_product_quantity)
      : Number(preferredCell.occupied_quantity || 0);
    const room = Math.max(0, itemsPerCell - currentQuantity);

    if (room > 0) {
      const plannedQuantity = Math.min(remaining, room);
      lines.push(inventoryLine(product.id, preferredCell.cell_id, plannedQuantity, "red"));
      remaining -= plannedQuantity;
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

    const plannedQuantity = Math.min(remaining, room);
    lines.push(inventoryLine(product.id, cell.cell_id, plannedQuantity, "red"));
    remaining -= plannedQuantity;
  }

  for (const cell of emptyCells) {
    if (remaining <= 0) {
      break;
    }

    const plannedQuantity = Math.min(remaining, itemsPerCell);
    lines.push(inventoryLine(product.id, cell.cell_id, plannedQuantity, "red"));
    remaining -= plannedQuantity;
  }

  if (remaining > 0) {
    throw new Error(PUT_CAPACITY_ERROR_MESSAGE);
  }

  return lines;
}

export function planRecommendedMoveDestinations({
  sourceCellId,
  requestedQuantity,
  itemsPerCell,
  sameProductCells,
  emptyCells,
}) {
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
    sourceCellId: Number(sourceCellId),
    destinations,
    unresolvedQuantity: remaining,
  };
}
