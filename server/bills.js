import crypto from 'node:crypto';
import { db } from './db.js';
import { storeName } from './branding.js';
import { commerceError } from './business-time.js';
export const channelNames={wechat:'微信支付',stored:'储值本金',bonus:'赠金',cash:'现金',merchant_qr:'商家收款码',offline:'线下收款',meituan:'美团核销',douyin:'抖音核销',unknown:'未记录渠道'};
export const channelAmounts=o=>o.payment_status!=='paid'?[]:[['wechat',o.wechat_paid_cents],['stored',o.stored_paid_cents],['bonus',o.bonus_paid_cents],[o.offline_channel || 'offline',o.offline_paid_cents || (o.payment_method==='offline'?o.payable_amount_cents:0)],...(o.payment_method==='group_buy'?[[o.source_channel,o.payable_amount_cents]]:[])].filter(([,amount])=>amount>0);
export const refundAmounts=(r,o)=>[['wechat',r.wechat_cents],['stored',r.stored_cents],['bonus',r.bonus_cents],[o.offline_channel || 'offline',r.offline_cents],...(r.external_cents?[[o.source_channel,r.external_cents]]:[])].filter(([,amount])=>amount>0);
export function ensureBillIdentity(sessionId) {
  db.prepare("UPDATE table_sessions SET bill_no=COALESCE(bill_no,'B'||printf('%010d',id)),table_no_snapshot=CASE WHEN table_no_snapshot='' THEN (SELECT table_no FROM tables WHERE id=table_id) ELSE table_no_snapshot END,store_name_snapshot=CASE WHEN store_name_snapshot='' THEN (SELECT name FROM stores WHERE id=store_id) ELSE store_name_snapshot END WHERE id=?").run(sessionId);
}
export function receiptOrder(order) {
  const groups=db.prepare('SELECT * FROM order_bundle_groups WHERE order_id=? ORDER BY id').all(order.id);
  const items=db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(order.id);
  const lines=[...groups.map(g=>({name:g.name,quantity:g.quantity,unit:'套',amount:g.paid_cents,original:g.original_cents,components:JSON.parse(g.components_json).map(p=>({name:p.name,quantity:p.component_quantity*g.quantity,unit:p.unit}))})),...items.filter(i=>!i.bundle_group_id).map(i=>({name:i.product_name,quantity:i.quantity,unit:i.unit_snapshot||'件',amount:i.quantity*i.paid_price_cents,original:i.quantity*i.original_price_cents,components:[]}))];
  const refunds=db.prepare("SELECT * FROM refund_transactions WHERE order_id=? AND status='success' ORDER BY id").all(order.id);
  return {id:order.id,orderNo:order.order_no,createdAt:order.created_at,paidAt:order.paid_at,status:order.status,paymentStatus:order.payment_status,source:order.source_channel,note:order.note,
    original:order.original_amount_cents,memberDiscount:Math.max(0,order.discount_amount_cents-order.coupon_discount_cents),couponDiscount:order.coupon_discount_cents,payable:order.payable_amount_cents,
    lines,channels:channelAmounts(order).map(([channel,amount])=>({channel,label:channelNames[channel]||'其他',amount})),refunds:refunds.map(r=>({id:r.id,number:r.out_refund_no,amount:r.amount_cents,completedAt:r.completed_at||r.created_at,reason:r.reason,channels:refundAmounts(r,order).map(([channel,amount])=>({channel,label:channelNames[channel]||'其他',amount}))}))};
}
export function billData(sessionId,{orderId}={}) {
  ensureBillIdentity(sessionId);
  const session=db.prepare('SELECT * FROM table_sessions WHERE id=?').get(sessionId);
  if(!session)throw commerceError('桌台账单不存在',404);
  const rows=db.prepare(`SELECT * FROM orders WHERE session_id=?${orderId?' AND id=?':''} ORDER BY created_at,id`).all(...[sessionId,...(orderId?[orderId]:[])]);
  if(orderId&&!rows.length)throw commerceError('订单不存在',404);
  const orders=rows.map(receiptOrder),paid=orders.filter(o=>o.paymentStatus==='paid');
  const sum=key=>paid.reduce((n,o)=>n+o[key],0),refund=paid.reduce((n,o)=>n+o.refunds.reduce((a,r)=>a+r.amount,0),0);
  const channels={};for(const o of paid)for(const c of o.channels)channels[c.channel]=(channels[c.channel]||0)+c.amount;
  const data={scope:orderId?'order':'bill',targetId:orderId||session.id,billNo:session.bill_no,tableNo:session.table_no_snapshot,storeName:session.status==='closed'?session.store_name_snapshot:storeName(session.store_id),sessionId:session.id,sessionStatus:session.status,openedAt:session.opened_at,closedAt:session.closed_at,
    orders,totals:{orders:orders.length,paidOrders:paid.length,pendingOrders:orders.filter(o=>o.paymentStatus==='pending').length,original:sum('original'),memberDiscount:sum('memberDiscount'),couponDiscount:sum('couponDiscount'),paid:sum('payable'),refund,net:sum('payable')-refund,channels}};
  // Delivery progress doesn't change a financial receipt. Keep it out of the
  // print revision so marking goods delivered cannot silently allow a duplicate.
  data.revision=crypto.createHash('sha256').update(JSON.stringify({...data,orders:orders.map(({status,...order})=>order)})).digest('hex');
  return data;
}
export function orderReceipt(orderId){const order=db.prepare('SELECT session_id FROM orders WHERE id=?').get(orderId);if(!order)throw commerceError('订单不存在',404);return billData(order.session_id,{orderId});}
export function captureFinalBill(sessionId) {
  const data=billData(sessionId);
  db.prepare('INSERT OR IGNORE INTO bill_snapshots(session_id,snapshot_json,revision) VALUES(?,?,?)').run(sessionId,JSON.stringify(data),data.revision);
  return data;
}
