import { printerConfiguration } from './printer-models.js';
import crypto from 'node:crypto';
import { db } from './db.js';
import { storeName } from './branding.js';
import { feieProvider,feieConfiguration } from './integrations/feie.js';
import { billData,orderReceipt } from './bills.js';
import { receiptTemplate,receiptLines,feieReceiptParts } from './receipts.js';
import { commerceError,formatTime } from './business-time.js';
const idPattern=/^[a-f0-9-]{36}$/i;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const printerTasks=new Map(),checks=new Map();
export function printJobView(id){
  const row=db.prepare('SELECT j.*,p.name AS printer,a.display_name AS operator FROM print_jobs j JOIN receipt_printers p ON p.id=j.printer_id LEFT JOIN staff_accounts a ON a.id=j.operator_id WHERE j.id=?').get(id);
  if(!row)throw commerceError('打印任务不存在',404);
  const snapshot=JSON.parse(row.snapshot_json),parts=db.prepare('SELECT part_no,state,provider_order_id FROM print_parts WHERE job_id=? ORDER BY part_no').all(id);
  return {id:row.id,scope:row.scope,targetId:row.target_id,printerId:row.printer_id,printer:row.printer,state:row.state,error:row.error,reprintOf:row.reprint_of,createdAt:formatTime(row.created_at),operator:row.operator,billNo:snapshot.data?.billNo||'测试打印',revision:snapshot.revision,paperWidth:snapshot.paperWidth,parts,lines:snapshot.lines};
}
export function receiptPreview(scope,targetId,printerId,operator='') {
  if(!['order','bill'].includes(scope))throw commerceError('请选择订单或桌台账单');
  const data=scope==='order'?orderReceipt(targetId):billData(targetId),template=receiptTemplate();
  const printer=printerConfiguration(db.prepare('SELECT * FROM receipt_printers WHERE id=?').get(printerId));
  // A new receipt follows today's heading settings, even for a closed bill.
  // Keep the bill's historical name and financial revision intact; freeze the
  // resolved heading separately so later reprints retain the printed name.
  data.receiptStoreName=template.storeNameOverride?.trim()||storeName();
  const paperWidth=printer?.paper_width||58,revision=hash([data.revision,template.revision,paperWidth,data.receiptStoreName]);
  const original=db.prepare('SELECT revision FROM bill_snapshots WHERE session_id=?').get(data.sessionId);
  if(data.sessionStatus==='closed'&&original&&original.revision!==data.revision)data.adjustedAfterClose=true;
  return {data,template,paperWidth,revision,lines:receiptLines(data,{paperWidth,template,operator})};
}
export function updateJobState(id) {
  const current=db.prepare('SELECT state FROM print_jobs WHERE id=?').get(id)?.state;
  if(['confirmed','cancelled'].includes(current))return current;
  const parts=db.prepare('SELECT state FROM print_parts WHERE job_id=?').all(id).map(p=>p.state);
  const state=parts.every(s=>['printed','confirmed'].includes(s))?(parts.includes('confirmed')?'confirmed':'printed'):parts.some(s=>s==='unknown')?'unknown':parts.some(s=>s==='sending')?'sending':parts.some(s=>s==='failed')?'failed':parts.some(s=>s==='accepted')?'accepted':'queued';
  db.prepare("UPDATE print_jobs SET state=?,error=CASE WHEN ?='printed' THEN '' ELSE error END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(state,state,id);return state;
}
export async function dispatchPrintJob(id) {
  const row=db.prepare('SELECT * FROM print_jobs WHERE id=?').get(id);
  if(!row)throw commerceError('打印任务不存在',404);
  const prior=printerTasks.get(row.printer_id)||Promise.resolve();
  const task=prior.catch(()=>{}).then(async()=>{
    const job=db.prepare('SELECT * FROM print_jobs WHERE id=?').get(id),printer=printerConfiguration(db.prepare('SELECT * FROM receipt_printers WHERE id=?').get(job.printer_id));
    if(['printed','confirmed','cancelled','unknown'].includes(job.state))return printJobView(id);
    const content=JSON.parse(job.content_json);
    for(const part of db.prepare("SELECT * FROM print_parts WHERE job_id=? AND state='queued' ORDER BY part_no").all(id)) {
      if(db.prepare("SELECT 1 FROM print_parts WHERE job_id=? AND state IN ('unknown','failed')").get(id))break;
      let provider;
      try {if(!printer||printer.status!=='active'||!printer.bound)throw commerceError('打印机未启用或未绑定');if(JSON.parse(job.snapshot_json).paperWidth!==printer.paper_width)throw commerceError('打印机纸宽已改变，请重新预览并创建打印任务');if(!printer.has_cutter&&content.some(part=>part.includes('<CUT>')))throw commerceError('此机型不带切刀，请重新预览并创建打印任务');provider=feieProvider({user:job.provider_account,region:job.provider_region});}
      catch(e){db.prepare("UPDATE print_parts SET state='failed' WHERE job_id=? AND part_no=? AND state='queued'").run(id,part.part_no);db.prepare('UPDATE print_jobs SET error=? WHERE id=?').run(e.message,id);break;}
      const expiresAt=Math.floor(Date.now()/1000)+15*60;
      db.transaction(()=>{db.prepare("UPDATE print_parts SET state='sending',expires_at=? WHERE job_id=? AND part_no=? AND state='queued'").run(expiresAt,id,part.part_no);db.prepare("UPDATE print_jobs SET state='sending',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);})();
      try {
        const providerId=await provider.print(printer.sn,content[part.part_no-1],{expiresAt});
        db.prepare("UPDATE print_parts SET state='accepted',provider_order_id=? WHERE job_id=? AND part_no=? AND state='sending'").run(providerId,id,part.part_no);
      } catch(e) {
        db.prepare("UPDATE print_parts SET state=? WHERE job_id=? AND part_no=? AND state='sending'").run(e.definite?'failed':'unknown',id,part.part_no);
        db.prepare('UPDATE print_jobs SET error=? WHERE id=?').run(e.message,id);break;
      }
    }
    updateJobState(id);return printJobView(id);
  });
  printerTasks.set(row.printer_id,task);
  try{return await task;}finally{if(printerTasks.get(row.printer_id)===task)printerTasks.delete(row.printer_id);}
}
export async function createPrintJob(body,staff,{test=false}={}) {
  if(!idPattern.test(body.requestId||''))throw commerceError('打印请求标识无效');
  const existing=db.prepare('SELECT * FROM print_jobs WHERE request_id=?').get(body.requestId);
  const request={scope:test?'test':body.scope,targetId:test?0:Number(body.targetId),printerId:Number(body.printerId),expectedRevision:body.expectedRevision||'',reprintOf:body.reprintOf||''};
  if(existing){if(JSON.stringify(JSON.parse(existing.snapshot_json).request)!==JSON.stringify(request))throw commerceError('同一打印请求不能改为另一份内容',409);return printJobView(existing.id);}
  const printer=printerConfiguration(db.prepare("SELECT * FROM receipt_printers WHERE id=? AND status='active'").get(request.printerId));
  if(!printer||!printer.bound)throw commerceError('请选择已启用且已绑定的打印机');
  feieProvider();const config=feieConfiguration();
  if(printer.bound_user!==config.user||printer.bound_region!==config.region)throw commerceError('飞鹅账号或区域已改变，请重新确认设备绑定',409);
  let snapshot;
  if(test) {const template=receiptTemplate(),data={scope:'order',targetId:0,billNo:'TEST',tableNo:'测试',storeName:storeName(),sessionId:0,sessionStatus:'open',openedAt:new Date().toISOString(),closedAt:null,orders:[],totals:{orders:0,paidOrders:0,pendingOrders:0,original:0,memberDiscount:0,couponDiscount:0,paid:0,refund:0,net:0,channels:{}}};snapshot={data,template,paperWidth:printer.paper_width,revision:hash([template.revision,printer.paper_width]),lines:receiptLines(data,{paperWidth:printer.paper_width,template,operator:staff.display_name})};}
  else if(request.reprintOf){const previous=db.prepare('SELECT * FROM print_jobs WHERE id=?').get(request.reprintOf);if(!previous)throw commerceError('原打印任务不存在',404);snapshot=JSON.parse(previous.snapshot_json);if(snapshot.revision!==request.expectedRevision)throw commerceError('补打版本与原任务不一致',409);if(snapshot.paperWidth!==printer.paper_width)throw commerceError('纸张规格已变化，请按原纸宽补打或重新预览新版',409);}
  else {snapshot=receiptPreview(request.scope,request.targetId,printer.id,staff.display_name);if(!request.expectedRevision||snapshot.revision!==request.expectedRevision)throw commerceError('订单、账单或模板已变化，请重新预览',409);}
  let reprint;
  if(request.reprintOf){reprint=db.prepare('SELECT * FROM print_jobs WHERE id=? AND scope=? AND target_id=? AND printer_id=?').get(request.reprintOf,request.scope,request.targetId,printer.id);if(!reprint||body.paperChecked!==true||!String(body.reason||'').trim()||String(body.reason).length>200)throw commerceError('补打需核对出纸情况并填写原因');if(['queued','sending','accepted'].includes(reprint.state))throw commerceError('原任务仍可能出纸，请先核对原任务状态',409);snapshot.lines=receiptLines(snapshot.data,{paperWidth:printer.paper_width,template:snapshot.template,reprint:true,operator:staff.display_name});}
  if(!reprint&&!test){const duplicate=db.prepare("SELECT id,snapshot_json FROM print_jobs j WHERE scope=? AND target_id=? AND printer_id=? AND (state!='failed' OR EXISTS(SELECT 1 FROM print_parts WHERE job_id=j.id AND provider_order_id IS NOT NULL)) AND reprint_of IS NULL ORDER BY created_at DESC").all(request.scope,request.targetId,printer.id).find(j=>JSON.parse(j.snapshot_json).revision===snapshot.revision);if(duplicate)return printJobView(duplicate.id);}
  snapshot.request=request;snapshot.reason=body.reason||'';
  const content=feieReceiptParts(snapshot.lines,printer,snapshot.template),id=crypto.randomUUID();
  db.transaction(()=>{db.prepare("INSERT INTO print_jobs(id,request_id,printer_id,scope,target_id,snapshot_json,content_json,provider_account,provider_region,reprint_of,operator_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,body.requestId,printer.id,request.scope,request.targetId,JSON.stringify(snapshot),JSON.stringify(content),config.user,config.region,reprint?.id||null,staff.id);for(let i=0;i<content.length;i++)db.prepare('INSERT INTO print_parts(job_id,part_no) VALUES(?,?)').run(id,i+1);})();
  return dispatchPrintJob(id);
}
export async function checkPrintJob(id,{resume=false}={}) {
  if(checks.has(id))return checks.get(id);
  const task=(async()=>{
    const job=db.prepare('SELECT * FROM print_jobs WHERE id=?').get(id);if(!job)throw commerceError('打印任务不存在',404);
    if(['printed','confirmed','cancelled'].includes(job.state))return printJobView(id);
    const provider=feieProvider({user:job.provider_account,region:job.provider_region});
    for(const part of db.prepare("SELECT * FROM print_parts WHERE job_id=? AND provider_order_id IS NOT NULL AND state='accepted'").all(id)) {
      if(await provider.query(part.provider_order_id))db.prepare("UPDATE print_parts SET state='printed' WHERE job_id=? AND part_no=? AND state='accepted'").run(id,part.part_no);
      else if(part.expires_at&&Date.now()>part.expires_at*1000){db.prepare("UPDATE print_parts SET state='unknown' WHERE job_id=? AND part_no=? AND state='accepted'").run(id,part.part_no);db.prepare("UPDATE print_jobs SET error='任务已过打印有效期，请核对设备实际出纸后再决定补打' WHERE id=?").run(id);}
    }
    if(resume&&!db.prepare("SELECT 1 FROM print_parts WHERE job_id=? AND state IN ('unknown','sending')").get(id))db.prepare("UPDATE print_parts SET state='queued' WHERE job_id=? AND state='failed'").run(id);
    updateJobState(id);
    if(resume||!db.prepare("SELECT 1 FROM print_parts WHERE job_id=? AND state IN ('unknown','failed','sending')").get(id))return dispatchPrintJob(id);
    return printJobView(id);
  })();checks.set(id,task);try{return await task;}finally{checks.delete(id);}
}
export async function reconcilePrintJobs(){
  const rows=db.prepare("SELECT id FROM print_jobs WHERE state='accepted' ORDER BY updated_at LIMIT 10").all();
  for(let offset=0;offset<rows.length;offset+=5)await Promise.all(rows.slice(offset,offset+5).map(r=>checkPrintJob(r.id).catch(()=>{})));
}
