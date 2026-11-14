export function historicalFactor(db, productId, originalUnit, recordedAt, sourceProductId=null,context=null) {
  const sameUnit=(a,b)=>String(a||'').trim().toUpperCase()===String(b||'').trim().toUpperCase();
  let id=sourceProductId||productId, unit=originalUnit, factor=1, since=recordedAt||'';const visited=new Set();
  while(!visited.has(id)){
    visited.add(id);const product=context?context.products.get(id):db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if(!product)throw new Error('Historical product no longer exists.');
    for(const c of (context?(context.conversions.get(id)||[]).filter(c=>c.created_at>=since):db.prepare('SELECT * FROM product_unit_conversions WHERE product_id=? AND created_at>=? ORDER BY created_at,id').all(id,since))){
      if(product.merged_at&&c.created_at>product.merged_at)continue;
      if(!sameUnit(c.from_unit,unit))throw new Error('The unit conversion history is incomplete. Preserve the proposed correction for reconciliation.');
      factor*=c.factor;unit=c.to_unit;
    }
    if(!sameUnit(unit,product.unit_of_measure))throw new Error('Cannot safely translate this historical unit to the current stock unit.');
    if(id===productId)return factor;
    if(!product.merged_into)break;
    id=product.merged_into;since=product.merged_at;
  }
  throw new Error('The product merge history is incomplete. Review this correction before saving.');
}
