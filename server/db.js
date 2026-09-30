import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'echo-hx.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, nickname TEXT NOT NULL, member_level TEXT NOT NULL DEFAULT '普通会员', member_discount REAL NOT NULL DEFAULT 1, points INTEGER NOT NULL DEFAULT 0, member_expires_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', image_url TEXT, price_cents INTEGER NOT NULL, member_price_cents INTEGER, tag TEXT, color TEXT NOT NULL DEFAULT 'amber', stock INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS tables (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), table_no TEXT NOT NULL, qr_token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'available');
  CREATE TABLE IF NOT EXISTS table_sessions (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), table_id INTEGER NOT NULL REFERENCES tables(id), session_no TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'open', opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT);
  CREATE TABLE IF NOT EXISTS session_members (session_id INTEGER NOT NULL REFERENCES table_sessions(id), user_id INTEGER NOT NULL REFERENCES users(id), joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (session_id, user_id));
  CREATE TABLE IF NOT EXISTS cart_items (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES table_sessions(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity > 0), added_by_user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, session_id INTEGER NOT NULL REFERENCES table_sessions(id), payer_user_id INTEGER NOT NULL REFERENCES users(id), original_amount_cents INTEGER NOT NULL, discount_amount_cents INTEGER NOT NULL DEFAULT 0, payable_amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending_payment', payment_status TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT);
  CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), cart_item_id INTEGER REFERENCES cart_items(id), product_id INTEGER NOT NULL REFERENCES products(id), product_name TEXT NOT NULL, quantity INTEGER NOT NULL, original_price_cents INTEGER NOT NULL, paid_price_cents INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS points_ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), order_id INTEGER REFERENCES orders(id), points INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS wallet_accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id), stored_cents INTEGER NOT NULL DEFAULT 0, bonus_cents INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS wallet_packages (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), name TEXT NOT NULL, pay_cents INTEGER NOT NULL, stored_cents INTEGER NOT NULL, bonus_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', allow_bonus INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS wallet_transactions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, pay_cents INTEGER NOT NULL DEFAULT 0, stored_cents INTEGER NOT NULL DEFAULT 0, bonus_cents INTEGER NOT NULL DEFAULT 0, remark TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS storage_records (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), store_id INTEGER NOT NULL REFERENCES stores(id), product_name TEXT NOT NULL, quantity INTEGER NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'stored', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS storage_movements (id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES storage_records(id), type TEXT NOT NULL CHECK(type IN ('deposit','withdraw')), quantity INTEGER NOT NULL CHECK(quantity > 0), operator TEXT NOT NULL DEFAULT '店员', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS group_buy_records (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), platform TEXT NOT NULL, voucher_no TEXT NOT NULL, package_name TEXT NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'verified', verified_by TEXT, verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, note TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS member_rules (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL UNIQUE REFERENCES stores(id), stored_enabled INTEGER NOT NULL DEFAULT 1, stored_min_cents INTEGER NOT NULL DEFAULT 0, monthly_enabled INTEGER NOT NULL DEFAULT 1, monthly_price_cents INTEGER NOT NULL DEFAULT 3900, monthly_days INTEGER NOT NULL DEFAULT 30, spend_enabled INTEGER NOT NULL DEFAULT 1, spend_target_cents INTEGER NOT NULL DEFAULT 100000, spend_period TEXT NOT NULL DEFAULT 'calendar_month', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS member_tiers (id INTEGER PRIMARY KEY, store_id INTEGER NOT NULL REFERENCES stores(id), name TEXT NOT NULL, discount REAL NOT NULL DEFAULT 1, points_rate REAL NOT NULL DEFAULT 1, allow_bonus INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS inventory_logs (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), change_quantity INTEGER NOT NULL, stock_after INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY, operator TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS staff_accounts (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('super','manager','staff')), permissions TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS staff_sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES staff_accounts(id), expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS integration_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS stock_losses (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity > 0), cost_cents INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('gift','damage')), reason TEXT NOT NULL, operator_id INTEGER NOT NULL REFERENCES staff_accounts(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS reward_items (id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id), name TEXT NOT NULL, image_url TEXT NOT NULL DEFAULT '', points INTEGER NOT NULL CHECK(points > 0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS reward_redemptions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), reward_id INTEGER NOT NULL REFERENCES reward_items(id), reward_name TEXT NOT NULL, points INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS mini_page_settings (key TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT NOT NULL);
