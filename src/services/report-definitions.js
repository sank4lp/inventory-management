const MOVEMENT_METRICS = new Set([
  "picked_quantity",
  "pick_frequency",
  "put_quantity",
  "put_frequency",
  "net_outflow",
  "total_handled",
]);
const MOVEMENT_VALUE_COLUMNS = new Set([
  ...MOVEMENT_METRICS,
  "available_quantity",
]);
const STOCK_DETAIL_VIRTUAL_COLUMNS = new Set(["group_label", "product_count"]);
const TREND_METRICS = new Set([
  "picked_quantity",
  "put_quantity",
  "total_handled",
  "net_change",
]);
const TREND_GROUP_BY_OPTIONS = new Set(["day", "week", "month"]);
const TREND_COLUMNS = new Set([
  "period",
  "product.unit_of_measure",
  ...TREND_METRICS,
]);
const EXCEPTION_METRICS = new Set([
  "exception_quantity",
  "exception_count",
  "affected_tasks",
]);
const EXCEPTION_GROUP_BY_OPTIONS = new Set([
  "product",
  "category",
  "unit_of_measure",
  "cell",
  "task_type",
]);
const EXCEPTION_COLUMNS = new Set([
  "group_label",
  "product.unit_of_measure",
  ...EXCEPTION_METRICS,
]);
const REPORT_VIRTUAL_COLUMNS = new Set([
  ...MOVEMENT_VALUE_COLUMNS,
  ...STOCK_DETAIL_VIRTUAL_COLUMNS,
  "period",
  ...TREND_METRICS,
  "group_label",
  ...EXCEPTION_METRICS,
]);
const GROUP_BY_OPTIONS = new Set(["product", "category", "unit_of_measure"]);
const PRODUCT_GROUP_FIELD_KEYS = {
  product: "product.name",
  category: "product.category",
  unit_of_measure: "product.unit_of_measure",
};
const MOVEMENT_VISUALIZATIONS = new Set(["bar", "table"]);
const STOCK_COMPOSITION_VISUALIZATIONS = new Set(["bar", "donut", "table"]);
const DATE_RANGES = new Set([
  "all_time",
  "last_1_hour",
  "last_3_hours",
  "last_6_hours",
  "last_12_hours",
  "last_24_hours",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "previous_day",
  "previous_week",
  "previous_month",
  "this_month",
]);

function nowIso() {
  return new Date().toISOString();
}

function actorId(actor) {
  const id = Number(actor?.id ?? actor?.userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid user is required.");
  }
  return id;
}

function cleanText(value, fieldName, maxLength, { required = true } = {}) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (required && !text) {
    throw new Error(`${fieldName} is required.`);
  }
  if (text.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function parseRecipe(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("Report recipe is not valid JSON.");
    }
  }
  return value;
}

function cleanOptionalFilter(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  if (text.length > 120) {
    throw new Error(`${label} must be 120 characters or fewer.`);
  }
  return text;
}

function reportableProductFieldKeys(db) {
  return new Set(
    db
      .prepare(
        `
          SELECT field_key
          FROM product_field_definitions
          WHERE active = 1 AND reportable = 1
        `,
      )
      .all()
      .map((row) => row.field_key),
  );
}

