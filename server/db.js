import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

export const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const databasePath = path.join(dataDir, 'echo-hx.sqlite');
export let db = new Database(databasePath);
const configureDatabase = database => {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
};
configureDatabase(db);

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
  CREATE TABLE IF NOT EXISTS backup_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    frequency TEXT NOT NULL DEFAULT 'daily',
    run_time TEXT NOT NULL DEFAULT '04:00',
    retention_days INTEGER NOT NULL DEFAULT 30,
    last_run_at TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS coupon_definitions (
    id INTEGER PRIMARY KEY,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('fixed','discount')),
    amount_cents INTEGER NOT NULL DEFAULT 0,
    discount_rate REAL NOT NULL DEFAULT 1,
    min_order_cents INTEGER NOT NULL DEFAULT 0,
    product_id INTEGER REFERENCES products(id),
    category_id INTEGER REFERENCES categories(id),
    member_tier_id INTEGER REFERENCES member_tiers(id),
    allow_stack_member_discount INTEGER NOT NULL DEFAULT 0,
    allow_bonus_payment INTEGER NOT NULL DEFAULT 0,
    total_quantity INTEGER NOT NULL DEFAULT 0,
    issued_quantity INTEGER NOT NULL DEFAULT 0,
    per_user_limit INTEGER NOT NULL DEFAULT 1,
    valid_from TEXT,
    valid_until TEXT,
    valid_days INTEGER NOT NULL DEFAULT 0,
    icon_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_coupons (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    coupon_definition_id INTEGER NOT NULL REFERENCES coupon_definitions(id),
    coupon_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','locked','used','expired','cancelled')),
    issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used_at TEXT,
    expired_at TEXT,
    order_id INTEGER REFERENCES orders(id),
    source_type TEXT NOT NULL DEFAULT 'campaign',
    source_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS message_templates (
    id INTEGER PRIMARY KEY,
    template_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'site',
    wechat_template_id TEXT NOT NULL DEFAULT '',
    title_template TEXT NOT NULL,
    content_template TEXT NOT NULL,
    field_mapping TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL DEFAULT 'system_notice',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    related_type TEXT,
    related_id INTEGER,
    read_at TEXT,
    hidden_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS message_campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    message_template_id INTEGER REFERENCES message_templates(id),
    audience_type TEXT NOT NULL DEFAULT 'selected',
    audience_filter TEXT NOT NULL DEFAULT '{}',
    scheduled_at TEXT,
    status TEXT NOT NULL DEFAULT 'sent',
    created_by INTEGER REFERENCES staff_accounts(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS message_recipients (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES message_campaigns(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    openid TEXT,
    channel TEXT NOT NULL DEFAULT 'site',
    status TEXT NOT NULL DEFAULT 'pending',
    wechat_message_id TEXT,
    error_code TEXT,
    error_message TEXT,
    sent_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS user_subscription_authorizations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    template_key TEXT NOT NULL,
    wechat_template_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'authorized',
    authorized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_checked_at TEXT,
    UNIQUE(user_id, template_key)
  );
  CREATE INDEX IF NOT EXISTS user_coupons_user_status_idx ON user_coupons(user_id, status);
  CREATE INDEX IF NOT EXISTS user_messages_user_read_idx ON user_messages(user_id, read_at);
`);

db.prepare('INSERT OR IGNORE INTO backup_settings (id) VALUES (1)').run();

// Keep the first SQLite release useful after schema upgrades as well as on a fresh install.
const ensureColumn = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};
ensureColumn('users', 'phone', 'TEXT');
ensureColumn('users', 'wechat_openid', 'TEXT');
ensureColumn('users', 'avatar_url', 'TEXT');
ensureColumn('users', 'member_tier_id', 'INTEGER REFERENCES member_tiers(id)');
ensureColumn('users', 'member_cycle_started_at', 'TEXT');
ensureColumn('users', 'member_pending_tier_id', 'INTEGER REFERENCES member_tiers(id)');
ensureColumn('users', 'admin_note', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'birthday_type', 'TEXT');
ensureColumn('users', 'birthday_date', 'TEXT');
ensureColumn('user_messages', 'hidden_at', 'TEXT');
ensureColumn('member_tiers', 'upgrade_type', "TEXT NOT NULL DEFAULT 'spend'");
ensureColumn('member_tiers', 'threshold_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_tiers', 'duration_days', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_tiers', 'sort', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_tiers', 'stored_threshold_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_tiers', 'spend_threshold_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_tiers', 'condition_mode', "TEXT NOT NULL DEFAULT 'any'");
ensureColumn('member_tiers', 'badge_color', "TEXT NOT NULL DEFAULT '#C77F52'");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS users_wechat_unique ON users(wechat_openid) WHERE wechat_openid IS NOT NULL;');
for (const account of db.prepare('SELECT id, permissions FROM staff_accounts WHERE role != ?').all('super')) {
  const permissions = JSON.parse(account.permissions);
  if (permissions.includes('rules')) db.prepare('UPDATE staff_accounts SET permissions = ? WHERE id = ?').run(JSON.stringify([...new Set([...permissions.filter(p => p !== 'rules'), 'members'])]), account.id);
}
ensureColumn('products', 'allow_bonus', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('products', 'reserved_stock', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('products', 'auto_unlisted', 'INTEGER NOT NULL DEFAULT 0');
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
ensureColumn('orders', 'hidden_by_user', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'coupon_id', 'INTEGER REFERENCES user_coupons(id)');
ensureColumn('orders', 'coupon_discount_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('coupon_definitions', 'voucher_type', "TEXT NOT NULL DEFAULT 'discount'");
ensureColumn('coupon_definitions', 'gift_product_id', 'INTEGER REFERENCES products(id)');
ensureColumn('cart_items', 'applied_coupon_id', 'INTEGER REFERENCES user_coupons(id)');
ensureColumn('wallet_accounts', 'stored_reserved_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('wallet_accounts', 'bonus_reserved_cents', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
  -- Rebuild reservations after upgrades or an unclean restart. Only orders
  -- still waiting for payment can hold stock.
  UPDATE products SET reserved_stock = COALESCE((
    SELECT SUM(oi.quantity)
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = products.id AND o.payment_status = 'pending'
  ), 0);
  UPDATE orders SET status = 'awaiting_delivery' WHERE status = 'paid' AND payment_status = 'paid';
  DROP TRIGGER IF EXISTS products_empty_update;
  DROP TRIGGER IF EXISTS products_empty_insert;
  DROP TRIGGER IF EXISTS products_available_restore;
  UPDATE products SET status = 'inactive', auto_unlisted = 1
    WHERE stock - reserved_stock <= 0 AND status = 'active';
  CREATE TRIGGER products_empty_update AFTER UPDATE OF stock, reserved_stock, status ON products
  WHEN NEW.stock - NEW.reserved_stock <= 0 AND NEW.status = 'active'
  BEGIN
    UPDATE products SET status = 'inactive', auto_unlisted = 1 WHERE id = NEW.id;
    INSERT INTO operation_logs (operator, action, detail) VALUES ('系统', '缺货自动下架', NEW.name);
  END;
  CREATE TRIGGER products_empty_insert AFTER INSERT ON products
  WHEN NEW.stock - NEW.reserved_stock <= 0 AND NEW.status = 'active'
  BEGIN
    UPDATE products SET status = 'inactive', auto_unlisted = 1 WHERE id = NEW.id;
  END;
  CREATE TRIGGER products_available_restore AFTER UPDATE OF stock, reserved_stock ON products
  WHEN NEW.stock - NEW.reserved_stock > 0 AND NEW.status = 'inactive' AND NEW.auto_unlisted = 1
  BEGIN
    UPDATE products SET status = 'active', auto_unlisted = 0 WHERE id = NEW.id;
    INSERT INTO operation_logs (operator, action, detail) VALUES ('系统', '库存恢复自动上架', NEW.name);
  END;
`);
ensureColumn('wallet_transactions', 'pos_request_id', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_pos_request_unique ON orders(pos_request_id) WHERE pos_request_id IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS wallet_pos_request_unique ON wallet_transactions(pos_request_id) WHERE pos_request_id IS NOT NULL;');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_wechat_prepay_unique ON orders(wechat_prepay_id) WHERE wechat_prepay_id IS NOT NULL;');

const messageTemplateSeed = [
  ['order_pending_payment', '待支付订单', '订单待支付', '订单 {{orderNo}} 还有 {{minutes}} 分钟自动取消。'],
  ['order_paid', '订单已支付', '订单已支付', '订单 {{orderNo}} 已支付成功，店员将尽快为您送达。'],
  ['order_awaiting_delivery', '订单待送达', '订单准备中', '订单 {{orderNo}} 正在准备，请稍候。'],
  ['order_completed', '订单已送达', '订单已送达', '订单 {{orderNo}} 已送达，祝您用餐愉快。'],
  ['order_cancelled', '订单已取消', '订单已取消', '订单 {{orderNo}} 已取消。'],
  ['coupon_issued', '优惠券到账', '您有新优惠券', '{{couponName}} 已放入您的券包。'],
  ['coupon_expiring', '优惠券即将到期', '优惠券即将到期', '{{couponName}} 将于 {{expireAt}} 到期。'],
  ['member_upgraded', '会员升级', '会员等级已升级', '恭喜您成为 {{memberLevel}}。'],
  ['storage_expiring', '存酒到期提醒', '您的存酒即将到期', '{{productName}} 将于 {{expireAt}} 到期。'],
  ['birthday_reward', '生日福利', '生日快乐', '祝您生日快乐，生日福利已到账。'],
  ['wallet_recharged', '储值到账', '储值到账提醒', '储值金额 {{stored}} 元，赠金 {{bonus}} 元已到账。'],
  ['reward_redeemed', '积分兑换', '兑换成功', '您已成功兑换 {{rewardName}}。'],
  ['system_notice', '系统通知', '系统通知', '{{content}}']
];
const insertMessageTemplate = db.prepare('INSERT OR IGNORE INTO message_templates (template_key, name, title_template, content_template) VALUES (?, ?, ?, ?)');
messageTemplateSeed.forEach(row => insertMessageTemplate.run(...row));

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
db.prepare("UPDATE member_tiers SET spend_threshold_cents = threshold_cents WHERE spend_threshold_cents = 0 AND upgrade_type IN ('spend', 'monthly') AND threshold_cents > 0").run();
db.prepare("UPDATE member_tiers SET stored_threshold_cents = threshold_cents WHERE stored_threshold_cents = 0 AND upgrade_type = 'recharge' AND threshold_cents > 0").run();
db.prepare("UPDATE users SET member_tier_id = (SELECT id FROM member_tiers WHERE name = users.member_level AND status = 'active' ORDER BY id LIMIT 1) WHERE member_tier_id IS NULL AND member_level != '普通会员'").run();

// Restore swaps the SQLite file while the API process stays online. Reopening
// this singleton keeps all route modules pointed at the restored database.
export function reopenDatabase() {
  if (db.open) db.close();
  db = new Database(databasePath);
  configureDatabase(db);
}

export function centsToMoney(cents) { return Number((cents / 100).toFixed(2)); }
