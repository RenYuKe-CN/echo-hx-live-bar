const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => `¥${(Number(cents || 0)/100).toFixed(2)}`;
const states = {open:'当班中',counting:'正在盘点',awaiting_accept:'等待接班',closed:'已结束'};
const channels = {cash:'现金',merchant_qr:'商家收款码',offline:'其他线下',wechat:'微信支付',stored:'储值余额',bonus:'赠金',meituan:'美团核销',douyin:'抖音核销',meituan_settlement:'美团实际结算',douyin_settlement:'抖音实际结算',unknown:'未知渠道'};
export function shiftsContent(data, account) {
  const shift = data.current, owned = shift && (shift.opened_by === account.id || ['super','manager'].includes(account.role));
  const current = shift ? `<section class="panel shift-current"><div class="panel-heading"><div><h2>班次 ${shift.id} · ${states[shift.status]}</h2><span>${escape(shift.openedByName)} · 开班 ${escape(shift.openedAtLabel)}</span></div></div>
    <div class="shift-metrics">${[['备用金',shift.opening_cents],['应有现金',shift.expected_cents],['实盘现金',shift.actual_cents],['现金差异',shift.variance_cents]].map(([label,value])=>`<div><span>${label}</span><strong>${value == null ? '待盘点' : money(value)}</strong></div>`).join('')}</div>
    <div class="shift-channels">${shift.channels.map(row=>`<span>${channels[row.channel] || escape(row.channel)}净额 <b>${money(row.net_cents)}</b></span>`).join('') || '本班暂无交易'}</div>
    <p>待送达 ${shift.pending.orders} 笔 · 待处理服务 ${shift.pending.services} 项 · 退款处理中 ${shift.pending.refunds} 笔。交班不会结束桌台或更改任务处理人，请在服务工作台确认交接。</p>
    ${shift.note ? `<p>交班备注：${escape(shift.note)}</p>` : ''}
    <div class="toolbar">${owned && shift.status === 'open' ? '<button class="outline-button" data-shift="movement">登记现金收支</button><button class="primary-small" data-shift="count">开始交班盘点</button>' : ''}
    ${owned && shift.status === 'counting' ? '<button class="primary-small" data-shift="submit">填写实盘现金</button>' : ''}
    ${owned && ['counting','awaiting_accept'].includes(shift.status) ? '<button class="outline-button" data-shift="cancel-count">取消盘点，恢复现金收款</button>' : ''}
    ${shift.status === 'awaiting_accept' && shift.opened_by !== account.id ? '<button class="primary-small" data-shift="accept">确认接班并开新班</button>' : ''}
    ${owned && shift.status === 'awaiting_accept' ? '<button class="outline-button" data-shift="close">结束班次（暂无接班人）</button>' : ''}</div>
    ${['counting','awaiting_accept'].includes(shift.status) ? '<p class="warning-text">现金收款和现金退款已暂停，在线支付继续记入当前班次，接班确认时划分新旧班次。</p>' : ''}</section>` : `<section class="panel"><h2>当前没有进行中的班次</h2><p>${data.enabled ? '请先开班，再登记现金收款。' : '首次开班后启用交接班管理；此前记录保留为未归班流水。'}</p><button class="primary-small" data-shift="open">开班并登记备用金</button></section>`;
  const history = data.history || [];
  return current + `<section class="panel"><h2>最近50个已结束班次</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>班次</th><th>收银员</th><th>开班</th><th>结束</th><th>应有现金</th><th>实盘现金</th><th>差异</th><th>操作</th></tr></thead><tbody>${history.map(s=>`<tr><td>${s.id}</td><td>${escape(s.openedByName)}</td><td>${escape(s.openedAtLabel)}</td><td>${escape(s.closedAtLabel)}</td><td>${money(s.expected_cents)}</td><td>${money(s.actual_cents)}</td><td>${money(s.variance_cents)}</td><td><button class="table-action" data-shift-detail="${s.id}">查看明细</button></td></tr>`).join('') || '<tr><td colspan="8">暂无已结束班次</td></tr>'}</tbody></table></div></section>
    ${data.unassigned?.length ? `<section class="panel"><h2>未归班流水</h2><p>未开班时确认的交易保留独立记录，不自动归入后续班次；仍计入营业报表。</p>${data.unassigned.map(row=>`<p>${channels[row.channel] || escape(row.channel)} ${row.count} 条 · 净额 ${money(row.net_cents)}</p>`).join('')}</section>` : ''}`;
}
export function bindShifts({api,data,refresh,notify,onDialog}) {
  const root = document.querySelector('#admin-dialog-root');
  const show = (title, fields, submit) => {
    onDialog(true);
    root.innerHTML = `<div class="admin-dialog-backdrop"><form class="admin-dialog shift-dialog" role="dialog" aria-modal="true"><header><h2>${title}</h2><button type="button" data-dismiss>×</button></header><div class="dialog-fields shift-dialog-fields">${fields}</div><p class="dialog-error" role="alert"></p><footer><button type="button" class="outline-button" data-dismiss>关闭</button>${submit ? '<button class="primary-small" type="submit">确认提交</button>' : ''}</footer></form></div>`;
    const close = () => {root.innerHTML='';onDialog(false);};
    root.querySelectorAll('[data-dismiss]').forEach(b=>b.onclick=close);
    root.querySelector('form').onsubmit=async event=>{
      event.preventDefault(); const button=event.currentTarget.querySelector('[type="submit"]'); if(!button || button.disabled)return;button.disabled=true;
      try {await submit(Object.fromEntries(new FormData(event.currentTarget)));close();await refresh();notify('班次操作已保存');}
      catch(error){root.querySelector('.dialog-error').textContent=error.message;button.disabled=false;}
    };
  };
  const field=(title,name,input)=>`<label class="admin-field"><span>${title}</span>${input || `<input type="number" name="${name}" min="0" step="0.01" required>`}</label>`;
  const commandId=crypto.randomUUID();
  document.querySelectorAll('[data-shift]').forEach(button=>button.onclick=()=>{
    const action=button.dataset.shift, shift=data.current, path=`/shifts/${shift?.id}/${action}`;
    const post=(url,payload)=>api(url,{method:'POST',body:JSON.stringify({revision:shift?.revision,requestId:commandId,...payload})});
    if(action==='open')show('收银开班',field('备用金（元）','opening'),payload=>post('/shifts/open',payload));
    else if(action==='movement')show('登记现金收支',field('收支类型','type','<select name="type"><option value="cash_out">现金支出 / 提走现金</option><option value="cash_in">其他现金收入 / 补充备用金</option></select>')+field('金额（元）','amount')+field('原因','note','<textarea name="note" maxlength="300" required></textarea>'),payload=>post(`/shifts/${shift.id}/movements`,payload));
    else if(action==='submit')show('交班盘点',`<p>应有现金 ${money(shift.expected_cents)}</p>`+field('实盘现金（元）','actual')+field('差异原因及交班备注','note','<textarea name="note" maxlength="500"></textarea>'),payload=>post(path,payload));
    else show(({count:'开始交班盘点',accept:'确认接班',close:'结束班次','cancel-count':'取消盘点'})[action],`<p>${({count:'开始后暂停现金收款和退款，请清点钱箱。',accept:`确认收到现金 ${money(shift.actual_cents)}，并以此作为新班次备用金。请同时在服务工作台确认未完成任务。`,close:'确认结束当前班次；后续现金收款需重新开班。','cancel-count':'恢复当前班次现金收款，原盘点结果清除。'})[action]}</p>`,()=>post(path,{}));
  });
  document.querySelectorAll('[data-shift-detail]').forEach(button=>button.onclick=async()=>{
    try { const {shift}=await api(`/shifts/${button.dataset.shiftDetail}`);show(`班次 ${shift.id} 明细`, `<p>应有现金 ${money(shift.expected_cents)} · 实盘 ${money(shift.actual_cents)} · 差异 ${money(shift.variance_cents)}</p><p>${escape(shift.note)}</p><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>时间</th><th>类型 / 渠道</th><th>金额</th><th>关联及备注</th></tr></thead><tbody>${shift.ledger.map(row=>`<tr><td>${escape(row.timeLabel)}</td><td>${escape(row.kind)} / ${channels[row.channel]||escape(row.channel)}</td><td>${money(row.amount_cents)}</td><td>${escape(row.reference)} ${escape(row.note)}</td></tr>`).join('')}</tbody></table></div><p>最多显示最近1000条流水。</p>`,null);}
    catch(error){notify(error.message);}
  });
}
