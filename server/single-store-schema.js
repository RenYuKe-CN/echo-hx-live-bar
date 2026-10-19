export function migrateSingleStore(database) {
  const add = (table, name, definition) => {
    if (database.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) return false;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    return true;
  };
  database.transaction(() => {
    if (add('order_items', 'cancelled_quantity', 'INTEGER NOT NULL DEFAULT 0')) {
      database.exec('UPDATE order_items SET cancelled_quantity=MIN(returned_quantity,MAX(0,quantity-delivered_quantity))');
    }
    add('order_items','returned_delivered_quantity','INTEGER NOT NULL DEFAULT 0 CHECK(returned_delivered_quantity>=0 AND returned_delivered_quantity<=delivered_quantity)');
    add('orders', 'payer_phone_snapshot', "TEXT NOT NULL DEFAULT ''");
    add('orders', 'payer_name_snapshot', "TEXT NOT NULL DEFAULT ''");
    add('orders','payer_identity_captured_at','TEXT');
    add('refund_transactions', 'command_id', 'TEXT');
    add('refund_transactions', 'command_hash', "TEXT NOT NULL DEFAULT ''");
    add('refund_transactions', 'operator_id', 'INTEGER REFERENCES staff_accounts(id)');
    // NULL preserves the already-authorized stock treatment of refunds in flight during upgrade.
    add('refund_transactions', 'stock_plan_json', 'TEXT');
    add('backup_settings', 'mirror_last_at', 'TEXT');
    add('backup_settings', 'mirror_error', "TEXT NOT NULL DEFAULT ''");
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS refund_command_unique ON refund_transactions(command_id) WHERE command_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS login_failures (key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shift_settings (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO shift_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS cash_shifts (
        id INTEGER PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,opened_by INTEGER NOT NULL REFERENCES staff_accounts(id),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','counting','awaiting_accept','closed')),
        opening_cents INTEGER NOT NULL CHECK(opening_cents>=0),actual_cents INTEGER,variance_cents INTEGER,
        note TEXT NOT NULL DEFAULT '',opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,counted_at TEXT,closed_at TEXT,
        accepted_by INTEGER REFERENCES staff_accounts(id),previous_id INTEGER REFERENCES cash_shifts(id),revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS shift_one_active ON cash_shifts((1)) WHERE status!='closed';
      CREATE TABLE IF NOT EXISTS shift_ledger (
        id INTEGER PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,shift_id INTEGER REFERENCES cash_shifts(id),
        kind TEXT NOT NULL,channel TEXT NOT NULL,amount_cents INTEGER NOT NULL,reference TEXT NOT NULL DEFAULT '',
        operator_id INTEGER REFERENCES staff_accounts(id),note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS shift_ledger_shift ON shift_ledger(shift_id,id);
      CREATE TABLE IF NOT EXISTS table_switch_commands (
        request_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),fingerprint TEXT NOT NULL,
        session_id INTEGER NOT NULL REFERENCES table_sessions(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  })();
}
