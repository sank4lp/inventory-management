export function migrateStocktaking(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stocktake_schedules (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL, frequency TEXT NOT NULL, interval_days INTEGER NOT NULL,
      anchor_day INTEGER NOT NULL, next_due TEXT NOT NULL, timezone TEXT NOT NULL,
      scope_json TEXT NOT NULL, assignee_id INTEGER REFERENCES users(id), updated_by INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stocktake_runs (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, scope_json TEXT NOT NULL, due_date TEXT,
      timezone TEXT NOT NULL, schedule_revision INTEGER, occurrence TEXT UNIQUE,
      created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, started_at TEXT,
      closed_at TEXT, close_reason TEXT, status TEXT NOT NULL DEFAULT 'pending', revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES stocktake_runs(id),
      cell_id INTEGER NOT NULL REFERENCES cells(id), location_json TEXT NOT NULL,
      assignee_id INTEGER REFERENCES users(id), generation INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'pending', latest_observation TEXT, note TEXT,
      UNIQUE(run_id,cell_id)
    );
    CREATE TABLE IF NOT EXISTS stocktake_attempts (
      id TEXT PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES stocktake_items(id),
      counter_id INTEGER NOT NULL REFERENCES users(id), generation INTEGER NOT NULL,
      baseline_json TEXT NOT NULL, started_at TEXT NOT NULL, method TEXT NOT NULL,
      identity_evidence TEXT NOT NULL, observation_id TEXT
    );
    CREATE TABLE IF NOT EXISTS stocktake_observations (
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES stocktake_attempts(id),
      item_id INTEGER NOT NULL REFERENCES stocktake_items(id), counter_id INTEGER NOT NULL REFERENCES users(id),
      lines_json TEXT NOT NULL, unknown_json TEXT NOT NULL, reported_reason TEXT, note TEXT,
      counted_at TEXT, received_at TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      verification TEXT, verified_reason TEXT, reviewer_id INTEGER REFERENCES users(id), reviewed_at TEXT,
      linked_movements TEXT NOT NULL DEFAULT '[]', supersedes TEXT
    );
    CREATE TABLE IF NOT EXISTS stocktake_settlements (
      observation_id TEXT PRIMARY KEY REFERENCES stocktake_observations(id),
      transaction_ids TEXT NOT NULL, actor_id INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stocktake_events (
      id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES stocktake_runs(id), item_id INTEGER REFERENCES stocktake_items(id),
      actor_id INTEGER REFERENCES users(id), event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stocktake_receipts (
      actor_id INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS stocktake_cell_versions (cell_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
    CREATE TRIGGER IF NOT EXISTS stocktake_balance_insert AFTER INSERT ON inventory_balances BEGIN
      INSERT INTO stocktake_cell_versions VALUES(NEW.cell_id,1) ON CONFLICT(cell_id) DO UPDATE SET version=version+1; END;
    CREATE TRIGGER IF NOT EXISTS stocktake_balance_update AFTER UPDATE OF available_quantity,product_id,cell_id ON inventory_balances
      WHEN NEW.available_quantity IS NOT OLD.available_quantity OR NEW.product_id IS NOT OLD.product_id OR NEW.cell_id IS NOT OLD.cell_id BEGIN
      INSERT INTO stocktake_cell_versions VALUES(NEW.cell_id,1) ON CONFLICT(cell_id) DO UPDATE SET version=version+1;
      INSERT INTO stocktake_cell_versions VALUES(OLD.cell_id,1) ON CONFLICT(cell_id) DO UPDATE SET version=version+1; END;
    CREATE TRIGGER IF NOT EXISTS stocktake_balance_delete AFTER DELETE ON inventory_balances BEGIN
      INSERT INTO stocktake_cell_versions VALUES(OLD.cell_id,1) ON CONFLICT(cell_id) DO UPDATE SET version=version+1; END;
    CREATE TABLE IF NOT EXISTS stocktake_condition_reviews (
      id INTEGER PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES stocktake_observations(id), cell_id INTEGER NOT NULL,
      details TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', resolved_by INTEGER, resolved_at TEXT, evidence TEXT
    );
    CREATE INDEX IF NOT EXISTS stocktake_condition_cell ON stocktake_condition_reviews(cell_id,state);
    CREATE TABLE IF NOT EXISTS stocktake_movement_links (
      report_id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES stocktake_observations(id),
      actor_id INTEGER NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL, accounted_delta REAL
    );
  `);
  if(!db.prepare('PRAGMA table_info(stocktake_movement_links)').all().some(c=>c.name==='accounted_delta'))db.exec('ALTER TABLE stocktake_movement_links ADD COLUMN accounted_delta REAL');
}
