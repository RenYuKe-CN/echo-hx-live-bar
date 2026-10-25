import crypto from 'node:crypto';
import { db } from './db.js';
import { catalogError, recipeSnapshot, assertStock, reserveStock, insertSaleItems, getCatalogProduct } from './catalog.js';
import { refundStockPlan, applyRefundStockPlan } from './refund-stock.js';
import { recordRefundFlow, recordShiftFlow } from './shifts.js';
import { hasDeliveryInProgress, cancelReadyBatchesForRefund, workEvent } from './workdesk.js';
import { parseLocal,commerceSettings } from './business-time.js';
import { orderCostSql } from './refund-stock.js';

const hash=code=>crypto.createHash('sha256').update(code).digest('hex');
export const maskVoucher=code=>!code ? '线下已核销' : code.length>4 ? `${'•'.repeat(Math.min(8,code.length-4))}${code.slice(-4)}` : '••••';
const platforms={meituan:'美团',douyin:'抖音'};
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
  if(!db.prepare("SELECT 1 FROM table_sessions s JOIN session_members m ON m.session_id=s.id JOIN tables t ON t.id=s.table_id WHERE s.id=? AND m.user_id=? AND s.status='open' AND t.status!='disabled'").get(sessionId,userId))throw catalogError('请绑定有效桌台和顾客');
}
function saveManualRecord({mapping,sessionId,userId,amount}) {
  const snapshot=recipeSnapshot(mapping.product_id);
  if(snapshot.product.status!=='active' || !snapshot.components.length)throw catalogError('套餐尚未开放兑换，请联系服务员');
  assertStock([{productId:mapping.product_id,quantity:1}]);
  const id=crypto.randomUUID();
  // Keep legacy identity columns for historical records. New offline entries
  // have no voucher code; these unique keys identify only the local record.
  db.prepare(`INSERT INTO group_buy_redemptions(id,store_id,session_id,user_id,platform,certificate_id,voucher_hash,voucher_code,mapping_id,state,source,snapshot_json,provider_json,amount_cents,expected_settlement_cents)
    VALUES(?,?,?,?,?,?,?,'',?,'prepared','manual',?,'{}',?,?)`)
    .run(id,mapping.store_id,sessionId,userId,mapping.platform,`manual:${id}`,hash(id),mapping.id,JSON.stringify(snapshot),amount,Math.round(amount*(1-mapping.fee_rate/100)));
  return db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id);
}
function reserveRedemption(row,requestId) {
  const snapshot=JSON.parse(row.snapshot_json),live=getCatalogProduct(snapshot.product.id);
  if(!live || live.recipe_version!==snapshot.product.recipe_version || live.status!=='active')throw catalogError('套餐配置已更新，请重新选择套餐');
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
export function finalizeRedemption(id,settleOrder,req={}) {
  return db.transaction(()=>{
    const row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id);
    if(row.state==='success')return redemptionView(row);
    if(row.state!=='verified')throw catalogError('核销结果尚未确认');
    const snapshot=JSON.parse(row.snapshot_json),voucher=JSON.parse(row.provider_json),orderNo=voucher.verificationContext?.vendorOrderId || `GB${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const orderId=db.prepare("INSERT INTO orders(order_no,session_id,payer_user_id,original_amount_cents,discount_amount_cents,payable_amount_cents,payment_method,source_channel,note) VALUES(?,?,?,?,?,?,'group_buy',?,?)")
      .run(orderNo,row.session_id,row.user_id,row.amount_cents,0,row.amount_cents,row.platform,`${platforms[row.platform]}团购兑换 · ${snapshot.product.name}`).lastInsertRowid;
    if(row.source==='manual' && row.request_id)db.prepare('UPDATE orders SET pos_request_id=? WHERE id=?').run(row.request_id,orderId);
    insertSaleItems(orderId,snapshot.product.id,1,{snapshot,originalPrice:row.amount_cents,paidPrice:row.amount_cents});
    settleOrder({id:orderId,payer_user_id:row.user_id,payable_amount_cents:row.amount_cents},'group_buy',req,true);
    db.prepare("UPDATE group_buy_redemptions SET state='success',order_id=?,updated_at=CURRENT_TIMESTAMP,error='' WHERE id=?").run(orderId,id);
    db.prepare('DELETE FROM redemption_stock WHERE redemption_id=?').run(id);
    return redemptionView(db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(id));
  })();
}
export function groupBuyOptions() {
  return db.prepare("SELECT * FROM group_buy_mappings WHERE status='active' ORDER BY platform,id").all().map(m=>({
    id:m.id,platform:m.platform,platformName:platforms[m.platform],name:m.name,price:m.price_cents/100,
    product:getCatalogProduct(m.product_id)
  })).filter(m=>m.product?.status==='active' && m.product.kind==='bundle' && m.product.components.length);
}
export function registerGroupBuyRoutes(router,{audit,settleOrder,getOrCreateSession}) {
  const handled=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status || 409).json({message:e.message});}};
  const retired=(_req,res)=>res.status(410).json({message:'平台在线核销已移除，请在美团 / 抖音商家端核销后，由收银台选择团购核销下单'});
  router.get('/sessions/:sessionId/group-buy',retired);
  router.post('/sessions/:sessionId/group-buy/query',retired);
  router.post('/sessions/:sessionId/group-buy/:id/consume',retired);
  router.get('/admin/group-buy',handled((req,res)=>{
    const mappings=db.prepare('SELECT m.*,p.recipe_version FROM group_buy_mappings m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC').all().map(m=>({...m,product:getCatalogProduct(m.product_id,req.staff.role==='super')}));
    const records=db.prepare('SELECT r.*,a.display_name AS operator,t.table_no FROM group_buy_redemptions r LEFT JOIN staff_accounts a ON a.id=r.operator_id JOIN table_sessions s ON s.id=r.session_id JOIN tables t ON t.id=s.table_id ORDER BY r.created_at DESC').all().map(r=>({...redemptionView(r),tableNo:r.table_no,operator:r.operator,expectedSettlement:r.expected_settlement_cents==null?null:r.expected_settlement_cents/100,actualSettlement:r.actual_settlement_cents==null?null:r.actual_settlement_cents/100}));
    const legacy=db.prepare('SELECT * FROM group_buy_records ORDER BY id DESC').all().map(r=>({id:`legacy-${r.id}`,platformName:r.platform,name:r.package_name,voucher:maskVoucher(r.voucher_no),amount:r.amount_cents/100,state:'legacy',source:'legacy',createdAt:r.verified_at,operator:r.verified_by}));
    const all=[...records,...legacy],pageSize=Number(req.query.pageSize)===50?50:20,totalPages=Math.max(1,Math.ceil(all.length/pageSize)),page=Math.min(totalPages,Math.max(1,Number(req.query.page)||1));
    res.json({mappings,records:all.slice((page-1)*pageSize,page*pageSize),pending:records.filter(r=>['verifying','unknown','verified'].includes(r.state)),pagination:{page,pageSize,total:all.length,totalPages,hasPrevious:page>1,hasNext:page<totalPages}});
  }));
  const manager=req=>{if(!['super','manager'].includes(req.staff.role))throw catalogError('仅管理员可配置套餐映射或核对异常',403);};
  router.post('/admin/group-buy/:id/recheck',retired);
  const mappingSave=(req,res,current)=>{
    manager(req);const b=req.body || {},platform=b.platform??current?.platform,external=String(b.externalProductId??current?.external_product_id??'').trim() || current?.external_product_id || `manual:${crypto.randomUUID()}`,sku=String(b.externalSkuId??current?.external_sku_id??'').trim(),product=getCatalogProduct(Number(b.productId??current?.product_id));
    const amount=Math.round(Number(b.price??(current?.price_cents||0)/100)*100),fee=Number(b.feeRate??current?.fee_rate??0),status=b.status??current?.status??'active';
    if(!platforms[platform]||!external||external.length>128||sku.length>128||product?.kind!=='bundle'||!product.components.length||!Number.isSafeInteger(amount)||amount<0||!Number.isFinite(fee)||fee<0||fee>100||!['active','inactive'].includes(status))throw catalogError('平台、套餐标识、组成货品或价格配置无效',400);
    if(current && current.product_id!==product.id && current.external_product_id===external && current.external_sku_id===sku)throw catalogError('已有套餐配置不能换成另一套组成，请新增团购套餐配置');
    if(current)db.prepare('UPDATE group_buy_mappings SET platform=?,external_product_id=?,external_sku_id=?,product_id=?,name=?,price_cents=?,fee_rate=?,status=? WHERE id=?').run(platform,external,sku,product.id,String(b.name||product.name),amount,fee,status,current.id);
    else db.prepare('INSERT INTO group_buy_mappings(store_id,platform,external_product_id,external_sku_id,product_id,name,price_cents,fee_rate,status) VALUES(?,?,?,?,?,?,?,?,?)').run(product.store_id,platform,external,sku,product.id,String(b.name||product.name),amount,fee,status);
    audit(req,'配置团购套餐映射',`${platforms[platform]} ${external}/${sku} -> ${product.name}`);res.json({ok:true});
  };
  router.post('/admin/group-buy/mappings',handled((req,res)=>mappingSave(req,res,null)));
  router.patch('/admin/group-buy/mappings/:id',handled((req,res)=>{const m=db.prepare('SELECT * FROM group_buy_mappings WHERE id=?').get(req.params.id);if(!m)throw catalogError('映射不存在',404);mappingSave(req,res,m);}));
  router.get('/admin/group-buy/context',handled((_req,res)=>res.json({bundles:db.prepare("SELECT * FROM products WHERE kind='bundle'").all().map(p=>getCatalogProduct(p.id))})));
  router.post('/admin/group-buy/verify',retired);
  router.post('/admin/pos/group-buy',handled((req,res)=>{
    const b=req.body||{},phone=String(b.phone||'').trim();
    if(b.platformVerified!==true || !/^[a-f0-9-]{36}$/i.test(b.requestId || ''))throw catalogError('请先在商家端完成核销，再勾选确认并提交',400);
    if(!/^1[3-9]\d{9}$/.test(phone) || !Number.isSafeInteger(b.tableId) || !Number.isSafeInteger(b.mappingId))throw catalogError('请选择有效桌台、手机号和团购套餐',400);
    if((b.items!=null && (!Array.isArray(b.items) || b.items.length)) || (b.quantity!=null && b.quantity!==1))throw catalogError('团购每次登记一套已在线下核销的套餐，加购商品请另行下单',400);
    const amountText=String(b.amount??'').trim();
    if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amountText))throw catalogError('请填写平台实际券金额，最多两位小数',400);
    const amount=Math.round(Number(amountText)*100);
    if(!Number.isSafeInteger(amount)||amount<0)throw catalogError('平台券金额无效',400);
    const result=db.transaction(()=>{
      const member=db.prepare('SELECT id,phone FROM users WHERE phone=?').get(phone);
      if(!member)throw catalogError('请先绑定顾客手机号',400);
      const prior=db.prepare('SELECT * FROM group_buy_redemptions WHERE request_id=?').get(b.requestId);
      if(prior){
        const tableId=db.prepare('SELECT table_id FROM table_sessions WHERE id=?').get(prior.session_id)?.table_id;
        if(prior.source!=='manual' || prior.mapping_id!==b.mappingId || tableId!==b.tableId || prior.user_id!==member.id || prior.amount_cents!==amount)throw catalogError('重复请求的内容不一致');
        if(prior.state!=='success')throw catalogError('原团购记录已撤销或待处理，请核对原记录');
        return redemptionView(prior);
      }
      if(db.prepare('SELECT 1 FROM orders WHERE pos_request_id=?').get(b.requestId) || db.prepare('SELECT 1 FROM wallet_transactions WHERE pos_request_id=?').get(b.requestId))throw catalogError('此请求标识已用于其他收银业务');
      const mapping=db.prepare("SELECT * FROM group_buy_mappings WHERE id=? AND status='active'").get(b.mappingId);
      const table=db.prepare("SELECT * FROM tables WHERE id=? AND status!='disabled'").get(b.tableId);
      if(!mapping || !table || mapping.store_id!==table.store_id)throw catalogError('请选择已配置的团购套餐和有效桌台',400);
      const session=getOrCreateSession(table.store_id,table.id,member.id);
      validSession(session.id,member.id);
      const row=saveManualRecord({mapping,sessionId:session.id,userId:member.id,amount});
      reserveRedemption(row,b.requestId);
      db.prepare("UPDATE group_buy_redemptions SET state='verified',operator_id=? WHERE id=?").run(req.staff.id,row.id);
      const record=finalizeRedemption(row.id,settleOrder,req);
      audit(req,'收银团购核销下单',`${platforms[mapping.platform]} 线下已核销 ${record.orderNo} 桌号 ${table.table_no} 手机尾号 ${member.phone.slice(-4)}`);
      return record;
    })();
    res.status(201).json({record:result,orderNo:result.orderNo,payable:result.amount});
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
      const inserted=db.prepare('INSERT INTO group_buy_settlements(redemption_id,request_id,amount_cents,settled_at,operator_id,target_total_cents) VALUES(?,?,?,?,?,?)').run(row.id,requestId,amount-recorded,settledAt,req.staff.id,amount);
      recordShiftFlow(`settlement:${inserted.lastInsertRowid}`,'settlement',`${row.platform}_settlement`,amount-recorded,row.id,req.staff.id,'按系统录入确认时间归班；实际到账日见营业报表');
      db.prepare('UPDATE group_buy_redemptions SET actual_settlement_cents=?,actual_settlement_at=? WHERE id=?').run(amount,settledAt,row.id);
    })();audit(req,'录入团购实际结算',`${req.params.id} ${amount/100}`);res.json({ok:true});
  }));
  router.get('/admin/group-buy/:id/refund-items',handled((req,res)=>{manager(req);const row=db.prepare('SELECT order_id FROM group_buy_redemptions WHERE id=?').get(req.params.id);if(!row)throw catalogError('团购记录不存在',404);res.json({items:db.prepare('SELECT id,product_name,quantity,returned_quantity,returned_delivered_quantity FROM order_items WHERE order_id=? ORDER BY id').all(row.order_id)});}));
  router.post('/admin/group-buy/:id/reverse',handled((req,res)=>{
    manager(req);const b=req.body||{},reason=String(b.reason||'').trim();
    if(b.platformChecked!==true || !reason || reason.length>300 || !String(b.verifyId||'').trim())throw catalogError('请核实平台撤销 / 退款凭证并填写原因',400);
    db.transaction(()=>{
      const row=db.prepare('SELECT * FROM group_buy_redemptions WHERE id=?').get(req.params.id);
      if(row?.state==='cancelled')return;
      if(row?.state!=='success')throw catalogError('此记录不能撤销');
      const order=db.prepare('SELECT * FROM orders WHERE id=?').get(row.order_id);
      if(!['awaiting_delivery','completed'].includes(order.status) || hasDeliveryInProgress(order.id))throw catalogError('有货品正在配送或订单已结束，请先核实实际交付');
      const plan=refundStockPlan(db,order,b,[],true);
      cancelReadyBatchesForRefund(order.id,[],true);
      const beforeReturn=db.prepare(`SELECT ${orderCostSql('o')} AS value FROM orders o WHERE id=?`).get(order.id).value;
      applyRefundStockPlan(db,order,plan);
      const afterReturn=db.prepare(`SELECT ${orderCostSql('o')} AS value FROM orders o WHERE id=?`).get(order.id).value;
      const refundId=db.prepare("INSERT INTO refund_transactions(order_id,user_id,amount_cents,external_cents,out_refund_no,reason,status,completed_at,returned_cost_cents,stock_plan_json,operator_id) VALUES(?,?,?,?,?,?,'success',CURRENT_TIMESTAMP,?,?,?)").run(order.id,row.user_id,row.amount_cents,row.amount_cents,`GBRF-${row.id}`,`平台凭证 ${b.verifyId}：${reason}`,beforeReturn-afterReturn,JSON.stringify(plan),req.staff.id).lastInsertRowid;
      recordRefundFlow(db.prepare('SELECT * FROM refund_transactions WHERE id=?').get(refundId),order);
      db.prepare("UPDATE orders SET status='refunded',fulfillment_revision=fulfillment_revision+1 WHERE id=?").run(order.id);
      db.prepare("UPDATE group_buy_redemptions SET state='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      const earned=db.prepare("SELECT COALESCE(SUM(points),0) AS value FROM points_ledger WHERE order_id=? AND reason='订单消费'").get(order.id).value;
      if(earned){const points=Math.min(earned,db.prepare('SELECT points FROM users WHERE id=?').get(row.user_id).points);db.prepare('UPDATE users SET points=points-? WHERE id=?').run(points,row.user_id);db.prepare('INSERT INTO points_ledger(user_id,order_id,points,reason) VALUES(?,?,?,?)').run(row.user_id,order.id,-points,'订单退款');}
      workEvent('order_changed',order.id);audit(req,'确认平台团购撤销并退库',`${row.id} ${b.verifyId}：${reason}`);
    })();
    res.json({ok:true});
  }));
}
