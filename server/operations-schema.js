export function migrateOperations(database) {
  database.transaction(() => {
    const add = (table, name, definition) => {
      if (database.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) return false;
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); return true;
    };
    add('staff_accounts', 'workspace', "TEXT NOT NULL DEFAULT 'admin' CHECK(workspace IN ('admin','cashier','waiter'))");
    add('orders', 'preparation_staff_id', 'INTEGER REFERENCES staff_accounts(id)');
    add('orders', 'preparation_started_at', 'TEXT');
    add('orders', 'fulfillment_revision', 'INTEGER NOT NULL DEFAULT 0');
    add('orders', 'fulfillment_pause_reason', "TEXT NOT NULL DEFAULT ''");
    if (add('order_items', 'delivered_quantity', 'INTEGER NOT NULL DEFAULT 0 CHECK(delivered_quantity >= 0 AND delivered_quantity + returned_quantity <= quantity)')) {
      database.exec("UPDATE order_items SET delivered_quantity = quantity - returned_quantity WHERE order_id IN (SELECT id FROM orders WHERE status = 'completed' OR delivered_at IS NOT NULL)");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS fulfillment_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
        preparation_staff_id INTEGER NOT NULL REFERENCES staff_accounts(id), delivery_staff_id INTEGER REFERENCES staff_accounts(id),
        status TEXT NOT NULL CHECK(status IN ('ready','delivering','delivered','cancelled')),
        request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_at TEXT, delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS fulfillment_batch_items (
        batch_id INTEGER NOT NULL REFERENCES fulfillment_batches(id), order_item_id INTEGER NOT NULL REFERENCES order_items(id),
        quantity INTEGER NOT NULL CHECK(quantity > 0), PRIMARY KEY(batch_id, order_item_id)
      );
      CREATE TABLE IF NOT EXISTS service_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES table_sessions(id),
        created_by INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','claimed','completed')),
        assigned_staff_id INTEGER REFERENCES staff_accounts(id), revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, claimed_at TEXT, completed_at TEXT,
        completion_note TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS service_request_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES service_requests(id),
        user_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS service_submit_commands (
        idempotency_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
        request_hash TEXT NOT NULL, request_id INTEGER NOT NULL REFERENCES service_requests(id)
      );
      CREATE TABLE IF NOT EXISTS work_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS service_active_type_unique ON service_requests(session_id,type) WHERE status IN ('waiting','claimed');
      CREATE INDEX IF NOT EXISTS service_status_idx ON service_requests(status,created_at);
      CREATE INDEX IF NOT EXISTS fulfillment_order_status_idx ON fulfillment_batches(order_id,status);
      CREATE INDEX IF NOT EXISTS fulfillment_item_idx ON fulfillment_batch_items(order_item_id);
      CREATE UNIQUE INDEX IF NOT EXISTS work_new_unique ON work_events(kind,entity_id) WHERE kind IN ('order_new','service_new');
      CREATE TABLE IF NOT EXISTS operations_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), service_minutes INTEGER NOT NULL DEFAULT 3,
        preparation_minutes INTEGER NOT NULL DEFAULT 10, delivery_minutes INTEGER NOT NULL DEFAULT 5
      );
      INSERT OR IGNORE INTO operations_settings(id) VALUES(1);
      INSERT OR IGNORE INTO work_events(kind,entity_id) SELECT 'order_new',id FROM orders WHERE payment_status='paid' AND status='awaiting_delivery';
    `);
    if (add('service_requests','call_count','INTEGER NOT NULL DEFAULT 1 CHECK(call_count>0)')) {
      database.exec('UPDATE service_requests SET call_count=MAX(1,(SELECT COUNT(*) FROM service_submit_commands WHERE request_id=service_requests.id))');
      if (database.prepare('PRAGMA index_list(service_request_notes)').all().some(index => index.unique)) {
        database.exec(`CREATE TABLE service_notes_upgrade(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id INTEGER NOT NULL REFERENCES service_requests(id),user_id INTEGER NOT NULL REFERENCES users(id),content TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
          INSERT INTO service_notes_upgrade SELECT * FROM service_request_notes;
          DROP TABLE service_request_notes;
          ALTER TABLE service_notes_upgrade RENAME TO service_request_notes;`);
      }
    }
  })();
}
