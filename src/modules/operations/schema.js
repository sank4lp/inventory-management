import { randomUUID } from "node:crypto";

// Additive migration: historical tasks keep their original workflow and units.
export function migrateOperations(db) {
  const add = (table, name, definition) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) {
      db.exec(`
    CREATE TABLE IF NOT EXISTS work_inactivity_alerts (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id), last_touched_at TEXT NOT NULL, detected_at TEXT NOT NULL
    );ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  add("users", "session_version", "INTEGER NOT NULL DEFAULT 1");
  add("tasks", "workflow_version", "INTEGER NOT NULL DEFAULT 1");
  add("tasks", "plan_revision", "INTEGER NOT NULL DEFAULT 1");
  add("tasks", "review_followup", "INTEGER NOT NULL DEFAULT 0");
  add("tasks", "review_handover_verified", "INTEGER NOT NULL DEFAULT 0");
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
  add("work_reports", "accounting_quantity", "REAL");
  add("work_reports", "accounting_unit", "TEXT");
  add("work_reports", "conversion_evidence", "TEXT");
  db.exec(`CREATE TRIGGER IF NOT EXISTS revoke_user_sessions AFTER UPDATE OF status ON users
    WHEN OLD.status != NEW.status BEGIN UPDATE users SET session_version=session_version+1 WHERE id=NEW.id; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS work_label_new AFTER INSERT ON cells WHEN NEW.label_id IS NULL
    BEGIN UPDATE cells SET label_id=lower(hex(randomblob(16))) WHERE id=NEW.id; END;`);
  for (const cell of db.prepare("SELECT id FROM cells WHERE label_id IS NULL").all()) {
    db.prepare("UPDATE cells SET label_id = ? WHERE id = ?").run(randomUUID(), cell.id);
  }
  migrateWorkflowContracts(db, add);
  db.exec(`CREATE INDEX IF NOT EXISTS work_task_pages ON tasks(workflow_version,assignee_id,outcome,id);
    CREATE INDEX IF NOT EXISTS work_team_pages ON tasks(workflow_version,outcome,due_at,id);
    CREATE INDEX IF NOT EXISTS work_assignment_scope ON task_assignment_events(task_id,assignee_id,previous_assignee);
    CREATE INDEX IF NOT EXISTS work_line_task ON task_lines(task_id,execution_state);
    CREATE INDEX IF NOT EXISTS work_report_line_status ON work_reports(line_id,status);
    CREATE INDEX IF NOT EXISTS work_review_person ON work_reports(status,performer_id,created_at);`);
  adoptPendingLegacyTasks(db);
  for (const key of ["warehouse_identity", "dataset_generation"]) {
    db.prepare("INSERT OR IGNORE INTO app_metadata(key,value,updated_at) VALUES(?,?,?)")
      .run(key, randomUUID(), new Date().toISOString());
  }
}

function migrateWorkflowContracts(db, add) {
  const first = !db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'assignee_id');
  for (const [name, definition] of Object.entries({
    assignee_id:'INTEGER REFERENCES users(id)', assigned_by:'INTEGER REFERENCES users(id)', assigned_at:'TEXT',
    assignment_generation:'INTEGER NOT NULL DEFAULT 1', assignment_state:"TEXT NOT NULL DEFAULT 'legacy'",
    assignment_source:"TEXT NOT NULL DEFAULT 'legacy'", due_at:'TEXT', requested_quantity:'REAL',
    outcome:"TEXT NOT NULL DEFAULT 'open'", instruction_note:'TEXT', stop_requested:'INTEGER NOT NULL DEFAULT 0',
  })) add('tasks', name, definition);
  add('task_lines','instruction_snapshot','TEXT');
  add('task_lines','instruction_owner','INTEGER REFERENCES users(id)');
  add('task_lines','assignment_generation','INTEGER NOT NULL DEFAULT 1');
  add('work_reports','case_revision','INTEGER NOT NULL DEFAULT 1');
  for (const [name, definition] of Object.entries({display_name:'TEXT', travel_instructions:'TEXT',
    description_revision:'INTEGER NOT NULL DEFAULT 1', binding_revision:'INTEGER NOT NULL DEFAULT 1',
    binding_verified_at:'TEXT', binding_verified_by:'INTEGER REFERENCES users(id)'})) add('cells',name,definition);
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_assignment_events (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), actor_id INTEGER NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL, generation INTEGER NOT NULL, previous_assignee INTEGER REFERENCES users(id),
      assignee_id INTEGER REFERENCES users(id), payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_return_acknowledgements (
      return_event_id INTEGER PRIMARY KEY REFERENCES task_assignment_events(id),
      actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_instruction_history (
      line_id INTEGER NOT NULL REFERENCES task_lines(id), revision INTEGER NOT NULL, assignee_id INTEGER REFERENCES users(id),
      assignment_generation INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(line_id,revision)
    );
    CREATE TABLE IF NOT EXISTS location_field_definitions (
      field_key TEXT PRIMARY KEY, label TEXT NOT NULL, field_type TEXT NOT NULL CHECK(field_type IN ('text','number','select')),
      options_json TEXT NOT NULL DEFAULT '[]', required INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0, use_in_directions INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS location_field_values (
      cell_id INTEGER NOT NULL REFERENCES cells(id), field_key TEXT NOT NULL REFERENCES location_field_definitions(field_key),
      value_json TEXT NOT NULL, PRIMARY KEY(cell_id,field_key)
    );
    CREATE TABLE IF NOT EXISTS location_labels (
      token TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, cell_id INTEGER REFERENCES cells(id),
      state TEXT NOT NULL CHECK(state IN ('unbound','bound','revoked')), created_at TEXT NOT NULL,
      bound_at TEXT, bound_by INTEGER REFERENCES users(id), retired_cell_id INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS location_current_label ON location_labels(cell_id) WHERE state='bound';
    INSERT OR IGNORE INTO location_labels(token,revision,cell_id,state,created_at)
      SELECT label_id,label_revision,id,'bound',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM cells WHERE label_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS location_binding_changed AFTER UPDATE OF controller_id,hardware_channel ON cells
      WHEN OLD.controller_id IS NOT NEW.controller_id OR OLD.hardware_channel IS NOT NEW.hardware_channel
      BEGIN UPDATE cells SET binding_revision=binding_revision+1,binding_verified_at=NULL,binding_verified_by=NULL WHERE id=NEW.id; END;
  `);
  add('location_labels','retired_cell_id','INTEGER');
  db.exec(`CREATE TRIGGER IF NOT EXISTS location_label_retired BEFORE DELETE ON cells
    BEGIN UPDATE location_labels SET state='revoked',retired_cell_id=OLD.id,cell_id=NULL WHERE cell_id=OLD.id; END;`);
  db.exec(`UPDATE tasks SET attention=0,outcome='needs_assignment' WHERE assignment_state='returned' AND stop_requested=0
    AND NOT EXISTS(SELECT 1 FROM task_lines l WHERE l.task_id=tasks.id AND l.execution_state IN ('ready','working'))
    AND NOT EXISTS(SELECT 1 FROM work_reports r JOIN task_lines l ON l.id=r.line_id WHERE l.task_id=tasks.id AND r.status IN ('review','received'));`);
  if (first) db.exec(`UPDATE tasks SET assignee_id=created_by,requested_quantity=(SELECT SUM(planned_quantity) FROM task_lines WHERE task_id=tasks.id AND execution_state!='superseded');
    UPDATE task_lines SET instruction_owner=(SELECT created_by FROM tasks WHERE id=task_lines.task_id);`);
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
