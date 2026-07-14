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

function andRangeClause(columnName, fromAt, toAt) {
  const { clause, params } = rangeClause(columnName, fromAt, toAt);
  return {
    clause: clause ? `AND ${clause.slice(6)}` : "",
    params,
  };
}

const PRODUCT_MOVEMENT_METRICS = new Set([
  "picked_quantity",
  "pick_frequency",
  "put_quantity",
  "put_frequency",
  "net_outflow",
  "total_handled",
]);
const REPORT_VIRTUAL_COLUMNS = new Set([
  ...PRODUCT_MOVEMENT_METRICS,
  "available_quantity",
  "group_label",
  "product_count",
]);

function cleanMovementFilter(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!text || text.length > 120) {
    throw new Error(`${label} must be between 1 and 120 characters.`);
  }
  return text;
}

function movementMetric(options) {
  const metric = String(options.metric || "picked_quantity");
  if (!PRODUCT_MOVEMENT_METRICS.has(metric)) {
    throw new Error("Choose a supported product movement metric.");
  }
  return metric;
}

function movementGroupBy(db, options) {
  const groupBy = String(options.groupBy || options.group_by || "product");
  if (["product", "category", "unit_of_measure"].includes(groupBy)) {
    return groupBy;
  }
  const customField = groupBy.startsWith("custom.")
    ? db
        .prepare(
          `
            SELECT field_key
            FROM product_field_definitions
            WHERE field_key = ? AND field_kind = 'custom' AND active = 1 AND reportable = 1
          `,
        )
        .get(groupBy)
    : null;
  if (!customField) {
    throw new Error("Choose a supported product movement grouping.");
  }
  return groupBy;
}

function productMovementLabels(db, groupBy = "product") {
  const labels = Object.fromEntries(
    db
      .prepare(
        `
          SELECT field_key, label
          FROM product_field_definitions
          WHERE active = 1 AND reportable = 1
          ORDER BY sort_order, id
        `,
      )
      .all()
      .map((row) => [row.field_key, row.label]),
  );
  if (groupBy.startsWith("custom.")) {
    const field = db
      .prepare("SELECT label FROM product_field_definitions WHERE field_key = ?")
      .get(groupBy);
    if (field) {
      labels[groupBy] = field.label;
    }
  }
  return labels;
}

