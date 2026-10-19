import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { db } from './db.js';
import { commerceSettings, localDateTime, nextDate, parseLocal, utcTime } from './business-time.js';

const MAX_EXPORT = 10000;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const utc = stamp => new Date(stamp).toISOString().slice(0,19).replace('T',' ');
const fingerprint = row => crypto.createHash('sha256').update(JSON.stringify([row.id,row.entry_key,row.operator,row.action,row.detail,row.created_at])).digest('hex');
const displayTime = (value, timezone) => {
  const stamp=utcTime(value);
  return Number.isFinite(stamp) ? localDateTime(stamp,timezone).replace('T',' ')+':'+String(new Date(stamp).getUTCSeconds()).padStart(2,'0') : String(value || '');
};
export function logFilters(query = {}) {
  const timezone=commerceSettings().timezone, today=localDateTime(Date.now(),timezone).slice(0,10);
  const defaults=!Object.hasOwn(query,'startAt')&&!Object.hasOwn(query,'endAt');
  const startAt=defaults?nextDate(today,-6)+'T00:00':query.startAt??'', endAt=defaults?nextDate(today)+'T00:00':query.endAt??'', q=query.q??'';
  if([startAt,endAt,q].some(value=>typeof value!=='string')||q.length>100)fail('日期或搜索内容无效，关键词最多 100 字');
  const from=startAt?parseLocal(startAt,timezone):null, to=endAt?parseLocal(endAt,timezone):null;
  if(from!==null&&to!==null&&from>=to)fail('结束时间必须晚于开始时间');
  return {startAt,endAt,q:q.trim(),timezone};
}
function whereFor(filters) {
  const clauses=[],params=[];
  if(filters.startAt){clauses.push('datetime(created_at)>=?');params.push(utc(parseLocal(filters.startAt,filters.timezone)));}
  if(filters.endAt){clauses.push('datetime(created_at)<?');params.push(utc(parseLocal(filters.endAt,filters.timezone)));}
  if(filters.q){clauses.push("(operator LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");const pattern='%'+filters.q.replace(/[\\%_]/g,'\\$&')+'%';params.push(pattern,pattern,pattern);}
  return {sql:clauses.length?' WHERE '+clauses.join(' AND '):'',params};
}
function forgetExpiredBatches() { db.prepare('DELETE FROM log_export_batches WHERE expires_at<=?').run(new Date().toISOString()); }
export function operationLogs(query) {
  const filters=logFilters(query),{sql,params}=whereFor(filters);
  forgetExpiredBatches();
  const total=db.prepare('SELECT COUNT(*) AS n FROM operation_logs'+sql).get(...params).n;
  const pageSize=Number(query.pageSize)===50?50:20,totalPages=Math.max(1,Math.ceil(total/pageSize));
  const page=Math.min(totalPages,Math.max(1,Math.floor(Number(query.page))||1));
  const logs=db.prepare('SELECT * FROM operation_logs'+sql+' ORDER BY datetime(created_at) DESC,id DESC LIMIT ? OFFSET ?').all(...params,pageSize,(page-1)*pageSize);
  const pageBytes=db.pragma('page_size',{simple:true});
  return {filters,logs:logs.map(({entry_key,...row})=>({...row,displayTime:displayTime(row.created_at,filters.timezone)})),
    pagination:{page,pageSize,total,totalPages,hasNext:page<totalPages,hasPrevious:page>1},
    storage:{totalLogs:db.prepare('SELECT COUNT(*) AS n FROM operation_logs').get().n,databaseBytes:db.pragma('page_count',{simple:true})*pageBytes,reusableBytes:db.pragma('freelist_count',{simple:true})*pageBytes},maxExport:MAX_EXPORT};
}
function detailChunks(text) {
  const chunks=[];let offset=0;
  do {let end=Math.min(offset+30000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;chunks.push(text.slice(offset,end));offset=end;}while(offset<text.length);
  return chunks;
}
export async function exportOperationLogs(req,audit) {
  const filters=logFilters(req.query),{sql,params}=whereFor(filters);
  // Capture rows before the asynchronous workbook write. Cleanup later matches
  // their IDs AND content hashes, rather than rerunning a changing time query.
  const rows=db.prepare('SELECT * FROM operation_logs'+sql+' ORDER BY datetime(created_at),id LIMIT ?').all(...params,MAX_EXPORT+1);
  if(!rows.length)fail('当前筛选没有日志可导出');
  if(rows.length>MAX_EXPORT)fail('一次最多导出 10000 条日志，请缩小时间范围或增加关键词');
  const id=crypto.randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+86400000).toISOString();
  const tag=value=>value.replace(/[-:T]/g,'');
  const filename=`操作日志-${filters.startAt?tag(filters.startAt):'最早'}-${filters.endAt?tag(filters.endAt):tag(localDateTime(Date.now(),filters.timezone))}-${id.slice(0,8)}.xlsx`;
  const workbook=new ExcelJS.Workbook();workbook.creator='门店管理后台';workbook.created=new Date(createdAt);
  const info=workbook.addWorksheet('导出说明');info.columns=[{width:24},{width:95}];
  const metadata=[['项目','内容'],['文件名称',filename],['导出批次',id],['生成时间',displayTime(createdAt,filters.timezone)],['时区',filters.timezone],['开始时间（含）',filters.startAt.replace('T',' ')||'不限'],['结束时间（不含）',filters.endAt.replace('T',' ')||'不限'],['关键词（账号 / 操作 / 详情）',filters.q||'无'],['日志条数',rows.length],['清理有效期',displayTime(expiresAt,filters.timezone)+'；仅保留本账号最近 5 批'],['清理规则','仅清理此批次导出的原日志；请先下载保存并核对。导出和清理操作另留日志，不删除订单或付款数据。'],['长文本','超过单元格长度的详情分段为多行，日志 ID 相同；条数按原日志计。']];
  metadata.forEach(values=>info.addRow(values));
  const sheet=workbook.addWorksheet('操作日志',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
  sheet.columns=[{header:'日志ID',width:16},{header:`时间（${filters.timezone}）`,width:28},{header:'账号',width:22},{header:'操作',width:28},{header:'详情',width:85},{header:'详情分段',width:14}];
  for(const row of rows){const parts=detailChunks(row.detail);parts.forEach((part,index)=>sheet.addRow([String(row.id),displayTime(row.created_at,filters.timezone),row.operator,row.action,part,`${index+1}/${parts.length}`]));}
  for(const current of [info,sheet]){
    current.getRow(1).height=30;current.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF214D40'}};});
    current.eachRow((row,index)=>{if(index===1)return;row.height=44;row.eachCell({includeEmpty:true},cell=>{cell.numFmt='@';cell.alignment={vertical:'top',wrapText:true};if(index%2)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F6F3'}};});});
  }
  sheet.autoFilter={from:'A1',to:`F${sheet.rowCount}`};sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:1'};
  const buffer=Buffer.from(await workbook.xlsx.writeBuffer());
  if(req.destroyed)fail('下载连接已关闭，请重新导出',409);
  db.transaction(()=>{
    forgetExpiredBatches();
    db.prepare('INSERT INTO log_export_batches(id,operator_id,filename,filters_json,entries_json,row_count,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id,req.staff.id,filename,JSON.stringify(filters),JSON.stringify(rows.map(row=>[row.id,fingerprint(row)])),rows.length,createdAt,expiresAt);
    db.prepare('DELETE FROM log_export_batches WHERE operator_id=? AND id NOT IN (SELECT id FROM log_export_batches WHERE operator_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5)').run(req.staff.id,req.staff.id);
    audit(req,'导出操作日志',`批次 ${id}；${rows.length} 条；${filename}；筛选 ${JSON.stringify(filters)}`);
  })();
  return {buffer,id,filename,count:rows.length,expiresAt,timezone:filters.timezone};
}
export function cleanupExportedLogs(req,audit) {
  if(req.body?.confirmedSaved!==true)fail('请先确认 Excel 已下载保存并核对');
  if(!/^[a-f0-9-]{36}$/i.test(req.params.id))fail('导出批次无效');
  return db.transaction(()=>{
    const batch=db.prepare('SELECT * FROM log_export_batches WHERE id=?').get(req.params.id);
    if(!batch||batch.expires_at<=new Date().toISOString())fail('导出批次已过期，请重新导出后再清理',410);
    if(batch.operator_id!==req.staff.id)fail('只能清理自己导出的日志',403);
    if(batch.status==='cleaned')return {ok:true,repeated:true,deleted:batch.deleted_count};
    const entries=JSON.parse(batch.entries_json),get=db.prepare('SELECT * FROM operation_logs WHERE id=?'),remove=db.prepare('DELETE FROM operation_logs WHERE id=?');
    let deleted=0;
    for(const [id,hash] of entries){const row=get.get(id);if(!row)continue;if(fingerprint(row)!==hash)fail('导出后的日志内容已变化，请重新导出，未执行清理',409);deleted+=remove.run(id).changes;}
    db.prepare("UPDATE log_export_batches SET status='cleaned',entries_json='[]',deleted_count=?,cleaned_at=? WHERE id=?").run(deleted,new Date().toISOString(),batch.id);
    audit(req,'清理已导出操作日志',`批次 ${batch.id}；实际删除 ${deleted} 条 / 导出 ${batch.row_count} 条；文件 ${batch.filename}；原筛选 ${batch.filters_json}`);
    return {ok:true,deleted};
  })();
}
export function registerOperationLogRoutes(router,audit) {
  const safe=handler=>(req,res,next)=>Promise.resolve().then(()=>{if(req.staff.role!=='super')fail('仅超级管理员可管理操作日志',403);return handler(req,res);}).catch(next);
  router.get('/admin/logs',safe((req,res)=>res.json(operationLogs(req.query))));
  router.get('/admin/logs/export',safe(async(req,res)=>{
    const result=await exportOperationLogs(req,audit);
    res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,'Cache-Control':'no-store','X-Log-Export-Id':result.id,'X-Log-Export-Count':String(result.count),'X-Log-Export-Expires':result.expiresAt,'X-Log-Export-Timezone':result.timezone});
    res.send(result.buffer);
  }));
  router.post('/admin/logs/exports/:id/cleanup',safe((req,res)=>res.json(cleanupExportedLogs(req,audit))));
}
