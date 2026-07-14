const DATA_TYPES = new Set(["text", "number", "date", "boolean", "select"]);
const PROTECTED_SYSTEM_ROLES = new Set([
  "identifier",
  "display_name",
  "unit_of_measure",
  "location_capacity",
]);
const REPORT_REQUIRED_SYSTEM_ROLES = new Set([
  "identifier",
  "display_name",
  "unit_of_measure",
]);
const EDITABLE_FLAGS = [
  "required",
  "searchable",
  "filterable",
  "reportable",
  "visible",
  "active",
];

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

function assertAdmin(actor) {
  const id = actorId(actor);
  if (actor?.role !== "admin") {
    throw new Error("Only an admin can change product field definitions.");
  }
  return id;
}

function cleanLabel(value) {
  const label = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!label) {
    throw new Error("Field label is required.");
  }
  if (label.length > 80) {
    throw new Error("Field label must be 80 characters or fewer.");
  }
  return label;
}

function asFlag(value, fallback = 0) {
  if (value === undefined) {
    return fallback;
  }
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

function parseOptions(value, dataType) {
  if (dataType !== "select") {
    return null;
  }

  const source = Array.isArray(value) ? value : [];
  const options = Array.from(
    new Set(source.map((option) => String(option ?? "").trim()).filter(Boolean)),
  );
  if (!options.length) {
    throw new Error("A selection field must have at least one option.");
  }
  if (options.length > 100 || options.some((option) => option.length > 120)) {
    throw new Error("Selection fields support up to 100 options of 120 characters each.");
  }
  return options;
}

function parseStoredOptions(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function presentField(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    options: parseStoredOptions(row.options_json),
  };
}

function findField(db, { fieldId, fieldKey }) {
  if (fieldId !== undefined && fieldId !== null) {
    return db
      .prepare("SELECT * FROM product_field_definitions WHERE id = ?")
      .get(Number(fieldId));
  }
  return db
    .prepare("SELECT * FROM product_field_definitions WHERE field_key = ?")
    .get(String(fieldKey || ""));
}

function slugFromLabel(label) {
  const slug = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 52);
  return slug || "field";
}

function nextCustomFieldKey(db, label) {
  const base = `custom.${slugFromLabel(label)}`;
  let candidate = base;
  let suffix = 2;
  while (
    db.prepare("SELECT 1 FROM product_field_definitions WHERE field_key = ?").get(candidate)
  ) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function assertCanRequireField(db, fieldId) {
  const missing = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM products p
        WHERE p.active = 1
          AND NOT EXISTS (
            SELECT 1
            FROM product_attribute_values pav
            WHERE pav.product_id = p.id
              AND pav.field_definition_id = ?
          )
      `,
    )
    .get(fieldId);
  if (Number(missing?.count || 0) > 0) {
    throw new Error(
      "Populate this field for every active product before marking it as required.",
    );
  }
}

function normalizedTypedValue(field, value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (field.data_type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`${field.label} must be a valid number.`);
    }
    return { column: "value_number", value: number };
  }

  if (field.data_type === "boolean") {
    if ([true, 1, "1", "true"].includes(value)) {
      return { column: "value_boolean", value: 1 };
    }
    if ([false, 0, "0", "false"].includes(value)) {
      return { column: "value_boolean", value: 0 };
    }
    throw new Error(`${field.label} must be yes or no.`);
  }

  const text = String(value).trim();
  if (field.data_type === "date") {
    const parsed = new Date(`${text}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== text
    ) {
      throw new Error(`${field.label} must be a valid date in YYYY-MM-DD format.`);
    }
    return { column: "value_date", value: text };
  }

  if (field.data_type === "select") {
    const options = parseStoredOptions(field.options_json);
    if (!options.includes(text)) {
      throw new Error(`${field.label} must use one of its configured options.`);
    }
  }

  if (text.length > 2000) {
    throw new Error(`${field.label} must be 2,000 characters or fewer.`);
  }
  return { column: "value_text", value: text };
}