function movementGroupKey(event, groupBy) {
  const unit = String(event.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
  const unitToken = normalizedCompositionToken(unit);
  if (groupBy.startsWith("custom.")) {
    const value = String(event.custom_group_value || "Not set").trim() || "Not set";
    return `${groupBy}:${normalizedCompositionToken(value)}\u0000unit:${unitToken}`;
  }
  if (groupBy === "unit_of_measure") {
    return `unit:${unitToken}`;
  }
  if (groupBy === "category") {
    // Quantity totals are never merged across units. A category therefore has
    // one row per unit unless the caller filters to a single unit first.
    const category = String(event.category || "Uncategorized").trim() || "Uncategorized";
    return `category:${normalizedCompositionToken(category)}\u0000unit:${unitToken}`;
  }
  return `product:${event.product_id}\u0000unit:${unitToken}`;
}

function emptyMovementRow(event, groupBy) {
  const category = String(event.category || "Uncategorized").trim() || "Uncategorized";
  const unit = String(event.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
  const unitToken = normalizedCompositionToken(unit);
  if (groupBy.startsWith("custom.")) {
    const value = String(event.custom_group_value || "Not set").trim() || "Not set";
    return {
      key: `${groupBy}:${normalizedCompositionToken(value)}\u0000unit:${unitToken}`,
      product_id: null,
      sku: null,
      name: value,
      brand: null,
      category,
      unit_of_measure: unit,
      custom_field_key: groupBy,
      custom_field_value: value,
    };
  }
  if (groupBy === "unit_of_measure") {
    return {
      key: `unit:${unitToken}`,
      product_id: null,
      sku: null,
      name: unit,
      brand: null,
      category: null,
      unit_of_measure: unit,
    };
  }
  if (groupBy === "category") {
    return {
      key: `category:${normalizedCompositionToken(category)}\u0000unit:${unitToken}`,
      product_id: null,
      sku: null,
      name: category,
      brand: null,
      category,
      unit_of_measure: unit,
    };
  }
  return {
    key: `product:${event.product_id}\u0000unit:${unitToken}`,
    product_id: Number(event.product_id),
    sku: event.sku,
    name: event.name,
    brand: event.brand,
    category: event.category,
    variant: event.variant,
    unit_of_measure: unit,
    description: event.description,
    items_per_cell: event.items_per_cell,
  };
}

function stabilizeMovementRowLabels(row, event, groupBy) {
  const unit = String(event.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
  row.unit_of_measure = stableCompositionLabel(row.unit_of_measure, unit);
  if (groupBy === "unit_of_measure") {
    row.name = row.unit_of_measure;
    return;
  }
  if (groupBy === "category") {
    const category = String(event.category || "Uncategorized").trim() || "Uncategorized";
    row.name = stableCompositionLabel(row.name, category);
    row.category = row.name;
    return;
  }
  if (groupBy.startsWith("custom.")) {
    const value = String(event.custom_group_value || "Not set").trim() || "Not set";
    row.name = stableCompositionLabel(row.name, value);
    row.custom_field_value = row.name;
  }
}

function movementDimensionlessGroupKey(row, groupBy) {
  if (groupBy === "category") {
    return `category:${normalizedCompositionToken(row.category || row.name || "Uncategorized")}`;
  }
  if (groupBy.startsWith("custom.")) {
    return `${groupBy}:${normalizedCompositionToken(row.custom_field_value || row.name || "Not set")}`;
  }
  return row.key;
}

function aggregateMovementFrequencyRows(rows, groupBy) {
  if (groupBy !== "category" && !groupBy.startsWith("custom.")) {
    return rows;
  }

  const aggregates = new Map();
  for (const source of rows) {
    const key = movementDimensionlessGroupKey(source, groupBy);
    let row = aggregates.get(key);
    if (!row) {
      row = {
        ...source,
        key,
        unit_of_measure: null,
        picked_quantity: 0,
        pick_frequency: 0,
        put_quantity: 0,
        put_frequency: 0,
        net_outflow: 0,
        total_handled: 0,
        available_quantity: 0,
        _pickTasks: new Set(),
        _putTasks: new Set(),
        _units: new Map(),
      };
      aggregates.set(key, row);
    } else {
      row.name = stableCompositionLabel(row.name, source.name);
      if (groupBy === "category") {
        row.category = row.name;
      } else {
        row.custom_field_value = row.name;
      }
    }

    const unit = String(source.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
    const unitToken = normalizedCompositionToken(unit);
    row._units.set(unitToken, stableCompositionLabel(row._units.get(unitToken), unit));
    for (const taskId of source._pickTasks || []) {
      row._pickTasks.add(taskId);
    }
    for (const taskId of source._putTasks || []) {
      row._putTasks.add(taskId);
    }
    row.picked_quantity += Number(source.picked_quantity || 0);
    row.put_quantity += Number(source.put_quantity || 0);
    row.net_outflow += Number(source.net_outflow || 0);
    row.total_handled += Number(source.total_handled || 0);
    row.available_quantity += Number(source.available_quantity || 0);
  }

  return Array.from(aggregates.values()).map((row) => {
    const units = Array.from(row._units.values()).sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" }),
    );
    row.pick_frequency = row._pickTasks.size;
    row.put_frequency = row._putTasks.size;
    row.units = units;
    row.quantity_comparison = units.length > 1 ? "separate_by_unit" : "comparable";
    row.unit_of_measure = units.length === 1 ? units[0] : null;
    if (units.length > 1) {
      row.picked_quantity = null;
      row.put_quantity = null;
      row.net_outflow = null;
      row.total_handled = null;
      row.available_quantity = null;
    }
    delete row._pickTasks;
    delete row._putTasks;
    delete row._stockProducts;
    delete row._units;
    return row;
  });
}

function compareMovementRows(metric) {
  return (left, right) => {
    const difference = Number(right[metric] || 0) - Number(left[metric] || 0);
    if (difference !== 0) {
      return difference;
    }
    const nameOrder = String(left.name || "").localeCompare(String(right.name || ""), "en", {
      sensitivity: "base",
    });
    if (nameOrder !== 0) {
      return nameOrder;
    }
    const skuOrder = String(left.sku || "").localeCompare(String(right.sku || ""), "en", {
      sensitivity: "base",
    });
    return skuOrder || Number(left.product_id || 0) - Number(right.product_id || 0);
  };
}

function movementLeader(rows, metric) {
  return [...rows].sort(compareMovementRows(metric))[0] || null;
}

function sumMovementRows(rows) {
  return rows.reduce(
    (summary, row) => ({
      picked_quantity: summary.picked_quantity + row.picked_quantity,
      put_quantity: summary.put_quantity + row.put_quantity,
      total_handled: summary.total_handled + row.total_handled,
      net_outflow: summary.net_outflow + row.net_outflow,
    }),
    { picked_quantity: 0, put_quantity: 0, total_handled: 0, net_outflow: 0 },
  );
}

function typedAttributeValue(row) {
  if (row.data_type === "number") {
    return row.value_number;
  }
  if (row.data_type === "date") {
    return row.value_date;
  }
  if (row.data_type === "boolean") {
    return row.value_boolean === null || row.value_boolean === undefined
      ? null
      : Boolean(row.value_boolean);
  }
  return row.value_text;
}

function attachRequestedProductFields(db, rows, columns) {
  const requested = Array.isArray(columns)
    ? Array.from(
        new Set(
          columns
            .map((column) => String(column))
            .filter((column) => !REPORT_VIRTUAL_COLUMNS.has(column)),
        ),
      )
    : [];
  if (!requested.length) {
    return;
  }

  const placeholders = requested.map(() => "?").join(", ");
  const definitions = db
    .prepare(
      `
        SELECT *
        FROM product_field_definitions
        WHERE field_key IN (${placeholders})
          AND active = 1
          AND reportable = 1
      `,
    )
    .all(...requested);
  const definitionsByKey = new Map(definitions.map((field) => [field.field_key, field]));
  const unavailable = requested.filter((fieldKey) => !definitionsByKey.has(fieldKey));
  if (unavailable.length) {
    throw new Error(`Report field ${unavailable[0]} is not available.`);
  }

  const productRows = rows.filter((row) => row.product_id);
  const customFields = definitions.filter((field) => field.field_kind === "custom");
  const attributes = new Map();
  if (productRows.length && customFields.length) {
    const productPlaceholders = productRows.map(() => "?").join(", ");
    const fieldPlaceholders = customFields.map(() => "?").join(", ");
    const values = db
      .prepare(
        `
          SELECT pav.*, pfd.field_key, pfd.data_type
          FROM product_attribute_values pav
          JOIN product_field_definitions pfd ON pfd.id = pav.field_definition_id
          WHERE pav.product_id IN (${productPlaceholders})
            AND pav.field_definition_id IN (${fieldPlaceholders})
        `,
      )
      .all(
        ...productRows.map((row) => row.product_id),
        ...customFields.map((field) => field.id),
      );
    for (const value of values) {
      attributes.set(
        `${value.product_id}:${value.field_key}`,
        typedAttributeValue(value),
      );
    }
  }

  for (const row of rows) {
    row.fields = {};
    for (const fieldKey of requested) {
      const definition = definitionsByKey.get(fieldKey);
      if (!row.product_id) {
        row.fields[fieldKey] = null;
      } else if (definition.field_kind === "custom") {
        row.fields[fieldKey] = attributes.get(`${row.product_id}:${fieldKey}`) ?? null;
      } else {
        row.fields[fieldKey] = row[definition.source_column] ?? null;
      }
    }
  }
}

export function buildProductMovementReport(db, options = {}) {
  const metric = movementMetric(options);
  const groupBy = movementGroupBy(db, options);
  const columns = Array.isArray(options.columns)
    ? options.columns
    : [
        "product.sku",
        "product.name",
        "picked_quantity",
        "pick_frequency",
        "put_quantity",
        "net_outflow",
      ];
  const category = cleanMovementFilter(
    options.category ?? options.filters?.category,
    "Category filter",
  );
  const unitOfMeasure = cleanMovementFilter(
    options.unitOfMeasure ??
      options.unit_of_measure ??
      options.filters?.unitOfMeasure ??
      options.filters?.unit_of_measure,
    "Unit of measure filter",
  );
  const topNValue = Number(options.topN ?? options.top_n ?? 10);
  if (!Number.isInteger(topNValue) || topNValue < 1 || topNValue > 50) {
    throw new Error("Top results must be a whole number from 1 to 50.");
  }

  const conditions = [
    "t.status = 'completed'",
    "t.type IN ('pick', 'put')",
    "t.completed_at IS NOT NULL",
  ];
  const params = [];
  if (options.fromAt) {
    conditions.push("t.completed_at >= ?");
    params.push(options.fromAt);
  }
  if (options.toAt) {
    conditions.push("t.completed_at <= ?");
    params.push(options.toAt);
  }
  if (category) {
    conditions.push("p.category = ? COLLATE NOCASE");
    params.push(category);
  }
  if (unitOfMeasure) {
    conditions.push("p.unit_of_measure = ? COLLATE NOCASE");
    params.push(unitOfMeasure);
  }

  // One event per task/product prevents a task split across several cells from
  // inflating frequency while retaining the corrected task-line quantities.
  const events = db
    .prepare(
      `
        SELECT
          t.id AS task_id,
          t.type,
          p.id AS product_id,
          p.sku,
          p.name,
          p.brand,
          p.category,
          p.variant,
          p.unit_of_measure AS current_unit,
          COALESCE(tl.unit_of_measure, p.unit_of_measure) AS recorded_unit,
          p.description,
          p.items_per_cell,
          SUM(tl.actual_quantity) AS quantity
        FROM task_lines tl
        JOIN tasks t ON t.id = tl.task_id
        JOIN products p ON p.id = tl.product_id
        WHERE ${conditions.join(" AND ")}
        GROUP BY t.id, t.type, p.id, COALESCE(tl.unit_of_measure, p.unit_of_measure)
        ORDER BY t.id, p.id
      `,
    )
    .all(...params);

  if (events.length) {
    const productIds = Array.from(new Set(events.map((event) => Number(event.product_id))));
    const placeholders = productIds.map(() => "?").join(", ");
    const conversions = db
      .prepare(
        `
          SELECT product_id, from_unit, to_unit, factor
          FROM product_unit_conversions
          WHERE product_id IN (${placeholders})
          ORDER BY id
        `,
      )
      .all(...productIds);
    const conversionGraphs = new Map();
    for (const conversion of conversions) {
      const productId = Number(conversion.product_id);
      const graph = conversionGraphs.get(productId) || new Map();
      const from = String(conversion.from_unit).toLowerCase();
      const edges = graph.get(from) || [];
      edges.push({
        to: String(conversion.to_unit).toLowerCase(),
        factor: Number(conversion.factor),
      });
      graph.set(from, edges);
      conversionGraphs.set(productId, graph);
    }
    const findFactor = (productId, fromUnit, toUnit) => {
      const from = fromUnit.toLowerCase();
      const target = toUnit.toLowerCase();
      if (from === target) {
        return 1;
      }
      const graph = conversionGraphs.get(Number(productId));
      if (!graph) {
        return null;
      }
      const queue = [{ unit: from, factor: 1 }];
      const visited = new Set([from]);
      while (queue.length) {
        const current = queue.shift();
        for (const edge of graph.get(current.unit) || []) {
          const factor = current.factor * edge.factor;
          if (edge.to === target) {
            return factor;
          }
          if (!visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push({ unit: edge.to, factor });
          }
        }
      }
      return null;
    };
    for (const event of events) {
      const recordedUnit = String(event.recorded_unit || event.current_unit || "");
      const currentUnit = String(event.current_unit || recordedUnit);
      const factor = findFactor(event.product_id, recordedUnit, currentUnit);
      if (recordedUnit.toLowerCase() !== currentUnit.toLowerCase() && Number.isFinite(factor)) {
        event.quantity = Number(event.quantity || 0) * factor;
        event.unit_of_measure = currentUnit;
      } else {
        event.unit_of_measure = recordedUnit;
      }
    }
  }

  let customGroupValues = null;
  if (groupBy.startsWith("custom.")) {
    customGroupValues = new Map(
      db
        .prepare(
          `
            SELECT
              pav.product_id,
              COALESCE(
                pav.value_text,
                CAST(pav.value_number AS TEXT),
                pav.value_date,
                CASE pav.value_boolean WHEN 1 THEN 'Yes' WHEN 0 THEN 'No' END
              ) AS display_value
            FROM product_attribute_values pav
            JOIN product_field_definitions pfd ON pfd.id = pav.field_definition_id
            WHERE pfd.field_key = ?
          `,
        )
        .all(groupBy)
        .map((row) => [Number(row.product_id), String(row.display_value || "Not set")]),
    );
    for (const event of events) {
      event.custom_group_value = customGroupValues.get(Number(event.product_id)) || "Not set";
    }
  }

  const stockConditions = [];
  const stockParams = [];
  if (category) {
    stockConditions.push("p.category = ? COLLATE NOCASE");
    stockParams.push(category);
  }
  if (unitOfMeasure) {
    stockConditions.push("p.unit_of_measure = ? COLLATE NOCASE");
    stockParams.push(unitOfMeasure);
  }
  const productStock = db
    .prepare(
      `
        SELECT
          p.id AS product_id,
          p.sku,
          p.name,
          p.brand,
          p.category,
          p.unit_of_measure,
          COALESCE(SUM(CASE WHEN c.active = 1 THEN ib.available_quantity ELSE 0 END), 0) AS available_quantity
        FROM products p
        LEFT JOIN inventory_balances ib ON ib.product_id = p.id
        LEFT JOIN cells c ON c.id = ib.cell_id
        WHERE p.active = 1
          ${stockConditions.length ? `AND ${stockConditions.join(" AND ")}` : ""}
        GROUP BY p.id
      `,
    )
    .all(...stockParams);
  if (customGroupValues) {
    for (const product of productStock) {
      product.custom_group_value = customGroupValues.get(Number(product.product_id)) || "Not set";
    }
  }

  const rowsByKey = new Map();
  const ensureRow = (event) => {
    const key = movementGroupKey(event, groupBy);
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        ...emptyMovementRow(event, groupBy),
        picked_quantity: 0,
        pick_frequency: 0,
        put_quantity: 0,
        put_frequency: 0,
        net_outflow: 0,
        total_handled: 0,
        available_quantity: 0,
        _pickTasks: new Set(),
        _putTasks: new Set(),
        _stockProducts: new Set(),
      });
    } else {
      stabilizeMovementRowLabels(rowsByKey.get(key), event, groupBy);
    }
    return rowsByKey.get(key);
  };

  for (const event of events) {
    const row = ensureRow(event);
    const quantity = Number(event.quantity || 0);
    if (event.type === "pick") {
      row.picked_quantity += quantity;
      row._pickTasks.add(Number(event.task_id));
    } else {
      row.put_quantity += quantity;
      row._putTasks.add(Number(event.task_id));
    }
  }

  // Stock is a current snapshot, clearly separate from the period movement.
  // Only groups that moved in the period are ranked.
  for (const product of productStock) {
    const key = movementGroupKey(product, groupBy);
    const row = rowsByKey.get(key);
    if (row && !row._stockProducts.has(Number(product.product_id))) {
      row.available_quantity += Number(product.available_quantity || 0);
      row._stockProducts.add(Number(product.product_id));
    }
  }

  const workingRows = Array.from(rowsByKey.values());
  for (const row of workingRows) {
    row.pick_frequency = row._pickTasks.size;
    row.put_frequency = row._putTasks.size;
    row.net_outflow = row.picked_quantity - row.put_quantity;
    row.total_handled = row.picked_quantity + row.put_quantity;
  }
  const dimensionlessRows = aggregateMovementFrequencyRows(workingRows, groupBy);
  const allRows = workingRows.map((row) => {
    delete row._pickTasks;
    delete row._putTasks;
    delete row._stockProducts;
    return row;
  });
  attachRequestedProductFields(db, allRows, columns);
  if (dimensionlessRows !== workingRows) {
    attachRequestedProductFields(db, dimensionlessRows, columns);
  }
  const frequencyMetric = metric === "pick_frequency" || metric === "put_frequency";
  const selectedRows = frequencyMetric ? dimensionlessRows : allRows;
  const rankedRows = [...selectedRows].sort(compareMovementRows(metric));
  const unitLabels = new Map();
  for (const row of allRows) {
    const unit = String(row.unit_of_measure || "").trim();
    if (!unit) {
      continue;
    }
    const token = normalizedCompositionToken(unit);
    unitLabels.set(token, stableCompositionLabel(unitLabels.get(token), unit));
  }
  const units = Array.from(unitLabels.values()).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
  const rowsForUnit = (unit) => {
    const token = normalizedCompositionToken(unit);
    return allRows.filter(
      (row) => normalizedCompositionToken(row.unit_of_measure) === token,
    );
  };
  const rankingsByUnit = units.map((unit) => ({
    unitOfMeasure: unit,
    rows: rowsForUnit(unit)
      .sort(compareMovementRows(metric))
      .slice(0, topNValue),
  }));
  const leadersByUnit = Object.fromEntries(
    units.map((unit) => {
      const unitRows = rowsForUnit(unit);
      return [
        unit,
        {
          mostPicked: movementLeader(unitRows, "picked_quantity"),
          mostPutAway: movementLeader(unitRows, "put_quantity"),
          highestNetOutflow: movementLeader(unitRows, "net_outflow"),
        },
      ];
    }),
  );

  const totalsByUnit = Object.fromEntries(
    units.map((unit) => [
      unit,
      sumMovementRows(rowsForUnit(unit)),
    ]),
  );
  const totals = units.length <= 1
    ? sumMovementRows(allRows)
    : {
        picked_quantity: null,
        put_quantity: null,
        total_handled: null,
        net_outflow: null,
      };
  const mixedUnits = units.length > 1;

  return {
    reportKey: "product-movement-demand",
    generatedAt: new Date().toISOString(),
    range: { fromAt: options.fromAt || null, toAt: options.toAt || null },
    filters: { category, unitOfMeasure },
    metric,
    groupBy,
    topN: topNValue,
    columns,
    labels: productMovementLabels(db, groupBy),
    comparison: mixedUnits && metric !== "pick_frequency" && metric !== "put_frequency"
      ? "separate_by_unit"
      : "comparable",
    units,
    totals,
    totalsByUnit,
    leaders: {
      mostPicked: mixedUnits ? null : movementLeader(allRows, "picked_quantity"),
      mostFrequentlyPicked: movementLeader(dimensionlessRows, "pick_frequency"),
      mostPutAway: mixedUnits ? null : movementLeader(allRows, "put_quantity"),
      highestNetOutflow: mixedUnits ? null : movementLeader(allRows, "net_outflow"),
    },
    leadersByUnit,
    rows: rankedRows.slice(0, topNValue),
    rankingsByUnit,
    rankingMode:
      frequencyMetric && dimensionlessRows !== workingRows
        ? "dimensionless_across_units"
        : "by_unit",
    totalMatchingRows: selectedRows.length,
  };
}

