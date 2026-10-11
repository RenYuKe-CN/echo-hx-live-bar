export function migrateCatalog(database) {
  const add = (table, name, definition) => {
    if (!database.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  add('products', 'kind', "TEXT NOT NULL DEFAULT 'basic' CHECK(kind IN ('basic','bundle'))");
  add('products', 'unit', "TEXT NOT NULL DEFAULT '件'");
  add('products', 'sellable', 'INTEGER NOT NULL DEFAULT 1');
  add('products', 'safety_stock', 'INTEGER NOT NULL DEFAULT 20');
  add('products', 'target_stock', 'INTEGER NOT NULL DEFAULT 100');
  add('products', 'pack_size', 'INTEGER NOT NULL DEFAULT 1');
  add('products', 'extra_cost_cents', 'INTEGER NOT NULL DEFAULT 0');
  add('products', 'reference_cost_cents', 'INTEGER');
  add('products', 'recipe_version', 'INTEGER NOT NULL DEFAULT 1');
  add('orders', 'source_channel', "TEXT NOT NULL DEFAULT 'miniapp'");
  database.exec(`
    CREATE TABLE IF NOT EXISTS bundle_components (
      bundle_id INTEGER NOT NULL REFERENCES products(id), product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999), PRIMARY KEY(bundle_id,product_id), CHECK(bundle_id != product_id)
    );
    CREATE TABLE IF NOT EXISTS order_bundle_groups (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, quantity INTEGER NOT NULL,
      recipe_version INTEGER NOT NULL, original_cents INTEGER NOT NULL, paid_cents INTEGER NOT NULL,
      cost_cents INTEGER NOT NULL, components_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_buy_mappings (
      id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), platform TEXT NOT NULL CHECK(platform IN ('meituan','douyin')),
      external_product_id TEXT NOT NULL, external_sku_id TEXT NOT NULL DEFAULT '', product_id INTEGER NOT NULL REFERENCES products(id),
      name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, fee_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(store_id,platform,external_product_id,external_sku_id)
    );
    CREATE TABLE IF NOT EXISTS group_buy_redemptions (
      id TEXT PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), session_id INTEGER NOT NULL REFERENCES table_sessions(id),
      user_id INTEGER NOT NULL REFERENCES users(id), platform TEXT NOT NULL, certificate_id TEXT NOT NULL,
      voucher_hash TEXT NOT NULL, voucher_code TEXT NOT NULL, mapping_id INTEGER NOT NULL REFERENCES group_buy_mappings(id),
      state TEXT NOT NULL, source TEXT NOT NULL, snapshot_json TEXT NOT NULL, provider_json TEXT NOT NULL DEFAULT '{}',
      amount_cents INTEGER NOT NULL, expected_settlement_cents INTEGER, actual_settlement_cents INTEGER,
      request_id TEXT UNIQUE, order_id INTEGER REFERENCES orders(id), operator_id INTEGER REFERENCES staff_accounts(id),
      error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform,certificate_id)
    );
    CREATE TABLE IF NOT EXISTS redemption_stock (
      redemption_id TEXT NOT NULL REFERENCES group_buy_redemptions(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL, PRIMARY KEY(redemption_id,product_id)
    );
    CREATE INDEX IF NOT EXISTS inventory_logs_product_time ON inventory_logs(product_id,created_at,id);
    CREATE INDEX IF NOT EXISTS bundle_components_product ON bundle_components(product_id);
    CREATE UNIQUE INDEX IF NOT EXISTS group_buy_manual_voucher_unique ON group_buy_redemptions(platform,voucher_hash) WHERE source='manual';
    UPDATE group_buy_redemptions SET state='unknown',error='核销请求中断，需核对平台结果' WHERE state='verifying';
  `);
  add('order_items', 'bundle_group_id', 'INTEGER REFERENCES order_bundle_groups(id)');
  add('inventory_logs', 'order_id', 'INTEGER REFERENCES orders(id) ON DELETE SET NULL');
  add('inventory_logs', 'channel', "TEXT NOT NULL DEFAULT 'adjustment'");
  add('inventory_logs', 'operator', "TEXT NOT NULL DEFAULT ''");
  add('refund_transactions', 'external_cents', 'INTEGER NOT NULL DEFAULT 0');
  database.exec(`
    DROP TRIGGER IF EXISTS products_empty_update;
    DROP TRIGGER IF EXISTS products_empty_insert;
    DROP TRIGGER IF EXISTS products_available_restore;
    UPDATE products SET reserved_stock=COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=products.id AND o.payment_status='pending'),0)
      +COALESCE((SELECT SUM(rs.quantity) FROM redemption_stock rs JOIN group_buy_redemptions r ON r.id=rs.redemption_id WHERE rs.product_id=products.id AND r.state IN ('verifying','unknown','verified')),0);
    CREATE TRIGGER products_empty_update AFTER UPDATE OF stock,reserved_stock,status ON products WHEN NEW.kind='basic' AND NEW.stock-NEW.reserved_stock<=0 AND NEW.status='active'
    BEGIN UPDATE products SET status='inactive',auto_unlisted=1 WHERE id=NEW.id; END;
    CREATE TRIGGER products_empty_insert AFTER INSERT ON products WHEN NEW.kind='basic' AND NEW.stock-NEW.reserved_stock<=0 AND NEW.status='active'
    BEGIN UPDATE products SET status='inactive',auto_unlisted=1 WHERE id=NEW.id; END;
    CREATE TRIGGER products_available_restore AFTER UPDATE OF stock,reserved_stock ON products WHEN NEW.kind='basic' AND NEW.stock-NEW.reserved_stock>0 AND NEW.status='inactive' AND NEW.auto_unlisted=1
    BEGIN UPDATE products SET status='active',auto_unlisted=0 WHERE id=NEW.id; END;
  `);
}