export function validateMovementRecipe(db, input) {
  const recipe = parseRecipe(input);
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new Error("Report recipe is required.");
  }
  if (recipe.sql !== undefined || recipe.query !== undefined || recipe.statement !== undefined) {
    throw new Error("Custom SQL is not accepted in report recipes.");
  }

  const type = String(recipe.type || "product_movement");
  if (type !== "product_movement") {
    throw new Error("Choose a supported report type.");
  }
  const metric = String(recipe.metric || "picked_quantity");
  if (!MOVEMENT_METRICS.has(metric)) {
    throw new Error("Choose a supported product movement metric.");
  }
  const groupBy = String(recipe.groupBy || recipe.group_by || "product");
  const allowedFields = reportableProductFieldKeys(db);
  if (!GROUP_BY_OPTIONS.has(groupBy) && !(groupBy.startsWith("custom.") && allowedFields.has(groupBy))) {
    throw new Error("Choose a supported product movement grouping.");
  }
  if (PRODUCT_GROUP_FIELD_KEYS[groupBy] && !allowedFields.has(PRODUCT_GROUP_FIELD_KEYS[groupBy])) {
    throw new Error("The selected product movement grouping is not available for reports.");
  }
  const visualization = String(recipe.visualization || "bar");
  if (!MOVEMENT_VISUALIZATIONS.has(visualization)) {
    throw new Error("Choose a supported product movement visualization.");
  }
  const dateRange = String(recipe.dateRange || recipe.date_range || "last_30_days");
  if (!DATE_RANGES.has(dateRange)) {
    throw new Error("Choose a supported report date range.");
  }
  const topN = Number(recipe.topN ?? recipe.top_n ?? 10);
  if (!Number.isInteger(topN) || topN < 1 || topN > 50) {
    throw new Error("Top results must be a whole number from 1 to 50.");
  }

  const defaultColumns = [
    "product.sku",
    "product.name",
    ...(groupBy.startsWith("custom.") ? [groupBy] : []),
    metric,
    "pick_frequency",
    "put_quantity",
  ];
  const requestedColumns = Array.isArray(recipe.columns) ? recipe.columns : defaultColumns;
  const columns = Array.from(new Set(requestedColumns.map((column) => String(column))));
  if (!columns.length || columns.length > 20) {
    throw new Error("Choose between 1 and 20 report columns.");
  }
  for (const column of columns) {
    if (!allowedFields.has(column) && !MOVEMENT_VALUE_COLUMNS.has(column)) {
      throw new Error(`Report column ${column} is not available.`);
    }
  }

  const filters = recipe.filters && typeof recipe.filters === "object" ? recipe.filters : {};
  return {
    version: 1,
    type,
    metric,
    groupBy,
    filters: {
      category: cleanOptionalFilter(filters.category, "Category filter"),
      unitOfMeasure: cleanOptionalFilter(
        filters.unitOfMeasure ?? filters.unit_of_measure,
        "Unit of measure filter",
      ),
    },
    dateRange,
    topN,
    visualization,
    columns,
  };
}

export function validateStockCompositionRecipe(db, input) {
  const recipe = parseRecipe(input);
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new Error("Report recipe is required.");
  }
  if (recipe.sql !== undefined || recipe.query !== undefined || recipe.statement !== undefined) {
    throw new Error("Custom SQL is not accepted in report recipes.");
  }

  const type = String(recipe.type || "stock_composition");
  if (type !== "stock_composition") {
    throw new Error("Choose a supported report type.");
  }
  const metric = String(recipe.metric || "available_quantity");
  if (metric !== "available_quantity") {
    throw new Error("Stock composition reports use available quantity.");
  }

  const allowedFields = reportableProductFieldKeys(db);
  const groupBy = String(recipe.groupBy || recipe.group_by || "product");
  if (groupBy === "unit_of_measure") {
    throw new Error("Stock composition cannot be grouped by unit of measure.");
  }
  if (
    !new Set(["product", "category"]).has(groupBy) &&
    !(groupBy.startsWith("custom.") && allowedFields.has(groupBy))
  ) {
    throw new Error(
      "Choose product, category, or a reportable custom field for stock composition.",
    );
  }
  if (PRODUCT_GROUP_FIELD_KEYS[groupBy] && !allowedFields.has(PRODUCT_GROUP_FIELD_KEYS[groupBy])) {
    throw new Error("The selected stock grouping is not available for reports.");
  }

  const visualization = String(recipe.visualization || "bar");
  if (!STOCK_COMPOSITION_VISUALIZATIONS.has(visualization)) {
    throw new Error("Choose a supported stock composition visualization.");
  }
  const topN = Number(recipe.topN ?? recipe.top_n ?? 8);
  if (!Number.isInteger(topN) || topN < 1 || topN > 50) {
    throw new Error("Top results must be a whole number from 1 to 50.");
  }

  const filters = recipe.filters && typeof recipe.filters === "object" ? recipe.filters : {};
  const category = cleanOptionalFilter(filters.category, "Category filter");
  const unitOfMeasure = cleanOptionalFilter(
    filters.unitOfMeasure ?? filters.unit_of_measure,
    "Unit of measure filter",
  );
  if (visualization === "donut" && !unitOfMeasure) {
    throw new Error("Choose a unit of measure before using a donut chart.");
  }
  if (visualization === "donut" && topN > 8) {
    throw new Error("Donut charts support at most 8 named slices.");
  }
  if (visualization === "donut" && groupBy === "category" && category) {
    throw new Error(
      "Remove the category filter when grouping a donut chart by category.",
    );
  }

  const defaultColumns = [
    "group_label",
    "product_count",
    "available_quantity",
    "product.unit_of_measure",
  ];
  const requestedColumns = Array.isArray(recipe.columns) ? recipe.columns : defaultColumns;
  const columns = Array.from(new Set(requestedColumns.map((column) => String(column))));
  if (!columns.length || columns.length > 20) {
    throw new Error("Choose between 1 and 20 report columns.");
  }
  for (const column of columns) {
    if (
      !allowedFields.has(column) &&
      column !== "available_quantity" &&
      !STOCK_DETAIL_VIRTUAL_COLUMNS.has(column)
    ) {
      throw new Error(`Report column ${column} is not available.`);
    }
    if (
      groupBy !== "product" &&
      allowedFields.has(column) &&
      column !== "product.unit_of_measure"
    ) {
      throw new Error("Product-only detail columns require grouping current stock by product.");
    }
  }

  return {
    version: 1,
    type,
    metric,
    groupBy,
    filters: { category, unitOfMeasure },
    dateRange: "current",
    topN,
    visualization,
    columns,
  };
}

