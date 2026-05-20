export function productFindGuidanceTask(product = {}) {
  return {
    id: null,
    type: "product_find",
    summary: `Find ${product.sku || "product"}`,
  };
}

export function productFindGuidanceLines(product = {}) {
  return (product.locations || [])
    .map((location) => ({
      ...location,
      id: location.cell_id,
      cell_id: location.cell_id,
      planned_quantity: Number(location.available_quantity || 0),
      guidance_color: "yellow",
      guidance_role: "product_find",
    }))
    .filter((line) => Number.isFinite(line.planned_quantity) && line.planned_quantity > 0);
}
