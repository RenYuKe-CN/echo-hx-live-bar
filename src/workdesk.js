import './workdesk.css';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid = () => crypto.randomUUID();
const time = value => value ? new Date(value.includes('T') ? value : value.replace(' ','T')+'Z').getTime() : Date.now();
const manager = account => ['super','manager'].includes(account.role);
const labels = { waiting:'待接单',preparing:'配货中',ready:'待配送',delivering:'配送中',completed:'已完成',delivered:'已送达',cancelled:'已取消',refunded:'已退款',claimed:'处理中' };

export function mountWorkdesk({ root, account, api, brand, logout, switchWorkspace }) {
  let data = null, cursor = 0, initialized = false, destroyed = false, refreshVersion = 0, connected = false;
  let tab = 'orders', filter = 'waiting', sound = false, audio = null, lastOverdueReminder = 0;
  const serviceNotes = new Map();
  const busy = new Set(), drafts = new Map(), commands = new Map(), seenEvents = new Set();
  root.innerHTML = `<main class="wd-root"><header class="wd-header"><div><span class="wd-brand">${esc(brand)}</span><h1>服务工作台</h1><p>${esc(account.displayName)} · 每批配送、每项服务都有负责人</p></div><div class="wd-header-actions"><button data-wd-sound>开启声音提醒</button>${account.permissions.includes('pos')?'<button data-wd-cashier>收银工作台</button>':''}${account.permissions.some(permission=>!['workdesk','pos'].includes(permission))?`<button data-wd-admin>${account.workspace==='admin'?'管理后台':'其他业务'}</button>`:''}<button data-wd-password>修改密码</button><button data-wd-refresh>刷新</button><button data-wd-logout>退出</button></div></header><div class="wd-connection" role="status">正在同步任务…</div><div class="wd-kpis"></div><nav class="wd-tabs"><button data-wd-tab="orders" class="active">订单任务</button><button data-wd-tab="services">顾客服务</button><button data-wd-tab="mine">我的任务</button>${manager(account)?'<button data-wd-tab="settings">提醒设置</button>':''}</nav><div class="wd-filters"></div><section class="wd-list"></section><div class="wd-toast" role="status" hidden></div><div class="wd-modal-root"></div></main>`;
  const q = selector => root.querySelector(selector);
  let toastTimer;
  const toast = message => { if(destroyed)return;const el=q('.wd-toast'); if(!el)return;el.textContent=message;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{if(el)el.hidden=true;},4500); };
  async function request(path,options={}) { const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);try{return await api('/workdesk'+path,{...options,signal:controller.signal});}finally{clearTimeout(timer);} }
  function connection(ok, message) { connected=ok;const el=q('.wd-connection');if(el){el.textContent=message;el.classList.toggle('offline',!ok);} }
  function play() { if(!sound||!audio)return; try { const start=audio.currentTime;for(let n=0;n<2;n++){const oscillator=audio.createOscillator(),gain=audio.createGain();oscillator.type='sine';oscillator.frequency.value=n?880:660;gain.gain.setValueAtTime(.12,start+n*.23);gain.gain.exponentialRampToValueAtTime(.001,start+n*.23+.18);oscillator.connect(gain);gain.connect(audio.destination);oscillator.start(start+n*.23);oscillator.stop(start+n*.23+.2);} }catch{toast('声音提醒暂不可用，请查看待接任务');} }
  function overdue(value, minutes) { return Date.now()-time(value)>Number(minutes)*60000; }
  function ago(value) { const minutes=Math.max(0,Math.floor((Date.now()-time(value))/60000));return minutes?`等待 ${minutes} 分钟`:'刚刚收到'; }
  function orderDraft(order) { let draft=drafts.get(order.id);if(!draft){draft={};drafts.set(order.id,draft);}for(const item of order.items){if(draft[item.id]==null)draft[item.id]=item.unpreparedQuantity;else draft[item.id]=Math.min(draft[item.id],item.unpreparedQuantity);}return draft; }
  function button(action,id,label,disabled=false,extra='') { return `<button class="wd-action" data-action="${action}" data-id="${id}" ${extra} ${disabled||!connected?'disabled':''}>${label}</button>`; }
  function transfer(kind,id,version) { return manager(account)?`<button class="wd-secondary" data-action="transfer" data-kind="${kind}" data-id="${id}" data-revision="${version}">转交任务</button>`:''; }
  function orderCard(order) {
    const draft=orderDraft(order), own=order.preparationStaffId===account.id;
    const late=['waiting','preparing'].includes(order.state)&&overdue(order.paidAt,data.settings.preparation_minutes);
    const header=`<header><div><h2>${esc(order.tableNo)} 桌</h2><span>${esc(order.orderNo)}</span></div><span class="wd-state ${order.state}">${labels[order.state]}</span></header><div class="wd-meta"><span class="${late?'wd-late':''}">${order.state==='completed'?'已完成':ago(order.paidAt)}${late&&order.state!=='completed'?' · 已超时':''}</span><span>${order.preparationStaff?`配货：${esc(order.preparationStaff)}`:order.state==='completed'?'历史记录':'尚未有人接单'}</span></div>`;
    const items=order.items.map(item=>`<div class="wd-item"><div><strong>${esc(item.name)}</strong><span>原订 ${item.quantity} · 已送 ${item.deliveredQuantity} · 已退 ${item.returnedQuantity} · 待配 ${item.unpreparedQuantity}</span></div>${own&&item.unpreparedQuantity>0&&!order.paused?`<label class="wd-quantity">本批应配<input type="number" inputmode="numeric" min="0" max="${item.unpreparedQuantity}" value="${draft[item.id]}" data-order="${order.id}" data-item="${item.id}" aria-label="${esc(item.name)}本批配货数量"></label>`:item.unpreparedQuantity>0?`<span class="wd-unprepared">待配 ${item.unpreparedQuantity} 件</span>`:''}</div>`).join('');
    const batches=order.batches.map(batch=>`<section class="wd-batch ${batch.status}"><div><strong>${esc(batch.number)} · ${labels[batch.status]}</strong><span class="wd-batch-goods">本批商品：${esc(batch.items.map(item=>`${item.name} ×${item.quantity}`).join('、'))}</span>${batch.status==='ready'?`<span class="${overdue(batch.createdAt,data.settings.delivery_minutes)?'wd-late':''}">${ago(batch.createdAt)} · 等待领取</span>`:''}${batch.deliveryStaff?`<span class="${batch.status==='delivering'&&overdue(batch.claimedAt,data.settings.delivery_minutes)?'wd-late':''}">配送：${esc(batch.deliveryStaff)} · ${batch.status==='delivered'?'已送达':ago(batch.claimedAt)}${batch.status==='delivering'&&overdue(batch.claimedAt,data.settings.delivery_minutes)?' · 请核实配送进度':''}</span>`:''}</div><div class="wd-batch-actions">${batch.status==='ready'?button('claim-batch',batch.id,'领取配送',order.paused||busy.has('batch-'+batch.id)):batch.status==='delivering'&&batch.deliveryStaffId===account.id?button('complete-batch',batch.id,'确认实际送达',busy.has('batch-'+batch.id)):''}${batch.status==='delivering'?transfer('delivery',batch.id,order.revision):''}${manager(account)&&['ready','delivering'].includes(batch.status)?`<button class="wd-secondary" data-action="recall" data-id="${batch.id}" data-revision="${order.revision}">核实归还并召回</button>`:''}</div></section>`).join('');
    const controls=order.state==='waiting'?button('claim-order',order.id,'接单配货',order.paused||busy.has('order-'+order.id)):own&&order.items.some(item=>item.unpreparedQuantity>0)?`${button('ready',order.id,'配齐待取',order.paused||busy.has('order-'+order.id))}${button('ready-send',order.id,'配齐并配送',order.paused||busy.has('order-'+order.id))}`:'';
    return `${header}${order.note?`<p class="wd-note"><b>订单备注</b> ${esc(order.note)}</p>`:''}${order.paused?`<p class="wd-paused">${esc(order.pausedReason)}，暂缓新的配货和领取配送。</p>`:''}<div class="wd-items">${items}</div>${batches}<footer>${controls}${manager(account)&&order.paused&&order.pausedReason!=='退款处理中'?`<button class="wd-secondary" data-action="resume" data-id="${order.id}" data-revision="${order.revision}">核实后恢复配货</button>`:''}${order.state!=='completed'&&order.preparationStaffId?transfer('preparation',order.id,order.revision):''}</footer>`;
  }
  function serviceCard(item) {
    const late=item.status!=='completed'&&overdue(item.createdAt,data.settings.service_minutes);
    return `<header><div><h2>${esc(item.tableNo)} 桌 · ${esc(item.title)}</h2><span>${esc(item.number)}</span></div><span class="wd-state ${item.status}">${labels[item.status]}</span></header><div class="wd-meta"><span class="${late?'wd-late':''}">${item.status==='completed'?'已处理 · '+new Date(time(item.completedAt)).toLocaleTimeString('zh-CN',{hour12:false}):ago(item.createdAt)}${late?' · 已超时':''}</span><span>${item.assignedStaff?`处理：${esc(item.assignedStaff)}`:'等待服务员领取'}</span></div>${item.callCount>1?`<p class="wd-call-count">顾客已呼叫 ${item.callCount} 次，请核对最新需求</p>`:''}${item.notes.length?`<div class="wd-service-notes">${item.notes.map(note=>`<p>${esc(note.content)}</p>`).join('')}</div>`:'<p class="wd-service-notes">顾客需要服务员到桌边协助。</p>'}${item.completionNote?`<p class="wd-note">处理说明：${esc(item.completionNote)}</p>`:''}${item.status==='claimed'&&item.assignedStaffId===account.id?`<label class="wd-completion">处理说明（可选）<input maxlength="300" data-service-note="${item.id}" value="${esc(serviceNotes.get(item.id)||'')}" placeholder="如：已补充纸巾"></label>`:''}<footer>${item.status==='waiting'?button('claim-service',item.id,'领取需求',busy.has('service-'+item.id)):item.status==='claimed'&&item.assignedStaffId===account.id?button('complete-service',item.id,'处理完成',busy.has('service-'+item.id)):''}${item.status!=='completed'?transfer('service',item.id,item.revision):''}</footer>`;
  }
  function reconcile(rows,render) {
    const list=q('.wd-list'),ids=new Set(rows.map(row=>row.cardKey||String(row.id)));
    list.querySelector('.wd-empty')?.remove();
    for(const card of [...list.children])if(!ids.has(card.dataset.key))card.remove();
    for(const row of rows){const key=row.cardKey||String(row.id);let card=list.querySelector(`[data-key="${key}"].wd-card`);if(!card){card=document.createElement('article');card.className='wd-card';card.dataset.id=row.id;card.dataset.key=key;list.append(card);}const html=render(row);if(card._html===html)continue;
      const active=document.activeElement,focused=card.contains(active)&&active.matches('input'), focusItem=focused?active.dataset.item:null, focusService=focused?active.dataset.serviceNote:null, value=focused?active.value:null;
      const selection=focused&&active.type!=='number'?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;
      card.innerHTML=html;card._html=html;
      if(focusItem||focusService){const input=card.querySelector(focusItem?`[data-item="${focusItem}"]`:`[data-service-note="${focusService}"]`);if(input){input.value=value;input.focus({preventScroll:true});if(selection&&selection[0]!==null)input.setSelectionRange(...selection);}}
    }
    if(!rows.length)list.innerHTML='<div class="wd-empty">当前没有这类任务，新任务会自动同步到这里。</div>';
  }
  function render() {
    if(destroyed||!data)return;
    const mineOrders=data.orders.filter(o=>o.preparationStaffId===account.id&&o.items.some(item=>item.unpreparedQuantity>0)||o.batches.some(b=>b.status==='delivering'&&b.deliveryStaffId===account.id));
    const mineServices=data.requests.filter(r=>r.status==='claimed'&&r.assignedStaffId===account.id);
    q('.wd-kpis').innerHTML=[['待接订单',data.orders.filter(o=>o.state==='waiting').length,'orders','waiting'],['待取配送',data.orders.flatMap(o=>o.batches).filter(b=>b.status==='ready').length,'orders','delivery'],['服务待接',data.requests.filter(r=>r.status==='waiting').length,'services','waiting'],['我的任务',mineServices.length+mineOrders.length,'mine','waiting']].map(([label,count,target,stage])=>`<button data-quick-tab="${target}" data-quick-filter="${stage}"><span>${label}</span><strong>${count}</strong></button>`).join('');
    q('.wd-tabs').querySelectorAll('button').forEach(el=>el.classList.toggle('active',el.dataset.wdTab===tab));
    const filters=tab==='orders'?[['waiting','待接单'],['preparing','配货中'],['delivery','待配送'],['mine','我的任务'],['completed','已完成']]:[['waiting','待响应'],['claimed','处理中'],['mine','我的任务'],['completed','已完成']];
    q('.wd-filters').innerHTML=['settings','mine'].includes(tab)?'':filters.map(([key,label])=>`<button class="${key===filter?'active':''}" data-filter="${key}">${label}</button>`).join('');
    if(tab==='settings') {const list=q('.wd-list');if(!list.querySelector('.wd-settings'))list.innerHTML=`<form class="wd-settings"><h2>超时只提醒，任务不会自动重新派单</h2>${[['service_minutes','服务请求'],['preparation_minutes','配货'],['delivery_minutes','配送']].map(([key,label])=>`<label>${label}超过<input name="${key}" type="number" min="1" max="120" value="${data.settings[key]}" required>分钟提醒</label>`).join('')}<button>保存提醒设置</button></form>`;return;}
    if(tab==='mine') {
      const rows=[...mineOrders.map(order=>({...order,cardKey:'order-'+order.id,taskKind:'order'})),...mineServices.map(item=>({...item,cardKey:'service-'+item.id,taskKind:'service'}))].sort((a,b)=>time(a.paidAt||a.createdAt)-time(b.paidAt||b.createdAt));
      reconcile(rows,row=>row.taskKind==='order'?orderCard(row):serviceCard(row));return;
    }
    if(tab==='orders') {
      const rows=filter==='completed'?data.completedOrders:data.orders.filter(o=>filter==='mine'?(o.preparationStaffId===account.id||o.batches.some(b=>b.status==='delivering'&&b.deliveryStaffId===account.id)):filter==='delivery'?o.batches.some(b=>b.status==='ready'||b.status==='delivering'):o.state===filter);
      reconcile(rows,orderCard);
    } else reconcile(data.requests.filter(item=>filter==='mine'?item.assignedStaffId===account.id&&item.status!=='completed':item.status===filter),serviceCard);
  }
  async function refresh() {
    if(destroyed)return;const version=++refreshVersion;
    try {const result=await request(`?after=${cursor}`);if(destroyed||version!==refreshVersion)return;
      const newcomers=result.events.filter(event=>!seenEvents.has(event.id)&&(
        event.kind==='order_new'&&result.orders.some(order=>order.id===event.entity_id&&order.state==='waiting')
        ||event.kind==='batch_ready'&&result.orders.some(order=>order.batches.some(batch=>batch.id===event.entity_id&&batch.status==='ready'))
        ||event.kind==='service_transfer'&&result.requests.some(item=>item.id===event.entity_id&&item.assignedStaffId===account.id&&item.status==='claimed')
        ||event.kind==='preparation_transfer'&&result.orders.some(order=>order.id===event.entity_id&&order.preparationStaffId===account.id)
        ||event.kind==='delivery_transfer'&&result.orders.some(order=>order.batches.some(batch=>batch.id===event.entity_id&&batch.deliveryStaffId===account.id&&batch.status==='delivering'))
        ||['service_new','service_note'].includes(event.kind)&&result.requests.some(item=>item.id===event.entity_id&&item.status!=='completed'&&(!item.assignedStaffId||item.assignedStaffId===account.id))
      ));
      result.events.forEach(event=>seenEvents.add(event.id));cursor=result.cursor;data=result;if(result.storeName){q('.wd-brand').textContent=result.storeName;document.title=result.storeName+' · 服务工作台';}
      connection(true,`已连接 · 最近同步 ${new Date().toLocaleTimeString('zh-CN',{hour12:false})} · 保持工作台在前台接单`);
      if(initialized&&newcomers.length){toast(`收到 ${newcomers.length} 项新任务、待取配送或需求更新，请核对待接任务`);play();}
      const overdueCount=result.requests.filter(item=>item.status!=='completed'&&(!item.assignedStaffId||item.assignedStaffId===account.id)&&overdue(item.createdAt,result.settings.service_minutes)).length
        +result.orders.filter(order=>(!order.preparationStaffId||order.preparationStaffId===account.id)&&order.items.some(item=>item.unpreparedQuantity>0)&&overdue(order.paidAt,result.settings.preparation_minutes)).length
        +result.orders.flatMap(order=>order.batches).filter(batch=>(batch.status==='ready'||batch.status==='delivering'&&batch.deliveryStaffId===account.id)&&overdue(batch.claimedAt||batch.createdAt,result.settings.delivery_minutes)).length;
      if(initialized&&overdueCount&&Date.now()-lastOverdueReminder>60000){lastOverdueReminder=Date.now();toast(`有 ${overdueCount} 项任务已超时，请核对处理进度`);play();}
      initialized=true;render();
    } catch(error){if(destroyed||version!==refreshVersion)return;connection(false,error.status===401||error.status===403?'登录或权限已变化，请重新登录':'连接中断，任务仍保留，正在重试；暂勿重复拿货。');render();}
  }
  async function act(key,path,body) {
    if(destroyed||busy.has(key))return;if(!connected){toast('请先恢复连接并核对任务状态');return;}
    let saved=false;
    busy.add(key);render();
    try {await request(path,{method:'POST',body:JSON.stringify(body)});saved=true;if(path.endsWith('/claim')||path.endsWith('/batches')&&body.startDelivery){tab='mine';filter='waiting';}toast('操作已保存');}
    catch(error){toast((error.message||'请求失败')+'；正在核对服务器状态，请勿重复拿货。');}
    finally {
      busy.delete(key);await refresh();
      const ownOrders=data?.orders.some(order=>order.preparationStaffId===account.id&&order.items.some(item=>item.unpreparedQuantity>0)||order.batches.some(batch=>batch.status==='delivering'&&batch.deliveryStaffId===account.id));
      const ownServices=data?.requests.some(item=>item.status==='claimed'&&item.assignedStaffId===account.id);
      if(saved&&path.endsWith('/complete')&&tab==='mine'&&!ownOrders&&!ownServices){
        const nextOrder=data.orders.find(order=>order.state==='waiting'),nextService=data.requests.find(item=>item.status==='waiting');
        tab=nextService&&(!nextOrder||time(nextService.createdAt)<time(nextOrder.paidAt))?'services':'orders';filter='waiting';render();
      }
    }
    return saved;
  }
  const handleInput=event=>{if(destroyed)return;const input=event.target;if(input.dataset.serviceNote)serviceNotes.set(Number(input.dataset.serviceNote),input.value);if(input.dataset.item){const draft=drafts.get(Number(input.dataset.order));if(draft)draft[input.dataset.item]=Number(input.value);}};
  const handleClick=async event=>{
    if(destroyed)return;
    const buttonEl=event.target.closest('button');if(!buttonEl)return;
    if(buttonEl.dataset.quickTab){tab=buttonEl.dataset.quickTab;filter=buttonEl.dataset.quickFilter;q('.wd-list').replaceChildren();render();return;}
    if(buttonEl.dataset.wdTab){tab=buttonEl.dataset.wdTab;filter='waiting';q('.wd-list').replaceChildren();render();return;}
    if(buttonEl.dataset.filter){filter=buttonEl.dataset.filter;render();return;}
    if(buttonEl.hasAttribute('data-wd-refresh'))return refresh();
    if(buttonEl.hasAttribute('data-wd-logout'))return logout();
    if(buttonEl.hasAttribute('data-wd-admin'))return switchWorkspace('admin');
    if(buttonEl.hasAttribute('data-wd-cashier'))return switchWorkspace('cashier');
    if(buttonEl.hasAttribute('data-wd-password')) {
      q('.wd-modal-root').innerHTML='<div class="wd-modal-mask"><form class="wd-password wd-transfer"><h2>修改自己的密码</h2><label>当前密码<input name="oldPassword" type="password" required></label><label>新密码（至少10位）<input name="newPassword" type="password" minlength="10" required></label><footer><button type="button" data-wd-close>取消</button><button>保存密码</button></footer></form></div>';
      q('[data-wd-close]').onclick=()=>q('.wd-modal-root').replaceChildren();
      q('.wd-password').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await api('/change-password',{method:'POST',body:JSON.stringify(values)});q('.wd-modal-root').replaceChildren();toast('密码已修改');}catch(error){toast(error.message);}};
      return;
    }
    if(buttonEl.hasAttribute('data-wd-sound')){try{audio=audio||new(window.AudioContext||window.webkitAudioContext)();await audio.resume();sound=!sound;buttonEl.textContent=sound?'声音提醒已开启':'开启声音提醒';if(sound)play();}catch{toast('当前浏览器无法播放提示声，请查看工作台提醒');}return;}
    const action=buttonEl.dataset.action,id=Number(buttonEl.dataset.id);if(!action)return;
    const order=data.orders.find(row=>row.id===id),service=data.requests.find(row=>row.id===id);
    if(action==='claim-order')return act('order-'+id,`/orders/${id}/claim`,{revision:order.revision});
    if(action==='ready'||action==='ready-send'){
      const draft=orderDraft(order),items=order.items.filter(item=>draft[item.id]>0).map(item=>({orderItemId:item.id,quantity:draft[item.id]}));
      if(!items.length)return toast('请填写本批配齐的商品数量');
      if(items.some(item=>!Number.isSafeInteger(item.quantity)))return toast('商品数量须为整数');
      const fingerprint=JSON.stringify([id,items,action]);let command=commands.get(id);if(command?.fingerprint!==fingerprint){command={fingerprint,requestId:uuid()};commands.set(id,command);}
      const saved=await act('order-'+id,`/orders/${id}/batches`,{items,revision:order.revision,startDelivery:action==='ready-send',requestId:command.requestId});
      if(saved&&commands.get(id)===command)commands.delete(id);
      return;
    }
    if(action==='claim-batch')return act('batch-'+id,`/batches/${id}/claim`,{});
    if(action==='complete-batch'){const target=[...data.orders,...data.completedOrders].find(order=>order.batches.some(batch=>batch.id===id));const batch=target?.batches.find(row=>row.id===id);if(!target||!batch)return toast('任务状态已更新，请先刷新');if(!window.confirm(`${target.tableNo} 桌 · ${batch.number}\n${batch.items.map(item=>`${item.name} ×${item.quantity}`).join('、')}\n确认这些商品已实际送到这张桌上？`))return;return act('batch-'+id,`/batches/${id}/complete`,{});}
    if(action==='recall'||action==='resume'){
      const reason=window.prompt(action==='recall'?'仅在实物已核对并归还吧台后操作。填写归还说明（会暂停这张订单的新配送）：':'核对商品与退款情况后恢复，填写恢复原因：','');if(!reason?.trim())return;
      return act(action+'-'+id,action==='recall'?`/batches/${id}/recall`:`/orders/${id}/resume`,{reason,revision:Number(buttonEl.dataset.revision)});
    }
    if(action==='claim-service')return act('service-'+id,`/requests/${id}/claim`,{revision:service.revision});
    if(action==='complete-service'){
      const note=serviceNotes.get(id)||'';
      return act('service-'+id,`/requests/${id}/complete`,{revision:service.revision,note});
    }
    if(action==='transfer'){
      const kind=buttonEl.dataset.kind,version=Number(buttonEl.dataset.revision);
      q('.wd-modal-root').innerHTML=`<div class="wd-modal-mask"><form class="wd-transfer"><h2>转交任务</h2><p>先核对实物与原处理人，避免重复配送。</p><label>接手员工<select name="targetId">${data.operators.map(operator=>`<option value="${operator.id}">${esc(operator.name)}</option>`).join('')}</select></label><label>转交原因<textarea name="reason" maxlength="300" required></textarea></label><footer><button type="button" data-wd-close>取消</button><button>确认转交</button></footer></form></div>`;
      q('[data-wd-close]').onclick=()=>q('.wd-modal-root').replaceChildren();
      q('.wd-transfer').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));q('.wd-modal-root').replaceChildren();await act('transfer-'+id,'/transfer',{kind,id,revision:version,targetId:Number(values.targetId),reason:values.reason});};
    }
  };
  const handleSubmit=async event=>{if(!event.target.matches('.wd-settings'))return;event.preventDefault();const values=Object.fromEntries(new FormData(event.target));try{await request('/settings',{method:'PATCH',body:JSON.stringify(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,Number(value)])))});toast('提醒设置已保存');await refresh();}catch(error){toast(error.message);}};
  root.addEventListener('input',handleInput);root.addEventListener('click',handleClick);root.addEventListener('submit',handleSubmit);
  const visible=()=>{if(!document.hidden)refresh();};document.addEventListener('visibilitychange',visible);
  const timer=setInterval(()=>{if(!document.hidden)refresh();},3000);
  refresh();
  return {refresh,destroy(){if(destroyed)return;destroyed=true;clearInterval(timer);clearTimeout(toastTimer);root.removeEventListener('input',handleInput);root.removeEventListener('click',handleClick);root.removeEventListener('submit',handleSubmit);document.removeEventListener('visibilitychange',visible);if(audio&&audio.state!=='closed')audio.close().catch(()=>{});}};
}