function normalizedCompositionToken(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en");
}

function stableCompositionLabel(current, candidate) {
  const next = String(candidate ?? "").trim();
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return [current, next].sort((left, right) => {
    const insensitive = left.localeCompare(right, "en", { sensitivity: "base" });
    return insensitive || left.localeCompare(right, "en", { sensitivity: "variant" });
  })[0];
}

function stockCompositionGroupBy(db, options) {
  const groupBy = String(options.groupBy || options.group_by || "product");
  if (groupBy === "unit_of_measure") {
    throw new Error("Stock composition cannot be grouped by unit of measure.");
  }
  if (["product", "category"].includes(groupBy)) {
    return groupBy;
  }
  const customField = groupBy.startsWith("custom.")
    ? db
        .prepare(
          `
            SELECT field_key
            FROM product_field_definitions
            WHERE field_key = ? AND field_kind = 'custom' AND active = 1 AND reportable = 1
          `,
        )
        .get(groupBy)
    : null;
  if (!customField) {
    throw new Error(
      "Choose product, category, or a reportable custom field for stock composition.",
    );
  }
  return groupBy;
}

function compareStockCompositionRows(left, right) {
  const difference =
    Number(right.available_quantity || 0) - Number(left.available_quantity || 0);
  if (difference !== 0) {
    return difference;
  }
  const nameOrder = String(left.name || "").localeCompare(String(right.name || ""), "en", {
    sensitivity: "base",
  });
  if (nameOrder !== 0) {
    return nameOrder;
  }
  const skuOrder = String(left.sku || "").localeCompare(String(right.sku || ""), "en", {
    sensitivity: "base",
  });
  if (skuOrder !== 0) {
    return skuOrder;
  }
  return String(left.key || "").localeCompare(String(right.key || ""), "en", {
    sensitivity: "variant",
  });
}

function allocateSharePercentages(slices, total) {
  if (!slices.length || !(total > 0)) {
    return slices.map((slice) => ({ ...slice, percentage: 0 }));
  }

  const allocations = slices.map((slice, index) => {
    const exactTenths = (Number(slice.value || 0) / total) * 1000;
    const percentageTenths = Math.floor(exactTenths + Number.EPSILON);
    return {
      ...slice,
      _index: index,
      _remainder: exactTenths - percentageTenths,
      _percentageTenths: percentageTenths,
    };
  });
  let remainingTenths =
    1000 - allocations.reduce((sum, slice) => sum + slice._percentageTenths, 0);
  const remainderOrder = [...allocations].sort(
    (left, right) => right._remainder - left._remainder || left._index - right._index,
  );
  for (let index = 0; remainingTenths > 0 && remainderOrder.length; index += 1) {
    remainderOrder[index % remainderOrder.length]._percentageTenths += 1;
    remainingTenths -= 1;
  }
  const reverseRemainderOrder = [...remainderOrder].reverse();
  for (let index = 0; remainingTenths < 0 && reverseRemainderOrder.length; index += 1) {
    const allocation = reverseRemainderOrder[index % reverseRemainderOrder.length];
    if (allocation._percentageTenths > 0) {
      allocation._percentageTenths -= 1;
      remainingTenths += 1;
    }
  }

  return allocations
    .sort((left, right) => left._index - right._index)
    .map(({ _index, _remainder, _percentageTenths, ...slice }) => ({
      ...slice,
      percentage: _percentageTenths / 10,
    }));
}

