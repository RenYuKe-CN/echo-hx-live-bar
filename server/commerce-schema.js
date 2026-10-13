export function migrateCommerce(database) {
  const add=(table,name,definition)=>{if(!database.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===name))database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);};
  add('table_sessions','bill_no','TEXT');
  add('table_sessions','table_no_snapshot',"TEXT NOT NULL DEFAULT ''");
  add('table_sessions','store_name_snapshot',"TEXT NOT NULL DEFAULT ''");
  add('refund_transactions','returned_cost_cents','INTEGER');
  add('group_buy_redemptions','actual_settlement_at','TEXT');
  add('wallet_transactions','payment_channel',"TEXT NOT NULL DEFAULT 'unknown'");
  add('order_items','unit_snapshot',"TEXT NOT NULL DEFAULT ''");
  add('inventory_logs','unit_snapshot',"TEXT NOT NULL DEFAULT ''");
  database.exec(`
    CREATE TABLE IF NOT EXISTS commerce_settings (id INTEGER PRIMARY KEY CHECK(id=1),timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',open_time TEXT NOT NULL DEFAULT '12:00',close_time TEXT NOT NULL DEFAULT '06:00',export_title TEXT NOT NULL DEFAULT '营业明细');
    INSERT OR IGNORE INTO commerce_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS receipt_templates (id INTEGER PRIMARY KEY CHECK(id=1),settings_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT OR IGNORE INTO receipt_templates(id,settings_json) VALUES(1,'{}');
    CREATE TABLE IF NOT EXISTS receipt_printers (id INTEGER PRIMARY KEY,name TEXT NOT NULL,sn TEXT NOT NULL UNIQUE,device_key TEXT NOT NULL DEFAULT '',paper_width INTEGER NOT NULL DEFAULT 58,has_cutter INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',bound INTEGER NOT NULL DEFAULT 0,logo_url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS bill_snapshots (session_id INTEGER PRIMARY KEY REFERENCES table_sessions(id) ON DELETE CASCADE,snapshot_json TEXT NOT NULL,revision TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS print_jobs (id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,printer_id INTEGER NOT NULL REFERENCES receipt_printers(id),scope TEXT NOT NULL,target_id INTEGER NOT NULL,snapshot_json TEXT NOT NULL,content_json TEXT NOT NULL,provider_account TEXT NOT NULL,provider_region TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',reprint_of TEXT REFERENCES print_jobs(id),operator_id INTEGER REFERENCES staff_accounts(id),error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS print_parts (job_id TEXT NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,part_no INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',provider_order_id TEXT,PRIMARY KEY(job_id,part_no));
    CREATE TABLE IF NOT EXISTS group_buy_settlements (id INTEGER PRIMARY KEY,redemption_id TEXT NOT NULL REFERENCES group_buy_redemptions(id) ON DELETE CASCADE,request_id TEXT UNIQUE,amount_cents INTEGER NOT NULL,settled_at TEXT NOT NULL,operator_id INTEGER REFERENCES staff_accounts(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS print_jobs_state_time ON print_jobs(state,created_at);
    CREATE INDEX IF NOT EXISTS group_buy_settlements_time ON group_buy_settlements(settled_at);
    UPDATE print_parts SET state='unknown' WHERE state='sending';
    UPDATE print_jobs SET state='unknown',error='打印请求中断，请核对设备出纸情况' WHERE state='sending';
    UPDATE table_sessions SET bill_no='B'||printf('%010d',id) WHERE bill_no IS NULL;
    UPDATE table_sessions SET table_no_snapshot=COALESCE((SELECT table_no FROM tables WHERE id=table_sessions.table_id),'') WHERE table_no_snapshot='';
    UPDATE table_sessions SET store_name_snapshot=COALESCE((SELECT name FROM stores WHERE id=table_sessions.store_id),'') WHERE store_name_snapshot='';
    CREATE UNIQUE INDEX IF NOT EXISTS table_sessions_bill_unique ON table_sessions(bill_no);
  `);
  add('receipt_printers','bound_user',"TEXT NOT NULL DEFAULT ''");
  add('receipt_printers','bound_region',"TEXT NOT NULL DEFAULT ''");
  add('print_parts','expires_at','INTEGER');
  add('group_buy_settlements','target_total_cents','INTEGER');
  // Legacy cost recovery is limited to evidence that can be attributed exactly.
  // Ambiguous historical returns stay NULL rather than silently becoming zero.
  for(const order of database.prepare("SELECT DISTINCT o.id FROM orders o JOIN refund_transactions r ON r.order_id=o.id WHERE r.status='success' AND r.returned_cost_cents IS NULL").all()) {
    const refunds=database.prepare("SELECT * FROM refund_transactions WHERE order_id=? AND status='success' ORDER BY id").all(order.id);
    const items=database.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
    if(refunds.length===1) {
      const name=database.prepare('SELECT order_no FROM orders WHERE id=?').get(order.id).order_no;
      const logged=database.prepare("SELECT product_id,SUM(change_quantity) AS quantity FROM inventory_logs WHERE change_quantity>0 AND (order_id=? AND channel='refund' OR order_id IS NULL AND reason=?) GROUP BY product_id").all(order.id,'订单退款 '+name);
      const returned=new Map();for(const item of items)returned.set(item.product_id,(returned.get(item.product_id)||0)+item.returned_quantity);
      if(items.every(i=>i.returned_quantity===0)||[...returned].every(([id,qty])=>(logged.find(l=>l.product_id===id)?.quantity||0)===qty))database.prepare('UPDATE refund_transactions SET returned_cost_cents=? WHERE id=? AND returned_cost_cents IS NULL').run(items.reduce((n,i)=>n+i.returned_quantity*i.cost_price_cents,0),refunds[0].id);
    }
    else if(items.every(i=>i.returned_quantity===0))database.prepare("UPDATE refund_transactions SET returned_cost_cents=0 WHERE order_id=? AND status='success' AND returned_cost_cents IS NULL").run(order.id);
  }
}
