import { db } from './db.js';
import { captureFinalBill } from './bills.js';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
export function workdeskTables() {
  const tables=db.prepare(`SELECT t.id,t.table_no AS tableNo,s.id AS sessionId,
    (SELECT COUNT(*) FROM orders WHERE session_id=s.id AND payment_status='pending') AS pendingPayments,
    (SELECT COUNT(*) FROM orders WHERE session_id=s.id AND payment_status='paid' AND status='awaiting_delivery') AS pendingOrders,
    (SELECT COUNT(*) FROM fulfillment_batches b JOIN orders o ON o.id=b.order_id WHERE o.session_id=s.id AND b.status IN ('ready','delivering')) AS pendingBatches,
    (SELECT COUNT(*) FROM service_requests WHERE session_id=s.id AND status!='completed') AS pendingServices,
    (SELECT COUNT(*) FROM group_buy_redemptions WHERE session_id=s.id AND state IN ('verifying','unknown','verified')) AS pendingRedemptions,
    (SELECT COUNT(*) FROM refund_transactions r JOIN orders o ON o.id=r.order_id WHERE o.session_id=s.id AND r.status IN ('pending','processing')) +
    (SELECT COUNT(*) FROM refund_requests r JOIN orders o ON o.id=r.order_id WHERE o.session_id=s.id AND r.status='pending') AS pendingRefunds,
    (SELECT COALESCE(SUM(quantity),0) FROM cart_items WHERE session_id=s.id AND status='pending') AS cartQuantity
    FROM tables t LEFT JOIN table_sessions s ON s.id=(SELECT id FROM table_sessions WHERE table_id=t.id AND status='open' ORDER BY id DESC LIMIT 1)
    WHERE t.status!='disabled'`).all();
  for(const table of tables){
    table.occupied=!!table.sessionId;
    table.blockers=[['pendingPayments','待支付订单'],['pendingOrders','待送达订单'],['pendingBatches','待取或在途配送'],['pendingServices','未完成服务'],['pendingRedemptions','核销待确认'],['pendingRefunds','退款待处理']].filter(([field])=>table[field]>0).map(([field,label])=>`${label} ${table[field]} 项`);
    table.canClose=table.occupied&&!table.blockers.length;
  }
  return tables.sort((a,b)=>a.tableNo.localeCompare(b.tableNo,'zh-CN',{numeric:true}));
}
export function closeWorkdeskTable(req,audit) {
  return db.transaction(()=>{
    const tableId=Number(req.params.id),{sessionId,requestId,confirmedDeparture}=req.body || {};
    if(!Number.isSafeInteger(tableId)||!Number.isSafeInteger(sessionId)||confirmedDeparture!==true||!/^[a-f0-9-]{36}$/i.test(String(requestId||'')))fail('请刷新桌台并确认顾客已离店、清台完成',400);
    const prior=db.prepare('SELECT * FROM table_close_commands WHERE request_id=?').get(requestId);
    if(prior){if(prior.table_id!==tableId||prior.session_id!==sessionId||prior.operator_id!==req.staff.id)fail('请求标识已使用');return{ok:true,repeated:true};}
    const table=workdeskTables().find(row=>row.id===tableId);
    if(!table)fail('桌台不存在或已停用',404);
    if(table.sessionId!==sessionId)fail('本桌已结束或已重新开台，请刷新后核对，不能结束另一批顾客的桌台');
    if(!table.canClose)fail(`暂不能清台：${table.blockers.join('；')}。请先处理或联系收银核对。`);
    db.prepare("UPDATE table_sessions SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(sessionId);
    captureFinalBill(sessionId);
    db.prepare('INSERT INTO table_close_commands(request_id,table_id,session_id,operator_id) VALUES(?,?,?,?)').run(requestId,tableId,sessionId,req.staff.id);
    db.prepare("INSERT INTO work_events(kind,entity_id) VALUES('table_closed',?)").run(sessionId);
    audit(req,'服务员清台并结束桌台',`${table.tableNo} 桌，会话 ${sessionId}，未下单商品 ${table.cartQuantity} 件`);
    return {ok:true};
  })();
}
