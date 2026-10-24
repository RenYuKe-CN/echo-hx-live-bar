import { channelAmounts, channelNames } from './bills.js';
import { commerceError, formatTime, inWindow, localDateTime, parseLocal } from './business-time.js';

const money = n => n == null ? null : Number((n / 100).toFixed(2));
const sum = (rows, select) => rows.reduce((n, row) => n + select(row), 0);
export const sourceNames = { miniapp: '小程序', pos: '收银', meituan: '美团', douyin: '抖音' };
export const orderStates = { pending_payment: '待付款', awaiting_delivery: '待配送', completed: '已完成', refunded: '已退款', cancelled: '已取消' };
export const refundStates = { pending: '待处理', processing: '处理中', success: '成功', failed: '失败' };
const revenueRefund = r => r.stored_cents + r.wechat_cents + r.offline_cents + r.external_cents;
const json = value => { try { const result = JSON.parse(value || '{}'); return result && typeof result === 'object' && !Array.isArray(result) ? result : {}; } catch { return {}; } };
const groupBy = (rows, select) => { const map = new Map(); for (const row of rows) { const key = select(row); if (!map.has(key)) map.set(key, []); map.get(key).push(row); } return map; };

// One projection owns the amounts and identities used by charts, drill-downs and Excel.
// Internal raw rows and third-party payloads never pass through the report API.
export function prepareReportViews(report) {
  const { window, totals } = report, date = v => formatTime(v, window.timezone);
  const refunds = groupBy(report.refunds, r => r.order_id), requests = groupBy(report.requests, r => r.order_id);
  const products = groupBy(report.products, p => p.orderId);
  const items = groupBy(report.items, i => i.order_id);
  const itemById = new Map(report.items.map(i => [i.id, i]));
  const settlementsByRedemption = groupBy(report.settlements, x => x.redemption_id);
  report.orderViews = report.orders.map(o => {
    const paid = o.payment_status === 'paid' && inWindow(o.paid_at, window), same = refunds.get(o.id) || [], successful = same.filter(r => r.status === 'success');
    const refund = sum(successful, revenueRefund), pending = same.filter(r => ['pending', 'processing'].includes(r.status)).length + (requests.get(o.id) || []).length;
    const cost = (report.paymentCosts[o.id] || 0), returned = successful.some(r => r.returned_cost_cents == null) ? null : sum(successful, r => r.returned_cost_cents);
    return {
      id: o.id, orderNo: o.order_no, billNo: o.bill_no, tableNo: o.table_no,
      createdAt: date(o.created_at), paidAt: date(o.paid_at), source: o.source_channel, sourceLabel: sourceNames[o.source_channel] || o.source_channel,
      payerName: o.nickname, payerPhone: o.payer_phone || '', memberId: String(o.payer_user_id), identitySource: o.payer_identity_captured_at ? '付款时快照' : '当前资料（历史未留存）',
      status: o.status, statusLabel: orderStates[o.status] || o.status, paymentStatus: o.payment_status,
      scope: paid ? '本期支付' : successful.length ? '跨期退款' : o.payment_status === 'paid' ? '关联历史订单' : o.status === 'cancelled' ? '已取消' : '待付款',
      original: money(o.original_amount_cents), discount: money(o.discount_amount_cents), memberDiscount: money(o.discount_amount_cents - o.coupon_discount_cents), couponDiscount: money(o.coupon_discount_cents),
      payable: money(o.payable_amount_cents), bonus: money(o.bonus_paid_cents), refund: money(refund), refundTotal: money(sum(successful, r => r.amount_cents)),
      revenue: money((paid ? o.payable_amount_cents - o.bonus_paid_cents : 0) - refund), paidInRange: paid, pendingRefunds: pending,
      saleCost: money(cost), returnedCost: money(returned), note: o.note,
      lines: (products.get(o.id) || []).map(p => ({ id: String(p.id), name: p.name, kind: p.kind, quantity: p.quantity, unit: p.unit, original: money(p.original), beforeCoupon: money(p.beforeCoupon), couponDiscount: money(p.couponDiscount), amount: p.couponDiscount == null ? null : money(p.amount) })),
      channels: channelAmounts(o).map(([channel, amount]) => ({ channel, label: channelNames[channel] || channel, amount: money(amount) })),
      baseItems: (items.get(o.id) || []).map(i => ({ name: i.product_name, quantity: i.quantity, unit: i.unit_snapshot || '件', cost: money(i.cost_price_cents * i.quantity) })),
      eventTimes: [...(paid ? [o.paid_at] : []), ...same.map(r => r.completed_at || r.created_at), ...(requests.get(o.id) || []).map(q => q.created_at)]
    };
  });
  const viewById = new Map(report.orderViews.map(o => [o.id, o]));
  report.refundViews = [...report.refunds.map(r => ({ ...r, recordKind: 'transaction' })), ...report.requests.map(r => ({ ...r, recordKind: 'request', out_refund_no: `申请-${r.id}` }))].map(r => {
    const o = viewById.get(r.order_id), success = r.recordKind === 'transaction' && r.status === 'success', plan = json(r.stock_plan_json);
    return { id: `${r.recordKind}-${r.id}`, orderId: r.order_id, number: r.out_refund_no, orderNo: o?.orderNo || '', billNo: o?.billNo || '', tableNo: o?.tableNo || '', payerPhone: o?.payerPhone || '', memberId: o?.memberId || '',
      createdAt: date(r.created_at), completedAt: success ? date(r.completed_at || r.created_at) : '', legacyTime: success && !r.completed_at, status: r.status, statusLabel: r.recordKind === 'request' ? '待审核申请' : refundStates[r.status] || r.status,
      requested: money(r.amount_cents), confirmed: success ? money(r.amount_cents) : null, stored: success ? money(r.stored_cents) : null, bonus: success ? money(r.bonus_cents) : null,
      external: success ? money(r.wechat_cents + r.offline_cents + r.external_cents) : null, revenue: success ? money(revenueRefund(r)) : 0,
      returnedCost: success ? money(r.returned_cost_cents) : null, stockMode: plan.mode === 'restock' ? '实物回库' : plan.mode === 'no_restock' ? '不回库' : '历史方式未留存', paidAt: o?.paidAt || '', reason: r.reason,
      returnItems: (Array.isArray(plan.returnItems) ? plan.returnItems : []).map(i => { const item = itemById.get(Number(i.orderItemId)); return { name: item?.product_name || `货品${i.orderItemId}`, quantity: i.quantity, unit: item?.unit_snapshot || '件' }; }) };
  });
  const refundViewsByOrder = groupBy(report.refundViews, r => r.orderId);
  report.orderViews.forEach(o => { o.refunds = refundViewsByOrder.get(o.id) || []; });
  const orderByNo = new Map(report.orderViews.map(o => [o.orderNo, o]));
  const rechargeByNo = new Map(report.recharges.map(r => ['充值-' + r.id, r]));
  report.flowViews = report.flows.map((f, index) => {
    const o = orderByNo.get(f.orderNo), r = rechargeByNo.get(f.number);
    return { id: String(index), time: date(f.time), rawTime: f.time, type: f.type, channel: f.channel, channelLabel: f.type === '团购实际结算 / 调整' ? ({ meituan: '美团结算', douyin: '抖音结算' }[f.channel] || channelNames[f.channel] || f.channel) : channelNames[f.channel] || '未记录渠道',
      amount: money(f.amount), requestedAmount: money(f.requestedAmount), status: f.status || 'success', statusLabel: refundStates[f.status || 'success'] || f.status,
      external: f.external, orderNo: f.orderNo, orderId: o?.id || null, billNo: f.billNo, number: f.number, tableNo: o?.tableNo || '', payerPhone: o?.payerPhone || r?.phone || '', memberId: o?.memberId || (r ? String(r.user_id) : ''), legacyTime: !!f.legacyTime };
  });
  report.redemptionViews = report.redemptions.map(r => {
    const paidInRange = inWindow(r.paid_at, window), inPeriod = settlementsByRedemption.get(r.id) || [], actual = r.registered_to_end_cents;
    const pending = r.expected_settlement_cents == null ? null : Math.max(0, r.expected_settlement_cents - (actual || 0));
    return { id: r.id, platform: r.platform, platformLabel: sourceNames[r.platform] || r.platform, orderId: r.order_id, orderNo: r.order_no || '', billNo: r.bill_no, tableNo: r.table_no, name: json(r.snapshot_json).product?.name || '团购套餐', paidAt: date(r.paid_at),
      paidInRange, amount: money(r.amount_cents), expected: money(r.expected_settlement_cents), registered: money(actual), registeredAt: date(r.registered_at), inRangeReceived: money(sum(inPeriod, x => x.amount_cents)), pending: money(pending),
      unsettled: paidInRange && (actual == null || pending > 0), statusLabel: actual == null ? '待登记到账' : pending > 0 ? '部分登记' : r.expected_settlement_cents == null ? '已登记（预计未知）' : '已登记',
      settlements: inPeriod.map(x => ({ number: '结算-' + x.id, time: date(x.settled_at), amount: money(x.amount_cents), targetTotal: money(x.target_total_cents) })) };
  });
  const successful = report.refunds.filter(r => r.status === 'success');
  const sourceMap = new Map();
  for (const o of report.orders) {
    const view = viewById.get(o.id); if (!view.paidInRange && !view.refund) continue;
    const v = sourceMap.get(o.source_channel) || { source: o.source_channel, label: sourceNames[o.source_channel] || o.source_channel, orders: 0, revenue: 0 };
    v.orders += view.paidInRange ? 1 : 0;
    v.revenue += (view.paidInRange ? o.payable_amount_cents - o.bonus_paid_cents : 0) - sum((refunds.get(o.id) || []).filter(r => r.status === 'success'), revenueRefund);
    sourceMap.set(o.source_channel, v);
  }
  report.bySource = [...sourceMap.values()].map(v => ({ ...v, revenue: money(v.revenue) }));
  const cashMap = new Map();
  report.flows.filter(f => f.external && f.amount != null).forEach(f => {
    const settlement = f.type === '团购实际结算 / 调整', key = `${settlement ? 'settlement:' : ''}${f.channel}`;
    const v = cashMap.get(key) || { key, channel: f.channel, settlement, label: settlement ? `${sourceNames[f.channel] || f.channel}结算` : channelNames[f.channel] || '未记录渠道', received: 0, refunded: 0, net: 0 };
    v.received += Math.max(0, f.amount); v.refunded += Math.max(0, -f.amount); v.net += f.amount; cashMap.set(key, v);
  });
  report.externalChannels = [...cashMap.values()].map(v => ({ ...v, received: money(v.received), refunded: money(v.refunded), net: money(v.net) }));
  totals.grossMarginRate = totals.profit != null && totals.revenue > 0 ? totals.profit / totals.revenue : null;
  totals.refundCount = successful.length;
  totals.pendingRefunds = report.refundViews.filter(r => r.status === 'pending' || r.status === 'processing').length;
  const unsettled = report.redemptionViews.filter(r => r.unsettled);
  totals.unsettledCount = unsettled.length; totals.unsettledUnknown = unsettled.filter(r => r.pending == null).length;
  totals.unsettledAmount = Number(sum(unsettled, r => r.pending || 0).toFixed(2));
  totals.externalOrderReceived = money(sum(report.flows.filter(f => f.external && f.type === '订单付款'), f => f.amount));
  totals.externalRefunded = money(sum(report.flows.filter(f => f.external && f.type === '订单退款'), f => -f.amount));
  report.trend = window.to - window.from > 86400000 ? report.daily : hourlyTrend(report);
}

