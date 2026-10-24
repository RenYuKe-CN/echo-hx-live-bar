import ExcelJS from 'exceljs';
import { channelNames } from './bills.js';
import { formatTime } from './business-time.js';

const currency = '#,##0.00_);[Red](#,##0.00);"—"_)';
const green = 'FF285A4A', ink = 'FF243C37', pale = 'FFEFF5F1', muted = 'FF68796F';
const money = n => n == null ? null : Number((n / 100).toFixed(2));
const columns = spec => spec.map(([label, type = 'text', width = 18]) => ({ label, type, width }));
export async function reportWorkbook(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '门店管理后台'; workbook.created = new Date(report.generatedAt);
  const { window, totals: t } = report;
  const period = `${window.start.replace('T', ' ')} 至 ${window.end.replace('T', ' ')} · ${window.timezone} · 含开始，不含结束`;
  const date = value => { const text = value && formatTime(value, window.timezone); return text ? new Date(text.replace(' ', 'T') + ':00Z') : null; };
  const localDate = value => value ? new Date(value.replace(' ', 'T') + ':00Z') : null;
  function table(name, specs, rows, note) {
    const cols = columns(specs), sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4, xSplit: 2, showGridLines: false }] });
    sheet.columns = cols.map(c => ({ width: c.width }));
    sheet.mergeCells(1, 1, 1, cols.length); sheet.getCell('A1').value = name;
    sheet.getCell('A1').font = { name: 'Arial', size: 16, bold: true, color: { argb: ink } }; sheet.getRow(1).height = 33;
    [period, note + ' 金额单位：元；空白为未确认或不适用，金额横线代表0。'].forEach((text, i) => {
      sheet.mergeCells(i + 2, 1, i + 2, cols.length); const cell = sheet.getCell(i + 2, 1); cell.value = text;
      cell.font = { name: 'Arial', size: 11, color: { argb: muted }, italic: true }; cell.alignment = { vertical: 'middle', wrapText: true }; sheet.getRow(i + 2).height = i ? 34 : 26;
    });
    sheet.getRow(4).values = cols.map(c => c.label); sheet.getRow(4).height = 36;
    sheet.getRow(4).eachCell(cell => { cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: green } }; cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
    for (const values of rows) {
      const row = sheet.addRow(values.map(v => v === '' ? null : v)); let height = 29;
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1); cell.font = { name: 'Arial', size: 11, color: { argb: ink } };
        cell.alignment = { vertical: 'middle', horizontal: ['money', 'count', 'rate'].includes(c.type) ? 'right' : 'left', wrapText: true };
        if (['类型', '单位', '状态', '订单状态', '支付状态', '计入本范围销售', '本期消费', '外部收付', '库存处理', '登记状态'].includes(c.label)) cell.alignment.horizontal = 'center';
        cell.numFmt = c.type === 'money' ? currency : c.type === 'count' ? '#,##0' : c.type === 'rate' ? '0.00%' : c.type === 'date' ? 'yyyy-mm-dd hh:mm' : '@';
        if (row.number % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F6F3' } };
        if (typeof cell.value === 'string') { const width = [...cell.value].reduce((n, ch) => n + (/[^\x00-\x7f]/.test(ch) ? 2 : 1), 0); height = Math.max(height, Math.ceil(width / Math.max(8, c.width - 2)) * 15 + 8); }
      }); row.height = Math.min(409, height);
    }
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, sheet.rowCount), column: cols.length } };
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:4' };
    return sheet;
  }
  const summary = workbook.addWorksheet('营业总览', { views: [{ showGridLines: false }], properties: { tabColor: { argb: green } } });
  summary.columns = Array.from({ length: 16 }, () => ({ width: 10 }));
  const merged = (range, value, opts = {}) => { summary.mergeCells(range); const cell = summary.getCell(range.split(':')[0]); cell.value = value; cell.font = { name: 'Arial', size: opts.size || 11, bold: !!opts.bold, color: { argb: opts.color || ink } }; cell.alignment = { vertical: 'middle', horizontal: opts.right ? 'right' : 'left', wrapText: true }; if (opts.fill) summary.getCell(range.split(':')[0]).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } }; if (opts.numFmt) cell.numFmt = opts.numFmt; return cell; };
  for (let r = 1; r < 45; r++) summary.getRow(r).height = 25;
  merged('A2:P2', '营业报表', { size: 17, bold: true }); summary.getRow(2).height = 35;
  merged('A3:P3', period + ' · 金额：元', { color: muted });
  [['A', 'D', '净销售额', t.revenue, currency], ['F', 'H', '商品毛利估算', t.profit, currency], ['J', 'L', '商品毛利率', t.grossMarginRate, '0.00%'], ['N', 'P', '外部净收款', t.externalNetReceived, currency]].forEach(([a, b, label, value, format]) => {
    merged(`${a}5:${b}5`, label, { bold: true, color: green, fill: pale }); merged(`${a}6:${b}7`, value, { size: 17, bold: true, fill: pale, numFmt: format });
    merged(`${a}8:${b}8`, label === '商品毛利估算' && value == null ? '历史成本待补充' : label === '商品毛利率' && value == null ? '成本不明或净销售不为正' : label === '外部净收款' ? '含充值及平台登记到账' : label === '商品毛利估算' ? '未扣人工、房租及平台费用' : label === '商品毛利率' ? '与毛利使用同一口径' : '已扣赠金及成功退款', { color: muted, fill: pale });
  });
  summary.getRow(8).height = 38;
  merged('A10:P10', `已付款 ${t.orders} 单 · 消费 ${t.tables} 桌次 · 成功退款 ${t.refundCount} 笔 · 处理中退款 / 申请 ${t.pendingRefunds} 笔 · 本期核销待登记 ${t.unsettledCount} 笔`, { color: muted });
  const band = (range, label) => merged(range, label, { bold: true, color: 'FFFFFFFF', fill: green });
  band('A11:G11', '销售额怎么算'); band('I11:P11', '钱怎么收进来');
  const left = [['商品原价', t.gross], ['减：会员与优惠券优惠', t.discount], ['订单结算（含赠金）', t.sales + t.bonusUsed], ['减：赠金抵扣', t.bonusUsed], ['消费销售收入', t.sales], ['减：成功退款（不含退赠金）', t.refund], ['本期净销售额', t.revenue]];
  const right = [['订单外部收款', t.externalOrderReceived], ['会员充值实收', t.rechargeReceived], ['平台登记到账 / 调整', t.settlementReceived], ['外部收款及调整小计', Number((t.externalOrderReceived + t.rechargeReceived + t.settlementReceived).toFixed(2))], ['减：成功外部退款', t.externalRefunded], ['本期外部净收款', t.externalNetReceived]];
  left.forEach(([label, v], i) => { merged(`A${12 + i}:E${12 + i}`, label, { bold: i === 6 }); merged(`F${12 + i}:G${12 + i}`, v, { numFmt: currency, right: true, bold: i === 6, fill: i === 6 ? pale : undefined }); });
  right.forEach(([label, v], i) => { merged(`I${12 + i}:N${12 + i}`, label, { bold: i === 5 }); merged(`O${12 + i}:P${12 + i}`, v, { numFmt: currency, right: true, bold: i === 5, fill: i === 5 ? pale : undefined }); });
  merged('I18:P18', '余额、赠金与团购核销记账不重复作为新收款。', { color: muted });
  band('A21:G21', '各来源的净销售贡献'); band('I21:P21', '毛利与成本');
  merged('A22:C22', '来源', { bold: true }); merged('D22:E22', '付款单数', { bold: true }); merged('F22:G22', '净销售额', { bold: true });
  report.bySource.forEach((s, i) => { const r = 23 + i; merged(`A${r}:C${r}`, s.label); merged(`D${r}:E${r}`, s.orders, { numFmt: '#,##0', right: true }); merged(`F${r}:G${r}`, s.revenue, { numFmt: currency, right: true }); });
  [['销售货品成本', t.saleCost], ['减：实际回库成本', t.returnedCost], ['销售净耗用成本', t.orderCost], ['赠送与报损成本', t.lossCost], ['商品毛利估算', t.profit], ['经营净利润', '费用待补充']].forEach(([label, v], i) => { const r = 22 + i; merged(`I${r}:N${r}`, label, { bold: i >= 4 }); merged(`O${r}:P${r}`, v, { right: true, numFmt: typeof v === 'string' ? '@' : currency, bold: i >= 4 }); });
  summary.getRow(27).height = 35;
  const footer = Math.max(30, 24 + report.bySource.length);
  band(`A${footer}:P${footer}`, '明细与口径');
  ['订单明细可按付款手机号、会员ID和订单号追溯；桌台账单汇总同一次开台的点单与加单。', '商品明细按套餐 / 单品列示，基础货品流水按实际出入库列示，两种数量不混加。', '退款按完成时段冲减销售；只有实际回库才冲回成本。处理中申请不计确认退款。', '团购结算按截止时点的登记流水统计；预计到账未知时留空，不把核销记账当成实际到账。', '毛利估算未扣人工、房租、水电、税费和平台费用；历史退库成本未知时，成本、毛利和毛利率留空。', `历史核对：商品金额不匹配 ${t.unallocatedOrderAmounts} 笔、退库成本缺失 ${t.missingRefundCost} 笔、退款完成时间缺失 ${t.legacyRefundTimes} 笔、未记录到账时间 ${t.undatedSettlements} 笔。`, `生成：${formatTime(report.generatedAt, window.timezone)}；此文件是当时的账务快照。`].forEach((v, i) => { merged(`A${footer + 1 + i}:P${footer + 1 + i}`, v, { color: muted }); summary.getRow(footer + 1 + i).height = 29; });
  summary.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: `A1:P${footer + 7}` };

  const orderMap = new Map(report.orderViews.map(o => [o.id, o]));
  table('订单明细', [['订单号', 'text', 32], ['账单号', 'text', 20], ['桌号'], ['创建时间', 'date', 23], ['付款时间', 'date', 23], ['来源'], ['付款人'], ['付款人手机号', 'text', 20], ['付款人会员ID', 'text', 20], ['订单状态'], ['支付状态'], ['原价', 'money'], ['优惠', 'money'], ['结算金额', 'money'], ['赠金', 'money'], ['计入本范围销售'], ['备注', 'text', 40], ['身份来源', 'text', 24], ['商品摘要', 'text', 42], ['记录归属'], ['本期成功退款（不含赠金）', 'money', 24], ['本期净销售贡献', 'money', 22], ['处理中退款 / 申请', 'count', 20]],
    report.orderViews.map(o => [o.orderNo, o.billNo, o.tableNo, localDate(o.createdAt), localDate(o.paidAt), o.sourceLabel, o.payerName, o.payerPhone || '未绑定手机号', o.memberId, o.statusLabel, ({ paid: '已付款', pending: '待付款', closed: '已关闭' })[o.paymentStatus] || o.paymentStatus, o.original, o.discount, o.payable, o.bonus, o.paidInRange ? '是' : '否', o.note, o.identitySource, o.lines.map(p => `${p.name} ×${p.quantity}${p.unit}`).join('、'), o.scope, o.refund, o.revenue, o.pendingRefunds]), '本范围创建 / 付款 / 退款关联记录全部保留；净销售贡献剔除赠金，未支付 / 取消不计销售。历史无身份快照时明确使用当前资料。');
  table('桌台账单', [['账单号', 'text', 20], ['桌号'], ['开台时间', 'date', 23], ['结束时间', 'date', 23], ['状态'], ['累计付款订单数', 'count'], ['本期付款订单数', 'count'], ['本期净销售贡献', 'money', 22], ['整桌累计净消费（含赠金）', 'money', 27]], report.bills.map(b => [b.billNo, b.tableNo, date(b.openedAt), date(b.closedAt), b.status === 'open' ? '进行中' : '已结束', b.orders, b.todayOrders, b.todayRevenue, b.cumulativeNet]), '整桌累计含跨期消费和赠金，与本期净销售贡献分开，不能重复加入本期收入。');
  table('商品明细', [['订单号', 'text', 32], ['商品ID'], ['商品 / 套餐', 'text', 32], ['类型'], ['销售数量', 'count'], ['单位'], ['原价金额', 'money'], ['会员后券前金额', 'money', 22], ['分摊优惠券', 'money'], ['券后结算金额', 'money', 22], ['计入本范围销售'], ['售出货品成本', 'money', 20]], report.products.map(p => { const o = orderMap.get(p.orderId); return [o.orderNo, String(p.id), p.name, p.kind, p.quantity, p.unit, money(p.original), money(p.beforeCoupon), money(p.couponDiscount), p.couponDiscount == null ? null : money(p.amount), o.paidInRange ? '是' : '否', money(p.cost)]; }), '套餐按套，基础货品不重复计销售；结算含赠金、未扣退款，退款不猜测分摊到某个商品。');
  table('收付流水', [['时间', 'date', 23], ['业务类型', 'text', 26], ['渠道', 'text', 22], ['确认金额', 'money'], ['未确认申请金额', 'money', 22], ['状态'], ['外部收付'], ['订单号', 'text', 32], ['账单号', 'text', 20], ['流水号', 'text', 36], ['时间依据', 'text', 30], ['付款人手机号', 'text', 20], ['会员ID', 'text', 20]], report.flowViews.map(f => [localDate(f.time), f.type, f.channelLabel, f.amount, f.requestedAmount, f.statusLabel, f.amount == null ? '待确认' : f.external ? '是' : '内部记账', f.orderNo, f.billNo, f.number, f.legacyTime ? '历史缺少完成时间，按创建时间' : '业务确认时间', f.payerPhone, f.memberId]), '确认收款为正、退款 / 下调为负；未确认金额留空。核销记账和实际到账分开，不重复计外部收款。');
  table('退款明细', [['退款 / 申请号', 'text', 36], ['订单号', 'text', 32], ['账单号', 'text', 20], ['桌号'], ['付款手机号', 'text', 20], ['会员ID', 'text', 20], ['申请时间', 'date', 23], ['完成时间', 'date', 23], ['状态'], ['申请金额', 'money'], ['确认退款总额', 'money'], ['退本金', 'money'], ['退赠金', 'money'], ['退外部款 / 券记账', 'money', 22], ['净销售冲减', 'money'], ['库存处理', 'text', 24], ['实际回库成本', 'money', 22], ['原付款时间', 'date', 23], ['原因', 'text', 40], ['时间依据', 'text', 30]], report.refundViews.map(r => [r.number, r.orderNo, r.billNo, r.tableNo, r.payerPhone, r.memberId, localDate(r.createdAt), localDate(r.completedAt), r.statusLabel, r.requested, r.confirmed, r.stored, r.bonus, r.external, r.revenue, r.stockMode, r.returnedCost, localDate(r.paidAt), r.reason, r.legacyTime ? '历史缺少完成时间，按创建时间' : '业务确认时间']), '成功按完成时段计入，处理中 / 待审核只列申请；退钱与实物回库分别处理，历史未留存的库存处理方式不猜测。');
  table('团购结算', [['核销记录号', 'text', 36], ['平台'], ['订单号', 'text', 32], ['账单号', 'text', 20], ['桌号'], ['消费记账时间', 'date', 23], ['核销记账额', 'money'], ['预计到账', 'money'], ['截止期末已登记', 'money', 23], ['截止期末最后到账时间', 'date', 26], ['本期到账 / 调整', 'money', 22], ['已知待登记差额', 'money', 22], ['本期消费'], ['登记状态', 'text', 26], ['本期各次到账 / 调整', 'text', 65]], report.redemptionViews.map(r => [r.id, r.platformLabel, r.orderNo, r.billNo, r.tableNo, localDate(r.paidAt), r.amount, r.expected, r.registered, localDate(r.registeredAt), r.inRangeReceived, r.pending, r.paidInRange ? '是' : '否', r.statusLabel, r.settlements.map(s => `${s.number} ${s.time} ${s.amount.toFixed(2)}`).join('\n')]), '本期核销或本期到账关联记录；截止期末累计与本期到账不能叠加。预计未知留空，登记不代表已自动核对平台账单。');
  table('基础货品流水', [['时间', 'date', 23], ['货品ID'], ['货品', 'text', 30], ['单位'], ['库存变动', 'count'], ['变动后库存', 'count'], ['业务渠道'], ['原因', 'text', 36], ['订单号', 'text', 32], ['账单号', 'text', 20], ['桌号'], ['操作人']], report.inventory.map(i => [date(i.created_at), String(i.product_id), i.name, i.unit_snapshot || '历史单位未留存', i.change_quantity, i.stock_after, ({ miniapp: '小程序', pos: '收银', meituan: '美团', douyin: '抖音', refund: '退款回库', adjustment: '库存调整', loss: '赠送报损', reward: '积分兑换' })[i.channel] || i.channel, i.reason, i.order_no || '', i.bill_no || '', i.table_no || '', i.operator || '']), '套餐展开后的真实库存变化，出库为负、回库为正。不同单位不合计，成本使用订单及退库快照，不套用现价。');
  table('会员充值记录', [['充值号', 'text', 20], ['时间', 'date', 23], ['会员', 'text', 24], ['收款渠道', 'text', 22], ['实际收款', 'money'], ['到账本金', 'money'], ['到账赠金', 'money'], ['备注', 'text', 40], ['会员手机号', 'text', 20], ['会员ID', 'text', 20], ['身份来源', 'text', 25]], report.recharges.map(r => [String(r.id), date(r.created_at), r.nickname, channelNames[r.payment_channel] || '未记录渠道', money(r.pay_cents), money(r.stored_cents), money(r.bonus_cents), r.remark, r.phone || '未绑定手机号', String(r.user_id), '当前资料（充值未留身份快照）']), '只把实收计入收款，本金和赠金分开；后续余额消费不重复计新收款。手机号与昵称为当前资料，稳定会员ID用于追溯。');
  const paidProducts = report.products.filter(p => orderMap.get(p.orderId).paidInRange);
  const checks = [
    ['订单净销售贡献合计', Number(report.orderViews.reduce((n, o) => n + o.revenue, 0).toFixed(2)), t.revenue],
    ['整桌本期净销售贡献合计', Number(report.bills.reduce((n, b) => n + b.todayRevenue, 0).toFixed(2)), t.revenue],
    ['商品券后结算合计（本期已付）', paidProducts.some(p => p.couponDiscount == null) ? null : money(paidProducts.reduce((n, p) => n + p.amount, 0)), t.sales + t.bonusUsed],
    ['来源净销售贡献合计', Number(report.bySource.reduce((n, s) => n + s.revenue, 0).toFixed(2)), t.revenue],
    ['外部渠道净收款合计', Number(report.externalChannels.reduce((n, s) => n + s.net, 0).toFixed(2)), t.externalNetReceived],
    ['本期团购到账 / 调整合计', Number(report.redemptionViews.reduce((n, r) => n + r.inRangeReceived, 0).toFixed(2)), t.settlementReceived]
  ];
  const notes = table('统计说明', [['项目', 'text', 34], ['定义 / 左侧金额', 'text', 64], ['说明 / 右侧金额', 'text', 70], ['核对差额', 'money', 18]], [
    ['净销售额', '本期成功付款结算－赠金－本期成功退款中的销售额冲减', '退款以完成时间归期；跨期退款保留原订单，不重记原销售。'],
    ['商品毛利估算 / 毛利率', '净销售额－商品净耗用成本－赠送报损；毛利率＝毛利÷净销售', '未扣人工、房租、水电、税费、平台费用；净销售不为正或成本未知时毛利率留空。'],
    ['经营净利润', '费用待补充', '现阶段没有完整经营费用台账，不能把商品毛利称为最终净利润。'],
    ['整桌与子订单', '一次开台归集多次点单和加单，各笔付款人分别保留', '整桌累计含跨期和赠金，不与本期净销售重复相加。'],
    ['商品与基础货品', '套餐按套销售，组成货品按瓶 / 杯 / 份出入库', '两张明细承担不同用途，不能把套餐与组成货品重复计销售额。'],
    ['团购截止期末与本期到账', '截止期末按所有有日期的历史结算流水累计；本期列示本期各次差额', '未来到账不倒灌以前的报表。未保留日期的历史结算不猜测到账期。预计未知留空。'],
    ['付款身份', '订单优先付款时姓名和手机号快照＋稳定会员ID', '历史订单无快照、充值无身份快照时明确使用当前档案；不能按同名顾客匹配。'],
    ['范围与空白', '页面的图表筛选只筛选明细，导出为完整已查询营业周期', '金额横线为0，空白为未确认、不适用或历史缺失。单次最多31天、10000笔订单。'],
    ['核对关系', '以下只核对导出各页是否一致', '差额0.00表示内部一致，不代表平台对账、真实商户或打印设备验收。'],
    ...checks.map(([label, a, b]) => [label, a, b, a == null || b == null ? null : Number((a - b).toFixed(2))])
  ], '来源：订单、退款、库存、充值和团购结算流水；统计口径与后台图表共用同一份查询结果。');
  notes.getColumn(4).numFmt = '#,##0.00;[Red](#,##0.00);0.00';
  for (let r = 14; r <= notes.rowCount; r++) for (const c of [2, 3]) notes.getCell(r, c).numFmt = currency;
  return workbook.xlsx.writeBuffer();
}
