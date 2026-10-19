import './logs-admin.css';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bytes=value=>value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(1)} MB`;
const range=filters=>`${filters.startAt?.replace('T',' ')||'不限'} 至 ${filters.endAt?.replace('T',' ')||'不限'}（结束时刻不含）`;

export function logsContent(data,{table,pagination,lastExport,account}) {
  const filters=data.filters,batch=lastExport?.ownerId===account.id?lastExport:null,expired=batch&&Date.parse(batch.expiresAt)<=Date.now();
  return `<section class="logs-panel"><form class="logs-filter" aria-label="日志筛选"><label>开始时间（含）<input name="startAt" type="datetime-local" value="${esc(filters.startAt)}"></label><label>结束时间（不含）<input name="endAt" type="datetime-local" value="${esc(filters.endAt)}"></label><label class="logs-keyword">搜索日志<input name="q" type="search" maxlength="100" placeholder="账号、操作或详情关键词" value="${esc(filters.q)}"></label><div class="logs-filter-actions"><button class="primary-small" type="submit">查询日志</button><button class="outline-button" type="button" data-logs-all>全部时间</button><button class="outline-button" type="submit" data-logs-export>导出筛选结果 Excel</button></div></form><p class="logs-error" role="alert"></p><div class="logs-summary"><span>匹配 <strong>${data.pagination.total}</strong> 条 / 共 ${data.storage.totalLogs} 条日志</span><span>业务数据库 ${bytes(data.storage.databaseBytes)} · 可复用 ${bytes(data.storage.reusableBytes)}</span></div><p class="logs-hint">时间按 ${esc(filters.timezone)}；单次最多导出 ${data.maxExport} 条，包含全部匹配记录，不限当前页。数据库大小包含订单等业务数据；清理日志后空间可复用，文件不一定立即缩小。</p>${batch?`<section class="logs-export-record" aria-label="本次导出"><div><strong>${batch.cleaned?'本次导出已清理':expired?'本次导出清理凭证已过期':'本次已导出'}</strong><span>${esc(batch.filename)} · ${batch.count} 条</span><small>${esc(range(batch.filters))}${batch.filters.q?' · 关键词：'+esc(batch.filters.q):''}</small><small>${batch.cleaned?`已删除 ${batch.deleted} 条，清理记录另行保留。`:'下载发起后请核对本地文件；清理凭证有效 24 小时，仅保留本账号最近 5 批。'}</small></div>${!batch.cleaned&&!expired?'<button class="logs-cleanup-button" type="button" data-logs-cleanup>删除本次已导出的日志</button>':''}</section>`:''}${table(['日志ID','时间','账号','操作','详情'],data.logs.map(row=>`<tr><td>${row.id}</td><td class="logs-time">${esc(row.displayTime)}</td><td>${esc(row.operator)}</td><td>${esc(row.action)}</td><td class="logs-detail">${esc(row.detail)}</td></tr>`).join(''))}${pagination('logs',data.pagination)}</section>`;
}

export function bindLogs({api,account,filters,lastExport,onFilter,onExport,onCleaned,onDialog,refresh,notify}) {
  const panel=document.querySelector('.logs-panel');if(!panel)return;
  let exporting=false;
  const form=panel.querySelector('.logs-filter'),error=panel.querySelector('.logs-error');
  const controls=disabled=>form.querySelectorAll('button,input').forEach(input=>input.disabled=disabled);
  const values=()=>Object.fromEntries(new FormData(form));
  form.onsubmit=async event=>{
    event.preventDefault();if(exporting)return;const selected=values();
    selected.q=selected.q.trim();error.textContent='';
    if(selected.startAt&&selected.endAt&&selected.startAt>=selected.endAt){error.textContent='结束时间必须晚于开始时间';return;}
    if(!event.submitter?.hasAttribute('data-logs-export'))return onFilter(selected);
    exporting=true;controls(true);error.textContent='正在生成 Excel，请稍等…';
    const token=sessionStorage.getItem('adminToken');
    try {
      const response=await fetch('/api/admin/logs/export?'+new URLSearchParams(selected),{headers:{Authorization:'Bearer '+token}});
      if(!response.ok){const result=await response.json();throw new Error(result.message||'日志导出失败');}
      const blob=await response.blob(),id=response.headers.get('x-log-export-id'),count=Number(response.headers.get('x-log-export-count')),expiresAt=response.headers.get('x-log-export-expires');
      if(!id||!count||!expiresAt)throw new Error('导出凭证缺失，请重新导出');
      if(sessionStorage.getItem('adminToken')!==token)return;
      const match=/filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition')||''),filename=match?decodeURIComponent(match[1]):'操作日志.xlsx';
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
      onExport({id,count,expiresAt,filename,ownerId:account.id,filters:{...selected,timezone:response.headers.get('x-log-export-timezone')||filters.timezone}});
      if(panel.isConnected){await onFilter(selected);notify(`已发起下载 ${count} 条日志；请保存并核对 Excel 后再清理`);}
    } catch(failure){error.textContent=failure.message;}
    finally {exporting=false;controls(false);}
  };
  panel.querySelector('[data-logs-all]').onclick=()=>onFilter({startAt:'',endAt:'',q:form.elements.q.value.trim()});
  panel.querySelector('[data-logs-cleanup]')?.addEventListener('click',()=>{
    const batch=lastExport;if(!batch||batch.ownerId!==account.id)return;
    const root=document.querySelector('#admin-dialog-root');let busy=false;
    onDialog(true);
    root.innerHTML=`<div class="admin-dialog-backdrop"><section class="admin-dialog logs-cleanup-dialog" role="dialog" aria-modal="true" aria-label="删除已导出的操作日志"><header><h2>删除本次已导出的日志</h2><button type="button" data-close-dialog aria-label="关闭">×</button></header><form><div class="dialog-fields"><p>将永久删除本次 Excel 中的 <strong>${batch.count} 条原日志</strong>。后续新增日志及订单、付款、库存数据不会删除。</p><p class="logs-export-filename">${esc(batch.filename)}</p><p>${esc(range(batch.filters))}${batch.filters.q?' · 关键词：'+esc(batch.filters.q):''}</p><label class="logs-save-confirm"><input name="confirmedSaved" type="checkbox" required>我已在本地保存并核对 Excel，确认删除这批操作日志</label><p class="dialog-hint">Excel 不能通过此页面重新导入；有追溯需要时请同时保留完整数据库备份。清理操作会另留日志。</p></div><p class="dialog-error" role="alert"></p><footer><button type="button" class="outline-button" data-close-dialog>暂不删除</button><button type="submit" class="logs-danger-button">确认删除已导出日志</button></footer></form></section></div>`;
    const close=()=>{if(busy)return;root.replaceChildren();onDialog(false);};
    root.querySelectorAll('[data-close-dialog]').forEach(button=>button.onclick=close);
    root.querySelector('.admin-dialog-backdrop').onclick=event=>{if(event.target.classList.contains('admin-dialog-backdrop'))close();};
    root.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;busy=true;const dialog=event.currentTarget,confirmedSaved=dialog.elements.confirmedSaved.checked;
      root.querySelectorAll('button,input').forEach(input=>input.disabled=true);
      try {
        const result=await api(`/logs/exports/${batch.id}/cleanup`,{method:'POST',body:JSON.stringify({confirmedSaved})});
        onCleaned({...batch,cleaned:true,deleted:result.deleted});busy=false;close();await refresh();notify(`已删除 ${result.deleted} 条已导出日志，业务数据保留`);
      } catch(failure){dialog.querySelector('.dialog-error').textContent=failure.message;busy=false;root.querySelectorAll('button,input').forEach(input=>input.disabled=false);}
    };
    root.querySelector('[name="confirmedSaved"]').focus({preventScroll:true});
  });
}