export function validateMovementOverTimeRecipe(db, input) {
  const recipe = parseRecipe(input);
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new Error("Report recipe is required.");
  }
  if (recipe.sql !== undefined || recipe.query !== undefined || recipe.statement !== undefined) {
    throw new Error("Custom SQL is not accepted in report recipes.");
  }
  if (!reportableProductFieldKeys(db).has("product.unit_of_measure")) {
    throw new Error("Unit of measure is required for movement trend reports.");
  }

  const type = String(recipe.type || "movement_over_time");
  if (type !== "movement_over_time") {
    throw new Error("Choose a supported report type.");
  }
  const metric = String(recipe.metric || "picked_quantity");
  if (!TREND_METRICS.has(metric)) {
    throw new Error("Choose a supported movement trend measure.");
  }
  const groupBy = String(recipe.groupBy || recipe.group_by || "day");
  if (!TREND_GROUP_BY_OPTIONS.has(groupBy)) {
    throw new Error("Choose day, week, or month for movement over time.");
  }
  const visualization = String(recipe.visualization || "bar");
  if (!MOVEMENT_VISUALIZATIONS.has(visualization)) {
    throw new Error("Choose a supported movement trend visualization.");
  }
  const dateRange = String(recipe.dateRange || recipe.date_range || "last_30_days");
  if (!DATE_RANGES.has(dateRange)) {
    throw new Error("Choose a supported report date range.");
  }
  const topN = Number(recipe.topN ?? recipe.top_n ?? 10);
  if (!Number.isInteger(topN) || topN < 1 || topN > 50) {
    throw new Error("Periods shown must be a whole number from 1 to 50.");
  }
  const requestedColumns = Array.isArray(recipe.columns)
    ? recipe.columns
    : ["period", "product.unit_of_measure", metric];
  const columns = Array.from(new Set(requestedColumns.map((column) => String(column))));
  if (!columns.length || columns.length > 20 || columns.some((column) => !TREND_COLUMNS.has(column))) {
    throw new Error("Choose valid movement trend columns.");
  }
  const filters = recipe.filters && typeof recipe.filters === "object" ? recipe.filters : {};
  return {
    version: 1,
    type,
    metric,
    groupBy,
    filters: {
      category: cleanOptionalFilter(filters.category, "Category filter"),
      unitOfMeasure: cleanOptionalFilter(
        filters.unitOfMeasure ?? filters.unit_of_measure,
        "Unit of measure filter",
      ),
    },
    dateRange,
    topN,
    visualization,
    columns,
  };
}

