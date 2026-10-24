import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, AriaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { esc } from './catalog-admin.js';

use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, AriaComponent, SVGRenderer]);
export function mountReportCharts(root, data, onSelect) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const style = getComputedStyle(root), color = name => style.getPropertyValue('--report-' + name).trim();
  const ink = color('ink'), muted = color('muted'), green = color('green'), gold = color('gold'), line = color('line'), soft = color('soft');
  const number = n => n == null ? '待补充' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nodes = Object.fromEntries([...root.querySelectorAll('[data-report-chart]')].map(el => [el.dataset.reportChart, el]));
  const charts = Object.fromEntries(Object.entries(nodes).map(([key, el]) => [key, init(el, null, { renderer: 'svg' })]));
  const axis = { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 11, hideOverlap: true }, splitLine: { show: false } };
  const base = { animation: !reduced, animationDuration: 0, animationDurationUpdate: 300, textStyle: { fontFamily: 'Arial,Microsoft YaHei,sans-serif', color: ink, fontSize: 11 }, tooltip: { trigger: 'axis', confine: true, backgroundColor: '#fff', borderColor: line, textStyle: { color: ink, fontSize: 12 } }, aria: { enabled: true } };
  const trend = data.trend, hourly = new Date(data.dateRange.endAt + 'Z') - new Date(data.dateRange.startAt + 'Z') <= 86400000;
  charts.trend.setOption({ ...base, legend: { top: 12, left: 18, textStyle: { color: muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8, data: ['净销售额', '商品毛利'] }, grid: { left: 67, right: 22, top: 55, bottom: 70 },
    xAxis: { ...axis, type: 'category', data: trend.map(d => hourly ? d.startAt.slice(11) : d.startAt.slice(5, 10).replace('-', '/')), axisLabel: { ...axis.axisLabel, margin: 13 } },
    yAxis: { ...axis, type: 'value', name: '金额（元）', nameTextStyle: { color: muted, fontSize: 11 }, splitLine: { show: true, lineStyle: { color: line, type: 'dashed' } } },
    tooltip: { ...base.tooltip, axisPointer: { type: 'cross' }, formatter: rows => `${esc(trend[rows[0]?.dataIndex]?.startAt.replace('T', ' ') || '')}<br>${rows.map(p => `${esc(p.seriesName)}　${p.value == null ? '成本待补充' : '¥' + number(p.value)}`).join('<br>')}` },
    dataZoom: [{ type: 'slider', height: 14, bottom: 13, start: 0, end: 100, borderColor: 'transparent', backgroundColor: '#f3f6f3', fillerColor: soft, handleStyle: { color: green, borderColor: green }, showDetail: false }],
    series: [{ name: '净销售额', type: 'bar', barMaxWidth: 18, data: trend.map(d => d.revenue), itemStyle: { color: green, borderRadius: [3, 3, 0, 0] } }, { name: '商品毛利', type: 'line', data: trend.map(d => d.profit), connectNulls: false, smooth: .2, symbol: 'circle', symbolSize: 5, lineStyle: { color: gold, width: 2 }, itemStyle: { color: gold } }] });
  const horizontal = (rows, label, value, left, accent) => ({ ...base, grid: { left, right: 74, top: 28, bottom: 24 }, xAxis: { ...axis, type: 'value', show: false }, yAxis: { ...axis, type: 'category', inverse: true, data: rows.map(r => r[label]), axisLabel: { ...axis.axisLabel, color: ink, width: left - 13, overflow: 'truncate' } },
    tooltip: { ...base.tooltip, trigger: 'item', formatter: p => `${esc(p.name)}<br>¥${number(p.value)}` },
    series: [{ type: 'bar', barWidth: 17, data: rows.map(r => r[value]), itemStyle: { color: accent, borderRadius: [0, 3, 3, 0] }, label: { show: true, position: 'right', color: ink, fontSize: 11, formatter: p => Number(p.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) } }] });
  charts.sources.setOption(horizontal(data.bySource, 'label', 'revenue', 75, green));
  charts.cash.setOption(horizontal(data.externalChannels, 'label', 'net', 95, gold));
  const t = data.totals, floating = t.profit != null && t.profit >= 0 && t.revenue >= t.orderCost && t.orderCost >= 0 && t.lossCost >= 0;
  if (!floating) nodes.profit.closest('.report-panel').querySelector('.report-panel-heading small').textContent = t.profit == null ? '历史退库成本待补充，毛利暂不计算' : '各项对毛利的影响：正值增加，负值减少';
  charts.profit.setOption({ ...base, grid: { left: 67, right: 24, top: 35, bottom: 34 }, xAxis: { ...axis, type: 'category', data: ['净销售', '商品耗用', '赠送报损', '毛利估算'] }, yAxis: { ...axis, type: 'value', splitLine: { show: true, lineStyle: { color: line, type: 'dashed' } } },
    tooltip: { ...base.tooltip, formatter: rows => { const p = rows.find(r => r.seriesName === '金额'); return p ? `${esc(p.name)}　${p.value == null ? '成本待补充' : '¥' + number(p.value)}` : ''; } },
    series: [...(floating ? [{ name: '辅助', type: 'bar', stack: 'cost', silent: true, itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, data: [0, t.revenue - t.orderCost, t.profit, 0] }] : []),
      { name: '金额', type: 'bar', stack: floating ? 'cost' : undefined, barMaxWidth: 40, data: [t.revenue, t.orderCost == null ? null : floating ? t.orderCost : -t.orderCost, floating ? t.lossCost : -t.lossCost, t.profit].map((value, i) => ({ value, itemStyle: { color: i === 3 ? green : color('deduct') } })), label: { show: true, position: 'top', color: ink, fontSize: 11, formatter: p => p.value == null ? '待补充' : (floating && [1, 2].includes(p.dataIndex) ? '−' : '') + Number(p.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }, itemStyle: { borderRadius: [3, 3, 0, 0] } }] });
  let selected = {};
  charts.trend.on('click', p => { if (p.componentType === 'series' && trend[p.dataIndex]) onSelect({ kind: 'orders', segmentStart: trend[p.dataIndex].startAt, segmentEnd: trend[p.dataIndex].endAt }); });
  charts.sources.on('click', p => { const row = data.bySource[p.dataIndex]; if (p.componentType === 'series' && row) onSelect({ kind: 'orders', source: selected.source === row.source ? '' : row.source }); });
  charts.cash.on('click', p => { const row = data.externalChannels[p.dataIndex]; if (p.componentType === 'series' && row) onSelect({ kind: 'flows', channel: selected.channel === row.key ? '' : row.key }); });
  const description = () => {
    nodes.trend.setAttribute('aria-label', `净销售额 ${number(t.revenue)}元、商品毛利估算 ${number(t.profit)}元。支持图例切换、时间缩放和点击时段查看订单。`);
    nodes.sources.setAttribute('aria-label', data.bySource.map(s => `${s.label}净销售贡献${number(s.revenue)}元`).join('；') || '本周期没有已支付消费或成功退款');
    nodes.cash.setAttribute('aria-label', data.externalChannels.map(s => `${s.label}净收款${number(s.net)}元`).join('；') || '本周期没有外部收付记录');
    nodes.profit.setAttribute('aria-label', `净销售${number(t.revenue)}元，商品净耗用${number(t.orderCost)}元，赠送报损${number(t.lossCost)}元，毛利估算${number(t.profit)}元。经营净利润费用待补充。`);
  };
  description();
  const observer = new ResizeObserver(() => { Object.values(charts).forEach(chart => chart.resize()); description(); }); observer.observe(root);
  return { select(state) { selected = { ...state }; for (const [key, rows, field, match, accent] of [['sources', data.bySource, 'revenue', 'source', green], ['cash', data.externalChannels, 'net', 'key', gold]]) charts[key].setOption({ series: [{ data: rows.map(row => ({ value: row[field], itemStyle: { color: (key === 'sources' ? state.source && state.source !== row[match] : state.channel && state.channel !== row[match]) ? color('deduct') : accent } })) }] }); description(); }, destroy() { observer.disconnect(); Object.values(charts).forEach(chart => chart.dispose()); } };
}
