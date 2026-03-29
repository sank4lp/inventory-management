function rangeClause(columnName, fromAt, toAt) {
  const parts = [];
  const params = [];

  if (fromAt) {
    parts.push(`${columnName} >= ?`);
    params.push(fromAt);
  }

  if (toAt) {
    parts.push(`${columnName} <= ?`);
    params.push(toAt);
  }

  return {
    clause: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params,
  };
}

export function buildReports(db, { fromAt, toAt }) {
  const transactionRange = rangeClause("tr.created_at", fromAt, toAt);
  const taskRange = rangeClause("t.completed_at", fromAt, toAt);
  const taskActivityRange = rangeClause("t.started_at", fromAt, toAt);
  const userTransactionRange = rangeClause("tr.created_at", fromAt, toAt);

  const stockSnapshot = db
    .prepare(
      `
        SELECT
          p.sku,
          p.name,
          p.brand,
          p.unit_of_measure,
          COALESCE(SUM(b.available_quantity), 0) AS available,
          COALESCE(SUM(b.reserved_quantity), 0) AS reserved
        FROM products p
        LEFT JOIN inventory_balances b ON b.product_id = p.id
        GROUP BY p.id
        ORDER BY p.name
      `,
    )
    .all();

  const movementSummary = db
    .prepare(
      `
        SELECT
          date(tr.created_at) AS movement_date,
          SUM(CASE WHEN tr.type = 'pick' THEN ABS(tr.quantity_delta) ELSE 0 END) AS picked,
          SUM(CASE WHEN tr.type = 'put' THEN tr.quantity_delta ELSE 0 END) AS put_away,
          SUM(tr.quantity_delta) AS net_change
        FROM transactions tr
        ${transactionRange.clause}
        GROUP BY date(tr.created_at)
        ORDER BY movement_date DESC
      `,
    )
    .all(...transactionRange.params);

  const userActivity = db
    .prepare(
      `
        SELECT
          u.username,
          (
            SELECT COUNT(*)
            FROM tasks t
            WHERE t.created_by = u.id
            ${taskActivityRange.clause ? `AND ${taskActivityRange.clause.slice(6)}` : ""}
          ) AS tasks_created,
          (
            SELECT COUNT(*)
            FROM transactions tr
            WHERE tr.user_id = u.id
            ${userTransactionRange.clause ? `AND ${userTransactionRange.clause.slice(6)}` : ""}
          ) AS transactions_recorded
        FROM users u
        ORDER BY u.username
      `,
    )
    .all(...taskActivityRange.params, ...userTransactionRange.params);

  const exceptions = db
    .prepare(
      `
        SELECT
          t.id AS task_id,
          t.type,
          p.sku,
          p.name AS product_name,
          c.logical_code,
          tl.planned_quantity,
          tl.actual_quantity,
          tl.exception_quantity,
          t.completed_at
        FROM task_lines tl
        JOIN tasks t ON t.id = tl.task_id
        JOIN products p ON p.id = tl.product_id
        JOIN cells c ON c.id = tl.cell_id
        WHERE tl.exception_quantity > 0
        ${taskRange.clause ? `AND ${taskRange.clause.slice(6)}` : ""}
        ORDER BY t.id DESC
      `,
    )
    .all(...taskRange.params);

  const adjustments = db
    .prepare(
      `
        SELECT
          tr.created_at,
          p.sku,
          c.logical_code,
          tr.quantity_delta,
          u.username,
          tr.reason
        FROM transactions tr
        JOIN products p ON p.id = tr.product_id
        JOIN cells c ON c.id = tr.cell_id
        JOIN users u ON u.id = tr.user_id
        WHERE tr.type = 'adjustment'
        ${transactionRange.clause ? `AND ${transactionRange.clause.slice(6)}` : ""}
        ORDER BY tr.created_at DESC
      `,
    )
    .all(...transactionRange.params);

  return {
    stockSnapshot,
    movementSummary,
    userActivity,
    exceptions,
    adjustments,
  };
}