function stockCompositionShares(unitRows, unitOfMeasure, topNValue) {
  const positiveRows = unitRows
    .filter((row) => Number(row.available_quantity || 0) > 0)
    .sort(compareStockCompositionRows);
  const namedRows = positiveRows.slice(0, topNValue);
  const omittedRows = positiveRows.slice(topNValue);
  const totalAvailable = positiveRows.reduce(
    (sum, row) => sum + Number(row.available_quantity || 0),
    0,
  );
  const slices = namedRows.map((row) => ({
    key: row.key,
    label: row.name,
    value: Number(row.available_quantity || 0),
    isOther: false,
  }));
  const otherValue = omittedRows.reduce(
    (sum, row) => sum + Number(row.available_quantity || 0),
    0,
  );
  if (otherValue > 0) {
    slices.push({
      key: `other:${normalizedCompositionToken(unitOfMeasure)}`,
      label: "Other",
      value: otherValue,
      isOther: true,
    });
  }

  return {
    unitOfMeasure,
    total: totalAvailable,
    totalAvailable,
    sourceRowCount: unitRows.length,
    omittedRowCount: omittedRows.length,
    slices: allocateSharePercentages(slices, totalAvailable),
  };
}

export function buildInventoryCompositionReport(db, options = {}) {
  const metric = String(options.metric || "available_quantity");
  if (metric !== "available_quantity") {
    throw new Error("Stock composition reports use available quantity.");
  }
  const groupBy = stockCompositionGroupBy(db, options);
  const visualization = String(options.visualization || "bar");
  if (!["bar", "donut", "table"].includes(visualization)) {
    throw new Error("Choose a supported stock composition visualization.");
  }
  const category = cleanMovementFilter(
    options.category ?? options.filters?.category,
    "Category filter",
  );
  const unitOfMeasure = cleanMovementFilter(
    options.unitOfMeasure ??
      options.unit_of_measure ??
      options.filters?.unitOfMeasure ??
      options.filters?.unit_of_measure,
    "Unit of measure filter",
  );
  const topNValue = Number(options.topN ?? options.top_n ?? 8);
  if (!Number.isInteger(topNValue) || topNValue < 1 || topNValue > 50) {
    throw new Error("Top results must be a whole number from 1 to 50.");
  }
  if (visualization === "donut" && !unitOfMeasure) {
    throw new Error("Choose a unit of measure before using a donut chart.");
  }
  if (visualization === "donut" && topNValue > 8) {
    throw new Error("Donut charts support at most 8 named slices.");
  }
  if (visualization === "donut" && groupBy === "category" && category) {
    throw new Error(
      "Remove the category filter when grouping a donut chart by category.",
    );
  }
  const columns = Array.isArray(options.columns)
    ? options.columns
    : [
        "group_label",
        "product_count",
        "available_quantity",
        "product.unit_of_measure",
      ];

  const conditions = ["p.active = 1"];
  const params = [];
  if (category) {
    conditions.push("p.category = ? COLLATE NOCASE");
    params.push(category);
  }
  if (unitOfMeasure) {
    conditions.push("p.unit_of_measure = ? COLLATE NOCASE");
    params.push(unitOfMeasure);
  }
  const products = db
    .prepare(
      `
        SELECT
          p.id AS product_id,
          p.sku,
          p.name,
          p.brand,
          p.category,
          p.variant,
          p.unit_of_measure,
          p.description,
          p.items_per_cell,
          COALESCE(
            SUM(CASE WHEN c.active = 1 THEN ib.available_quantity ELSE 0 END),
            0
          ) AS available_quantity
        FROM products p
        LEFT JOIN inventory_balances ib ON ib.product_id = p.id
        LEFT JOIN cells c ON c.id = ib.cell_id
        WHERE ${conditions.join(" AND ")}
        GROUP BY p.id
        ORDER BY p.id
      `,
    )
    .all(...params);

  let customValues = null;
  if (groupBy.startsWith("custom.")) {
    customValues = new Map(
      db
        .prepare(
          `
            SELECT
              pav.product_id,
              COALESCE(
                pav.value_text,
                CAST(pav.value_number AS TEXT),
                pav.value_date,
                CASE pav.value_boolean WHEN 1 THEN 'Yes' WHEN 0 THEN 'No' END
              ) AS display_value
            FROM product_attribute_values pav
            JOIN product_field_definitions pfd ON pfd.id = pav.field_definition_id
            WHERE pfd.field_key = ?
          `,
        )
        .all(groupBy)
        .map((row) => [Number(row.product_id), String(row.display_value || "Not set")]),
    );
  }

  const rowsByKey = new Map();
  for (const product of products) {
    const unitDisplay = String(product.unit_of_measure || "Recorded unit").trim();
    const unitToken = normalizedCompositionToken(unitDisplay);
    let dimensionToken;
    let dimensionDisplay;
    let key;
    if (groupBy === "category") {
      const hasCategory = String(product.category || "").trim().length > 0;
      dimensionDisplay = hasCategory ? String(product.category).trim() : "Uncategorized";
      dimensionToken = hasCategory
        ? `value:${normalizedCompositionToken(dimensionDisplay)}`
        : "missing-category";
      key = `category:${dimensionToken}\u0000unit:${unitToken}`;
    } else if (groupBy.startsWith("custom.")) {
      const configuredValue = customValues.get(Number(product.product_id));
      const hasValue = String(configuredValue || "").trim().length > 0;
      dimensionDisplay = hasValue ? String(configuredValue).trim() : "Not set";
      dimensionToken = hasValue
        ? `value:${normalizedCompositionToken(dimensionDisplay)}`
        : "missing-value";
      key = `${groupBy}:${dimensionToken}\u0000unit:${unitToken}`;
    } else {
      dimensionDisplay = product.name;
      dimensionToken = String(product.product_id);
      key = `product:${dimensionToken}\u0000unit:${unitToken}`;
    }

    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        key,
        product_id: groupBy === "product" ? Number(product.product_id) : null,
        sku: groupBy === "product" ? product.sku : null,
        name: dimensionDisplay,
        brand: groupBy === "product" ? product.brand : null,
        category:
          groupBy === "category"
            ? dimensionDisplay
            : groupBy === "product"
              ? product.category
              : null,
        variant: groupBy === "product" ? product.variant : null,
        unit_of_measure: unitDisplay,
        description: groupBy === "product" ? product.description : null,
        items_per_cell: groupBy === "product" ? product.items_per_cell : null,
        available_quantity: 0,
        product_count: 0,
        _productIds: new Set(),
      };
      if (groupBy.startsWith("custom.")) {
        row.custom_field_key = groupBy;
        row.custom_field_value = dimensionDisplay;
      }
      rowsByKey.set(key, row);
    } else {
      row.name = stableCompositionLabel(row.name, dimensionDisplay);
      row.unit_of_measure = stableCompositionLabel(row.unit_of_measure, unitDisplay);
      if (groupBy === "category") {
        row.category = row.name;
      }
      if (groupBy.startsWith("custom.")) {
        row.custom_field_value = row.name;
      }
    }
    row.available_quantity += Number(product.available_quantity || 0);
    row._productIds.add(Number(product.product_id));
  }

  const allRows = Array.from(rowsByKey.values())
    .map((row) => {
      row.product_count = row._productIds.size;
      delete row._productIds;
      return row;
    })
    .filter((row) => Number(row.available_quantity || 0) > 0);
  attachRequestedProductFields(db, allRows, columns);
  const rankedRows = [...allRows].sort(compareStockCompositionRows);
  const unitLabels = new Map();
  for (const row of allRows) {
    const token = normalizedCompositionToken(row.unit_of_measure);
    unitLabels.set(
      token,
      stableCompositionLabel(unitLabels.get(token), row.unit_of_measure),
    );
  }
  const units = Array.from(unitLabels.values()).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
  const rowsForUnit = (unit) => {
    const token = normalizedCompositionToken(unit);
    return allRows.filter(
      (row) => normalizedCompositionToken(row.unit_of_measure) === token,
    );
  };
  const rankingsByUnit = units.map((unit) => ({
    unitOfMeasure: unit,
    rows: rowsForUnit(unit).sort(compareStockCompositionRows).slice(0, topNValue),
  }));
  const totalsByUnit = Object.fromEntries(
    units.map((unit) => [
      unit,
      rowsForUnit(unit).reduce(
        (sum, row) => sum + Number(row.available_quantity || 0),
        0,
      ),
    ]),
  );
  const sharesByUnit = units.map((unit) =>
    stockCompositionShares(rowsForUnit(unit), unit, topNValue),
  );

  return {
    reportKey: "inventory-stock-composition",
    generatedAt: new Date().toISOString(),
    filters: { category, unitOfMeasure },
    metric,
    groupBy,
    visualization,
    topN: topNValue,
    columns,
    labels: productMovementLabels(db, groupBy),
    comparison: units.length > 1 ? "separate_by_unit" : "comparable",
    units,
    totalsByUnit,
    rows: rankedRows.slice(0, topNValue),
    rankingsByUnit,
    sharesByUnit,
    totalMatchingRows: allRows.length,
  };
}

const MOVEMENT_TREND_METRICS = new Set([
  "picked_quantity",
  "put_quantity",
  "total_handled",
  "net_change",
]);
const MOVEMENT_TREND_GRAINS = new Set(["day", "week", "month"]);
const EXCEPTION_REPORT_METRICS = new Set([
  "exception_quantity",
  "exception_count",
  "affected_tasks",
]);
const EXCEPTION_REPORT_GROUPS = new Set([
  "product",
  "category",
  "unit_of_measure",
  "cell",
  "task_type",
]);

