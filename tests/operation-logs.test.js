import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';

const work=fs.mkdtempSync(path.join(os.tmpdir(),'echo-logs-test-'));
Object.assign(process.env,{DATA_DIR:work,ECHO_ENV_FILE:path.join(work,'missing.env'),NODE_ENV:'production',ADMIN_INITIAL_PASSWORD:'logs-fixture-password',ALLOW_DEMO_USER:'false'});
const {db}=await import('../server/db.js');
const {createApp}=await import('../server/app.js');
const {migrateAuditLogs}=await import('../server/logs-schema.js');
const nativeFetch=globalThis.fetch,tokens={admin:'1'.repeat(64),manager:'2'.repeat(64),waiter:'3'.repeat(64)};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
let server,base;
before(async()=>{
  const password=db.prepare('SELECT password_hash FROM staff_accounts WHERE id=1').get().password_hash;
  for(const [id,name,role,permissions] of [[2,'manager','manager',['logs']],[3,'waiter','staff',['workdesk']]])db.prepare('INSERT INTO staff_accounts(id,username,display_name,password_hash,role,permissions) VALUES(?,?,?,?,?,?)').run(id,name,name,password,role,JSON.stringify(permissions));
  server=await new Promise(resolve=>{const instance=createApp().listen(0,'127.0.0.1',()=>resolve(instance));});base=`http://127.0.0.1:${server.address().port}/api`;
  globalThis.fetch=async()=>{throw new Error('Log tests must not contact providers');};
});
beforeEach(()=>{
  db.exec('DELETE FROM log_export_batches; DELETE FROM operation_logs; DELETE FROM staff_sessions;');
  db.prepare("UPDATE staff_accounts SET role='manager' WHERE id=2").run();
  db.prepare("UPDATE commerce_settings SET timezone='Asia/Shanghai'").run();
  for(const [key,id] of [['admin',1],['manager',2],['waiter',3]])db.prepare('INSERT INTO staff_sessions VALUES(?,?,?)').run(hash(tokens[key]),id,new Date(Date.now()+3600000).toISOString());
});
after(async()=>{globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(work,{recursive:true,force:true});});
async function call(url,{method='GET',body,token=tokens.admin,binary=false}={}){
  const response=await nativeFetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,headers:response.headers,body:binary&&response.ok?Buffer.from(await response.arrayBuffer()):await response.json()};
}
const all='startAt=&endAt=';
function add(detail='演示操作',at='2026-10-19 08:00:00',operator='admin',action='修改商品') {return Number(db.prepare('INSERT INTO operation_logs(operator,action,detail,created_at) VALUES(?,?,?,?)').run(operator,action,detail,at).lastInsertRowid);}
const count=()=>db.prepare('SELECT COUNT(*) AS n FROM operation_logs').get().n;
const exported=async(query=all)=>{const response=await call('/admin/logs/export?'+query,{binary:true});assert.equal(response.status,200,JSON.stringify(response.body));return response;};
const cleanup=(id,body={confirmedSaved:true},token=tokens.admin)=>call(`/admin/logs/exports/${id}/cleanup`,{method:'POST',body,token});

