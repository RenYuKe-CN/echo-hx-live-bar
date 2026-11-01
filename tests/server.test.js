import test, { before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as tar from 'tar';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-hx-tests-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
Object.assign(process.env, {
  DATA_DIR: work, ECHO_ENV_FILE: path.join(work, '.env'), NODE_ENV: 'production', ALLOW_DEMO_USER: 'false',
  ADMIN_INITIAL_PASSWORD: 'test-initial-password-only', WECHAT_APP_ID: 'test-app', WECHAT_MCH_ID: 'test-mch',
  WECHAT_API_V3_KEY: 'x'.repeat(32), WECHAT_MERCHANT_SERIAL: 'test-merchant-serial',
  WECHAT_PLATFORM_SERIAL: 'PUB_KEY_ID_123456', WECHAT_PLATFORM_CERTIFICATE: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  WECHAT_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  WECHAT_NOTIFY_URL: 'https://example.test/api/payments/wechat/notify', WECHAT_REFUND_NOTIFY_URL: ''
});
const databaseModule = await import('../server/db.js');
let db = databaseModule.db;
const { createBackup, restoreBackup } = await import('../server/backup.js');
const { reserveCart, cleanupCartHolds } = await import('../server/catalog.js');
const { createApp } = await import('../server/app.js');
const { reconcileProcessingRefunds, releaseExpiredWechatOrders } = await import('../server/routes.js');
const { verifyNotification } = await import('../server/integrations/wechat.js');
const nativeFetch = globalThis.fetch;
const tokens = { user: 'a'.repeat(64), outsider: 'b'.repeat(64), admin: 'c'.repeat(64) };
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
let server, base;
before(async () => {
  server = await new Promise(resolve => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  db.prepare("INSERT INTO users(id,nickname,phone,wechat_openid) VALUES(2,'Test guest','13800138002','openid-2')").run();
  db.prepare('INSERT INTO wallet_accounts(user_id) VALUES(2)').run();
  db.prepare('INSERT INTO staff_sessions(token_hash,account_id,expires_at) VALUES(?,1,?)').run(hash(tokens.admin), new Date(Date.now() + 3600000).toISOString());
});
beforeEach(() => {
  db.prepare("UPDATE commerce_settings SET open_time='00:00',close_time='00:00'").run();
  process.env.NODE_ENV = 'production';
  process.env.WECHAT_PLATFORM_CERTIFICATE = keys.publicKey.export({ type: 'spki', format: 'pem' });
  process.env.WECHAT_PLATFORM_SERIAL = 'PUB_KEY_ID_123456';
  db.transaction(() => {
    db.prepare('DELETE FROM mini_page_settings').run();
    db.prepare("UPDATE stores SET name='Test Store' WHERE id=1").run();
    db.prepare('INSERT OR REPLACE INTO staff_sessions(token_hash,account_id,expires_at) VALUES(?,1,?)').run(hash(tokens.admin), new Date(Date.now() + 3600000).toISOString());
    for (const table of ['table_switch_commands','work_events','fulfillment_batch_items','fulfillment_batches','service_submit_commands','service_request_notes','service_requests','user_coupons', 'refund_transactions', 'refund_requests', 'inventory_logs', 'wallet_transactions', 'points_ledger', 'order_items', 'orders', 'cart_items', 'session_members', 'table_sessions', 'wechat_sessions', 'user_messages']) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare("UPDATE users SET member_tier_id=NULL,member_level='普通会员',member_discount=1,member_expires_at=NULL,points=0").run();
    db.prepare("UPDATE users SET phone='13800138001',wechat_openid='openid-1' WHERE id=1").run();
    db.prepare("UPDATE member_tiers SET status='inactive'").run();
    db.prepare("UPDATE products SET stock=100,reserved_stock=0,status='active',price_cents=3000,member_price_cents=3000,cost_cents=1000,allow_bonus=0").run();
    db.prepare('UPDATE wallet_accounts SET stored_cents=10000,bonus_cents=0,stored_reserved_cents=0,bonus_reserved_cents=0').run();
    db.prepare("INSERT INTO table_sessions(id,store_id,table_id,session_no) VALUES(1,1,1,'TEST-SESSION')").run();
    db.prepare('INSERT INTO session_members(session_id,user_id) VALUES(1,1)').run();
    for (const [token, id] of [[tokens.user, 1], [tokens.outsider, 2]]) db.prepare('INSERT INTO wechat_sessions(token_hash,user_id,openid,expires_at) VALUES(?,?,?,?)').run(hash(token), id, `openid-${id}`, new Date(Date.now() + 3600000).toISOString());
  })();
});
afterEach(() => { globalThis.fetch = nativeFetch; });
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close(); fs.rmSync(work, { recursive: true, force: true });
});

async function call(url, { token = tokens.user, method = 'GET', body, headers = {}, raw = false } = {}) {
  if (/^\/admin\/orders\/[^/]+\/refund$/.test(url)) body={requestId:crypto.randomUUID(),reason:'测试退款',...body};
  const response = await nativeFetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  return { status: response.status, body: raw ? await response.text() : await response.json() };
}

