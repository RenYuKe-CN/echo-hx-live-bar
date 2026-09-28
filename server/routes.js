import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Router } from 'express';
import { db, centsToMoney } from './db.js';
import { getIntegrationStatus, integrationDefinitions } from './config.js';
import { getUnlimitedMiniProgramCode } from './wechat-mini-code.js';

export const router = Router();
const currentUserId = req => Number(req.header('x-demo-user-id') || 1);
const todayLocalDate = () => db.prepare("SELECT date('now', 'localtime') AS day").get().day;
const modules = ['dashboard','pos','orders','tables','members','storage','group-buy','products','wallet','rewards','reports','losses'];
const hashPassword = password => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; };
const verifyPassword = (password, stored) => { const [salt, hash] = stored.split(':'); const supplied = crypto.scryptSync(password, salt, 64); return hash?.length === 128 && crypto.timingSafeEqual(supplied, Buffer.from(hash, 'hex')); };
const normalizePermissions = permissions => [...new Set(permissions.map(permission => permission === 'inventory' ? 'products' : permission).filter(permission => modules.includes(permission)))];
const publicAccount = row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, permissions: row.role === 'super' ? [...modules, 'accounts', 'settings', 'logs', 'mini-page'] : normalizePermissions(JSON.parse(row.permissions)), status: row.status });
const audit = (req, action, detail = '') => db.prepare('INSERT INTO operation_logs (operator, action, detail) VALUES (?, ?, ?)').run(req.staff.username, action, String(detail));
const syncProductAvailability = () => {
  db.prepare("UPDATE products SET status = 'inactive' WHERE stock <= 0 AND status = 'active'").run();
};

