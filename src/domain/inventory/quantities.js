export function normalizePositiveQuantity(value, message = "Quantity must be a positive number.") {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(message);
  }
  return quantity;
}

export function normalizeNonNegativeQuantity(
  value,
  message = "Quantity values must be zero or greater.",
) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(message);
  }
  return quantity;
}

export function normalizeItemsPerCell(value) {
  return normalizePositiveQuantity(value, "Items per cell must be a positive number.");
}

export function quantitiesMatch(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.000001;
}

export function assertSufficientBalance(balance, quantity, message) {
  if (Number(balance.available_quantity) < Number(quantity)) {
    throw new Error(message);
  }
}
