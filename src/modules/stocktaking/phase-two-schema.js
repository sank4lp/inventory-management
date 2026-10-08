export function migratePhaseTwo(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS display_requests (
      id TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, fingerprint TEXT NOT NULL, scope_json TEXT NOT NULL,
      targets_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS location_setup_sessions (
      id TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, controller_id INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1, output INTEGER, controller_snapshot TEXT NOT NULL,
      skipped_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', display_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_controller_setup ON location_setup_sessions(controller_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS location_setup_events (
      id INTEGER PRIMARY KEY, session_id TEXT, actor_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS location_setup_receipts (
      actor_id INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(actor_id,request_id)
    );
    UPDATE location_labels SET scanned_at=(
      SELECT MAX(e.created_at) FROM location_setup_events e
      WHERE json_valid(e.payload) AND (
        e.event_type='output_physically_verified' AND json_extract(e.payload,'$.token')=location_labels.token
        OR e.event_type='label_replaced' AND json_extract(e.payload,'$.newToken')=location_labels.token
      )
    ) WHERE state='bound' AND scanned_at IS NULL;
  `);
}