router.post('/admin/login', (req, res) => {
  const account = db.prepare("SELECT * FROM staff_accounts WHERE username = ? AND status = 'active'").get(String(req.body?.username || '').trim());
  if (!account || !verifyPassword(String(req.body?.password || ''), account.password_hash)) return res.status(401).json({ message: '账号或密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO staff_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), account.id, new Date(Date.now() + 12 * 3600000).toISOString());
  db.prepare('INSERT INTO operation_logs (operator, action, detail) VALUES (?, ?, ?)').run(account.username, '登录后台', '');
  res.json({ token, account: publicAccount(account) });
});
router.use('/admin', (req, res, next) => {
  const token = req.header('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const row = token && db.prepare("SELECT a.* FROM staff_sessions s JOIN staff_accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ? AND a.status = 'active'").get(crypto.createHash('sha256').update(token).digest('hex'), new Date().toISOString());
  if (!row) return res.status(401).json({ message: '请先登录管理后台' });
  req.staff = row;
  const segment = req.path.split('/')[1];
  const section = ({ summary: 'dashboard', 'wallet-packages': 'wallet', 'member-rules': 'members', 'member-tiers': 'members', categories: 'products', 'session': null, 'logout': null, 'change-password': null })[segment] ?? segment;
  if (['session','logout','change-password'].includes(segment)) return next();
  const allowed = row.role === 'super' || JSON.parse(row.permissions).includes(section);
  if (!allowed) return res.status(403).json({ message: '当前账号没有此模块权限' });
  if (req.method !== 'GET' && row.role !== 'super') {
    const managerOnly = ['accounts','settings','logs'];
    if (managerOnly.includes(section)) return res.status(403).json({ message: '仅超级管理员可修改此模块' });
  }
  next();
});
router.get('/admin/session', (req, res) => res.json({ account: publicAccount(req.staff) }));
router.post('/admin/logout', (req, res) => { db.prepare('DELETE FROM staff_sessions WHERE account_id = ?').run(req.staff.id); res.json({ ok: true }); });
router.post('/admin/change-password', (req, res) => {
  if (!verifyPassword(String(req.body?.oldPassword || ''), req.staff.password_hash) || String(req.body?.newPassword || '').length < 10) return res.status(400).json({ message: '原密码错误，或新密码少于 10 位' });
  db.prepare('UPDATE staff_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.newPassword), req.staff.id);
  audit(req, '修改密码'); res.json({ ok: true });
});
router.get('/admin/accounts', (_req, res) => res.json({ accounts: db.prepare('SELECT * FROM staff_accounts ORDER BY id').all().map(publicAccount), modules }));
router.post('/admin/accounts', (req, res) => {
  const { username, displayName, password, role, permissions = [] } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username || '') || String(password || '').length < 10 || !['manager','staff'].includes(role) || !Array.isArray(permissions) || permissions.some(p => !modules.includes(p))) return res.status(400).json({ message: '账号、密码或权限无效（密码至少 10 位）' });
  try { const r = db.prepare('INSERT INTO staff_accounts (username, display_name, password_hash, role, permissions) VALUES (?, ?, ?, ?, ?)').run(username, String(displayName || username), hashPassword(password), role, JSON.stringify(permissions)); audit(req, '创建账号', username); res.status(201).json({ account: publicAccount(db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(r.lastInsertRowid)) }); }
  catch (error) { res.status(409).json({ message: '账号名已存在' }); }
});
router.patch('/admin/accounts/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(req.params.id);
  if (!account || account.role === 'super') return res.status(400).json({ message: '不可修改超级管理员账号' });
  const { role = account.role, status = account.status, permissions = JSON.parse(account.permissions), password, displayName = account.display_name } = req.body || {};
  if (!['manager','staff'].includes(role) || !['active','disabled'].includes(status) || !Array.isArray(permissions) || permissions.some(p => !modules.includes(p)) || (password && String(password).length < 10)) return res.status(400).json({ message: '账号配置无效' });
  db.prepare('UPDATE staff_accounts SET role = ?, status = ?, permissions = ?, display_name = ?, password_hash = ? WHERE id = ?').run(role, status, JSON.stringify(permissions), displayName, password ? hashPassword(password) : account.password_hash, account.id);
  if (status === 'disabled' || password) db.prepare('DELETE FROM staff_sessions WHERE account_id = ?').run(account.id);
  audit(req, '修改账号', account.username); res.json({ ok: true });
});
router.get('/admin/logs', (_req, res) => res.json({ logs: db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT 300').all() }));
router.get('/admin/settings', (_req, res) => {
  const status = getIntegrationStatus();
  res.json({ settings: Object.entries(integrationDefinitions).map(([key, definition]) => ({ key, label: definition.label, value: definition.secret && status.values[key] ? '' : status.values[key], configured: Boolean(status.values[key]), secret: definition.secret, source: process.env[definition.env] ? 'environment' : 'admin' })), groups: status.groups, integrationsActive: false });
});
const imageDir = path.resolve('data/uploads');
fs.mkdirSync(imageDir, { recursive: true });
router.post('/admin/products/image', express.raw({ type: ['image/png','image/jpeg','image/webp'], limit: '5mb' }), (req, res) => {
  const type = req.header('content-type')?.split(';')[0];
  const bytes = req.body;
  const extension = type === 'image/png' && bytes?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' : type === 'image/jpeg' && bytes?.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpg' : type === 'image/webp' && bytes?.subarray(0, 4).toString() === 'RIFF' && bytes?.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!extension) return res.status(400).json({ message: '仅支持 PNG、JPEG、WebP 图片，最大 5MB' });
  const filename = `${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(imageDir, filename), bytes);
  audit(req, '上传商品图片', filename);
  res.status(201).json({ imageUrl: `/api/product-images/${filename}` });
});
router.get('/product-images/:name', (req, res) => {
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(req.params.name)) return res.sendStatus(404);
  res.sendFile(path.join(imageDir, req.params.name));
});
router.put('/admin/settings', (req, res) => {
  const values = req.body || {};
  if (Object.keys(values).some(key => !Object.hasOwn(integrationDefinitions, key))) return res.status(400).json({ message: '包含未知配置项' });
  db.transaction(() => Object.entries(values).forEach(([key, value]) => {
    const text = String(value ?? '').trim();
    if (text && !process.env[integrationDefinitions[key].env]) db.prepare('INSERT INTO integration_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(key, text);
  }))();
  audit(req, '更新接口配置', Object.keys(values).join(','));
  const status = getIntegrationStatus();
  res.json({ ok: true, integrationsActive: false, groups: status.groups });
});
router.post('/admin/settings/check', (_req, res) => {
  const status = getIntegrationStatus();
  const checks = Object.fromEntries(Object.entries(status.groups).map(([group, value]) => [group, { status: value.configured ? 'ready_for_auth' : 'missing_config', missing: value.missing }]));
  res.json({ ok: true, checks, message: '配置完整性检查完成；真实平台授权、签名和回调仍需使用商户资质联调' });
});
router.get('/runtime-config', (_req, res) => {
  const { values } = getIntegrationStatus();
  const apiBaseUrl = values.public_api_base_url;
  if (!apiBaseUrl || !/^https:\/\//i.test(apiBaseUrl)) return res.status(503).json({ message: '小程序 API 地址尚未配置为 HTTPS' });
  res.json({ apiBaseUrl: apiBaseUrl.replace(/\/$/, '') });
});

function getOrCreateSession(storeId, tableId, userId) {
  let session = db.prepare("SELECT * FROM table_sessions WHERE store_id = ? AND table_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(storeId, tableId);
  if (!session) {
    const sessionNo = `S${Date.now().toString(36).toUpperCase()}`;
    const result = db.prepare('INSERT INTO table_sessions (store_id, table_id, session_no) VALUES (?, ?, ?)').run(storeId, tableId, sessionNo);
    session = db.prepare('SELECT * FROM table_sessions WHERE id = ?').get(result.lastInsertRowid);
  }
  db.prepare('INSERT OR IGNORE INTO session_members (session_id, user_id) VALUES (?, ?)').run(session.id, userId);
  return session;
}

function productView(row) {
  const product = { ...row, price: centsToMoney(row.price_cents), memberPrice: centsToMoney(row.member_price_cents ?? row.price_cents) };
  delete product.cost_cents;
  return product;
}

function memberPricing(userId) {
  const user = db.prepare('SELECT member_level, member_tier_id, member_discount, member_expires_at FROM users WHERE id = ?').get(userId);
  if (!user) return { active: false, discount: 1, pointsRate: 1 };
  if (user.member_level === '普通会员') return { active: false, discount: 1, pointsRate: 1 };
  const active = (!user.member_expires_at || new Date(user.member_expires_at) > new Date()) && (user.member_tier_id != null || user.member_discount < 1);
  const tier = user.member_tier_id && db.prepare("SELECT discount, points_rate FROM member_tiers WHERE id = ? AND status = 'active'").get(user.member_tier_id);
  const eligible = Boolean(active && (tier || user.member_tier_id == null));
  return { active: eligible, discount: eligible ? tier?.discount ?? user.member_discount : 1, pointsRate: eligible ? tier?.points_rate ?? 1 : 1 };
}
function unitPrice(product, pricing) {
  if (!pricing.active) return product.price_cents;
  return Math.min(product.member_price_cents ?? product.price_cents, Math.round(product.price_cents * pricing.discount));
}

router.get('/products', (req, res) => {
  syncProductAvailability();
  const storeId = Number(req.query.storeId || 1);
  const rows = db.prepare("SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id WHERE p.store_id = ? AND p.status = 'active' AND p.stock > 0 ORDER BY c.sort, p.sort, p.id").all(storeId);
  const pricing = memberPricing(currentUserId(req));
  res.json({ membership: pricing, products: rows.map(row => ({ ...productView(row), referenceMemberPrice: centsToMoney(Math.min(row.price_cents, row.member_price_cents ?? row.price_cents)), memberPrice: centsToMoney(unitPrice(row, pricing)) })), categories: [...new Set(rows.map(row => row.category))] });
});

router.get('/tables/resolve', (req, res) => {
  const scene = String(req.query.scene || '');
  const match = /^t_(\d{1,12})$/.exec(scene);
  if (!match) return res.status(400).json({ message: '桌台二维码参数无效' });
  const table = db.prepare("SELECT id, table_no FROM tables WHERE id = ? AND status != 'disabled'").get(Number(match[1]));
  if (!table) return res.status(404).json({ message: '桌台不存在或已停用' });
  res.json({ table: { id: table.id, tableNo: table.table_no } });
});

router.get('/tables/:tableNo/session', (req, res) => {
  const userId = currentUserId(req);
  const table = db.prepare('SELECT * FROM tables WHERE table_no = ? AND status != ?').get(req.params.tableNo, 'disabled');
  if (!table) return res.status(404).json({ message: '桌台不存在' });
  const session = getOrCreateSession(table.store_id, table.id, userId);
  const user = db.prepare('SELECT id, nickname, member_level, member_discount, points, member_expires_at FROM users WHERE id = ?').get(userId);
  res.json({ table: { id: table.id, tableNo: table.table_no }, session, user, membership: memberPricing(userId) });
});

router.get('/sessions/:sessionId/cart', (req, res) => {
  const rows = db.prepare("SELECT ci.id, ci.product_id, ci.quantity, ci.added_by_user_id, p.name, p.detail, p.price_cents, p.member_price_cents, p.image_url, p.color, p.stock FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? AND ci.status = 'pending' ORDER BY ci.id").all(req.params.sessionId);
  const pricing = memberPricing(currentUserId(req));
  const totals = rows.reduce((sum, row) => { sum.original += row.price_cents * row.quantity; sum.member += unitPrice(row, pricing) * row.quantity; return sum; }, { original: 0, member: 0 });
  res.json({ membership: pricing, items: rows.map(row => ({ ...row, price: centsToMoney(row.price_cents), referenceMemberPrice: centsToMoney(Math.min(row.price_cents, row.member_price_cents ?? row.price_cents)), memberPrice: centsToMoney(unitPrice(row, pricing)) })), totals: { original: centsToMoney(totals.original), member: centsToMoney(totals.member), discount: centsToMoney(totals.original - totals.member), points: Math.floor(totals.member / 100 * pricing.pointsRate) } });
});

router.post('/sessions/:sessionId/cart/items', (req, res) => {
  const userId = currentUserId(req);
  const { productId, quantity = 1 } = req.body || {};
  const requested = Number(quantity);
  if (!Number.isSafeInteger(Number(productId)) || !Number.isSafeInteger(requested) || requested < 1) return res.status(400).json({ message: '商品或数量无效' });
  try {
    db.transaction(() => {
      const session = db.prepare("SELECT * FROM table_sessions WHERE id = ? AND status = 'open'").get(req.params.sessionId);
      const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active' AND stock > 0").get(productId);
      if (!session || !product) throw new Error('商品已下架或库存不足');
      const inCart = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM cart_items WHERE session_id = ? AND product_id = ? AND status = 'pending'").get(session.id, product.id).quantity;
      if (inCart + requested > product.stock) throw new Error(`库存不足，当前最多还可下单 ${Math.max(product.stock - inCart, 0)} 件`);
      db.prepare('INSERT OR IGNORE INTO session_members (session_id, user_id) VALUES (?, ?)').run(session.id, userId);
      const existing = db.prepare("SELECT id FROM cart_items WHERE session_id = ? AND product_id = ? AND added_by_user_id = ? AND status = 'pending'").get(session.id, product.id, userId);
      if (existing) db.prepare('UPDATE cart_items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(requested, existing.id);
      else db.prepare('INSERT INTO cart_items (session_id, product_id, quantity, added_by_user_id) VALUES (?, ?, ?, ?)').run(session.id, product.id, requested, userId);
    })();
    res.status(201).json({ ok: true });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

router.patch('/sessions/:sessionId/cart/items/:itemId', (req, res) => {
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ message: '数量无效' });
  try {
    db.transaction(() => {
      const item = db.prepare("SELECT ci.*, p.stock, p.status AS product_status FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.id = ? AND ci.session_id = ? AND ci.status = 'pending'").get(req.params.itemId, req.params.sessionId);
      if (!item) throw new Error('购物车商品不存在或已下架');
      if (quantity > 0) {
        const other = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM cart_items WHERE session_id = ? AND product_id = ? AND status = 'pending' AND id != ?").get(req.params.sessionId, item.product_id, item.id).quantity;
        if (item.product_status !== 'active' || item.stock <= 0 || other + quantity > item.stock) throw new Error(`库存不足，当前最多可下单 ${Math.max(item.stock - other, 0)} 件`);
        db.prepare("UPDATE cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(quantity, item.id);
      } else db.prepare("UPDATE cart_items SET status = 'removed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id);
    })();
    res.json({ ok: true });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

function settleOrder(order, method, req) {
  const items = db.prepare('SELECT product_id, quantity, cart_item_id FROM order_items WHERE order_id = ?').all(order.id);
  for (const item of items) {
    if (!db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(item.quantity, item.product_id, item.quantity).changes) throw new Error('库存不足，无法完成支付');
    db.prepare("UPDATE cart_items SET status = 'settled' WHERE id = ?").run(item.cart_item_id);
  }
  db.prepare("UPDATE orders SET status = 'awaiting_delivery', payment_status = 'paid', payment_method = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(method, order.id);
  const points = Math.floor(order.payable_amount_cents / 100 * memberPricing(order.payer_user_id).pointsRate);
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(points, order.payer_user_id);
  db.prepare('INSERT INTO points_ledger (user_id, order_id, points, reason) VALUES (?, ?, ?, ?)').run(order.payer_user_id, order.id, points, '订单消费');
  const spent = db.prepare("SELECT COALESCE(SUM(payable_amount_cents),0) AS amount FROM orders WHERE payer_user_id = ? AND payment_status = 'paid'").get(order.payer_user_id).amount;
  const tier = db.prepare("SELECT * FROM member_tiers WHERE store_id = 1 AND status = 'active' AND upgrade_type = 'spend' AND threshold_cents <= ? ORDER BY threshold_cents DESC, id DESC LIMIT 1").get(spent);
  if (tier) {
    const current = db.prepare('SELECT member_tier_id, member_discount FROM users WHERE id = ?').get(order.payer_user_id);
    if (!current.member_tier_id || tier.discount < current.member_discount) {
      const expiry = tier.duration_days ? new Date(Date.now() + tier.duration_days * 86400000).toISOString() : null;
      db.prepare('UPDATE users SET member_tier_id = ?, member_level = ?, member_discount = ?, member_expires_at = ? WHERE id = ?').run(tier.id, tier.name, tier.discount, expiry, order.payer_user_id);
      if (req.staff) audit(req, '会员自动升级', `ID ${order.payer_user_id}: ${tier.name}`);
    }
  }
}

const posMember = row => row && ({ id: row.id, phone: row.phone, nickname: row.nickname, level: row.member_level, stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) });
const posMemberSql = 'SELECT u.*, COALESCE(w.stored_cents,0) AS stored_cents, COALESCE(w.bonus_cents,0) AS bonus_cents FROM users u LEFT JOIN wallet_accounts w ON w.user_id = u.id WHERE u.phone = ?';
router.get('/admin/pos', (req, res) => {
  syncProductAvailability();
  const phone = String(req.query.phone || '').trim();
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ message: '请输入完整会员手机号' });
  const member = phone ? db.prepare(posMemberSql).get(phone) : null;
  res.json({ member: posMember(member), tables: db.prepare("SELECT id, table_no FROM tables WHERE status != 'disabled' ORDER BY table_no").all(), products: db.prepare("SELECT id, name, image_url, price_cents, member_price_cents, stock, category_id FROM products WHERE status = 'active' AND stock > 0 ORDER BY sort,id").all().map(row => ({ ...row, price: centsToMoney(row.price_cents), memberPrice: member ? centsToMoney(unitPrice(row, memberPricing(member.id))) : centsToMoney(row.price_cents) })), packages: db.prepare("SELECT id,name,pay_cents,stored_cents,bonus_cents FROM wallet_packages WHERE status = 'active' ORDER BY pay_cents").all().map(row => ({ ...row, pay: centsToMoney(row.pay_cents), stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) })) });
});

router.post('/admin/pos/orders', (req, res) => {
  const { tableId, phone, items, paymentMethod, requestId } = req.body || {};
  if (!['balance','cash','merchant_qr'].includes(paymentMethod) || !/^[a-f0-9-]{36}$/.test(String(requestId || '')) || !Array.isArray(items) || !items.length || items.length > 100 || items.some(i => !Number.isSafeInteger(i.productId) || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > 999) || new Set(items.map(i => i.productId)).size !== items.length) return res.status(400).json({ message: '商品、数量或支付方式无效' });
  const member = db.prepare(posMemberSql).get(String(phone || '').trim());
  const table = db.prepare("SELECT * FROM tables WHERE id = ? AND status != 'disabled'").get(tableId);
  if (!member || !table) return res.status(400).json({ message: '请选择有效桌号和已绑定手机号的会员' });
  try {
    const order = db.transaction(() => {
      const prior = db.prepare('SELECT * FROM orders WHERE pos_request_id = ?').get(requestId);
      if (prior) return prior;
      const rows = items.map(item => ({ ...item, product: db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'").get(item.productId) }));
      if (rows.some(i => !i.product || i.product.stock < i.quantity)) throw new Error('商品已下架或库存不足');
      const pricing = memberPricing(member.id);
      const original = rows.reduce((n, i) => n + i.product.price_cents * i.quantity, 0);
      const payable = rows.reduce((n, i) => n + unitPrice(i.product, pricing) * i.quantity, 0);
      const eligible = rows.reduce((n, i) => n + (i.product.allow_bonus ? unitPrice(i.product, pricing) * i.quantity : 0), 0);
      const wallet = db.prepare('SELECT stored_cents,bonus_cents FROM wallet_accounts WHERE user_id = ?').get(member.id) || { stored_cents: 0, bonus_cents: 0 };
      const bonus = paymentMethod === 'balance' ? Math.min(wallet.bonus_cents, eligible, payable) : 0;
      const stored = paymentMethod === 'balance' ? payable - bonus : 0;
      if (wallet.stored_cents < stored) throw new Error('储值余额不足，请选择线下收款');
      const session = getOrCreateSession(table.store_id, table.id, member.id);
      const orderNo = `EH${Date.now()}${crypto.randomInt(100,999)}`;
      const method = paymentMethod === 'balance' ? 'balance' : 'offline';
      const id = db.prepare('INSERT INTO orders (order_no,session_id,payer_user_id,original_amount_cents,discount_amount_cents,payable_amount_cents,payment_method,stored_paid_cents,bonus_paid_cents,offline_paid_cents,pos_request_id,offline_channel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(orderNo, session.id, member.id, original, original - payable, payable, method, stored, bonus, method === 'offline' ? payable : 0, requestId, method === 'offline' ? paymentMethod : null).lastInsertRowid;
      const insert = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents) VALUES (?,?,?,?,?,?,?)');
      rows.forEach(i => insert.run(id, i.product.id, i.product.name, i.quantity, i.product.price_cents, unitPrice(i.product, pricing), i.product.cost_cents));
      if (method === 'balance') {
        db.prepare('UPDATE wallet_accounts SET stored_cents = stored_cents - ?, bonus_cents = bonus_cents - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(stored, bonus, member.id);
        db.prepare('INSERT INTO wallet_transactions (user_id,type,stored_cents,bonus_cents,remark) VALUES (?,?,?,?,?)').run(member.id, 'order_payment', -stored, -bonus, orderNo);
      }
      settleOrder({ id, payer_user_id: member.id, payable_amount_cents: payable }, method, req);
      audit(req, '收银点单', `${orderNo} 桌号 ${table.table_no} 手机尾号 ${member.phone.slice(-4)} ${paymentMethod}`);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    })();
    res.status(201).json({ orderNo: order.order_no, payable: centsToMoney(order.payable_amount_cents), storedPaid: centsToMoney(order.stored_paid_cents), bonusPaid: centsToMoney(order.bonus_paid_cents) });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

router.post('/admin/pos/recharges', (req, res) => {
  const { phone, packageId, paymentMethod, requestId } = req.body || {};
  if (!['cash','merchant_qr'].includes(paymentMethod) || !/^[a-f0-9-]{36}$/.test(String(requestId || ''))) return res.status(400).json({ message: '请选择线下收款方式' });
  const member = db.prepare(posMemberSql).get(String(phone || '').trim());
  const offer = db.prepare("SELECT * FROM wallet_packages WHERE id = ? AND status = 'active'").get(packageId);
  if (!member || !offer || offer.pay_cents <= 0 || offer.stored_cents < 0 || offer.bonus_cents < 0) return res.status(400).json({ message: '会员或储值套餐无效' });
  try {
    const transaction = db.transaction(() => {
      const prior = db.prepare('SELECT * FROM wallet_transactions WHERE pos_request_id = ?').get(requestId);
      if (prior) return prior;
      db.prepare('INSERT OR IGNORE INTO wallet_accounts (user_id) VALUES (?)').run(member.id);
      db.prepare('UPDATE wallet_accounts SET stored_cents = stored_cents + ?, bonus_cents = bonus_cents + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(offer.stored_cents, offer.bonus_cents, member.id);
      const id = db.prepare('INSERT INTO wallet_transactions (user_id,type,pay_cents,stored_cents,bonus_cents,remark,pos_request_id) VALUES (?,\'recharge\',?,?,?,?,?)').run(member.id, offer.pay_cents, offer.stored_cents, offer.bonus_cents, `${offer.name} · ${paymentMethod} · ${req.staff.username}`, requestId).lastInsertRowid;
      const tier = db.prepare("SELECT * FROM member_tiers WHERE store_id = 1 AND status = 'active' AND upgrade_type = 'recharge' AND threshold_cents <= ? ORDER BY threshold_cents DESC LIMIT 1").get(offer.pay_cents);
      if (tier && (!member.member_tier_id || tier.discount < member.member_discount)) db.prepare('UPDATE users SET member_tier_id = ?, member_level = ?, member_discount = ?, member_expires_at = ? WHERE id = ?').run(tier.id, tier.name, tier.discount, tier.duration_days ? new Date(Date.now() + tier.duration_days * 86400000).toISOString() : null, member.id);
      audit(req, '收银储值', `${offer.name} 手机尾号 ${member.phone.slice(-4)} ${paymentMethod} ${centsToMoney(offer.pay_cents)}元`);
      return db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(id);
    })();
    res.status(201).json({ transactionId: transaction.id, pay: centsToMoney(transaction.pay_cents), stored: centsToMoney(transaction.stored_cents), bonus: centsToMoney(transaction.bonus_cents) });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

router.get('/sessions/:sessionId/checkout', (req, res) => {
  const session = db.prepare("SELECT id FROM table_sessions WHERE id = ? AND status = 'open'").get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: '桌台会话不存在' });
  const rows = db.prepare("SELECT ci.quantity, p.price_cents, p.member_price_cents, p.allow_bonus FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? AND ci.status = 'pending'").all(session.id);
  const pricing = memberPricing(currentUserId(req));
  const payable = rows.reduce((n, item) => n + unitPrice(item, pricing) * item.quantity, 0);
  const bonusEligible = rows.reduce((n, item) => n + (item.allow_bonus ? unitPrice(item, pricing) * item.quantity : 0), 0);
  const wallet = db.prepare('SELECT stored_cents, bonus_cents FROM wallet_accounts WHERE user_id = ?').get(currentUserId(req)) || { stored_cents: 0, bonus_cents: 0 };
  const bonusUsable = Math.min(wallet.bonus_cents, bonusEligible, payable);
  const storedUsable = Math.min(wallet.stored_cents, payable - bonusUsable);
  const balanceDeduction = bonusUsable + storedUsable;
  const wechatDue = payable - balanceDeduction;
  res.json({ payable: centsToMoney(payable), stored: centsToMoney(wallet.stored_cents), bonus: centsToMoney(wallet.bonus_cents), accountBalance: centsToMoney(wallet.stored_cents), accountBonus: centsToMoney(wallet.bonus_cents), bonusEligible: centsToMoney(bonusEligible), bonusUsable: centsToMoney(bonusUsable), storedUsable: centsToMoney(storedUsable), balanceDeduction: centsToMoney(balanceDeduction), wechatDue: centsToMoney(wechatDue), balanceAvailable: wechatDue === 0, mixedPaymentAvailable: balanceDeduction > 0 && wechatDue > 0 });
});

router.post('/sessions/:sessionId/orders', (req, res) => {
  const userId = currentUserId(req);
  const method = req.body?.paymentMethod;
  if (!['balance','wechat','mixed'].includes(method)) return res.status(400).json({ message: '请选择支付方式' });
  const session = db.prepare("SELECT * FROM table_sessions WHERE id = ? AND status = 'open'").get(req.params.sessionId);
  const items = db.prepare("SELECT ci.*, p.name, p.price_cents, p.member_price_cents, p.cost_cents, p.stock, p.allow_bonus FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? AND ci.status = 'pending'").all(req.params.sessionId);
  if (!session || !items.length) return res.status(400).json({ message: '桌台没有待支付商品' });
  const existing = db.prepare("SELECT o.* FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.session_id = ? AND o.payment_status = 'pending' AND oi.cart_item_id IN (SELECT id FROM cart_items WHERE session_id = ? AND status = 'pending') ORDER BY o.id DESC LIMIT 1").get(session.id, session.id);
  if (existing) return res.status(409).json({ message: `订单 ${existing.order_no} 正在等待支付，请勿重复提交` });
  if (items.some(item => item.quantity > item.stock)) return res.status(409).json({ message: '部分商品库存不足' });
  const pricing = memberPricing(userId);
  const totals = items.reduce((sum, item) => { sum.original += item.price_cents * item.quantity; sum.member += unitPrice(item, pricing) * item.quantity; return sum; }, { original: 0, member: 0 });
  const eligible = items.reduce((n, item) => n + (item.allow_bonus ? unitPrice(item, pricing) * item.quantity : 0), 0);
  const orderNo = `EH${Date.now()}${crypto.randomInt(100, 999)}`;
  try { const order = db.transaction(() => {
    const wallet = db.prepare('SELECT stored_cents, bonus_cents FROM wallet_accounts WHERE user_id = ?').get(userId) || { stored_cents: 0, bonus_cents: 0 };
    const bonus = method === 'wechat' ? 0 : Math.min(wallet.bonus_cents, eligible, totals.member);
    const stored = method === 'wechat' ? 0 : Math.min(wallet.stored_cents, totals.member - bonus);
    const wechat = totals.member - bonus - stored;
    if (method === 'balance' && wechat > 0) throw new Error('余额不足，请选择组合支付或微信支付');
    if (method === 'mixed' && (wechat <= 0 || bonus + stored <= 0)) throw new Error('当前订单不需要组合支付');
    const result = db.prepare('INSERT INTO orders (order_no, session_id, payer_user_id, original_amount_cents, discount_amount_cents, payable_amount_cents, payment_method, stored_paid_cents, bonus_paid_cents, wechat_paid_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(orderNo, session.id, userId, totals.original, totals.original - totals.member, totals.member, method, stored, bonus, wechat);
    const insertItem = db.prepare('INSERT INTO order_items (order_id, cart_item_id, product_id, product_name, quantity, original_price_cents, paid_price_cents, cost_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    items.forEach(item => insertItem.run(result.lastInsertRowid, item.id, item.product_id, item.name, item.quantity, item.price_cents, unitPrice(item, pricing), item.cost_cents));
    db.prepare(`UPDATE cart_items SET status = 'checking_out' WHERE session_id = ? AND status = 'pending'`).run(session.id);
    if (method === 'balance') {
      db.prepare('UPDATE wallet_accounts SET stored_cents = stored_cents - ?, bonus_cents = bonus_cents - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(stored, bonus, userId);
      db.prepare('INSERT INTO wallet_transactions (user_id, type, stored_cents, bonus_cents, remark) VALUES (?, ?, ?, ?, ?)').run(userId, 'order_payment', -stored, -bonus, orderNo);
      settleOrder({ id: result.lastInsertRowid, payer_user_id: userId, payable_amount_cents: totals.member }, method, req);
    }
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  })();
  res.status(201).json({ order: { ...order, originalAmount: centsToMoney(order.original_amount_cents), discountAmount: centsToMoney(order.discount_amount_cents), payableAmount: centsToMoney(order.payable_amount_cents), storedPaid: centsToMoney(order.stored_paid_cents), bonusPaid: centsToMoney(order.bonus_paid_cents), wechatPaid: centsToMoney(order.wechat_paid_cents) }, payment: method === 'balance' ? { provider: 'balance', status: 'paid', message: '余额支付成功' } : { provider: 'wechat', status: 'not_started', statusLabel: '待微信支付', message: method === 'mixed' ? `余额抵扣 ${centsToMoney(order.stored_paid_cents + order.bonus_paid_cents)}，微信需支付 ${centsToMoney(order.wechat_paid_cents)}；微信支付接口尚未接通，暂不扣除余额` : '微信支付尚未接通，订单待支付，不会扣款' } });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

// Management APIs. They intentionally stay small and REST-shaped so a real staff auth layer can be added in front later.
const adminRows = query => db.prepare(query).all();
const adminMoney = row => ({ ...row, price: row.price_cents == null ? undefined : centsToMoney(row.price_cents), memberPrice: row.member_price_cents == null ? undefined : centsToMoney(row.member_price_cents) });

function fulfillmentLabel(order) {
  return order.status === 'completed' ? '已送达' : order.payment_status === 'paid' ? '待送达' : order.payment_status === 'pending' ? '待支付' : '已取消';
}
function orderItems(orderIds) {
  if (!orderIds.length) return {};
  const grouped = {};
  const rows = db.prepare(`SELECT oi.order_id, oi.product_id, oi.product_name, oi.quantity, p.image_url FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY oi.id`).all(...orderIds);
  for (const row of rows) (grouped[row.order_id] ||= []).push(row);
  return grouped;
}
router.get('/admin/summary', (req, res) => {
  const revenue = db.prepare("SELECT COALESCE(SUM(payable_amount_cents - bonus_paid_cents), 0) AS value FROM orders WHERE payment_status = 'paid' AND date(paid_at, 'localtime') = date('now','localtime')").get().value;
  const pendingPayment = db.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'pending_payment'").get().value;
  const activeOrders = db.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'awaiting_delivery' AND payment_status = 'paid'").get().value;
  const activeTables = db.prepare("SELECT COUNT(*) AS value FROM table_sessions WHERE status = 'open'").get().value;
  const totalTables = db.prepare("SELECT COUNT(*) AS value FROM tables WHERE status != 'disabled'").get().value;
  const idleTables = Math.max(totalTables - activeTables, 0);
  const members = db.prepare("SELECT COUNT(*) AS value FROM users WHERE member_level != '普通会员'").get().value;
  const lowStock = db.prepare("SELECT COUNT(*) AS value FROM products WHERE stock <= 0 OR (stock <= 20 AND status = 'active')").get().value;
  const outOfStock = db.prepare('SELECT COUNT(*) AS value FROM products WHERE stock <= 0').get().value;
  const canViewOrders = req.staff.role === 'super' || JSON.parse(req.staff.permissions).includes('orders');
  const pendingOrders = canViewOrders ? db.prepare("SELECT o.id, o.order_no, o.paid_at, t.table_no, u.nickname FROM orders o JOIN table_sessions ts ON ts.id = o.session_id JOIN tables t ON t.id = ts.table_id JOIN users u ON u.id = o.payer_user_id WHERE o.status = 'awaiting_delivery' AND o.payment_status = 'paid' ORDER BY o.paid_at, o.id LIMIT 50").all() : [];
  const items = orderItems(pendingOrders.map(o => o.id));
  const today = db.prepare("SELECT COALESCE(SUM(o.payable_amount_cents - o.bonus_paid_cents),0) AS revenue, COALESCE(SUM(o.payable_amount_cents - o.bonus_paid_cents - COALESCE((SELECT SUM(oi.quantity * oi.cost_price_cents) FROM order_items oi WHERE oi.order_id = o.id),0)),0) AS profit, COALESCE(SUM(CASE WHEN o.payment_method = 'offline' THEN o.offline_paid_cents ELSE 0 END),0) AS offline, COALESCE(SUM((SELECT SUM(oi.quantity * oi.cost_price_cents) FROM order_items oi WHERE oi.order_id = o.id)),0) AS order_cost FROM orders o WHERE o.payment_status = 'paid' AND date(o.paid_at, 'localtime') = date('now','localtime')").get();
  const todayRecharge = db.prepare("SELECT COALESCE(SUM(pay_cents),0) AS value FROM wallet_transactions WHERE type = 'recharge' AND date(created_at, 'localtime') = date('now','localtime')").get().value;
  const todayLoss = db.prepare("SELECT COALESCE(SUM(cost_cents),0) AS value FROM stock_losses WHERE date(created_at, 'localtime') = date('now','localtime')").get().value;
  res.json({ todayRevenue: centsToMoney(revenue), activeOrders, pendingPayment, activeTables, idleTables, totalTables, members, lowStock, outOfStock, todayMetrics: { revenue: centsToMoney(today.revenue), profit: centsToMoney(today.revenue - today.order_cost - todayLoss), recharge: centsToMoney(todayRecharge), offline: centsToMoney(today.offline), orderCost: centsToMoney(today.order_cost), lossCost: centsToMoney(todayLoss) }, pendingOrders: pendingOrders.map(o => ({ ...o, items: items[o.id] || [] })), updatedAt: new Date().toISOString() });
});

router.get('/admin/products', (req, res) => { syncProductAvailability(); return res.json({ products: adminRows('SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC').map(row => { const product = adminMoney(row); if (req.staff.role !== 'super') delete product.cost_cents; return product; }), categories: adminRows('SELECT * FROM categories ORDER BY sort, id') }); });
router.post('/admin/products', (req, res) => {
  const body = req.body || {};
  if (req.staff.role !== 'super' && body.cost != null) return res.status(403).json({ message: '仅超级管理员可设置进货价' });
  const category = db.prepare('SELECT id FROM categories WHERE id = ? OR name = ?').get(Number(body.categoryId) || 0, body.category || '啤酒');
  if (!body.name || !category) return res.status(400).json({ message: '商品名称和分类不能为空' });
  if (!Number.isInteger(Number(body.stock || 0)) || Number(body.stock || 0) < 0) return res.status(400).json({ message: '库存数量无效' });
  const result = db.prepare('INSERT INTO products (store_id, category_id, name, detail, image_url, price_cents, member_price_cents, cost_cents, tag, color, stock, allow_bonus, status, sort) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(category.id, body.name, body.detail || '', body.imageUrl || '', Math.round(Number(body.price || 0) * 100), body.memberPrice == null ? null : Math.round(Number(body.memberPrice) * 100), Math.round(Number(body.cost || 0) * 100), body.tag || '', body.color || 'amber', Number(body.stock || 0), body.allowBonus ? 1 : 0, body.status || 'active', Number(body.sort || 0));
  audit(req, '新增商品', body.name);
  const product = adminMoney(db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid));
  if (req.staff.role !== 'super') delete product.cost_cents;
  res.status(201).json({ product });
});
router.patch('/admin/products/:id', (req, res) => {
  const body = req.body || {};
  if (req.staff.role !== 'super' && body.cost != null) return res.status(403).json({ message: '仅超级管理员可设置进货价' });
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '商品不存在' });
  const category = body.categoryId ? db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(body.categoryId)) : null;
  if (body.stock != null && (!Number.isInteger(Number(body.stock)) || Number(body.stock) < 0)) return res.status(400).json({ message: '库存数量无效' });
  if (body.cost != null && (!Number.isFinite(Number(body.cost)) || Number(body.cost) < 0)) return res.status(400).json({ message: '进货价无效' });
  if (body.status === 'active' && Number(body.stock ?? current.stock) <= 0) return res.status(409).json({ message: '库存为零，请先补货再上架' });
  db.prepare('UPDATE products SET name = ?, detail = ?, image_url = ?, price_cents = ?, member_price_cents = ?, cost_cents = ?, stock = ?, allow_bonus = ?, status = ?, tag = ?, color = ?, category_id = COALESCE(?, category_id) WHERE id = ?').run(body.name ?? current.name, body.detail ?? current.detail, body.imageUrl ?? current.image_url, body.price == null ? current.price_cents : Math.round(Number(body.price) * 100), body.memberPrice === '' ? null : body.memberPrice == null ? current.member_price_cents : Math.round(Number(body.memberPrice) * 100), body.cost == null ? current.cost_cents : Math.round(Number(body.cost) * 100), body.stock == null ? current.stock : Number(body.stock), body.allowBonus == null ? current.allow_bonus : (body.allowBonus ? 1 : 0), body.status ?? current.status, body.tag ?? current.tag, body.color ?? current.color, category?.id || null, req.params.id);
  audit(req, '修改商品', `${current.name} #${current.id}`);
  const product = adminMoney(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
  if (req.staff.role !== 'super') delete product.cost_cents;
  res.json({ product });
});
router.delete('/admin/products/:id', (req, res) => { db.prepare("UPDATE products SET status = 'inactive' WHERE id = ?").run(req.params.id); audit(req, '下架商品', req.params.id); res.json({ ok: true }); });

router.get('/admin/categories', (_req, res) => res.json({ categories: adminRows('SELECT c.*, COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id ORDER BY c.sort, c.id') }));
router.post('/admin/categories', (req, res) => { if (!req.body.name) return res.status(400).json({ message: '分类名称不能为空' }); const r = db.prepare('INSERT INTO categories (store_id, name, sort) VALUES (1, ?, ?)').run(req.body.name, Number(req.body.sort || 0)); res.status(201).json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(r.lastInsertRowid) }); });
router.patch('/admin/categories/:id', (req, res) => { db.prepare('UPDATE categories SET name = COALESCE(?, name), sort = COALESCE(?, sort), status = COALESCE(?, status) WHERE id = ?').run(req.body.name, req.body.sort == null ? null : Number(req.body.sort), req.body.status, req.params.id); res.json({ ok: true }); });

router.get('/admin/tables', (_req, res) => res.json({ tables: adminRows("SELECT t.*, ts.session_no, ts.status AS session_status, COALESCE(SUM(o.payable_amount_cents),0) AS order_total FROM tables t LEFT JOIN table_sessions ts ON ts.table_id = t.id AND ts.status = 'open' LEFT JOIN orders o ON o.session_id = ts.id AND o.payment_status = 'paid' GROUP BY t.id ORDER BY t.table_no") .map(row => ({ ...row, orderTotal: centsToMoney(row.order_total) })) }));
router.get('/admin/tables/:id/mini-code', async (req, res) => {
  const table = db.prepare("SELECT id, table_no FROM tables WHERE id = ? AND status != 'disabled'").get(req.params.id);
  if (!table) return res.status(404).json({ message: '桌台不存在或已停用' });
  try {
    const image = await getUnlimitedMiniProgramCode(`t_${table.id}`);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="table-${table.id}.png"` });
    res.send(image);
  } catch (error) {
    res.status(502).json({ message: error.name === 'AbortError' ? '微信接口超时，请稍后重试' : error.message });
  }
});
router.post('/admin/tables', (req, res) => { if (!req.body.tableNo) return res.status(400).json({ message: '桌号不能为空' }); const token = `echo-${String(req.body.tableNo).toLowerCase()}-${crypto.randomBytes(4).toString('hex')}`; const r = db.prepare('INSERT INTO tables (store_id, table_no, qr_token) VALUES (1, ?, ?)').run(req.body.tableNo, token); audit(req, '新增桌台', req.body.tableNo); res.status(201).json({ table: db.prepare('SELECT * FROM tables WHERE id = ?').get(r.lastInsertRowid) }); });
router.patch('/admin/tables/:id', (req, res) => { db.prepare('UPDATE tables SET table_no = COALESCE(?, table_no), status = COALESCE(?, status) WHERE id = ?').run(req.body.tableNo, req.body.status, req.params.id); res.json({ ok: true }); });
router.post('/admin/tables/:id/close', (req, res) => { const session = db.prepare("SELECT id FROM table_sessions WHERE table_id = ? AND status = 'open'").get(req.params.id); if (session) { db.prepare("UPDATE table_sessions SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id); audit(req, '结束桌台', req.params.id); } res.json({ ok: true }); });

router.get('/admin/orders', (req, res) => {
  const rows = adminRows("SELECT o.*, t.table_no, u.nickname, COALESCE((SELECT SUM(oi.quantity * oi.cost_price_cents) FROM order_items oi WHERE oi.order_id = o.id),0) AS cost_cents FROM orders o JOIN table_sessions ts ON ts.id = o.session_id JOIN tables t ON t.id = ts.table_id JOIN users u ON u.id = o.payer_user_id ORDER BY (o.status = 'awaiting_delivery') DESC, o.id DESC LIMIT 100");
  const items = orderItems(rows.map(o => o.id));
  res.json({ orders: rows.map(row => { const order = { ...row, items: items[row.id] || [], statusLabel: fulfillmentLabel(row), originalAmount: centsToMoney(row.original_amount_cents), discountAmount: centsToMoney(row.discount_amount_cents), payableAmount: centsToMoney(row.payable_amount_cents), storedPaid: centsToMoney(row.stored_paid_cents), bonusPaid: centsToMoney(row.bonus_paid_cents), wechatPaid: centsToMoney(row.wechat_paid_cents), netSales: centsToMoney(row.payable_amount_cents - row.bonus_paid_cents) }; delete order.cost_cents; if (req.staff.role === 'super') { order.cost = centsToMoney(row.cost_cents); order.profit = row.payment_status === 'paid' ? centsToMoney(row.payable_amount_cents - row.bonus_paid_cents - row.cost_cents) : null; } return order; }) });
});
router.post('/admin/orders/:id/deliver', (req, res) => {
  const result = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.status === 'completed') return { code: 200 };
    if (order.payment_status !== 'paid' || order.status !== 'awaiting_delivery') return { code: 409, message: '仅已支付的待送达订单可确认送达' };
    db.prepare("UPDATE orders SET status = 'completed', delivered_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
    audit(req, '确认订单送达', order.order_no);
    return { code: 200 };
  })();
  res.status(result.code).json(result.message ? { message: result.message } : { ok: true });
});
router.post('/admin/orders/:id/mark-paid', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.payment_status === 'paid') return res.json({ ok: true });
  if (order.payment_method === 'mixed') return res.status(409).json({ message: '组合支付订单需完成微信支付后再结算，不能直接确认线下收款' });
  if (order.payment_method === 'balance') return res.status(409).json({ message: '余额订单不能确认线下收款' });
  try { db.transaction(() => {
    settleOrder(order, 'offline', req);
    db.prepare('UPDATE orders SET offline_paid_cents = payable_amount_cents WHERE id = ?').run(order.id);
    audit(req, '确认线下收款', order.order_no);
  })(); res.json({ ok: true }); } catch (error) { res.status(409).json({ message: error.message }); }
});

const validPhone = phone => /^1[3-9]\d{9}$/.test(phone);
const memberView = row => ({ id: row.id, phone: row.phone, nickname: row.nickname, avatarUrl: row.avatar_url, wechatBound: Boolean(row.wechat_openid), memberTierId: row.member_tier_id, memberLevel: row.member_level, memberDiscount: row.member_discount, memberExpiresAt: row.member_expires_at, points: row.points, stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents), createdAt: row.created_at });
const memberQuery = `SELECT u.*, COALESCE(w.stored_cents,0) AS stored_cents, COALESCE(w.bonus_cents,0) AS bonus_cents FROM users u LEFT JOIN wallet_accounts w ON w.user_id = u.id`;
const tiers = () => db.prepare('SELECT * FROM member_tiers WHERE store_id = 1 ORDER BY sort, threshold_cents, id').all();
router.get('/admin/members', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (phone && !/^\d{1,11}$/.test(phone)) return res.status(400).json({ message: '请输入手机号数字' });
  const rows = phone ? db.prepare(`${memberQuery} WHERE u.phone LIKE ? ORDER BY u.id DESC LIMIT 100`).all(`${phone}%`) : db.prepare(`${memberQuery} ORDER BY u.id DESC LIMIT 100`).all();
  res.json({ members: rows.map(memberView), tiers: tiers() });
});
router.post('/admin/members', (req, res) => {
  const phone = String(req.body?.phone || '').trim(), nickname = String(req.body?.nickname || '').trim();
  if (!validPhone(phone) || !nickname || nickname.length > 50) return res.status(400).json({ message: '请输入有效手机号和姓名' });
  try { const id = db.prepare('INSERT INTO users (phone, nickname) VALUES (?, ?)').run(phone, nickname).lastInsertRowid; audit(req, '创建会员', `ID ${id} 手机尾号 ${phone.slice(-4)}`); res.status(201).json({ member: memberView(db.prepare(`${memberQuery} WHERE u.id = ?`).get(id)) }); }
  catch { res.status(409).json({ message: '手机号已绑定其他会员' }); }
});
router.patch('/admin/members/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '会员不存在' });
  const b = req.body || {}, phone = String(b.phone ?? current.phone ?? '').trim(), nickname = String(b.nickname ?? current.nickname).trim();
  const tierId = b.memberTierId === '' ? null : b.memberTierId == null ? current.member_tier_id : Number(b.memberTierId);
  const tier = tierId == null ? null : db.prepare("SELECT * FROM member_tiers WHERE id = ? AND store_id = 1 AND status = 'active'").get(tierId);
  const points = b.points == null ? current.points : Number(b.points);
  const moneyInput = value => value == null ? null : value === '' || !Number.isFinite(Number(value)) || !Number.isSafeInteger(Number(value) * 100) ? NaN : Math.round(Number(value) * 100);
  const stored = moneyInput(b.stored), bonus = moneyInput(b.bonus);
  const walletBefore = db.prepare('SELECT stored_cents, bonus_cents FROM wallet_accounts WHERE user_id = ?').get(current.id) || { stored_cents: 0, bonus_cents: 0 };
  const moneyChanged = (stored != null && stored !== walletBefore.stored_cents) || (bonus != null && bonus !== walletBefore.bonus_cents);
  const changedTier = tierId !== current.member_tier_id;
  const defaultExpiry = changedTier ? (tier?.duration_days ? new Date(Date.now() + tier.duration_days * 86400000) : null) : current.member_expires_at;
  const expiry = b.memberExpiresAt ? new Date(`${b.memberExpiresAt}T23:59:59.999+08:00`) : defaultExpiry;
  if (!validPhone(phone) || !nickname || nickname.length > 50 || (tierId != null && !tier) || !Number.isSafeInteger(points) || points < 0 || [stored,bonus].some(v => v != null && (!Number.isSafeInteger(v) || v < 0)) || (expiry instanceof Date && Number.isNaN(expiry.getTime()))) return res.status(400).json({ message: '会员信息、等级或余额无效' });
  if ((points !== current.points || moneyChanged) && !String(b.reason || '').trim()) return res.status(400).json({ message: '调整积分或钱包余额必须填写原因' });
  try {
    db.transaction(() => {
      db.prepare('UPDATE users SET phone = ?, nickname = ?, member_tier_id = ?, member_level = ?, member_discount = ?, member_expires_at = ?, points = ? WHERE id = ?').run(phone, nickname, tierId, tier?.name || '普通会员', tier?.discount || 1, expiry instanceof Date ? expiry.toISOString() : expiry, points, current.id);
      if (points !== current.points) db.prepare('INSERT INTO points_ledger (user_id, points, reason) VALUES (?, ?, ?)').run(current.id, points - current.points, `后台调整：${String(b.reason || '').trim()}`);
      if (stored != null || bonus != null) {
        db.prepare('INSERT OR IGNORE INTO wallet_accounts (user_id) VALUES (?)').run(current.id);
        const wallet = db.prepare('SELECT * FROM wallet_accounts WHERE user_id = ?').get(current.id);
        const storedDelta = (stored ?? wallet.stored_cents) - wallet.stored_cents, bonusDelta = (bonus ?? wallet.bonus_cents) - wallet.bonus_cents;
        if (storedDelta || bonusDelta) {
          db.prepare('UPDATE wallet_accounts SET stored_cents = ?, bonus_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(stored ?? wallet.stored_cents, bonus ?? wallet.bonus_cents, current.id);
          db.prepare('INSERT INTO wallet_transactions (user_id, type, stored_cents, bonus_cents, remark) VALUES (?, ?, ?, ?, ?)').run(current.id, 'admin_adjustment', storedDelta, bonusDelta, `后台调整：${String(b.reason || '').trim()}`);
        }
      }
      audit(req, '修改会员', `ID ${current.id} 手机尾号 ${phone.slice(-4)}: ${String(b.reason || '').trim()}`);
    })();
    res.json({ member: memberView(db.prepare(`${memberQuery} WHERE u.id = ?`).get(current.id)) });
  } catch (error) { res.status(409).json({ message: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '手机号已绑定其他会员' : error.message }); }
});
router.get('/me', (req, res) => { const user = db.prepare('SELECT id, nickname, avatar_url, member_level, points, member_expires_at FROM users WHERE id = ?').get(currentUserId(req)); if (!user) return res.status(404).json({ message: '用户不存在' }); const wallet = db.prepare('SELECT stored_cents, bonus_cents FROM wallet_accounts WHERE user_id = ?').get(user.id) || { stored_cents: 0, bonus_cents: 0 }; res.json({ user, wallet: { stored: centsToMoney(wallet.stored_cents), bonus: centsToMoney(wallet.bonus_cents) } }); });
const miniEntries = { rewards: { title: '兑换中心', icon: 'gift' }, storage: { title: '我的存酒', icon: 'bottle' }, recharge: { title: '会员充值', icon: 'wallet' }, orders: { title: '我的订单', icon: 'receipt' } };
const miniIcons = ['gift','bottle','wallet','receipt','star','glass','card','bag'];
router.get('/mini-page', (_req, res) => {
  const saved = Object.fromEntries(db.prepare('SELECT * FROM mini_page_settings').all().map(row => [row.key, row]));
  res.json({ entries: Object.entries(miniEntries).map(([key, defaults]) => ({ key, title: saved[key]?.title || defaults.title, icon: saved[key]?.icon || defaults.icon })) });
});
router.get('/wallet-packages', (_req, res) => res.json({ packages: db.prepare("SELECT id, name, pay_cents, stored_cents, bonus_cents FROM wallet_packages WHERE status = 'active' ORDER BY pay_cents").all().map(row => ({ id: row.id, name: row.name, pay: centsToMoney(row.pay_cents), stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) })) }));
const rewardQuery = 'SELECT r.*, p.image_url AS product_image, p.name AS product_name FROM reward_items r LEFT JOIN products p ON p.id = r.product_id';
const rewardView = row => ({ ...row, imageUrl: row.image_url || row.product_image || '', name: row.product_id ? row.product_name : row.name });
router.get('/rewards', (_req, res) => res.json({ rewards: db.prepare(`${rewardQuery} WHERE r.status = 'active' ORDER BY r.id DESC`).all().map(rewardView) }));
router.get('/me/redemptions', (req, res) => res.json({ redemptions: db.prepare('SELECT * FROM reward_redemptions WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(currentUserId(req)) }));
router.post('/rewards/:id/redeem', (req, res) => {
  try {
    const record = db.transaction(() => {
      const reward = db.prepare("SELECT * FROM reward_items WHERE id = ? AND status = 'active'").get(req.params.id);
      if (!reward) throw new Error('奖品已下架');
      if (reward.product_id) {
        const product = db.prepare("SELECT stock FROM products WHERE id = ? AND status = 'active'").get(reward.product_id);
        if (!product || product.stock < 1) throw new Error('商品库存不足');
      }
      const user = db.prepare('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?').run(reward.points, currentUserId(req), reward.points);
      if (!user.changes) throw new Error('积分不足');
      const stock = db.prepare('UPDATE reward_items SET stock = stock - 1 WHERE id = ? AND stock > 0').run(reward.id);
      if (!stock.changes) throw new Error('奖品库存不足');
      if (reward.product_id) db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(reward.product_id);
      const id = db.prepare('INSERT INTO reward_redemptions (user_id, reward_id, reward_name, points) VALUES (?, ?, ?, ?)').run(currentUserId(req), reward.id, reward.name, reward.points).lastInsertRowid;
      db.prepare('INSERT INTO points_ledger (user_id, points, reason) VALUES (?, ?, ?)').run(currentUserId(req), -reward.points, `兑换奖品：${reward.name}`);
      return db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(id);
    })();
    res.status(201).json({ redemption: record });
  } catch (error) { res.status(409).json({ message: error.message }); }
});
router.get('/me/orders', (req, res) => res.json({ orders: db.prepare('SELECT * FROM orders WHERE payer_user_id = ? ORDER BY id DESC LIMIT 100').all(currentUserId(req)).map(row => ({ ...row, originalAmount: centsToMoney(row.original_amount_cents), discountAmount: centsToMoney(row.discount_amount_cents), payableAmount: centsToMoney(row.payable_amount_cents), storedPaid: centsToMoney(row.stored_paid_cents), bonusPaid: centsToMoney(row.bonus_paid_cents), wechatPaid: centsToMoney(row.wechat_paid_cents), paymentMethodLabel: ({ balance: '余额支付', mixed: '余额 + 微信支付', wechat: '微信支付', offline: '线下收款' })[row.payment_method] || '其他', paymentStatusLabel: row.payment_status === 'paid' ? '已支付' : row.payment_status === 'pending' ? '待支付' : '已取消', fulfillmentLabel: fulfillmentLabel(row) })) }));
function storageView(row) {
  const remainingDays = Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 86400000));
  const expiresDate = row.expires_at.slice(0, 10);
  return { ...row, expiresAt: row.expires_at, expiresDate, remainingDays, expired: new Date(row.expires_at) <= new Date(), statusLabel: row.status === 'collected' ? '已取完' : new Date(row.expires_at) <= new Date() ? '已过期' : '存放中' };
}
router.get('/me/storage', (req, res) => res.json({ records: db.prepare("SELECT s.*, p.image_url, p.color FROM storage_records s LEFT JOIN products p ON p.id = s.product_id WHERE s.user_id = ? AND s.status = 'stored' AND s.quantity > 0 ORDER BY s.id DESC").all(currentUserId(req)).map(storageView) }));
router.get('/admin/inventory', (_req, res) => res.json({ products: adminRows('SELECT id, name, stock, status, allow_bonus FROM products ORDER BY stock, id').map(row => ({ ...row, warning: row.stock <= 20 })) }));
router.post('/admin/inventory/:productId/adjust', (req, res) => { const product = db.prepare('SELECT stock FROM products WHERE id = ?').get(req.params.productId); if (!product) return res.status(404).json({ message: '商品不存在' }); const change = Number(req.body.change); if (!Number.isInteger(change) || change === 0 || !String(req.body.reason || '').trim()) return res.status(400).json({ message: '请输入非零变动数量和原因' }); const after = product.stock + change; if (after < 0) return res.status(400).json({ message: '库存不能小于零' }); db.transaction(() => { db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(after, req.params.productId); db.prepare('INSERT INTO inventory_logs (product_id, change_quantity, stock_after, reason) VALUES (?, ?, ?, ?)').run(req.params.productId, change, after, req.body.reason.trim()); audit(req, '调整库存', `${req.params.productId}: ${change}, ${req.body.reason.trim()}`); })(); res.json({ ok: true, stock: after }); });
router.get('/admin/losses', (req, res) => res.json({ records: db.prepare('SELECT l.*, p.name AS product_name, a.display_name AS operator FROM stock_losses l JOIN products p ON p.id = l.product_id JOIN staff_accounts a ON a.id = l.operator_id ORDER BY l.id DESC LIMIT 200').all().map(row => { const record = { ...row }; delete record.cost_cents; if (req.staff.role === 'super') record.cost = centsToMoney(row.cost_cents); return record; }) }));
router.post('/admin/losses', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.body?.productId);
  const quantity = Number(req.body?.quantity), type = req.body?.type, reason = String(req.body?.reason || '').trim();
  if (!product || !Number.isInteger(quantity) || quantity < 1 || !['gift','damage'].includes(type) || !reason) return res.status(400).json({ message: '请选择商品、数量、类型并填写原因' });
  try { const record = db.transaction(() => { const updated = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(quantity, product.id, quantity); if (!updated.changes) throw new Error('库存不足'); const r = db.prepare('INSERT INTO stock_losses (product_id, quantity, cost_cents, type, reason, operator_id) VALUES (?, ?, ?, ?, ?, ?)').run(product.id, quantity, product.cost_cents * quantity, type, reason, req.staff.id); audit(req, type === 'gift' ? '上报赠酒' : '上报报损', `${product.name} x${quantity}: ${reason}`); return db.prepare('SELECT * FROM stock_losses WHERE id = ?').get(r.lastInsertRowid); })(); if (req.staff.role !== 'super') delete record.cost_cents; res.status(201).json({ record }); } catch (error) { res.status(409).json({ message: error.message }); }
});

router.get('/admin/storage', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (phone && !/^\d{1,11}$/.test(phone)) return res.status(400).json({ message: '请输入手机号数字' });
  const all = adminRows("SELECT s.*, u.nickname, u.phone FROM storage_records s JOIN users u ON u.id = s.user_id WHERE s.status = 'stored' AND s.quantity > 0 ORDER BY s.id DESC").map(row => ({ ...row, expired: new Date(row.expires_at) < new Date() }));
  const movements = adminRows('SELECT m.*, s.product_name, u.nickname, u.phone FROM storage_movements m JOIN storage_records s ON s.id = m.record_id JOIN users u ON u.id = s.user_id ORDER BY m.id DESC LIMIT 100');
  res.json({ records: phone ? all.filter(r => r.phone?.startsWith(phone)) : all, movements: phone ? movements.filter(r => r.phone?.startsWith(phone)) : movements, stats: { remaining: all.filter(r => r.status === 'stored' && !r.expired).reduce((n, r) => n + r.quantity, 0), expiring: all.filter(r => r.status === 'stored' && r.quantity > 0 && !r.expired && new Date(r.expires_at) < new Date(Date.now() + 7 * 86400000)).length } });
});
router.post('/admin/storage', (req, res) => {
  const { productId, note = '' } = req.body || {};
  const phone = String(req.body?.phone || '').trim();
  const days = Number(req.body?.days);
  const quantity = Number(req.body?.quantity);
  const product = db.prepare("SELECT id, name FROM products WHERE id = ? AND status = 'active'").get(productId);
  const user = validPhone(phone) && db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  const expiry = new Date(Date.now() + days * 86400000);
  if (!product || !user || !Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ message: '请输入已绑定的会员手机号、在售商品及有效数量和天数' });
  const record = db.transaction(() => {
    const r = db.prepare('INSERT INTO storage_records (user_id, store_id, product_id, product_name, quantity, expires_at, note) VALUES (?, 1, ?, ?, ?, ?, ?)').run(user.id, product.id, product.name, quantity, expiry.toISOString(), String(note).trim());
    db.prepare('INSERT INTO storage_movements (record_id, type, quantity, operator, note) VALUES (?, ?, ?, ?, ?)').run(r.lastInsertRowid, 'deposit', quantity, req.staff.username, String(note).trim());
    audit(req, '登记存酒', `${user.id}: ${product.name} x${quantity}`);
    return db.prepare('SELECT * FROM storage_records WHERE id = ?').get(r.lastInsertRowid);
  })();
  res.status(201).json({ record: storageView(record), expiresAt: expiry.toISOString(), days });
});
router.post('/admin/storage/:id/withdraw', (req, res) => {
  const quantity = Number(req.body?.quantity);
  const record = db.prepare('SELECT * FROM storage_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ message: '存酒记录不存在' });
  if (record.status !== 'stored' || new Date(record.expires_at) < new Date()) return res.status(409).json({ message: '该存酒已取完或过期' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > record.quantity) return res.status(400).json({ message: `取酒数量须为 1 至 ${record.quantity}` });
  db.transaction(() => {
    db.prepare("UPDATE storage_records SET quantity = quantity - ?, status = CASE WHEN quantity = ? THEN 'collected' ELSE status END WHERE id = ?").run(quantity, quantity, record.id);
    db.prepare('INSERT INTO storage_movements (record_id, type, quantity, operator, note) VALUES (?, ?, ?, ?, ?)').run(record.id, 'withdraw', quantity, req.staff.username, String(req.body.note || '').trim());
    audit(req, '取酒', `${record.id}: ${record.product_name} x${quantity}`);
  })();
  res.json({ record: db.prepare('SELECT * FROM storage_records WHERE id = ?').get(record.id) });
});

router.get('/admin/group-buy', (_req, res) => res.json({ records: adminRows('SELECT * FROM group_buy_records ORDER BY id DESC') }));
router.post('/admin/group-buy/verify', (req, res) => { if (!req.body.platform || !req.body.voucherNo) return res.status(400).json({ message: '平台和券码不能为空' }); const existing = db.prepare('SELECT id FROM group_buy_records WHERE platform = ? AND voucher_no = ?').get(req.body.platform, req.body.voucherNo); if (existing) return res.status(409).json({ message: '该券码已核销' }); const r = db.prepare('INSERT INTO group_buy_records (store_id, platform, voucher_no, package_name, amount_cents, verified_by) VALUES (1, ?, ?, ?, ?, ?)').run(req.body.platform, req.body.voucherNo, req.body.packageName || '团购套餐', Math.round(Number(req.body.amount || 0) * 100), req.staff.username); audit(req, '录入团购券', `${req.body.platform}: ${req.body.voucherNo}`); res.status(201).json({ record: db.prepare('SELECT * FROM group_buy_records WHERE id = ?').get(r.lastInsertRowid), message: '核销记录已保存，真实平台查券接口需配置商户授权' }); });

router.get('/admin/wallet-packages', (_req, res) => { const balance = db.prepare('SELECT COALESCE(SUM(stored_cents),0) AS stored, COALESCE(SUM(bonus_cents),0) AS bonus FROM wallet_accounts').get(); res.json({ packages: adminRows('SELECT * FROM wallet_packages ORDER BY id DESC').map(row => ({ ...row, pay: centsToMoney(row.pay_cents), stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) })), outstanding: { stored: centsToMoney(balance.stored), bonus: centsToMoney(balance.bonus) } }); });
router.get('/admin/rewards', (_req, res) => res.json({ rewards: db.prepare(`${rewardQuery} ORDER BY r.id DESC`).all().map(rewardView), redemptions: db.prepare('SELECT rr.*, u.nickname, u.phone FROM reward_redemptions rr JOIN users u ON u.id = rr.user_id ORDER BY rr.id DESC LIMIT 100').all() }));
router.post('/admin/rewards/redemptions/:id/fulfill', (req, res) => {
  const record = db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ message: '兑换记录不存在' });
  if (record.status !== 'pending') return res.status(409).json({ message: '奖品已领取' });
  db.transaction(() => { db.prepare("UPDATE reward_redemptions SET status = 'fulfilled' WHERE id = ? AND status = 'pending'").run(record.id); audit(req, '发放积分奖品', `${record.reward_name} #${record.id}`); })();
  res.json({ ok: true });
});
const rewardInput = (body, current = {}) => {
  const productId = body.productId === '' ? null : body.productId == null ? current.product_id ?? null : Number(body.productId);
  const product = productId == null ? null : db.prepare('SELECT id, name, image_url FROM products WHERE id = ?').get(productId);
  const name = String(body.name ?? current.name ?? '').trim(), imageUrl = String(body.imageUrl ?? current.image_url ?? '').trim();
  const points = Number(body.points ?? current.points), stock = Number(body.stock ?? current.stock ?? 0), status = body.status ?? current.status ?? 'active';
  if ((productId != null && !product) || (!product && (!name || name.length > 50)) || !Number.isSafeInteger(points) || points < 1 || !Number.isSafeInteger(stock) || stock < 0 || !['active','inactive'].includes(status)) return null;
  return { productId, name: product?.name || name, imageUrl, points, stock, status };
};
router.post('/admin/rewards', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可配置积分奖品' });
  const item = rewardInput(req.body || {});
  if (!item) return res.status(400).json({ message: '奖品、积分或库存无效' });
  const id = db.prepare('INSERT INTO reward_items (product_id, name, image_url, points, stock, status) VALUES (?, ?, ?, ?, ?, ?)').run(item.productId, item.name, item.imageUrl, item.points, item.stock, item.status).lastInsertRowid;
  audit(req, '新增积分奖品', item.name); res.status(201).json({ reward: db.prepare('SELECT * FROM reward_items WHERE id = ?').get(id) });
});
router.patch('/admin/rewards/:id', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可配置积分奖品' });
  const current = db.prepare('SELECT * FROM reward_items WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '奖品不存在' });
  const item = rewardInput(req.body || {}, current);
  if (!item) return res.status(400).json({ message: '奖品、积分或库存无效' });
  db.prepare('UPDATE reward_items SET product_id = ?, name = ?, image_url = ?, points = ?, stock = ?, status = ? WHERE id = ?').run(item.productId, item.name, item.imageUrl, item.points, item.stock, item.status, current.id);
  audit(req, '修改积分奖品', item.name); res.json({ ok: true });
});
router.get('/admin/mini-page', (_req, res) => res.json({ entries: Object.entries(miniEntries).map(([key, defaults]) => ({ key, ...defaults, ...db.prepare('SELECT title, icon FROM mini_page_settings WHERE key = ?').get(key) })), icons: miniIcons }));
router.put('/admin/mini-page', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可修改小程序页面' });
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || entries.length !== Object.keys(miniEntries).length || entries.some(item => !miniEntries[item.key] || !String(item.title || '').trim() || String(item.title).length > 8 || !miniIcons.includes(item.icon)) || new Set(entries.map(item => item.key)).size !== entries.length) return res.status(400).json({ message: '页面名称或图标无效' });
  db.transaction(() => { for (const item of entries) db.prepare('INSERT INTO mini_page_settings (key, title, icon) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET title = excluded.title, icon = excluded.icon').run(item.key, item.title.trim(), item.icon); audit(req, '修改小程序页面', entries.map(item => item.title).join('、')); })();
  res.json({ ok: true });
});
router.post('/admin/wallet-packages', (req, res) => { const r = db.prepare('INSERT INTO wallet_packages (store_id, name, pay_cents, stored_cents, bonus_cents, allow_bonus) VALUES (1, ?, ?, ?, ?, ?)').run(req.body.name, Math.round(Number(req.body.pay || 0) * 100), Math.round(Number(req.body.stored || 0) * 100), Math.round(Number(req.body.bonus || 0) * 100), req.body.allowBonus ? 1 : 0); audit(req, '新增储值套餐', req.body.name); res.status(201).json({ package: db.prepare('SELECT * FROM wallet_packages WHERE id = ?').get(r.lastInsertRowid) }); });