test('log filtering uses the configured timezone, exact boundaries and literal keyword search',async()=>{
  add('边界之前','2026-10-18 15:59:59');const start=add('实际 100%_ 保留','2026-10-18 16:00:00');
  add('普通100任意','2026-10-19T01:02:03Z','cashier','登录后台');add('边界结束','2026-10-19 16:00:00');
  const range='startAt=2026-10-19T00:00&endAt=2026-10-20T00:00';
  let response=await call('/admin/logs?'+range);assert.equal(response.status,200);assert.equal(response.body.pagination.total,2);
  assert.equal(response.body.logs.find(row=>row.id===start).displayTime,'2026-10-19 00:00:00');assert.equal(response.body.storage.totalLogs,4);assert.ok(response.body.storage.databaseBytes>0);
  response=await call('/admin/logs?'+range+'&q='+encodeURIComponent('100%_'));assert.deepEqual(response.body.logs.map(row=>row.id),[start]);
  assert.equal((await call('/admin/logs?'+range+'&q=cashier')).body.pagination.total,1);
  assert.equal((await call('/admin/logs?'+range+'&q='+encodeURIComponent("' OR 1=1 --"))).body.pagination.total,0);
  assert.equal((await call('/admin/logs?startAt=2026-02-30T00:00&endAt=')).status,400);
  assert.equal((await call('/admin/logs?startAt=2026-10-20T00:00&endAt=2026-10-19T00:00')).status,400);
  assert.equal((await call('/admin/logs?'+all+'&q[]='+encodeURIComponent('无效数组'))).status,400);
});
test('default log range is seven local calendar days and pagination clamps to the final page',async()=>{
  add('现在',new Date().toISOString());add('很久之前','2020-01-01 00:00:00');
  const defaultList=await call('/admin/logs');assert.equal(defaultList.body.pagination.total,1);assert.ok(defaultList.body.filters.startAt.endsWith('T00:00'));
  for(let i=0;i<61;i++)add('批次-'+i);
  const last=await call('/admin/logs?'+all+'&page=999');assert.equal(last.body.pagination.page,4);assert.equal(last.body.logs.length,3);
  migrateAuditLogs(db);migrateAuditLogs(db);assert.equal(count(),63);
});
test('Excel exports all matched pages with plain text identities, complete long details and filter metadata',async()=>{
  const long='长'.repeat(29999)+'🍺'+'尾'.repeat(10000);const longId=add(long);
  const formulaId=add('=HYPERLINK("https://example.invalid","literal")','2026-10-19 09:01:02','00123','=文字操作');
  for(let i=0;i<25;i++)add('导出条目-'+i);
  const response=await exported('startAt=2026-10-19T00:00&endAt=2026-10-20T00:00');
  assert.equal(response.headers.get('x-log-export-count'),'27');assert.match(decodeURIComponent(response.headers.get('content-disposition')),/操作日志-202610190000-202610200000-[a-f0-9]{8}\.xlsx/);
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(response.body);
  assert.deepEqual(workbook.worksheets.map(sheet=>sheet.name),['导出说明','操作日志']);const sheet=workbook.getWorksheet('操作日志');
  const rows=sheet.getRows(2,sheet.rowCount-1),parts=rows.filter(row=>row.getCell(1).value===String(longId));assert.equal(parts.length,2);assert.equal(parts.map(row=>row.getCell(5).value).join(''),long);
  const literal=rows.find(row=>row.getCell(1).value===String(formulaId));assert.equal(literal.getCell(3).value,'00123');assert.equal(literal.getCell(4).value,'=文字操作');assert.equal(literal.getCell(5).type,ExcelJS.ValueType.String);assert.equal(literal.getCell(2).value,'2026-10-19 17:01:02');
  assert.equal(db.prepare('SELECT row_count FROM log_export_batches').get().row_count,27);assert.equal(count(),28);
  assert.equal(fs.readdirSync(work).some(name=>name.endsWith('.xlsx')),false);
});
test('cleanup deletes only the saved snapshot, preserves new backdated logs and business data, and is idempotent',async()=>{
  const first=add('可导出1'),second=add('可导出2');const snapshot=JSON.stringify({users:db.prepare('SELECT * FROM users').all(),orders:db.prepare('SELECT * FROM orders').all(),products:db.prepare('SELECT * FROM products').all()});
  const response=await exported(),id=response.headers.get('x-log-export-id');
  const fresh=add('导出之后补记的旧时间','2026-10-19 07:00:00');
  assert.equal((await cleanup(id,{confirmedSaved:false})).status,400);assert.equal(count(),4);
  const cleaned=await cleanup(id);assert.equal(cleaned.status,200);assert.equal(cleaned.body.deleted,2);
  assert.equal(db.prepare('SELECT id FROM operation_logs WHERE id IN (?,?)').all(first,second).length,0);assert.ok(db.prepare('SELECT id FROM operation_logs WHERE id=?').get(fresh));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operation_logs WHERE action='导出操作日志'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operation_logs WHERE action='清理已导出操作日志'").get().n,1);
  const retry=await cleanup(id);assert.equal(retry.body.repeated,true);assert.equal(retry.body.deleted,2);assert.equal(count(),3);
  assert.equal(snapshot,JSON.stringify({users:db.prepare('SELECT * FROM users').all(),orders:db.prepare('SELECT * FROM orders').all(),products:db.prepare('SELECT * FROM products').all()}));
  assert.equal(db.prepare('SELECT entries_json FROM log_export_batches').get().entries_json,'[]');
});
test('changed or reused log IDs abort the entire cleanup instead of deleting unexported content',async()=>{
  const first=add('原始1'),second=add('原始2');const response=await exported(),id=response.headers.get('x-log-export-id');
  db.prepare('UPDATE operation_logs SET detail=? WHERE id=?').run('导出后被更新',second);
  assert.equal((await cleanup(id)).status,409);assert.ok(db.prepare('SELECT id FROM operation_logs WHERE id=?').get(first));assert.equal(count(),3);
  // Even identical replacement content is a different record generation.
  db.prepare('DELETE FROM operation_logs WHERE id=?').run(second);db.prepare("INSERT INTO operation_logs(id,operator,action,detail,created_at) VALUES(?,'admin','修改商品','原始2','2026-10-19 08:00:00')").run(second);
  assert.equal((await cleanup(id)).status,409);assert.equal(count(),3);assert.equal(db.prepare('SELECT status FROM log_export_batches').get().status,'ready');
});
test('exports and cleanup are super-admin-only, owner-bound and expire after 24 hours',async()=>{
  add();for(const token of [tokens.manager,tokens.waiter,null]){
    const expected=token?403:401;assert.equal((await call('/admin/logs?'+all,{token})).status,expected);assert.equal((await call('/admin/logs/export?'+all,{token})).status,expected);
  }
  const response=await exported(),id=response.headers.get('x-log-export-id');assert.equal((await cleanup(id,undefined,tokens.manager)).status,403);
  db.prepare("UPDATE staff_accounts SET role='super' WHERE id=2").run();assert.equal((await cleanup(id,undefined,tokens.manager)).status,403);
  db.prepare('UPDATE log_export_batches SET expires_at=?').run(new Date(Date.now()-1).toISOString());assert.equal((await cleanup(id)).status,410);assert.equal(count(),2);
  await call('/admin/logs?'+all);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM log_export_batches').get().n,0);
});
test('empty and oversized exports never offer cleanup; only the five newest manifests are retained',async()=>{
  assert.equal((await call('/admin/logs/export?'+all)).status,400);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM log_export_batches').get().n,0);
  db.transaction(()=>{for(let i=0;i<10001;i++)add('大批日志');})();
  assert.equal((await call('/admin/logs/export?'+all)).status,400);assert.equal(count(),10001);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM log_export_batches').get().n,0);
  db.exec('DELETE FROM operation_logs');add('唯一演示日志');const batches=[];
  for(let i=0;i<6;i++)batches.push((await exported(all+'&q='+encodeURIComponent('唯一演示日志'))).headers.get('x-log-export-id'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM log_export_batches').get().n,5);assert.equal((await cleanup(batches[0])).status,410);
});
