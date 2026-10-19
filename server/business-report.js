import ExcelJS from 'exceljs';
import { db } from './db.js';
import { channelAmounts,refundAmounts,channelNames,ensureBillIdentity } from './bills.js';
import { commerceError,formatTime,inWindow,utcTime,commerceSettings,localDateTime,currentBusinessDate,nextDate,parseLocal } from './business-time.js';
const money=n=>n==null?null:Number((n/100).toFixed(2));
const sqlDate=value=>new Date(value).toISOString();
const sum=(rows,key)=>rows.reduce((n,r)=>n+Number(r[key]||0),0);
export function businessReport(window) {
  return db.transaction(()=>{
    for(const session of db.prepare("SELECT id FROM table_sessions WHERE bill_no IS NULL OR table_no_snapshot='' OR store_name_snapshot=''").all())ensureBillIdentity(session.id);
    const bounds=[sqlDate(window.from),sqlDate(window.to)];
    const within=field=>`datetime(${field})>=datetime(?) AND datetime(${field})<datetime(?)`;
    const orders=db.prepare(`SELECT o.*,s.bill_no,s.table_no_snapshot AS table_no,s.opened_at,s.closed_at,s.status AS session_status,CASE WHEN o.payer_identity_captured_at IS NOT NULL THEN o.payer_name_snapshot ELSE u.nickname END AS nickname,CASE WHEN o.payer_identity_captured_at IS NOT NULL THEN o.payer_phone_snapshot ELSE u.phone END AS payer_phone FROM orders o JOIN table_sessions s ON s.id=o.session_id JOIN users u ON u.id=o.payer_user_id WHERE (${within('o.created_at')}) OR (o.payment_status='paid' AND ${within('o.paid_at')}) OR EXISTS(SELECT 1 FROM refund_transactions r WHERE r.order_id=o.id AND ${within('COALESCE(r.completed_at,r.created_at)')}) ORDER BY o.created_at,o.id LIMIT 10001`).all(...bounds,...bounds,...bounds);
    if(orders.length>10000)throw commerceError('所选范围订单超过 10000 笔，请缩短时间范围',413);
    const orderMap=new Map(orders.map(o=>[o.id,o]));
    const refunds=db.prepare(`SELECT r.*,o.offline_channel,o.source_channel,o.order_no,o.session_id FROM refund_transactions r JOIN orders o ON o.id=r.order_id WHERE ${within('COALESCE(r.completed_at,r.created_at)')} ORDER BY COALESCE(r.completed_at,r.created_at),r.id`).all(...bounds);
    const successfulRefunds=refunds.filter(r=>r.status==='success');
    const recharges=db.prepare(`SELECT w.*,u.nickname FROM wallet_transactions w JOIN users u ON u.id=w.user_id WHERE w.type='recharge' AND ${within('w.created_at')} ORDER BY w.created_at,w.id`).all(...bounds);
    const settlements=db.prepare(`SELECT x.*,r.platform,s.bill_no,o.order_no FROM group_buy_settlements x JOIN group_buy_redemptions r ON r.id=x.redemption_id JOIN table_sessions s ON s.id=r.session_id LEFT JOIN orders o ON o.id=r.order_id WHERE ${within('x.settled_at')} ORDER BY x.settled_at,x.id`).all(...bounds);
    const losses=db.prepare(`SELECT l.*,p.name,p.unit,a.display_name AS operator FROM stock_losses l JOIN products p ON p.id=l.product_id JOIN staff_accounts a ON a.id=l.operator_id WHERE ${within('l.created_at')}`).all(...bounds);
    const inventory=db.prepare(`SELECT l.*,p.name,p.unit,o.order_no,s.bill_no,s.table_no_snapshot AS table_no FROM inventory_logs l JOIN products p ON p.id=l.product_id LEFT JOIN orders o ON o.id=l.order_id LEFT JOIN table_sessions s ON s.id=o.session_id WHERE ${within('l.created_at')} ORDER BY l.created_at,l.id`).all(...bounds);
    const paid=orders.filter(o=>o.payment_status==='paid'&&inWindow(o.paid_at,window));
    const ids=orders.map(o=>o.id),items=ids.length?db.prepare(`SELECT i.*,p.unit FROM order_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.order_id IN (${ids.map(()=>'?').join(',')}) ORDER BY i.order_id,i.id`).all(...ids):[];
    const groups=ids.length?db.prepare(`SELECT * FROM order_bundle_groups WHERE order_id IN (${ids.map(()=>'?').join(',')}) ORDER BY order_id,id`).all(...ids):[];
    if(items.length+inventory.length>100000)throw commerceError('明细超过 100000 行，请缩短时间范围',413);
    const channels={};
    const flows=[];
    for(const order of paid)for(const [channel,amount] of channelAmounts(order)) {
      (channels[channel]||=( {received:0,refunded:0} )).received+=amount;
      flows.push({time:order.paid_at,type:order.payment_method==='group_buy'?'团购核销记账':'订单付款',channel,amount,orderNo:order.order_no,billNo:order.bill_no,number:order.wechat_transaction_id||order.order_no,external:!['stored','bonus','meituan','douyin'].includes(channel)});
    }
    for(const refund of successfulRefunds)for(const [channel,amount] of refundAmounts(refund,refund)) {
      (channels[channel]||=( {received:0,refunded:0} )).refunded+=amount;
      flows.push({time:refund.completed_at||refund.created_at,type:'订单退款',channel,amount:-amount,orderNo:refund.order_no,billNo:orderMap.get(refund.order_id)?.bill_no||'',number:refund.out_refund_no,external:!['stored','bonus','meituan','douyin'].includes(channel),legacyTime:!refund.completed_at});
    }
    for(const recharge of recharges)flows.push({time:recharge.created_at,type:'会员充值',channel:recharge.payment_channel,amount:recharge.pay_cents,orderNo:'',billNo:'',number:'充值-'+recharge.id,external:true});
    for(const settled of settlements)flows.push({time:settled.settled_at,type:'团购实际结算 / 调整',channel:settled.platform,amount:settled.amount_cents,orderNo:settled.order_no||'',billNo:settled.bill_no,number:'结算-'+settled.id,external:true});
    for(const refund of refunds.filter(r=>r.status!=='success'))flows.push({time:refund.created_at,type:'退款申请（未确认记账）',channel:'unknown',amount:null,requestedAmount:-refund.amount_cents,status:refund.status,orderNo:refund.order_no,billNo:orderMap.get(refund.order_id)?.bill_no||'',number:refund.out_refund_no,external:false});
    flows.sort((a,b)=>utcTime(a.time)-utcTime(b.time));
    const sales=sum(paid,'payable_amount_cents')-sum(paid,'bonus_paid_cents');
    const refundRevenue=successfulRefunds.reduce((n,r)=>n+r.stored_cents+r.wechat_cents+r.offline_cents+r.external_cents,0);
    const paidIds=new Set(paid.map(o=>o.id)),paymentCosts={};for(const item of items)paymentCosts[item.order_id]=(paymentCosts[item.order_id]||0)+item.quantity*item.cost_price_cents;
    const saleCost=paid.reduce((n,o)=>n+(paymentCosts[o.id]||0),0);
    const missingCost=successfulRefunds.filter(r=>r.returned_cost_cents==null).length;
    const returnedCost=missingCost?null:sum(successfulRefunds,'returned_cost_cents');
    const cost=returnedCost==null?null:saleCost-returnedCost,lossCost=sum(losses,'cost_cents');
    const totals={orders:paid.length,tables:new Set(paid.map(o=>o.session_id)).size,createdOrders:orders.filter(o=>inWindow(o.created_at,window)).length,pendingOrders:orders.filter(o=>o.payment_status==='pending').length,
      gross:money(sum(paid,'original_amount_cents')),discount:money(sum(paid,'discount_amount_cents')),sales:money(sales),refund:money(refundRevenue),refundBonus:money(sum(successfulRefunds,'bonus_cents')),revenue:money(sales-refundRevenue),bonusUsed:money(sum(paid,'bonus_paid_cents')),
      storedUsed:money(channels.stored?.received||0),wechatReceived:money(channels.wechat?.received||0),offlineReceived:money(Object.entries(channels).filter(([k])=>['cash','merchant_qr','offline'].includes(k)).reduce((n,[,c])=>n+c.received,0)),
      rechargeReceived:money(sum(recharges,'pay_cents')),settlementReceived:money(sum(settlements,'amount_cents')),externalNetReceived:money(flows.filter(f=>f.external).reduce((n,f)=>n+f.amount,0)),
      saleCost:money(saleCost),returnedCost:money(returnedCost),orderCost:money(cost),lossCost:money(lossCost),profit:cost==null?null:money(sales-refundRevenue-cost-lossCost),missingRefundCost:missingCost,legacyRefundTimes:successfulRefunds.filter(r=>!r.completed_at).length,
      undatedSettlements:db.prepare('SELECT COUNT(*) AS n FROM group_buy_redemptions WHERE actual_settlement_cents IS NOT NULL AND actual_settlement_at IS NULL').get().n};
    const products=[...groups.map(g=>({orderId:g.order_id,id:g.product_id,name:g.name,kind:'套餐',quantity:g.quantity,unit:'套',original:g.original_cents,amount:g.paid_cents})),...items.filter(i=>!i.bundle_group_id).map(i=>({orderId:i.order_id,id:i.product_id,name:i.product_name,kind:'单品',quantity:i.quantity,unit:i.unit_snapshot||'件',original:i.original_price_cents*i.quantity,amount:i.paid_price_cents*i.quantity}))];
    // Coupon discounts live on the order, while item prices precede coupons.
    // Allocate known discounts in whole cents so product totals reconcile.
    let unallocatedOrders=0;
    for(const order of orders) {
      const rows=products.filter(p=>p.orderId===order.id),base=rows.reduce((n,p)=>n+p.amount,0),discount=base-order.payable_amount_cents;
      if(discount<0||discount!==order.coupon_discount_cents){unallocatedOrders++;for(const row of rows){row.beforeCoupon=row.amount;row.couponDiscount=null;}continue;}
      const portions=rows.map((p,index)=>({index,amount:base?Math.floor(discount*p.amount/base):0,remainder:base?discount*p.amount%base:0}));
      const rank=[...portions].sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
      for(let left=discount-portions.reduce((n,p)=>n+p.amount,0),i=0;i<left;i++)rank[i].amount++;
      rows.forEach((p,index)=>{p.beforeCoupon=p.amount;p.couponDiscount=portions[index].amount;p.amount-=p.couponDiscount;});
    }
    totals.unallocatedOrderAmounts=unallocatedOrders;
    const byProduct=new Map();for(const p of products.filter(p=>paidIds.has(p.orderId))) {const key=p.id+':'+p.name;const current=byProduct.get(key)||{product_name:p.name,quantity:0,amount:0,unit:p.unit};current.quantity+=p.quantity;current.amount=current.amount==null||p.couponDiscount==null?null:current.amount+p.amount;byProduct.set(key,current);}
    const bills=[...new Set(orders.map(o=>o.session_id))].map(id=>{
      const s=db.prepare('SELECT * FROM table_sessions WHERE id=?').get(id);
      const all=db.prepare("SELECT * FROM orders WHERE session_id=? AND payment_status='paid'").all(id);
      const cumulativeRefund=db.prepare("SELECT COALESCE(SUM(r.amount_cents),0) AS value FROM refund_transactions r JOIN orders o ON o.id=r.order_id WHERE o.session_id=? AND r.status='success'").get(id).value;
      const same=paid.filter(o=>o.session_id===id),sameRefund=successfulRefunds.filter(r=>r.session_id===id);
      return {sessionId:id,billNo:s.bill_no||'B'+String(id).padStart(10,'0'),tableNo:s.table_no_snapshot,openedAt:s.opened_at,closedAt:s.closed_at,status:s.status,orders:all.length,todayOrders:same.length,todayRevenue:money(sum(same,'payable_amount_cents')-sum(same,'bonus_paid_cents')-sameRefund.reduce((n,r)=>n+r.stored_cents+r.wechat_cents+r.offline_cents+r.external_cents,0)),cumulativeNet:money(sum(all,'payable_amount_cents')-cumulativeRefund)};
    });
    const result={window,totals,paymentCosts,channels:Object.entries(channels).map(([channel,c])=>({channel,label:channelNames[channel]||'其他',received:money(c.received),refunded:money(c.refunded),net:money(c.received-c.refunded)})),orders,refunds,recharges,settlements,losses,inventory,products,bills,flows,byProduct:[...byProduct.values()].map(p=>({...p,amount:money(p.amount)})).sort((a,b)=>b.amount-a.amount),generatedAt:new Date().toISOString()};
    result.daily=reportDaily(result);return result;
  })();
}
export function reportDaily(report,settings=commerceSettings()) {
  const daily=[];let from=report.window.from;
  while(from<report.window.to) {
    const day=currentBusinessDate(settings,from),boundary=parseLocal(nextDate(day)+'T'+settings.openTime,settings.timezone),to=Math.min(boundary,report.window.to),window={from,to};
    const paid=report.orders.filter(o=>o.payment_status==='paid'&&inWindow(o.paid_at,window)),refunds=report.refunds.filter(r=>r.status==='success'&&inWindow(r.completed_at||r.created_at,window));
    const revenue=sum(paid,'payable_amount_cents')-sum(paid,'bonus_paid_cents')-refunds.reduce((n,r)=>n+r.stored_cents+r.wechat_cents+r.offline_cents+r.external_cents,0);
    const cost=refunds.some(r=>r.returned_cost_cents==null)?null:paid.reduce((n,o)=>n+(report.paymentCosts[o.id]||0),0)-sum(refunds,'returned_cost_cents');
    const lossCost=report.losses.filter(r=>inWindow(r.created_at,window)).reduce((n,r)=>n+r.cost_cents,0);
    daily.push({day,startAt:localDateTime(from,settings.timezone),endAt:localDateTime(to,settings.timezone),orders:paid.length,revenue:money(revenue),orderCost:money(cost),lossCost:money(lossCost),profit:cost==null?null:money(revenue-cost-lossCost),recharge:money(report.recharges.filter(r=>inWindow(r.created_at,window)).reduce((n,r)=>n+r.pay_cents,0)),offline:money(report.flows.filter(f=>f.type==='订单付款'&&['cash','merchant_qr','offline'].includes(f.channel)&&inWindow(f.time,window)).reduce((n,f)=>n+f.amount,0))});
    from=to;
  }
  return daily;
}
export async function reportWorkbook(report) {
  const workbook=new ExcelJS.Workbook();workbook.creator='门店管理后台';workbook.created=new Date(report.generatedAt);
  const {window,totals}=report,date=value=>{if(!value)return null;const time=formatTime(value,window.timezone);return time?new Date(time.replace(' ','T')+':00Z'):null;};
  const table=(name,columns,rows,note='')=>{
    const sheet=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:4,showGridLines:false}]});
    sheet.columns=columns.map(c=>({width:c.width||18}));
    sheet.getCell('A1').value=name;sheet.getRow(1).height=30;sheet.getCell('A1').font={name:'Arial',size:16,bold:true,color:{argb:'FF214D40'}};
    sheet.mergeCells(2,1,2,columns.length);sheet.getCell('A2').value=`${window.start.replace('T',' ')} 至 ${window.end.replace('T',' ')}（结束时刻不含） · ${window.timezone}`;sheet.getRow(2).height=26;
    sheet.mergeCells(3,1,3,columns.length);sheet.getCell('A3').value=note||'来源：门店订单与资金流水，按成功付款 / 退款完成时间统计。';sheet.getRow(3).height=32;sheet.getCell('A3').alignment={wrapText:true,vertical:'middle'};
    sheet.getRow(4).values=columns.map(c=>c.label);sheet.getRow(4).height=34;
    sheet.getRow(4).eachCell(cell=>{cell.font={name:'Arial',size:11,bold:true,color:{argb:'FF214D40'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE6EEE9'}};cell.alignment={wrapText:true,vertical:'middle',horizontal:'center'};});
    for(const row of rows){const added=sheet.addRow(row.map(v=>v===''?null:v));let height=30;added.eachCell({includeEmpty:true},(cell,index)=>{const col=columns[index-1];cell.font={name:'Arial',size:11};cell.alignment={vertical:'middle',wrapText:true,horizontal:col.type==='money'||col.type==='count'?'right':'left'};cell.numFmt=col.type==='money'?'#,##0.00;[Red]-#,##0.00':col.type==='count'?'#,##0':col.type==='date'?'yyyy-mm-dd hh:mm':'@';if(typeof cell.value==='string'){const width=[...cell.value].reduce((n,c)=>n+(/[^\x00-\x7f]/.test(c)?2:1),0);height=Math.max(height,Math.ceil(width/Math.max(8,(col.width||18)-2))*15+8);}if(added.number%2===1)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF6F8F6'}};});added.height=Math.min(409,height);}
    sheet.autoFilter={from:{row:4,column:1},to:{row:Math.max(4,sheet.rowCount),column:columns.length}};sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:4'};return sheet;
  };
  const cols=spec=>spec.map(([label,type='text',width])=>({label,type,width}));
  const summary=table('当日概览',cols([['项目','text',32],['数值','money',20],['说明','text',66]]),[
    ['已付款子订单数',totals.orders,'同一桌多次点单分别计数'],['消费桌次数',totals.tables,'本范围内有付款的桌台会话去重'],['商品原价',totals.gross,'成功付款订单原价'],['优惠金额',totals.discount,'会员优惠与优惠券优惠'],['赠金抵扣',totals.bonusUsed,'内部赠金，不计新收款'],['销售收入',totals.sales,'结算金额减赠金'],['退款销售额冲减',totals.refund,'成功退款，退款返还赠金另列'],['净销售额',totals.revenue,'本范围销售收入减本范围成功退款'],['订单商品成本',totals.orderCost,'付款日成本减退款完成日退库成本'],['赠送报损成本',totals.lossCost,'按发生日期'],['商品毛利估算',totals.profit,'净销售额减净商品成本和赠送报损；未扣房租、人工及未记录的平台费用'],['会员充值收款',totals.rechargeReceived,'不重复算为消费收入'],['团购实际结算 / 调整',totals.settlementReceived,'已录入到账时间的结算记录'],['外部净收款',totals.externalNetReceived,'外部付款、充值和团购到账减外部退款，不含余额与赠金内部扣减'],['未明确退库成本的历史退款',totals.missingRefundCost,'存在时成本与毛利留空'],['历史退款完成时间缺失',totals.legacyRefundTimes,'此类历史记录暂按创建时间，不能保证原完成日期'],['未记录到账时间的历史团购结算',totals.undatedSettlements,'未加入时间范围到账统计，需补录时间']
  ],'生成时间：'+formatTime(report.generatedAt,window.timezone)+'。金额单位：元。此文件是导出时的账务快照。');
  for(const row of summary.getRows(5,summary.rowCount-4))if(/数$|次数$|历史退款$|时间缺失$|历史团购结算$/.test(row.getCell(1).value))row.getCell(2).numFmt='#,##0';
  table('桌台账单',cols([['账单号','text',20],['桌号'],['开台时间','date',23],['结束时间','date',23],['状态'],['累计订单数','count'],['本范围订单数','count'],['本范围净销售额','money',24],['整桌累计净结算','money',24]]),report.bills.map(b=>[b.billNo,b.tableNo,date(b.openedAt),date(b.closedAt),b.status==='open'?'进行中':'已结束',b.orders,b.todayOrders,b.todayRevenue,b.cumulativeNet]),'整桌累计金额含本范围以外的消费，不能再次加入本范围收入。');
  table('订单明细',cols([['订单号','text',32],['账单号','text',20],['桌号'],['创建时间','date',23],['付款时间','date',23],['来源'],['付款人'],['付款人手机号','text',20],['付款人会员ID','text',20],['订单状态'],['支付状态'],['原价','money'],['优惠','money'],['结算金额','money'],['赠金','money'],['计入本范围销售'],['备注','text',40],['身份来源','text',24]]),report.orders.map(o=>[o.order_no,o.bill_no||'B'+String(o.session_id).padStart(10,'0'),o.table_no,date(o.created_at),date(o.paid_at),({miniapp:'小程序',pos:'收银',meituan:'美团',douyin:'抖音'})[o.source_channel]||o.source_channel,o.nickname,o.payer_phone||'未绑定手机号',String(o.payer_user_id),({pending_payment:'待付款',awaiting_delivery:'待配送',completed:'已完成',refunded:'已退款',cancelled:'已取消'})[o.status]||o.status,({paid:'已付款',pending:'待付款',closed:'已关闭'})[o.payment_status]||o.payment_status,money(o.original_amount_cents),money(o.discount_amount_cents),money(o.payable_amount_cents),money(o.bonus_paid_cents),o.payment_status==='paid'&&inWindow(o.paid_at,window)?'是':'否',o.note,o.payer_identity_captured_at?'付款时快照':'当前资料（历史未留存）']),'付款人按固定会员ID关联；新订单优先使用付款时昵称和手机号快照，历史订单缺少快照时使用当前档案。包含本范围创建 / 付款 / 退款订单；未付款或取消不计销售。');
  const orderMap=new Map(report.orders.map(o=>[o.id,o]));
  table('商品明细',cols([['订单号','text',32],['商品ID'],['商品 / 套餐','text',32],['类型'],['销售数量','count'],['单位'],['原价金额','money'],['会员后券前金额','money',22],['分摊优惠券','money'],['券后结算金额','money',22],['计入本范围销售']]),report.products.map(p=>{const o=orderMap.get(p.orderId);return [o.order_no,String(p.id),p.name,p.kind,p.quantity,p.unit,money(p.original),money(p.beforeCoupon),money(p.couponDiscount),p.couponDiscount==null?null:money(p.amount),o.payment_status==='paid'&&inWindow(o.paid_at,window)?'是':'否'];}),'套餐按套计价，整分钱分摊已知订单优惠券。异常历史金额不猜测，退款单独列在收付流水。');
  table('收付流水',cols([['时间','date',23],['业务类型','text',26],['渠道','text',22],['确认金额','money'],['未确认申请金额','money',22],['状态'],['外部收付'],['订单号','text',32],['账单号','text',20],['流水号','text',36],['时间依据','text',30]]),report.flows.map(f=>[date(f.time),f.type,channelNames[f.channel]||'其他',money(f.amount),money(f.requestedAmount),({pending:'待确认',processing:'处理中',success:'成功',failed:'失败'})[f.status||'success']||f.status,f.external?'是':'否',f.orderNo,f.billNo,f.number,f.legacyTime?'历史缺失完成时间，按创建时间':'业务确认时间']),'确认付款为正、确认退款为负。未确认金额留空。团购核销记账与实际到账分开，不重复加入外部收款。');
  table('基础货品流水',cols([['时间','date',23],['货品ID'],['货品','text',30],['单位'],['库存变动','count'],['变动后库存','count'],['业务渠道'],['原因','text',36],['订单号','text',32],['账单号','text',20],['桌号'],['操作人']]),report.inventory.map(i=>[date(i.created_at),String(i.product_id),i.name,i.unit_snapshot||'历史单位未留存',i.change_quantity,i.stock_after,({miniapp:'小程序',pos:'收银',meituan:'美团',douyin:'抖音',refund:'退款退库',adjustment:'库存调整',loss:'赠送报损',reward:'积分兑换'})[i.channel]||i.channel,i.reason,i.order_no||'',i.bill_no||'',i.table_no||'',i.operator||'']),'套餐展开为真实货品的库存流水。负数为出库，正数为入库 / 退库，单位不同不直接相加。');
  table('会员充值记录',cols([['充值号'],['时间','date',23],['会员'],['收款渠道','text',22],['实际收款','money'],['到账本金','money'],['到账赠金','money'],['备注','text',40]]),report.recharges.map(r=>[String(r.id),date(r.created_at),r.nickname,channelNames[r.payment_channel]||'未记录渠道',money(r.pay_cents),money(r.stored_cents),money(r.bonus_cents),r.remark]),'充值收款单列，后续余额消费不会再次记为外部收款。');
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
