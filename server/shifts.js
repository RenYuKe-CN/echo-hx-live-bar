import { db } from './db.js';
import { formatTime } from './business-time.js';
import { channelAmounts, refundAmounts } from './bills.js';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const money = value => {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value ?? ''))) fail('请输入有效金额，最多两位小数', 400);
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100000000) fail('金额超出范围', 400);
  return cents;
};
const key = value => { if (!/^[a-f0-9-]{36}$/i.test(String(value || ''))) fail('请求标识无效', 400); return value; };
export const activeShift = () => db.prepare("SELECT * FROM cash_shifts WHERE status!='closed'").get();
export function assertCashPosting(staff) {
  if (!db.prepare('SELECT enabled FROM shift_settings WHERE id=1').get().enabled) return;
  const shift = activeShift();
  if (!shift || shift.status !== 'open') fail('请先开班；交班盘点期间暂停现金收款和现金退款');
  if (staff && staff.id !== shift.opened_by && !['super','manager'].includes(staff.role)) fail('当前账号不是当班收银员', 403);
}
export function recordShiftFlow(eventKey, kind, channel, amount, reference, operatorId = null, note = '') {
  if (!amount) return;
  db.prepare('INSERT OR IGNORE INTO shift_ledger(event_key,shift_id,kind,channel,amount_cents,reference,operator_id,note) VALUES(?,?,?,?,?,?,?,?)')
    .run(eventKey, activeShift()?.id || null, kind, channel, amount, reference, operatorId, note);
}
export function recordOrderFlow(order, staff) {
  for (const [channel, amount] of channelAmounts(order)) recordShiftFlow(`order:${order.id}:${channel}`, 'order', channel, amount, order.order_no, staff?.id);
}
export function recordRefundFlow(refund, order) {
  for (const [channel, amount] of refundAmounts(refund, order)) recordShiftFlow(`refund:${refund.id}:${channel}`, 'refund', channel, -amount, refund.out_refund_no, refund.operator_id);
}
function view(shift, detail = false) {
  if (!shift) return null;
  const channels = db.prepare('SELECT channel,SUM(amount_cents) AS net_cents FROM shift_ledger WHERE shift_id=? GROUP BY channel').all(shift.id);
  const cash = channels.find(c => c.channel === 'cash')?.net_cents || 0;
  const pending = {
    orders: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE payment_status='paid' AND status='awaiting_delivery'").get().n,
    services: db.prepare("SELECT COUNT(*) AS n FROM service_requests WHERE status!='completed'").get().n,
    refunds: db.prepare("SELECT COUNT(*) AS n FROM refund_transactions WHERE status IN ('pending','processing')").get().n
  };
  return { ...shift, openedAtLabel:formatTime(shift.opened_at),closedAtLabel:formatTime(shift.closed_at), openedByName: db.prepare('SELECT display_name FROM staff_accounts WHERE id=?').get(shift.opened_by)?.display_name || '已停用员工',
    expected_cents: shift.opening_cents + cash, channels, pending,
    ...(detail ? { ledger: db.prepare('SELECT l.*,a.display_name AS operator FROM shift_ledger l LEFT JOIN staff_accounts a ON a.id=l.operator_id WHERE shift_id=? ORDER BY l.id DESC LIMIT 1000').all(shift.id).map(row=>({...row,timeLabel:formatTime(row.created_at)})) } : {}) };
}
export function registerShiftRoutes(router, audit) {
  const route = (method, path, handler) => router[method](path, (req, res) => {
    try { res.json(handler(req)); } catch (error) { if (!error.status) console.error(error); res.status(error.status || 500).json({ message: error.status ? error.message : '交接班操作失败' }); }
  });
  const owned = (req, statuses) => {
    const shift = activeShift();
    if (!shift || shift.id !== Number(req.params.id) || !statuses.includes(shift.status)) fail('班次状态已变化，请刷新');
    if (req.staff.id !== shift.opened_by && !['super','manager'].includes(req.staff.role)) fail('只能操作自己的班次', 403);
    if (req.body?.revision !== shift.revision) fail('班次数据已更新，请刷新后重试');
    return shift;
  };
  route('get', '/admin/shifts', () => ({ enabled: !!db.prepare('SELECT enabled FROM shift_settings WHERE id=1').get().enabled,
    current: view(activeShift(), true), history: db.prepare("SELECT * FROM cash_shifts WHERE status='closed' ORDER BY id DESC LIMIT 50").all().map(s => view(s)),
    unassigned: db.prepare('SELECT channel,SUM(amount_cents) AS net_cents,COUNT(*) AS count FROM shift_ledger WHERE shift_id IS NULL GROUP BY channel').all() }));
  route('get', '/admin/shifts/:id', req => {
    const shift = db.prepare('SELECT * FROM cash_shifts WHERE id=?').get(req.params.id);
    if (!shift) fail('班次不存在', 404);
    return { shift: view(shift, true) };
  });
  route('post', '/admin/shifts/open', req => db.transaction(() => {
    const requestId = key(req.body?.requestId), amount = money(req.body?.opening);
    const prior = db.prepare('SELECT * FROM cash_shifts WHERE request_id=?').get(requestId);
    if (prior) {
      if (prior.opened_by !== req.staff.id || prior.opening_cents !== amount || prior.previous_id) fail('请求标识已用于其他开班操作');
      return { shift: view(prior), repeated: true };
    }
    if (activeShift()) fail('已有未交接班次，请先完成交接');
    const id = db.prepare('INSERT INTO cash_shifts(request_id,opened_by,opening_cents) VALUES(?,?,?)').run(requestId, req.staff.id, amount).lastInsertRowid;
    db.prepare('UPDATE shift_settings SET enabled=1 WHERE id=1').run();
    audit(req, '收银开班', `班次 ${id} 备用金 ${amount / 100}`);
    return { shift: view(activeShift()) };
  })());
  route('post', '/admin/shifts/:id/movements', req => db.transaction(() => {
    const shift = owned(req, ['open']), amount = money(req.body?.amount), requestId = key(req.body?.requestId);
    const type = req.body?.type, note = String(req.body?.note || '').trim();
    if (!amount || !['cash_in','cash_out'].includes(type) || !note || note.length > 300) fail('请选择现金收支类型并填写原因', 400);
    const signed = type === 'cash_out' ? -amount : amount;
    const prior = db.prepare('SELECT * FROM shift_ledger WHERE event_key=?').get(`movement:${requestId}`);
    if (prior) {
      if (prior.shift_id !== shift.id || prior.amount_cents !== signed || prior.note !== note || prior.operator_id !== req.staff.id) fail('请求标识已使用');
      return { ok: true, repeated: true };
    }
    if (view(shift).expected_cents + signed < 0) fail('现金支出不能超过应有现金');
    recordShiftFlow(`movement:${requestId}`, type, 'cash', signed, `班次-${shift.id}`, req.staff.id, note);
    audit(req, '班次现金收支', `${shift.id} ${type} ${amount / 100} ${note}`);
    return { ok: true };
  })());
  route('post', '/admin/shifts/:id/count', req => db.transaction(() => {
    const shift = owned(req, ['open']);
    db.prepare("UPDATE cash_shifts SET status='counting',revision=revision+1 WHERE id=?").run(shift.id);
    audit(req, '开始交班盘点', String(shift.id));
    return { shift: view(activeShift()) };
  })());
  route('post', '/admin/shifts/:id/cancel-count', req => db.transaction(() => {
    const shift = owned(req, ['counting','awaiting_accept']);
    db.prepare("UPDATE cash_shifts SET status='open',actual_cents=NULL,variance_cents=NULL,counted_at=NULL,note='',revision=revision+1 WHERE id=?").run(shift.id);
    audit(req, '取消交班盘点', String(shift.id));
    return { ok: true };
  })());
  route('post', '/admin/shifts/:id/submit', req => db.transaction(() => {
    const shift = owned(req, ['counting']), actual = money(req.body?.actual), note = String(req.body?.note || '').trim();
    const variance = actual - view(shift).expected_cents;
    if (note.length > 500 || (variance && !note)) fail('现金有差异时必须填写原因，备注最多500字', 400);
    db.prepare("UPDATE cash_shifts SET status='awaiting_accept',actual_cents=?,variance_cents=?,note=?,counted_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?").run(actual, variance, note, shift.id);
    audit(req, '提交交班盘点', `${shift.id} 实盘 ${actual / 100} 差异 ${variance / 100}`);
    return { shift: view(activeShift()) };
  })());
  route('post', '/admin/shifts/:id/accept', req => db.transaction(() => {
    const requestId = key(req.body?.requestId), prior = db.prepare('SELECT * FROM cash_shifts WHERE request_id=?').get(requestId);
    if (prior) {
      if (prior.previous_id !== Number(req.params.id) || prior.opened_by !== req.staff.id) fail('请求标识已使用');
      return { shift: view(prior), repeated: true };
    }
    const shift = activeShift();
    if (!shift || shift.id !== Number(req.params.id) || shift.status !== 'awaiting_accept' || shift.revision !== req.body?.revision) fail('班次状态已变化，请刷新');
    if (shift.opened_by === req.staff.id) fail('请由接班人登录并确认；当天结束营业可选择结束班次');
    db.prepare("UPDATE cash_shifts SET status='closed',closed_at=CURRENT_TIMESTAMP,accepted_by=?,revision=revision+1 WHERE id=?").run(req.staff.id, shift.id);
    db.prepare('INSERT INTO cash_shifts(request_id,opened_by,opening_cents,previous_id) VALUES(?,?,?,?)').run(requestId, req.staff.id, shift.actual_cents, shift.id);
    audit(req, '确认接班', `原班次 ${shift.id}，现金 ${shift.actual_cents / 100}`);
    return { shift: view(activeShift()) };
  })());
  route('post', '/admin/shifts/:id/close', req => db.transaction(() => {
    const shift = owned(req, ['awaiting_accept']);
    db.prepare("UPDATE cash_shifts SET status='closed',closed_at=CURRENT_TIMESTAMP,accepted_by=?,revision=revision+1 WHERE id=?").run(req.staff.id, shift.id);
    audit(req, '结束收银班次', `${shift.id} 实盘 ${shift.actual_cents / 100}`);
    return { ok: true };
  })());
}