export function listProductFields(
  db,
  { includeInactive = false, reportableOnly = false } = {},
) {
  const clauses = [];
  if (!includeInactive) {
    clauses.push("active = 1");
  }
  if (reportableOnly) {
    clauses.push("reportable = 1");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `
        SELECT *
        FROM product_field_definitions
        ${where}
        ORDER BY sort_order, id
      `,
    )
    .all()
    .map(presentField);
}

export function getProductFieldLabels(db) {
  return Object.fromEntries(
    listProductFields(db).map((field) => [field.field_key, field.label]),
  );
}

export function createCustomProductField(db, input) {
  const createdBy = assertAdmin(input.actor);
  const label = cleanLabel(input.label);
  const dataType = String(input.dataType || input.data_type || "text").trim();
  if (!DATA_TYPES.has(dataType)) {
    throw new Error("Choose a supported product field type.");
  }

  const required = asFlag(input.required);
  if (required) {
    const activeProducts = Number(
      db.prepare("SELECT COUNT(*) AS count FROM products WHERE active = 1").get()?.count || 0,
    );
    if (activeProducts > 0) {
      throw new Error(
        "Create the field as optional, populate existing products, and then mark it required.",
      );
    }
  }

  const options = parseOptions(input.options, dataType);
  const createdAt = nowIso();
  const result = db
    .prepare(
      `
        INSERT INTO product_field_definitions (
          field_key, source_column, label, data_type, field_kind, system_role,
          required, searchable, filterable, reportable, visible, active,
          options_json, sort_order, created_by, created_at, updated_at
        )
        VALUES (?, NULL, ?, ?, 'custom', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      nextCustomFieldKey(db, label),
      label,
      dataType,
      required,
      asFlag(input.searchable),
      asFlag(input.filterable, 1),
      asFlag(input.reportable, 1),
      asFlag(input.visible, 1),
      asFlag(input.active, 1),
      options ? JSON.stringify(options) : null,
      Number.isInteger(Number(input.sortOrder ?? input.sort_order))
        ? Number(input.sortOrder ?? input.sort_order)
        : 100,
      createdBy,
      createdAt,
      createdAt,
    );

  return presentField(
    db.prepare("SELECT * FROM product_field_definitions WHERE id = ?").get(result.lastInsertRowid),
  );
}

export function updateProductField(db, input) {
  assertAdmin(input.actor);
  const field = findField(db, input);
  if (!field) {
    throw new Error("Product field not found.");
  }

  const requestedType = input.dataType ?? input.data_type;
  if (requestedType !== undefined && requestedType !== field.data_type) {
    throw new Error(
      "Changing a field type requires a separate previewed data migration.",
    );
  }

  const next = {
    label: input.label === undefined ? field.label : cleanLabel(input.label),
    required: field.required,
    searchable: field.searchable,
    filterable: field.filterable,
    reportable: field.reportable,
    visible: field.visible,
    active: field.active,
    sort_order: Number.isInteger(Number(input.sortOrder ?? input.sort_order))
      ? Number(input.sortOrder ?? input.sort_order)
      : field.sort_order,
  };
  for (const flag of EDITABLE_FLAGS) {
    if (input[flag] !== undefined) {
      next[flag] = asFlag(input[flag]);
    }
  }

  if (
    field.field_kind === "core" &&
    PROTECTED_SYSTEM_ROLES.has(field.system_role) &&
    (!next.active || !next.required)
  ) {
    throw new Error(
      "This operational product field can be renamed or hidden, but it cannot be disabled or made optional.",
    );
  }
  if (
    field.field_kind === "core" &&
    REPORT_REQUIRED_SYSTEM_ROLES.has(field.system_role) &&
    !next.reportable
  ) {
    throw new Error(
      "This operational product field is required by reports. It can be renamed or hidden, but reporting cannot be disabled.",
    );
  }

  if (!field.required && next.required && field.field_kind === "custom") {
    assertCanRequireField(db, field.id);
  }

  let optionsJson = field.options_json;
  if (input.options !== undefined) {
    if (field.data_type !== "select") {
      throw new Error("Only selection fields have configured options.");
    }
    const options = parseOptions(input.options, field.data_type);
    const usedValues = db
      .prepare(
        `
          SELECT DISTINCT value_text
          FROM product_attribute_values
          WHERE field_definition_id = ? AND value_text IS NOT NULL
        `,
      )
      .all(field.id)
      .map((row) => row.value_text);
    const removedUsedValues = usedValues.filter((value) => !options.includes(value));
    if (removedUsedValues.length) {
      throw new Error(
        "Reassign existing product values before removing a selection option that is in use.",
      );
    }
    optionsJson = JSON.stringify(options);
  }

  db.prepare(
    `
      UPDATE product_field_definitions
      SET label = ?, required = ?, searchable = ?, filterable = ?, reportable = ?,
          visible = ?, active = ?, options_json = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(
    next.label,
    next.required,
    next.searchable,
    next.filterable,
    next.reportable,
    next.visible,
    next.active,
    optionsJson,
    next.sort_order,
    nowIso(),
    field.id,
  );

  return presentField(
    db.prepare("SELECT * FROM product_field_definitions WHERE id = ?").get(field.id),
  );
}

export function getProductAttributes(db, productId, { includeInactive = false } = {}) {
  return db
    .prepare(
      `
        SELECT
          pfd.*,
          pav.value_text,
          pav.value_number,
          pav.value_date,
          pav.value_boolean,
          pav.updated_at AS value_updated_at
        FROM product_field_definitions pfd
        LEFT JOIN product_attribute_values pav
          ON pav.field_definition_id = pfd.id
         AND pav.product_id = ?
        WHERE pfd.field_kind = 'custom'
          ${includeInactive ? "" : "AND pfd.active = 1"}
        ORDER BY pfd.sort_order, pfd.id
      `,
    )
    .all(Number(productId))
    .map((row) => {
      const value =
        row.data_type === "number"
          ? row.value_number
          : row.data_type === "date"
            ? row.value_date
            : row.data_type === "boolean"
              ? row.value_boolean === null || row.value_boolean === undefined
                ? null
                : Boolean(row.value_boolean)
              : row.value_text;
      return { ...presentField(row), value };
    });
}

export function setProductAttributeValue(db, input) {
  const updatedBy = actorId(input.actor);
  const productId = Number(input.productId ?? input.product_id);
  const product = db.prepare("SELECT id FROM products WHERE id = ?").get(productId);
  if (!product) {
    throw new Error("Product not found.");
  }

  const field = findField(db, input);
  if (!field || field.field_kind !== "custom") {
    throw new Error("Custom product field not found.");
  }
  if (!field.active) {
    throw new Error("This product field is disabled.");
  }

  const typed = normalizedTypedValue(field, input.value);
  if (!typed) {
    if (field.required) {
      throw new Error(`${field.label} is required.`);
    }
    db.prepare(
      "DELETE FROM product_attribute_values WHERE product_id = ? AND field_definition_id = ?",
    ).run(productId, field.id);
    return { productId, field: presentField(field), value: null };
  }

  const values = {
    value_text: null,
    value_number: null,
    value_date: null,
    value_boolean: null,
    [typed.column]: typed.value,
  };
  db.prepare(
    `
      INSERT INTO product_attribute_values (
        product_id, field_definition_id, value_text, value_number,
        value_date, value_boolean, updated_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id, field_definition_id) DO UPDATE SET
        value_text = excluded.value_text,
        value_number = excluded.value_number,
        value_date = excluded.value_date,
        value_boolean = excluded.value_boolean,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `,
  ).run(
    productId,
    field.id,
    values.value_text,
    values.value_number,
    values.value_date,
    values.value_boolean,
    updatedBy,
    nowIso(),
  );
  return { productId, field: presentField(field), value: typed.value };
}

export function createProductFieldService({ db }) {
  return {
    list(options) {
      return listProductFields(db, options);
    },
    labels() {
      return getProductFieldLabels(db);
    },
    create(input) {
      return createCustomProductField(db, input);
    },
    update(input) {
      return updateProductField(db, input);
    },
    getProductValues(productId, options) {
      return getProductAttributes(db, productId, options);
    },
    setProductValue(input) {
      return setProductAttributeValue(db, input);
    },
  };
}
