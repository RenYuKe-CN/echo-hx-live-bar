import crypto from 'node:crypto';
import { db } from './db.js';
import { parseRefundItems } from './refund-stock.js';
import { storeName } from './branding.js';

export const serviceTypes = { help: '呼叫服务员', tissue: '需要纸巾', cleanup: '收拾桌面', remind: '催单', other: '其他帮助' };
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const manager = staff => ['super', 'manager'].includes(staff.role);
const hash = input => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
const requestKey = value => { if (!/^[a-f0-9-]{36}$/i.test(String(value || ''))) fail('请求标识无效，请刷新后重试', 400); return value; };
const revision = (value, expected) => { if (!Number.isSafeInteger(value) || value !== expected) fail('任务有更新，请核对最新内容后再操作'); };
const operatorName = id => id ? db.prepare('SELECT display_name FROM staff_accounts WHERE id=?').get(id)?.display_name || '已停用员工' : '';
export function workEvent(kind, entityId) { db.prepare('INSERT OR IGNORE INTO work_events(kind,entity_id) VALUES(?,?)').run(kind, entityId); }
export function hasDeliveryInProgress(orderId) { return !!db.prepare("SELECT 1 FROM fulfillment_batches WHERE order_id=? AND status='delivering'").get(orderId); }
export function refundHold(orderId) {
  return !!db.prepare("SELECT 1 FROM refund_requests WHERE order_id=? AND status='pending' UNION ALL SELECT 1 FROM refund_transactions WHERE order_id=? AND status IN ('pending','processing') LIMIT 1").get(orderId, orderId);
}
function activeOrder(id, ignorePause = false) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!order) fail('订单不存在', 404);
  if (order.payment_status !== 'paid' || order.status !== 'awaiting_delivery') fail('只有已支付、尚未完成的订单可以处理');
  if (refundHold(id)) fail('订单正在处理退款，请先核实退款再继续配货或配送');
  if (!ignorePause && order.fulfillment_pause_reason) fail('订单已暂停，请管理员核实后恢复');
  return order;
}
function staffTarget(id) {
  const staff = db.prepare("SELECT * FROM staff_accounts WHERE id=? AND status='active'").get(id);
  if (!staff || (staff.role !== 'super' && !JSON.parse(staff.permissions).includes('workdesk'))) fail('目标员工没有服务工作台权限', 400);
  return staff;
}
export function fulfillmentLines(orderId) {
  return db.prepare(`SELECT oi.*,
    COALESCE((SELECT SUM(bi.quantity) FROM fulfillment_batch_items bi JOIN fulfillment_batches b ON b.id=bi.batch_id WHERE bi.order_item_id=oi.id AND b.status='ready'),0) AS ready_quantity,
    COALESCE((SELECT SUM(bi.quantity) FROM fulfillment_batch_items bi JOIN fulfillment_batches b ON b.id=bi.batch_id WHERE bi.order_item_id=oi.id AND b.status='delivering'),0) AS delivering_quantity
    FROM order_items oi WHERE oi.order_id=? ORDER BY oi.id`).all(orderId).map(row => ({
      id: row.id, name: row.product_name, quantity: row.quantity, returnedQuantity: row.returned_quantity,
      deliveredQuantity: row.delivered_quantity, readyQuantity: row.ready_quantity, deliveringQuantity: row.delivering_quantity,
      unpreparedQuantity: Math.max(0, row.quantity - row.returned_quantity - row.delivered_quantity - row.ready_quantity - row.delivering_quantity)
    }));
}
function batchView(batch) {
  return { id: batch.id, orderId: batch.order_id, number: `配送-${String(batch.id).padStart(5, '0')}`, status: batch.status,
    preparationStaffId: batch.preparation_staff_id, preparationStaff: operatorName(batch.preparation_staff_id),
    deliveryStaffId: batch.delivery_staff_id, deliveryStaff: operatorName(batch.delivery_staff_id),
    createdAt: batch.created_at, claimedAt: batch.claimed_at, deliveredAt: batch.delivered_at,
    items: db.prepare('SELECT bi.order_item_id AS id,oi.product_name AS name,bi.quantity FROM fulfillment_batch_items bi JOIN order_items oi ON oi.id=bi.order_item_id WHERE batch_id=? ORDER BY oi.id').all(batch.id) };
}
export function workOrderView(order) {
  const table = db.prepare('SELECT t.table_no FROM table_sessions s JOIN tables t ON t.id=s.table_id WHERE s.id=?').get(order.session_id);
  const items = fulfillmentLines(order.id);
  const batches = db.prepare("SELECT * FROM fulfillment_batches WHERE order_id=? AND status!='cancelled' ORDER BY id").all(order.id).map(batchView);
  const state = order.status === 'completed' ? 'completed' : order.status === 'refunded' ? 'refunded' : !order.preparation_staff_id ? 'waiting' : items.some(item => item.unpreparedQuantity) ? 'preparing' : batches.some(batch => batch.status === 'ready') ? 'ready' : 'delivering';
  return { id: order.id, orderNo: order.order_no, tableNo: table?.table_no || '', sessionId: order.session_id, note: order.note,
    paidAt: order.paid_at, preparationStaffId: order.preparation_staff_id, preparationStaff: operatorName(order.preparation_staff_id),
    preparationStartedAt: order.preparation_started_at, revision: order.fulfillment_revision, state, paused: !['completed','refunded'].includes(order.status) && (refundHold(order.id) || !!order.fulfillment_pause_reason), pausedReason: order.fulfillment_pause_reason || '退款处理中', items, batches };
}
function serviceView(request) {
  const table = db.prepare('SELECT t.table_no FROM table_sessions s JOIN tables t ON t.id=s.table_id WHERE s.id=?').get(request.session_id);
  return { id: request.id, number: `服务-${String(request.id).padStart(5,'0')}`, sessionId: request.session_id, tableNo: table?.table_no || '',
    type: request.type, title: serviceTypes[request.type] || '服务需求', status: request.status, revision: request.revision, callCount: request.call_count,
    assignedStaffId: request.assigned_staff_id, assignedStaff: operatorName(request.assigned_staff_id), createdAt: request.created_at,
    claimedAt: request.claimed_at, completedAt: request.completed_at, completionNote: request.completion_note,
    notes: db.prepare('SELECT id,content,created_at AS createdAt FROM service_request_notes WHERE request_id=? ORDER BY id').all(request.id) };
}
function selectedLines(orderId, input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) fail('请选择本批配齐的商品和数量', 400);
  const lines = fulfillmentLines(orderId), seen = new Set();
  return input.map(item => {
    if (!Number.isSafeInteger(item?.orderItemId) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || seen.has(item.orderItemId)) fail('配货数量无效或商品重复', 400);
    seen.add(item.orderItemId);
    const line = lines.find(row => row.id === item.orderItemId);
    if (!line || item.quantity > line.unpreparedQuantity) fail('商品已配货、退款或数量有变化，请刷新核对');
    return { orderItemId: line.id, quantity: item.quantity };
  });
}
export function cancelReadyBatchesForRefund(orderId, items, full) {
  const selected = new Set(parseRefundItems(items).map(item => item.orderItemId));
  const batches = db.prepare("SELECT * FROM fulfillment_batches WHERE order_id=? AND status='ready'").all(orderId);
  for (const batch of batches) {
    if (full || db.prepare('SELECT order_item_id FROM fulfillment_batch_items WHERE batch_id=?').all(batch.id).some(item => selected.has(item.order_item_id))) {
      db.prepare("UPDATE fulfillment_batches SET status='cancelled' WHERE id=?").run(batch.id);
    }
  }
  db.prepare('UPDATE orders SET fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(orderId);
  workEvent('order_changed', orderId);
}

export function registerWorkdeskRoutes(router, { currentUserId, audit, completedOrder }) {
  const route = (method, url, handler) => router[method](url, (req, res) => {
    try { const result = handler(req); res.json(result); }
    catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : '任务处理失败，请刷新后重试' }); if (!error.status) console.error(error); }
  });
  route('get', '/sessions/:sessionId/services', req => ({ types: serviceTypes,
    requests: db.prepare("SELECT * FROM service_requests WHERE session_id=? ORDER BY (status='completed'),id DESC LIMIT 50").all(req.params.sessionId).map(serviceView) }));
  route('post', '/sessions/:sessionId/services', req => db.transaction(() => {
    const userId = currentUserId(req), sessionId = Number(req.params.sessionId), { type, note = '' } = req.body || {};
    if (!db.prepare("SELECT 1 FROM table_sessions s JOIN session_members m ON m.session_id=s.id JOIN tables t ON t.id=s.table_id WHERE s.id=? AND s.status='open' AND t.status!='disabled' AND m.user_id=?").get(sessionId,userId)) fail('桌台已结束或尚未加入，请重新扫码',409);
    const key = requestKey(req.body?.requestId);
    if (!Object.hasOwn(serviceTypes, type) || typeof note !== 'string' || note.trim().length > 300 || (type === 'other' && !note.trim())) fail('请选择服务类型，其他帮助需填写需求；备注最多300字', 400);
    const content = note.trim(), fingerprint = hash([sessionId, userId, type, content]);
    const prior = db.prepare('SELECT * FROM service_submit_commands WHERE idempotency_key=?').get(key);
    if (prior) { if (prior.user_id !== userId || prior.request_hash !== fingerprint) fail('请求标识已使用，请重新提交'); return { request: serviceView(db.prepare('SELECT * FROM service_requests WHERE id=?').get(prior.request_id)), repeated: true }; }
    let request = db.prepare("SELECT * FROM service_requests WHERE session_id=? AND type=? AND status IN ('waiting','claimed')").get(sessionId, type);
    const merged = !!request;
    if (!request) {
      const id = db.prepare('INSERT INTO service_requests(session_id,created_by,type) VALUES(?,?,?)').run(sessionId, userId, type).lastInsertRowid;
      request = db.prepare('SELECT * FROM service_requests WHERE id=?').get(id); workEvent('service_new', Number(id));
    }
    if (content) db.prepare('INSERT INTO service_request_notes(request_id,user_id,content) VALUES(?,?,?)').run(request.id, userId, content);
    if (merged) { db.prepare('UPDATE service_requests SET revision=revision+1,call_count=call_count+1 WHERE id=?').run(request.id); workEvent('service_note',request.id); }
    db.prepare('INSERT INTO service_submit_commands(idempotency_key,user_id,request_hash,request_id) VALUES(?,?,?,?)').run(key, userId, fingerprint, request.id);
    return { request: serviceView(db.prepare('SELECT * FROM service_requests WHERE id=?').get(request.id)), merged };
  })());
  route('get', '/admin/workdesk', req => db.transaction(() => {
    const after = Math.max(0, Number.parseInt(req.query.after || '0', 10) || 0);
    const latest = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM work_events').get().id;
    const events = db.prepare('SELECT * FROM work_events WHERE id>? AND id<=? ORDER BY id LIMIT 200').all(after, latest);
    const orders = db.prepare("SELECT * FROM orders WHERE payment_status='paid' AND status='awaiting_delivery' ORDER BY paid_at,id").all().map(workOrderView);
    const requests = db.prepare("SELECT * FROM service_requests WHERE status!='completed' OR completed_at>=datetime('now','-1 day') ORDER BY (status='completed'),created_at,id").all().map(serviceView);
    return { storeName: storeName(), orders, requests, events, cursor: events.length === 200 ? events.at(-1).id : latest, serverTime: new Date().toISOString(),
      completedOrders: db.prepare("SELECT * FROM orders WHERE payment_status='paid' AND status='completed' AND delivered_at>=datetime('now','-1 day') ORDER BY delivered_at DESC LIMIT 50").all().map(workOrderView),
      settings: db.prepare('SELECT * FROM operations_settings WHERE id=1').get(),
      operators: manager(req.staff) ? db.prepare("SELECT id,display_name AS name FROM staff_accounts WHERE status='active' AND (role='super' OR EXISTS(SELECT 1 FROM json_each(permissions) WHERE value='workdesk')) ORDER BY id").all() : [] };
  })());
  route('patch', '/admin/workdesk/settings', req => {
    if (!manager(req.staff)) fail('仅管理员可设置提醒时限', 403);
    const fields = ['service_minutes','preparation_minutes','delivery_minutes'];
    if (fields.some(key => !Number.isSafeInteger(req.body?.[key]) || req.body[key] < 1 || req.body[key] > 120)) fail('提醒时限须为1至120分钟', 400);
    db.prepare('UPDATE operations_settings SET service_minutes=?,preparation_minutes=?,delivery_minutes=? WHERE id=1').run(...fields.map(key => req.body[key])); audit(req, '设置服务提醒时限');
    return { ok: true };
  });
  route('post', '/admin/workdesk/orders/:id/claim', req => db.transaction(() => {
    const order = activeOrder(req.params.id);
    if (order.preparation_staff_id === req.staff.id) return { order: workOrderView(order) };
    revision(req.body?.revision, order.fulfillment_revision);
    if (order.preparation_staff_id) fail(`订单已由${operatorName(order.preparation_staff_id)}接单配货`);
    db.prepare('UPDATE orders SET preparation_staff_id=?,preparation_started_at=CURRENT_TIMESTAMP,fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(req.staff.id, order.id);
    audit(req, '接单配货', order.order_no); workEvent('order_changed', order.id);
    return { order: workOrderView(db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)) };
  })());
  route('post', '/admin/workdesk/orders/:id/batches', req => db.transaction(() => {
    const key = requestKey(req.body?.requestId);
    const fingerprint = hash([Number(req.params.id), req.staff.id, req.body?.items, !!req.body?.startDelivery]);
    const prior = db.prepare('SELECT * FROM fulfillment_batches WHERE request_id=?').get(key);
    if (prior) { if (prior.request_hash !== fingerprint) fail('配送请求标识已使用'); return { batch: batchView(prior), repeated: true }; }
    const order = activeOrder(req.params.id);
    if (order.preparation_staff_id !== req.staff.id) fail('只有当前配货负责人可以提交配货', 403);
    if (!Number.isSafeInteger(req.body?.revision) || req.body.revision < 0 || req.body.revision > order.fulfillment_revision) fail('任务版本无效，请刷新核对');
    const items = selectedLines(order.id, req.body?.items);
    if (req.body?.startDelivery !== undefined && typeof req.body.startDelivery !== 'boolean') fail('配送模式无效',400);
    const start = req.body?.startDelivery === true;
    const id = db.prepare('INSERT INTO fulfillment_batches(order_id,preparation_staff_id,delivery_staff_id,status,request_id,request_hash,claimed_at) VALUES(?,?,?,?,?,?,?)')
      .run(order.id, req.staff.id, start ? req.staff.id : null, start ? 'delivering' : 'ready', key, fingerprint, start ? new Date().toISOString() : null).lastInsertRowid;
    for (const item of items) db.prepare('INSERT INTO fulfillment_batch_items(batch_id,order_item_id,quantity) VALUES(?,?,?)').run(id, item.orderItemId, item.quantity);
    db.prepare('UPDATE orders SET fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(order.id);
    audit(req, start ? '配齐并领取配送' : '配齐待取', `${order.order_no} 配送-${id}`); workEvent('order_changed', order.id); if (!start) workEvent('batch_ready', Number(id));
    return { batch: batchView(db.prepare('SELECT * FROM fulfillment_batches WHERE id=?').get(id)) };
  })());
  route('post', '/admin/workdesk/batches/:id/claim', req => db.transaction(() => {
    const batch = db.prepare('SELECT * FROM fulfillment_batches WHERE id=?').get(req.params.id);
    if (!batch) fail('配送单不存在',404);
    if (batch.status === 'delivering' && batch.delivery_staff_id === req.staff.id) return { batch: batchView(batch) };
    activeOrder(batch.order_id);
    if (batch.status !== 'ready') fail(`这批商品已由${operatorName(batch.delivery_staff_id) || '其他员工'}领取或已处理`);
    db.prepare("UPDATE fulfillment_batches SET status='delivering',delivery_staff_id=?,claimed_at=CURRENT_TIMESTAMP WHERE id=? AND status='ready'").run(req.staff.id,batch.id);
    db.prepare('UPDATE orders SET fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(batch.order_id);
    audit(req,'领取配送',`配送-${batch.id}`); workEvent('order_changed',batch.order_id);
    return { batch: batchView(db.prepare('SELECT * FROM fulfillment_batches WHERE id=?').get(batch.id)) };
  })());
  route('post', '/admin/workdesk/batches/:id/complete', req => {
    const result = db.transaction(() => {
      const batch = db.prepare('SELECT * FROM fulfillment_batches WHERE id=?').get(req.params.id);
      if (!batch) fail('配送单不存在',404);
      if (batch.delivery_staff_id !== req.staff.id) fail('只有当前配送负责人可以确认送达',403);
      if (batch.status === 'delivered') return { batch: batchView(batch) };
      if (batch.status !== 'delivering') fail('这批商品尚未领取配送');
      const order = activeOrder(batch.order_id, true);
      const items = db.prepare('SELECT * FROM fulfillment_batch_items WHERE batch_id=?').all(batch.id);
      for (const item of items) {
        if (!db.prepare('UPDATE order_items SET delivered_quantity=delivered_quantity+? WHERE id=? AND quantity-returned_quantity-delivered_quantity>=?').run(item.quantity,item.order_item_id,item.quantity).changes) fail('商品数量发生变化，请管理员核对');
      }
      db.prepare("UPDATE fulfillment_batches SET status='delivered',delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(batch.id);
      db.prepare('UPDATE orders SET fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(order.id);
      const remaining = db.prepare('SELECT COALESCE(SUM(quantity-returned_quantity-delivered_quantity),0) AS quantity FROM order_items WHERE order_id=?').get(order.id).quantity;
      if (!remaining) db.prepare("UPDATE orders SET status='completed',delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(order.id);
      audit(req,'确认配送送达',`配送-${batch.id} ${order.order_no}`); workEvent('order_changed',order.id);
      return { batch: batchView(db.prepare('SELECT * FROM fulfillment_batches WHERE id=?').get(batch.id)), completed: !remaining, orderId: order.id };
    })();
    if (result.completed) { try { completedOrder(result.orderId); } catch (error) { console.error('送达消息发送失败',error); } }
    return result;
  });
  route('post', '/admin/workdesk/requests/:id/claim', req => db.transaction(() => {
    const request = db.prepare('SELECT * FROM service_requests WHERE id=?').get(req.params.id);
    if (!request) fail('服务请求不存在',404);
    if (request.status === 'claimed' && request.assigned_staff_id === req.staff.id) return { request: serviceView(request) };
    revision(req.body?.revision,request.revision);
    if (request.status !== 'waiting') fail(`需求已由${operatorName(request.assigned_staff_id)}领取或已经处理`);
    db.prepare("UPDATE service_requests SET status='claimed',assigned_staff_id=?,claimed_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?").run(req.staff.id,request.id);
    audit(req,'领取顾客需求',`服务-${request.id}`); workEvent('service_changed',request.id);
    return { request: serviceView(db.prepare('SELECT * FROM service_requests WHERE id=?').get(request.id)) };
  })());
  route('post', '/admin/workdesk/batches/:id/recall', req => db.transaction(() => {
    if (!manager(req.staff)) fail('仅管理员可以核实归还并取消配送批次',403);
    const batch=db.prepare('SELECT * FROM fulfillment_batches WHERE id=?').get(req.params.id);
    if (!batch || !['ready','delivering'].includes(batch.status)) fail('批次已送达或已取消，不能召回');
    const order=activeOrder(batch.order_id,true), reason=req.body?.reason;
    revision(req.body?.revision,order.fulfillment_revision);
    if(typeof reason!=='string'||!reason.trim()||reason.trim().length>300)fail('请填写实物核实与归还说明',400);
    db.prepare("UPDATE fulfillment_batches SET status='cancelled' WHERE id=?").run(batch.id);
    db.prepare('UPDATE orders SET fulfillment_pause_reason=?,fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(`已召回配送-${batch.id}，待管理员核实：${reason.trim()}`,order.id);
    audit(req,'核实归还并召回配送',`配送-${batch.id} 原配送员 ${operatorName(batch.delivery_staff_id)}：${reason.trim()}`);workEvent('order_changed',order.id);
    return{ok:true};
  })());
  route('post', '/admin/workdesk/orders/:id/resume', req => db.transaction(() => {
    if(!manager(req.staff))fail('仅管理员可以解除核实暂停',403);
    const order=activeOrder(req.params.id,true),reason=req.body?.reason;
    revision(req.body?.revision,order.fulfillment_revision);
    if(typeof reason!=='string'||!reason.trim()||reason.trim().length>300)fail('请填写恢复原因',400);
    db.prepare("UPDATE orders SET fulfillment_pause_reason='',fulfillment_revision=fulfillment_revision+1 WHERE id=?").run(order.id);
    audit(req,'恢复订单配货',`${order.order_no}：${reason.trim()}`);workEvent('order_changed',order.id);return{ok:true};
  })());
  route('post', '/admin/workdesk/requests/:id/complete', req => db.transaction(() => {
    const request = db.prepare('SELECT * FROM service_requests WHERE id=?').get(req.params.id);
    if (!request) fail('服务请求不存在',404);
    if (request.assigned_staff_id !== req.staff.id) fail('只有领取需求的服务员可以完成',403);
    if (request.status === 'completed') return { request: serviceView(request) };
    revision(req.body?.revision,request.revision);
    if (request.status !== 'claimed') fail('请先领取服务请求');
    const note = req.body?.note || '';
    if (typeof note !== 'string' || note.trim().length>300) fail('处理说明最多300字',400);
    db.prepare("UPDATE service_requests SET status='completed',completed_at=CURRENT_TIMESTAMP,completion_note=?,revision=revision+1 WHERE id=?").run(note.trim(),request.id);
    audit(req,'完成顾客需求',`服务-${request.id} ${note.trim()}`); workEvent('service_changed',request.id);
    return { request: serviceView(db.prepare('SELECT * FROM service_requests WHERE id=?').get(request.id)) };
  })());
  route('post', '/admin/workdesk/transfer', req => db.transaction(() => {
    if (!manager(req.staff)) fail('仅管理员可以转交任务',403);
    const { kind,id,targetId,reason,revision: supplied } = req.body || {};
    if (!Number.isSafeInteger(targetId) || typeof reason !== 'string' || !reason.trim() || reason.trim().length>300) fail('请选择员工并填写转交原因',400);
    staffTarget(targetId);
    if (kind === 'service') {
      const request = db.prepare('SELECT * FROM service_requests WHERE id=?').get(id);
      if (!request || request.status==='completed') fail('需求不存在或已经完成');
      revision(supplied,request.revision);
      db.prepare("UPDATE service_requests SET status='claimed',assigned_staff_id=?,claimed_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?").run(targetId,id); workEvent('service_transfer',id);
    } else if (kind === 'preparation') {
      const order=activeOrder(id,true); revision(supplied,order.fulfillment_revision);
      db.prepare('UPDATE orders SET preparation_staff_id=?,preparation_started_at=CURRENT_TIMESTAMP,fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(targetId,id); workEvent('preparation_transfer',id);
    } else if (kind === 'delivery') {
      const batch=db.prepare('SELECT * FROM fulfillment_batches WHERE id=?').get(id);
      if (!batch || batch.status!=='delivering') fail('只有正在配送的批次可以转交');
      const order=activeOrder(batch.order_id,true); revision(supplied,order.fulfillment_revision);
      db.prepare('UPDATE fulfillment_batches SET delivery_staff_id=?,claimed_at=CURRENT_TIMESTAMP WHERE id=?').run(targetId,id);
      db.prepare('UPDATE orders SET fulfillment_revision=fulfillment_revision+1 WHERE id=?').run(order.id); workEvent('delivery_transfer',id);
    } else fail('任务类型无效',400);
    audit(req,'转交工作任务',`${kind} ${id} -> ${operatorName(targetId)}：${reason.trim()}`); return {ok:true};
  })());
}