test('store name is centrally configurable and synchronized with public mini-program settings', async () => {
  const initial = await call('/admin/mini-page', { token: tokens.admin });
  assert.equal(initial.body.entries.find(entry => entry.key === 'app_name').title, 'Test Store');
  const entries = initial.body.entries.map(entry => ({ ...entry, title: entry.key === 'app_name' ? '新店名 · LIVE & BAR' : entry.title }));
  const updated = await call('/admin/mini-page', { token: tokens.admin, method: 'PUT', body: { entries } });
  assert.equal(updated.status, 200);
  assert.equal(db.prepare('SELECT name FROM stores WHERE id=1').get().name, '新店名 · LIVE & BAR');
  const visible = await call('/mini-page', { token: null });
  assert.equal(visible.body.entries.find(entry => entry.key === 'app_name').title, '新店名 · LIVE & BAR');
  assert.equal(visible.body.entries.find(entry => entry.key === 'coupons').icon, 'ticket');
});

test('an empty or overlong store name cannot partially update page settings', async () => {
  const initial = (await call('/admin/mini-page', { token: tokens.admin })).body.entries;
  for (const name of ['  ', '长'.repeat(31)]) {
    const entries = initial.map(entry => ({ ...entry, title: entry.key === 'app_name' ? name : entry.title }));
    assert.equal((await call('/admin/mini-page', { token: tokens.admin, method: 'PUT', body: { entries } })).status, 400);
    assert.equal(db.prepare('SELECT name FROM stores WHERE id=1').get().name, 'Test Store');
  }
});
function addCart() { db.prepare('INSERT INTO cart_items(id,session_id,product_id,quantity,added_by_user_id) VALUES(1,1,1,1,1)').run(); reserveCart(1); }
test('unbound payers cannot create any kind of order or change shared cart, stock, wallet and coupons', async () => {
  addCart();
  db.prepare('UPDATE cart_items SET added_by_user_id=2').run();
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('must not contact payment provider'); };
  const snapshot = () => JSON.stringify(['orders','order_items','cart_items','products','wallet_accounts','wallet_transactions','user_coupons','inventory_logs'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const initial = snapshot();
  for (const phone of [null, '', '   ', 'invalid-phone']) {
    db.prepare('UPDATE users SET phone=? WHERE id=1').run(phone);
    for (const paymentMethod of ['balance', 'wechat', 'mixed']) {
      const result = await call('/sessions/1/orders', { method: 'POST', body: { paymentMethod, phone: '13800138002', userId: 2 } });
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'PHONE_BINDING_REQUIRED');
      assert.equal(snapshot(), initial);
    }
  }
  assert.equal(providerCalls, 0);
  assert.equal((await call('/products?storeId=1')).status, 200);
  assert.equal((await call('/sessions/1/cart')).status, 200);
  assert.equal((await call('/sessions/1/checkout')).status, 200);
  // A zero-price order still needs an identifiable payer.
  db.prepare('UPDATE products SET price_cents=0,member_price_cents=0 WHERE id=1').run();
  assert.equal((await call('/sessions/1/orders', { method: 'POST', body: { paymentMethod: 'balance' } })).body.code, 'PHONE_BINDING_REQUIRED');
});

test('official phone binding allows the retained cart to be ordered without requiring avatar or nickname', async () => {
  addCart();
  db.prepare("UPDATE users SET phone=NULL,nickname='微信用户',avatar_url='' WHERE id=1").run();
  const originalSecret = process.env.WECHAT_APP_SECRET;
  process.env.WECHAT_APP_SECRET = 'test-phone-secret';
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://api.weixin.qq.com/cgi-bin/token?')) return Response.json({ access_token: 'test-phone-token', expires_in: 7200 });
    if (String(url).startsWith('https://api.weixin.qq.com/wxa/business/getuserphonenumber?')) return Response.json({ phone_info: { purePhoneNumber: '13800138001', countryCode: '86' } });
    throw new Error('Unexpected provider call');
  };
  try {
    assert.equal((await call('/sessions/1/orders', { method: 'POST', body: { paymentMethod: 'balance' } })).status, 403);
    const bound = await call('/me/phone', { method: 'POST', body: { code: 'test-authorized-phone-code' } });
    assert.equal(bound.status, 200);
    assert.equal(bound.body.user.phone, '13800138001');
    const result = await call('/sessions/1/orders', { method: 'POST', body: { paymentMethod: 'balance', note: '少冰' } });
    assert.equal(result.status, 201);
    assert.equal(result.body.payment.status, 'paid');
    assert.equal(db.prepare('SELECT payer_phone_snapshot,note FROM orders WHERE id=?').get(result.body.order.id).payer_phone_snapshot, '13800138001');
    assert.equal(result.body.order.note, '少冰');
  } finally {
    if (originalSecret === undefined) delete process.env.WECHAT_APP_SECRET;
    else process.env.WECHAT_APP_SECRET = originalSecret;
  }
});

test('unbound users cannot resume an old pending payment but can still view their orders', async () => {
  makeOrder({ method: 'wechat', status: 'pending_payment', stored: 0, wechat: 6000 });
  db.prepare('UPDATE users SET phone=NULL WHERE id=1').run();
  const original = db.prepare('SELECT * FROM orders WHERE id=100').get();
  globalThis.fetch = async () => { throw new Error('must not create another prepayment'); };
  const result = await call('/me/orders/TEST-ORDER/pay', { method: 'POST' });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'PHONE_BINDING_REQUIRED');
  assert.deepEqual(db.prepare('SELECT * FROM orders WHERE id=100').get(), original);
  assert.equal((await call('/me/orders')).status, 200);
});

