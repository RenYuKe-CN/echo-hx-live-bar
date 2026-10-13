import crypto from 'node:crypto';
import { db } from './db.js';
import { catalogError, recipeSnapshot, assertStock, reserveStock, insertSaleItems, getCatalogProduct } from './catalog.js';
import { groupBuyProvider, groupBuyCapabilities } from './integrations/group-buy.js';
import { returnOrderStock } from './refund-stock.js';
import { hasDeliveryInProgress, cancelReadyBatchesForRefund, workEvent } from './workdesk.js';
import { withBackgroundTask } from './maintenance.js';
import { parseLocal,commerceSettings } from './business-time.js';
import { orderCostSql } from './refund-stock.js';

const hash=code=>crypto.createHash('sha256').update(code).digest('hex');
export const maskVoucher=code=>code.length>4 ? `${'•'.repeat(Math.min(8,code.length-4))}${code.slice(-4)}` : '••••';
const platforms={meituan:'美团',douyin:'抖音'};
const codeInput=value=>{const code=String(value || '').replace(/\s/g,'');if(!/^[a-zA-Z0-9-]{4,256}$/.test(code))throw catalogError('请填写券详情中的核销码，保留开头的 0',400);return code;};
export function redemptionView(row) {
  const snapshot=JSON.parse(row.snapshot_json);
  const restrictions=JSON.parse(row.provider_json).restrictions || {},rules=[];
  if(restrictions.start || restrictions.end) {
    const date=value=>{const d=new Date(Number(value)*1000);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(d):'';};
    if(restrictions.start)rules.push(`有效期开始：${date(restrictions.start)}`);
    if(restrictions.end)rules.push(`有效期截至：${date(restrictions.end)}`);
  }
  if(restrictions.time?.use_time_type===2)rules.push(`可用时段：${(restrictions.time.time_period_list||[]).map(p=>`${p.start_time}～${p.end_time}${p.end_time_is_next_day?'（次日）':''}`).join('、')}`);
  try{const raw=restrictions.attrs?.catering_voucher_limit_use_rule,rule=typeof raw==='string'?JSON.parse(raw):raw;if(rule?.limit_type>1)rules.push(`每${({2:'人',3:'桌',4:'次消费'})[rule.limit_type]||'次'}限用 ${rule.limit_use_num} 张`);}catch{/* Preserve the record; confirmation rejects malformed restrictions. */}
  if(restrictions.maxPerRedemption)rules.push(`平台用券数量上限：${restrictions.maxPerRedemption} 张`);
  return {id:row.id,platform:row.platform,platformName:platforms[row.platform],voucher:maskVoucher(row.voucher_code),name:snapshot.product.name,
    amount:row.amount_cents/100,state:row.state,error:row.error,source:row.source,createdAt:row.created_at,
    orderNo:row.order_id ? db.prepare('SELECT order_no FROM orders WHERE id=?').get(row.order_id)?.order_no : null,
    rulesText:rules.join('；'),components:snapshot.components.map(p=>({name:p.name,quantity:p.component_quantity,unit:p.unit}))};
}
function validSession(sessionId,userId) {
  if(!db.prepare("SELECT 1 FROM table_sessions s JOIN session_members m ON m.session_id=s.id JOIN tables t ON t.id=s.table_id WHERE s.id=? AND m.user_id=? AND s.status='open' AND t.status!='disabled'").get(sessionId,userId))throw catalogError('请先扫描并加入有效桌台');
}
function savePrepared({platform,code,voucher,mapping,sessionId,userId,source='api'}) {
  const prior=db.prepare("SELECT * FROM group_buy_redemptions WHERE platform=? AND (certificate_id=? OR (source='manual' AND voucher_hash=?))").get(platform,voucher.certificateId,hash(code));
  if(prior && (prior.user_id!==userId || prior.session_id!==sessionId))throw catalogError('此券已有兑换记录，请联系收银台核对');
  if(prior && ['verifying','unknown','verified','success'].includes(prior.state))return prior;
  if(prior?.state==='cancelled')throw catalogError('此券已有撤销记录，请由收银台核对新的有效券');
  const snapshot=recipeSnapshot(mapping.product_id);
  if(snapshot.product.status!=='active' || !snapshot.components.length)throw catalogError('套餐尚未开放兑换，请联系服务员');
  assertStock([{productId:mapping.product_id,quantity:1}]);
  const id=prior?.id || crypto.randomUUID();
  db.prepare(`INSERT INTO group_buy_redemptions(id,store_id,session_id,user_id,platform,certificate_id,voucher_hash,voucher_code,mapping_id,state,source,snapshot_json,provider_json,amount_cents,expected_settlement_cents)
    VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state='prepared',mapping_id=excluded.mapping_id,snapshot_json=excluded.snapshot_json,provider_json=excluded.provider_json,amount_cents=excluded.amount_cents,expected_settlement_cents=excluded.expected_settlement_cents,error='',request_id=NULL,updated_at=CURRENT_TIMESTAMP`)
    .run(id,mapping.store_id,sessionId,userId,platform,voucher.certificateId,hash(code),code,mapping.id,source,JSON.stringify(snapshot),JSON.stringify(voucher),voucher.amountCents,Math.round(voucher.amountCents*(1-mapping.fee_rate/100)));
  return db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id);
}
export async function prepareRedemption({platform,code,sessionId,userId}, provider) {
  if(!platforms[platform])throw catalogError('请选择团购平台',400);
  code=codeInput(code);validSession(sessionId,userId);
  const storeId=db.prepare('SELECT store_id FROM table_sessions WHERE id=?').get(sessionId).store_id;
    const vouchers=await (provider || groupBuyProvider(platform)).prepare(code);
  if(!vouchers.length)throw catalogError('未查到可用的固定套餐券，请核对券码或联系服务员');
  const receipts=db.transaction(()=>{
    validSession(sessionId,userId);
    return vouchers.map(voucher=>{
      if(!voucher.certificateId || !Number.isSafeInteger(voucher.amountCents) || voucher.amountCents<0)throw catalogError('平台券信息不完整');
      const mapping=db.prepare("SELECT * FROM group_buy_mappings WHERE store_id=? AND platform=? AND external_product_id=? AND (external_sku_id=? OR external_sku_id='') AND status='active' ORDER BY external_sku_id DESC LIMIT 1").get(storeId,platform,voucher.externalProductId,voucher.externalSkuId || '');
      if(!mapping)throw catalogError('此套餐尚未配置商品映射，请联系服务员');
      return savePrepared({platform,code,voucher,mapping,sessionId,userId});
    });
  })();
  return receipts.map(redemptionView);
}
function reserveRedemption(row,requestId) {
  const snapshot=JSON.parse(row.snapshot_json),live=getCatalogProduct(snapshot.product.id);
  if(!live || live.recipe_version!==snapshot.product.recipe_version || live.status!=='active')throw catalogError('套餐配置已更新，请重新查询券码');
  const requirements=assertStock([{productId:snapshot.product.id,quantity:1}]);
  reserveStock(requirements);
  for(const [id,quantity] of requirements)db.prepare('INSERT INTO redemption_stock VALUES(?,?,?)').run(row.id,id,quantity);
  db.prepare("UPDATE group_buy_redemptions SET state='verifying',request_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(requestId,row.id);
}
function releaseRedemption(row,message,operatorId=null) {
  for(const p of db.prepare('SELECT * FROM redemption_stock WHERE redemption_id=?').all(row.id)) {
    if(!db.prepare('UPDATE products SET reserved_stock=reserved_stock-? WHERE id=? AND reserved_stock>=?').run(p.quantity,p.product_id,p.quantity).changes)throw catalogError('预占库存异常，请核对');
  }
  db.prepare('DELETE FROM redemption_stock WHERE redemption_id=?').run(row.id);
  db.prepare("UPDATE group_buy_redemptions SET state='failed',error=?,operator_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(message,operatorId,row.id);
}
function validateRestrictions(row,voucher) {
  const r=voucher.restrictions;if(!r)return;
  // Meituan defines a coupon-count ceiling, not a per-table ownership rule.
  // This flow consumes one coupon per command; platform preflight validates
  // its full eligibility rules. Don't invent a cumulative per-table limit.
  if(r.maxPerRedemption!=null && r.maxPerRedemption<1)throw catalogError('已超出平台用券数量限制');
  const now=Date.now();
  if((r.start && Number(r.start)*1000>now)||(r.end && Number(r.end)*1000<now))throw catalogError('团购券不在有效期内');
  const date=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
  const day=new Date(Date.UTC(Number(date.year),Number(date.month)-1,Number(date.day))).getUTCDay()||7,minutes=Number(date.hour)*60+Number(date.minute);
  const toMinutes=value=>{const match=/^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value || '');if(!match || Number(match[1])>24 || Number(match[2])>59)throw catalogError('券的使用时间需人工核对');return Number(match[1])*60+Number(match[2]);};
  const inPeriod=p=>{const start=toMinutes(p.start_time),end=toMinutes(p.end_time);return p.end_time_is_next_day || end<start ? minutes>=start || minutes<=end : minutes>=start && minutes<=end;};
  if(r.time?.use_time_type===2 && !r.time.time_period_list?.some(inPeriod))throw catalogError('当前不在套餐可用时段');
  const unavailable=r.unavailable;
  if(unavailable?.can_no_use_week_day?.includes(day) || unavailable?.can_no_use_date?.some(d=>now>=Number(d.start_time)*1000 && now<=Number(d.end_time)*1000))throw catalogError('今天或当前时段不可使用此券');
  if(r.offPeak?.idle_time_limit_type===2)throw catalogError('错峰套餐需由服务员核对使用时段');
  const parseRule=v=>{if(!v)return null;try{return typeof v==='string'?JSON.parse(v):v;}catch{throw catalogError('套餐使用限制需由服务员核对');}};
  const rule=parseRule(r.attrs?.catering_voucher_limit_use_rule),generic=parseRule(r.attrs?.limit_use_rule);
  const limit=rule?.limit_type>1 ? Number(rule.limit_use_num) : generic?.is_limit_use ? Number(generic.use_num_per_consume) : 0;
  if(limit){const personal=rule?.limit_type===2;const total=db.prepare(`SELECT COUNT(*) AS value FROM group_buy_redemptions WHERE session_id=? AND mapping_id=? AND state IN ('verifying','unknown','verified','success')${personal?' AND user_id=?':''}`).get(...[row.session_id,row.mapping_id,...(personal?[row.user_id]:[])]).value;if(total>=limit)throw catalogError('已达到本桌或本人的套餐用券数量限制');}
}
export function finalizeRedemption(id,settleOrder,req={}) {
  return db.transaction(()=>{
    const row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id);
    if(row.state==='success')return redemptionView(row);
    if(row.state!=='verified')throw catalogError('核销结果尚未确认');
    const snapshot=JSON.parse(row.snapshot_json),voucher=JSON.parse(row.provider_json),orderNo=voucher.verificationContext?.vendorOrderId || `GB${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const orderId=db.prepare("INSERT INTO orders(order_no,session_id,payer_user_id,original_amount_cents,discount_amount_cents,payable_amount_cents,payment_method,source_channel,note) VALUES(?,?,?,?,?,?,'group_buy',?,?)")
      .run(orderNo,row.session_id,row.user_id,row.amount_cents,0,row.amount_cents,row.platform,`${platforms[row.platform]}团购兑换 · ${snapshot.product.name}`).lastInsertRowid;
    insertSaleItems(orderId,snapshot.product.id,1,{snapshot,originalPrice:row.amount_cents,paidPrice:row.amount_cents});
    settleOrder({id:orderId,payer_user_id:row.user_id,payable_amount_cents:row.amount_cents},'group_buy',req,true);
    db.prepare("UPDATE group_buy_redemptions SET state='success',order_id=?,updated_at=CURRENT_TIMESTAMP,error='' WHERE id=?").run(orderId,id);
    db.prepare('DELETE FROM redemption_stock WHERE redemption_id=?').run(id);
    return redemptionView(db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id));
  })();
}
export async function consumeRedemption({id,sessionId,userId,requestId},settleOrder,provider) {
  if(!/^[a-f0-9-]{36}$/i.test(requestId || ''))throw catalogError('请求标识无效',400);
  let row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=? AND session_id=? AND user_id=?').get(id,sessionId,userId);
  if(!row)throw catalogError('兑换记录不存在',404);
  if(row.state==='verified')return finalizeRedemption(id,settleOrder);
  if(['success','verifying','unknown'].includes(row.state))return redemptionView(row);
  validSession(sessionId,userId);
  if(row.state!=='prepared')throw catalogError('请重新查询券码');
  let voucher=JSON.parse(row.provider_json);
  if(voucher.expiresAt<Date.now())throw catalogError('查询结果已过期，请重新查询');
  const adapter=provider || groupBuyProvider(row.platform);
  if(adapter.verificationContext)voucher={...voucher,verificationContext:adapter.verificationContext(voucher,requestId,{id:row.id,product:JSON.parse(row.snapshot_json).product})};
  db.transaction(()=>{
    row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id);if(row.state!=='prepared')throw catalogError('兑换正在处理');
    if(voucher.verifyToken && db.prepare("SELECT 1 FROM group_buy_redemptions WHERE id!=? AND platform=? AND json_extract(provider_json,'$.verifyToken')=? AND state IN ('verifying','unknown','verified','success')").get(id,row.platform,voucher.verifyToken))throw catalogError('本次查询已有券开始核销，请重新查询剩余券');
    validateRestrictions(row,voucher);
    reserveRedemption(row,requestId);
    // Persist the merchant order and original verification request *before*
    // dispatch, so a timeout or restart can be checked without consuming again.
    db.prepare('UPDATE group_buy_redemptions SET provider_json=? WHERE id=?').run(JSON.stringify(voucher),id);
  })();
  try {
    const result=await adapter.verify(voucher,requestId);
    if(result.certificateId!==row.certificate_id || !result.verifyId)throw catalogError('平台核销结果不匹配');
    // Persist platform evidence before creating the local order. A crash
    // after this write is recovered without issuing another redemption.
    db.prepare("UPDATE group_buy_redemptions SET state='verified',provider_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='verifying'").run(JSON.stringify({...voucher,verification:result}),id);
    return finalizeRedemption(id,settleOrder);
  } catch(error) {
    if(error.redemptionRejected) {
      db.transaction(()=>{
        const live=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id);
        if(live.state==='verifying' && live.request_id===requestId)releaseRedemption(live,error.message);
      })();
      return redemptionView(db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id));
    }
    db.prepare("UPDATE group_buy_redemptions SET state='unknown',error='核销结果待核对，请勿重复兑换',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='verifying'").run(id);
    return redemptionView(db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id));
  }
}
const reconciliationTasks=new Map(),lastReconciliation=new Map();
export async function reconcileRedemption(id,settleOrder,req={}) {
  if(reconciliationTasks.has(id))return reconciliationTasks.get(id);
  const task=(async()=>{
    const row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id);
    if(!row)throw catalogError('兑换记录不存在',404);
    if(row.state==='verified')return finalizeRedemption(id,settleOrder,req);
    if(row.state!=='unknown' || row.platform!=='meituan' || row.source!=='api')return redemptionView(row);
    lastReconciliation.set(id,Date.now());
    const voucher=JSON.parse(row.provider_json);
    try {
      const result=await groupBuyProvider(row.platform).reconcile(voucher);
      if(result?.certificateId===row.certificate_id && result.verifyId) {
        const changed=db.prepare("UPDATE group_buy_redemptions SET state='verified',provider_json=?,error='',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='unknown' AND request_id=?")
          .run(JSON.stringify({...voucher,verification:result}),id,row.request_id);
        if(changed.changes)return finalizeRedemption(id,settleOrder,req);
      }
    } catch { /* Missing permissions or inconclusive history retain the hold. */ }
    return redemptionView(db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id));
  })();
  reconciliationTasks.set(id,task);
  try{return await task;}finally{reconciliationTasks.delete(id);}
}
export async function reconcileMeituanRedemptions(settleOrder) {
  if(!groupBuyCapabilities().meituan.ready)return;
  const rows=db.prepare("SELECT id FROM group_buy_redemptions WHERE state='unknown' AND platform='meituan' AND source='api'").all();
  const ids=new Set(rows.map(row=>row.id));
  for(const id of lastReconciliation.keys())if(!ids.has(id))lastReconciliation.delete(id);
  // Fair rotation prevents one unresolved coupon from blocking newer records.
  rows.sort((a,b)=>(lastReconciliation.get(a.id)||0)-(lastReconciliation.get(b.id)||0));
  for(let offset=0;offset<Math.min(rows.length,10);offset+=5)await Promise.all(rows.slice(offset,Math.min(offset+5,10)).map(row=>reconcileRedemption(row.id,settleOrder)));
}
export function registerGroupBuyRoutes(router,{currentUserId,audit,settleOrder}) {
  const handled=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status || 409).json({message:e.message});}};
  router.get('/sessions/:sessionId/group-buy',handled((req,res)=>res.json({platforms:groupBuyCapabilities(),records:db.prepare('SELECT * FROM group_buy_redemptions WHERE session_id=? AND user_id=? ORDER BY created_at DESC').all(req.params.sessionId,currentUserId(req)).map(redemptionView)})));
  router.post('/sessions/:sessionId/group-buy/query',handled(async(req,res)=>res.json({records:await withBackgroundTask(()=>prepareRedemption({...req.body,sessionId:Number(req.params.sessionId),userId:currentUserId(req)}))})));
  router.post('/sessions/:sessionId/group-buy/:id/consume',handled(async(req,res)=>res.json({record:await withBackgroundTask(()=>consumeRedemption({id:req.params.id,sessionId:Number(req.params.sessionId),userId:currentUserId(req),requestId:req.body?.requestId},settleOrder))})));
  router.get('/admin/group-buy',handled((req,res)=>{
    const mappings=db.prepare('SELECT m.*,p.recipe_version FROM group_buy_mappings m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC').all().map(m=>({...m,product:getCatalogProduct(m.product_id,req.staff.role==='super')}));
    const records=db.prepare('SELECT r.*,a.display_name AS operator,t.table_no FROM group_buy_redemptions r LEFT JOIN staff_accounts a ON a.id=r.operator_id JOIN table_sessions s ON s.id=r.session_id JOIN tables t ON t.id=s.table_id ORDER BY r.created_at DESC').all().map(r=>({...redemptionView(r),tableNo:r.table_no,operator:r.operator,expectedSettlement:r.expected_settlement_cents==null?null:r.expected_settlement_cents/100,actualSettlement:r.actual_settlement_cents==null?null:r.actual_settlement_cents/100}));
    const legacy=db.prepare('SELECT * FROM group_buy_records ORDER BY id DESC').all().map(r=>({id:`legacy-${r.id}`,platformName:r.platform,name:r.package_name,voucher:maskVoucher(r.voucher_no),amount:r.amount_cents/100,state:'legacy',source:'legacy',createdAt:r.verified_at,operator:r.verified_by}));
    const all=[...records,...legacy],pageSize=Number(req.query.pageSize)===50?50:20,totalPages=Math.max(1,Math.ceil(all.length/pageSize)),page=Math.min(totalPages,Math.max(1,Number(req.query.page)||1));
    res.json({platforms:groupBuyCapabilities(),mappings,records:all.slice((page-1)*pageSize,page*pageSize),pending:records.filter(r=>['verifying','unknown','verified'].includes(r.state)),pagination:{page,pageSize,total:all.length,totalPages,hasPrevious:page>1,hasNext:page<totalPages}});
  }));
  const manager=req=>{if(!['super','manager'].includes(req.staff.role))throw catalogError('仅管理员可配置套餐映射或核对异常',403);};
  router.post('/admin/group-buy/:id/recheck',handled(async(req,res)=>{
    manager(req);
    const record=await withBackgroundTask(()=>reconcileRedemption(req.params.id,settleOrder,req));
    audit(req,'查询平台团购核销结果',`${req.params.id} ${record.state}`);
    res.json({record});
  }));
  const mappingSave=(req,res,current)=>{
    manager(req);const b=req.body || {},platform=b.platform??current?.platform,external=String(b.externalProductId??current?.external_product_id??'').trim(),sku=String(b.externalSkuId??current?.external_sku_id??'').trim(),product=getCatalogProduct(Number(b.productId??current?.product_id));
    const amount=Math.round(Number(b.price??(current?.price_cents||0)/100)*100),fee=Number(b.feeRate??current?.fee_rate??0),status=b.status??current?.status??'active';
    if(!platforms[platform]||!external||external.length>128||sku.length>128||product?.kind!=='bundle'||!product.components.length||!Number.isSafeInteger(amount)||amount<0||!Number.isFinite(fee)||fee<0||fee>100||!['active','inactive'].includes(status))throw catalogError('平台、套餐 ID、组成货品或价格配置无效',400);
    if(current && current.product_id!==product.id && current.external_product_id===external && current.external_sku_id===sku)throw catalogError('同一平台套餐 ID 的组成不能改为另一个套餐，请使用新的平台套餐 ID');
    if(current)db.prepare('UPDATE group_buy_mappings SET platform=?,external_product_id=?,external_sku_id=?,product_id=?,name=?,price_cents=?,fee_rate=?,status=? WHERE id=?').run(platform,external,sku,product.id,String(b.name||product.name),amount,fee,status,current.id);
    else db.prepare('INSERT INTO group_buy_mappings(store_id,platform,external_product_id,external_sku_id,product_id,name,price_cents,fee_rate,status) VALUES(?,?,?,?,?,?,?,?,?)').run(product.store_id,platform,external,sku,product.id,String(b.name||product.name),amount,fee,status);
    audit(req,'配置团购套餐映射',`${platforms[platform]} ${external}/${sku} -> ${product.name}`);res.json({ok:true});
  };
  router.post('/admin/group-buy/mappings',handled((req,res)=>mappingSave(req,res,null)));
  router.patch('/admin/group-buy/mappings/:id',handled((req,res)=>{const m=db.prepare('SELECT * FROM group_buy_mappings WHERE id=?').get(req.params.id);if(!m)throw catalogError('映射不存在',404);mappingSave(req,res,m);}));
  router.get('/admin/group-buy/context',handled((_req,res)=>res.json({bundles:db.prepare("SELECT * FROM products WHERE kind='bundle'").all().map(p=>getCatalogProduct(p.id)),sessions:db.prepare("SELECT s.id,t.table_no FROM table_sessions s JOIN tables t ON t.id=s.table_id WHERE s.status='open' AND t.status!='disabled'").all().map(s=>({...s,members:db.prepare('SELECT u.id,u.nickname,u.phone FROM session_members m JOIN users u ON u.id=m.user_id WHERE m.session_id=?').all(s.id)}))})));
  router.post('/admin/group-buy/verify',handled((req,res)=>{
    const b=req.body||{};
    if(!['super','manager'].includes(req.staff.role) && req.staff.workspace!=='cashier')throw catalogError('请由收银员或管理员核对平台核销',403);
    if(b.platformVerified!==true || !/^[a-f0-9-]{36}$/i.test(b.requestId || ''))throw catalogError('请先在平台完成核销，再勾选确认并提交',400);
    const mapping=db.prepare("SELECT * FROM group_buy_mappings WHERE id=? AND status='active'").get(Number(b.mappingId));
    if(!mapping)throw catalogError('请选择已配置的团购套餐',400);
    const code=codeInput(b.voucherNo),sessionId=Number(b.sessionId),userId=Number(b.userId),amount=Math.round(Number(b.amount)*100);
    if(!Number.isSafeInteger(amount)||amount<0)throw catalogError('平台券金额无效',400);
    validSession(sessionId,userId);
    if(mapping.store_id!==db.prepare('SELECT store_id FROM table_sessions WHERE id=?').get(sessionId).store_id)throw catalogError('套餐和桌台不属于同一门店');
    if(db.prepare('SELECT 1 FROM group_buy_records WHERE platform=? AND voucher_no=?').get(platforms[mapping.platform],code))throw catalogError('历史核销记录中已有此券，请核对原记录');
    const prior=db.prepare('SELECT * FROM group_buy_redemptions WHERE request_id=?').get(b.requestId);
    if(prior){if(prior.mapping_id!==mapping.id || prior.voucher_hash!==hash(code)||prior.session_id!==sessionId||prior.user_id!==userId||prior.amount_cents!==amount)throw catalogError('重复请求的内容不一致');return res.json({record:redemptionView(prior)});}
    const record=db.transaction(()=>{
      const existing=db.prepare('SELECT * FROM group_buy_redemptions WHERE platform=? AND voucher_hash=?').all(mapping.platform,hash(code));
      if(existing.some(r=>['verifying','unknown','verified','success','cancelled'].includes(r.state)))throw catalogError('此券已有兑换或核销待确认，请核对原记录');
      db.prepare("UPDATE group_buy_redemptions SET state='failed',error='收银已在平台核销并另行生成配送订单' WHERE platform=? AND voucher_hash=? AND source='api' AND state='prepared'").run(mapping.platform,hash(code));
      const row=savePrepared({platform:mapping.platform,code,voucher:{certificateId:`manual:${hash(code)}`,amountCents:amount},mapping,sessionId,userId,source:'manual'});
      if(row.state==='success')return redemptionView(row);
      if(row.state!=='prepared')throw catalogError('此券已有核销正在处理，请核对异常记录');
      reserveRedemption(row,b.requestId);
      db.prepare("UPDATE group_buy_redemptions SET state='verified',operator_id=? WHERE id=?").run(req.staff.id,row.id);
      const record=finalizeRedemption(row.id,settleOrder,req);audit(req,'确认平台核销并生成配送订单',`${platforms[mapping.platform]} ${maskVoucher(code)} ${record.orderNo}`);return record;
    })();
    res.status(201).json({record});
  }));
  router.post('/admin/group-buy/:id/resolve',handled((req,res)=>{
    manager(req);const b=req.body || {},reason=String(b.reason || '').trim();
    if(!reason || reason.length>300 || b.platformChecked!==true || !['success','failed'].includes(b.outcome))throw catalogError('请核对平台结果并填写原因',400);
    const result=db.transaction(()=>{
      const row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(req.params.id);
      if(!row || !['unknown','verified'].includes(row.state))throw catalogError('此记录无需人工核对');
      let record;
      if(b.outcome==='success') {if(!String(b.verifyId || '').trim())throw catalogError('请填写平台核销凭证编号',400);db.prepare("UPDATE group_buy_redemptions SET state='verified',operator_id=?,provider_json=? WHERE id=?").run(req.staff.id,JSON.stringify({...JSON.parse(row.provider_json),manualEvidence:{verifyId:b.verifyId,reason}}),row.id);record=finalizeRedemption(row.id,settleOrder,req);}
      else {releaseRedemption(row,reason,req.staff.id);record=redemptionView(db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(row.id));}
      audit(req,'人工核对团购结果',`${row.id} ${b.outcome} ${reason}`);return record;
    })();
    res.json({record:result});
  }));
  router.patch('/admin/group-buy/:id/settlement',handled((req,res)=>{
    if(req.staff.role!=='super')throw catalogError('仅超级管理员可录入实际结算',403);
    const amount=Math.round(Number(req.body?.amount)*100);if(!Number.isSafeInteger(amount)||amount<0)throw catalogError('结算金额无效',400);
    const settledAt=req.body?.settledAt?new Date(parseLocal(req.body.settledAt,commerceSettings().timezone)).toISOString():new Date().toISOString();
    db.transaction(()=>{
      const row=db.prepare("SELECT * FROM group_buy_redemptions WHERE id=? AND state='success'").get(req.params.id);if(!row)throw catalogError('仅成功兑换记录可以结算');
      const requestId=req.body?.requestId || crypto.randomUUID(),previous=db.prepare('SELECT * FROM group_buy_settlements WHERE request_id=?').get(requestId);
      if(previous){if(previous.redemption_id!==row.id||previous.target_total_cents!==amount||req.body?.settledAt&&previous.settled_at!==settledAt)throw catalogError('结算请求内容不一致');return;}
      const recorded=db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS n FROM group_buy_settlements WHERE redemption_id=?').get(row.id).n;
      db.prepare('INSERT INTO group_buy_settlements(redemption_id,request_id,amount_cents,settled_at,operator_id,target_total_cents) VALUES(?,?,?,?,?,?)').run(row.id,requestId,amount-recorded,settledAt,req.staff.id,amount);
      db.prepare('UPDATE group_buy_redemptions SET actual_settlement_cents=?,actual_settlement_at=? WHERE id=?').run(amount,settledAt,row.id);
    })();audit(req,'录入团购实际结算',`${req.params.id} ${amount/100}`);res.json({ok:true});
  }));
  router.post('/admin/group-buy/:id/reverse',handled((req,res)=>{
    manager(req);const b=req.body||{},reason=String(b.reason||'').trim();
    if(b.platformChecked!==true || !reason || reason.length>300 || !String(b.verifyId||'').trim())throw catalogError('请核实平台撤销 / 退款凭证并填写原因',400);
    db.transaction(()=>{
      const row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(req.params.id);
      if(row?.state==='cancelled')return;
      if(row?.state!=='success')throw catalogError('此记录不能撤销');
      const order=db.prepare('SELECT * FROM orders WHERE id=?').get(row.order_id);
      if(order.status!=='awaiting_delivery' || hasDeliveryInProgress(order.id) || db.prepare('SELECT 1 FROM order_items WHERE order_id=? AND delivered_quantity>0').get(order.id))throw catalogError('有货品已送达或正在配送，请先核对实际交付，不能整券退库');
      cancelReadyBatchesForRefund(order.id,[],true);
      const beforeReturn=db.prepare(`SELECT ${orderCostSql('o')} AS value FROM orders o WHERE id=?`).get(order.id).value;
      returnOrderStock(db,order,[],true);
      const afterReturn=db.prepare(`SELECT ${orderCostSql('o')} AS value FROM orders o WHERE id=?`).get(order.id).value;
      db.prepare("INSERT INTO refund_transactions(order_id,user_id,amount_cents,external_cents,out_refund_no,reason,status,completed_at,returned_cost_cents) VALUES(?,?,?,?,?,?,'success',CURRENT_TIMESTAMP,?)").run(order.id,row.user_id,row.amount_cents,row.amount_cents,`GBRF-${row.id}`,`平台凭证 ${b.verifyId}：${reason}`,beforeReturn-afterReturn);
      db.prepare("UPDATE orders SET status='refunded',fulfillment_revision=fulfillment_revision+1 WHERE id=?").run(order.id);
      db.prepare("UPDATE group_buy_redemptions SET state='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      const earned=db.prepare("SELECT COALESCE(SUM(points),0) AS value FROM points_ledger WHERE order_id=? AND reason='订单消费'").get(order.id).value;
      if(earned){const points=Math.min(earned,db.prepare('SELECT points FROM users WHERE id=?').get(row.user_id).points);db.prepare('UPDATE users SET points=points-? WHERE id=?').run(points,row.user_id);db.prepare('INSERT INTO points_ledger(user_id,order_id,points,reason) VALUES(?,?,?,?)').run(row.user_id,order.id,-points,'订单退款');}
      workEvent('order_changed',order.id);audit(req,'确认平台团购撤销并退库',`${row.id} ${b.verifyId}：${reason}`);
    })();
    res.json({ok:true});
  }));
}