export function validateExceptionsRecipe(db, input) {
  const recipe = parseRecipe(input);
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new Error("Report recipe is required.");
  }
  if (recipe.sql !== undefined || recipe.query !== undefined || recipe.statement !== undefined) {
    throw new Error("Custom SQL is not accepted in report recipes.");
  }

  const type = String(recipe.type || "exceptions");
  if (type !== "exceptions") {
    throw new Error("Choose a supported report type.");
  }
  const metric = String(recipe.metric || "exception_quantity");
  if (!EXCEPTION_METRICS.has(metric)) {
    throw new Error("Choose a supported exception measure.");
  }
  const groupBy = String(recipe.groupBy || recipe.group_by || "product");
  if (!EXCEPTION_GROUP_BY_OPTIONS.has(groupBy)) {
    throw new Error("Choose a supported exception grouping.");
  }
  const allowedFields = reportableProductFieldKeys(db);
  if (PRODUCT_GROUP_FIELD_KEYS[groupBy] && !allowedFields.has(PRODUCT_GROUP_FIELD_KEYS[groupBy])) {
    throw new Error("The selected exception grouping is not available for reports.");
  }
  if (!allowedFields.has("product.unit_of_measure")) {
    throw new Error("Unit of measure is required for exception reports.");
  }
  const visualization = String(recipe.visualization || "bar");
  if (!MOVEMENT_VISUALIZATIONS.has(visualization)) {
    throw new Error("Choose a supported exception visualization.");
  }
  const dateRange = String(recipe.dateRange || recipe.date_range || "last_30_days");
  if (!DATE_RANGES.has(dateRange)) {
    throw new Error("Choose a supported report date range.");
  }
  const topN = Number(recipe.topN ?? recipe.top_n ?? 10);
  if (!Number.isInteger(topN) || topN < 1 || topN > 50) {
    throw new Error("Top results must be a whole number from 1 to 50.");
  }
  const requestedColumns = Array.isArray(recipe.columns)
    ? recipe.columns
    : ["group_label", "product.unit_of_measure", "exception_count", "exception_quantity"];
  const columns = Array.from(new Set(requestedColumns.map((column) => String(column))));
  if (!columns.length || columns.length > 20 || columns.some((column) => !EXCEPTION_COLUMNS.has(column))) {
    throw new Error("Choose valid exception report columns.");
  }
  const filters = recipe.filters && typeof recipe.filters === "object" ? recipe.filters : {};
  return {
    version: 1,
    type,
    metric,
    groupBy,
    filters: {
      category: cleanOptionalFilter(filters.category, "Category filter"),
      unitOfMeasure: cleanOptionalFilter(
        filters.unitOfMeasure ?? filters.unit_of_measure,
        "Unit of measure filter",
      ),
    },
    dateRange,
    topN,
    visualization,
    columns,
  };
}

export function validateReportRecipe(db, input) {
  const recipe = parseRecipe(input);
  if (recipe && typeof recipe === "object") {
    if (recipe.type === "stock_composition") {
      return validateStockCompositionRecipe(db, recipe);
    }
    if (recipe.type === "movement_over_time") {
      return validateMovementOverTimeRecipe(db, recipe);
    }
    if (recipe.type === "exceptions") {
      return validateExceptionsRecipe(db, recipe);
    }
  }
  return validateMovementRecipe(db, recipe);
}

function recipeStatus(db, recipe) {
  const productColumns = Array.from(new Set([
    ...(Array.isArray(recipe.columns) ? recipe.columns : []).filter(
      (column) =>
        !REPORT_VIRTUAL_COLUMNS.has(column),
    ),
    ...(String(recipe.groupBy || "").startsWith("custom.") ? [recipe.groupBy] : []),
  ]));
  if (!productColumns.length) {
    return { status: "ready", unavailableFields: [] };
  }
  const placeholders = productColumns.map(() => "?").join(", ");
  const available = new Set(
    db
      .prepare(
        `
          SELECT field_key
          FROM product_field_definitions
          WHERE field_key IN (${placeholders})
            AND active = 1
            AND reportable = 1
        `,
      )
      .all(...productColumns)
      .map((row) => row.field_key),
  );
  const unavailableFields = productColumns.filter((field) => !available.has(field));
  return {
    status: unavailableFields.length ? "needs_attention" : "ready",
    unavailableFields,
  };
}

function presentDefinition(db, row) {
  if (!row) {
    return null;
  }
  let recipe;
  try {
    recipe = JSON.parse(row.recipe_json);
  } catch {
    recipe = null;
  }
  let validation = { status: "needs_attention", unavailableFields: [] };
  let validationError = null;
  if (recipe) {
    const fieldValidation = recipeStatus(db, recipe);
    if (fieldValidation.status === "needs_attention") {
      validation = fieldValidation;
    } else {
      try {
        const normalizedRecipe = validateReportRecipe(db, recipe);
        validation = recipeStatus(db, normalizedRecipe);
      } catch (error) {
        validationError = error.message;
      }
    }
  }
  return {
    ...row,
    recipe,
    validation_status: validation.status,
    unavailable_fields: validation.unavailableFields,
    validation_error: validationError,
  };
}

function requestedVisibility(actor, value, fallback = "private") {
  const visibility = String(value || fallback);
  if (!new Set(["private", "shared"]).has(visibility)) {
    throw new Error("Report visibility must be private or shared.");
  }
  if (visibility === "shared" && actor?.role !== "admin") {
    throw new Error("Only an admin can publish a shared report.");
  }
  return visibility;
}

function findVisibleDefinition(db, id, actor) {
  const userId = actorId(actor);
  return db
    .prepare(
      `
        SELECT *
        FROM report_definitions
        WHERE id = ?
          AND active = 1
          AND (visibility = 'shared' OR owner_user_id = ?)
      `,
    )
    .get(Number(id), userId);
}