function makeOrder({ method = 'balance', status = 'awaiting_delivery', quantity = 2, stored = 6000, wechat = 0, bonus = 0 } = {}) {
  const total = quantity * 3000;
  db.prepare(`INSERT INTO orders(id,order_no,session_id,payer_user_id,original_amount_cents,payable_amount_cents,payment_method,stored_paid_cents,bonus_paid_cents,wechat_paid_cents,status,payment_status,paid_at,delivered_at)
    VALUES(100,'TEST-ORDER',1,1,?,?,?,?,?,?,?, ?,CURRENT_TIMESTAMP,?)`).run(total, total, method, stored, bonus, wechat, status, status === 'pending_payment' ? 'pending' : 'paid', status === 'completed' ? new Date().toISOString() : null);
  db.prepare("INSERT INTO order_items(id,order_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents) VALUES(100,100,1,'Test product',?,3000,3000,1000)").run(quantity);
  db.prepare('UPDATE products SET stock=stock-? WHERE id=1').run(status === 'pending_payment' ? 0 : quantity);
  if (status === 'pending_payment') db.prepare('UPDATE products SET reserved_stock=? WHERE id=1').run(quantity);
  return db.prepare('SELECT * FROM orders WHERE id=100').get();
}
function paymentPayload(extra = {}) {
  return { out_trade_no: 'TEST-ORDER', transaction_id: 'test-transaction', trade_state: 'SUCCESS', appid: 'test-app', mchid: 'test-mch', payer: { openid: 'openid-1' }, amount: { total: 3000, currency: 'CNY' }, ...extra };
}
function refundPayload(refund, status = 'SUCCESS') {
  return { out_trade_no: 'TEST-ORDER', out_refund_no: refund.out_refund_no, mchid: 'test-mch', refund_id: 'test-refund', refund_status: status, status, amount: { refund: refund.wechat_cents, total: 3000, currency: 'CNY' } };
}
function signedNotification(payload, { serial = process.env.WECHAT_PLATFORM_SERIAL, timestamp = String(Math.floor(Date.now() / 1000)), aad = 'transaction' } = {}) {
  const nonce = '123456789012';
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(process.env.WECHAT_API_V3_KEY), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  const body = JSON.stringify({ resource: { algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: aad, ciphertext: ciphertext.toString('base64') } });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${timestamp}\nnotify-nonce\n${body}\n`), keys.privateKey).toString('base64');
  return { body, timestamp, nonce: 'notify-nonce', signature, serial };
}
async function notify(payload, url = '/payments/wechat/notify') {
  const n = signedNotification(payload);
  return call(url, { token: null, method: 'POST', body: n.body, headers: { 'Wechatpay-Timestamp': n.timestamp, 'Wechatpay-Nonce': n.nonce, 'Wechatpay-Signature': n.signature, 'Wechatpay-Serial': n.serial } });
}

test('standard WeChat AES-GCM notification supports appended tag and AAD', () => {
  const payload = paymentPayload();
  assert.deepEqual(verifyNotification(signedNotification(payload)), payload);
  assert.deepEqual(verifyNotification(signedNotification(payload, { aad: '' })), payload);
  assert.throws(() => verifyNotification(signedNotification(payload, { serial: 'PUB_KEY_ID_OTHER' })), { code: 'WECHAT_SERIAL_MISMATCH' });
  assert.throws(() => verifyNotification(signedNotification(payload, { timestamp: String(Math.floor(Date.now() / 1000) - 600) })), { code: 'WECHAT_SIGNATURE_INVALID' });
  assert.throws(() => verifyNotification({ ...signedNotification(payload), signature: 'invalid' }), { code: 'WECHAT_SIGNATURE_INVALID' });
});

test('X.509 serial is parsed from the certificate and PEM paths are supported', () => {
  const privateFile = path.join(work, 'key.pem'), certFile = path.join(work, 'cert.pem');
  fs.writeFileSync(privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const openssl = spawnSync('openssl', ['req', '-new', '-x509', '-key', privateFile, '-out', certFile, '-subj', '/CN=Wechat Test', '-set_serial', '0xABCDEF', '-days', '1'], { encoding: 'utf8' });
  assert.equal(openssl.status, 0, openssl.stderr);
  const pem = fs.readFileSync(certFile, 'utf8');
  process.env.WECHAT_PLATFORM_CERTIFICATE = pem;
  assert.deepEqual(verifyNotification(signedNotification(paymentPayload(), { serial: 'ABCDEF' })), paymentPayload());
  process.env.WECHAT_PLATFORM_CERTIFICATE = certFile;
  assert.deepEqual(verifyNotification(signedNotification(paymentPayload(), { serial: 'ab:cd:ef' })), paymentPayload());
});

test('nonmembers and anonymous users cannot read, modify, or pay another table cart', async () => {
  addCart();
  for (const [url, method, body] of [
    ['/sessions/1/cart', 'GET'], ['/sessions/1/checkout', 'GET'],
    ['/sessions/1/cart/items', 'POST', { productId: 1 }],
    ['/sessions/1/cart/items/1', 'PATCH', { quantity: 0 }],
    ['/sessions/1/orders', 'POST', { paymentMethod: 'balance' }],
    ['/sessions/1/coupons/1/use', 'POST']
  ]) {
    assert.equal((await call(url, { token: tokens.outsider, method, body })).status, 403);
    assert.equal((await call(url, { token: null, method, body })).status, 401);
  }
  assert.equal(db.prepare('SELECT status FROM cart_items WHERE id=1').get().status, 'pending');
});

test('demo authentication is enabled only in explicit development mode', async () => {
  delete process.env.NODE_ENV;
  assert.equal((await call('/me', { token: null, headers: { 'x-demo-user-id': '1' } })).status, 401);
  process.env.NODE_ENV = 'development';
  assert.equal((await call('/me', { token: null, headers: { 'x-demo-user-id': '1' } })).status, 401);
  process.env.ALLOW_DEMO_USER = 'true';
  try { assert.equal((await call('/me', { token: null, headers: { 'x-demo-user-id': '1' } })).status, 200); }
  finally { process.env.ALLOW_DEMO_USER = 'false'; }
});

test('joined guests can share a cart; a closed session cannot be modified', async () => {
  addCart();
  assert.equal((await call('/tables/A-08/session', { token: tokens.outsider })).status, 409);
  assert.equal((await call('/tables/select',{token:tokens.outsider,method:'POST',body:{tableId:1,confirmed:true,requestId:crypto.randomUUID()}})).status,200);
  assert.equal((await call('/sessions/1/cart', { token: tokens.outsider })).body.items.length, 1);
  assert.equal((await call('/sessions/1/cart/items/1', { token: tokens.outsider, method: 'PATCH', body: { quantity: 2 } })).status, 200);
  db.prepare("UPDATE table_sessions SET status='closed' WHERE id=1").run();
  assert.equal((await call('/sessions/1/cart/items/1', { method: 'PATCH', body: { quantity: 0 } })).status, 409);
});

test('POS and mini-program cannot spend frozen stored balance or bonus', async () => {
  addCart();
  db.prepare('UPDATE products SET allow_bonus=1 WHERE id=1').run();
  db.prepare('UPDATE wallet_accounts SET stored_cents=10000,stored_reserved_cents=9000,bonus_cents=3000,bonus_reserved_cents=3000 WHERE user_id=1').run();
  const before = db.prepare('SELECT * FROM wallet_accounts WHERE user_id=1').get();
  assert.equal((await call('/admin/pos/orders', { token: tokens.admin, method: 'POST', body: { tableId: 1, phone: '13800138001', items: [{ productId: 1, quantity: 1 }], paymentMethod: 'balance', requestId: crypto.randomUUID() } })).status, 409);
  assert.equal((await call('/sessions/1/orders', { method: 'POST', body: { paymentMethod: 'balance' } })).status, 409);
  assert.deepEqual(db.prepare('SELECT * FROM wallet_accounts WHERE user_id=1').get(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('POS can spend the unfrozen remainder exactly once using its request ID', async () => {
  db.prepare('UPDATE wallet_accounts SET stored_cents=10000,stored_reserved_cents=7000 WHERE user_id=1').run();
  const body = { tableId: 1, phone: '13800138001', items: [{ productId: 1, quantity: 1 }], paymentMethod: 'balance', requestId: crypto.randomUUID() };
  for (let i = 0; i < 2; i++) assert.equal((await call('/admin/pos/orders', { token: tokens.admin, method: 'POST', body })).status, 201);
  assert.equal(db.prepare('SELECT stored_cents FROM wallet_accounts WHERE user_id=1').get().stored_cents, 7000);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 99);
});

test('manual wallet adjustment cannot reduce funds below their reservations', async () => {
  db.prepare('UPDATE wallet_accounts SET stored_reserved_cents=9000 WHERE user_id=1').run();
  assert.equal((await call('/admin/members/1', { token: tokens.admin, method: 'PATCH', body: { stored: 10, reason: 'test' } })).status, 409);
  assert.equal(db.prepare('SELECT stored_cents FROM wallet_accounts WHERE user_id=1').get().stored_cents, 10000);
});

test('partial item refund then amount-only full refund returns each unit once', async () => {
  makeOrder();
  const requested = await call('/me/orders/TEST-ORDER/refund-requests', { method: 'POST', body: { items: [{ orderItemId: 100, quantity: 1 }] } });
  assert.equal(requested.status, 201);
  const review = `/admin/refunds/${requested.body.request.id}/approve`;
  assert.equal((await call(review, { token: tokens.admin, method: 'POST', body: {stockMode:'restock',stockConfirmed:true,returnItems:[{orderItemId:100,quantity:1}]} })).status, 200);
  assert.equal((await call(review, { token: tokens.admin, method: 'POST', body: {} })).status, 200);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 99);
  const report = (await call('/admin/reports', { token: tokens.admin })).body;
  assert.equal(report.today.orderCost, 10); assert.equal(report.today.profit, 20);
  const adminOrder = (await call('/admin/orders', { token: tokens.admin })).body.orders[0];
  assert.equal(adminOrder.cost, 10); assert.equal(adminOrder.profit, 20);
  const csv = (await call('/admin/reports/export?format=csv', { token: tokens.admin, raw: true })).body;
  assert.match(csv, /,30\.00,0\.00,0\.00,10\.00,0\.00,20\.00/);
  assert.equal((await call('/admin/orders/100/refund', { token: tokens.admin, method: 'POST', body: { amount: 30,stockMode:'restock',stockConfirmed:true,returnItems:[{orderItemId:100,quantity:1}] } })).status, 200);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 100);
  assert.equal(db.prepare('SELECT returned_quantity FROM order_items WHERE id=100').get().returned_quantity, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_logs').get().n, 2);
  assert.equal((await call('/admin/orders/100/refund', { token: tokens.admin, method: 'POST', body: {} })).status, 400);
});

test('refund after delivery retains consumed cost and does not restock', async () => {
  makeOrder({ status: 'completed' });
  assert.equal((await call('/admin/orders/100/refund', { token: tokens.admin, method: 'POST', body: {} })).status, 200);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 98);
  const report = (await call('/admin/reports', { token: tokens.admin })).body;
  assert.equal(report.today.revenue, 0); assert.equal(report.today.orderCost, 20); assert.equal(report.today.profit, -20);
});

test('verified duplicate payment notifications settle stock, wallet and points only once', async () => {
  makeOrder({ method: 'mixed', status: 'pending_payment', stored: 3000, wechat: 3000 });
  db.prepare('UPDATE wallet_accounts SET stored_reserved_cents=3000 WHERE user_id=1').run();
  for (let i = 0; i < 2; i++) assert.equal((await notify(paymentPayload())).status, 200);
  assert.equal(db.prepare('SELECT stock,reserved_stock FROM products WHERE id=1').get().stock, 98);
  assert.deepEqual(db.prepare('SELECT stored_cents,stored_reserved_cents FROM wallet_accounts WHERE user_id=1').get(), { stored_cents: 7000, stored_reserved_cents: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE type='order_payment'").get().n, 1);
  assert.equal(db.prepare('SELECT points FROM users WHERE id=1').get().points, 60);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind='order_new' AND entity_id=100").get().n, 1);
});

test('an older pending order that pays late produces a fresh work event after newer orders', async () => {
  makeOrder({ method: 'mixed', status: 'pending_payment', stored: 3000, wechat: 3000 });
  db.prepare('UPDATE wallet_accounts SET stored_reserved_cents=3000 WHERE user_id=1').run();
  const newer = await call('/admin/pos/orders', { token: tokens.admin, method: 'POST', body: { tableId: 1, phone: '13800138001', items: [{ productId: 1, quantity: 1 }], paymentMethod: 'cash', requestId: crypto.randomUUID() } });
  assert.equal(newer.status, 201);
  const cursor = db.prepare('SELECT MAX(id) AS id FROM work_events').get().id;
  assert.equal((await notify(paymentPayload())).status, 200);
  const feed = (await call(`/admin/workdesk?after=${cursor}`, { token: tokens.admin })).body;
  assert.ok(feed.events.some(event => event.kind === 'order_new' && event.entity_id === 100));
});

test('signed but mismatched payment data cannot settle an order', async () => {
  makeOrder({ method: 'wechat', status: 'pending_payment', quantity: 1, stored: 0, wechat: 3000 });
  for (const extra of [{ amount: { total: 1, currency: 'CNY' } }, { mchid: 'other' }, { appid: 'other' }, { payer: { openid: 'other' } }]) assert.equal((await notify(paymentPayload(extra))).status, 409);
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=100').get().payment_status, 'pending');
  assert.equal(db.prepare('SELECT reserved_stock FROM products WHERE id=1').get().reserved_stock, 1);
});

test('ambiguous JSAPI failure keeps reservations until WeChat is queried and closed', async () => {
  addCart();
  globalThis.fetch = async () => { throw new TypeError('network timeout'); };
  const order = await call('/sessions/1/orders', { method: 'POST', body: { paymentMethod: 'wechat' } });
  assert.equal(order.status, 502);
  const pending = db.prepare('SELECT * FROM orders').get();
  assert.equal(pending.payment_status, 'pending'); assert.equal(pending.wechat_prepay_id, null);
  assert.equal(db.prepare('SELECT reserved_stock FROM products WHERE id=1').get().reserved_stock, 1);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).endsWith('/close') ? new Response(null, { status: 204 }) : Response.json({ trade_state: 'NOTPAY' });
  };
  assert.equal((await call(`/me/orders/${pending.order_no}/cancel`, { method: 'POST' })).status, 200);
  assert.equal(calls.length, 2); assert.match(calls[1], /\/close$/);
  assert.equal(db.prepare('SELECT reserved_stock FROM products WHERE id=1').get().reserved_stock, 0);
});

test('an expired ambiguous order retains its reservations even if callback configuration is missing', async () => {
  makeOrder({ method: 'mixed', status: 'pending_payment', stored: 3000, wechat: 3000 });
  db.prepare("UPDATE orders SET payment_expire_at='2000-01-01T00:00:00.000Z' WHERE id=100").run();
  db.prepare('UPDATE wallet_accounts SET stored_reserved_cents=3000 WHERE user_id=1').run();
  process.env.WECHAT_PLATFORM_CERTIFICATE = '';
  globalThis.fetch = async () => { throw new TypeError('network timeout'); };
  await releaseExpiredWechatOrders();
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=100').get().payment_status, 'pending');
  assert.equal(db.prepare('SELECT reserved_stock FROM products WHERE id=1').get().reserved_stock, 2);
  assert.equal(db.prepare('SELECT stored_reserved_cents FROM wallet_accounts WHERE user_id=1').get().stored_reserved_cents, 3000);
});

test('a live WeChat trade cannot also be marked paid offline', async () => {
  makeOrder({ method: 'wechat', status: 'pending_payment', quantity: 1, stored: 0, wechat: 3000 });
  assert.equal((await call('/admin/orders/100/mark-paid', { token: tokens.admin, method: 'POST' })).status, 409);
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=100').get().payment_status, 'pending');
});

test('refund recovery queries an interrupted refund and duplicate callback is idempotent', async () => {
  makeOrder({ method: 'wechat', quantity: 1, stored: 0, wechat: 3000 });
  globalThis.fetch = async () => { throw new TypeError('network timeout'); };
  assert.equal((await call('/admin/orders/100/refund', { token: tokens.admin, method: 'POST', body: {} })).status, 200);
  const refund = db.prepare('SELECT * FROM refund_transactions').get();
  assert.equal(refund.status, 'processing');
  globalThis.fetch = async () => Response.json(refundPayload(refund));
  await reconcileProcessingRefunds();
  assert.equal(db.prepare('SELECT status FROM refund_transactions').get().status, 'success');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 99);
  assert.equal((await notify(refundPayload(refund), '/payments/wechat/refund/notify')).status, 200);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 99);
});

test('refund creation derives the refund callback URL rather than the payment callback', async () => {
  makeOrder({ method: 'wechat', quantity: 1, stored: 0, wechat: 3000 });
  let sent;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ ...refundPayload({ out_refund_no: sent.out_refund_no, wechat_cents: 3000 }, 'PROCESSING') });
  };
  assert.equal((await call('/admin/orders/100/refund', { token: tokens.admin, method: 'POST', body: {} })).status, 200);
  assert.equal(sent.notify_url, 'https://example.test/api/payments/wechat/refund/notify');
});

test('a missing interrupted refund is retried with the original refund number', async () => {
  makeOrder({ method: 'wechat', quantity: 1, stored: 0, wechat: 3000 });
  globalThis.fetch = async () => { throw new TypeError('network timeout'); };
  await call('/admin/orders/100/refund', { token: tokens.admin, method: 'POST', body: {} });
  const refund = db.prepare('SELECT * FROM refund_transactions').get();
  const retried = [];
  globalThis.fetch = async (_url, options) => {
    if (!options.method) return Response.json({ code: 'RESOURCE_NOT_EXISTS', message: 'not found' }, { status: 404 });
    retried.push(JSON.parse(options.body).out_refund_no);
    return Response.json(refundPayload(refund));
  };
  await reconcileProcessingRefunds();
  assert.deepEqual(retried, [refund.out_refund_no]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refund_transactions').get().n, 1);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 99);
});

test('an explicit merchant rejection fails the refund and a mismatched callback cannot complete it', async () => {
  makeOrder({ method: 'wechat', quantity: 1, stored: 0, wechat: 3000 });
  globalThis.fetch = async () => Response.json({ code: 'INVALID_REQUEST', message: 'invalid request' }, { status: 400 });
  const result = await call('/admin/orders/100/refund', { token: tokens.admin, method: 'POST', body: {} });
  assert.equal(result.body.refund.status, 'failed');
  const refund = db.prepare('SELECT * FROM refund_transactions').get();
  assert.equal((await notify({ ...refundPayload(refund), amount: { refund: 1, total: 3000, currency: 'CNY' } }, '/payments/wechat/refund/notify')).status, 409);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 99);
});

test('mixed settlement rejects a legacy wallet whose funds are below reservations', async () => {
  makeOrder({ method: 'mixed', status: 'pending_payment', stored: 3000, wechat: 3000 });
  db.prepare('UPDATE wallet_accounts SET stored_cents=2000,stored_reserved_cents=3000 WHERE user_id=1').run();
  const result = await notify(paymentPayload());
  assert.equal(result.status, 500);
  assert.equal(db.prepare('SELECT stored_cents FROM wallet_accounts WHERE user_id=1').get().stored_cents, 2000);
  assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=100').get().payment_status, 'pending');
});

test('legacy return tracking migration is idempotent and does not alter physical stock', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE orders(id INTEGER PRIMARY KEY,status TEXT,delivered_at TEXT);
      CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER,quantity INTEGER);
      CREATE TABLE products(stock INTEGER);
      CREATE TABLE refund_transactions(id INTEGER PRIMARY KEY,order_id INTEGER,status TEXT,items_json TEXT);
      INSERT INTO products VALUES(100);
      INSERT INTO orders VALUES(1,'awaiting_delivery',NULL),(2,'completed','2026-10-01'),(3,'refunded',NULL),(4,'completed','2026-10-01');
      INSERT INTO order_items VALUES(1,1,2),(2,2,2),(3,3,2),(4,4,2);
      INSERT INTO refund_transactions VALUES(1,1,'success','[{"orderItemId":1,"quantity":1}]'),(2,2,'success','[{"orderItemId":2,"quantity":1}]'),(3,3,'success','[]'),(4,4,'success','[]');`);
    databaseModule.migrateRefundStock(legacy);
    databaseModule.migrateRefundStock(legacy);
    assert.deepEqual(legacy.prepare('SELECT returned_quantity FROM order_items ORDER BY id').all().map(item => item.returned_quantity), [1, 1, 2, 0]);
    assert.equal(legacy.prepare('SELECT stock FROM products').get().stock, 100);
    assert.throws(() => legacy.prepare('UPDATE order_items SET returned_quantity=3 WHERE id=1').run(), /CHECK constraint failed/);
  } finally { legacy.close(); }
});

