import { db } from './db.js';
import { channelAmounts,refundAmounts,channelNames,ensureBillIdentity } from './bills.js';
import { commerceError,inWindow,utcTime,commerceSettings,localDateTime,currentBusinessDate,nextDate,parseLocal } from './business-time.js';
import { prepareReportViews } from './report-views.js';
export { reportWorkbook } from './report-workbook.js';
const money=n=>n==null?null:Number((n/100).toFixed(2));
const sqlDate=value=>new Date(value).toISOString();
const sum=(rows,key)=>rows.reduce((n,r)=>n+Number(r[key]||0),0);
export function businessReport(window) {
  return db.transaction(()=>{
    for(const session of db.prepare("SELECT id FROM table_sessions WHERE bill_no IS NULL OR table_no_snapshot='' OR store_name_snapshot=''").all())ensureBillIdentity(session.id);
    const bounds=[sqlDate(window.from),sqlDate(window.to)];
    const within=field=>`datetime(${field})>=datetime(?) AND datetime(${field})<datetime(?)`;
    const orders=db.prepare(`SELECT o.*,s.bill_no,s.table_no_snapshot AS table_no,s.opened_at,s.closed_at,s.status AS session_status,CASE WHEN o.payer_identity_captured_at IS NOT NULL THEN o.payer_name_snapshot ELSE u.nickname END AS nickname,CASE WHEN o.payer_identity_captured_at IS NOT NULL THEN o.payer_phone_snapshot ELSE u.phone END AS payer_phone FROM orders o JOIN table_sessions s ON s.id=o.session_id JOIN users u ON u.id=o.payer_user_id WHERE (${within('o.created_at')}) OR (o.payment_status='paid' AND ${within('o.paid_at')}) OR EXISTS(SELECT 1 FROM refund_transactions r WHERE r.order_id=o.id AND ${within('COALESCE(r.completed_at,r.created_at)')}) OR EXISTS(SELECT 1 FROM refund_requests q WHERE q.order_id=o.id AND q.status='pending' AND ${within('q.created_at')}) ORDER BY o.created_at,o.id LIMIT 10001`).all(...bounds,...bounds,...bounds,...bounds);
    if(orders.length>10000)throw commerceError('所选范围订单超过 10000 笔，请缩短时间范围',413);
    const orderMap=new Map(orders.map(o=>[o.id,o]));
    const refunds=db.prepare(`SELECT r.*,o.offline_channel,o.source_channel,o.order_no,o.session_id FROM refund_transactions r JOIN orders o ON o.id=r.order_id WHERE ${within('COALESCE(r.completed_at,r.created_at)')} ORDER BY COALESCE(r.completed_at,r.created_at),r.id`).all(...bounds);
    const successfulRefunds=refunds.filter(r=>r.status==='success');
    const requests=db.prepare(`SELECT q.* FROM refund_requests q WHERE q.status='pending' AND ${within('q.created_at')} AND NOT EXISTS(SELECT 1 FROM refund_transactions r WHERE r.request_id=q.id) ORDER BY q.created_at,q.id`).all(...bounds);
    const recharges=db.prepare(`SELECT w.*,u.nickname,u.phone FROM wallet_transactions w JOIN users u ON u.id=w.user_id WHERE w.type='recharge' AND ${within('w.created_at')} ORDER BY w.created_at,w.id`).all(...bounds);
    const settlements=db.prepare(`SELECT x.*,r.platform,s.bill_no,o.order_no FROM group_buy_settlements x JOIN group_buy_redemptions r ON r.id=x.redemption_id JOIN table_sessions s ON s.id=r.session_id LEFT JOIN orders o ON o.id=r.order_id WHERE ${within('x.settled_at')} ORDER BY x.settled_at,x.id`).all(...bounds);
    const redemptions=db.prepare(`SELECT r.id,r.platform,r.order_id,r.state,r.amount_cents,r.expected_settlement_cents,r.actual_settlement_cents,r.actual_settlement_at,r.snapshot_json,o.order_no,o.paid_at,s.bill_no,s.table_no_snapshot AS table_no,(SELECT SUM(x.amount_cents) FROM group_buy_settlements x WHERE x.redemption_id=r.id AND datetime(x.settled_at)<datetime(?)) AS registered_to_end_cents,(SELECT MAX(datetime(x.settled_at)) FROM group_buy_settlements x WHERE x.redemption_id=r.id AND datetime(x.settled_at)<datetime(?)) AS registered_at FROM group_buy_redemptions r JOIN table_sessions s ON s.id=r.session_id LEFT JOIN orders o ON o.id=r.order_id WHERE (o.payment_status='paid' AND ${within('o.paid_at')}) OR EXISTS(SELECT 1 FROM group_buy_settlements x WHERE x.redemption_id=r.id AND ${within('x.settled_at')}) ORDER BY o.paid_at,r.id LIMIT 10001`).all(bounds[1],bounds[1],...bounds,...bounds);
    if(redemptions.length>10000)throw commerceError('所选范围团购记录超过 10000 笔，请缩短时间范围',413);
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
    const groupCosts=new Map();for(const i of items)if(i.bundle_group_id)groupCosts.set(i.bundle_group_id,(groupCosts.get(i.bundle_group_id)||0)+i.quantity*i.cost_price_cents);
    const products=[...groups.map(g=>({orderId:g.order_id,id:g.product_id,name:g.name,kind:'套餐',quantity:g.quantity,unit:'套',original:g.original_cents,amount:g.paid_cents,cost:groupCosts.get(g.id)||0})),...items.filter(i=>!i.bundle_group_id).map(i=>({orderId:i.order_id,id:i.product_id,name:i.product_name,kind:'单品',quantity:i.quantity,unit:i.unit_snapshot||'件',original:i.original_price_cents*i.quantity,amount:i.paid_price_cents*i.quantity,cost:i.cost_price_cents*i.quantity}))];
    // Coupon discounts live on the order, while item prices precede coupons.
    // Allocate known discounts in whole cents so product totals reconcile.
    const productsByOrder=new Map();for(const p of products){if(!productsByOrder.has(p.orderId))productsByOrder.set(p.orderId,[]);productsByOrder.get(p.orderId).push(p);}
    let unallocatedOrders=0;
    for(const order of orders) {
      const rows=productsByOrder.get(order.id)||[],base=rows.reduce((n,p)=>n+p.amount,0),discount=base-order.payable_amount_cents;
      if(discount<0||discount!==order.coupon_discount_cents){unallocatedOrders++;for(const row of rows){row.beforeCoupon=row.amount;row.couponDiscount=null;}continue;}
      const portions=rows.map((p,index)=>({index,amount:base?Math.floor(discount*p.amount/base):0,remainder:base?discount*p.amount%base:0}));
      const rank=[...portions].sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
      for(let left=discount-portions.reduce((n,p)=>n+p.amount,0),i=0;i<left;i++)rank[i].amount++;
      rows.forEach((p,index)=>{p.beforeCoupon=p.amount;p.couponDiscount=portions[index].amount;p.amount-=p.couponDiscount;});
    }
    totals.unallocatedOrderAmounts=unallocatedOrders;
    const byProduct=new Map();for(const p of products.filter(p=>paidIds.has(p.orderId))) {const key=[p.id,p.name,p.kind,p.unit].join(':');const current=byProduct.get(key)||{product_name:p.name,quantity:0,amount:0,unit:p.unit};current.quantity+=p.quantity;current.amount=current.amount==null||p.couponDiscount==null?null:current.amount+p.amount;byProduct.set(key,current);}
    const bills=[...new Set(orders.map(o=>o.session_id))].map(id=>{
      const s=db.prepare('SELECT * FROM table_sessions WHERE id=?').get(id);
      const all=db.prepare("SELECT * FROM orders WHERE session_id=? AND payment_status='paid'").all(id);
      const cumulativeRefund=db.prepare("SELECT COALESCE(SUM(r.amount_cents),0) AS value FROM refund_transactions r JOIN orders o ON o.id=r.order_id WHERE o.session_id=? AND r.status='success'").get(id).value;
      const same=paid.filter(o=>o.session_id===id),sameRefund=successfulRefunds.filter(r=>r.session_id===id);
      return {sessionId:id,billNo:s.bill_no||'B'+String(id).padStart(10,'0'),tableNo:s.table_no_snapshot,openedAt:s.opened_at,closedAt:s.closed_at,status:s.status,orders:all.length,todayOrders:same.length,todayRevenue:money(sum(same,'payable_amount_cents')-sum(same,'bonus_paid_cents')-sameRefund.reduce((n,r)=>n+r.stored_cents+r.wechat_cents+r.offline_cents+r.external_cents,0)),cumulativeNet:money(sum(all,'payable_amount_cents')-cumulativeRefund)};
    });
    const result={window,totals,paymentCosts,channels:Object.entries(channels).map(([channel,c])=>({channel,label:channelNames[channel]||'其他',received:money(c.received),refunded:money(c.refunded),net:money(c.received-c.refunded)})),orders,refunds,requests,recharges,settlements,redemptions,items,losses,inventory,products,bills,flows,byProduct:[...byProduct.values()].map(p=>({...p,amount:money(p.amount)})).sort((a,b)=>b.amount-a.amount),generatedAt:new Date().toISOString()};
    result.daily=reportDaily(result);prepareReportViews(result);return result;
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
