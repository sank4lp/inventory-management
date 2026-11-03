const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;

// Read the installed schema so newer work and stocktaking tables are protected too.
export function cellHasReferences(db, cellId) {
  const references = db.prepare(`
    SELECT m.name AS table_name, fk."from" AS column_name
    FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk
    WHERE m.type = 'table' AND fk."table" = 'cells'
      AND m.name NOT IN ('inventory_balances', 'device_events')
  `).all();
  return references.some(reference => Boolean(db.prepare(
    `SELECT 1 FROM ${quoteIdentifier(reference.table_name)} WHERE ${quoteIdentifier(reference.column_name)} = ? LIMIT 1`,
  ).get(Number(cellId))));
}