function reportTopN(options, fallback = 10) {
  const value = Number(options.topN ?? options.top_n ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("Top results must be a whole number from 1 to 50.");
  }
  return value;
}

function reportVisualization(options) {
  const visualization = String(options.visualization || "bar");
  if (!new Set(["bar", "table"]).has(visualization)) {
    throw new Error("Choose a supported report visualization.");
  }
  return visualization;
}

function reportFilters(options) {
  return {
    category: cleanMovementFilter(
      options.category ?? options.filters?.category,
      "Category filter",
    ),
    unitOfMeasure: cleanMovementFilter(
      options.unitOfMeasure ??
        options.unit_of_measure ??
        options.filters?.unitOfMeasure ??
        options.filters?.unit_of_measure,
      "Unit of measure filter",
    ),
  };
}

function reportRangeConditions(options, columnName = "t.completed_at") {
  const conditions = [];
  const params = [];
  if (options.fromAt) {
    conditions.push(`${columnName} >= ?`);
    params.push(options.fromAt);
  }
  if (options.toAt) {
    conditions.push(`${columnName} <= ?`);
    params.push(options.toAt);
  }
  return { conditions, params };
}

function normalizeHistoricalReportUnits(db, sourceEvents, quantityFields) {
  const events = sourceEvents.map((event) => ({ ...event }));
  const productIds = Array.from(
    new Set(events.map((event) => Number(event.product_id)).filter(Number.isInteger)),
  );
  if (!productIds.length) {
    return events;
  }

  const placeholders = productIds.map(() => "?").join(", ");
  const conversions = db
    .prepare(
      `
        SELECT product_id, from_unit, to_unit, factor
        FROM product_unit_conversions
        WHERE product_id IN (${placeholders})
        ORDER BY id
      `,
    )
    .all(...productIds);
  const graphs = new Map();
  for (const conversion of conversions) {
    const productId = Number(conversion.product_id);
    const graph = graphs.get(productId) || new Map();
    const from = String(conversion.from_unit || "").toLocaleLowerCase("en");
    const edges = graph.get(from) || [];
    edges.push({
      to: String(conversion.to_unit || "").toLocaleLowerCase("en"),
      factor: Number(conversion.factor),
    });
    graph.set(from, edges);
    graphs.set(productId, graph);
  }

  const conversionFactor = (productId, fromUnit, toUnit) => {
    const from = String(fromUnit || "").toLocaleLowerCase("en");
    const target = String(toUnit || "").toLocaleLowerCase("en");
    if (from === target) {
      return 1;
    }
    const graph = graphs.get(Number(productId));
    if (!graph) {
      return null;
    }
    const queue = [{ unit: from, factor: 1 }];
    const visited = new Set([from]);
    while (queue.length) {
      const current = queue.shift();
      for (const edge of graph.get(current.unit) || []) {
        const factor = current.factor * edge.factor;
        if (edge.to === target) {
          return factor;
        }
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push({ unit: edge.to, factor });
        }
      }
    }
    return null;
  };

  for (const event of events) {
    const recordedUnit = String(event.recorded_unit || event.current_unit || "Recorded unit");
    const currentUnit = String(event.current_unit || recordedUnit);
    const factor = conversionFactor(event.product_id, recordedUnit, currentUnit);
    if (
      recordedUnit.toLocaleLowerCase("en") !== currentUnit.toLocaleLowerCase("en") &&
      Number.isFinite(factor)
    ) {
      for (const field of quantityFields) {
        event[field] = Number(event[field] || 0) * factor;
      }
      event.unit_of_measure = currentUnit;
    } else {
      event.unit_of_measure = recordedUnit;
    }
  }
  return events;
}

export function buildMovementOverTimeReport(db, options = {}) {
  const metric = String(options.metric || "picked_quantity");
  if (!MOVEMENT_TREND_METRICS.has(metric)) {
    throw new Error("Choose a supported movement trend measure.");
  }
  const groupBy = String(
    options.groupBy ||
      options.group_by ||
      options.grain ||
      options.timeGrain ||
      options.time_grain ||
      "day",
  );
  if (!MOVEMENT_TREND_GRAINS.has(groupBy)) {
    throw new Error("Choose day, week, or month for movement over time.");
  }
  const topN = reportTopN(options);
  const visualization = reportVisualization(options);
  const filters = reportFilters(options);
  const { conditions: rangeConditions, params } = reportRangeConditions(options);
  const conditions = [
    "t.status = 'completed'",
    "t.type IN ('pick', 'put')",
    "t.completed_at IS NOT NULL",
    ...rangeConditions,
  ];
  if (filters.category) {
    conditions.push("p.category = ? COLLATE NOCASE");
    params.push(filters.category);
  }
  if (filters.unitOfMeasure) {
    conditions.push("p.unit_of_measure = ? COLLATE NOCASE");
    params.push(filters.unitOfMeasure);
  }
  const periodExpression = {
    day: "date(t.completed_at)",
    week: "date(t.completed_at, '-' || ((CAST(strftime('%w', t.completed_at) AS INTEGER) + 6) % 7) || ' days')",
    month: "date(t.completed_at, 'start of month')",
  }[groupBy];
  const sourceRows = db
    .prepare(
      `
        SELECT
          ${periodExpression} AS period,
          p.id AS product_id,
          p.unit_of_measure AS current_unit,
          COALESCE(tl.unit_of_measure, p.unit_of_measure) AS recorded_unit,
          SUM(CASE WHEN t.type = 'pick' THEN tl.actual_quantity ELSE 0 END) AS picked_quantity,
          SUM(CASE WHEN t.type = 'put' THEN tl.actual_quantity ELSE 0 END) AS put_quantity,
          SUM(tl.actual_quantity) AS total_handled,
          SUM(CASE
            WHEN t.type = 'put' THEN tl.actual_quantity
            WHEN t.type = 'pick' THEN -tl.actual_quantity
            ELSE 0
          END) AS net_change
        FROM task_lines tl
        JOIN tasks t ON t.id = tl.task_id
        JOIN products p ON p.id = tl.product_id
        WHERE ${conditions.join(" AND ")}
        GROUP BY
          ${periodExpression},
          p.id,
          p.unit_of_measure,
          COALESCE(tl.unit_of_measure, p.unit_of_measure)
        ORDER BY period ASC, p.id
      `,
    )
    .all(...params)
    .map((row) => ({
      period: String(row.period),
      product_id: Number(row.product_id),
      current_unit: String(row.current_unit || "Recorded unit"),
      recorded_unit: String(row.recorded_unit || row.current_unit || "Recorded unit"),
      picked_quantity: Number(row.picked_quantity || 0),
      put_quantity: Number(row.put_quantity || 0),
      total_handled: Number(row.total_handled || 0),
      net_change: Number(row.net_change || 0),
    }));
  const normalizedRows = normalizeHistoricalReportUnits(db, sourceRows, [
    "picked_quantity",
    "put_quantity",
    "total_handled",
    "net_change",
  ]);
  const rowsByPeriodAndUnit = new Map();
  for (const row of normalizedRows) {
    const unit = String(row.unit_of_measure || "Recorded unit");
    const key = `${row.period}\u0000${normalizedCompositionToken(unit)}`;
    const current = rowsByPeriodAndUnit.get(key) || {
      key,
      name: String(row.period),
      period: String(row.period),
      unit_of_measure: unit,
      picked_quantity: 0,
      put_quantity: 0,
      total_handled: 0,
      net_change: 0,
    };
    current.unit_of_measure = stableCompositionLabel(current.unit_of_measure, unit);
    current.picked_quantity += Number(row.picked_quantity || 0);
    current.put_quantity += Number(row.put_quantity || 0);
    current.total_handled += Number(row.total_handled || 0);
    current.net_change += Number(row.net_change || 0);
    rowsByPeriodAndUnit.set(key, current);
  }
  const rows = Array.from(rowsByPeriodAndUnit.values()).sort(
    (left, right) =>
      String(left.period).localeCompare(String(right.period)) ||
      left.unit_of_measure.localeCompare(right.unit_of_measure, "en", { sensitivity: "base" }),
  );
  const units = Array.from(new Set(rows.map((row) => row.unit_of_measure))).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
  const seriesByUnit = units.map((unit) => ({
    unitOfMeasure: unit,
    rows: rows.filter((row) => row.unit_of_measure === unit).slice(-topN),
  }));
  const visibleRows = seriesByUnit.flatMap((series) => series.rows);
  const totalForRows = (source) =>
    source.reduce(
      (totals, row) => ({
        picked_quantity: totals.picked_quantity + row.picked_quantity,
        put_quantity: totals.put_quantity + row.put_quantity,
        total_handled: totals.total_handled + row.total_handled,
        net_change: totals.net_change + row.net_change,
      }),
      { picked_quantity: 0, put_quantity: 0, total_handled: 0, net_change: 0 },
    );
  const totalsByUnit = Object.fromEntries(
    seriesByUnit.map((series) => [series.unitOfMeasure, totalForRows(series.rows)]),
  );
  const columns = Array.isArray(options.columns)
    ? options.columns
    : ["period", "product.unit_of_measure", metric];
  return {
    reportKey: "movement-over-time",
    generatedAt: new Date().toISOString(),
    range: { fromAt: options.fromAt || null, toAt: options.toAt || null },
    filters,
    metric,
    groupBy,
    visualization,
    topN,
    columns,
    timezone: "UTC",
    comparison: units.length > 1 ? "separate_by_unit" : "comparable",
    units,
    totals: units.length === 1 ? totalsByUnit[units[0]] : null,
    totalsByUnit,
    rows: visibleRows,
    seriesByUnit,
    rankingsByUnit: seriesByUnit,
    totalMatchingRows: rows.length,
    totalPeriods: new Set(rows.map((row) => row.period)).size,
  };
}

