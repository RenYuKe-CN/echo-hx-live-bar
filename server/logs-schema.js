export function migrateAuditLogs(database) {
  database.transaction(()=>{
    if(!database.prepare('PRAGMA table_info(operation_logs)').all().some(column=>column.name==='entry_key')) {
      database.exec("ALTER TABLE operation_logs ADD COLUMN entry_key TEXT NOT NULL DEFAULT ''; UPDATE operation_logs SET entry_key=lower(hex(randomblob(16)));");
    }
    database.exec(`
    CREATE TRIGGER IF NOT EXISTS operation_log_identity AFTER INSERT ON operation_logs
      BEGIN UPDATE operation_logs SET entry_key=lower(hex(randomblob(16))) WHERE id=NEW.id; END;
    CREATE INDEX IF NOT EXISTS operation_logs_time_id ON operation_logs(datetime(created_at),id);
    CREATE TABLE IF NOT EXISTS log_export_batches (
      id TEXT PRIMARY KEY,operator_id INTEGER NOT NULL,filename TEXT NOT NULL,
      filters_json TEXT NOT NULL,entries_json TEXT NOT NULL,row_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','cleaned')),
      deleted_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,cleaned_at TEXT
    );
    CREATE INDEX IF NOT EXISTS log_export_expiry ON log_export_batches(expires_at);
    `);
  })();
}
