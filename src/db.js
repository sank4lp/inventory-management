import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "inventory.db");

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

function seedUsers(db, authHelpers) {
  const { hashPassword } = authHelpers;
  const adminExists = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get("admin");

  if (!adminExists) {
    db.prepare(
      `
        INSERT INTO users (name, username, password_hash, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "System Admin",
      "admin",
      hashPassword("admin123"),
      "admin",
      "active",
      nowIso(),
    );
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
  const row = db
    .prepare("SELECT id FROM registration_keys WHERE key_value = ?")
    .get("INVITE-OP-2026");

  if (!row) {
    const admin = db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("admin");

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
      admin.id,
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
      db.prepare(
        `
          UPDATE products
          SET name = ?, brand = ?, category = ?, variant = ?, unit_of_measure = ?, description = ?, items_per_cell = ?, active = 1
          WHERE sku = ?
        `,
      ).run(
        sample.name,
        sample.brand,
        sample.category,
        sample.variant,
        sample.unit,
        sample.description,
        sample.itemsPerCell,
        sample.sku,
      );
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

function seedInventory(db) {
  const productRows = db
    .prepare("SELECT id, sku FROM products ORDER BY id")
    .all();
  const cellRows = db
    .prepare("SELECT id, logical_code FROM cells ORDER BY row_number, column_number")
    .all();

  const seedPairs = [
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

  for (const seed of seedPairs) {
    const product = productRows.find((item) => item.sku === seed.sku);
    const cell = cellRows.find((item) => item.logical_code === seed.cell);
    const existing = db
      .prepare("SELECT id FROM inventory_balances WHERE product_id = ? AND cell_id = ?")
      .get(product.id, cell.id);

    if (!existing) {
      db.prepare(
        `
          INSERT INTO inventory_balances (product_id, cell_id, available_quantity, reserved_quantity)
          VALUES (?, ?, ?, 0)
        `,
      ).run(product.id, cell.id, seed.qty);
    }
  }
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

    CREATE TABLE IF NOT EXISTS device_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      controller_id INTEGER REFERENCES controllers(id),
      cell_id INTEGER REFERENCES cells(id),
      task_id INTEGER REFERENCES tasks(id),
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_balances_product ON inventory_balances(product_id);
    CREATE INDEX IF NOT EXISTS idx_task_lines_task ON task_lines(task_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_device_events_created_at ON device_events(created_at);
  `);

  ensureColumn(db, "products", "items_per_cell", "REAL NOT NULL DEFAULT 12");
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
  initializeSchema(db);
  db.prepare("UPDATE inventory_balances SET reserved_quantity = 0 WHERE reserved_quantity != 0").run();
  seedUsers(db, authHelpers);
  seedRegistrationKeys(db);
  seedWarehouse(db);
  seedProducts(db);
  seedInventory(db);
  return db;
}