function assertEditable(row, actor) {
  const userId = actorId(actor);
  if (!row) {
    throw new Error("Report not found.");
  }
  if (row.is_locked || row.definition_type === "built_in") {
    throw new Error("Built-in reports are locked. Duplicate the report to customize it.");
  }
  if (Number(row.owner_user_id) !== userId) {
    throw new Error("You can change only reports that you own.");
  }
}

export function listReportDefinitions(db, { actor, includeInactive = false } = {}) {
  const userId = actorId(actor);
  return db
    .prepare(
      `
        SELECT rd.*, u.username AS owner_username
        FROM report_definitions rd
        LEFT JOIN users u ON u.id = rd.owner_user_id
        WHERE (rd.visibility = 'shared' OR rd.owner_user_id = ?)
          ${includeInactive ? "" : "AND rd.active = 1"}
        ORDER BY
          CASE rd.definition_type WHEN 'built_in' THEN 0 ELSE 1 END,
          rd.name COLLATE NOCASE,
          rd.id
      `,
    )
    .all(userId)
    .map((row) => presentDefinition(db, row));
}

export function getReportDefinition(db, { reportId, actor }) {
  return presentDefinition(db, findVisibleDefinition(db, reportId, actor));
}

export function createReportDefinition(db, input) {
  const ownerUserId = actorId(input.actor);
  const recipe = validateReportRecipe(db, input.recipe);
  const createdAt = nowIso();
  const result = db
    .prepare(
      `
        INSERT INTO report_definitions (
          stable_key, name, description, definition_type, recipe_json,
          owner_user_id, visibility, is_locked, active, created_by, created_at, updated_at
        )
        VALUES (NULL, ?, ?, 'custom', ?, ?, ?, 0, 1, ?, ?, ?)
      `,
    )
    .run(
      cleanText(input.name, "Report name", 100),
      cleanText(input.description, "Report description", 500, { required: false }),
      JSON.stringify(recipe),
      ownerUserId,
      requestedVisibility(input.actor, input.visibility),
      ownerUserId,
      createdAt,
      createdAt,
    );
  return presentDefinition(
    db,
    db.prepare("SELECT * FROM report_definitions WHERE id = ?").get(result.lastInsertRowid),
  );
}

export function updateReportDefinition(db, input) {
  const row = db
    .prepare("SELECT * FROM report_definitions WHERE id = ?")
    .get(Number(input.reportId));
  assertEditable(row, input.actor);
  const recipe =
    input.recipe === undefined ? JSON.parse(row.recipe_json) : validateReportRecipe(db, input.recipe);
  const name =
    input.name === undefined ? row.name : cleanText(input.name, "Report name", 100);
  const description =
    input.description === undefined
      ? row.description
      : cleanText(input.description, "Report description", 500, { required: false });
  const visibility =
    input.visibility === undefined
      ? row.visibility
      : requestedVisibility(input.actor, input.visibility, row.visibility);

  db.prepare(
    `
      UPDATE report_definitions
      SET name = ?, description = ?, recipe_json = ?, visibility = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(name, description, JSON.stringify(recipe), visibility, nowIso(), row.id);
  return presentDefinition(
    db,
    db.prepare("SELECT * FROM report_definitions WHERE id = ?").get(row.id),
  );
}

export function deleteReportDefinition(db, { reportId, actor }) {
  const row = db
    .prepare("SELECT * FROM report_definitions WHERE id = ?")
    .get(Number(reportId));
  assertEditable(row, actor);
  db.prepare("DELETE FROM report_definitions WHERE id = ?").run(row.id);
  return { id: row.id, deleted: true };
}

export function duplicateReportDefinition(db, input) {
  const source = findVisibleDefinition(db, input.reportId, input.actor);
  if (!source) {
    throw new Error("Report not found.");
  }
  return createReportDefinition(db, {
    actor: input.actor,
    name: input.name || `Copy of ${source.name}`,
    description: input.description ?? source.description,
    visibility: input.visibility || "private",
    recipe: JSON.parse(source.recipe_json),
  });
}

export function createReportDefinitionService({ db }) {
  return {
    list(input) {
      return listReportDefinitions(db, input);
    },
    get(input) {
      return getReportDefinition(db, input);
    },
    create(input) {
      return createReportDefinition(db, input);
    },
    update(input) {
      return updateReportDefinition(db, input);
    },
    delete(input) {
      return deleteReportDefinition(db, input);
    },
    duplicate(input) {
      return duplicateReportDefinition(db, input);
    },
    validate(recipe) {
      return validateReportRecipe(db, recipe);
    },
  };
}
