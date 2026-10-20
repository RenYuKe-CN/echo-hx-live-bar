export function migrateRefundPermissions(database) {
  database.exec('CREATE TABLE IF NOT EXISTS permission_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  database.transaction(() => {
    const name = 'explicit-refund-permission-v1';
    if (database.prepare('SELECT 1 FROM permission_migrations WHERE name=?').get(name)) return;
    for (const account of database.prepare("SELECT id,permissions FROM staff_accounts WHERE role='manager'").all()) {
      let permissions;
      try { permissions = JSON.parse(account.permissions); } catch { continue; }
      if (Array.isArray(permissions) && permissions.includes('orders') && !permissions.includes('refunds')) {
        database.prepare('UPDATE staff_accounts SET permissions=? WHERE id=?').run(JSON.stringify([...permissions, 'refunds']), account.id);
      }
    }
    database.prepare('INSERT INTO permission_migrations(name) VALUES(?)').run(name);
  })();
}
