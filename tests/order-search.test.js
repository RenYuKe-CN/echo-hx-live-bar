import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work=fs.mkdtempSync(path.join(os.tmpdir(),'echo-order-search-'));
Object.assign(process.env,{DATA_DIR:work,ECHO_ENV_FILE:path.join(work,'missing.env'),NODE_ENV:'production',ALLOW_DEMO_USER:'false',ADMIN_INITIAL_PASSWORD:'order-search-fixture-password'});
const {db}=await import('../server/db.js');
const {createApp}=await import('../server/app.js');
const nativeFetch=globalThis.fetch,hash=token=>crypto.createHash('sha256').update(token).digest('hex');
const tokens={owner:'a'.repeat(64),reader:'b'.repeat(64),waiter:'c'.repeat(64)};
let server,base;
before(async()=>{
  const password=db.prepare('SELECT password_hash FROM staff_accounts WHERE id=1').get().password_hash;
  for(const [id,name,permissions] of [[2,'order_reader',['orders']],[3,'waiter',['workdesk']]]) db.prepare("INSERT INTO staff_accounts(id,username,display_name,password_hash,role,permissions) VALUES(?,?,?,?,'staff',?)").run(id,name,name,password,JSON.stringify(permissions));
  db.prepare("INSERT INTO users(id,nickname,phone) VALUES(2,'同名顾客','13900239002')").run();
  db.prepare("INSERT INTO table_sessions(id,store_id,table_id,session_no) VALUES(1,1,1,'ORDER-SEARCH-SESSION')").run();
  server=await new Promise(resolve=>{const instance=createApp().listen(0,'127.0.0.1',()=>resolve(instance));});
  base=`http://127.0.0.1:${server.address().port}/api/admin/orders`;
});
beforeEach(()=>{
  db.prepare('DELETE FROM order_items').run();db.prepare('DELETE FROM orders').run();
  db.prepare("UPDATE users SET phone='13800138001',nickname='同名顾客' WHERE id=1").run();
  db.prepare('DELETE FROM staff_sessions').run();
  for(const [name,id] of [['owner',1],['reader',2],['waiter',3]]) db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(tokens[name]),id,new Date(Date.now()+3600000).toISOString());
});
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(work,{recursive:true,force:true});});
function order(id,{payer=1,phone='13800138001',captured=true}={}) {
  db.prepare("INSERT INTO orders(id,order_no,session_id,payer_user_id,original_amount_cents,payable_amount_cents,payment_method,stored_paid_cents,status,payment_status,paid_at,payer_name_snapshot,payer_phone_snapshot,payer_identity_captured_at) VALUES(?,?,1,?,3000,3000,'balance',3000,'completed','paid',CURRENT_TIMESTAMP,?,?,?)").run(id,`SEARCH-${id}`,payer,`历史付款人${id}`,phone,captured?'2026-10-21 12:00:00':null);
}
async function search(query={},token=tokens.owner) {
  const response=await nativeFetch(base+'?'+new URLSearchParams(query),{headers:token?{authorization:`Bearer ${token}`}:{}});
  return {status:response.status,body:await response.json()};
}

test('phone search follows the same captured payer identity as the displayed order, including legacy and unbound orders',async()=>{
  order(1);order(2,{captured:false});order(3,{phone:''});order(4,{payer:2,captured:false});order(5,{phone:'00001380001'});
  db.prepare("UPDATE users SET phone='13900139001',nickname='改名后的顾客' WHERE id=1").run();
  let result=await search({phone:'13800138001'});
  assert.equal(result.status,200);assert.deepEqual(result.body.orders.map(row=>row.id),[1]);
  assert.equal(result.body.orders[0].nickname,'历史付款人1');assert.equal(result.body.orders[0].payer_phone,'13800138001');
  result=await search({phone:'13900139001'});assert.deepEqual(result.body.orders.map(row=>row.id),[2]);assert.equal(result.body.orders[0].nickname,'改名后的顾客');
  result=await search({phone:'13900239002'});assert.deepEqual(result.body.orders.map(row=>row.id),[4]);
  result=await search({phone:'00001380001'});assert.deepEqual(result.body.orders.map(row=>row.id),[5]);
  assert.equal((await search()).body.orders.find(row=>row.id===3).payer_phone,'');
});

test('phone filters count and paginate all matching history rather than only the currently loaded page',async()=>{
  for(let id=1;id<=30;id++)order(id,{phone:id<=26?'13800138001':'13900239002'});
  const first=(await search({phone:'8001',page:1})).body,second=(await search({phone:'8001',page:2})).body;
  assert.equal(first.pagination.total,26);assert.equal(first.orders.length,20);assert.equal(second.orders.length,6);
  assert.equal(new Set([...first.orders,...second.orders].map(row=>row.id)).size,26);
  assert.deepEqual(first.filters,{phone:'8001'});
  const clamped=(await search({phone:'8001',page:999})).body;
  assert.equal(clamped.pagination.page,2);assert.equal(clamped.orders.length,6);
  const empty=(await search({phone:'5555'})).body;
  assert.equal(empty.pagination.total,0);assert.equal(empty.pagination.totalPages,1);assert.deepEqual(empty.orders,[]);
  assert.equal((await search()).body.pagination.total,30);
});

test('phone input accepts trimmed digit fragments and rejects malformed searches without altering any records',async()=>{
  order(1);
  assert.equal((await search({phone:' 38001 '})).body.orders[0].id,1);
  assert.equal((await search({phone:'   '})).body.pagination.total,1);
  for(const phone of ['138001380012','138-0013','abc','%','_','\' OR 1=1 --','138 0013']) assert.equal((await search({phone})).status,400,phone);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,1);
});

test('search remains behind order permission and does not expose costs or grant refund access',async()=>{
  order(1);
  const reader=await search({phone:'38001'},tokens.reader);
  assert.equal(reader.status,200);assert.equal(reader.body.orders.length,1);assert.equal(reader.body.orders[0].profit,undefined);assert.equal(reader.body.orders[0].cost,undefined);
  assert.equal((await search({phone:'38001'},tokens.waiter)).status,403);
  assert.equal((await search({phone:'38001'},null)).status,401);
});
