import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'echo-workdesk-tests-'));
Object.assign(process.env,{DATA_DIR:temp,BACKUP_DIR:path.join(temp,'backups'),ECHO_ENV_FILE:path.join(temp,'.env'),NODE_ENV:'production',ALLOW_DEMO_USER:'false',ADMIN_INITIAL_PASSWORD:'workdesk-test-password'});
const {db}=await import('../server/db.js');
const {createApp}=await import('../server/app.js');
let server,base;
const tokens={admin:'a'.repeat(64),workerA:'b'.repeat(64),workerB:'c'.repeat(64),cashier:'d'.repeat(64),user:'e'.repeat(64),outsider:'f'.repeat(64)};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const ids={};
async function call(url,{token=tokens.admin,method='GET',body}={}){const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()};}
const post=(url,body,token=tokens.admin)=>call(url,{method:'POST',body,token});
before(async()=>{
 server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}/api`;
 db.prepare('INSERT INTO staff_sessions(token_hash,account_id,expires_at) VALUES(?,1,?)').run(hash(tokens.admin),new Date(Date.now()+3600000).toISOString());
 for(const [key,workspace]of[['workerA','waiter'],['workerB','waiter'],['cashier','cashier']]){
  const result=await post('/admin/accounts',{username:key,displayName:key,password:'test-worker-password',role:'staff',workspace});assert.equal(result.status,201);ids[key]=result.body.account.id;
  db.prepare('INSERT INTO staff_sessions(token_hash,account_id,expires_at) VALUES(?,?,?)').run(hash(tokens[key]),ids[key],new Date(Date.now()+3600000).toISOString());
 }
 db.prepare("INSERT INTO users(id,nickname) VALUES(2,'Another guest')").run();db.prepare('INSERT INTO wallet_accounts(user_id) VALUES(2)').run();
});
beforeEach(()=>{
 db.transaction(()=>{
  for(const table of['service_submit_commands','service_request_notes','service_requests','fulfillment_batch_items','fulfillment_batches','work_events','user_coupons','refund_transactions','refund_requests','points_ledger','wallet_transactions','user_messages','inventory_logs','order_items','orders','cart_items','session_members','table_sessions','wechat_sessions'])db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("UPDATE products SET stock=100,reserved_stock=0,status='active',price_cents=3000,member_price_cents=3000,cost_cents=1000").run();
  db.prepare('UPDATE wallet_accounts SET stored_cents=10000,bonus_cents=0,stored_reserved_cents=0,bonus_reserved_cents=0').run();
  db.prepare("UPDATE users SET member_tier_id=NULL,member_level='普通会员',member_discount=1,points=0,member_expires_at=NULL").run();db.prepare("UPDATE member_tiers SET status='inactive'").run();
  db.prepare("INSERT INTO table_sessions(id,store_id,table_id,session_no) VALUES(1,1,1,'WORK-SESSION')").run();db.prepare('INSERT INTO session_members(session_id,user_id) VALUES(1,1)').run();
  for(const [key,userId]of[['user',1],['outsider',2]])db.prepare('INSERT INTO wechat_sessions(token_hash,user_id,openid,expires_at) VALUES(?,?,?,?)').run(hash(tokens[key]),userId,`test-openid-${userId}`,new Date(Date.now()+3600000).toISOString());
 }).immediate();
});
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(temp,{recursive:true,force:true});});
function paidOrder(quantity=2){db.prepare("INSERT INTO orders(id,order_no,session_id,payer_user_id,original_amount_cents,payable_amount_cents,payment_method,stored_paid_cents,status,payment_status,paid_at) VALUES(100,'WORK-ORDER',1,1,?,?, 'balance',?,'awaiting_delivery','paid',CURRENT_TIMESTAMP)").run(quantity*3000,quantity*3000,quantity*3000);db.prepare("INSERT INTO order_items(id,order_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents) VALUES(100,100,1,'Test beer',?,3000,3000,1000)").run(quantity);db.prepare('UPDATE products SET stock=stock-? WHERE id=1').run(quantity);}
async function prepare(quantity=1,startDelivery=false,key=crypto.randomUUID()){
 const claimed=await post('/admin/workdesk/orders/100/claim',{revision:0},tokens.workerA);assert.equal(claimed.status,200);
 const result=await post('/admin/workdesk/orders/100/batches',{revision:db.prepare('SELECT fulfillment_revision AS r FROM orders WHERE id=100').get().r,items:[{orderItemId:100,quantity}],startDelivery,requestId:key},tokens.workerA);assert.equal(result.status,200,JSON.stringify(result.body));return result.body.batch;
}
const service=(type='help',note='',requestId=crypto.randomUUID(),token=tokens.user)=>post('/sessions/1/services',{type,note,requestId},token);

test('workspaces give waiter and cashier separate capabilities and never expose financial fields',async()=>{
 const worker=(await call('/admin/session',{token:tokens.workerA})).body.account;assert.equal(worker.workspace,'waiter');assert.deepEqual(worker.permissions,['workdesk']);
 const cashier=(await call('/admin/session',{token:tokens.cashier})).body.account;assert.equal(cashier.workspace,'cashier');assert.deepEqual(cashier.permissions,['pos','orders']);
 assert.equal((await call('/admin/orders',{token:tokens.workerA})).status,403);assert.equal((await call('/admin/pos',{token:tokens.workerA})).status,403);assert.equal((await call('/admin/workdesk',{token:tokens.cashier})).status,403);
 paidOrder();const view=(await call('/admin/workdesk',{token:tokens.workerA})).body.orders[0];assert.equal(view.tableNo,'A-08');assert.equal(view.items[0].quantity,2);
 for(const field of['payable_amount_cents','profit','cost','storedPaid','phone','payer_user_id'])assert.equal(Object.hasOwn(view,field),false);
});

test('only authenticated members of an open table can call or inspect service requests',async()=>{
 assert.equal((await service('help','',crypto.randomUUID(),null)).status,401);
 assert.equal((await service('help','',crypto.randomUUID(),tokens.outsider)).status,403);
 assert.equal((await call('/sessions/1/services',{token:tokens.outsider})).status,403);
 db.prepare("UPDATE table_sessions SET status='closed' WHERE id=1").run();assert.equal((await service()).status,409);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_requests').get().n,0);
});

test('retries and same-table calls merge without losing additional notes',async()=>{
 const key=crypto.randomUUID();const first=await service('tissue','需要两份纸巾',key);assert.equal(first.status,200);
 assert.equal((await service('tissue','需要两份纸巾',key)).body.repeated,true);
 const second=await service('tissue','再补一份纸巾');assert.equal(second.body.merged,true);assert.equal(second.body.request.id,first.body.request.id);
 assert.deepEqual(second.body.request.notes.map(note=>note.content),['需要两份纸巾','再补一份纸巾']);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_requests').get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind='service_new'").get().n,1);
 assert.equal((await service('help','changed',key)).status,409);
});

test('an explicit repeat call preserves identical notes and alerts the current owner again',async()=>{
 const key=crypto.randomUUID();const first=(await service('tissue','需要两份纸巾',key)).body.request;
 assert.equal((await service('tissue','需要两份纸巾',key)).body.request.callCount,1);
 const claimed=(await post(`/admin/workdesk/requests/${first.id}/claim`,{revision:first.revision},tokens.workerA)).body.request;
 const before=(await call('/admin/workdesk',{token:tokens.workerA})).body.cursor;
 const again=(await service('tissue','需要两份纸巾')).body.request;
 assert.equal(again.callCount,2);assert.deepEqual(again.notes.map(note=>note.content),['需要两份纸巾','需要两份纸巾']);
 assert.equal((await post(`/admin/workdesk/requests/${first.id}/complete`,{revision:claimed.revision},tokens.workerA)).status,409);
 const refreshed=(await call(`/admin/workdesk?after=${before}`,{token:tokens.workerA})).body;
 assert.ok(refreshed.events.some(event=>event.kind==='service_note'&&event.entity_id===first.id));
});

test('service claim is exclusive and completion checks newly added notes',async()=>{
 const first=(await service('other','帮忙调整空调')).body.request;
 const results=await Promise.all([post(`/admin/workdesk/requests/${first.id}/claim`,{revision:first.revision},tokens.workerA),post(`/admin/workdesk/requests/${first.id}/claim`,{revision:first.revision},tokens.workerB)]);
 assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
 const claimed=results.find(result=>result.status===200).body.request,ownerToken=claimed.assignedStaffId===ids.workerA?tokens.workerA:tokens.workerB,otherToken=ownerToken===tokens.workerA?tokens.workerB:tokens.workerA;
 const updated=(await service('other','还需要关小一点音乐')).body.request;
 assert.equal((await post(`/admin/workdesk/requests/${first.id}/complete`,{revision:claimed.revision},ownerToken)).status,409);
 assert.equal((await post(`/admin/workdesk/requests/${first.id}/complete`,{revision:updated.revision},otherToken)).status,403);
 const complete=await post(`/admin/workdesk/requests/${first.id}/complete`,{revision:updated.revision,note:'已调整'},ownerToken);assert.equal(complete.body.request.status,'completed');
 assert.equal((await post(`/admin/workdesk/requests/${first.id}/complete`,{revision:updated.revision},ownerToken)).status,200);
 const next=(await service('other','新的需求')).body.request;assert.notEqual(next.id,first.id);
});

test('administrative transfers invalidate stale completion and retain responsibility',async()=>{
 const request=(await service()).body.request;const claimed=(await post(`/admin/workdesk/requests/${request.id}/claim`,{revision:request.revision},tokens.workerA)).body.request;
 assert.equal((await post('/admin/workdesk/transfer',{kind:'service',id:request.id,targetId:ids.workerB,reason:'换班',revision:claimed.revision},tokens.workerA)).status,403);
 assert.equal((await post('/admin/workdesk/transfer',{kind:'service',id:request.id,targetId:ids.workerB,reason:'换班',revision:claimed.revision})).status,200);
 assert.equal((await post(`/admin/workdesk/requests/${request.id}/complete`,{revision:claimed.revision},tokens.workerA)).status,403);
 const latest=(await call('/admin/workdesk',{token:tokens.workerB})).body.requests[0];assert.equal(latest.assignedStaffId,ids.workerB);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind='service_transfer' AND entity_id=?").get(request.id).n,1);
 assert.equal((await post(`/admin/workdesk/requests/${request.id}/complete`,{revision:latest.revision},tokens.workerB)).status,200);
});

test('unhandled service requests block closing the table and remain visible in history',async()=>{
 const request=(await service()).body.request;assert.equal((await post('/admin/tables/1/close',{})).status,409);
 const owned=(await post(`/admin/workdesk/requests/${request.id}/claim`,{revision:request.revision},tokens.workerA)).body.request;
 await post(`/admin/workdesk/requests/${request.id}/complete`,{revision:owned.revision,note:'已协助'},tokens.workerA);
 const history=(await call('/sessions/1/services',{token:tokens.user})).body.requests;assert.equal(history[0].status,'completed');assert.equal(history[0].assignedStaff,'workerA');
 assert.equal((await post('/admin/tables/1/close',{})).status,200);
});

test('preparation cannot be claimed twice and a batch reserves each item only once',async()=>{
 paidOrder();const claimed=await post('/admin/workdesk/orders/100/claim',{revision:0},tokens.workerA);assert.equal(claimed.status,200);
 assert.equal((await post('/admin/workdesk/orders/100/claim',{revision:0},tokens.workerB)).status,409);
 const key=crypto.randomUUID(),body={revision:claimed.body.order.revision,items:[{orderItemId:100,quantity:2}],requestId:key};
 const first=await post('/admin/workdesk/orders/100/batches',body,tokens.workerA);assert.equal(first.status,200);
 const repeated=await post('/admin/workdesk/orders/100/batches',body,tokens.workerA);assert.equal(repeated.body.batch.id,first.body.batch.id);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fulfillment_batches').get().n,1);
 assert.equal((await post('/admin/workdesk/orders/100/batches',{...body,revision:2,requestId:crypto.randomUUID()},tokens.workerA)).status,409);
 assert.equal((await post('/admin/orders/100/deliver',{},tokens.workerA)).status,403);
 assert.equal((await post('/admin/orders/100/deliver',{})).status,409);
});

test('bar preparation and runner handoff prevents double delivery and tracks partial quantities',async()=>{
 paidOrder();const batch=await prepare(1);
 const claims=await Promise.all([post(`/admin/workdesk/batches/${batch.id}/claim`,{},tokens.workerA),post(`/admin/workdesk/batches/${batch.id}/claim`,{},tokens.workerB)]);
 assert.deepEqual(claims.map(result=>result.status).sort(),[200,409]);
 const owner=claims.find(result=>result.status===200).body.batch.deliveryStaffId,token=owner===ids.workerA?tokens.workerA:tokens.workerB,other=token===tokens.workerA?tokens.workerB:tokens.workerA;
 assert.equal((await post(`/admin/workdesk/batches/${batch.id}/complete`,{},other)).status,403);
 for(let i=0;i<2;i++)assert.equal((await post(`/admin/workdesk/batches/${batch.id}/complete`,{},token)).status,200);
 assert.equal(db.prepare('SELECT delivered_quantity FROM order_items WHERE id=100').get().delivered_quantity,1);
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=100').get().status,'awaiting_delivery');
 assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,98);
 const second=await prepare(1,true);assert.equal(second.deliveryStaffId,ids.workerA);
 assert.equal((await post(`/admin/workdesk/batches/${second.id}/complete`,{},tokens.workerA)).body.completed,true);
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=100').get().status,'completed');assert.equal(db.prepare('SELECT delivered_quantity FROM order_items WHERE id=100').get().delivered_quantity,2);
});

test('refunds cannot refund a delivery in transit or already delivered items',async()=>{
 paidOrder();const batch=await prepare(1,true);
 assert.equal((await post('/me/orders/WORK-ORDER/refund-requests',{items:[{orderItemId:100,quantity:1}]},tokens.user)).status,409);
 assert.equal((await post('/admin/orders/100/refund',{amount:30})).status,409);
 await post(`/admin/workdesk/batches/${batch.id}/complete`,{},tokens.workerA);
 const order=(await call('/me/orders/WORK-ORDER',{token:tokens.user})).body.order;
 assert.equal(order.items[0].refundAvailableQuantity,1);assert.equal(order.refundableAmount,30);
 assert.equal((await post('/me/orders/WORK-ORDER/refund-requests',{items:[{orderItemId:100,quantity:2}]},tokens.user)).status,409);
 const requested=await post('/me/orders/WORK-ORDER/refund-requests',{items:[{orderItemId:100,quantity:1}]},tokens.user);assert.equal(requested.body.request.amount,30);
 await post(`/admin/refunds/${requested.body.request.id}/approve`,{});
 assert.deepEqual(db.prepare('SELECT delivered_quantity,returned_quantity FROM order_items WHERE id=100').get(),{delivered_quantity:1,returned_quantity:1});
 assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,99);
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=100').get().status,'completed');
});

test('successful item refunds cancel ready reservations without returning delivered stock twice',async()=>{
 paidOrder();const ready=await prepare(2);
 const requested=(await post('/me/orders/WORK-ORDER/refund-requests',{items:[{orderItemId:100,quantity:1}]},tokens.user)).body.request;
 assert.equal((await post(`/admin/workdesk/batches/${ready.id}/claim`,{},tokens.workerB)).status,409);
 assert.equal((await post(`/admin/refunds/${requested.id}/approve`,{})).status,200);
 assert.equal(db.prepare('SELECT status FROM fulfillment_batches').get().status,'cancelled');
 const view=(await call('/admin/workdesk',{token:tokens.workerA})).body.orders[0];assert.equal(view.items[0].unpreparedQuantity,1);assert.equal(view.items[0].returnedQuantity,1);
 const delivery=await prepare(1,true);await post(`/admin/workdesk/batches/${delivery.id}/complete`,{},tokens.workerA);
 assert.equal(db.prepare('SELECT status FROM orders').get().status,'completed');assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,99);
});

test('a failed refund keeps ready goods paused until an administrator checks the order',async()=>{
 paidOrder();const ready=await prepare(2);
 db.prepare("UPDATE orders SET payment_method='wechat',stored_paid_cents=0,wechat_paid_cents=6000 WHERE id=100").run();
 const result=await post('/admin/orders/100/refund',{});assert.equal(result.status,200);assert.equal(result.body.refund.status,'failed');
 const view=(await call('/admin/workdesk',{token:tokens.workerA})).body.orders[0];assert.equal(view.paused,true);assert.match(view.pausedReason,/退款失败/);
 assert.equal((await post(`/admin/workdesk/batches/${ready.id}/claim`,{},tokens.workerB)).status,409);
 assert.equal((await call('/me/orders/WORK-ORDER',{token:tokens.user})).body.order.statusLabel,'待核实');
 assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,98);
 assert.equal((await post('/admin/workdesk/orders/100/resume',{revision:view.revision,reason:'顾客确认继续送货，退款失败已核实'})).status,200);
 assert.equal((await post(`/admin/workdesk/batches/${ready.id}/claim`,{},tokens.workerB)).status,200);
});

test('the event cursor captures new tasks even when total pending counts stay unchanged',async()=>{
 const first=(await service('help')).body.request;const initial=(await call('/admin/workdesk',{token:tokens.workerA})).body;
 const owned=(await post(`/admin/workdesk/requests/${first.id}/claim`,{revision:first.revision},tokens.workerA)).body.request;
 await post(`/admin/workdesk/requests/${first.id}/complete`,{revision:owned.revision},tokens.workerA);
 const next=(await service('help')).body.request;
 const refreshed=(await call(`/admin/workdesk?after=${initial.cursor}`,{token:tokens.workerA})).body;
 assert.equal(initial.requests.filter(row=>row.status==='waiting').length,refreshed.requests.filter(row=>row.status==='waiting').length);
 assert.ok(refreshed.events.some(event=>event.kind==='service_new'&&event.entity_id===next.id));
 assert.equal((await call(`/admin/workdesk?after=${refreshed.cursor}`,{token:tokens.workerA})).body.events.length,0);
});

test('timeouts highlight work without automatically releasing its owner',async()=>{
 const request=(await service()).body.request;await post(`/admin/workdesk/requests/${request.id}/claim`,{revision:request.revision},tokens.workerA);
 db.prepare("UPDATE service_requests SET claimed_at='2000-01-01 00:00:00' WHERE id=?").run(request.id);
 const row=(await call('/admin/workdesk',{token:tokens.workerB})).body.requests[0];assert.equal(row.assignedStaffId,ids.workerA);assert.equal(row.status,'claimed');
 assert.equal((await post(`/admin/workdesk/requests/${row.id}/claim`,{revision:row.revision},tokens.workerB)).status,409);
});

test('a recalled delivery stays paused until checked and cannot be completed by its previous courier',async()=>{
 paidOrder();const batch=await prepare(2,true);
 const revision=db.prepare('SELECT fulfillment_revision AS r FROM orders WHERE id=100').get().r;
 assert.equal((await post(`/admin/workdesk/batches/${batch.id}/recall`,{revision,reason:'实物已归还吧台'},tokens.workerB)).status,403);
 assert.equal((await post(`/admin/workdesk/batches/${batch.id}/recall`,{revision,reason:'实物已归还吧台'})).status,200);
 assert.equal((await post(`/admin/workdesk/batches/${batch.id}/complete`,{},tokens.workerA)).status,409);
 const view=(await call('/admin/workdesk',{token:tokens.workerA})).body.orders[0];assert.equal(view.paused,true);assert.equal(view.items[0].unpreparedQuantity,2);
 assert.equal((await post('/admin/workdesk/orders/100/batches',{revision:view.revision,requestId:crypto.randomUUID(),items:[{orderItemId:100,quantity:2}]},tokens.workerA)).status,409);
 assert.equal((await post('/admin/orders/100/refund',{})).status,200);assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,100);
});

test('a preparer can continue valid remaining quantities after an unrelated delivery update',async()=>{
 paidOrder();const batch=await prepare(1,false);
 const before=db.prepare('SELECT fulfillment_revision AS r FROM orders WHERE id=100').get().r;
 await post(`/admin/workdesk/batches/${batch.id}/claim`,{},tokens.workerB);
 const second=await post('/admin/workdesk/orders/100/batches',{revision:before,items:[{orderItemId:100,quantity:1}],startDelivery:true,requestId:crypto.randomUUID()},tokens.workerA);
 assert.equal(second.status,200);
 const current=db.prepare('SELECT fulfillment_revision AS r FROM orders WHERE id=100').get().r;
 await post(`/admin/workdesk/batches/${second.body.batch.id}/recall`,{revision:current,reason:'先核对桌号'});
 const paused=(await call('/admin/workdesk',{token:tokens.workerA})).body.orders[0];
 assert.equal((await post('/admin/workdesk/orders/100/resume',{revision:paused.revision,reason:'桌号已核实'})).status,200);
 assert.equal((await call('/admin/workdesk',{token:tokens.workerA})).body.orders[0].paused,false);
});
