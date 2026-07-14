import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "inventory.db");
export const APP_SCHEMA_VERSION = "5";

const CORE_PRODUCT_FIELD_DEFINITIONS = [
  {
    key: "product.sku",
    sourceColumn: "sku",
    label: "SKU",
    dataType: "text",
    systemRole: "identifier",
    required: 1,
    sortOrder: 10,
  },
  {
    key: "product.name",
    sourceColumn: "name",
    label: "Name",
    dataType: "text",
    systemRole: "display_name",
    required: 1,
    sortOrder: 20,
  },
  {
    key: "product.brand",
    sourceColumn: "brand",
    label: "Brand",
    dataType: "text",
    systemRole: "brand",
    required: 1,
    sortOrder: 30,
  },
  {
    key: "product.category",
    sourceColumn: "category",
    label: "Category",
    dataType: "text",
    systemRole: "category",
    required: 0,
    sortOrder: 40,
  },
  {
    key: "product.variant",
    sourceColumn: "variant",
    label: "Variant",
    dataType: "text",
    systemRole: "variant",
    required: 0,
    sortOrder: 50,
  },
  {
    key: "product.unit_of_measure",
    sourceColumn: "unit_of_measure",
    label: "Unit of measure",
    dataType: "text",
    systemRole: "unit_of_measure",
    required: 1,
    sortOrder: 60,
  },
  {
    key: "product.items_per_cell",
    sourceColumn: "items_per_cell",
    label: "Items per location",
    dataType: "number",
    systemRole: "location_capacity",
    required: 1,
    sortOrder: 70,
  },
  {
    key: "product.description",
    sourceColumn: "description",
    label: "Description",
    dataType: "text",
    systemRole: "description",
    required: 0,
    sortOrder: 80,
  },
];

const BUILT_IN_PRODUCT_MOVEMENT_RECIPE = {
  version: 1,
  type: "product_movement",
  metric: "picked_quantity",
  groupBy: "product",
  filters: {
    category: null,
    unitOfMeasure: null,
  },
  topN: 10,
  visualization: "bar",
  columns: [
    "product.sku",
    "product.name",
    "picked_quantity",
    "pick_frequency",
    "put_quantity",
    "net_outflow",
  ],
};

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function seedReportingFoundation(db) {
  const insertField = db.prepare(
    `
      INSERT OR IGNORE INTO product_field_definitions (
        field_key, source_column, label, data_type, field_kind, system_role,
        required, searchable, filterable, reportable, visible, active,
        options_json, sort_order, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'core', ?, ?, 1, 1, 1, 1, 1, NULL, ?, ?, ?)
    `,
  );
  const createdAt = nowIso();

  for (const field of CORE_PRODUCT_FIELD_DEFINITIONS) {
    insertField.run(
      field.key,
      field.sourceColumn,
      field.label,
      field.dataType,
      field.systemRole,
      field.required,
      field.sortOrder,
      createdAt,
      createdAt,
    );
  }

  db.prepare(
    `
      INSERT OR IGNORE INTO report_definitions (
        stable_key, name, description, definition_type, recipe_json,
        owner_user_id, visibility, is_locked, active, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, 'built_in', ?, NULL, 'shared', 1, 1, NULL, ?, ?)
    `,
  ).run(
    "product-movement-demand",
    "Product Movement & Demand",
    "Shows the products most picked and put away using corrected completed-task quantities.",
    JSON.stringify(BUILT_IN_PRODUCT_MOVEMENT_RECIPE),
    createdAt,
    createdAt,
  );
}

