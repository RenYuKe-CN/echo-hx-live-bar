import { esc, money } from './catalog-admin.js';
import './orders-admin.css';

export function ordersContent(data, { account, refundCell, refundActions, paymentSummary, phone = '', phoneDraft = phone }) {
  const headers = ['订单信息', '付款人', '商品与备注', '金额汇总', '优惠与支付', '退款信息', '操作'];
  const cell = (label, content, className = '') => `<td data-label="${label}" class="${className}">${content}</td>`;
  const amount = (label, value, className = '') => `<div class="order-amount ${className}"><span>${label}</span><strong>${value}</strong></div>`;
  const rows = data.orders.map(order => {
    const items = order.displayItems || (order.items || []).map(item => ({ ...item, name: item.product_name }));
    const controls = order.payment_status === 'pending'
      ? ['wechat', 'mixed'].includes(order.payment_method) ? '<span class="order-muted">等待微信支付</span>' : `<button class="table-action" data-mark-paid="${order.id}">确认线下收款</button>`
      : order.status === 'awaiting_delivery' ? `<button class="table-action" data-admin-section="workdesk" ${account.permissions.includes('workdesk') ? '' : 'disabled'}>查看配送任务</button>` : '<span class="order-muted">已完成</span>';
    return `<tr>${cell(headers[0], `<button type="button" class="order-number" data-copy-order="${esc(order.order_no)}" title="复制完整订单号" aria-label="复制订单号 ${esc(order.order_no)}">${esc(order.order_no)}</button><div class="order-context"><strong>${esc(order.table_no)} 桌</strong><span class="order-state">${esc(order.statusLabel)}</span></div>`)}
      ${cell(headers[1], `<strong class="order-payer">${esc(order.nickname)}</strong><span class="order-phone">${esc(order.payer_phone || '未绑定手机号')}</span>`)}
      ${cell(headers[2], `<div class="order-goods">${items.map(item => `<span>${esc(item.name)} × ${item.quantity}</span>`).join('') || '<span class="order-muted">无商品明细</span>'}</div><div class="order-note"><span class="order-muted">订单备注</span><p>${order.note ? esc(order.note) : '<span class="order-muted">无</span>'}</p></div>`)}
      ${cell(headers[3], amount('原价', money(order.originalAmount)) + amount('实付', money(order.payableAmount), 'order-paid') + amount('净销售额', order.payment_status === 'paid' ? money(order.netSales) : '—') + amount('利润', account.role === 'super' && order.profit != null ? money(order.profit) : '—'))}
      ${cell(headers[4], amount('会员优惠', `-${money(order.memberDiscount)}`, 'order-discount') + amount('优惠券优惠', `-${money(order.couponDiscount)}`, 'order-discount') + `<div class="order-payment"><span class="order-muted">支付构成</span><p>${esc(paymentSummary(order))}</p></div>`)}
      ${cell(headers[5], `<div class="order-refunds">${refundCell(order)}</div>`)}
      ${cell(headers[6], `<div class="order-actions">${controls}${refundActions(order)}<button class="table-action" data-receipt-order="${order.id}">小票</button></div>`)}</tr>`;
  }).join('');
  const search = `<form id="order-phone-search" class="order-filter" aria-label="订单手机号搜索"><label>付款人手机号<input name="phone" type="search" inputmode="numeric" pattern="[0-9]{1,11}" maxlength="11" autocomplete="off" placeholder="输入完整手机号或后4位" value="${esc(phoneDraft)}"></label><button class="primary-small" type="submit">查询订单</button><button class="outline-button" type="button" data-order-clear>清空</button><span class="order-filter-result" role="status">${phone ? `筛选号码：${esc(phone)} · 匹配 ${data.pagination.total} 笔` : `全部订单 · 共 ${data.pagination.total} 笔`}</span></form>`;
  return `${search}<section class="orders-panel" aria-label="订单列表"><table class="order-table"><colgroup>${[16,13,20,13,14,14,10].map(width => `<col style="width:${width}%">`).join('')}</colgroup><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows || `<tr class="order-empty"><td colspan="7">${phone ? '没有匹配的订单，请核对付款人手机号或清空筛选' : '暂无数据'}</td></tr>`}</tbody></table></section>`;
}
