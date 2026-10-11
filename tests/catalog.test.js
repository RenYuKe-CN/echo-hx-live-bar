import test,{before,beforeEach,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const work=fs.mkdtempSync(path.join(os.tmpdir(),'echo-catalog-tests-'));
Object.assign(process.env,{DATA_DIR:work,ECHO_ENV_FILE:path.join(work,'.env'),NODE_ENV:'production',ALLOW_DEMO_USER:'false',ADMIN_INITIAL_PASSWORD:'catalog-test-password',DOUYIN_CLIENT_KEY:'fixture-key',DOUYIN_CLIENT_SECRET:'fixture-secret',DOUYIN_POI_ID:'fixture-poi',DOUYIN_REDEMPTION_ENABLED:'0'});
const {db}=await import('../server/db.js');
const {createApp}=await import('../server/app.js');
const {migrateCatalog}=await import('../server/catalog-schema.js');
const {orderCostSql}=await import('../server/refund-stock.js');
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
const admin=(url,method='GET',body)=>call('/admin'+url,{token:tokens.admin,method,body});
const stock=id=>db.prepare('SELECT stock,reserved_stock FROM products WHERE id=?').get(id);
async function payBundle(quantity=1){assert.equal((await call('/sessions/1/cart/items',{method:'POST',body:{productId:bundleId,quantity}})).status,201);return call('/sessions/1/orders',{method:'POST',body:{paymentMethod:'balance'}});}
function platformMock({timeout=false,certificates=1}={}){
  const calls=[];process.env.DOUYIN_REDEMPTION_ENABLED='1';
  globalThis.fetch=async(url,options={})=>{
    const address=String(url);calls.push({url:address,options});
    if(address.includes('/oauth/client_token/'))return new Response(JSON.stringify({data:{access_token:'fixture-token',expires_in:7200,error_code:0}}));
    if(address.includes('/certificate/prepare/'))return new Response(`{"data":{"error_code":0,"verify_token":"platform-token-${calls.length}","certificates":[${Array.from({length:certificates},(_,i)=>`{"certificate_id":922337203685477580${i},"can_verify_status":1,"encrypted_code":"encrypted-${i}","amount":{"pay_amount":8999},"sku":{"sku_id":"sku-1","groupon_type":1,"title":"双人团购"}}`).join(',')}]}}`);
    if(address.includes('/certificate/verify/')){if(timeout)throw new Error('network timeout');const payload=JSON.parse(options.body),i=payload.encrypted_codes[0].slice(-1);return new Response(`{"data":{"error_code":0,"verify_results":[{"certificate_id":922337203685477580${i},"verify_id":"verified-${i}","result":0}]}}`);}
    throw new Error('Unexpected upstream request');
  };return calls;
}
const query=()=>call('/sessions/1/group-buy/query',{method:'POST',body:{platform:'douyin',code:'000012345678'}});
const consume=id=>call(`/sessions/1/group-buy/${id}/consume`,{method:'POST',body:{requestId:crypto.randomUUID()}});
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
  const r=await admin(`/orders/${id}/refund`,'POST',{amount:99.99,reason:'未配送整单退款'});assert.equal(r.status,200);assert.equal(stock(1).stock,100);assert.equal(stock(4).stock,100);
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
test('unconfigured self redemption cannot create successful vouchers or change stock',async()=>{
  const r=await query();assert.equal(r.status,503);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_buy_redemptions').get().n,0);assert.equal(stock(1).stock,100);
  assert.equal((await call('/sessions/1/group-buy',{token:tokens.other})).status,403);
});
test('real adapter preserves long IDs and leading zero codes and uses platform verify_token',async()=>{
  const calls=platformMock(),q=await query();assert.equal(q.status,200);const id=q.body.records[0].id;
  assert.equal(db.prepare('SELECT certificate_id FROM group_buy_redemptions WHERE id=?').get(id).certificate_id,'9223372036854775800');assert.ok(calls.some(c=>c.url.includes('code=000012345678')));
  const redeemed=await consume(id);assert.equal(redeemed.status,200);assert.equal(redeemed.body.record.state,'success');assert.deepEqual(stock(1),{stock:94,reserved_stock:0});
  const verify=calls.find(c=>c.url.includes('/certificate/verify/'));assert.match(JSON.parse(verify.options.body).verify_token,/^platform-token-/);
  assert.equal((await consume(id)).body.record.orderNo,redeemed.body.record.orderNo);assert.equal(calls.filter(c=>c.url.includes('/certificate/verify/')).length,1);
  const order=db.prepare('SELECT * FROM orders WHERE order_no=?').get(redeemed.body.record.orderNo);assert.equal(order.payment_method,'group_buy');assert.equal(order.offline_paid_cents,0);assert.equal(order.wechat_paid_cents,0);
  assert.equal((await admin(`/orders/${order.id}/refund`,'POST',{amount:89.99})).status,409);
});
test('multiple coupons from one query cannot reuse an already consumed platform token',async()=>{
  platformMock({certificates:2});const q=await query();assert.equal(q.status,200);assert.equal(q.body.records.length,2);
  assert.equal((await consume(q.body.records[0].id)).body.record.state,'success');assert.equal((await consume(q.body.records[1].id)).status,409);assert.equal(stock(1).stock,94);
});
test('ambiguous redemption retains stock across restart migration, blocks table close and requires administrator evidence',async()=>{
  const calls=platformMock({timeout:true}),q=await query(),id=q.body.records[0].id;
  assert.equal((await consume(id)).body.record.state,'unknown');assert.deepEqual(stock(1),{stock:100,reserved_stock:6});
  migrateCatalog(db);assert.deepEqual(stock(1),{stock:100,reserved_stock:6});assert.equal((await admin('/tables/1/close','POST',{})).status,409);
  assert.equal((await consume(id)).body.record.state,'unknown');assert.equal(calls.filter(c=>c.url.includes('/certificate/verify/')).length,1);
  assert.equal((await admin(`/group-buy/${id}/resolve`,'POST',{outcome:'success',reason:'核对平台记录',platformChecked:true})).status,400);
  const result=await admin(`/group-buy/${id}/resolve`,'POST',{outcome:'success',verifyId:'verified-evidence',reason:'核对平台记录',platformChecked:true});assert.equal(result.status,200);assert.equal(result.body.record.state,'success');assert.equal(stock(1).stock,94);assert.equal(stock(1).reserved_stock,0);
});
test('a confirmed unused voucher releases reservations and a waiter cannot resolve it',async()=>{
  platformMock({timeout:true});const q=await query(),id=q.body.records[0].id;await consume(id);
  assert.equal((await call(`/admin/group-buy/${id}/resolve`,{token:tokens.waiter,method:'POST',body:{outcome:'failed',reason:'平台未核销',platformChecked:true}})).status,403);
  assert.equal((await admin(`/group-buy/${id}/resolve`,'POST',{outcome:'failed',reason:'平台未核销',platformChecked:true})).status,200);assert.deepEqual(stock(1),{stock:100,reserved_stock:0});
});
test('cashier manual confirmation is idempotent and a whole unserved external refund reverses stock and revenue once',async()=>{
  const body={mappingId,sessionId:1,userId:1,voucherNo:'000009876543',amount:89.99,platformVerified:true,requestId:crypto.randomUUID()};
  assert.equal((await admin('/group-buy/verify','POST',{...body,platformVerified:false})).status,400);
  const first=await admin('/group-buy/verify','POST',body);assert.equal(first.status,201);const id=first.body.record.id;
  assert.equal((await admin('/group-buy/verify','POST',body)).body.record.orderNo,first.body.record.orderNo);assert.equal(stock(1).stock,94);
  const reverse={platformChecked:true,verifyId:'platform-refund-1',reason:'未交付，已在平台完成退款'};assert.equal((await admin(`/group-buy/${id}/reverse`,'POST',reverse)).status,200);assert.equal(stock(1).stock,100);
  assert.equal((await admin(`/group-buy/${id}/reverse`,'POST',reverse)).status,200);assert.equal(stock(1).stock,100);assert.equal((await admin('/reports')).body.totals.revenue,0);
});
test('super admin directly changes own and managed passwords; other sessions are invalidated and ordinary accounts still need their old password',async()=>{
  const otherSession='f'.repeat(64);db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(otherSession),1,new Date(Date.now()+3600000).toISOString());
  assert.equal((await admin('/change-password','POST',{newPassword:'new-super-password'})).status,200);assert.equal((await admin('/session')).status,200);assert.equal(db.prepare('SELECT 1 FROM staff_sessions WHERE token_hash=?').get(hash(otherSession)),undefined);
  assert.equal((await call('/admin/change-password',{token:tokens.cashier,method:'POST',body:{newPassword:'new-cashier-password'}})).status,400);
  assert.equal((await admin('/accounts/2/reset-password','POST',{password:'reset-cashier-password'})).status,200);assert.equal((await call('/admin/session',{token:tokens.cashier})).status,401);
  assert.equal((await call('/admin/login',{token:null,method:'POST',body:{username:'cashier',password:'reset-cashier-password'}})).status,200);
});