function hourlyTrend(report) {
  const rows = []; let from = report.window.from;
  while (from < report.window.to) {
    const to = Math.min(report.window.to, (Math.floor(from / 3600000) + 1) * 3600000), segment = { from, to };
    const paid = report.orders.filter(o => o.payment_status === 'paid' && inWindow(o.paid_at, segment)), refunds = report.refunds.filter(r => r.status === 'success' && inWindow(r.completed_at || r.created_at, segment));
    const revenue = sum(paid, o => o.payable_amount_cents - o.bonus_paid_cents) - sum(refunds, revenueRefund);
    const cost = refunds.some(r => r.returned_cost_cents == null) ? null : sum(paid, o => report.paymentCosts[o.id] || 0) - sum(refunds, r => r.returned_cost_cents);
    const loss = sum(report.losses.filter(r => inWindow(r.created_at, segment)), r => r.cost_cents);
    rows.push({ startAt: localDateTime(from, report.window.timezone), endAt: localDateTime(to, report.window.timezone), orders: paid.length, revenue: money(revenue), profit: cost == null ? null : money(revenue - cost - loss), orderCost: money(cost), lossCost: money(loss) });
    from = to;
  }
  return rows;
}

export function reportDetails(report, query = {}) {
  const kind = String(query.kind || 'orders');
  if (!['orders', 'flows', 'redemptions'].includes(kind)) throw commerceError('明细类型无效');
  const q = String(query.q || '').trim(), status = String(query.status || ''), source = String(query.source || ''), channel = String(query.channel || '');
  if (q.length > 80 || source.length > 40 || channel.length > 60 || !['', 'paid', 'pending', 'cancelled', 'refund', 'pendingRefund', 'unsettled'].includes(status)) throw commerceError('报表筛选条件无效');
  let segment = null;
  if (query.segmentStart || query.segmentEnd) {
    const from = parseLocal(query.segmentStart, report.window.timezone), to = parseLocal(query.segmentEnd, report.window.timezone);
    if (from >= to || from < report.window.from || to > report.window.to) throw commerceError('图表明细时段超出查询范围');
    segment = { from, to };
  }
  let rows;
  if (kind === 'orders') rows = report.orderViews.filter(o => (!source || o.source === source) && (!q || o.payerPhone.includes(q) || o.orderNo.toLowerCase().includes(q.toLowerCase())) && (!segment || o.eventTimes.some(t => inWindow(t, segment))) && (!status || (status === 'paid' ? o.paidInRange : status === 'refund' ? o.refund > 0 : status === 'pendingRefund' ? o.pendingRefunds > 0 : status === 'cancelled' ? o.status === 'cancelled' : o.paymentStatus === 'pending'))).reverse();
  if (kind === 'flows') rows = report.flowViews.filter(f => (!q || f.payerPhone.includes(q) || f.orderNo.toLowerCase().includes(q.toLowerCase()) || f.number.toLowerCase().includes(q.toLowerCase())) && (!segment || inWindow(f.rawTime, segment)) && (!channel || `${f.type === '团购实际结算 / 调整' ? 'settlement:' : ''}${f.channel}` === channel)).reverse();
  if (kind === 'redemptions') rows = report.redemptionViews.filter(r => (!source || r.platform === source) && (!q || r.orderNo.toLowerCase().includes(q.toLowerCase()) || r.id.toLowerCase().includes(q.toLowerCase())) && (!status || status !== 'unsettled' || r.unsettled)).reverse();
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(query.pageSize) || 10))), total = rows.length, totalPages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(totalPages, Math.max(1, Math.trunc(Number(query.page) || 1)));
  const compact = rows.slice((page - 1) * pageSize, page * pageSize).map(({ eventTimes, rawTime, ...row }) => kind === 'orders' ? (({ lines, baseItems, refunds, channels, ...summary }) => ({ ...summary, itemSummary: lines.map(p => `${p.name} ×${p.quantity}${p.unit}`).join('、') }))(row) : row);
  return { kind, rows: compact, pagination: { page, pageSize, total, totalPages, hasPrevious: page > 1, hasNext: page < totalPages } };
}

export function reportOrderDetail(report, id) {
  const order = report.orderViews.find(o => o.id === Number(id));
  if (!order) throw commerceError('本报表范围没有该订单', 404);
  const { eventTimes, ...view } = order;
  return view;
}