test('restoring a pre-migration backup backfills return quantities without restocking', async () => {
  makeOrder();
  const requested = await call('/me/orders/TEST-ORDER/refund-requests', { method: 'POST', body: { items: [{ orderItemId: 100, quantity: 1 }] } });
  await call(`/admin/refunds/${requested.body.request.id}/approve`, { token: tokens.admin, method: 'POST', body: {stockMode:'restock',stockConfirmed:true,returnItems:[{orderItemId:100,quantity:1}]} });
  const backup = await createBackup();
  const incoming = path.join(work, 'legacy-backup'); fs.mkdirSync(incoming);
  await tar.x({ file: path.join(work, 'backups', backup.name), cwd: incoming });
  const legacyPath = path.join(incoming, 'database.sqlite');
  const legacy = new Database(legacyPath);
  legacy.exec('DROP TABLE cart_stock_holds; ALTER TABLE order_items DROP COLUMN returned_delivered_quantity; ALTER TABLE order_items DROP COLUMN delivered_quantity; ALTER TABLE order_items DROP COLUMN returned_quantity');
  legacy.close();
  const manifestPath = path.join(incoming, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files['database.sqlite'] = crypto.createHash('sha256').update(fs.readFileSync(legacyPath)).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const archive = path.join(work, 'legacy.tar.gz');
  await tar.c({ file: archive, cwd: incoming, gzip: true }, ['manifest.json', 'database.sqlite', 'uploads']);
  await restoreBackup(archive);
  db = databaseModule.db;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_stock_holds').get().n,0);
  assert.equal(db.prepare('SELECT returned_quantity FROM order_items WHERE id=100').get().returned_quantity, 1);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 99);
  assert.equal((await call('/me')).status, 401);
});

