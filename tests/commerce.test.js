import test,{before,beforeEach,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
const work=fs.mkdtempSync(path.join(os.tmpdir(),'echo-commerce-test-'));
Object.assign(process.env,{DATA_DIR:work,ECHO_ENV_FILE:path.join(work,'.env'),NODE_ENV:'production',ALLOW_DEMO_USER:'false',ADMIN_INITIAL_PASSWORD:'commerce-test-password',FEIE_USER:'fixture-user',FEIE_UKEY:'fixture-ukey',FEIE_REGION:'china',FEIE_PRINTING_ENABLED:'0'});
const {db}=await import('../server/db.js');
const {createApp}=await import('../server/app.js');
const {reportWindow,businessWindow,parseLocal,currentBusinessDate}=await import('../server/business-time.js');
const {businessReport}=await import('../server/business-report.js');
const {migrateCommerce}=await import('../server/commerce-schema.js');
const {insertSaleItems}=await import('../server/catalog.js');
const {createBackup,restoreBackup}=await import('../server/backup.js');
const {beginRestore,endRestore}=await import('../server/maintenance.js');
const nativeFetch=globalThis.fetch,tokens={admin:'c'.repeat(64),cashier:'d'.repeat(64),waiter:'e'.repeat(64)},hash=t=>crypto.createHash('sha256').update(t).digest('hex');
const windowQuery='startAt=2026-10-13T12%3A00&endAt=2026-10-14T06%3A00';
let server,base,bundleId,printerId;
before(async()=>{
  const password=db.prepare('SELECT password_hash FROM staff_accounts WHERE id=1').get().password_hash;
  for(const [id,username,role,permissions] of [[2,'cashier','manager',['orders','pos','tables','group-buy']],[3,'waiter','staff',['workdesk']]])db.prepare('INSERT INTO staff_accounts(id,username,display_name,password_hash,role,permissions,workspace) VALUES(?,?,?,?,?,?,?)').run(id,username,username,password,role,JSON.stringify(permissions),id===2?'cashier':'waiter');
  server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(()=>{
  globalThis.fetch=nativeFetch;process.env.FEIE_PRINTING_ENABLED='0';process.env.FEIE_USER='fixture-user';process.env.FEIE_REGION='china';
  for(const table of ['print_parts','print_jobs','receipt_printers','bill_snapshots','group_buy_settlements','redemption_stock','group_buy_redemptions','fulfillment_batch_items','fulfillment_batches','work_events','service_request_notes','service_requests','refund_transactions','refund_requests','inventory_logs','wallet_transactions','points_ledger','order_items','orders','cart_items','session_members','table_sessions','bundle_components','group_buy_mappings','stock_losses','staff_sessions'])db.prepare(`DELETE FROM ${table}`).run();
  db.prepare('DELETE FROM products WHERE id>6').run();db.prepare("UPDATE products SET stock=100,reserved_stock=0,status='active',cost_cents=1000,unit='瓶' WHERE id=1").run();db.prepare("UPDATE products SET stock=100,reserved_stock=0,status='active',cost_cents=2000,unit='份' WHERE id=4").run();
  db.prepare("UPDATE stores SET name='测试门店' WHERE id=1").run();db.prepare('DELETE FROM mini_page_settings').run();db.prepare("UPDATE receipt_templates SET settings_json='{}',revision=1").run();db.prepare("UPDATE commerce_settings SET timezone='Asia/Shanghai',open_time='12:00',close_time='06:00',export_title='营业明细'").run();
  for(const [key,id] of [['admin',1],['cashier',2],['waiter',3]])db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(tokens[key]),id,new Date(Date.now()+3600000).toISOString());
  db.prepare("UPDATE users SET phone='13800138001',member_tier_id=NULL,member_level='普通会员' WHERE id=1").run();db.prepare('UPDATE member_tiers SET status=\'inactive\'').run();
  db.prepare('INSERT INTO table_sessions(id,store_id,table_id,session_no,opened_at) VALUES(1,1,1,?,?)').run('COMMERCE-VISIT','2026-10-12 12:00:00');db.prepare('INSERT INTO session_members VALUES(1,1,CURRENT_TIMESTAMP)').run();
  bundleId=db.prepare("INSERT INTO products(store_id,category_id,name,kind,price_cents,cost_cents,extra_cost_cents,unit) VALUES(1,5,'双人套餐','bundle',8999,0,1,'套')").run().lastInsertRowid;
  db.prepare('INSERT INTO bundle_components VALUES(?,?,?)').run(bundleId,1,2);db.prepare('INSERT INTO bundle_components VALUES(?,?,?)').run(bundleId,4,1);
  printerId=db.prepare("INSERT INTO receipt_printers(name,sn,device_key,bound,bound_user,bound_region) VALUES('FP-V3-WH','316500011','abcdefgh',1,'fixture-user','china')").run().lastInsertRowid;
});
afterEach(()=>{globalThis.fetch=nativeFetch;});after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(work,{recursive:true,force:true});});
async function call(url,{method='GET',body,token=tokens.admin,binary=false}={}){const response=await nativeFetch(base+url,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,headers:response.headers,body:binary?Buffer.from(await response.arrayBuffer()):await response.json()};}
function addOrder(id,at,amount,{original=amount,coupon=0,bonus=0,stored=0,method='wechat',source='miniapp',pending=false,productId=1,quantity=1,cost=1000,itemPrice=amount+coupon}={}) {
  const no=id===100?'000012345678901234567890':`ORDER-${id}`;
  db.prepare('INSERT INTO orders(id,order_no,session_id,payer_user_id,original_amount_cents,discount_amount_cents,coupon_discount_cents,payable_amount_cents,payment_method,source_channel,stored_paid_cents,bonus_paid_cents,wechat_paid_cents,payment_status,status,created_at,paid_at) VALUES(?,?,1,1,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,no,original,original-amount,coupon,amount,method,source,stored,bonus,method==='group_buy'?0:amount-stored-bonus,pending?'pending':'paid',pending?'pending_payment':'completed',at,pending?null:at);
  if(productId===bundleId)insertSaleItems(id,bundleId,quantity,{paidPrice:amount,originalPrice:original});
  else db.prepare('INSERT INTO order_items(order_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents,delivered_quantity) VALUES(?,?,?,?,?,?,?,?)').run(id,productId,`商品-${productId}`,quantity,original/quantity,itemPrice/quantity,cost,pending?0:quantity);
  return no;
}
function ledgerFixture(){
  addOrder(90,'2026-10-12 13:00:00',5000,{cost:1000});
  addOrder(100,'2026-10-13 04:20:00',10000,{original:12000,coupon:1000,quantity:2,itemPrice:11000});
  addOrder(101,'2026-10-13 17:10:00',6000,{method:'mixed',stored:2000,bonus:1000,productId:4,cost:2000});
  addOrder(102,'2026-10-13 18:00:00',8999,{method:'group_buy',source:'meituan',productId:bundleId});
  addOrder(103,'2026-10-13 21:59:00',7000,{pending:true});addOrder(104,'2026-10-13 22:00:00',500);
  db.prepare("INSERT INTO refund_transactions(order_id,user_id,amount_cents,stored_cents,wechat_cents,out_refund_no,status,created_at,completed_at,returned_cost_cents) VALUES(90,1,2500,1000,1500,'REFUND-OLD','success','2026-10-13 04:50:00','2026-10-13 05:00:00',500)").run();
  db.prepare("INSERT INTO wallet_transactions(user_id,type,pay_cents,stored_cents,bonus_cents,remark,created_at,payment_channel) VALUES(1,'recharge',50000,50000,10000,'测试充值','2026-10-13 06:00:00','cash')").run();
  const mapping=db.prepare("INSERT INTO group_buy_mappings(store_id,platform,external_product_id,product_id,name) VALUES(1,'meituan','deal-fixture',?,'双人套餐')").run(bundleId).lastInsertRowid;
  db.prepare("INSERT INTO group_buy_redemptions(id,store_id,session_id,user_id,platform,certificate_id,voucher_hash,voucher_code,mapping_id,state,source,snapshot_json,provider_json,amount_cents,order_id) VALUES('redemption',1,1,1,'meituan','000012345678','hash','000012345678',?,'success','api','{}','{}',8999,102)").run(mapping);
  db.prepare("INSERT INTO group_buy_settlements(redemption_id,request_id,amount_cents,settled_at,operator_id,target_total_cents) VALUES('redemption','settlement-fixture',8000,'2026-10-13T19:00:00Z',1,8000)").run();
  db.prepare("UPDATE group_buy_redemptions SET actual_settlement_cents=8000,actual_settlement_at='2026-10-13T19:00:00Z' WHERE id='redemption'").run();
  db.prepare("INSERT INTO stock_losses(product_id,quantity,cost_cents,type,reason,operator_id,created_at) VALUES(1,1,200,'gift','测试赠送',1,'2026-10-13 08:00:00')").run();
  db.prepare("INSERT INTO inventory_logs(product_id,change_quantity,stock_after,reason,order_id,channel,created_at) VALUES(1,-2,98,'订单出库',100,'miniapp','2026-10-13 04:20:00')").run();
}
function feieMock({printed=false,timeoutPart=0,rejected=false,wait}={}) {
  process.env.FEIE_PRINTING_ENABLED='1';const calls=[];let prints=0;
  globalThis.fetch=async(url,options)=>{
    const payload=Object.fromEntries(new URLSearchParams(options.body)),action=String(url).split('/Open/')[1];calls.push({url:String(url),payload,action});
    assert.match(String(url),/^https:\/\/api\.feieyun\.cn\/Api\/Open\/[a-zA-Z]+$/);assert.equal(payload.user,'fixture-user');assert.equal(payload.sig,crypto.createHash('sha1').update('fixture-userfixture-ukey'+payload.stime).digest('hex'));assert.equal(payload.apiname,'Open_'+action);
    const response=data=>new Response(JSON.stringify({ret:0,msg:'ok',data}));
    if(action==='printerAddlist')return response({ok:[payload.printerContent],no:[]});
    if(action==='queryPrinterStatus')return response('在线，工作状态正常');
    if(action==='queryOrderState')return response(printed);
    if(action==='printMsg') {
      prints++;assert.equal(payload.times,'1');assert.equal(payload.sn,'316500011');assert.equal(payload.content.includes('<CUT>'),false);assert.ok(Buffer.byteLength(payload.content)<5000);assert.ok(Number(payload.expired)>Number(payload.stime));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM print_parts WHERE state='sending'").get().n,1);
      if(wait)await wait();if(prints===timeoutPart)throw new Error('fixture ambiguous timeout');if(rejected)return new Response(JSON.stringify({ret:1001,msg:'fixture rejected'}));
      return response('316500011_ORDER_'+prints);
    }
    throw new Error('Unexpected printer action');
  };return calls;
}
const preview=()=>call(`/admin/printing/preview?scope=bill&targetId=1&printerId=${printerId}`);
const print=body=>call('/admin/printing/jobs',{method:'POST',body});
test('business windows use the selected timezone and exact half-open timestamps in filenames',()=>{
  const w=businessWindow('2026-10-13');assert.equal(w.filename,'营业明细-202610131200-202610140600.xlsx');assert.equal(new Date(w.from).toISOString(),'2026-10-13T04:00:00.000Z');assert.equal(new Date(w.to).toISOString(),'2026-10-13T22:00:00.000Z');
  assert.equal(currentBusinessDate(undefined,Date.parse('2026-10-13T03:00:00Z')),'2026-10-12');
  assert.throws(()=>parseLocal('2026-02-30T12:00'));assert.throws(()=>reportWindow({startAt:'2026-10-13T12:00',endAt:'2026-10-13T12:00'}));
});
test('overnight reports reconcile payments, earlier-order refunds, bonuses, recharge and group settlement separately',async()=>{
  ledgerFixture();const result=await call('/admin/reports?'+windowQuery);assert.equal(result.status,200);const t=result.body.totals;
  assert.equal(t.orders,3);assert.equal(t.tables,1);assert.equal(t.revenue,214.99);assert.equal(t.orderCost,75.01);assert.equal(t.profit,137.98);assert.equal(t.externalNetReceived,695);assert.equal(t.rechargeReceived,500);assert.equal(t.settlementReceived,80);assert.equal(t.bonusUsed,10);
  assert.equal(result.body.byProduct.reduce((n,p)=>n+Math.round(p.amount*100),0),24999);
  const next=await call('/admin/reports?startAt=2026-10-14T06:00&endAt=2026-10-14T07:00');assert.equal(next.body.totals.orders,1);assert.equal(next.body.totals.revenue,5);
});
test('multi-day reports partition all money at business boundaries without losing opening or closing transactions',async()=>{
  ledgerFixture();const report=businessReport(reportWindow({startAt:'2026-10-12T15:00',endAt:'2026-10-14T07:00'}));
  assert.equal(report.daily.length,2);assert.equal(report.daily[0].startAt,'2026-10-12T15:00');assert.equal(report.daily.at(-1).endAt,'2026-10-14T07:00');
  for(const key of ['orders','revenue','orderCost','lossCost','profit'])assert.equal(Math.round(report.daily.reduce((n,d)=>n+d[key],0)*100),Math.round(report.totals[key]*100));
  assert.equal(report.daily.reduce((n,d)=>n+d.recharge,0),report.totals.rechargeReceived);
});
test('settlements preserve actual arrival dates and record only correction differences with duplicate-request protection',async()=>{
  ledgerFixture();const body={amount:75,settledAt:'2026-10-14T07:00',requestId:crypto.randomUUID()},url='/admin/group-buy/redemption/settlement';
  assert.equal((await call(url,{method:'PATCH',body})).status,200);assert.equal((await call(url,{method:'PATCH',body})).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_buy_settlements').get().n,2);
  assert.equal((await call(url,{method:'PATCH',body:{...body,amount:74}})).status,409);
  const next=await call('/admin/reports?startAt=2026-10-14T06:00&endAt=2026-10-14T08:00');assert.equal(next.body.totals.settlementReceived,-5);
});
test('Excel export has ten readable, typed sheets and preserves exact identifiers and coupon reconciliation',async()=>{
  ledgerFixture();const response=await call('/admin/reports/export?'+windowQuery+'&source=meituan&q=ORDER-102&page=2',{binary:true});assert.equal(response.status,200);assert.ok(response.body.subarray(0,2).equals(Buffer.from('PK')));assert.ok(decodeURIComponent(response.headers.get('content-disposition')).includes('营业明细-202610131200-202610140600.xlsx'));
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(response.body);assert.deepEqual(workbook.worksheets.map(s=>s.name),['营业总览','订单明细','桌台账单','商品明细','收付流水','退款明细','团购结算','基础货品流水','会员充值记录','统计说明']);
  const orders=workbook.getWorksheet('订单明细');assert.ok(orders.autoFilter);assert.equal(orders.views[0].ySplit,4);const order=orders.getRows(5,orders.rowCount-4).find(r=>r.getCell(1).value==='000012345678901234567890');assert.equal(typeof order.getCell(1).value,'string');const amountColumn=orders.getRow(4).values.indexOf('结算金额');assert.equal(typeof order.getCell(amountColumn).value,'number');assert.ok(order.getCell(5).value instanceof Date);
  const productRows=workbook.getWorksheet('商品明细').getRows(5,workbook.getWorksheet('商品明细').rowCount-4);const product=productRows.find(r=>r.getCell(1).value==='000012345678901234567890');assert.equal(product.getCell(8).value,110);assert.equal(product.getCell(9).value,10);assert.equal(product.getCell(10).value,100);
  assert.equal(productRows.filter(r=>r.getCell(4).value==='套餐').length,1);assert.equal(JSON.stringify(workbook.model).includes('fixture-ukey'),false);
  const summary=workbook.getWorksheet('营业总览');assert.equal(summary.getCell('A6').value,214.99);assert.equal(summary.getCell('F6').value,137.98);assert.equal(summary.getCell('N6').value,695);assert.equal(summary.getCell('J6').numFmt,'0.00%');assert.equal(summary.getCell('J6').value,137.98/214.99);
  const revenueColumn=orders.getRow(4).values.indexOf('本期净销售贡献');assert.equal(Math.round(orders.getRows(5,orders.rowCount-4).reduce((n,r)=>n+r.getCell(revenueColumn).value,0)*100),21499);
  const checks=workbook.getWorksheet('统计说明');for(let r=14;r<=checks.rowCount;r++)assert.equal(checks.getCell(r,4).value,0);
});
test('interactive report charts and paginated drill-downs reconcile the full window including cross-period refunds',async()=>{
  ledgerFixture();const response=await call('/admin/reports?'+windowQuery),r=response.body;
  assert.equal(r.totals.grossMarginRate,137.98/214.99);
  assert.equal(Math.round(r.bySource.reduce((n,s)=>n+s.revenue,0)*100),21499);
  assert.equal(r.externalChannels.reduce((n,s)=>n+s.net,0),695);
  for(const key of ['revenue','profit','orderCost','lossCost'])assert.equal(Math.round(r.trend.reduce((n,s)=>n+s[key],0)*100),Math.round(r.totals[key]*100));
  const page=await call('/admin/reports/details?'+windowQuery+'&q=13800138001&pageSize=2&page=2');assert.equal(page.status,200);assert.equal(page.body.pagination.total,5);assert.equal(page.body.pagination.page,2);assert.equal(page.body.rows.length,2);
  assert.ok(page.body.rows.every(o=>o.payerPhone==='13800138001'));assert.equal(JSON.stringify(page.body).includes('provider_json'),false);
  const source=await call('/admin/reports/details?'+windowQuery+'&source=meituan');assert.equal(source.body.rows.length,1);assert.equal(source.body.rows[0].orderNo,'ORDER-102');
  const details=await call('/admin/reports/orders/90?'+windowQuery);assert.equal(details.body.order.scope,'跨期退款');assert.equal(details.body.order.revenue,-25);assert.equal(details.body.order.returnedCost,5);
  const refundSegment=r.trend.find(s=>s.startAt==='2026-10-13T13:00');const filtered=await call('/admin/reports/details?'+new URLSearchParams({startAt:'2026-10-13T12:00',endAt:'2026-10-14T06:00',segmentStart:refundSegment.startAt,segmentEnd:refundSegment.endAt}));assert.deepEqual(filtered.body.rows.map(o=>o.id),[90]);
  const arrived=await call('/admin/reports/details?'+windowQuery+'&kind=flows&channel=settlement:meituan');assert.equal(arrived.body.rows.length,1);assert.equal(arrived.body.rows[0].amount,80);assert.equal(arrived.body.rows[0].external,true);
  const internal=await call('/admin/reports/details?'+windowQuery+'&kind=flows&channel=meituan');assert.equal(internal.body.rows.length,1);assert.equal(internal.body.rows[0].external,false);
  assert.equal((await call('/admin/reports/details?'+windowQuery+'&segmentStart=2026-10-12T12:00&segmentEnd=2026-10-13T13:00')).status,400);
  assert.equal((await call('/admin/reports/orders/104?'+windowQuery)).status,404);
});
test('missing historical costs stay unknown in cards, trends and Excel instead of fabricating zero profit',async()=>{
  ledgerFixture();db.prepare("UPDATE refund_transactions SET returned_cost_cents=NULL WHERE out_refund_no='REFUND-OLD'").run();
  const r=(await call('/admin/reports?'+windowQuery)).body;assert.equal(r.totals.orderCost,null);assert.equal(r.totals.profit,null);assert.equal(r.totals.grossMarginRate,null);assert.ok(r.trend.some(s=>s.profit===null));
  const exported=await call('/admin/reports/export?'+windowQuery,{binary:true}),book=new ExcelJS.Workbook();await book.xlsx.load(exported.body);assert.equal(book.getWorksheet('营业总览').getCell('F6').value,null);assert.equal(book.getWorksheet('营业总览').getCell('J6').value,null);
});
test('sales rankings never combine different historical units of the same product into a false quantity',async()=>{
  addOrder(100,'2026-10-13 04:20:00',7600,{quantity:2});addOrder(101,'2026-10-13 05:20:00',20000);
  db.prepare("UPDATE order_items SET unit_snapshot=CASE order_id WHEN 100 THEN '瓶' ELSE '箱' END").run();
  const r=(await call('/admin/reports?'+windowQuery)).body;
  assert.equal(r.byProduct.length,2);assert.equal(r.byProduct.find(p=>p.unit==='瓶').quantity,2);assert.equal(r.byProduct.find(p=>p.unit==='箱').quantity,1);
  assert.equal(r.byProduct.reduce((n,p)=>n+p.amount,0),276);
});
test('pending customer applications remain queryable without reducing sales, and historical group arrivals exclude later corrections',async()=>{
  ledgerFixture();addOrder(89,'2026-10-12 13:00:00',2000);
  db.prepare("INSERT INTO refund_requests(order_id,user_id,amount_cents,reason,created_at) VALUES(89,1,500,'待审核不扣数','2026-10-13 09:00:00')").run();
  const r=(await call('/admin/reports?'+windowQuery)).body;assert.equal(r.totals.pendingRefunds,1);assert.equal(r.totals.revenue,214.99);
  const pending=(await call('/admin/reports/details?'+windowQuery+'&status=pendingRefund')).body;assert.deepEqual(pending.rows.map(o=>o.id),[89]);assert.equal(pending.rows[0].revenue,0);
  const detail=(await call('/admin/reports/orders/89?'+windowQuery)).body.order;assert.equal(detail.refunds[0].confirmed,null);assert.equal(detail.refunds[0].statusLabel,'待审核申请');
  db.prepare("UPDATE group_buy_redemptions SET expected_settlement_cents=9000 WHERE id='redemption'").run();
  assert.equal((await call('/admin/group-buy/redemption/settlement',{method:'PATCH',body:{amount:75,settledAt:'2026-10-14T07:00',requestId:crypto.randomUUID()}})).status,200);
  const before=(await call('/admin/reports/details?'+windowQuery+'&kind=redemptions')).body.rows[0];assert.equal(before.registered,80);assert.equal(before.inRangeReceived,80);assert.equal(before.pending,10);assert.equal(before.settlements.length,1);
  const after=(await call('/admin/reports/details?startAt=2026-10-14T06:00&endAt=2026-10-14T08:00&kind=redemptions')).body.rows[0];assert.equal(after.registered,75);assert.equal(after.inRangeReceived,-5);assert.equal(after.paidInRange,false);
});
test('export identifies payers by their own phone and stable member ID after a nickname change, including unbound accounts',async()=>{
  const sameName='同名会员';db.prepare('UPDATE users SET nickname=? WHERE id=1').run(sameName);
  const other=db.prepare('INSERT INTO users(nickname,phone) VALUES(?,?)').run(sameName,'13900139001').lastInsertRowid;
  addOrder(100,'2026-10-13 04:20:00',3800);addOrder(101,'2026-10-13 05:10:00',4200);db.prepare('UPDATE orders SET payer_user_id=? WHERE id=101').run(other);
  db.prepare("UPDATE users SET nickname='修改后昵称' WHERE id=1").run();
  const exportOrders=async()=>{const response=await call('/admin/reports/export?'+windowQuery,{binary:true});assert.equal(response.status,200);const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(response.body);return workbook.getWorksheet('订单明细');};
  const sheet=await exportOrders(),headers=sheet.getRow(4).values,nameColumn=headers.indexOf('付款人'),phoneColumn=headers.indexOf('付款人手机号'),idColumn=headers.indexOf('付款人会员ID');
  assert.equal(phoneColumn,nameColumn+1);assert.equal(idColumn,phoneColumn+1);
  const rows=sheet.getRows(5,sheet.rowCount-4),first=rows.find(r=>r.getCell(1).value==='000012345678901234567890'),second=rows.find(r=>r.getCell(1).value==='ORDER-101');
  assert.equal(first.getCell(nameColumn).value,'修改后昵称');assert.equal(first.getCell(phoneColumn).value,'13800138001');assert.equal(first.getCell(idColumn).value,'1');assert.equal(first.getCell(phoneColumn).numFmt,'@');assert.equal(first.getCell(idColumn).numFmt,'@');
  assert.equal(second.getCell(nameColumn).value,sameName);assert.equal(second.getCell(phoneColumn).value,'13900139001');assert.equal(second.getCell(idColumn).value,String(other));
  db.prepare('UPDATE users SET phone=NULL WHERE id=1').run();const unbound=(await exportOrders()).getRows(5,2).find(r=>r.getCell(idColumn).value==='1');assert.equal(unbound.getCell(phoneColumn).value,'未绑定手机号');
  assert.equal((await call('/admin/reports/export?'+windowQuery,{token:tokens.waiter})).status,403);
});
test('settings change the default overnight boundary and export title without depending on the server timezone',async()=>{
  const result=await call('/admin/reports/settings',{method:'PUT',body:{timezone:'Asia/Kuala_Lumpur',openTime:'15:30',closeTime:'05:15',exportTitle:'晚场营业'}});assert.equal(result.status,200);
  const report=await call('/admin/reports?date=2026-10-13');assert.equal(report.body.dateRange.filename,'晚场营业-202610131530-202610140515.xlsx');
  assert.equal((await call('/admin/reports/settings',{method:'PUT',body:{exportTitle:'bad/name'}})).status,400);
  assert.equal((await call('/admin/reports/export?'+windowQuery,{token:tokens.cashier})).status,403);
});
test('all add-on orders share one bill and closing captures an immutable final version',async()=>{
  ledgerFixture();let response=await call('/admin/bills/1');assert.equal(response.body.bill.totals.paidOrders,5);assert.equal(response.body.bill.totals.pendingOrders,1);assert.equal(response.body.bill.totals.net,27999);
  assert.equal(JSON.stringify(response.body).includes('cost_price_cents'),false);assert.equal((await call('/admin/tables/1/close',{method:'POST',body:{}})).status,409);
  db.prepare("UPDATE orders SET payment_status='closed',status='cancelled' WHERE id=103").run();assert.equal((await call('/admin/tables/1/close',{method:'POST',body:{}})).status,200);
  const saved=db.prepare('SELECT * FROM bill_snapshots WHERE session_id=1').get(),snapshot=JSON.parse(saved.snapshot_json);assert.equal(snapshot.sessionStatus,'closed');
  db.prepare("UPDATE orders SET note='after close correction' WHERE id=100").run();assert.equal(db.prepare('SELECT snapshot_json FROM bill_snapshots WHERE session_id=1').get().snapshot_json,saved.snapshot_json);assert.equal((await preview()).body.data.adjustedAfterClose,true);
  assert.equal((await call('/admin/pos/orders',{token:tokens.cashier,method:'POST',body:{tableId:1,phone:'13800138001',paymentMethod:'cash',items:[{productId:1,quantity:1}],requestId:crypto.randomUUID()}})).status,201);
  const active=db.prepare("SELECT * FROM table_sessions WHERE status='open'").get();assert.notEqual(active.bill_no,snapshot.billNo);
});
test('waiters cannot view financial receipts or configure printers, while cashiers can print without secret access',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);assert.equal((await call('/admin/printing',{token:tokens.waiter})).status,403);assert.equal((await call('/admin/bills',{token:tokens.waiter})).status,403);
  const data=(await call('/admin/printing',{token:tokens.cashier})).body;assert.equal(data.canConfigure,false);assert.equal(JSON.stringify(data).includes('abcdefgh'),false);assert.equal(JSON.stringify(data).includes('fixture-ukey'),false);
  assert.equal((await call('/admin/printing/template',{token:tokens.cashier,method:'PUT',body:{}})).status,403);
});
test('receipt names follow branding in previews, allow a separate saved name and retain the original name on reprints',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);
  const sample=template=>call('/admin/printing/template/preview',{method:'POST',body:{template,paperWidth:58}});
  assert.equal((await sample({})).body.lines[0].text,'测试门店');
  const entries=(await call('/admin/mini-page')).body.entries.map(e=>({...e,title:e.key==='app_name'?'联动门店':e.title}));
  assert.equal((await call('/admin/mini-page',{method:'PUT',body:{entries}})).status,200);
  assert.equal((await sample({})).body.lines[0].text,'联动门店');assert.equal((await preview()).body.lines[0].text,'联动门店');
  assert.equal((await call('/admin/printing')).body.storeName,'联动门店');
  const saved=await call('/admin/printing/template',{method:'PUT',body:{storeNameOverride:'  小票专用店名  '}});assert.equal(saved.status,200);assert.equal(saved.body.template.storeNameOverride,'小票专用店名');
  assert.equal((await sample(saved.body.template)).body.lines[0].text,'小票专用店名');
  assert.equal((await call(`/admin/printing/preview?scope=order&targetId=100&printerId=${printerId}`)).body.lines[0].text,'小票专用店名');
  const p=(await preview()).body;assert.equal(p.lines[0].text,'小票专用店名');assert.equal(db.prepare('SELECT name FROM stores WHERE id=1').get().name,'联动门店');
  for(const storeNameOverride of ['长'.repeat(41),'换行\n店名',null])assert.equal((await call('/admin/printing/template',{method:'PUT',body:{storeNameOverride}})).status,400);
  const calls=feieMock({printed:true}),first=(await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision})).body.job;
  assert.equal((await call(`/admin/printing/jobs/${first.id}/check`,{method:'POST',body:{}})).body.job.state,'printed');
  assert.equal((await call('/admin/printing/template',{method:'PUT',body:{storeNameOverride:''}})).status,200);
  assert.equal((await preview()).body.lines[0].text,'联动门店');assert.equal((await call(`/admin/printing/jobs/${first.id}`)).body.job.lines[0].text,'小票专用店名');
  assert.equal((await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:first.revision,reprintOf:first.id,paperChecked:true,reason:'需要原版小票'})).status,201);
  const copy=calls.filter(c=>c.action==='printMsg').at(-1).payload.content;assert.match(copy,/<CB>小票专用店名<\/CB>/);assert.equal(copy.includes('联动门店'),false);
});
test('new receipts for closed bills use the current configured heading without changing historical bills or printed originals',async()=>{
  const oldName='Echo HX Live Bar',newName='Echo 回响 Live Bar';
  const heading=p=>p.lines.slice(0,p.lines.findIndex(line=>line.size!=='large')).map(line=>line.text).join('');
  db.prepare('UPDATE stores SET name=? WHERE id=1').run(oldName);addOrder(100,'2026-10-13 10:00:00',3800);
  assert.equal((await call('/admin/tables/1/close',{method:'POST',body:{}})).status,200);
  const closed=db.prepare('SELECT snapshot_json FROM bill_snapshots WHERE session_id=1').get().snapshot_json;
  const before=(await preview()).body,calls=feieMock({printed:true});assert.equal(heading(before),oldName);
  const original=(await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:before.revision})).body.job;
  await call(`/admin/printing/jobs/${original.id}/check`,{method:'POST',body:{}});
  const legacy=JSON.parse(db.prepare('SELECT snapshot_json FROM print_jobs WHERE id=?').get(original.id).snapshot_json);
  delete legacy.data.receiptStoreName;db.prepare('UPDATE print_jobs SET snapshot_json=? WHERE id=?').run(JSON.stringify(legacy),original.id);
  const entries=(await call('/admin/mini-page')).body.entries.map(e=>({...e,title:e.key==='app_name'?newName:e.title}));
  assert.equal((await call('/admin/mini-page',{method:'PUT',body:{entries}})).status,200);
  const sample=(await call('/admin/printing/template/preview',{method:'POST',body:{template:{},paperWidth:58}})).body;
  const current=(await preview()).body,order=(await call(`/admin/printing/preview?scope=order&targetId=100&printerId=${printerId}`)).body;
  assert.equal(heading(sample),newName);assert.equal(heading(current),newName);assert.equal(heading(order),newName);
  assert.equal(current.data.storeName,oldName);assert.equal(current.data.revision,before.data.revision);assert.equal(current.data.adjustedAfterClose,undefined);
  assert.notEqual(current.revision,before.revision);
  assert.equal((await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:before.revision})).status,409);
  const fresh=(await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:current.revision})).body.job;
  assert.notEqual(fresh.id,original.id);assert.equal(heading(fresh),newName);
  assert.equal(db.prepare('SELECT snapshot_json FROM bill_snapshots WHERE session_id=1').get().snapshot_json,closed);
  assert.equal(heading((await call(`/admin/printing/jobs/${original.id}`)).body.job),oldName);
  assert.equal((await call('/admin/printing/template',{method:'PUT',body:{storeNameOverride:'小票独立店名'}})).status,200);
  assert.equal(heading((await preview()).body),'小票独立店名');
  assert.equal(heading((await call(`/admin/printing/preview?scope=order&targetId=100&printerId=${printerId}`)).body),'小票独立店名');
  // Both legacy snapshots and new snapshots retain the name actually printed.
  for(const job of [original,fresh]) {
    await call(`/admin/printing/jobs/${job.id}/check`,{method:'POST',body:{}});
    const copy=await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:job.revision,reprintOf:job.id,paperChecked:true,reason:'核对原版店名'});
    assert.equal(copy.status,201);assert.equal(heading(copy.body.job),job.id===original.id?oldName:newName);
    assert.equal(heading((await call(`/admin/printing/jobs/${job.id}`)).body.job),job.id===original.id?oldName:newName);
  }
  const copies=calls.filter(c=>c.action==='printMsg').slice(-2).map(c=>c.payload.content);
  assert.match(copies[0],/<CB>Echo HX Live Bar<\/CB>/);assert.equal(copies[0].includes('小票独立店名'),false);
  assert.equal(copies[1].includes('<CB>Echo 回响 Live '),true);assert.equal(copies[1].includes('小票独立店名'),false);
});
test('disabled Feie cannot enqueue or fake a successful print',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);const p=(await preview()).body;
  assert.equal((await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision})).status,503);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM print_jobs').get().n,0);
});
test('Feie sends signed text to the new endpoints, preserves a receipt snapshot and does not resend duplicate clicks',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);const calls=feieMock(),p=(await preview()).body,body={scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision};
  const first=(await print(body)).body.job;assert.equal(first.state,'accepted');assert.equal((await print(body)).body.job.id,first.id);assert.equal((await print({...body,requestId:crypto.randomUUID()})).body.job.id,first.id);assert.equal(calls.filter(c=>c.action==='printMsg').length,1);
  db.prepare("UPDATE orders SET status='awaiting_delivery' WHERE id=100").run();const deliveryPreview=(await preview()).body;assert.equal(deliveryPreview.revision,p.revision);
  assert.equal((await print({...body,requestId:crypto.randomUUID(),expectedRevision:deliveryPreview.revision})).body.job.id,first.id);assert.equal(calls.filter(c=>c.action==='printMsg').length,1);
  assert.equal((await call(`/admin/printing/jobs/${first.id}/check`,{method:'POST',body:{}})).body.job.state,'accepted');
  db.prepare("UPDATE orders SET note='changed after dispatch' WHERE id=100").run();assert.equal((await print({...body,requestId:crypto.randomUUID()})).status,409);assert.equal(JSON.stringify((await call(`/admin/printing/jobs/${first.id}`)).body.job.lines).includes('changed after dispatch'),false);
});
test('a late platform query cannot reopen a manually cancelled ambiguous print',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);feieMock();const p=(await preview()).body,first=(await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision})).body.job;
  let queryStarted,release;const started=new Promise(resolve=>{queryStarted=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const providerFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/queryOrderState')){queryStarted();await waiting;return new Response(JSON.stringify({ret:0,msg:'ok',data:true}));}return providerFetch(url,options);};
  const pendingCheck=call(`/admin/printing/jobs/${first.id}/check`,{method:'POST',body:{}});await started;
  db.prepare("UPDATE print_jobs SET state='unknown' WHERE id=?").run(first.id);db.prepare('UPDATE print_parts SET expires_at=? WHERE job_id=?').run(Math.floor(Date.now()/1000)-1,first.id);
  assert.equal((await call(`/admin/printing/jobs/${first.id}/resolve`,{method:'POST',body:{outcome:'not_printed',paperChecked:true,reason:'有效期后现场核对，停止等待'}})).body.job.state,'cancelled');
  release();assert.equal((await pendingCheck).body.job.state,'cancelled');assert.equal((await call(`/admin/printing/jobs/${first.id}`)).body.job.state,'cancelled');
});
test('uploaded header and footer images preview together while cloud printing rejects unsupported double-image output',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=';
  assert.equal((await call('/admin/printing/assets',{method:'POST',body:{image},token:tokens.cashier})).status,403);
  const asset=await call('/admin/printing/assets',{method:'POST',body:{image}});assert.equal(asset.status,201);
  assert.equal((await call('/admin/printing/template',{method:'PUT',body:{logoEnabled:true,logoUrl:asset.body.url,qrMode:'image',qrImageUrl:asset.body.url,footerLines:[{text:'联系门店',align:'center',size:'bold'}]}})).status,200);
  feieMock();const p=(await preview()).body;assert.equal(p.lines.filter(l=>l.type==='logo'||l.type==='qr-image').length,2);
  assert.equal((await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision})).status,409);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM print_jobs').get().n,0);
});
test('reprints use the original template and payment snapshot and explicitly mark the copy',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);const calls=feieMock({printed:true}),p=(await preview()).body,first=(await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision})).body.job;
  assert.equal((await call(`/admin/printing/jobs/${first.id}/check`,{method:'POST',body:{}})).body.job.state,'printed');
  db.prepare("UPDATE receipt_templates SET settings_json=?,revision=revision+1").run(JSON.stringify({headerLines:[{text:'NEW TEMPLATE',align:'center',size:'bold'}]}));db.prepare("UPDATE orders SET note='NEW PAYMENT NOTE' WHERE id=100").run();
  const copy=await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:first.revision,reprintOf:first.id,paperChecked:true,reason:'顾客需要一份补打'});assert.equal(copy.status,201);const content=calls.filter(c=>c.action==='printMsg').at(-1).payload.content;assert.match(content,/补打/);assert.equal(content.includes('NEW TEMPLATE'),false);assert.equal(content.includes('NEW PAYMENT NOTE'),false);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,1);
});
test('long receipts split under 5000 bytes, keep ambiguous parts and never blindly resend after restart',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);db.prepare('UPDATE orders SET note=? WHERE id=100').run('较长的文字备注'.repeat(1400));const calls=feieMock({timeoutPart:2}),p=(await preview()).body,body={scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision};
  const first=(await print(body)).body.job;assert.equal(first.state,'unknown');assert.ok(first.parts.length>2);assert.equal(calls.filter(c=>c.action==='printMsg').length,2);migrateCommerce(db);
  assert.equal((await print(body)).body.job.state,'unknown');assert.equal(calls.filter(c=>c.action==='printMsg').length,2);
  assert.equal((await call(`/admin/printing/jobs/${first.id}/resolve`,{method:'POST',body:{outcome:'not_printed',paperChecked:true,reason:'尚未出纸'}})).status,409);
  const resumed=await call(`/admin/printing/jobs/${first.id}/resolve`,{method:'POST',body:{outcome:'printed',paperChecked:true,reason:'已核对前两段已经出纸'}});assert.equal(resumed.status,200);assert.equal(calls.filter(c=>c.action==='printMsg').length,first.parts.length);
});
test('cloud markup is escaped; a device bitmap can print a logo or uploaded mini-program code, not two unrelated images',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);db.prepare("UPDATE orders SET note='<CUT><QR>evil</QR>' WHERE id=100").run();const calls=feieMock(),image='/api/product-images/11111111-1111-1111-1111-111111111111.png';
  assert.equal((await call('/admin/printing/template',{method:'PUT',body:{logoEnabled:false,qrMode:'device_image',qrImageUrl:image,qrCaption:'进入小程序'}})).status,200);
  let p=(await preview()).body;assert.equal((await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision})).status,409);
  assert.equal((await call(`/admin/printing/printers/${printerId}/logo-confirm`,{method:'POST',body:{deviceLogoChecked:true}})).status,200);
  p=(await preview()).body;assert.equal((await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision})).status,201);const content=calls.find(c=>c.action==='printMsg').payload.content;assert.match(content,/<LOGO>/);assert.equal(content.includes('<QR>evil</QR>'),false);assert.ok(content.includes('＜CUT＞'));
  assert.equal((await call('/admin/printing/template',{method:'PUT',body:{logoEnabled:true,logoUrl:image,qrMode:'device_image',qrImageUrl:image}})).status,400);
});
test('platform-confirmed state uses real printer text status and backup restoration removes device keys and blocks replay',async()=>{
  addOrder(100,'2026-10-13 10:00:00',3800);feieMock();assert.equal((await call(`/admin/printing/printers/${printerId}/status`)).body.status.code,1);
  const p=(await preview()).body;await print({scope:'bill',targetId:1,printerId,requestId:crypto.randomUUID(),expectedRevision:p.revision});
  const backup=await createBackup();await beginRestore();try{await restoreBackup(path.join(work,'backups',backup.name));}finally{endRestore();}
  const {db:restored}=await import('../server/db.js');assert.equal(restored.prepare('SELECT device_key FROM receipt_printers').get().device_key,'');assert.equal(restored.prepare('SELECT bound FROM receipt_printers').get().bound,0);assert.equal(restored.prepare('SELECT state FROM print_jobs').get().state,'unknown');
});