router.get('/admin/member-tiers', (_req, res) => res.json({ tiers: tiers() }));
const tierInput = (body, current = {}) => {
  const name = String(body.name ?? current.name ?? '').trim(), upgradeType = body.upgradeType ?? current.upgrade_type ?? 'spend';
  const thresholdValue = Number(body.threshold ?? centsToMoney(current.threshold_cents || 0));
  const threshold = Math.round(thresholdValue * 100);
  const discount = Number(body.discount ?? current.discount ?? 1), pointsRate = Number(body.pointsRate ?? current.points_rate ?? 1);
  const duration = Number(body.durationDays ?? current.duration_days ?? 0), status = body.status ?? current.status ?? 'active';
  if (!name || name.length > 30 || !['spend','recharge','monthly'].includes(upgradeType) || !Number.isSafeInteger(threshold) || threshold <= 0 || !Number.isFinite(discount) || discount <= 0 || discount > 1 || !Number.isFinite(pointsRate) || pointsRate < 0 || pointsRate > 100 || !Number.isInteger(duration) || duration < 0 || duration > 3650 || !['active','inactive'].includes(status)) return null;
  return { name, upgradeType, threshold, discount, pointsRate, duration, status };
};
router.post('/admin/member-tiers', (req, res) => {
  const t = tierInput(req.body || {});
  if (!t) return res.status(400).json({ message: '等级名称、升级条件或优惠无效' });
  const id = db.prepare('INSERT INTO member_tiers (store_id, name, upgrade_type, threshold_cents, discount, points_rate, duration_days, status) VALUES (1, ?, ?, ?, ?, ?, ?, ?)').run(t.name, t.upgradeType, t.threshold, t.discount, t.pointsRate, t.duration, t.status).lastInsertRowid;
  audit(req, '新增会员等级', t.name); res.status(201).json({ tier: db.prepare('SELECT * FROM member_tiers WHERE id = ?').get(id) });
});
router.patch('/admin/member-tiers/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM member_tiers WHERE id = ? AND store_id = 1').get(req.params.id);
  if (!current) return res.status(404).json({ message: '等级不存在' });
  const t = tierInput(req.body || {}, current);
  if (!t) return res.status(400).json({ message: '等级名称、升级条件或优惠无效' });
  db.transaction(() => {
    db.prepare('UPDATE member_tiers SET name = ?, upgrade_type = ?, threshold_cents = ?, discount = ?, points_rate = ?, duration_days = ?, status = ? WHERE id = ?').run(t.name, t.upgradeType, t.threshold, t.discount, t.pointsRate, t.duration, t.status, current.id);
    db.prepare('UPDATE users SET member_level = ?, member_discount = ? WHERE member_tier_id = ?').run(t.name, t.discount, current.id);
    audit(req, '修改会员等级', `${current.name} -> ${t.name}`);
  })();
  res.json({ tier: db.prepare('SELECT * FROM member_tiers WHERE id = ?').get(current.id) });
});