test('cart holds arbitrate two tables atomically, expire without reads renewing them, and require explicit reacquisition', async () => {
  db.prepare('UPDATE products SET stock=1 WHERE id=1').run();
  db.prepare("INSERT OR IGNORE INTO tables(id,store_id,table_no,qr_token) VALUES(2,1,'TEST-02','test-02')").run();
  db.prepare("INSERT INTO table_sessions(id,store_id,table_id,session_no) VALUES(2,1,2,'SECOND-TABLE')").run();
  db.prepare('INSERT INTO session_members(session_id,user_id) VALUES(2,2)').run();
  const results = await Promise.all([
    call('/sessions/1/cart/items',{method:'POST',body:{productId:1}}),
    call('/sessions/2/cart/items',{method:'POST',token:tokens.outsider,body:{productId:1}})
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const winner=results[0].status===201?1:2, loser=winner===1?2:1;
  const tokenFor=id=>id===1?tokens.user:tokens.outsider;
  const initial=(await call(`/sessions/${winner}/cart`,{token:tokenFor(winner)})).body;
  assert.equal(initial.reservation.reserved,true); assert.equal(initial.remainingByProduct[1],0);
  assert.equal((await call(`/sessions/${winner}/cart`,{token:tokenFor(winner)})).body.reservation.expiresAt,initial.reservation.expiresAt);
  assert.equal((await call('/products')).body.products.find(p=>p.id===1).stock,0);
  const inventory=(await call('/admin/products',{token:tokens.admin})).body.products.find(p=>p.id===1);
  assert.equal(inventory.physicalStock,1); assert.equal(inventory.cartReservedStock,1); assert.equal(inventory.orderReservedStock,0);
  db.prepare('UPDATE cart_stock_holds SET expires_at=?').run(Date.now()-1);
  assert.equal((await call(`/sessions/${winner}/orders`,{method:'POST',token:tokenFor(winner),body:{paymentMethod:'balance'}})).body.code,'CART_RESERVATION_EXPIRED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,0);
  assert.equal((await call(`/sessions/${loser}/cart/items`,{method:'POST',token:tokenFor(loser),body:{productId:1}})).status,201);
  assert.equal((await call(`/sessions/${winner}/cart/reserve`,{method:'POST',token:tokenFor(winner)})).status,409);
  const winnerCart=(await call(`/sessions/${winner}/cart`,{token:tokenFor(winner)})).body;
  assert.equal(winnerCart.items.length,1); assert.equal(winnerCart.reservation.reserved,false);
  const loserItem=(await call(`/sessions/${loser}/cart`,{token:tokenFor(loser)})).body.items[0];
  assert.equal((await call(`/sessions/${loser}/cart/items/${loserItem.id}`,{method:'PATCH',token:tokenFor(loser),body:{delta:-1}})).status,200);
  assert.equal((await call(`/sessions/${winner}/cart/reserve`,{method:'POST',token:tokenFor(winner)})).status,200);
  assert.equal((await call(`/sessions/${winner}/orders`,{method:'POST',token:tokenFor(winner),body:{paymentMethod:'balance'}})).status,201);
  assert.deepEqual(db.prepare('SELECT stock,reserved_stock FROM products WHERE id=1').get(),{stock:0,reserved_stock:0});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_stock_holds').get().n,0);
});

test('shared cart deltas use current quantity, release on reductions, and do not prevent removing unavailable goods', async () => {
  assert.equal((await call('/sessions/1/cart/items',{method:'POST',body:{productId:1,quantity:2}})).status,201);
  const item=(await call('/sessions/1/cart')).body.items[0];
  db.prepare('INSERT INTO session_members(session_id,user_id) VALUES(1,2)').run();
  const responses=await Promise.all([tokens.user,tokens.outsider].map(token=>call(`/sessions/1/cart/items/${item.id}`,{method:'PATCH',token,body:{delta:1}})));
  assert.ok(responses.every(r=>r.status===200));
  assert.equal((await call('/sessions/1/cart')).body.items[0].quantity,4);
  assert.equal(db.prepare('SELECT SUM(quantity) AS n FROM cart_stock_holds').get().n,4);
  for(const body of [{delta:2},{delta:1,quantity:2},{quantity:-1},{quantity:1.5}]) assert.equal((await call(`/sessions/1/cart/items/${item.id}`,{method:'PATCH',body})).status,400);
  db.prepare("UPDATE products SET status='inactive',auto_unlisted=0 WHERE id=1").run();
  assert.equal((await call(`/sessions/1/cart/items/${item.id}`,{method:'PATCH',body:{delta:-1}})).status,200);
  assert.equal(db.prepare('SELECT SUM(quantity) AS n FROM cart_stock_holds').get().n,3);
  assert.equal((await call('/sessions/1/cart')).body.reservation.reserved,false);
  assert.equal((await call(`/sessions/1/cart/items/${item.id}`,{method:'PATCH',body:{quantity:0}})).status,200);
  assert.equal((await call('/sessions/1/cart')).body.items.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_stock_holds').get().n,0);
});

test('cart holds transfer into payment reservations once and cancellation releases them without silently re-locking the cart', async () => {
  addCart();
  globalThis.fetch=async()=>{throw new TypeError('network timeout');};
  assert.equal((await call('/sessions/1/orders',{method:'POST',body:{paymentMethod:'wechat'}})).status,502);
  assert.equal(db.prepare('SELECT reserved_stock FROM products WHERE id=1').get().reserved_stock,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_stock_holds').get().n,0);
  const order=db.prepare('SELECT * FROM orders').get();
  globalThis.fetch=async url=>String(url).endsWith('/close')?new Response(null,{status:204}):Response.json({trade_state:'NOTPAY'});
  assert.equal((await call(`/me/orders/${order.order_no}/cancel`,{method:'POST'})).status,200);
  const cart=(await call('/sessions/1/cart')).body;assert.equal(cart.items.length,1);assert.equal(cart.reservation.reserved,false);
  assert.equal(db.prepare('SELECT reserved_stock FROM products WHERE id=1').get().reserved_stock,0);
  assert.equal((await call('/sessions/1/cart/reserve',{method:'POST'})).status,200);
  assert.equal(db.prepare('SELECT SUM(quantity) AS n FROM cart_stock_holds').get().n,1);
});

test('inventory adjustments, stocktake and losses cannot consume cart-held units; closed tables release immediately', async () => {
  db.prepare('UPDATE products SET stock=2 WHERE id=1').run();addCart();
  for(const [url,body] of [
    ['/admin/inventory/1/adjust',{change:-2,reason:'盘点'}],
    ['/admin/losses',{productId:1,quantity:2,type:'damage',reason:'报损'}],
    ['/admin/inventory/import/preview',{rows:[{productId:1,stock:0}]}],
    ['/admin/products/1',{stock:0}]
  ]) assert.ok((await call(url,{token:tokens.admin,method:url==='/admin/products/1'?'PATCH':'POST',body})).status>=400);
  db.prepare("UPDATE table_sessions SET status='closed' WHERE id=1").run();
  assert.equal((await call('/products')).body.products.find(p=>p.id===1).stock,2);
  cleanupCartHolds();assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_stock_holds').get().n,0);
});

test('cart-held units survive reopen without extending their deadline and block reward redemptions',async()=>{
  db.prepare('UPDATE products SET stock=1 WHERE id=1').run();addCart();
  const expiry=db.prepare('SELECT expires_at FROM cart_stock_holds').get().expires_at;
  db.close();databaseModule.reopenDatabase();db=databaseModule.db;
  assert.equal(db.prepare('SELECT expires_at FROM cart_stock_holds').get().expires_at,expiry);
  assert.equal((await call('/sessions/1/cart')).body.reservation.reserved,true);
  db.prepare('UPDATE users SET points=100 WHERE id=1').run();
  const reward=db.prepare("INSERT INTO reward_items(product_id,name,points,stock) VALUES(1,'锁定库存测试奖品',10,1)").run().lastInsertRowid;
  assert.equal((await call(`/rewards/${reward}/redeem`,{method:'POST'})).status,409);
  assert.equal(db.prepare('SELECT points FROM users WHERE id=1').get().points,100);
  assert.equal(db.prepare('SELECT stock FROM reward_items WHERE id=?').get(reward).stock,1);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,1);
});
