import { randomUUID } from "node:crypto";

// Additive migration: historical tasks keep their original workflow and units.
export function migrateOperations(db) {
  const add = (table, name, definition) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  add("users", "session_version", "INTEGER NOT NULL DEFAULT 1");
  add("tasks", "workflow_version", "INTEGER NOT NULL DEFAULT 1");
  add("tasks", "plan_revision", "INTEGER NOT NULL DEFAULT 1");
  add("tasks", "attention", "INTEGER NOT NULL DEFAULT 0");
  add("task_lines", "revision", "INTEGER NOT NULL DEFAULT 1");
  add("task_lines", "execution_state", "TEXT NOT NULL DEFAULT 'legacy'");
  add("task_lines", "device_id", "TEXT");
  add("task_lines", "started_at", "TEXT");
  add("cells", "guidance_mode", "TEXT NOT NULL DEFAULT 'exclusive'");
  add("cells", "label_id", "TEXT");
  add("cells", "label_revision", "INTEGER NOT NULL DEFAULT 1");
  add("transactions", "task_line_id", "INTEGER REFERENCES task_lines(id)");
  add("transactions", "origin_ref", "TEXT");
  add("transactions", "performed_by", "INTEGER REFERENCES users(id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_receipts (
      actor_id INTEGER NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(actor_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS work_reservations (
      line_id INTEGER PRIMARY KEY REFERENCES task_lines(id), kind TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity >= 0), state TEXT NOT NULL DEFAULT 'held'
    );
    CREATE TABLE IF NOT EXISTS work_reports (
      id TEXT PRIMARY KEY, origin_ref TEXT NOT NULL, line_id INTEGER REFERENCES task_lines(id),
      product_id INTEGER NOT NULL REFERENCES products(id), cell_id INTEGER NOT NULL REFERENCES cells(id),
      direction TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity >= 0), unit TEXT NOT NULL,
      performer_id INTEGER REFERENCES users(id), reporter_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL, reason TEXT, payload TEXT NOT NULL, occurred_at TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT, resolver_id INTEGER REFERENCES users(id), verification TEXT
    );
    CREATE INDEX IF NOT EXISTS work_reports_origin ON work_reports(origin_ref);
    CREATE INDEX IF NOT EXISTS work_reports_status ON work_reports(status, created_at);
    CREATE TABLE IF NOT EXISTS work_settlements (
      line_id INTEGER PRIMARY KEY REFERENCES task_lines(id), report_id TEXT NOT NULL REFERENCES work_reports(id),
      quantity REAL NOT NULL, cell_id INTEGER NOT NULL, unit TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, line_id INTEGER REFERENCES task_lines(id), report_id TEXT,
      actor_id INTEGER REFERENCES users(id), event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cell_turns (
      cell_id INTEGER PRIMARY KEY REFERENCES cells(id), line_id INTEGER NOT NULL UNIQUE REFERENCES task_lines(id),
      actor_id INTEGER NOT NULL REFERENCES users(id), device_id TEXT NOT NULL, generation TEXT NOT NULL,
      uncertain INTEGER NOT NULL DEFAULT 0, acquired_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_guidance (
      cell_id INTEGER PRIMARY KEY REFERENCES cells(id), generation TEXT NOT NULL, desired TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_discrepancies (
      cell_id INTEGER NOT NULL REFERENCES cells(id), product_id INTEGER NOT NULL REFERENCES products(id),
      reason TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(cell_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS work_origins (
      origin_ref TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES work_reports(id)
    );
  `);
  add("work_reports", "quantity_known", "INTEGER NOT NULL DEFAULT 1");
  db.exec(`CREATE TRIGGER IF NOT EXISTS revoke_user_sessions AFTER UPDATE OF status ON users
    WHEN OLD.status != NEW.status BEGIN UPDATE users SET session_version=session_version+1 WHERE id=NEW.id; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS work_label_new AFTER INSERT ON cells WHEN NEW.label_id IS NULL
    BEGIN UPDATE cells SET label_id=lower(hex(randomblob(16))) WHERE id=NEW.id; END;`);
  for (const cell of db.prepare("SELECT id FROM cells WHERE label_id IS NULL").all()) {
    db.prepare("UPDATE cells SET label_id = ? WHERE id = ?").run(randomUUID(), cell.id);
  }
  adoptPendingLegacyTasks(db);
  for (const key of ["warehouse_identity", "dataset_generation"]) {
    db.prepare("INSERT OR IGNORE INTO app_metadata(key,value,updated_at) VALUES(?,?,?)")
      .run(key, randomUUID(), new Date().toISOString());
  }
}

export function adoptPendingLegacyTasks(db) {
  // Carry pre-release unfinished plans into explicit verification instead of replaying them.
  for(const task of db.prepare("SELECT id,type FROM tasks WHERE workflow_version=1 AND status='pending_review'").all()) {
    db.prepare("UPDATE tasks SET workflow_version=2,attention=0 WHERE id=?").run(task.id);
    for(const l of db.prepare("SELECT * FROM task_lines WHERE task_id=?").all(task.id)) {
      db.prepare("UPDATE task_lines SET execution_state='ready' WHERE id=?").run(l.id);
      db.prepare("INSERT OR IGNORE INTO work_reservations(line_id,kind,quantity) VALUES(?,?,?)").run(l.id,task.type,l.planned_quantity);
    }
  }
  db.exec(`UPDATE inventory_balances SET reserved_quantity=COALESCE((SELECT SUM(r.quantity) FROM work_reservations r JOIN task_lines l ON l.id=r.line_id WHERE r.state='held' AND r.kind='pick' AND l.product_id=inventory_balances.product_id AND l.cell_id=inventory_balances.cell_id),0)`);
}