router.get('/admin/reports', (req, res) => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const today = todayLocalDate();
  const end = datePattern.test(String(req.query.end || '')) ? String(req.query.end) : today;
  const start = datePattern.test(String(req.query.start || '')) ? String(req.query.start) : db.prepare("SELECT date(?, '-29 day') AS day").get(today).day;
  if (start > end) return res.status(400).json({ message: '开始日期不能晚于结束日期' });
  const totals = db.prepare("SELECT COALESCE(SUM(payable_amount_cents - bonus_paid_cents),0) AS revenue, COALESCE(SUM(bonus_paid_cents),0) AS bonus, COALESCE(SUM(stored_paid_cents),0) AS stored, COALESCE(SUM(wechat_paid_cents),0) AS wechat, COALESCE(SUM(CASE WHEN payment_method = 'offline' THEN payable_amount_cents ELSE offline_paid_cents END),0) AS offline, COALESCE(SUM((SELECT SUM(quantity * cost_price_cents) FROM order_items WHERE order_id = o.id)),0) AS cost FROM orders o WHERE payment_status = 'paid'").get();
  const losses = db.prepare('SELECT COALESCE(SUM(cost_cents),0) AS cost FROM stock_losses').get().cost;
  const balance = db.prepare('SELECT COALESCE(SUM(stored_cents),0) AS stored, COALESCE(SUM(bonus_cents),0) AS bonus FROM wallet_accounts').get();
  const recharge = db.prepare("SELECT COALESCE(SUM(pay_cents),0) AS amount FROM wallet_transactions WHERE type = 'recharge'").get().amount;
  const daily = db.prepare(`SELECT days.day, COALESCE(o.orders,0) AS orders, COALESCE(o.revenue,0) AS revenue, COALESCE(o.order_cost,0) AS order_cost, COALESCE(o.offline,0) AS offline, COALESCE(r.recharge,0) AS recharge, COALESCE(l.loss_cost,0) AS loss_cost FROM (WITH RECURSIVE dates(day) AS (SELECT date(?) UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date(?)) SELECT day FROM dates) days LEFT JOIN (SELECT date(paid_at, 'localtime') AS day, COUNT(*) AS orders, SUM(payable_amount_cents - bonus_paid_cents) AS revenue, SUM((SELECT COALESCE(SUM(quantity * cost_price_cents),0) FROM order_items WHERE order_id = orders.id)) AS order_cost, SUM(CASE WHEN payment_method = 'offline' THEN offline_paid_cents ELSE 0 END) AS offline FROM orders WHERE payment_status = 'paid' AND date(paid_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(paid_at, 'localtime')) o ON o.day = days.day LEFT JOIN (SELECT date(created_at, 'localtime') AS day, SUM(pay_cents) AS recharge FROM wallet_transactions WHERE type = 'recharge' AND date(created_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(created_at, 'localtime')) r ON r.day = days.day LEFT JOIN (SELECT date(created_at, 'localtime') AS day, SUM(cost_cents) AS loss_cost FROM stock_losses WHERE date(created_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(created_at, 'localtime')) l ON l.day = days.day ORDER BY days.day DESC`).all(start, end, start, end, start, end, start, end).map(row => ({ day: row.day, orders: row.orders, revenue: centsToMoney(row.revenue), profit: centsToMoney(row.revenue - row.order_cost - row.loss_cost), recharge: centsToMoney(row.recharge), offline: centsToMoney(row.offline), orderCost: centsToMoney(row.order_cost), lossCost: centsToMoney(row.loss_cost) }));
  res.json({ dateRange: { start, end }, today: daily.find(row => row.day === today) || daily[0], ...(req.staff.role === 'super' ? { totals: { revenue: centsToMoney(totals.revenue), bonusUsed: centsToMoney(totals.bonus), storedUsed: centsToMoney(totals.stored), wechatReceived: centsToMoney(totals.wechat), offlineReceived: centsToMoney(totals.offline), rechargeReceived: centsToMoney(recharge), outstandingStored: centsToMoney(balance.stored), outstandingBonus: centsToMoney(balance.bonus), orderCost: centsToMoney(totals.cost), lossCost: centsToMoney(losses), profit: centsToMoney(totals.revenue - totals.cost - losses) } } : {}), daily, byProduct: adminRows("SELECT product_name, SUM(quantity) AS quantity, SUM(paid_price_cents * quantity) AS amount FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.payment_status = 'paid' GROUP BY product_id ORDER BY quantity DESC LIMIT 20").map(row => ({ ...row, amount: centsToMoney(row.amount) })) });
});

