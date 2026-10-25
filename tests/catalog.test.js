import test,{before,beforeEach,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const work=fs.mkdtempSync(path.join(os.tmpdir(),'echo-catalog-tests-'));
Object.assign(process.env,{DATA_DIR:work,ECHO_ENV_FILE:path.join(work,'.env'),NODE_ENV:'production',ALLOW_DEMO_USER:'false',ADMIN_INITIAL_PASSWORD:'catalog-test-password',DOUYIN_CLIENT_KEY:'fixture-key',DOUYIN_CLIENT_SECRET:'fixture-secret',DOUYIN_POI_ID:'fixture-poi',DOUYIN_REDEMPTION_ENABLED:'0',MEITUAN_DEVELOPER_ID:'100567',MEITUAN_SIGN_KEY:'fixture-mt-sign-key',MEITUAN_VENDOR_SHOP_ID:'fixture-mt-shop',MEITUAN_ERP_ID:'fixture-erp',MEITUAN_ERP_NAME:'顾客自助核销',MEITUAN_REDEMPTION_ENABLED:'0'});
const {db}=await import('../server/db.js');
const {createApp}=await import('../server/app.js');
const {migrateCatalog}=await import('../server/catalog-schema.js');
const {recipeSnapshot}=await import('../server/catalog.js');
const {finalizeRedemption}=await import('../server/group-buy.js');
const {orderCostSql}=await import('../server/refund-stock.js');
const {displayOrderItems}=await import('../server/order-item-groups.js');
const {distributeQuantities}=await import('../src/order-quantities.js');
const {refundStockSelection}=await import('../src/refund-stock-view.js');
const nativeFetch=globalThis.fetch,hash=t=>crypto.createHash('sha256').update(t).digest('hex');
const tokens={admin:'c'.repeat(64),user:'a'.repeat(64),other:'b'.repeat(64),cashier:'d'.repeat(64),waiter:'e'.repeat(64)};
let server,base,adminHash,bundleId,mappingId;
before(async()=>{
  server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}/api`;
  adminHash=db.prepare('SELECT password_hash FROM staff_accounts WHERE id=1').get().password_hash;
  for(const [id,name,role,workspace,permissions] of [[2,'cashier','manager','cashier',['products','group-buy','pos','orders','tables','workdesk']],[3,'waiter','staff','waiter',['workdesk']]])db.prepare('INSERT INTO staff_accounts(id,username,display_name,password_hash,role,workspace,permissions) VALUES(?,?,?,?,?,?,?)').run(id,name,name,adminHash,role,workspace,JSON.stringify(permissions));
  db.prepare("INSERT INTO users(id,nickname,wechat_openid) VALUES(2,'Other guest','openid-2')").run();db.prepare('INSERT INTO wallet_accounts(user_id) VALUES(2)').run();
});
beforeEach(()=>{
  process.env.DOUYIN_REDEMPTION_ENABLED='0';
  process.env.MEITUAN_REDEMPTION_ENABLED='0';process.env.MEITUAN_VENDOR_SHOP_ID='fixture-mt-shop';
  for(const name of ['work_events','fulfillment_batch_items','fulfillment_batches','service_submit_commands','service_request_notes','service_requests','redemption_stock','group_buy_redemptions','refund_transactions','refund_requests','user_messages','points_ledger','wallet_transactions','inventory_logs','order_items','orders','cart_items','session_members','table_sessions','group_buy_mappings','bundle_components','wechat_sessions','staff_sessions'])db.prepare(`DELETE FROM ${name}`).run();
  db.prepare("DELETE FROM products WHERE id>6").run();db.prepare("UPDATE products SET kind='basic',stock=100,reserved_stock=0,status='active',sellable=1,cost_cents=500,price_cents=2000,member_price_cents=NULL,unit='瓶',safety_stock=20,target_stock=100,recipe_version=1").run();
  db.prepare("UPDATE products SET cost_cents=800,unit='份',price_cents=4000 WHERE id=4").run();db.prepare('UPDATE staff_accounts SET password_hash=? WHERE id=1').run(adminHash);
  db.prepare("UPDATE users SET points=0,member_tier_id=NULL,member_level='普通会员',phone='13800138001',wechat_openid='openid-1' WHERE id=1").run();db.prepare("UPDATE member_tiers SET status='inactive'").run();db.prepare('UPDATE wallet_accounts SET stored_cents=1000000,bonus_cents=0,stored_reserved_cents=0,bonus_reserved_cents=0').run();
  db.prepare("INSERT INTO table_sessions(id,store_id,table_id,session_no) VALUES(1,1,1,'CATALOG-SESSION')").run();db.prepare('INSERT INTO session_members VALUES(1,1,CURRENT_TIMESTAMP)').run();
  for(const [key,id] of [['admin',1],['cashier',2],['waiter',3]])db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(tokens[key]),id,new Date(Date.now()+3600000).toISOString());
  for(const [key,id] of [['user',1],['other',2]])db.prepare('INSERT INTO wechat_sessions(token_hash,user_id,openid,expires_at) VALUES(?,?,?,?)').run(hash(tokens[key]),id,`openid-${id}`,new Date(Date.now()+3600000).toISOString());
  bundleId=db.prepare("INSERT INTO products(store_id,category_id,name,kind,price_cents,cost_cents,extra_cost_cents,stock,unit) VALUES(1,5,'双人套餐','bundle',9999,0,201,0,'套')").run().lastInsertRowid;
  db.prepare('INSERT INTO bundle_components VALUES(?,?,?)').run(bundleId,1,6);db.prepare('INSERT INTO bundle_components VALUES(?,?,?)').run(bundleId,4,1);
  mappingId=db.prepare("INSERT INTO group_buy_mappings(store_id,platform,external_product_id,product_id,name,price_cents,fee_rate) VALUES(1,'douyin','sku-1',?,'双人团购',8999,5)").run(bundleId).lastInsertRowid;
});
afterEach(()=>{globalThis.fetch=nativeFetch;});
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(work,{recursive:true,force:true});});
async function call(url,{token=tokens.user,method='GET',body}={}){const r=await nativeFetch(base+url,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
const admin=(url,method='GET',body)=>call('/admin'+url,{token:tokens.admin,method,body:/^\/orders\/[^/]+\/refund$/.test(url)?{requestId:crypto.randomUUID(),reason:'测试退款',...body}:body});
const stock=id=>db.prepare('SELECT stock,reserved_stock FROM products WHERE id=?').get(id);
async function payBundle(quantity=1){assert.equal((await call('/sessions/1/cart/items',{method:'POST',body:{productId:bundleId,quantity}})).status,201);return call('/sessions/1/orders',{method:'POST',body:{paymentMethod:'balance'}});}
const query=()=>call('/sessions/1/group-buy/query',{method:'POST',body:{platform:'douyin',code:'000012345678'}});
const consume=id=>call(`/sessions/1/group-buy/${id}/consume`,{method:'POST',body:{requestId:crypto.randomUUID()}});
const groupBody=(patch={})=>({phone:'13800138001',tableId:1,mappingId,amount:'89.99',platformVerified:true,requestId:crypto.randomUUID(),...patch});
const groupOrder=(body,token=tokens.cashier)=>call('/admin/pos/group-buy',{token,method:'POST',body});
function legacyRedemption(state='unknown') {
  const id=crypto.randomUUID(),snapshot=recipeSnapshot(bundleId);
  db.prepare("INSERT INTO group_buy_redemptions(id,store_id,session_id,user_id,platform,certificate_id,voucher_hash,voucher_code,mapping_id,state,source,snapshot_json,provider_json,amount_cents,request_id) VALUES(?,1,1,1,'meituan',?,?,?,?,?,'api',?,'{}',8999,?)")
    .run(id,'9223372036854775800','legacy-hash','000012345678',mappingId,state,JSON.stringify(snapshot),crypto.randomUUID());
  for(const c of snapshot.components){db.prepare('INSERT INTO redemption_stock VALUES(?,?,?)').run(id,c.id,c.component_quantity);db.prepare('UPDATE products SET reserved_stock=reserved_stock+? WHERE id=?').run(c.component_quantity,c.id);}
  return id;
}
test('bundle availability and cost derive from shared goods without a virtual stock balance',async()=>{
  db.prepare('UPDATE products SET stock=42,reserved_stock=0 WHERE id=1').run();db.prepare('UPDATE products SET stock=12 WHERE id=4').run();
  const p=(await admin('/products?all=1')).body.products.find(p=>p.id===bundleId);assert.equal(p.availableStock,7);assert.equal(p.physicalStock,null);assert.equal(p.calculatedCost,40.01);
  const publicP=(await call('/products')).body.products.find(p=>p.id===bundleId);assert.equal(publicP.stock,7);assert.ok(!('cost_cents' in publicP));assert.ok(!('extra_cost_cents' in publicP));assert.ok(!('reference_cost_cents' in publicP));
});
test('selected categories are preserved and costs cannot leak through inventory or product APIs to cashier accounts',async()=>{
  const created=await admin('/products','POST',{name:'分类验证货品',categoryId:4,price:10,cost:2,stock:10});assert.equal(created.status,201);assert.equal(created.body.product.category_id,4);
  for(const endpoint of ['/admin/inventory','/admin/products?all=1']){const result=await call(endpoint,{token:tokens.cashier});assert.equal(result.status,200);for(const p of result.body.products)for(const key of ['cost_cents','extra_cost_cents','reference_cost_cents','calculatedCost'])assert.equal(Object.hasOwn(p,key),false);}
  assert.equal((await call('/admin/products/1',{token:tokens.cashier,method:'PATCH',body:{cost:0}})).status,403);
});
test('shared cart checks aggregate bundles and ordinary goods and expose remaining capacity',async()=>{
  db.prepare('UPDATE products SET stock=12 WHERE id=1').run();assert.equal((await call('/sessions/1/cart/items',{method:'POST',body:{productId:bundleId,quantity:2}})).status,201);
  assert.equal((await call('/sessions/1/cart/items',{method:'POST',body:{productId:1}})).status,409);
  const cart=(await call('/sessions/1/cart')).body;assert.equal(cart.remainingByProduct[1],0);assert.equal(cart.remainingByProduct[bundleId],0);assert.deepEqual(stock(1),{stock:12,reserved_stock:0});
});
test('a paid bundle expands into exact integer money and cost snapshots and enters fulfillment once',async()=>{
  const paid=await payBundle(2);assert.equal(paid.status,201);const id=paid.body.order.id;
  assert.deepEqual(stock(1),{stock:88,reserved_stock:0});assert.deepEqual(stock(4),{stock:98,reserved_stock:0});
  const sums=db.prepare('SELECT SUM(quantity*paid_price_cents) AS paid,SUM(quantity*cost_price_cents) AS cost FROM order_items WHERE order_id=?').get(id);assert.deepEqual(sums,{paid:19998,cost:8002});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_events WHERE kind=\'order_new\' AND entity_id=?').get(id).n,1);
  const order=(await call(`/me/orders/${paid.body.order.order_no}`)).body.order;assert.equal(order.bundleGroups[0].quantity,2);assert.equal(order.bundleGroups[0].amount,199.98);
  const desk=(await admin('/workdesk')).body;assert.ok(JSON.stringify(desk).includes('精酿啤酒'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_logs WHERE order_id=?').get(id).n,2);
});
test('bundle refunds return constituent goods once and retain no returned costs',async()=>{
  const paid=await payBundle();assert.equal(paid.status,201);const id=paid.body.order.id;
  const r=await admin(`/orders/${id}/refund`,'POST',{amount:99.99,reason:'未配送整单退款',stockMode:'restock',stockConfirmed:true,returnItems:db.prepare('SELECT id AS orderItemId,quantity FROM order_items WHERE order_id=?').all(id)});assert.equal(r.status,200);assert.equal(stock(1).stock,100);assert.equal(stock(4).stock,100);
  assert.equal(db.prepare(`SELECT ${orderCostSql('o')} AS cost FROM orders o WHERE id=?`).get(id).cost,0);
  assert.equal((await admin(`/orders/${id}/refund`,'POST',{amount:99.99})).status,409);assert.equal(stock(1).stock,100);
});
test('recipe and stock edits fail atomically and platform mappings protect historical compositions',async()=>{
  const before=db.prepare('SELECT * FROM products WHERE id=?').get(bundleId);
  const invalid=await admin(`/products/${bundleId}`,'PATCH',{name:'Changed',components:[{productId:4,quantity:2}]});assert.equal(invalid.status,409);assert.equal(db.prepare('SELECT name FROM products WHERE id=?').get(bundleId).name,before.name);
  assert.equal((await admin(`/inventory/${bundleId}/adjust`,'POST',{change:10,reason:'wrong'})).status,400);
  const basic=await admin('/products/1','PATCH',{components:[{productId:bundleId,quantity:1}],kind:'bundle'});assert.equal(basic.status,400);
});
test('stock pack conversion and previewed stocktake are atomic and reject stale previews',async()=>{
  assert.equal((await admin('/products/1','PATCH',{packSize:24,safetyStock:48,targetStock:120})).status,200);
  assert.equal((await admin('/inventory/1/adjust','POST',{change:2,unit:'pack',reason:'进货两箱'})).status,200);assert.equal(stock(1).stock,148);
  const preview=(await admin('/inventory/import/preview','POST',{rows:[{productId:1,stock:120},{productId:4,stock:80}]})).body.rows;
  db.prepare('UPDATE products SET stock=149 WHERE id=1').run();assert.equal((await admin('/inventory/import','POST',{rows:preview,reason:'盘点'})).status,409);assert.equal(stock(4).stock,100);
  const fresh=(await admin('/inventory/import/preview','POST',{rows:[{productId:1,stock:120},{productId:4,stock:80}]})).body.rows;assert.equal((await admin('/inventory/import','POST',{rows:fresh,reason:'盘点'})).status,200);assert.equal(stock(4).stock,80);
  const detail=(await admin('/products/1/detail')).body;assert.ok(detail.logs.some(l=>l.change_quantity===48));assert.equal(detail.affectedBundles[0].id,bundleId);
});
test('removed customer and legacy entry points reject every request even with old enable flags and never call a provider',async()=>{
  process.env.MEITUAN_REDEMPTION_ENABLED='1';process.env.DOUYIN_REDEMPTION_ENABLED='1';
  let upstreamCalls=0;globalThis.fetch=async()=>{upstreamCalls++;throw new Error('No upstream request allowed');};
  assert.equal((await query()).status,410);assert.equal((await consume('old-redemption')).status,410);
  assert.equal((await call('/sessions/1/group-buy')).status,410);
  assert.equal((await admin('/group-buy/verify','POST',groupBody())).status,410);
  assert.equal((await admin('/group-buy/old-redemption/recheck','POST')).status,410);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_buy_redemptions').get().n,0);
  assert.deepEqual(stock(1),{stock:100,reserved_stock:0});assert.equal(upstreamCalls,0);
  const settings=(await admin('/settings')).body;assert.ok(!settings.settings.some(s=>/^(meituan|douyin)_/.test(s.key)));
  assert.ok(!Object.hasOwn(settings.groups,'meituan'));assert.ok(!Object.hasOwn(settings.groups,'douyin'));
});
test('POS-only staff can record a merchant-verified voucher with identity snapshots and exact bundle stock without taking money',async()=>{
  db.prepare("UPDATE staff_accounts SET role='staff',permissions=? WHERE id=2").run(JSON.stringify(['pos']));
  try {
    const context=await call('/admin/pos?phone=13800138001',{token:tokens.cashier});assert.equal(context.status,200);
    const option=context.body.groupBuyPackages.find(m=>m.id===mappingId);assert.equal(option.product.availableStock,16);assert.equal(Object.hasOwn(option.product,'calculatedCost'),false);
    const beforeWallet=db.prepare('SELECT * FROM wallet_accounts WHERE user_id=1').get();
    const result=await groupOrder(groupBody());assert.equal(result.status,201);assert.equal(result.body.payable,89.99);
    const order=db.prepare('SELECT * FROM orders WHERE order_no=?').get(result.body.orderNo);
    assert.equal(order.payment_method,'group_buy');assert.equal(order.source_channel,'douyin');assert.equal(order.payment_status,'paid');assert.equal(order.status,'awaiting_delivery');
    for(const field of ['offline_paid_cents','wechat_paid_cents','stored_paid_cents','bonus_paid_cents','coupon_discount_cents'])assert.equal(order[field],0);
    assert.equal(order.payer_phone_snapshot,'13800138001');assert.equal(order.payer_user_id,1);
    assert.deepEqual(db.prepare('SELECT * FROM wallet_accounts WHERE user_id=1').get(),beforeWallet);
    assert.deepEqual(stock(1),{stock:94,reserved_stock:0});assert.deepEqual(stock(4),{stock:99,reserved_stock:0});
    assert.deepEqual(db.prepare('SELECT SUM(quantity*paid_price_cents) AS paid,SUM(quantity*cost_price_cents) AS cost FROM order_items WHERE order_id=?').get(order.id),{paid:8999,cost:4001});
    const record=db.prepare('SELECT * FROM group_buy_redemptions WHERE order_id=?').get(order.id);assert.equal(record.source,'manual');assert.equal(record.voucher_code,'');assert.equal(record.expected_settlement_cents,8549);assert.equal(record.operator_id,2);assert.equal(record.actual_settlement_cents,null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind='order_new' AND entity_id=?").get(order.id).n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_logs WHERE order_id=?').get(order.id).n,2);
    assert.equal((await call('/me/orders/'+order.order_no)).body.order.order_no,order.order_no);
    assert.equal((await admin('/bills')).body.bills[0].orders,1);
    assert.equal((await admin(`/orders/${order.id}/refund`,'POST',{amount:89.99})).status,409);
    assert.equal((await call('/admin/group-buy',{token:tokens.cashier})).status,403);
  } finally {db.prepare("UPDATE staff_accounts SET role='manager',permissions=? WHERE id=2").run(JSON.stringify(['products','group-buy','pos','orders','tables','workdesk']));}
});
test('repeated commands create one offline group order; retries remain safe after a table closes or a mapping is disabled',async()=>{
  const body=groupBody(),first=await groupOrder(body);assert.equal(first.status,201);
  assert.equal((await groupOrder(body)).body.orderNo,first.body.orderNo);
  assert.equal((await groupOrder({...body,amount:'88'})).status,409);
  assert.equal((await groupOrder({...body,tableId:2})).status,409);
  db.prepare("UPDATE table_sessions SET status='closed' WHERE id=1").run();db.prepare("UPDATE group_buy_mappings SET status='inactive' WHERE id=?").run(mappingId);
  assert.equal((await groupOrder(body)).body.orderNo,first.body.orderNo);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,1);assert.deepEqual(stock(1),{stock:94,reserved_stock:0});
});
test('POS validates permission, confirmation, exact money and a single coupon bundle atomically',async()=>{
  assert.equal((await groupOrder(groupBody(),tokens.waiter)).status,403);
  assert.equal((await groupOrder(groupBody(),tokens.user)).status,401);
  for(const patch of [{platformVerified:false},{phone:'13800138099'},{amount:''},{amount:'1.001'},{amount:-1},{quantity:2},{items:[{productId:1,quantity:1}]},{mappingId:999},{tableId:999}])assert.ok((await groupOrder(groupBody(patch))).status>=400,JSON.stringify(patch));
  db.prepare('UPDATE products SET stock=5 WHERE id=1').run();assert.equal((await groupOrder(groupBody())).status,409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_buy_redemptions').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,0);assert.equal(stock(1).reserved_stock,0);
});
test('cashier can open a table for a phone-bound guest, and administrators can create manual packages without external IDs',async()=>{
  db.prepare("UPDATE table_sessions SET status='closed' WHERE id=1").run();
  const configured=await admin('/group-buy/mappings','POST',{platform:'meituan',productId:bundleId,name:'收银美团套餐',price:80,feeRate:6});assert.equal(configured.status,200);
  const mapping=db.prepare("SELECT * FROM group_buy_mappings WHERE platform='meituan'").get();assert.match(mapping.external_product_id,/^manual:/);
  const result=await groupOrder(groupBody({mappingId:mapping.id}));assert.equal(result.status,201);
  const order=db.prepare('SELECT * FROM orders WHERE order_no=?').get(result.body.orderNo);assert.notEqual(order.session_id,1);assert.equal(order.source_channel,'meituan');
  assert.equal(db.prepare('SELECT user_id FROM session_members WHERE session_id=?').get(order.session_id).user_id,1);
});
test('manual group sales retain gross profit while platform arrivals are counted as separate external receipts',async()=>{
  const result=await groupOrder(groupBody());assert.equal(result.status,201);
  db.prepare("UPDATE orders SET created_at='2026-10-13 05:00:00',paid_at='2026-10-13 05:00:00' WHERE order_no=?").run(result.body.orderNo);
  db.prepare("UPDATE group_buy_redemptions SET created_at='2026-10-13 05:00:00' WHERE id=?").run(result.body.record.id);
  const url='/reports?startAt=2026-10-13T12:00&endAt=2026-10-14T06:00';
  let report=(await admin(url)).body;
  assert.equal(report.totals.revenue,89.99);assert.equal(report.totals.orderCost,40.01);assert.equal(report.totals.profit,49.98);assert.equal(report.totals.externalNetReceived,0);
  assert.equal((await admin(`/group-buy/${result.body.record.id}/settlement`,'PATCH',{amount:85,settledAt:'2026-10-13T17:00',requestId:crypto.randomUUID()})).status,200);
  report=(await admin(url)).body;assert.equal(report.totals.revenue,89.99);assert.equal(report.totals.externalNetReceived,85);assert.equal(report.totals.settlementReceived,85);
});
test('offline group entries need no voucher and independent orders for the same package do not collide',async()=>{
  const first=await groupOrder(groupBody());assert.equal(first.status,201);assert.equal(first.body.record.voucher,'线下已核销');
  const second=await groupOrder(groupBody({voucherNo:''}));assert.equal(second.status,201);assert.notEqual(first.body.orderNo,second.body.orderNo);
  const records=db.prepare("SELECT certificate_id,voucher_hash,voucher_code FROM group_buy_redemptions ORDER BY created_at,id").all();
  assert.equal(records.length,2);assert.ok(records.every(r=>r.voucher_code===''));assert.notEqual(records[0].certificate_id,records[1].certificate_id);assert.notEqual(records[0].voucher_hash,records[1].voucher_hash);
  assert.equal(stock(1).stock,88);
});
test('legacy ambiguous redemptions retain stock across upgrade and still require administrator evidence',async()=>{
  const id=legacyRedemption('verifying');migrateCatalog(db);assert.deepEqual(stock(1),{stock:100,reserved_stock:6});assert.equal((await admin('/tables/1/close','POST',{})).status,409);
  assert.equal((await admin(`/group-buy/${id}/resolve`,'POST',{outcome:'success',reason:'核对平台记录',platformChecked:true})).status,400);
  const result=await admin(`/group-buy/${id}/resolve`,'POST',{outcome:'success',verifyId:'verified-evidence',reason:'核对平台记录',platformChecked:true});assert.equal(result.status,200);assert.equal(result.body.record.state,'success');assert.deepEqual(stock(1),{stock:94,reserved_stock:0});
});
test('legacy confirmed-unused vouchers release holds only through authorized manual review',async()=>{
  const id=legacyRedemption();
  assert.equal((await call(`/admin/group-buy/${id}/resolve`,{token:tokens.waiter,method:'POST',body:{outcome:'failed',reason:'平台未核销',platformChecked:true}})).status,403);
  assert.equal((await admin(`/group-buy/${id}/resolve`,'POST',{outcome:'failed',reason:'平台未核销',platformChecked:true})).status,200);assert.deepEqual(stock(1),{stock:100,reserved_stock:0});
});
test('legacy locally verified orders recover once without any provider request',()=>{
  const id=legacyRedemption('verified');let requests=0;globalThis.fetch=()=>{requests++;throw new Error('No network');};
  const settle=order=>db.prepare("UPDATE orders SET payment_status='paid',status='awaiting_delivery' WHERE id=?").run(order.id);
  const first=finalizeRedemption(id,settle),second=finalizeRedemption(id,settle);assert.equal(first.orderNo,second.orderNo);assert.equal(requests,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,1);
});
test('manual external refund reverses revenue once and applies only explicitly chosen returned goods',async()=>{
  const body=groupBody(),first=await groupOrder(body);assert.equal(first.status,201);const id=first.body.record.id;
  const reverse={platformChecked:true,verifyId:'platform-refund-1',reason:'未交付，已在平台完成退款',stockMode:'restock',stockConfirmed:true,returnItems:db.prepare('SELECT id AS orderItemId,quantity FROM order_items WHERE order_id=(SELECT order_id FROM group_buy_redemptions WHERE id=?)').all(id)};
  assert.equal((await admin(`/group-buy/${id}/reverse`,'POST',reverse)).status,200);assert.equal(stock(1).stock,100);
  assert.equal((await admin(`/group-buy/${id}/reverse`,'POST',reverse)).status,200);assert.equal(stock(1).stock,100);assert.equal((await admin('/reports')).body.totals.revenue,0);
  assert.equal((await groupOrder(body)).status,409);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,1);
});
test('super admin directly changes own and managed passwords; other sessions are invalidated and ordinary accounts still need their old password',async()=>{
  const otherSession='f'.repeat(64);db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(otherSession),1,new Date(Date.now()+3600000).toISOString());
  assert.equal((await admin('/change-password','POST',{newPassword:'new-super-password'})).status,200);assert.equal((await admin('/session')).status,200);assert.equal(db.prepare('SELECT 1 FROM staff_sessions WHERE token_hash=?').get(hash(otherSession)),undefined);
  assert.equal((await call('/admin/change-password',{token:tokens.cashier,method:'POST',body:{newPassword:'new-cashier-password'}})).status,400);
  assert.equal((await admin('/accounts/2/reset-password','POST',{password:'reset-cashier-password'})).status,200);assert.equal((await call('/admin/session',{token:tokens.cashier})).status,401);
  assert.equal((await call('/admin/login',{token:null,method:'POST',body:{username:'cashier',password:'reset-cashier-password'}})).status,200);
});

test('cent-split bundle goods are grouped across order views without changing historical amounts or names',async()=>{
  const paid=await payBundle(2),id=paid.body.order.id;
  db.prepare("UPDATE products SET name='后来修改的名称' WHERE id=1").run();
  const detail=(await call(`/me/orders/${paid.body.order.order_no}`)).body.order;
  assert.ok(detail.items.filter(item=>item.productId===1).length>1);
  const beer=detail.displayItems.filter(item=>item.productId===1);assert.equal(beer.length,1);assert.equal(beer[0].name,'精酿啤酒');assert.equal(beer[0].quantity,12);assert.equal(beer[0].paidPrice,null);
  assert.equal(detail.displayItems.reduce((sum,item)=>sum+Math.round(item.paidSubtotal*100),0),19998);
  const adminOrder=(await admin('/orders')).body.orders.find(order=>order.id===id);assert.equal(adminOrder.displayItems.filter(item=>item.productId===1).length,1);assert.equal(adminOrder.items.length,detail.items.length);
  const summary=(await admin('/summary')).body.pendingOrders.find(order=>order.id===id);assert.equal(summary.displayItems.find(item=>item.productId===1).quantity,12);
  const desk=(await call('/admin/workdesk',{token:tokens.waiter})).body.orders.find(order=>order.id===id);assert.equal(desk.displayItems.find(item=>item.productId===1).unpreparedQuantity,12);
  for(const item of desk.displayItems)for(const field of ['paidPrice','paidSubtotal','cost_cents','originalPrice'])assert.equal(Object.hasOwn(item,field),false);
  assert.equal(db.prepare('SELECT SUM(quantity*paid_price_cents) AS paid FROM order_items WHERE order_id=?').get(id).paid,19998);
});
test('a grouped bundle quantity can be delivered across source lines in separate idempotent batches',async()=>{
  const paid=await payBundle(2),id=paid.body.order.id,stockAfterSale=stock(1);
  const staffPost=(url,body)=>call('/admin/workdesk'+url,{token:tokens.waiter,method:'POST',body});
  let order=(await staffPost(`/orders/${id}/claim`,{revision:0})).body.order;
  const firstQuantities=Object.fromEntries(order.displayItems.map(item=>[item.id,item.productId===1?8:0]));
  const first=await staffPost(`/orders/${id}/batches`,{revision:order.revision,requestId:crypto.randomUUID(),startDelivery:true,items:distributeQuantities(order.displayItems,firstQuantities,order.items,row=>row.unpreparedQuantity)});assert.equal(first.status,200);
  assert.ok(first.body.batch.items.length>1);assert.equal(first.body.batch.displayItems.length,1);assert.equal(first.body.batch.displayItems[0].quantity,8);
  assert.equal((await staffPost(`/batches/${first.body.batch.id}/complete`,{})).status,200);assert.equal((await staffPost(`/batches/${first.body.batch.id}/complete`,{})).status,200);
  order=(await call('/admin/workdesk',{token:tokens.waiter})).body.orders.find(order=>order.id===id);
  const beer=order.displayItems.find(item=>item.productId===1);assert.equal(beer.deliveredQuantity,8);assert.equal(beer.unpreparedQuantity,4);
  const rest=await staffPost(`/orders/${id}/batches`,{revision:order.revision,requestId:crypto.randomUUID(),startDelivery:true,items:distributeQuantities(order.displayItems,Object.fromEntries(order.displayItems.map(item=>[item.id,item.unpreparedQuantity])),order.items,row=>row.unpreparedQuantity)});assert.equal(rest.status,200);
  assert.equal(rest.body.batch.displayItems.find(item=>item.productId===1).quantity,4);assert.equal((await staffPost(`/batches/${rest.body.batch.id}/complete`,{})).status,200);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status,'completed');assert.deepEqual(stock(1),stockAfterSale);
  const final=(await call(`/me/orders/${paid.body.order.order_no}`)).body.order;assert.equal(final.displayItems.find(item=>item.productId===1).deliveredQuantity,12);
});
test('same-name distinct goods and different historical units never merge into one display quantity',()=>{
  const groups=displayOrderItems(0,[{id:1,product_id:1,product_name:'同名商品',unit_snapshot:'瓶',quantity:2},{id:2,product_id:2,product_name:'同名商品',unit_snapshot:'瓶',quantity:3},{id:3,product_id:1,product_name:'同名商品',unit_snapshot:'箱',quantity:4}]);
  assert.equal(groups.length,3);assert.deepEqual(groups.map(item=>item.quantity),[2,3,4]);
});

test('a grouped partial bundle refund retains exact source prices and returns only the chosen goods',async()=>{
  const paid=await payBundle(),id=paid.body.order.id,order=(await call(`/me/orders/${paid.body.order.order_no}`)).body.order;
  const quantities=Object.fromEntries(order.displayItems.map(item=>[item.id,item.productId===1?5:0]));
  const selected=distributeQuantities(order.displayItems,quantities,order.items,row=>row.refundAvailableQuantity);
  const expected=selected.reduce((sum,row)=>sum+Math.round(order.items.find(item=>item.id===row.orderItemId).paidPrice*100)*row.quantity,0);
  const request=await call(`/me/orders/${paid.body.order.order_no}/refund-requests`,{method:'POST',body:{items:selected}});assert.equal(request.status,201);assert.equal(Math.round(request.body.request.amount*100),expected);
  const adminOrder=(await admin('/orders')).body.orders.find(row=>row.id===id);
  const stockPlan=refundStockSelection(adminOrder,adminOrder.displayItems,{cancelQuantities:{},returnQuantities:quantities,requested:adminOrder.refundRequest.items,restock:true});
  assert.deepEqual(stockPlan.cancelItems,selected);
  const body={...stockPlan,stockMode:'restock',stockConfirmed:true};
  assert.equal((await admin(`/refunds/${request.body.request.id}/approve`,'POST',body)).status,200);assert.equal((await admin(`/refunds/${request.body.request.id}/approve`,'POST',body)).status,200);
  assert.equal(stock(1).stock,99);assert.equal(stock(4).stock,99);
  const desk=(await admin('/workdesk')).body.orders.find(row=>row.id===id),beer=desk.displayItems.find(row=>row.productId===1);
  assert.equal(beer.cancelledQuantity,5);assert.equal(beer.returnedQuantity,5);assert.equal(beer.unpreparedQuantity,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refund_transactions WHERE order_id=?').get(id).n,1);
});
