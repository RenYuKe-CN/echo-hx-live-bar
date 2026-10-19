import test, {before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work=fs.mkdtempSync(path.join(os.tmpdir(),'echo-single-store-'));
Object.assign(process.env,{DATA_DIR:work,ECHO_ENV_FILE:path.join(work,'missing.env'),NODE_ENV:'production',ADMIN_INITIAL_PASSWORD:'single-store-test-password',ALLOW_DEMO_USER:'false'});
const {db}=await import('../server/db.js');
const {reconcileProcessingRefunds}=await import('../server/routes.js');
const {createApp}=await import('../server/app.js');
const {orderCostSql}=await import('../server/refund-stock.js');
const {businessReport}=await import('../server/business-report.js');
const {reportWindow}=await import('../server/business-time.js');
const {migrateSingleStore}=await import('../server/single-store-schema.js');
const {createBackup,backupFile,backupSettings}=await import('../server/backup.js');
const nativeFetch=globalThis.fetch;
const tokens={admin:'a'.repeat(64),cashier:'b'.repeat(64),waiter:'c'.repeat(64),user:'d'.repeat(64),guest:'e'.repeat(64)};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
let server,base;
before(async()=>{
  const password=db.prepare('SELECT password_hash FROM staff_accounts WHERE id=1').get().password_hash;
  for(const [id,username,permissions] of [[2,'cashier',['pos','orders']],[3,'waiter',['workdesk']]])db.prepare('INSERT INTO staff_accounts(id,username,display_name,password_hash,role,permissions) VALUES(?,?,?,?,?,?)').run(id,username,username,password,'staff',JSON.stringify(permissions));
  db.prepare("INSERT INTO users(id,nickname,phone,wechat_openid) VALUES(2,'另一顾客','13800138002','guest-2')").run();
  db.prepare('INSERT INTO wallet_accounts(user_id) VALUES(2)').run();
  db.prepare("INSERT INTO tables(id,store_id,table_no,qr_token) VALUES(2,1,'A-09','fixture-table-2'),(3,1,'A-10','fixture-table-3')").run();
  server=await new Promise(resolve=>{const instance=createApp().listen(0,'127.0.0.1',()=>resolve(instance));});base=`http://127.0.0.1:${server.address().port}/api`;
  globalThis.fetch=async()=>{throw new Error('Tests must not contact external providers');};
});
beforeEach(()=>{
  delete process.env.BACKUP_MIRROR_DIR;
  for(const table of ['shift_ledger','cash_shifts','table_switch_commands','bill_snapshots','work_events','fulfillment_batch_items','fulfillment_batches','service_submit_commands','service_request_notes','service_requests','refund_transactions','refund_requests','inventory_logs','wallet_transactions','points_ledger','order_items','orders','cart_items','session_members','table_sessions','staff_sessions','wechat_sessions','login_failures'])db.prepare(`DELETE FROM ${table}`).run();
  db.prepare('UPDATE shift_settings SET enabled=0').run();db.prepare("UPDATE backup_settings SET mirror_error='',mirror_last_at=NULL").run();
  db.prepare("UPDATE commerce_settings SET open_time='00:00',close_time='00:00'").run();
  db.prepare("UPDATE tables SET status='active'").run();db.prepare("UPDATE users SET member_tier_id=NULL,member_level='普通会员',member_discount=1,points=0").run();db.prepare("UPDATE users SET phone='13800138001',nickname='付款原名' WHERE id=1").run();db.prepare("UPDATE member_tiers SET status='inactive'").run();
  db.prepare("UPDATE products SET stock=100,reserved_stock=0,status='active',price_cents=3000,member_price_cents=3000,cost_cents=1000,allow_bonus=0").run();
  db.prepare('UPDATE wallet_accounts SET stored_cents=10000,bonus_cents=0,stored_reserved_cents=0,bonus_reserved_cents=0').run();
  for(const [name,id] of [['admin',1],['cashier',2],['waiter',3]])db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(tokens[name]),id,new Date(Date.now()+3600000).toISOString());
  for(const [name,id] of [['user',1],['guest',2]])db.prepare('INSERT INTO wechat_sessions(token_hash,user_id,openid,expires_at) VALUES(?,?,?,?)').run(hash(tokens[name]),id,`openid-${id}`,new Date(Date.now()+3600000).toISOString());
  db.prepare("INSERT INTO table_sessions(id,store_id,table_id,session_no) VALUES(1,1,1,'single-store-session')").run();db.prepare('INSERT INTO session_members(session_id,user_id) VALUES(1,1)').run();
});
after(async()=>{globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(work,{recursive:true,force:true});});
async function call(url,{method='GET',body,token=tokens.admin}={}){const response=await nativeFetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}
const post=(url,body,token)=>call(url,{method:'POST',body,token});
const command=extra=>({requestId:crypto.randomUUID(),reason:'已核实的退款原因',...extra});
function paidOrder({quantity=2,delivered=0,method='balance'}={}){
  const total=quantity*3000;
  db.prepare("INSERT INTO orders(id,order_no,session_id,payer_user_id,original_amount_cents,payable_amount_cents,payment_method,stored_paid_cents,status,payment_status,paid_at) VALUES(100,'FIXTURE-ORDER',1,1,?,?,?,?,?,'paid',CURRENT_TIMESTAMP)").run(total,total,method,method==='balance'?total:0,delivered===quantity?'completed':'awaiting_delivery');
  db.prepare("INSERT INTO order_items(id,order_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents,delivered_quantity) VALUES(100,100,1,'测试酒水',?,3000,3000,1000,?)").run(quantity,delivered);
  db.prepare('UPDATE products SET stock=stock-? WHERE id=1').run(quantity);
}
const stock=()=>db.prepare('SELECT stock FROM products WHERE id=1').get().stock;
const current=async()=> (await call('/admin/shifts')).body.current;
test('unserved consumed goods can be fully refunded without replenishing stock or reversing cost',async()=>{
  paidOrder();const result=await post('/admin/orders/100/refund',command());assert.equal(result.status,200);assert.equal(stock(),98);
  assert.deepEqual(db.prepare('SELECT returned_quantity,cancelled_quantity FROM order_items WHERE id=100').get(),{returned_quantity:0,cancelled_quantity:2});
  assert.equal(db.prepare(`SELECT ${orderCostSql('o')} AS cost FROM orders o WHERE id=100`).get().cost,2000);
  assert.equal(db.prepare('SELECT returned_cost_cents FROM refund_transactions').get().returned_cost_cents,0);
  assert.equal((await call('/admin/reports')).body.totals.profit,-20);
});
test('delivered unopened goods can be explicitly returned while delivery history remains intact',async()=>{
  paidOrder({delivered:2});const body=command({amount:30,stockMode:'restock',stockConfirmed:true,returnItems:[{orderItemId:100,quantity:1}]});
  assert.equal((await post('/admin/orders/100/refund',body)).status,200);assert.equal(stock(),99);
  assert.deepEqual(db.prepare('SELECT delivered_quantity,returned_quantity,returned_delivered_quantity,cancelled_quantity FROM order_items').get(),{delivered_quantity:2,returned_quantity:0,returned_delivered_quantity:1,cancelled_quantity:0});
  assert.equal(db.prepare('SELECT returned_cost_cents FROM refund_transactions').get().returned_cost_cents,1000);
  assert.equal((await post('/admin/orders/100/refund',command({amount:10,stockMode:'restock',stockConfirmed:true,returnItems:[{orderItemId:100,quantity:2}]}))).status,409);assert.equal(stock(),99);
});
test('mixed stock treatment stops all remaining deliveries and returns only the confirmed quantity',async()=>{
  paidOrder({quantity:3});assert.equal((await post('/admin/orders/100/refund',command({stockMode:'restock',stockConfirmed:true,returnItems:[{orderItemId:100,quantity:1}]}))).status,200);
  assert.equal(stock(),98);assert.deepEqual(db.prepare('SELECT cancelled_quantity,returned_quantity FROM order_items').get(),{cancelled_quantity:3,returned_quantity:1});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_logs').get().n,1);
});
test('a repeated partial-refund command refunds money and stock at most once',async()=>{
  paidOrder();const body=command({amount:10});const results=await Promise.all(Array.from({length:4},()=>post('/admin/orders/100/refund',body)));
  assert.ok(results.every(r=>r.status===200));assert.equal(new Set(results.map(r=>r.body.refund.id)).size,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refund_transactions').get().n,1);assert.equal(db.prepare('SELECT stored_cents FROM wallet_accounts WHERE user_id=1').get().stored_cents,11000);
  assert.equal((await post('/admin/orders/100/refund',{...body,amount:20})).status,409);
  assert.equal((await post('/admin/orders/100/refund',{amount:10,reason:'没有请求标识'})).status,400);
  assert.equal((await post('/admin/orders/100/refund',command(),tokens.cashier)).status,403);
});
test('customer refund approval defaults to no restock and cancels only requested goods',async()=>{
  paidOrder();const request=await post('/me/orders/FIXTURE-ORDER/refund-requests',{items:[{orderItemId:100,quantity:1}]},tokens.user);assert.equal(request.status,201);
  assert.equal((await post(`/admin/refunds/${request.body.request.id}/approve`,{})).status,200);assert.equal(stock(),98);
  assert.deepEqual(db.prepare('SELECT cancelled_quantity,returned_quantity FROM order_items').get(),{cancelled_quantity:1,returned_quantity:0});
  const desk=(await call('/admin/workdesk',{token:tokens.waiter})).body;assert.equal(desk.orders[0].items[0].unpreparedQuantity,1);
});
test('manual table selection requires occupied-table confirmation and moves only the choosing customer cart',async()=>{
  db.prepare('INSERT INTO cart_items(id,session_id,product_id,quantity,added_by_user_id) VALUES(1,1,1,2,1),(2,1,1,1,2)').run();
  const listed=await call('/tables',{token:tokens.guest});assert.equal(listed.body.tables[0].occupied,true);assert.deepEqual(Object.keys(listed.body.tables[0]).sort(),['id','occupied','tableNo']);
  assert.equal((await call('/tables/A-08/session',{token:tokens.guest})).status,409);
  assert.equal((await post('/tables/select',{tableId:1,requestId:crypto.randomUUID()},tokens.guest)).status,409);
  assert.equal((await post('/tables/select',{tableId:1,confirmed:true,requestId:crypto.randomUUID()},tokens.guest)).status,200);
  paidOrder();const body={tableId:2,currentSessionId:1,cartAction:'move',confirmed:true,requestId:crypto.randomUUID()};const moved=await post('/tables/select',body,tokens.user);assert.equal(moved.status,200);
  assert.equal(db.prepare('SELECT session_id FROM cart_items WHERE id=1').get().session_id,moved.body.session.id);assert.equal(db.prepare('SELECT session_id FROM cart_items WHERE id=2').get().session_id,1);
  assert.equal(db.prepare('SELECT session_id FROM orders WHERE id=100').get().session_id,1);
  assert.equal((await post('/tables/select',body,tokens.user)).body.session.id,moved.body.session.id);
  assert.equal((await post('/tables/select',{...body,tableId:3},tokens.user)).status,409);
});
test('table switching cannot bypass pending payments, stock validation, or disabled tables',async()=>{
  paidOrder();db.prepare("UPDATE orders SET status='pending_payment',payment_status='pending'").run();
  assert.equal((await post('/tables/select',{tableId:2,requestId:crypto.randomUUID()},tokens.user)).status,409);
  db.prepare("UPDATE orders SET payment_status='paid'").run();db.prepare('INSERT INTO cart_items(session_id,product_id,quantity,added_by_user_id) VALUES(1,1,2,1)').run();db.prepare('UPDATE products SET stock=1 WHERE id=1').run();
  assert.equal((await post('/tables/select',{tableId:2,currentSessionId:1,cartAction:'move',requestId:crypto.randomUUID()},tokens.user)).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM table_sessions').get().n,1);
  db.prepare("UPDATE tables SET status='disabled' WHERE id=2").run();assert.equal((await post('/tables/select',{tableId:2,requestId:crypto.randomUUID()},tokens.user)).status,404);
});
test('shift cash, recharge, refund and handover reconcile while online orders continue during counting',async()=>{
  const opened=await post('/admin/shifts/open',{opening:100,requestId:crypto.randomUUID()},tokens.cashier);assert.equal(opened.status,200);
  const order=await post('/admin/pos/orders',{tableId:1,phone:'13800138001',items:[{productId:1,quantity:1}],paymentMethod:'cash',requestId:crypto.randomUUID()},tokens.cashier);assert.equal(order.status,201);
  const offer=db.prepare('SELECT id,pay_cents FROM wallet_packages LIMIT 1').get();assert.equal((await post('/admin/pos/recharges',{phone:'13800138001',packageId:offer.id,paymentMethod:'cash',requestId:crypto.randomUUID()},tokens.cashier)).status,201);
  const orderId=db.prepare('SELECT id FROM orders WHERE order_no=?').get(order.body.orderNo).id;
  assert.equal((await post(`/admin/orders/${orderId}/refund`,command({amount:10,cashConfirmed:true}))).status,200);
  let shift=await current();assert.equal((await post(`/admin/shifts/${shift.id}/movements`,{type:'cash_out',amount:10,note:'缴存现金',revision:shift.revision,requestId:crypto.randomUUID()},tokens.cashier)).status,200);
  shift=await current();const expected=10000+3000+offer.pay_cents-1000-1000;assert.equal(shift.expected_cents,expected);
  assert.equal((await post(`/admin/shifts/${shift.id}/count`,{revision:shift.revision},tokens.cashier)).status,200);
  const cashAttempt=await post('/admin/pos/orders',{tableId:1,phone:'13800138001',items:[{productId:1,quantity:1}],paymentMethod:'cash',requestId:crypto.randomUUID()},tokens.cashier);assert.equal(cashAttempt.status,409);
  db.prepare('INSERT INTO cart_items(session_id,product_id,quantity,added_by_user_id) VALUES(1,1,1,1)').run();assert.equal((await post('/sessions/1/orders',{paymentMethod:'balance'},tokens.user)).status,201);
  shift=await current();assert.ok(shift.channels.some(row=>row.channel==='stored'&&row.net_cents===3000));assert.equal(shift.expected_cents,expected);
  assert.equal((await post(`/admin/shifts/${shift.id}/submit`,{revision:shift.revision,actual:expected/100},tokens.cashier)).status,200);
  shift=await current();const acceptance={requestId:crypto.randomUUID(),revision:shift.revision};assert.equal((await post(`/admin/shifts/${shift.id}/accept`,acceptance,tokens.cashier)).status,409);
  const accepted=await post(`/admin/shifts/${shift.id}/accept`,acceptance);assert.equal(accepted.status,200);assert.equal(accepted.body.shift.opening_cents,expected);
  assert.equal((await post(`/admin/shifts/${shift.id}/accept`,acceptance)).body.repeated,true);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cash_shifts').get().n,2);
  assert.equal(db.prepare("SELECT status FROM table_sessions WHERE id=1").get().status,'open');
  assert.equal((await post(`/admin/orders/${orderId}/refund`,command({amount:1,cashConfirmed:true}))).status,200);
  assert.equal((await current()).expected_cents,expected-100);
  assert.equal((await call('/admin/shifts',{token:tokens.waiter})).status,403);
});
test('cash discrepancies require explanations and closing does not silently disable shift control',async()=>{
  await post('/admin/shifts/open',{opening:100,requestId:crypto.randomUUID()});let shift=await current();await post(`/admin/shifts/${shift.id}/count`,{revision:shift.revision});shift=await current();
  assert.equal((await post(`/admin/shifts/${shift.id}/submit`,{revision:shift.revision,actual:90})).status,400);
  await post(`/admin/shifts/${shift.id}/submit`,{revision:shift.revision,actual:90,note:'短款已记录，待复核'});shift=await current();assert.equal(shift.variance_cents,-1000);
  assert.equal((await post(`/admin/shifts/${shift.id}/close`,{revision:shift.revision})).status,200);assert.equal(await current(),null);
  assert.equal((await post('/admin/pos/recharges',{phone:'13800138001',packageId:1,paymentMethod:'cash',requestId:crypto.randomUUID()})).status,409);
});
test('new payments preserve payer identity after profile changes and migrations are repeatable',async()=>{
  const order=await post('/admin/pos/orders',{tableId:1,phone:'13800138001',items:[{productId:1,quantity:1}],paymentMethod:'cash',requestId:crypto.randomUUID()});assert.equal(order.status,201);
  db.prepare("UPDATE users SET nickname='后来改名',phone='13800138099' WHERE id=1").run();migrateSingleStore(db);migrateSingleStore(db);
  const row=(await call('/admin/orders')).body.orders.find(o=>o.order_no===order.body.orderNo);assert.equal(row.nickname,'付款原名');assert.equal(row.payer_phone,'13800138001');
  const exported=businessReport(reportWindow({})).orders.find(o=>o.order_no===order.body.orderNo);assert.equal(exported.payer_phone,'13800138001');assert.equal(exported.payer_user_id,1);
});
test('admin failed-login cooldown persists and expired failures release access',async()=>{
  for(let index=0;index<10;index++)assert.equal((await post('/admin/login',{username:'admin',password:'wrong'},null)).status,401);
  assert.equal((await post('/admin/login',{username:'admin',password:'single-store-test-password'},null)).status,429);
  db.prepare('UPDATE login_failures SET expires_at=?').run(Date.now()-1);
  assert.equal((await post('/admin/login',{username:'admin',password:'single-store-test-password'},null)).status,200);
});
test('external backup copying validates its private destination and preserves local success on failure',async()=>{
  const mirror=path.join(work,'private-mirror');fs.mkdirSync(mirror,{recursive:true});process.env.BACKUP_MIRROR_DIR=mirror;
  const first=await createBackup();assert.ok(backupFile(first.name));assert.ok(first.mirrorWarning);assert.ok(backupSettings().mirrorError);assert.equal(fs.existsSync(path.join(mirror,first.name)),false);
  fs.writeFileSync(path.join(mirror,'.echo-backup-target'),'echo-hx-private-backups-v1');
  assert.equal((await post(`/admin/backups/${first.name}/mirror`,{})).status,200);
  assert.equal(hash(fs.readFileSync(backupFile(first.name))),hash(fs.readFileSync(path.join(mirror,first.name))));assert.equal(backupSettings().mirrorError,'');
});

test('refunds already pending before upgrade retain their previously authorized stock treatment',async()=>{
  paidOrder();
  db.prepare("INSERT INTO refund_transactions(order_id,user_id,amount_cents,stored_cents,out_refund_no,status,stock_plan_json) VALUES(100,1,6000,6000,'LEGACY-IN-FLIGHT','pending',NULL)").run();
  await reconcileProcessingRefunds();await reconcileProcessingRefunds();
  assert.equal(stock(),100);assert.deepEqual(db.prepare('SELECT returned_quantity,cancelled_quantity FROM order_items').get(),{returned_quantity:2,cancelled_quantity:2});
  assert.equal(db.prepare('SELECT returned_cost_cents FROM refund_transactions').get().returned_cost_cents,2000);
});
