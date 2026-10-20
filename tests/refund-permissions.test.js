import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateRefundPermissions } from '../server/refund-permissions-schema.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-refund-permissions-'));
Object.assign(process.env, { DATA_DIR: work, ECHO_ENV_FILE: path.join(work, 'missing.env'), NODE_ENV: 'production', ALLOW_DEMO_USER: 'false', ADMIN_INITIAL_PASSWORD: 'refund-permission-fixture' });
const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const nativeFetch = globalThis.fetch, hash = token => crypto.createHash('sha256').update(token).digest('hex');
const tokens = { owner: 'a'.repeat(64), cashier: 'b'.repeat(64), reader: 'c'.repeat(64), manager: 'd'.repeat(64), user: 'e'.repeat(64) };
let server, base;
before(async () => {
  const password = db.prepare('SELECT password_hash FROM staff_accounts WHERE id=1').get().password_hash;
  for (const [id, username, role, permissions] of [[2, 'refund_cashier', 'staff', ['pos','orders','refunds','dashboard']], [3, 'order_reader', 'staff', ['orders','dashboard']], [4, 'new_manager', 'manager', ['orders','dashboard']]]) {
    db.prepare('INSERT INTO staff_accounts(id,username,display_name,password_hash,role,permissions,workspace) VALUES(?,?,?,?,?,?,?)').run(id, username, username, password, role, JSON.stringify(permissions), id === 2 ? 'cashier' : 'admin');
  }
  server = await new Promise(resolve => { const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(() => {
  for (const table of ['work_events','fulfillment_batch_items','fulfillment_batches','refund_transactions','refund_requests','inventory_logs','wallet_transactions','points_ledger','user_messages','order_items','orders','cart_items','session_members','table_sessions','staff_sessions','wechat_sessions']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("UPDATE staff_accounts SET permissions='[\"pos\",\"orders\",\"refunds\",\"dashboard\"]' WHERE id=2").run();
  db.prepare('UPDATE shift_settings SET enabled=0').run();
  db.prepare("UPDATE products SET stock=100,reserved_stock=0,cost_cents=1000,price_cents=3000,status='active' WHERE id=1").run();
  db.prepare('UPDATE wallet_accounts SET stored_cents=10000,bonus_cents=0,stored_reserved_cents=0,bonus_reserved_cents=0').run();
  db.prepare("UPDATE users SET phone='13800138001' WHERE id=1").run();
  for (const [name,id] of [['owner',1],['cashier',2],['reader',3],['manager',4]]) db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(tokens[name]), id, new Date(Date.now()+3600000).toISOString());
  db.prepare('INSERT INTO wechat_sessions(token_hash,user_id,openid,expires_at) VALUES(?,1,?,?)').run(hash(tokens.user), 'refund-fixture', new Date(Date.now()+3600000).toISOString());
  db.prepare("INSERT INTO table_sessions(id,store_id,table_id,session_no) VALUES(1,1,1,'REFUND-PERMISSION')").run();
  db.prepare('INSERT INTO session_members(session_id,user_id) VALUES(1,1)').run();
  db.prepare("INSERT INTO orders(id,order_no,session_id,payer_user_id,original_amount_cents,payable_amount_cents,payment_method,stored_paid_cents,status,payment_status,paid_at) VALUES(100,'REFUND-PERM-ORDER',1,1,6000,6000,'balance',6000,'awaiting_delivery','paid',CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO order_items(id,order_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents) VALUES(100,100,1,'权限测试酒水',2,3000,3000,1000)").run();
  db.prepare('UPDATE products SET stock=stock-2 WHERE id=1').run();
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(work, { recursive:true, force:true }); });
async function call(url, { token=tokens.owner, method='GET', body }={}) {
  const response = await nativeFetch(base+url, { method, headers:{'content-type':'application/json', ...(token?{authorization:`Bearer ${token}`}:{})}, ...(body===undefined?{}:{body:JSON.stringify(body)}) });
  return { status:response.status, body:await response.json() };
}
const post = (url, body, token=tokens.cashier) => call(url, {token,method:'POST',body});
const requestRefund = async () => {
  const result = await post('/me/orders/REFUND-PERM-ORDER/refund-requests', {items:[{orderItemId:100,quantity:1}]}, tokens.user);
  assert.equal(result.status,201,JSON.stringify(result.body)); return result.body.request.id;
};

test('upgrade preserves only existing managers with order access and never grants again after revocation', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.exec("CREATE TABLE staff_accounts(id INTEGER PRIMARY KEY,role TEXT,permissions TEXT); INSERT INTO staff_accounts VALUES(1,'manager','[\"orders\",\"pos\"]'),(2,'staff','[\"orders\"]'),(3,'manager','[\"products\"]')");
    migrateRefundPermissions(legacy);
    const permissions = id => JSON.parse(legacy.prepare('SELECT permissions FROM staff_accounts WHERE id=?').get(id).permissions);
    assert.deepEqual(permissions(1), ['orders','pos','refunds']);
    assert.deepEqual(permissions(2), ['orders']); assert.deepEqual(permissions(3), ['products']);
    legacy.prepare('UPDATE staff_accounts SET permissions=? WHERE id=1').run('["orders"]');
    legacy.prepare('INSERT INTO staff_accounts VALUES(4,?,?)').run('manager','["orders"]');
    migrateRefundPermissions(legacy);
    assert.deepEqual(permissions(1), ['orders']); assert.deepEqual(permissions(4), ['orders']);
  } finally { legacy.close(); }
});

test('an explicitly authorized staff cashier refunds and restocks at most once without acquiring financial or admin access', async () => {
  const body={requestId:crypto.randomUUID(),reason:'退回一瓶未开封酒水',amount:30,stockMode:'restock',stockConfirmed:true,cancelItems:[{orderItemId:100,quantity:1}],returnItems:[{orderItemId:100,quantity:1}]};
  for (let retry=0;retry<2;retry++) assert.equal((await post('/admin/orders/100/refund',body)).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refund_transactions').get().n,1);
  assert.equal(db.prepare('SELECT stored_cents FROM wallet_accounts WHERE user_id=1').get().stored_cents,13000);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,99);
  assert.equal(db.prepare("SELECT operator FROM operation_logs WHERE action='后台退款' ORDER BY id DESC").get().operator,'refund_cashier');
  const order=(await call('/admin/orders',{token:tokens.cashier})).body.orders[0];
  assert.equal(order.profit,undefined); assert.equal(order.cost,undefined);
  for(const url of ['/admin/reports','/admin/accounts','/admin/settings']) assert.equal((await call(url,{token:tokens.cashier})).status,403);
});

test('order readers and managers without the new grant cannot use any refund endpoint', async () => {
  const id=await requestRefund();
  for(const token of [tokens.reader,tokens.manager]) {
    assert.equal((await call('/admin/orders',{token})).status,200);
    assert.equal((await call('/admin/refunds',{token})).status,403);
    for(const path of [`/admin/refunds/${id}/approve`,`/admin/refunds/${id}/reject`,`/admin/refunds/999/query`,'/admin/orders/100/refund']) assert.equal((await post(path,{reason:'无授权',amount:30,requestId:crypto.randomUUID()},token)).status,403);
    assert.equal((await call('/admin/summary',{token})).body.pendingRefunds,0);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refund_transactions').get().n,0);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,98);
});

test('an authorized staff cashier can approve and reject customer requests through the existing flow', async () => {
  let id=await requestRefund();
  assert.equal((await call('/admin/summary',{token:tokens.cashier})).body.pendingRefunds,1);
  assert.equal((await post(`/admin/refunds/${id}/approve`,{})).status,200);
  assert.equal(db.prepare('SELECT reviewed_by FROM refund_requests WHERE id=?').get(id).reviewed_by,2);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,98);
  id=await requestRefund();
  assert.equal((await post(`/admin/refunds/${id}/reject`,{})).status,400);
  assert.equal((await post(`/admin/refunds/${id}/reject`,{reason:'顾客确认继续配送'})).status,200);
  assert.equal(db.prepare('SELECT status FROM refund_requests WHERE id=?').get(id).status,'rejected');
  assert.equal((await post('/admin/refunds/999/query',{})).status,404);
});

test('refund permission requires order access and revocation immediately blocks an existing cashier session', async () => {
  const result=await call('/admin/accounts/2',{method:'PATCH',body:{permissions:['refunds']}});
  assert.equal(result.status,400);
  assert.equal((await post('/admin/accounts',{username:'bad_refund_grant',displayName:'测试',password:'refund-fixture-password',role:'staff',workspace:'admin',permissions:['refunds']},tokens.owner)).status,400);
  assert.equal((await call('/admin/accounts/2',{token:tokens.cashier,method:'PATCH',body:{permissions:['orders','refunds']}})).status,403);
  const id=await requestRefund();
  assert.equal((await call('/admin/accounts/2',{method:'PATCH',body:{permissions:['pos','orders','dashboard']}})).status,200);
  assert.equal((await post(`/admin/refunds/${id}/approve`,{})).status,403);
  assert.equal((await call('/admin/summary',{token:tokens.cashier})).body.pendingRefunds,0);
  assert.equal((await call('/admin/orders',{token:tokens.cashier})).body.orders[0].refundRequest.status,'pending');
  migrateRefundPermissions(db);
  assert.equal((await post(`/admin/refunds/${id}/approve`,{})).status,403);
});
