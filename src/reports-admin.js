import { esc, table, adminDialog } from './catalog-admin.js';
import './reports-admin.css';

const rate = value => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
const money = value => value == null ? '—' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const negative = n => n < 0 ? 'report-negative' : '';
const periodQuery = data => ({ startAt: data.dateRange.startAt, endAt: data.dateRange.endAt });
const shiftDate = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const shown = value => esc(value || '—');

export function reportsContent(data) {
  const t = data.totals, s = data.settings, warnings = t.missingRefundCost || t.legacyRefundTimes || t.undatedSettlements || t.unallocatedOrderAmounts;
  const cards = [['净销售额', money(t.revenue), '已扣赠金及成功退款'], ['商品毛利估算', t.profit == null ? '待补充' : money(t.profit), t.profit == null ? '历史退库成本尚未明确' : '已扣商品、赠送与报损成本'], ['商品毛利率', rate(t.grossMarginRate), t.grossMarginRate == null ? '成本不明或净销售额不为正' : '毛利估算 / 净销售额'], ['外部净收款', money(t.externalNetReceived), '含充值及平台登记到账']];
  return `<div class="business-reports" id="business-reports">
    <header class="report-toolbar"><div><span class="report-eyebrow">门店经营分析</span><p>${esc(data.dateRange.startAt.replace('T', ' '))} — ${esc(data.dateRange.endAt.replace('T', ' '))}</p><small>${esc(data.dateRange.timezone)} · 含开始，不含结束</small></div><div class="report-actions"><label class="report-sr" for="report-preset">统计周期</label><select id="report-preset"><option value="today">本营业日</option><option value="7d">近7个营业日</option><option value="30d">近30个营业日</option><option value="custom">自选时间</option></select><button type="button" class="report-primary" data-report-export>导出 Excel</button></div></header>
    <details class="report-range"><summary>选择营业日期 / 精确起止时间</summary><form id="business-report-range"><label>营业日期<input type="date" data-report-date value="${esc(data.dateRange.startAt.slice(0, 10))}"></label><label>开始时间<input type="datetime-local" name="startAt" value="${esc(data.dateRange.startAt)}" required></label><label>结束时间<input type="datetime-local" name="endAt" value="${esc(data.dateRange.endAt)}" required></label><button class="report-primary">查询此时段</button></form><p>导出使用当前已查询的完整周期；修改时间后请先查询。单次最多31天、10000笔订单。</p></details>
    <section class="report-kpis" aria-label="核心营业指标">${cards.map(([label, value, note], i) => `<article class="report-kpi ${i === 1 ? 'report-kpi-profit' : ''}"><span>${label}</span><strong class="${i === 1 ? negative(t.profit) : ''}">${value}</strong><small>${note}</small></article>`).join('')}</section>
    <div class="report-summary-strip"><div><span>已支付 <strong>${t.orders}</strong> 单</span><span>消费 <strong>${t.tables}</strong> 桌次</span><span>退款销售冲减 <strong>${money(t.refund)}</strong> / ${t.refundCount}笔</span></div><div class="report-followup"><button type="button" data-report-pending>退款处理中 / 申请 ${t.pendingRefunds}笔</button><button type="button" data-report-unsettled>本期核销待登记 ${t.unsettledCount}笔 · ${money(t.unsettledAmount)}${t.unsettledUnknown ? `（另${t.unsettledUnknown}笔预计未知）` : ''}</button></div></div>
    ${warnings ? `<div class="report-warning">历史记录需核对：商品金额不匹配 ${t.unallocatedOrderAmounts}笔，退库成本缺失 ${t.missingRefundCost}笔，退款完成时间缺失 ${t.legacyRefundTimes}笔，团购到账时间缺失 ${t.undatedSettlements}笔。未知成本、毛利与毛利率不按0处理。</div>` : ''}
    <section class="report-charts" aria-label="经营图表">
      <article class="report-panel"><div class="report-panel-heading"><div><h2>销售与毛利趋势</h2><small>${data.dateRange.endAt && data.trend.length > data.daily.length ? '按营业时段' : '按营业日'} · 点击日期 / 时段联动明细</small></div><span>元</span></div><div class="report-chart report-chart-trend" data-report-chart="trend" role="img" aria-label="净销售额与商品毛利趋势"></div></article>
      <article class="report-panel"><div class="report-panel-heading"><div><h2>销售来源</h2><small>按净销售贡献 · 点击筛选订单</small></div><span>元</span></div><div class="report-chart" data-report-chart="sources" role="img" aria-label="各来源净销售贡献"></div></article>
      <article class="report-panel"><div class="report-panel-heading"><div><h2>毛利是怎么算出来的</h2><small>销售减去实际货品耗用与赠送报损</small></div><span>元</span></div><div class="report-chart report-chart-profit" data-report-chart="profit" role="img" aria-label="商品毛利拆解"></div><div class="report-net-profit"><div><span>经营净利润</span><strong>费用待补充</strong></div><small>尚未扣除人工、房租、水电、税费及平台费用。</small></div></article>
      <article class="report-panel"><div class="report-panel-heading"><div><h2>外部收付渠道</h2><small>含充值及登记到账 · 点击查流水</small></div><span>净收款 / 元</span></div><div class="report-chart" data-report-chart="cash" role="img" aria-label="各渠道外部净收款"></div><p class="report-note">余额、赠金、团购核销记账不重复计收款。</p></article>
    </section>
    <section class="report-panel report-details" aria-label="消费与资金明细"><div class="report-details-heading"><div><h2>从图表查到每一笔</h2><small>明细筛选不改变上方完整周期的指标，也不限制完整周期导出。</small></div><div class="report-tabs" aria-label="明细类型">${[['orders', '消费订单'], ['flows', '收付流水'], ['redemptions', '团购结算']].map(([key, label]) => `<button type="button" data-report-tab="${key}" aria-pressed="${key === 'orders'}">${label}</button>`).join('')}</div></div>
      <form class="report-detail-search" id="report-detail-search"><input name="q" type="search" maxlength="80" placeholder="手机号 / 订单号" aria-label="手机号或订单号"><select name="status" aria-label="明细状态"><option value="">全部记录</option><option value="paid">本期已支付</option><option value="refund">有成功退款</option><option value="pendingRefund">退款处理中 / 申请</option><option value="pending">待支付</option><option value="cancelled">已取消</option></select><button>查询</button><button type="button" data-report-clear>清除筛选</button></form><p class="report-filter-label" data-report-filter aria-live="polite"></p><div data-report-details>${detailTable(data.details)}</div>
    </section>
    <details class="report-more report-panel"><summary>商品销售、消费支付渠道与每日经营明细</summary><div class="report-more-content"><h2>商品销售</h2><p class="report-note">页面显示前50项 / 共${data.productCount}项。套餐按套计价，结算含赠金、未扣退款；Excel保留全部明细。</p>${table(['商品 / 套餐', '售出数量', '单位', '结算金额'], data.byProduct.map(p => `<tr><td>${esc(p.product_name)}</td><td>${p.quantity}</td><td>${esc(p.unit)}</td><td>${money(p.amount)}</td></tr>`).join(''))}<h2>消费支付渠道</h2><p class="report-note">包含余额、赠金与团购核销等消费记账，与外部资金收付分开。</p>${table(['渠道', '消费结算', '成功退款', '净记账'], data.channels.map(c => `<tr><td>${esc(c.label)}</td><td>${money(c.received)}</td><td>${money(c.refunded)}</td><td>${money(c.net)}</td></tr>`).join(''))}<h2>每日经营明细</h2>${table(['营业日 / 实际时段', '已付订单', '净销售', '毛利估算', '商品净成本'], data.daily.map(d => `<tr><td>${esc(d.day)}<small>${esc(d.startAt.replace('T', ' '))} 至 ${esc(d.endAt.replace('T', ' '))}</small></td><td>${d.orders}</td><td>${money(d.revenue)}</td><td>${money(d.profit)}</td><td>${money(d.orderCost)}</td></tr>`).join(''))}</div></details>
    ${data.canConfigure ? `<details class="report-more report-panel"><summary>营业日与导出文件名设置（超级管理员）</summary><form id="business-report-settings"><label>门店时区<select name="timezone">${[['Asia/Shanghai', '北京时间'], ['Asia/Kuala_Lumpur', '马来西亚时间'], ['UTC', 'UTC']].map(([v, label]) => `<option value="${v}" ${s.timezone === v ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>营业开始<input type="time" name="openTime" value="${s.openTime}" required></label><label>营业结束<input type="time" name="closeTime" value="${s.closeTime}" required></label><label>导出标题<input name="exportTitle" maxlength="30" value="${esc(s.exportTitle)}" required></label><button class="report-primary">保存规则</button></form><p class="report-note">结束时间不晚于开始时间时，按次日结束计算。</p></details>` : '<p class="report-note">营业日、时区与导出标题的全局规则由超级管理员设置。</p>'}
    <p class="report-note">生成于 ${esc(data.generatedAt ? new Date(data.generatedAt).toLocaleString('zh-CN', {timeZone:data.dateRange.timezone,hour12:false}) : '')}。团购“登记到账”不代表已与平台账单自动核对。</p>
  </div>`;
}

export function detailTable(result) {
  const { rows, kind, pagination: p } = result;
  const headers = kind === 'flows' ? ['时间 / 关联单', '业务 / 渠道', '手机号 / 会员ID', '资金属性', '确认金额', ''] : kind === 'redemptions' ? ['平台 / 套餐', '订单 / 桌台', '核销 / 预计到账', '截至期末已登记', '本期到账 / 调整', ''] : ['付款人 / 手机号', '桌台 / 时间', '消费内容', '订单结算', '本期净销售贡献', ''];
  const body = rows.map(o => kind === 'flows' ? `<tr><td>${esc(o.time)}<small>${shown(o.orderNo || o.number)}</small></td><td>${esc(o.type)}<small>${esc(o.channelLabel)}</small></td><td>${shown(o.payerPhone)}<small>${o.memberId ? '会员ID ' + esc(o.memberId) : ''}</small></td><td>${o.amount == null ? '未确认' : o.external ? '外部资金' : '内部记账'}</td><td class="report-number ${negative(o.amount)}">${money(o.amount)}${o.amount == null ? `<small>申请 ${money(o.requestedAmount)}</small>` : ''}</td><td><button type="button" data-report-flow="${esc(o.id)}">详情</button></td></tr>` : kind === 'redemptions' ? `<tr><td>${esc(o.platformLabel)}<small>${esc(o.name)}</small></td><td>${shown(o.orderNo)}<small>${esc(o.tableNo)} · ${esc(o.paidAt)}</small></td><td class="report-number">${money(o.amount)}<small>预计 ${money(o.expected)}</small></td><td class="report-number">${money(o.registered)}<small>${esc(o.statusLabel)}</small></td><td class="report-number ${negative(o.inRangeReceived)}">${money(o.inRangeReceived)}<small>已知待登记 ${money(o.pending)}</small></td><td><button type="button" data-report-redemption="${esc(o.id)}">详情</button></td></tr>` : `<tr><td><strong>${shown(o.payerName)}</strong><small>${o.payerPhone ? esc(o.payerPhone) : '未绑定手机号'}</small></td><td>${esc(o.tableNo)}<small>${esc((o.paidAt || o.createdAt).slice(5))}</small></td><td>${shown(o.itemSummary)}<small>${esc(o.orderNo)} · ${esc(o.sourceLabel)}${o.pendingRefunds ? ' · 退款处理中' : ''}</small></td><td class="report-number">${money(o.payable)}<small>${esc(o.scope)}</small></td><td class="report-number ${negative(o.revenue)}">${money(o.revenue)}<small>${o.refund ? '成功退款 ' + money(o.refund) : o.bonus ? '赠金 ' + money(o.bonus) : ''}</small></td><td><button type="button" data-report-order="${o.id}">详情</button></td></tr>`).join('');
  return `<div class="report-table-wrap"><table class="report-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body || '<tr><td colspan="6" class="report-empty">当前条件下没有记录</td></tr>'}</tbody></table></div><div class="report-pagination"><span>共${p.total}条 · 第${p.total ? (p.page - 1) * p.pageSize + 1 : 0}–${Math.min(p.page * p.pageSize, p.total)}条</span><div><button type="button" data-report-page="${p.page - 1}" ${p.hasPrevious ? '' : 'disabled'}>上一页</button><span>${p.page} / ${p.totalPages}</span><button type="button" data-report-page="${p.page + 1}" ${p.hasNext ? '' : 'disabled'}>下一页</button></div></div>`;
}

export function bindReports({ api, data, notify, onDialog, onReportRange, filters = {} }) {
  const root = document.querySelector('#business-reports');
  if (!root) return null;
  const $ = selector => root.querySelector(selector), range = periodQuery(data);
  let alive = true, sequence = 0, request = null, charts = null, last = data.details;
  const state = filters;
  Object.assign(state, { kind: state.kind || 'orders', page: state.page || 1, pageSize: 10 });
  const safe = fn => async event => { try { await fn(event); } catch (error) { if (alive && error.name !== 'AbortError') notify(error.message); } };
  function syncFilters() {
    root.querySelectorAll('[data-report-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.reportTab === state.kind)));
    const search = $('#report-detail-search'); search.elements.q.value = state.q || ''; search.elements.q.placeholder = state.kind === 'redemptions' ? '订单号 / 核销记录号' : '手机号 / 订单号';
    search.elements.q.setAttribute('aria-label', state.kind === 'redemptions' ? '订单号或核销记录号' : '手机号或订单号');
    search.elements.status.hidden = state.kind !== 'orders'; search.elements.status.value = state.status || '';
    const labels = [state.source && '来源：' + (data.bySource.find(s => s.source === state.source)?.label || state.source), state.channel && '渠道：' + (data.externalChannels.find(c => c.key === state.channel)?.label || state.channel), state.segmentStart && `事件时段：${state.segmentStart.replace('T', ' ')} 至 ${state.segmentEnd.replace('T', ' ')}`, state.q && '查询：' + state.q, state.status === 'unsettled' ? '本期核销待登记到账' : state.status ? search.elements.status.selectedOptions[0]?.textContent : ''].filter(Boolean);
    $('[data-report-filter]').textContent = labels.join(' · ') || '全部明细 · 点击图表仅筛选本列表';
    charts?.select(state);
  }
  async function loadDetails() {
    const current = ++sequence; request?.abort(); request = new AbortController(); syncFilters();
    $('[data-report-details]').setAttribute('aria-busy', 'true');
    try {
      const result = await api('/reports/details?' + new URLSearchParams({ ...range, ...state }), { signal: request.signal });
      if (!alive || current !== sequence || !root.isConnected) return;
      last = result; state.page = result.pagination.page; $('[data-report-details]').innerHTML = detailTable(result);
    } catch (error) {
      if (error.name === 'AbortError' || current !== sequence || !alive) return;
      $('[data-report-details]').innerHTML = `<p class="report-empty" role="alert">${esc(error.message)} <button type="button" data-report-retry>重试</button></p>`;
    } finally { if (alive && current === sequence) $('[data-report-details]').removeAttribute('aria-busy'); }
  }
  function select(changes) { for (const k of ['source', 'channel', 'segmentStart', 'segmentEnd', 'q', 'status']) delete state[k]; Object.assign(state, { page: 1 }, changes); return loadDetails(); }
  const form = $('#business-report-range');
  const setDate = date => { form.elements.startAt.value = date + 'T' + data.settings.openTime; form.elements.endAt.value = shiftDate(date, data.settings.closeTime <= data.settings.openTime ? 1 : 0) + 'T' + data.settings.closeTime; };
  form.querySelector('[data-report-date]').onchange = event => { if (event.target.value) setDate(event.target.value); };
  form.onsubmit = event => { event.preventDefault(); onReportRange(Object.fromEntries(new FormData(form))); };
  const preset = $('#report-preset'), today = data.currentBusinessDate;
  preset.value = 'custom';
  for (const [value, count] of [['today', 1], ['7d', 7], ['30d', 30]]) if (range.startAt === shiftDate(today, 1 - count) + 'T' + data.settings.openTime && range.endAt === shiftDate(today, data.settings.closeTime <= data.settings.openTime ? 1 : 0) + 'T' + data.settings.closeTime) preset.value = value;
  preset.onchange = () => { if (preset.value === 'custom') $('.report-range').open = true; else onReportRange({ start: shiftDate(today, 1 - ({ today: 1, '7d': 7, '30d': 30 }[preset.value])), end: today }); };
  $('#report-detail-search').onsubmit = event => { event.preventDefault(); state.q = event.currentTarget.elements.q.value.trim(); state.status = event.currentTarget.elements.status.hidden ? state.kind === 'redemptions' ? state.status : '' : event.currentTarget.elements.status.value; state.page = 1; loadDetails(); };
  $('[data-report-clear]').onclick = () => select({ kind: state.kind });
  $('[data-report-pending]').onclick = () => select({ kind: 'orders', status: 'pendingRefund' });
  $('[data-report-unsettled]').onclick = () => select({ kind: 'redemptions', status: 'unsettled' });
  root.querySelectorAll('[data-report-tab]').forEach(button => button.onclick = () => select({ kind: button.dataset.reportTab }));
  const dialog = (title, html) => adminDialog(title, `<div class="business-reports report-dialog">${html}</div>`, { onDialog });
  const orderDetail = async id => {
    const result = await api(`/reports/orders/${id}?` + new URLSearchParams(range)); if (!alive || !root.isConnected) return;
    const o = result.order;
    dialog('消费订单详情', `<div class="report-dialog-facts"><div><small>订单 / 整桌账单</small>${esc(o.orderNo)}<small>${esc(o.billNo)} · ${esc(o.tableNo)}</small></div><div><small>付款时间 / 身份来源</small>${shown(o.paidAt)}<small>${esc(o.identitySource)}</small></div><div><small>付款人 / 手机号</small>${shown(o.payerName)}<small>${shown(o.payerPhone)}</small></div><div><small>固定会员ID</small>${esc(o.memberId)}</div></div>${table(['商品 / 套餐', '数量', '原价', '券后结算'], o.lines.map(p => `<tr><td>${esc(p.name)}</td><td>${p.quantity}${esc(p.unit)}</td><td>${money(p.original)}</td><td>${money(p.amount)}</td></tr>`).join(''))}<div class="report-dialog-totals"><span>原价 ${money(o.original)} · 会员优惠 ${money(o.memberDiscount)} · 券优惠 ${money(o.couponDiscount)}</span><strong>结算 ${money(o.payable)}</strong><span>赠金 ${money(o.bonus)} · 本期退款销售冲减 ${money(o.refund)}</span><strong class="${negative(o.revenue)}">本期净销售贡献 ${money(o.revenue)}</strong></div><p class="report-dialog-note">支付：${o.channels.map(c => esc(c.label) + ' ' + money(c.amount)).join(' ＋ ') || '尚未支付'}<br>售出商品成本 ${money(o.saleCost)}；本期实际回库成本 ${o.returnedCost == null ? '历史待补充' : money(o.returnedCost)}。${o.pendingRefunds ? `<br>另有${o.pendingRefunds}笔退款 / 申请处理中，未计成功退款。` : ''}${o.note ? '<br>' + esc(o.note) : ''}</p>${o.refunds.length ? `<h3>本期退款记录</h3>${table(['状态 / 时间', '申请 / 确认', '库存处理', '退库成本'], o.refunds.map(r => `<tr><td>${esc(r.statusLabel)}<small>${esc(r.completedAt || r.createdAt)}</small></td><td>${money(r.requested)} / ${money(r.confirmed)}</td><td>${esc(r.stockMode)}<small>${esc(r.reason)}</small></td><td>${money(r.returnedCost)}</td></tr>`).join(''))}` : ''}`);
  };
  root.addEventListener('click', safe(async event => {
    const page = event.target.closest('[data-report-page]'), order = event.target.closest('[data-report-order]'), flow = event.target.closest('[data-report-flow]'), redemption = event.target.closest('[data-report-redemption]');
    if (page && !page.disabled) { state.page = Number(page.dataset.reportPage); await loadDetails(); }
    if (event.target.closest('[data-report-retry]')) await loadDetails();
    if (order) await orderDetail(order.dataset.reportOrder);
    if (flow) { const f = last.rows.find(r => r.id === flow.dataset.reportFlow); if (f) dialog('收付流水详情', `<div class="report-dialog-facts"><div><small>时间 / 业务</small>${esc(f.time)}<small>${esc(f.type)} · ${esc(f.statusLabel)}</small></div><div><small>渠道 / 资金属性</small>${esc(f.channelLabel)} · ${f.amount == null ? '待确认' : f.external ? '外部资金' : '内部记账'}</div><div><small>付款手机号 / 会员ID</small>${shown(f.payerPhone)}<small>${shown(f.memberId)}</small></div><div><small>关联单号</small>${shown(f.orderNo || f.number)}</div></div><p>确认金额 ${money(f.amount)}${f.requestedAmount != null ? ' · 未确认申请 ' + money(f.requestedAmount) : ''}</p><p class="report-dialog-note">${f.legacyTime ? '历史未保留完成时间，按创建时间归期。' : '按业务确认时间归期。'}${f.external ? '平台结算与消费记账分别列示。' : '内部记账或未确认申请不重复作为外部收款。'}</p>`); }
    if (redemption) { const r = last.rows.find(v => v.id === redemption.dataset.reportRedemption); if (r) dialog('团购结算详情', `<div class="report-dialog-facts"><div><small>平台 / 套餐</small>${esc(r.platformLabel)} · ${esc(r.name)}</div><div><small>订单 / 桌台</small>${shown(r.orderNo)}<small>${esc(r.tableNo)}</small></div><div><small>核销记账 / 预计到账</small>${money(r.amount)} / ${money(r.expected)}</div><div><small>截至期末已登记 / 待登记差额</small>${money(r.registered)} / ${money(r.pending)}</div></div>${table(['本期到账时间', '结算流水', '到账 / 调整'], r.settlements.map(s => `<tr><td>${esc(s.time)}</td><td>${esc(s.number)}</td><td>${money(s.amount)}</td></tr>`).join(''))}<p class="report-dialog-note">本期到账 / 调整合计 ${money(r.inRangeReceived)}；截至期末累计与本期到账不能相加。预计金额未知时留空，登记不代表已自动核对平台账单。</p>`); }
  }));
  $('[data-report-export]').onclick = safe(async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = '正在导出…';
    try { const response = await fetch('/api/admin/reports/export?' + new URLSearchParams(range), { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('adminToken') } }); if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || '导出失败，请稍后重试'); } const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = data.dateRange.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    finally { if (button.isConnected) { button.disabled = false; button.textContent = '导出 Excel'; } }
  });
  const settings = $('#business-report-settings');
  if (settings) settings.onsubmit = safe(async event => { event.preventDefault(); const button = settings.querySelector('button'); button.disabled = true; try { await api('/reports/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(settings))) }); notify('营业日规则已保存'); onReportRange({ date: today }); } finally { if (button.isConnected) button.disabled = false; } });
  syncFilters();
  if (state.kind !== 'orders' || Object.keys(state).some(k => !['kind', 'page', 'pageSize'].includes(k)) || state.page > 1) loadDetails();
  import('./reports-charts.js').then(module => { if (!alive || !root.isConnected) return; charts = module.mountReportCharts(root, data, changes => select(changes)); charts.select(state); }).catch(error => { if (alive && root.isConnected) { root.querySelectorAll('[data-report-chart]').forEach(el => { el.innerHTML = '<p class="report-empty">图表加载失败，可查询下方明细或刷新重试。</p>'; }); console.error(error); } });
  return { destroy() { alive = false; sequence++; request?.abort(); charts?.destroy(); } };
}