`);

// Keep the first SQLite release useful after schema upgrades as well as on a fresh install.
const ensureColumn = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};
ensureColumn('users', 'phone', 'TEXT');
ensureColumn('users', 'wechat_openid', 'TEXT');
ensureColumn('users', 'avatar_url', 'TEXT');
ensureColumn('users', 'member_tier_id', 'INTEGER REFERENCES member_tiers(id)');
ensureColumn('member_tiers', 'upgrade_type', "TEXT NOT NULL DEFAULT 'spend'");
ensureColumn('member_tiers', 'threshold_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_tiers', 'duration_days', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_tiers', 'sort', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS users_wechat_unique ON users(wechat_openid) WHERE wechat_openid IS NOT NULL;');
for (const account of db.prepare('SELECT id, permissions FROM staff_accounts WHERE role != ?').all('super')) {
  const permissions = JSON.parse(account.permissions);
  if (permissions.includes('rules')) db.prepare('UPDATE staff_accounts SET permissions = ? WHERE id = ?').run(JSON.stringify([...new Set([...permissions.filter(p => p !== 'rules'), 'members'])]), account.id);
}
ensureColumn('products', 'allow_bonus', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('storage_records', 'product_id', 'INTEGER REFERENCES products(id)');
ensureColumn('products', 'cost_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('order_items', 'cost_price_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'payment_method', "TEXT NOT NULL DEFAULT 'offline'");
ensureColumn('orders', 'stored_paid_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'bonus_paid_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'wechat_paid_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'offline_paid_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'offline_channel', 'TEXT');
ensureColumn('orders', 'pos_request_id', 'TEXT');
ensureColumn('orders', 'delivered_at', 'TEXT');
ensureColumn('orders', 'note', "TEXT NOT NULL DEFAULT ''");
ensureColumn('orders', 'wechat_prepay_id', 'TEXT');
ensureColumn('orders', 'wechat_transaction_id', 'TEXT');
ensureColumn('orders', 'payment_expire_at', 'TEXT');
ensureColumn('orders', 'payment_error', "TEXT NOT NULL DEFAULT ''");
ensureColumn('wallet_accounts', 'stored_reserved_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('wallet_accounts', 'bonus_reserved_cents', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
  UPDATE orders SET status = 'awaiting_delivery' WHERE status = 'paid' AND payment_status = 'paid';
  UPDATE products SET status = 'inactive' WHERE stock <= 0 AND status = 'active';
  CREATE TRIGGER IF NOT EXISTS products_empty_update AFTER UPDATE OF stock, status ON products
  WHEN NEW.stock <= 0 AND NEW.status = 'active'
  BEGIN
    UPDATE products SET status = 'inactive' WHERE id = NEW.id;
    INSERT INTO operation_logs (operator, action, detail) VALUES ('系统', '缺货自动下架', NEW.name);
  END;
  CREATE TRIGGER IF NOT EXISTS products_empty_insert AFTER INSERT ON products
  WHEN NEW.stock <= 0 AND NEW.status = 'active'
  BEGIN
    UPDATE products SET status = 'inactive' WHERE id = NEW.id;
  END;
`);
ensureColumn('wallet_transactions', 'pos_request_id', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_pos_request_unique ON orders(pos_request_id) WHERE pos_request_id IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS wallet_pos_request_unique ON wallet_transactions(pos_request_id) WHERE pos_request_id IS NOT NULL;');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_wechat_prepay_unique ON orders(wechat_prepay_id) WHERE wechat_prepay_id IS NOT NULL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS wechat_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    openid TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS wechat_sessions_openid_unique ON wechat_sessions(openid);
`);

if (!db.prepare("SELECT id FROM staff_accounts WHERE role = 'super' LIMIT 1").get()) {
  const password = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(12).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  db.prepare('INSERT INTO staff_accounts (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)').run('admin', '超级管理员', `${salt}:${hash}`, 'super');
  console.log(`Initial admin login: admin / ${password} (change the password after signing in)`);
}

const seed = db.transaction(() => {
  if (db.prepare('SELECT id FROM stores LIMIT 1').get()) return;
  db.prepare('INSERT INTO stores (id, name) VALUES (1, ?)').run('Echo HX Live Bar');
  const categories = ['推荐', '啤酒', '鸡尾酒', '小吃', '套餐', '无酒精'];
  const insertCategory = db.prepare('INSERT INTO categories (store_id, name, sort) VALUES (1, ?, ?)');
  categories.forEach((name, sort) => insertCategory.run(name, sort));
  const categoryId = name => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
  const products = [['精酿啤酒','冷藏 330ml','啤酒',3800,3400,'热销','amber'],['金汤力','杜松子酒 · 汤力水','鸡尾酒',6800,6100,'推荐','teal'],['百威啤酒','冰镇 330ml','啤酒',2800,2500,'会员专享','red'],['芝士薯条','现炸小食','小吃',4200,3800,'下酒菜','yellow'],['威士忌套餐','700ml · 适合分享','套餐',68800,61900,'分享装','purple'],['西柚气泡','无酒精特调','无酒精',3200,2900,'清爽','pink']];
  const insertProduct = db.prepare('INSERT INTO products (store_id, category_id, name, detail, price_cents, member_price_cents, tag, color, stock) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 100)');
  products.forEach(([name, detail, category, price, memberPrice, tag, color]) => insertProduct.run(categoryId(category), name, detail, price, memberPrice, tag, color));
  db.prepare("INSERT INTO tables (id, store_id, table_no, qr_token) VALUES (1, 1, 'A-08', 'echo-a08-demo')").run();
  db.prepare("INSERT INTO users (id, nickname, member_level, member_discount, points, member_expires_at) VALUES (1, 'Luna', '金卡会员', 0.9, 1280, '2026-10-28T23:59:59.000Z')").run();
  db.prepare('INSERT INTO wallet_accounts (user_id, stored_cents, bonus_cents) VALUES (1, 50000, 10000)').run();
  db.prepare('INSERT INTO wallet_packages (store_id, name, pay_cents, stored_cents, bonus_cents, allow_bonus) VALUES (1, ?, ?, ?, ?, ?)').run('畅饮储值 500', 50000, 50000, 10000, 0);
  db.prepare('INSERT INTO member_rules (store_id) VALUES (1)').run();
  db.prepare('INSERT INTO member_tiers (store_id, name, discount, points_rate, allow_bonus) VALUES (1, ?, ?, ?, ?)').run('金卡会员', 0.9, 1, 0);
});
seed();
db.prepare("UPDATE member_tiers SET threshold_cents = COALESCE((SELECT spend_target_cents FROM member_rules WHERE store_id = member_tiers.store_id), 100000) WHERE threshold_cents = 0 AND upgrade_type = 'spend'").run();
db.prepare("UPDATE users SET member_tier_id = (SELECT id FROM member_tiers WHERE name = users.member_level AND status = 'active' ORDER BY id LIMIT 1) WHERE member_tier_id IS NULL AND member_level != '普通会员'").run();

export function centsToMoney(cents) { return Number((cents / 100).toFixed(2)); }