router.get('/admin/reports/export', (req, res) => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const today = todayLocalDate();
  const end = datePattern.test(String(req.query.end || '')) ? String(req.query.end) : today;
  const start = datePattern.test(String(req.query.start || '')) ? String(req.query.start) : end;
  if (start > end) return res.status(400).send('开始日期不能晚于结束日期');
  const rows = db.prepare(`WITH RECURSIVE dates(day) AS (SELECT date(?) UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date(?)) SELECT dates.day, COALESCE(o.orders, 0) AS orders, COALESCE(o.revenue, 0) AS revenue, COALESCE(o.offline, 0) AS offline, COALESCE(o.order_cost, 0) AS order_cost, COALESCE(r.recharge, 0) AS recharge FROM dates LEFT JOIN (SELECT date(paid_at, 'localtime') AS day, COUNT(*) AS orders, SUM(payable_amount_cents - bonus_paid_cents) AS revenue, SUM(CASE WHEN payment_method = 'offline' THEN offline_paid_cents ELSE 0 END) AS offline, SUM((SELECT COALESCE(SUM(quantity * cost_price_cents),0) FROM order_items WHERE order_id = orders.id)) AS order_cost FROM orders WHERE payment_status = 'paid' AND date(paid_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(paid_at, 'localtime')) o ON o.day = dates.day LEFT JOIN (SELECT date(created_at, 'localtime') AS day, SUM(pay_cents) AS recharge FROM wallet_transactions WHERE type = 'recharge' AND date(created_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(created_at, 'localtime')) r ON r.day = dates.day ORDER BY dates.day`).all(start, end, start, end, start, end);
  const csv = ['日期,订单数,订单净销售额,充值收款,线下收款,订单商品成本,赠酒报损成本,净利润', ...rows.map(row => { const loss = db.prepare("SELECT COALESCE(SUM(cost_cents),0) AS value FROM stock_losses WHERE date(created_at, 'localtime') = date(?)").get(row.day).value; return [row.day, row.orders, (row.revenue / 100).toFixed(2), (row.recharge / 100).toFixed(2), (row.offline / 100).toFixed(2), (row.order_cost / 100).toFixed(2), (loss / 100).toFixed(2), ((row.revenue - row.order_cost - loss) / 100).toFixed(2)].join(','); })].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="report-${start}-${end}.csv"; filename*=UTF-8''${encodeURIComponent(`经营报表-${start}-${end}.csv`)}`); res.send(`\ufeff${csv}`);
});