function exceptionGrouping(event, groupBy) {
  const unit = String(event.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
  const category = String(event.category || "Uncategorized").trim() || "Uncategorized";
  const cell = String(event.logical_code || "Unknown cell").trim() || "Unknown cell";
  const taskType = String(event.task_type || "task").trim().toLowerCase() || "task";
  return {
    product: {
      token: `product:${event.product_id}`,
      label: String(event.product_name || event.sku || "Unnamed product"),
    },
    category: {
      token: `category:${normalizedCompositionToken(category)}`,
      label: category,
    },
    unit_of_measure: {
      token: `unit:${normalizedCompositionToken(unit)}`,
      label: unit,
    },
    cell: {
      token: `cell:${normalizedCompositionToken(cell)}`,
      label: cell,
    },
    task_type: {
      token: `task:${taskType}`,
      label: taskType.toUpperCase(),
    },
  }[groupBy];
}

function compareExceptionRows(metric) {
  return (left, right) => {
    const difference = Number(right[metric] || 0) - Number(left[metric] || 0);
    if (difference !== 0) {
      return difference;
    }
    return String(left.name || "").localeCompare(String(right.name || ""), "en", {
      sensitivity: "base",
    });
  };
}

function aggregateDimensionlessExceptionRows(rows) {
  const aggregates = new Map();
  for (const source of rows) {
    let row = aggregates.get(source.group_token);
    if (!row) {
      row = {
        ...source,
        key: source.group_token,
        unit_of_measure: null,
        exception_quantity: 0,
        exception_count: 0,
        affected_tasks: 0,
        _taskIds: new Set(),
        _units: new Map(),
      };
      aggregates.set(source.group_token, row);
    } else {
      row.name = stableCompositionLabel(row.name, source.name);
      row.group_label = row.name;
      if (row.category && source.category) {
        row.category = stableCompositionLabel(row.category, source.category);
      }
    }

    const unit = String(source.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
    const unitToken = normalizedCompositionToken(unit);
    row._units.set(unitToken, stableCompositionLabel(row._units.get(unitToken), unit));
    row.exception_quantity += Number(source.exception_quantity || 0);
    row.exception_count += Number(source.exception_count || 0);
    for (const taskId of source._taskIds || []) {
      row._taskIds.add(taskId);
    }
  }

  return Array.from(aggregates.values()).map((row) => {
    const units = Array.from(row._units.values()).sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" }),
    );
    row.affected_tasks = row._taskIds.size;
    row.units = units;
    row.quantity_comparison = units.length > 1 ? "separate_by_unit" : "comparable";
    row.unit_of_measure = units.length === 1 ? units[0] : null;
    if (units.length > 1) {
      row.exception_quantity = null;
    }
    delete row._taskIds;
    delete row._units;
    return row;
  });
}

export function buildExceptionsReport(db, options = {}) {
  const metric = String(options.metric || "exception_quantity");
  if (!EXCEPTION_REPORT_METRICS.has(metric)) {
    throw new Error("Choose a supported exception measure.");
  }
  const groupBy = String(options.groupBy || options.group_by || "product");
  if (!EXCEPTION_REPORT_GROUPS.has(groupBy)) {
    throw new Error("Choose a supported exception grouping.");
  }
  const topN = reportTopN(options);
  const visualization = reportVisualization(options);
  const filters = reportFilters(options);
  const { conditions: rangeConditions, params } = reportRangeConditions(options);
  const conditions = [
    "t.status = 'completed'",
    "t.type IN ('pick', 'put')",
    "t.completed_at IS NOT NULL",
    "tl.exception_quantity > 0",
    ...rangeConditions,
  ];
  if (filters.category) {
    conditions.push("p.category = ? COLLATE NOCASE");
    params.push(filters.category);
  }
  if (filters.unitOfMeasure) {
    conditions.push("p.unit_of_measure = ? COLLATE NOCASE");
    params.push(filters.unitOfMeasure);
  }
  const sourceEvents = db
    .prepare(
      `
        SELECT
          t.id AS task_id,
          t.type AS task_type,
          p.id AS product_id,
          p.sku,
          p.name AS product_name,
          p.category,
          c.logical_code,
          p.unit_of_measure AS current_unit,
          COALESCE(tl.unit_of_measure, p.unit_of_measure) AS recorded_unit,
          tl.exception_quantity
        FROM task_lines tl
        JOIN tasks t ON t.id = tl.task_id
        JOIN products p ON p.id = tl.product_id
        JOIN cells c ON c.id = tl.cell_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY t.completed_at DESC, t.id DESC, tl.id
      `,
    )
    .all(...params);
  const events = normalizeHistoricalReportUnits(db, sourceEvents, ["exception_quantity"]);
  const groups = new Map();
  for (const event of events) {
    const unit = String(event.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
    const grouping = exceptionGrouping(event, groupBy);
    const key = `${grouping.token}\u0000unit:${normalizedCompositionToken(unit)}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        key,
        group_token: grouping.token,
        name: String(grouping.label || "Not set"),
        group_label: String(grouping.label || "Not set"),
        unit_of_measure: unit,
        product_id: groupBy === "product" ? Number(event.product_id) : null,
        sku: groupBy === "product" ? String(event.sku || "") : "",
        category: groupBy === "category" ? String(grouping.label) : String(event.category || ""),
        logical_code: groupBy === "cell" ? String(event.logical_code || "") : "",
        task_type: groupBy === "task_type" ? String(event.task_type || "") : "",
        exception_quantity: 0,
        exception_count: 0,
        _taskIds: new Set(),
      };
      groups.set(key, row);
    } else {
      row.name = stableCompositionLabel(row.name, grouping.label);
      row.group_label = row.name;
      row.unit_of_measure = stableCompositionLabel(row.unit_of_measure, unit);
      if (groupBy === "category") {
        row.category = row.name;
      }
    }
    row.exception_quantity += Number(event.exception_quantity || 0);
    row.exception_count += 1;
    row._taskIds.add(Number(event.task_id));
  }
  const workingRows = Array.from(groups.values());
  const dimensionlessRows = aggregateDimensionlessExceptionRows(workingRows);
  const rows = workingRows.map((row) => {
    row.affected_tasks = row._taskIds.size;
    delete row._taskIds;
    return row;
  });
  const unitLabels = new Map();
  for (const row of rows) {
    const unit = String(row.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
    const token = normalizedCompositionToken(unit);
    unitLabels.set(token, stableCompositionLabel(unitLabels.get(token), unit));
  }
  const units = Array.from(unitLabels.values()).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
  const dimensionlessMetric = metric === "exception_count" || metric === "affected_tasks";
  const selectedRows = dimensionlessMetric ? dimensionlessRows : rows;
  const rankingsByUnit = dimensionlessMetric
    ? selectedRows.length
      ? [
        {
          unitOfMeasure: units.length === 1 ? units[0] : null,
          rows: [...selectedRows].sort(compareExceptionRows(metric)).slice(0, topN),
        },
      ]
      : []
    : units.map((unit) => ({
        unitOfMeasure: unit,
        rows: rows
          .filter(
            (row) =>
              normalizedCompositionToken(row.unit_of_measure) ===
              normalizedCompositionToken(unit),
          )
          .sort(compareExceptionRows(metric))
          .slice(0, topN),
      }));
  const totalsByUnit = Object.fromEntries(
    units.map((unit) => {
      const unitEvents = events.filter(
        (event) =>
          normalizedCompositionToken(event.unit_of_measure || "Recorded unit") ===
          normalizedCompositionToken(unit),
      );
      return [
        unit,
        {
          exception_quantity: unitEvents.reduce(
            (sum, event) => sum + Number(event.exception_quantity || 0),
            0,
          ),
          exception_count: unitEvents.length,
          affected_tasks: new Set(unitEvents.map((event) => Number(event.task_id))).size,
        },
      ];
    }),
  );
  const aggregateTotals = {
    exception_quantity:
      units.length <= 1
        ? events.reduce((sum, event) => sum + Number(event.exception_quantity || 0), 0)
        : null,
    exception_count: events.length,
    affected_tasks: new Set(events.map((event) => Number(event.task_id))).size,
  };
  const columns = Array.isArray(options.columns)
    ? options.columns
    : ["group_label", "product.unit_of_measure", "exception_count", "exception_quantity"];
  return {
    reportKey: "task-exceptions",
    generatedAt: new Date().toISOString(),
    range: { fromAt: options.fromAt || null, toAt: options.toAt || null },
    filters,
    metric,
    groupBy,
    visualization,
    topN,
    columns,
    comparison:
      dimensionlessMetric || units.length <= 1 ? "comparable" : "separate_by_unit",
    units,
    totals: dimensionlessMetric
      ? aggregateTotals
      : units.length === 1
        ? totalsByUnit[units[0]]
        : null,
    totalsByUnit,
    rows: rankingsByUnit.flatMap((group) => group.rows),
    rankingsByUnit,
    rankingMode: dimensionlessMetric ? "dimensionless_across_units" : "by_unit",
    totalMatchingRows: events.length,
    labels: productMovementLabels(db, groupBy),
  };
}

/**
 * Products whose current active-location stock is empty or no greater than one
 * normal location batch. This is deliberately a simple operational rule, not
 * a demand forecast: the product model does not currently store reorder
 * points, supplier lead times, or safety-stock targets.
 */
export function buildReplenishmentWatchReport(db) {
  const rows = db
    .prepare(
      `
        WITH current_stock AS (
          SELECT
            p.id AS product_id,
            p.sku,
            p.name,
            p.brand,
            p.category,
            p.variant,
            p.unit_of_measure,
            p.items_per_cell,
            COALESCE(
              SUM(CASE WHEN c.active = 1 THEN ib.available_quantity ELSE 0 END),
              0
            ) AS available_quantity,
            COUNT(DISTINCT CASE
              WHEN c.active = 1 AND ib.available_quantity > 0 THEN c.id
              ELSE NULL
            END) AS occupied_locations
          FROM products p
          LEFT JOIN inventory_balances ib ON ib.product_id = p.id
          LEFT JOIN cells c ON c.id = ib.cell_id
          WHERE p.active = 1
          GROUP BY p.id
        )
        SELECT *
        FROM current_stock
        WHERE available_quantity <= items_per_cell
        ORDER BY
          CASE WHEN available_quantity <= 0 THEN 0 ELSE 1 END,
          CASE
            WHEN items_per_cell > 0 THEN available_quantity / items_per_cell
            ELSE NULL
          END,
          name COLLATE NOCASE,
          product_id
      `,
    )
    .all()
    .map((row) => {
      const availableQuantity = Number(row.available_quantity || 0);
      const itemsPerCell = Number(row.items_per_cell || 0);
      return {
        product_id: Number(row.product_id),
        sku: String(row.sku || ""),
        name: String(row.name || "Unnamed product"),
        brand: String(row.brand || ""),
        category: row.category ? String(row.category) : null,
        variant: row.variant ? String(row.variant) : null,
        unit_of_measure: String(row.unit_of_measure || "Recorded unit"),
        available_quantity: availableQuantity,
        items_per_cell: itemsPerCell,
        occupied_locations: Number(row.occupied_locations || 0),
        batch_ratio: itemsPerCell > 0 ? availableQuantity / itemsPerCell : null,
        status: availableQuantity <= 0 ? "out_of_stock" : "one_batch_or_less",
      };
    });

  const statusCounts = rows.reduce(
    (counts, row) => {
      if (row.status === "out_of_stock") {
        counts.out_of_stock += 1;
      } else {
        counts.one_batch_or_less += 1;
      }
      counts.total += 1;
      return counts;
    },
    { out_of_stock: 0, one_batch_or_less: 0, total: 0 },
  );
  const unitLabels = new Map();
  for (const row of rows) {
    const token = normalizedCompositionToken(row.unit_of_measure);
    unitLabels.set(
      token,
      stableCompositionLabel(unitLabels.get(token), row.unit_of_measure),
    );
  }

  return {
    reportKey: "replenishment-watch",
    generatedAt: new Date().toISOString(),
    range: { fromAt: null, toAt: null },
    rule: "one_location_batch_or_less",
    comparison: "dimensionless_status_counts",
    statusCounts,
    units: Array.from(unitLabels.values()).sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" }),
    ),
    rows,
    totalMatchingRows: rows.length,
  };
}

/**
 * Current stock that had no successful pick in the requested period. A put is
 * intentionally not treated as usage, and a completed zero-quantity pick does
 * not hide a product from this report.
 */
export function buildSlowMovingStockReport(db, options = {}) {
  const fromAt = options.fromAt || null;
  const toAt = options.toAt || null;
  const historyConditions = [];
  const historyParams = [];
  if (toAt) {
    historyConditions.push("completed_at <= ?");
    historyParams.push(toAt);
  }
  const rangeConditions = [];
  const rangeParams = [];
  if (fromAt) {
    rangeConditions.push("completed_at >= ?");
    rangeParams.push(fromAt);
  }
  if (toAt) {
    rangeConditions.push("completed_at <= ?");
    rangeParams.push(toAt);
  }
  const historyPredicate = historyConditions.length
    ? historyConditions.join(" AND ")
    : "1 = 1";
  const rangePredicate = rangeConditions.length
    ? rangeConditions.join(" AND ")
    : "1 = 1";

  const rows = db
    .prepare(
      `
        WITH current_stock AS (
          SELECT
            p.id AS product_id,
            p.sku,
            p.name,
            p.brand,
            p.category,
            p.variant,
            p.unit_of_measure,
            COALESCE(
              SUM(CASE WHEN c.active = 1 THEN ib.available_quantity ELSE 0 END),
              0
            ) AS available_quantity,
            COUNT(DISTINCT CASE
              WHEN c.active = 1 AND ib.available_quantity > 0 THEN c.id
              ELSE NULL
            END) AS occupied_locations
          FROM products p
          LEFT JOIN inventory_balances ib ON ib.product_id = p.id
          LEFT JOIN cells c ON c.id = ib.cell_id
          WHERE p.active = 1
          GROUP BY p.id
        ),
        positive_picks AS (
          SELECT
            tl.product_id,
            t.completed_at
          FROM task_lines tl
          JOIN tasks t ON t.id = tl.task_id
          WHERE t.status = 'completed'
            AND t.type = 'pick'
            AND t.completed_at IS NOT NULL
            AND tl.actual_quantity > 0
        ),
        pick_history AS (
          SELECT
            product_id,
            MAX(CASE WHEN ${historyPredicate} THEN completed_at END) AS last_picked_at,
            MAX(CASE WHEN ${rangePredicate} THEN completed_at END) AS last_picked_in_range
          FROM positive_picks
          GROUP BY product_id
        )
        SELECT
          stock.*,
          history.last_picked_at
        FROM current_stock stock
        LEFT JOIN pick_history history ON history.product_id = stock.product_id
        WHERE stock.available_quantity > 0
          AND history.last_picked_in_range IS NULL
        ORDER BY
          CASE WHEN history.last_picked_at IS NULL THEN 0 ELSE 1 END,
          history.last_picked_at,
          stock.name COLLATE NOCASE,
          stock.product_id
      `,
    )
    .all(...historyParams, ...rangeParams)
    .map((row) => ({
      product_id: Number(row.product_id),
      sku: String(row.sku || ""),
      name: String(row.name || "Unnamed product"),
      brand: String(row.brand || ""),
      category: row.category ? String(row.category) : null,
      variant: row.variant ? String(row.variant) : null,
      unit_of_measure: String(row.unit_of_measure || "Recorded unit"),
      available_quantity: Number(row.available_quantity || 0),
      occupied_locations: Number(row.occupied_locations || 0),
      last_picked_at: row.last_picked_at ? String(row.last_picked_at) : null,
    }));
  const neverPickedCount = rows.filter((row) => !row.last_picked_at).length;

  return {
    reportKey: "slow-moving-stock",
    generatedAt: new Date().toISOString(),
    range: { fromAt, toAt },
    comparison: "idle_time_only",
    rows,
    neverPickedCount,
    previouslyPickedCount: rows.length - neverPickedCount,
    totalMatchingRows: rows.length,
  };
}

/**
 * Throughput is based on completed tasks, never task-line or transaction-row
 * counts. That keeps multi-line and mixed-unit work comparable without adding
 * unrelated product quantities together.
 */
export function buildTeamThroughputReport(db, options = {}) {
  const { conditions: rangeConditions, params } = reportRangeConditions(options);
  const rowsWithDurations = db
    .prepare(
      `
        WITH completed_tasks AS (
          SELECT
            t.id AS task_id,
            t.created_by AS user_id,
            t.type,
            COALESCE(
              MAX(CASE WHEN tl.exception_quantity > 0 THEN 1 ELSE 0 END),
              0
            ) AS has_exception,
            MAX(
              0,
              (julianday(t.completed_at) - julianday(t.started_at)) * 24 * 60
            ) AS duration_minutes
          FROM tasks t
          LEFT JOIN task_lines tl ON tl.task_id = t.id
          WHERE t.status = 'completed'
            AND t.type IN ('pick', 'put')
            AND t.completed_at IS NOT NULL
            ${rangeConditions.length ? `AND ${rangeConditions.join(" AND ")}` : ""}
          GROUP BY t.id, t.created_by, t.type, t.started_at, t.completed_at
        )
        SELECT
          u.id AS user_id,
          u.name,
          u.username,
          COUNT(*) AS completed_tasks,
          SUM(CASE WHEN completed.type = 'pick' THEN 1 ELSE 0 END) AS completed_pick_tasks,
          SUM(CASE WHEN completed.type = 'put' THEN 1 ELSE 0 END) AS completed_put_tasks,
          SUM(completed.has_exception) AS exception_tasks,
          SUM(CASE WHEN completed.has_exception = 0 THEN 1 ELSE 0 END) AS exception_free_tasks,
          ROUND(
            100.0 * SUM(CASE WHEN completed.has_exception = 0 THEN 1 ELSE 0 END) /
              COUNT(*),
            1
          ) AS exception_free_percent,
          ROUND(AVG(completed.duration_minutes), 1) AS average_completion_minutes,
          SUM(completed.duration_minutes) AS total_duration_minutes
        FROM completed_tasks completed
        JOIN users u ON u.id = completed.user_id
        GROUP BY u.id
        ORDER BY completed_tasks DESC, u.username COLLATE NOCASE, u.id
      `,
    )
    .all(...params);

  const totals = {
    completed_tasks: 0,
    completed_pick_tasks: 0,
    completed_put_tasks: 0,
    exception_tasks: 0,
    exception_free_tasks: 0,
    exception_free_percent: null,
    average_completion_minutes: null,
  };
  let totalDurationMinutes = 0;
  const rows = rowsWithDurations.map((row) => {
    const completedTasks = Number(row.completed_tasks || 0);
    totals.completed_tasks += completedTasks;
    totals.completed_pick_tasks += Number(row.completed_pick_tasks || 0);
    totals.completed_put_tasks += Number(row.completed_put_tasks || 0);
    totals.exception_tasks += Number(row.exception_tasks || 0);
    totals.exception_free_tasks += Number(row.exception_free_tasks || 0);
    totalDurationMinutes += Number(row.total_duration_minutes || 0);
    return {
      user_id: Number(row.user_id),
      name: String(row.name || row.username || "Unknown user"),
      username: String(row.username || ""),
      completed_tasks: completedTasks,
      completed_pick_tasks: Number(row.completed_pick_tasks || 0),
      completed_put_tasks: Number(row.completed_put_tasks || 0),
      exception_tasks: Number(row.exception_tasks || 0),
      exception_free_tasks: Number(row.exception_free_tasks || 0),
      exception_free_percent: Number(row.exception_free_percent || 0),
      average_completion_minutes: Number(row.average_completion_minutes || 0),
    };
  });
  if (totals.completed_tasks > 0) {
    totals.exception_free_percent = Number(
      ((totals.exception_free_tasks / totals.completed_tasks) * 100).toFixed(1),
    );
    totals.average_completion_minutes = Number(
      (totalDurationMinutes / totals.completed_tasks).toFixed(1),
    );
  }

  return {
    reportKey: "team-throughput",
    generatedAt: new Date().toISOString(),
    range: { fromAt: options.fromAt || null, toAt: options.toAt || null },
    comparison: "task_counts",
    rows,
    totals,
    totalMatchingRows: totals.completed_tasks,
  };
}

export function buildReports(db, { fromAt, toAt }) {
  const transactionRange = rangeClause("tr.created_at", fromAt, toAt);
  const taskRange = rangeClause("t.completed_at", fromAt, toAt);
  const taskActivityRange = andRangeClause("t.started_at", fromAt, toAt);
  const userTransactionRange = andRangeClause("tr.created_at", fromAt, toAt);
  const recentTaskRange = rangeClause("COALESCE(t.completed_at, t.started_at)", fromAt, toAt);

  const stockSnapshot = db
    .prepare(
      `
        SELECT
          p.sku,
          p.name,
          p.brand,
          p.unit_of_measure,
          COALESCE(SUM(CASE WHEN c.active = 1 THEN b.available_quantity ELSE 0 END), 0) AS available
        FROM products p
        LEFT JOIN inventory_balances b ON b.product_id = p.id
        LEFT JOIN cells c ON c.id = b.cell_id
        WHERE p.active = 1
        GROUP BY p.id
        ORDER BY p.name
      `,
    )
    .all();

  const movementSummarySource = db
    .prepare(
      `
        SELECT
          date(t.completed_at) AS movement_date,
          p.id AS product_id,
          p.unit_of_measure AS current_unit,
          COALESCE(tl.unit_of_measure, p.unit_of_measure) AS recorded_unit,
          SUM(CASE WHEN t.type = 'pick' THEN tl.actual_quantity ELSE 0 END) AS picked,
          SUM(CASE WHEN t.type = 'put' THEN tl.actual_quantity ELSE 0 END) AS put_away,
          SUM(CASE
            WHEN t.type = 'put' THEN tl.actual_quantity
            WHEN t.type = 'pick' THEN -tl.actual_quantity
            ELSE 0
          END) AS net_change
        FROM task_lines tl
        JOIN tasks t ON t.id = tl.task_id
        JOIN products p ON p.id = tl.product_id
        WHERE t.status = 'completed'
          AND t.type IN ('pick', 'put')
          ${taskRange.clause ? `AND ${taskRange.clause.slice(6)}` : ""}
        GROUP BY
          date(t.completed_at),
          p.id,
          p.unit_of_measure,
          COALESCE(tl.unit_of_measure, p.unit_of_measure)
        ORDER BY movement_date DESC, p.id
      `,
    )
    .all(...taskRange.params);
  const movementSummaryByPeriodAndUnit = new Map();
  for (const source of normalizeHistoricalReportUnits(db, movementSummarySource, [
    "picked",
    "put_away",
    "net_change",
  ])) {
    const unit = String(source.unit_of_measure || "Recorded unit").trim() || "Recorded unit";
    const key = `${source.movement_date}\u0000${normalizedCompositionToken(unit)}`;
    const row = movementSummaryByPeriodAndUnit.get(key) || {
      movement_date: source.movement_date,
      unit_of_measure: unit,
      picked: 0,
      put_away: 0,
      net_change: 0,
    };
    row.unit_of_measure = stableCompositionLabel(row.unit_of_measure, unit);
    row.picked += Number(source.picked || 0);
    row.put_away += Number(source.put_away || 0);
    row.net_change += Number(source.net_change || 0);
    movementSummaryByPeriodAndUnit.set(key, row);
  }
  const movementSummary = Array.from(movementSummaryByPeriodAndUnit.values()).sort(
    (left, right) =>
      String(right.movement_date).localeCompare(String(left.movement_date)) ||
      String(left.unit_of_measure).localeCompare(String(right.unit_of_measure), "en", {
        sensitivity: "base",
      }),
  );

  const userActivity = db
    .prepare(
      `
        SELECT
          u.username,
          (
            SELECT COUNT(*)
            FROM tasks t
            WHERE t.created_by = u.id
            ${taskActivityRange.clause}
          ) AS tasks_created,
          (
            SELECT COUNT(*)
            FROM transactions tr
            WHERE tr.user_id = u.id
            ${userTransactionRange.clause}
          ) AS transactions_recorded
        FROM users u
        ORDER BY u.username
      `,
    )
    .all(...taskActivityRange.params, ...userTransactionRange.params);

  const exceptionSourceRows = db
    .prepare(
      `
        SELECT
          t.id AS task_id,
          t.type,
          p.id AS product_id,
          p.sku,
          p.name AS product_name,
          c.logical_code,
          p.unit_of_measure AS current_unit,
          COALESCE(tl.unit_of_measure, p.unit_of_measure) AS recorded_unit,
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
  const exceptions = normalizeHistoricalReportUnits(db, exceptionSourceRows, [
    "planned_quantity",
    "actual_quantity",
    "exception_quantity",
  ]);

  const adjustments = db
    .prepare(
      `
        SELECT
          tr.created_at,
          p.sku,
          p.name AS product_name,
          c.logical_code,
          tr.quantity_delta,
          COALESCE(tr.unit_of_measure, p.unit_of_measure) AS unit_of_measure,
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

  const recentTaskActivity = db
    .prepare(
      `
        SELECT
          t.id,
          t.type,
          t.status,
          t.summary,
          t.started_at,
          t.completed_at,
          u.username,
          COALESCE(
            (
              SELECT GROUP_CONCAT(DISTINCT p.sku)
              FROM task_lines tl
              JOIN products p ON p.id = tl.product_id
              WHERE tl.task_id = t.id
            ),
            ''
          ) AS sku_list
        FROM tasks t
        JOIN users u ON u.id = t.created_by
        ${recentTaskRange.clause}
        ORDER BY COALESCE(t.completed_at, t.started_at) DESC, t.id DESC
        LIMIT 40
      `,
    )
    .all(...recentTaskRange.params);

  return {
    stockSnapshot,
    replenishmentWatch: buildReplenishmentWatchReport(db),
    slowMovingStock: buildSlowMovingStockReport(db, { fromAt, toAt }),
    movementSummary,
    productMovement: buildProductMovementReport(db, { fromAt, toAt, topN: 10 }),
    userActivity,
    teamThroughput: buildTeamThroughputReport(db, { fromAt, toAt }),
    exceptions,
    adjustments,
    recentTaskActivity,
  };
}