function seedUsers(db, authHelpers) {
  const {
    hashPassword,
    bootstrapAdmin = null,
    allowDevAuthSeeds = true,
  } = authHelpers;
  const adminExists = db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1")
    .get();

  if (!adminExists) {
    const adminConfig = bootstrapAdmin || {
      name: "System Admin",
      username: "admin",
      password: "admin123",
    };
    db.prepare(
      `
        INSERT INTO users (name, username, password_hash, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      adminConfig.name,
      adminConfig.username,
      hashPassword(adminConfig.password),
      "admin",
      "active",
      nowIso(),
    );
  }

  if (!allowDevAuthSeeds) {
    return;
  }

  const operatorExists = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get("operator");

  if (!operatorExists) {
    const admin = db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("admin");

    db.prepare(
      `
        INSERT INTO users (name, username, password_hash, role, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "Warehouse Operator",
      "operator",
      hashPassword("operator123"),
      "operator",
      "active",
      admin.id,
      nowIso(),
    );
  }
}

function seedRegistrationKeys(db) {
  const activeAdmin = db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1")
    .get();
  if (!activeAdmin) {
    return;
  }

  const row = db
    .prepare("SELECT id FROM registration_keys WHERE key_value = ?")
    .get("INVITE-OP-2026");

  if (!row) {
    db.prepare(
      `
        INSERT INTO registration_keys (key_value, role, status, expires_at, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "INVITE-OP-2026",
      "operator",
      "active",
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      activeAdmin.id,
      nowIso(),
    );
  }
}

function seedWarehouse(db) {
  const zone = db.prepare("SELECT id FROM zones WHERE code = ?").get("Z1");

  let zoneId = zone?.id;
  if (!zoneId) {
    const result = db
      .prepare("INSERT INTO zones (code, name, sort_order) VALUES (?, ?, ?)")
      .run("Z1", "Main Zone", 1);
    zoneId = Number(result.lastInsertRowid);
  }

  const controllers = [
    {
      code: "CTRL-Z1-B1",
      address: "1",
      firmware: "sim-0.1",
      from: 1,
      to: 9,
    },
    {
      code: "CTRL-Z1-B2",
      address: "2",
      firmware: "sim-0.1",
      from: 10,
      to: 18,
    },
    {
      code: "CTRL-Z1-B3",
      address: "3",
      firmware: "sim-0.1",
      from: 19,
      to: 27,
    },
  ];

  for (const controller of controllers) {
    const existing = db
      .prepare("SELECT id FROM controllers WHERE controller_code = ?")
      .get(controller.code);

    if (!existing) {
      db.prepare(
        `
          INSERT INTO controllers (
            zone_id, controller_code, address, firmware_version, heartbeat_status,
            last_seen_at, cell_start_column, cell_end_column, active
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `,
      ).run(
        zoneId,
        controller.code,
        controller.address,
        controller.firmware,
        "online",
        nowIso(),
        controller.from,
        controller.to,
      );
    }
  }

  const admin = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  const controllerRows = db.prepare("SELECT * FROM controllers").all();

  for (let row = 1; row <= 3; row += 1) {
    for (let column = 1; column <= 27; column += 1) {
      const logicalCode = `Z1-R${row}-C${String(column).padStart(2, "0")}`;
      const existing = db
        .prepare("SELECT id FROM cells WHERE logical_code = ?")
        .get(logicalCode);

      if (existing) {
        continue;
      }

      const controller = controllerRows.find(
        (item) => column >= item.cell_start_column && column <= item.cell_end_column,
      );

      const hardwareChannel = (row - 1) * 9 + (column - controller.cell_start_column) + 1;

      db.prepare(
        `
          INSERT INTO cells (
            logical_code, zone_id, row_number, column_number, controller_id,
            hardware_channel, mapping_status, active, capacity, last_mapped_at, mapped_by
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `,
      ).run(
        logicalCode,
        zoneId,
        row,
        column,
        controller.id,
        hardwareChannel,
        "mapped",
        12,
        nowIso(),
        admin.id,
      );
    }
  }
}

function seedProducts(db) {
  const samples = [
    {
      sku: "SKU-SHOE-001",
      name: "Combat Boots",
      brand: "Frontline",
      category: "Footwear",
      variant: "Size 9",
      unit: "pairs",
      description: "Standard issue combat boots",
      itemsPerCell: 3,
    },
    {
      sku: "SKU-TEE-002",
      name: "Field Uniform Shirt",
      brand: "Frontline",
      category: "Uniform",
      variant: "Large",
      unit: "pieces",
      description: "Olive green field duty shirt",
      itemsPerCell: 5,
    },
    {
      sku: "SKU-BOX-003",
      name: "Field Supply Crate",
      brand: "Quartermaster",
      category: "Storage",
      variant: "Medium",
      unit: "crates",
      description: "Reusable supply crate for field loads",
      itemsPerCell: 4,
    },
    {
      sku: "ARMY-HELM-004",
      name: "Ballistic Helmet",
      brand: "Aegis",
      category: "Protective Gear",
      variant: "Standard",
      unit: "pieces",
      description: "Protective combat helmet",
      itemsPerCell: 4,
    },
    {
      sku: "ARMY-GLOV-005",
      name: "Tactical Gloves",
      brand: "Aegis",
      category: "Protective Gear",
      variant: "Medium",
      unit: "pairs",
      description: "Grip gloves for field operations",
      itemsPerCell: 6,
    },
    {
      sku: "ARMY-MED-006",
      name: "First Aid Pouch",
      brand: "Medicore",
      category: "Medical",
      variant: "Standard",
      unit: "kits",
      description: "Individual emergency medical pouch",
      itemsPerCell: 6,
    },
    {
      sku: "ARMY-RAT-007",
      name: "MRE Pack",
      brand: "FieldMeal",
      category: "Rations",
      variant: "24-hour",
      unit: "packs",
      description: "Meal ready-to-eat ration pack",
      itemsPerCell: 8,
    },
    {
      sku: "ARMY-CANT-008",
      name: "Canteen",
      brand: "Hydra",
      category: "Hydration",
      variant: "1L",
      unit: "pieces",
      description: "Issued water canteen",
      itemsPerCell: 6,
    },
    {
      sku: "ARMY-BATT-009",
      name: "Radio Battery",
      brand: "SignalCore",
      category: "Electronics",
      variant: "Long-life",
      unit: "packs",
      description: "Rechargeable radio battery pack",
      itemsPerCell: 10,
    },
    {
      sku: "ARMY-LAMP-010",
      name: "Tactical Flashlight",
      brand: "SignalCore",
      category: "Electronics",
      variant: "Compact",
      unit: "pieces",
      description: "Compact field flashlight",
      itemsPerCell: 6,
    },
    {
      sku: "ARMY-PON-011",
      name: "Rain Poncho",
      brand: "Frontline",
      category: "Weather Gear",
      variant: "Universal",
      unit: "pieces",
      description: "Waterproof field poncho",
      itemsPerCell: 5,
    },
    {
      sku: "ARMY-NET-012",
      name: "Camouflage Net Pack",
      brand: "FieldCover",
      category: "Camouflage",
      variant: "Small",
      unit: "packs",
      description: "Folded camouflage net kit",
      itemsPerCell: 2,
    },
    {
      sku: "ARMY-ROPE-013",
      name: "Rope Bundle",
      brand: "FieldCover",
      category: "Utility",
      variant: "20m",
      unit: "bundles",
      description: "General utility rope bundle",
      itemsPerCell: 5,
    },
    {
      sku: "ARMY-TOOL-014",
      name: "Entrenching Tool",
      brand: "IronCamp",
      category: "Utility",
      variant: "Foldable",
      unit: "pieces",
      description: "Foldable field digging tool",
      itemsPerCell: 3,
    },
    {
      sku: "ARMY-BAND-015",
      name: "Bandage Roll",
      brand: "Medicore",
      category: "Medical",
      variant: "Large",
      unit: "rolls",
      description: "Wrapped medical bandage roll",
      itemsPerCell: 12,
    },
    {
      sku: "ARMY-FLAR-016",
      name: "Signal Flare Kit",
      brand: "SkyMark",
      category: "Signal",
      variant: "Red",
      unit: "kits",
      description: "Emergency signal flare kit",
      itemsPerCell: 4,
    },
    {
      sku: "ARMY-PURE-017",
      name: "Water Purification Tablet Tin",
      brand: "Hydra",
      category: "Hydration",
      variant: "50 tabs",
      unit: "tins",
      description: "Portable water purification tablets",
      itemsPerCell: 10,
    },
    {
      sku: "ARMY-COMP-018",
      name: "Compass",
      brand: "Pathfinder",
      category: "Navigation",
      variant: "Lensatic",
      unit: "pieces",
      description: "Field navigation compass",
      itemsPerCell: 6,
    },
    {
      sku: "ARMY-BINO-019",
      name: "Binocular Case",
      brand: "Pathfinder",
      category: "Navigation",
      variant: "8x40",
      unit: "cases",
      description: "Protective binocular carry case",
      itemsPerCell: 3,
    },
    {
      sku: "ARMY-CLEAN-020",
      name: "Weapon Cleaning Kit",
      brand: "IronCamp",
      category: "Maintenance",
      variant: "Rifle",
      unit: "kits",
      description: "Field rifle cleaning kit",
      itemsPerCell: 5,
    },
    {
      sku: "ARMY-COVER-021",
      name: "Rain Cover",
      brand: "FieldCover",
      category: "Weather Gear",
      variant: "Pack cover",
      unit: "pieces",
      description: "Waterproof backpack cover",
      itemsPerCell: 8,
    },
    {
      sku: "ARMY-NOTE-022",
      name: "Field Notebook",
      brand: "Quartermaster",
      category: "Stationery",
      variant: "Pocket",
      unit: "books",
      description: "Pocket notebook for field notes",
      itemsPerCell: 12,
    },
    {
      sku: "ARMY-AMMO-023",
      name: "5.56 Ammo Crate",
      brand: "Quartermaster",
      category: "Ammunition",
      variant: "Training",
      unit: "crates",
      description: "Training ammunition crate",
      itemsPerCell: 3,
    },
    {
      sku: "ARMY-AMMO-024",
      name: "9mm Ammo Case",
      brand: "Quartermaster",
      category: "Ammunition",
      variant: "Training",
      unit: "cases",
      description: "Training sidearm ammunition case",
      itemsPerCell: 4,
    },
    {
      sku: "ARMY-SLEEP-025",
      name: "Sleeping Mat",
      brand: "CampBase",
      category: "Field Gear",
      variant: "Roll-up",
      unit: "pieces",
      description: "Roll-up sleeping mat",
      itemsPerCell: 4,
    },
  ];

  for (const sample of samples) {
    const existing = db
      .prepare("SELECT id FROM products WHERE sku = ?")
      .get(sample.sku);

    if (existing) {
      continue;
    }

    db.prepare(
      `
        INSERT INTO products (
          sku, name, brand, category, variant, unit_of_measure, description, items_per_cell, active, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `,
    ).run(
      sample.sku,
      sample.name,
      sample.brand,
      sample.category,
      sample.variant,
      sample.unit,
      sample.description,
      sample.itemsPerCell,
      nowIso(),
    );
  }
}

const LEGACY_DEMO_INVENTORY_CLEANUP_KEY = "legacy_demo_inventory_cleanup_v2_at";
const DEMO_INVENTORY_SEEDS = [
  { sku: "SKU-SHOE-001", cell: "Z1-R1-C01", qty: 3 },
  { sku: "SKU-SHOE-001", cell: "Z1-R1-C02", qty: 3 },
  { sku: "SKU-SHOE-001", cell: "Z1-R1-C03", qty: 2 },
  { sku: "SKU-TEE-002", cell: "Z1-R1-C04", qty: 6 },
  { sku: "SKU-TEE-002", cell: "Z1-R1-C05", qty: 4 },
  { sku: "ARMY-AMMO-023", cell: "Z1-R1-C06", qty: 5 },
  { sku: "ARMY-AMMO-024", cell: "Z1-R1-C07", qty: 6 },
  { sku: "ARMY-HELM-004", cell: "Z1-R1-C08", qty: 4 },
  { sku: "ARMY-GLOV-005", cell: "Z1-R1-C09", qty: 7 },
  { sku: "ARMY-MED-006", cell: "Z1-R1-C10", qty: 8 },
  { sku: "ARMY-RAT-007", cell: "Z1-R1-C11", qty: 10 },
  { sku: "ARMY-CANT-008", cell: "Z1-R1-C12", qty: 9 },
  { sku: "ARMY-BATT-009", cell: "Z1-R1-C13", qty: 11 },
  { sku: "ARMY-LAMP-010", cell: "Z1-R1-C14", qty: 6 },
  { sku: "ARMY-PON-011", cell: "Z1-R1-C15", qty: 5 },
  { sku: "ARMY-NET-012", cell: "Z1-R1-C16", qty: 2 },
  { sku: "ARMY-ROPE-013", cell: "Z1-R1-C17", qty: 7 },
  { sku: "ARMY-TOOL-014", cell: "Z1-R1-C18", qty: 3 },
  { sku: "ARMY-BAND-015", cell: "Z1-R1-C19", qty: 12 },
  { sku: "ARMY-FLAR-016", cell: "Z1-R1-C20", qty: 4 },
  { sku: "ARMY-PURE-017", cell: "Z1-R1-C21", qty: 10 },
  { sku: "ARMY-COMP-018", cell: "Z1-R1-C22", qty: 6 },
  { sku: "ARMY-BINO-019", cell: "Z1-R1-C23", qty: 3 },
  { sku: "ARMY-CLEAN-020", cell: "Z1-R1-C24", qty: 5 },
  { sku: "ARMY-COVER-021", cell: "Z1-R1-C25", qty: 8 },
  { sku: "ARMY-NOTE-022", cell: "Z1-R1-C26", qty: 9 },
  { sku: "SKU-BOX-003", cell: "Z1-R1-C27", qty: 8 },
  { sku: "ARMY-SLEEP-025", cell: "Z1-R2-C01", qty: 4 },
  { sku: "ARMY-RAT-007", cell: "Z1-R2-C02", qty: 9 },
  { sku: "ARMY-CANT-008", cell: "Z1-R2-C03", qty: 7 },
  { sku: "ARMY-MED-006", cell: "Z1-R2-C04", qty: 5 },
  { sku: "ARMY-GLOV-005", cell: "Z1-R2-C05", qty: 6 },
  { sku: "ARMY-CLEAN-020", cell: "Z1-R2-C06", qty: 4 },
];

function demoInventorySeedRows(db) {
  const productRows = db
    .prepare("SELECT id, sku FROM products ORDER BY id")
    .all();
  const cellRows = db
    .prepare("SELECT id, logical_code FROM cells ORDER BY row_number, column_number")
    .all();

  return DEMO_INVENTORY_SEEDS.map((seed) => ({
    ...seed,
    product: productRows.find((item) => item.sku === seed.sku) || null,
    cell: cellRows.find((item) => item.logical_code === seed.cell) || null,
  })).filter((seed) => seed.product && seed.cell);
}

function seedInventory(db) {
  for (const seed of demoInventorySeedRows(db)) {
    const existing = db
      .prepare("SELECT id FROM inventory_balances WHERE product_id = ? AND cell_id = ?")
      .get(seed.product.id, seed.cell.id);

    if (!existing) {
      db.prepare(
        `
          INSERT INTO inventory_balances (product_id, cell_id, available_quantity, reserved_quantity)
          VALUES (?, ?, ?, 0)
        `,
      ).run(seed.product.id, seed.cell.id, seed.qty);
    }
  }
}

function cleanupLegacyDemoInventory(db) {
  const alreadyRan = db
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get(LEGACY_DEMO_INVENTORY_CLEANUP_KEY);
  if (alreadyRan) {
    return;
  }

  for (const seed of demoInventorySeedRows(db)) {
    db.prepare(
      `
        DELETE FROM inventory_balances
        WHERE product_id = ?
          AND cell_id = ?
          AND reserved_quantity = 0
          AND NOT EXISTS (
            SELECT 1 FROM transactions WHERE product_id = ? AND cell_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM task_lines WHERE product_id = ? AND cell_id = ?
          )
      `,
    ).run(
      seed.product.id,
      seed.cell.id,
      seed.product.id,
      seed.cell.id,
      seed.product.id,
      seed.cell.id,
    );
  }

  db.prepare(
    `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(LEGACY_DEMO_INVENTORY_CLEANUP_KEY, nowIso(), nowIso());
}

function initializeSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registration_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_value TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator')),
      status TEXT NOT NULL CHECK(status IN ('active', 'used', 'revoked', 'expired')),
      usage_policy TEXT NOT NULL DEFAULT 'single_use' CHECK(usage_policy IN ('single_use', 'global')),
      usage_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by INTEGER REFERENCES users(id),
      used_by INTEGER REFERENCES users(id),
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      category TEXT,
      variant TEXT,
      unit_of_measure TEXT NOT NULL,
      description TEXT,
      items_per_cell REAL NOT NULL DEFAULT 12,
      active INTEGER NOT NULL DEFAULT 1,
      preferred_storage_strategy TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS controllers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id INTEGER NOT NULL REFERENCES zones(id),
      controller_code TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      firmware_version TEXT,
      heartbeat_status TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT,
      cell_start_column INTEGER NOT NULL,
      cell_end_column INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS cells (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logical_code TEXT NOT NULL UNIQUE,
      zone_id INTEGER NOT NULL REFERENCES zones(id),
      row_number INTEGER NOT NULL,
      column_number INTEGER NOT NULL,
      controller_id INTEGER REFERENCES controllers(id),
      hardware_channel INTEGER,
      mapping_status TEXT NOT NULL DEFAULT 'unmapped',
      active INTEGER NOT NULL DEFAULT 1,
      capacity REAL NOT NULL DEFAULT 12,
      last_mapped_at TEXT,
      mapped_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      cell_id INTEGER NOT NULL REFERENCES cells(id),
      available_quantity REAL NOT NULL DEFAULT 0,
      reserved_quantity REAL NOT NULL DEFAULT 0,
      UNIQUE(product_id, cell_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('pick', 'put', 'adjustment')),
      status TEXT NOT NULL CHECK(status IN ('planned', 'in_progress', 'pending_review', 'completed', 'cancelled')),
      summary TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      started_at TEXT NOT NULL,
      last_touched_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      cell_id INTEGER NOT NULL REFERENCES cells(id),
      planned_quantity REAL NOT NULL,
      actual_quantity REAL NOT NULL DEFAULT 0,
      exception_quantity REAL NOT NULL DEFAULT 0,
      guidance_color TEXT NOT NULL,
      physical_confirmed_at TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('pick', 'put', 'adjustment')),
      product_id INTEGER NOT NULL REFERENCES products(id),
      cell_id INTEGER NOT NULL REFERENCES cells(id),
      quantity_delta REAL NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      task_id INTEGER REFERENCES tasks(id),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_unit_conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      from_unit TEXT NOT NULL,
      to_unit TEXT NOT NULL,
      factor REAL NOT NULL CHECK(factor > 0),
      precision_digits INTEGER NOT NULL DEFAULT 3 CHECK(precision_digits BETWEEN 0 AND 8),
      preview_token TEXT NOT NULL UNIQUE,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      controller_id INTEGER REFERENCES controllers(id),
      cell_id INTEGER REFERENCES cells(id),
      task_id INTEGER REFERENCES tasks(id),
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submission_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      task_id INTEGER REFERENCES tasks(id),
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      used_at TEXT,
      used_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_field_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_key TEXT NOT NULL UNIQUE,
      source_column TEXT UNIQUE,
      label TEXT NOT NULL,
      data_type TEXT NOT NULL CHECK(data_type IN ('text', 'number', 'date', 'boolean', 'select')),
      field_kind TEXT NOT NULL CHECK(field_kind IN ('core', 'custom')),
      system_role TEXT UNIQUE,
      required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
      searchable INTEGER NOT NULL DEFAULT 0 CHECK(searchable IN (0, 1)),
      filterable INTEGER NOT NULL DEFAULT 0 CHECK(filterable IN (0, 1)),
      reportable INTEGER NOT NULL DEFAULT 1 CHECK(reportable IN (0, 1)),
      visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0, 1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      options_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (field_kind = 'core' AND source_column IS NOT NULL AND system_role IS NOT NULL)
        OR (field_kind = 'custom' AND source_column IS NULL AND system_role IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS product_attribute_values (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      field_definition_id INTEGER NOT NULL REFERENCES product_field_definitions(id) ON DELETE CASCADE,
      value_text TEXT,
      value_number REAL,
      value_date TEXT,
      value_boolean INTEGER CHECK(value_boolean IN (0, 1)),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(product_id, field_definition_id),
      CHECK(
        (value_text IS NOT NULL) +
        (value_number IS NOT NULL) +
        (value_date IS NOT NULL) +
        (value_boolean IS NOT NULL) = 1
      )
    );

    CREATE TABLE IF NOT EXISTS report_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stable_key TEXT UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      definition_type TEXT NOT NULL CHECK(definition_type IN ('built_in', 'custom')),
      recipe_json TEXT NOT NULL,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL CHECK(visibility IN ('private', 'shared')),
      is_locked INTEGER NOT NULL DEFAULT 0 CHECK(is_locked IN (0, 1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (definition_type = 'built_in' AND owner_user_id IS NULL AND visibility = 'shared' AND is_locked = 1)
        OR (definition_type = 'custom' AND owner_user_id IS NOT NULL AND is_locked = 0)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_balances_product ON inventory_balances(product_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_balances_cell ON inventory_balances(cell_id);
    CREATE INDEX IF NOT EXISTS idx_task_lines_task ON task_lines(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_lines_product ON task_lines(product_id);
    CREATE INDEX IF NOT EXISTS idx_task_lines_cell ON task_lines(cell_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_touched ON tasks(status, last_touched_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_by_id ON tasks(created_by, id);
    CREATE INDEX IF NOT EXISTS idx_tasks_completed_started ON tasks(completed_at, started_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_product_created ON transactions(product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_task ON transactions(task_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_type_created ON transactions(type, created_at);
    CREATE INDEX IF NOT EXISTS idx_device_events_created_at ON device_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_device_events_task ON device_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_device_events_cell ON device_events(cell_id);
    CREATE INDEX IF NOT EXISTS idx_device_events_type_created ON device_events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_system_events_type_created ON system_events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_submission_tokens_scope_task ON submission_tokens(scope, task_id, used_at);
    CREATE INDEX IF NOT EXISTS idx_products_active_name ON products(active, name);
    CREATE INDEX IF NOT EXISTS idx_product_fields_active_order ON product_field_definitions(active, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_product_fields_reportable ON product_field_definitions(reportable, active, field_key);
    CREATE INDEX IF NOT EXISTS idx_product_attribute_values_field ON product_attribute_values(field_definition_id, product_id);
    CREATE INDEX IF NOT EXISTS idx_report_definitions_owner ON report_definitions(owner_user_id, active, updated_at);
    CREATE INDEX IF NOT EXISTS idx_report_definitions_visibility ON report_definitions(visibility, active, name);
    CREATE INDEX IF NOT EXISTS idx_product_unit_conversions_product ON product_unit_conversions(product_id, created_at);
  `);

  seedReportingFoundation(db);

  ensureColumn(db, "products", "items_per_cell", "REAL NOT NULL DEFAULT 12");
  ensureColumn(db, "controllers", "device_identity", "TEXT");
  ensureColumn(db, "controllers", "module_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "controllers", "configured_at", "TEXT");
  ensureColumn(db, "controllers", "configured_by", "INTEGER REFERENCES users(id)");
  ensureColumn(db, "users", "last_active_at", "TEXT");
  ensureColumn(db, "registration_keys", "usage_policy", "TEXT NOT NULL DEFAULT 'single_use'");
  ensureColumn(db, "registration_keys", "usage_count", "INTEGER NOT NULL DEFAULT 0");
  db.prepare(
    `
      UPDATE registration_keys
      SET usage_count = 1
      WHERE status = 'used'
        AND used_by IS NOT NULL
        AND usage_count = 0
    `,
  ).run();
  ensureColumn(db, "tasks", "last_touched_at", "TEXT");
  ensureColumn(db, "task_lines", "unit_of_measure", "TEXT");
  ensureColumn(db, "transactions", "unit_of_measure", "TEXT");
  db.exec(`
    UPDATE task_lines
    SET unit_of_measure = (
      SELECT p.unit_of_measure FROM products p WHERE p.id = task_lines.product_id
    )
    WHERE unit_of_measure IS NULL;

    UPDATE transactions
    SET unit_of_measure = (
      SELECT p.unit_of_measure FROM products p WHERE p.id = transactions.product_id
    )
    WHERE unit_of_measure IS NULL;

    CREATE TRIGGER IF NOT EXISTS trg_task_lines_unit_snapshot
    AFTER INSERT ON task_lines
    WHEN NEW.unit_of_measure IS NULL
    BEGIN
      UPDATE task_lines
      SET unit_of_measure = (
        SELECT p.unit_of_measure FROM products p WHERE p.id = NEW.product_id
      )
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_transactions_unit_snapshot
    AFTER INSERT ON transactions
    WHEN NEW.unit_of_measure IS NULL
    BEGIN
      UPDATE transactions
      SET unit_of_measure = (
        SELECT p.unit_of_measure FROM products p WHERE p.id = NEW.product_id
      )
      WHERE id = NEW.id;
    END;
  `);
  db.prepare(
    `
      UPDATE tasks
      SET last_touched_at = COALESCE(last_touched_at, completed_at, started_at)
      WHERE last_touched_at IS NULL
    `,
  ).run();
  db.prepare(
    `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES ('schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(APP_SCHEMA_VERSION, nowIso());
}

export function withTransaction(db, callback) {
  db.exec("BEGIN");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createDatabase(authHelpers) {
  ensureDirectory(dirname(DB_PATH));
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
  initializeSchema(db);
  db.prepare("UPDATE inventory_balances SET reserved_quantity = 0 WHERE reserved_quantity != 0").run();
  db.prepare(
    `
      DELETE FROM submission_tokens
      WHERE used_at IS NOT NULL OR created_at < ?
    `,
  ).run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
  seedUsers(db, authHelpers);
  if (authHelpers.allowDevAuthSeeds !== false) {
    seedRegistrationKeys(db);
  }
  seedWarehouse(db);
  seedProducts(db);
  if (authHelpers.allowDemoInventorySeed === false) {
    cleanupLegacyDemoInventory(db);
  } else {
    seedInventory(db);
  }
  return db;
}
