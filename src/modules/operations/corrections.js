export function historicalFactor(db, productId, originalUnit, recordedAt) {
  const current=db.prepare('SELECT unit_of_measure FROM products WHERE id=?').get(productId).unit_of_measure;
  let unit=originalUnit, factor=1;
  for(const c of db.prepare('SELECT * FROM product_unit_conversions WHERE product_id=? AND created_at>=? ORDER BY created_at,id').all(productId,recordedAt||'')){
    if(c.from_unit!==unit)throw new Error('The unit conversion history is incomplete. Preserve the proposed correction for reconciliation.');
    factor*=c.factor;unit=c.to_unit;
  }
  if(unit!==current)throw new Error('Cannot safely translate this historical unit to the current stock unit.');
  return factor;
}
