import './style.css';
import './price-overrides.css';
import './membership-rules.css';
import './payment-sheet.css';
import './admin-operations.css';
import './mini-page-admin.css';
import './report-trend.css';
import './order-note.css';

let products = [
  { name: '精酿啤酒', detail: '冷藏 330ml', price: 38, memberPrice: 34, category: '啤酒', tag: '热销', color: 'amber' },
  { name: '金汤力', detail: '杜松子酒 · 汤力水', price: 68, memberPrice: 61, category: '鸡尾酒', tag: '推荐', color: 'teal' },
  { name: '百威啤酒', detail: '冰镇 330ml', price: 28, memberPrice: 25, category: '啤酒', tag: '会员专享', color: 'red' },
  { name: '芝士薯条', detail: '现炸小食', price: 42, memberPrice: 38, category: '小吃', tag: '下酒菜', color: 'yellow' },
  { name: '威士忌套餐', detail: '700ml · 适合分享', price: 688, memberPrice: 619, category: '套餐', tag: '分享装', color: 'purple' },
  { name: '西柚气泡', detail: '无酒精特调', price: 32, memberPrice: 29, category: '无酒精', tag: '清爽', color: 'pink' }
];

const state = { cart: [], category: '推荐', toast: '', paymentOpen: false, upgradeOpen: false, packages: [], paymentMethod: 'balance', checkout: null, sessionId: null, user: null, membership: null, table: null, miniPage: {}, loading: true };

function money(value) { return `¥${value.toFixed(2)}`; }

function cartTotals() {
  const original = state.cart.reduce((sum, item) => sum + products[item.index].price * item.qty, 0);
  const member = state.cart.reduce((sum, item) => sum + (state.membership?.active ? products[item.index].memberPrice : products[item.index].price) * item.qty, 0);
  return { original, member, discount: original - member, points: Math.floor(member * (state.membership?.pointsRate ?? 1)) };
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem('adminToken');
  const isGet = !options.method || options.method.toUpperCase() === 'GET';
  const requestPath = isGet ? `${path}${path.includes('?') ? '&' : '?'}_ts=${Date.now()}` : path;
  const response = await fetch(`/api${requestPath}`, { ...options, cache: isGet ? 'no-store' : 'default', headers: { 'Content-Type': 'application/json', 'x-demo-user-id': '1', ...(token && path.startsWith('/admin') ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('接口返回了网页，请检查 API 服务和 /api 代理配置');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '请求失败');
  return data;
}

async function loadData() {
  try {
    const [productData, sessionData, pageData] = await Promise.all([api('/products?storeId=1'), api('/tables/A-08/session'), api('/mini-page')]);
    state.miniPage = Object.fromEntries(pageData.entries.map(entry => [entry.key, entry.title]));
    products = productData.products.filter(product => product.status === 'active' && Number(product.stock) > 0);
    state.sessionId = sessionData.session.id;
    state.user = sessionData.user;
    state.membership = sessionData.membership;
    state.table = sessionData.table;
    await refreshCart();
  } catch (error) {
    console.error(error);
    showToast('暂时无法连接服务，请稍后重试');
  } finally {
    state.loading = false;
    renderCustomer();
  }
}

async function refreshCart() {
  if (!state.sessionId) return;
  const data = await api(`/sessions/${state.sessionId}/cart`);
  state.cart = data.items.map(item => ({ ...item, index: products.findIndex(product => product.id === item.product_id), qty: item.quantity }));
}

function renderCustomer() {
  document.querySelector('#app').innerHTML = `
    <main class="phone-shell">
      <header class="mobile-header">
        <div><span class="eyebrow">${escapeHtml(state.miniPage.app_name || 'Echo HX Live Bar')}</span><h1>${escapeHtml(state.miniPage.home_title || '今晚喝点什么？')}</h1></div>
        <button class="avatar-button" title="会员中心">L</button>
      </header>
      <section class="table-banner">
        <div><span class="muted">当前桌台</span><strong>${state.table?.tableNo || 'A-08'} · 多人点单</strong></div>
        <span class="live-dot">进行中</span>
      </section>
      <section class="membership-strip">
        <div class="member-mark">${state.user?.member_level?.slice(0, 1) || '会'}</div>
        <div><strong>${state.membership?.active ? state.user?.member_level : '普通会员'}${state.membership?.active && state.user?.member_expires_at ? ` · 有效期至 ${state.user.member_expires_at.slice(0, 10).replaceAll('-', '.')}` : ''}</strong><span>${state.membership?.active ? '本单享会员价，' : ''}支付后预计获得 ${cartTotals().points} 积分</span></div>
        <button class="text-button">查看权益 →</button>
      </section>
      ${!state.loading && !state.membership?.active ? '<div class="upgrade-banner"><span>当前按原价结算，是否充值余额并升级会员？</span><button class="text-button" data-upgrade>查看储值套餐</button></div>' : ''}
      <nav class="category-tabs">${['推荐', '啤酒', '鸡尾酒', '小吃', '套餐'].map(c => `<button class="${state.category === c ? 'active' : ''}" data-category="${c}">${c}</button>`).join('')}</nav>
      <section class="product-list">${products.filter(p => state.category === '推荐' || p.category === state.category).map(productCard).join('')}</section>
      <section class="order-dock">
        <div class="dock-total"><span class="muted">本桌待支付${state.membership?.active ? ` · ${escapeHtml(state.user?.member_level)}价` : ' · 原价'}</span><div>${state.membership?.active && cartTotals().discount ? `<del>${money(cartTotals().original)}</del>` : ''}<strong>${money(cartTotals().member)}</strong></div><small>${state.membership?.active ? `已优惠 ${money(cartTotals().discount)}` : '充值余额升级后享会员价'}</small></div>
        <button class="primary-button" id="pay-button">支付本桌订单 ${state.cart.length ? `(${state.cart.reduce((s, i) => s + i.qty, 0)})` : ''}</button>
      </section>
      <nav class="bottom-nav"><button class="selected">⌂<span>点单</span></button><button>▦<span>桌台订单</span></button><button>♙<span>会员中心</span></button></nav>
    </main>
    ${state.paymentOpen ? paymentSheet() : ''}
    ${state.upgradeOpen ? upgradeSheet() : ''}
    ${state.toast ? `<div class="toast">${state.toast}</div>` : ''}
  `;
  document.querySelectorAll('[data-category]').forEach(btn => btn.onclick = () => { state.category = btn.dataset.category; renderCustomer(); });
  document.querySelectorAll('[data-add]').forEach(btn => btn.onclick = () => changeCart(Number(btn.dataset.add), 1));
  document.querySelectorAll('[data-minus]').forEach(btn => btn.onclick = () => changeCart(Number(btn.dataset.minus), -1));
  document.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => removeFromCart(Number(btn.dataset.remove)));
  document.querySelectorAll('[data-upgrade]').forEach(button => button.onclick = async () => {
    try {
      const data = await api('/wallet-packages');
      state.packages = data.packages;
      state.paymentOpen = false;
      state.upgradeOpen = true;
      renderCustomer();
    } catch (error) { showToast(error.message); }
  });
  document.querySelector('#close-upgrade')?.addEventListener('click', () => { state.upgradeOpen = false; renderCustomer(); });
  document.querySelector('#pay-button').onclick = async () => {
    if (!state.cart.length) return showToast('先选几样喜欢的酒吧');
    try {
      state.checkout = await api(`/sessions/${state.sessionId}/checkout`);
      const bonusUsable = Number(state.checkout.bonusUsable ?? Math.min(Number(state.checkout.bonus || 0), Number(state.checkout.bonusEligible || 0), Number(state.checkout.payable || 0)));
      const storedUsable = Number(state.checkout.storedUsable ?? Math.min(Number(state.checkout.stored || 0), Math.max(Number(state.checkout.payable || 0) - bonusUsable, 0)));
      const balanceDeduction = Number(state.checkout.balanceDeduction ?? bonusUsable + storedUsable);
      const wechatDue = Number(state.checkout.wechatDue ?? Math.max(Number(state.checkout.payable || 0) - balanceDeduction, 0));
      state.checkout = { ...state.checkout, accountBalance: Number(state.checkout.accountBalance ?? state.checkout.stored ?? 0), accountBonus: Number(state.checkout.accountBonus ?? state.checkout.bonus ?? 0), bonusUsable, storedUsable, balanceDeduction, wechatDue, balanceAvailable: state.checkout.balanceAvailable ?? wechatDue === 0, mixedPaymentAvailable: state.checkout.mixedPaymentAvailable ?? (balanceDeduction > 0 && wechatDue > 0) };
      state.paymentMethod = state.checkout.balanceAvailable ? 'balance' : state.checkout.mixedPaymentAvailable ? 'mixed' : 'wechat';
      state.paymentOpen = true;
      renderCustomer();
    } catch (error) { showToast(error.message); }
  };
  document.querySelector('#close-payment')?.addEventListener('click', () => { state.paymentOpen = false; renderCustomer(); });
  const paymentMethods = document.querySelector('.payment-methods');
  if (paymentMethods && state.paymentOpen) {
    const noteField = document.createElement('label');
    noteField.className = 'order-note-field';
    noteField.innerHTML = `<span>订单备注</span><textarea id="order-note" maxlength="200" placeholder="例如：少冰、送到 A 区，不超过 200 字">${escapeHtml(state.orderNote || '')}</textarea>`;
    paymentMethods.before(noteField);
  }
  document.querySelector('#confirm-payment')?.addEventListener('click', createOrder);
  document.querySelectorAll('[data-payment-method]').forEach(button => button.onclick = () => {
    if (button.dataset.paymentMethod === 'balance' && !state.checkout?.balanceAvailable) return showToast('余额不足，请选择组合支付或微信支付');
    state.paymentMethod = button.dataset.paymentMethod;
    renderCustomer();
  });
}

function paymentSheet() {
  const totals = cartTotals();
  const items = state.cart.map(item => {
    const product = products[item.index];
    return `<div class="payment-item"><div class="payment-product"><div class="mini-product-art ${product.color}">${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="">` : escapeHtml(product.name.slice(0, 1))}</div><div><strong>${escapeHtml(product.name)}</strong><small>${state.membership?.active && product.memberPrice < product.price ? `<del>${money(product.price * item.qty)}</del>` : ''}<b class="${state.membership?.active ? '' : 'regular-price'}">${money((state.membership?.active ? product.memberPrice : product.price) * item.qty)}</b></small>${!state.membership?.active ? `<small class="reference-price">会员价 ${money((product.referenceMemberPrice ?? product.price) * item.qty)}</small>` : ''}</div></div><div class="payment-item-actions"><div class="quantity-controls compact"><button data-minus="${item.index}" title="减少一份">−</button><b>${item.qty}</b><button data-add="${item.index}" title="增加一份">+</button></div><button class="remove-button" data-remove="${item.index}" title="移除商品">删除</button></div></div>`;
  }).join('');
  const checkout = state.checkout || {};
  const balanceDetail = `账户储值 ${money(checkout.accountBalance ?? checkout.stored ?? 0)} · 本单抵扣 ${money(checkout.balanceDeduction ?? 0)}`;
  const buttonText = state.paymentMethod === 'balance' ? `确认余额支付 ${money(totals.member)}` : state.paymentMethod === 'mixed' ? `余额抵扣 ${money(checkout.balanceDeduction ?? 0)}，微信支付 ${money(checkout.wechatDue ?? 0)}` : `创建待支付订单 ${money(totals.member)}`;
  return `<div class="payment-backdrop"><section class="payment-sheet"><div class="sheet-heading"><div><span class="eyebrow">ORDER PREVIEW</span><h2>确认本桌订单</h2><p>请确认商品、数量和优惠</p></div><button id="close-payment" class="close-button" title="关闭">×</button></div><div class="payment-table"><div class="payment-table-head"><span>商品清单</span><span>实付价</span></div>${items}</div><div class="payment-summary"><div><span>商品原价</span><strong>${money(totals.original)}</strong></div>${state.membership?.active ? `<div><span>会员优惠</span><strong class="discount">-${money(totals.discount)}</strong></div>` : '<div><span>当前身份</span><strong>普通会员</strong></div>'}<div class="payable-row"><span>应付金额</span><strong>${money(totals.member)}</strong></div></div><div class="payment-methods"><strong>支付方式</strong><button data-payment-method="mixed" class="payment-choice ${state.paymentMethod === 'mixed' ? 'selected' : ''}" ${!checkout.mixedPaymentAvailable ? 'disabled' : ''}><span>余额 + 微信支付<small>${balanceDetail} · 微信支付 ${money(checkout.wechatDue ?? 0)} · 赠金抵扣 ${money(checkout.bonusUsable ?? 0)}</small></span><b>${state.paymentMethod === 'mixed' ? '●' : '○'}</b></button><button data-payment-method="balance" class="payment-choice ${state.paymentMethod === 'balance' ? 'selected' : ''}" ${!checkout.balanceAvailable ? 'disabled' : ''}><span>余额支付<small>账户储值余额 ${money(checkout.accountBalance ?? checkout.stored ?? 0)} · 赠金 ${money(checkout.accountBonus ?? checkout.bonus ?? 0)} · 本单最多抵扣 ${money(checkout.balanceDeduction ?? 0)}</small></span><b>${state.paymentMethod === 'balance' ? '●' : '○'}</b></button><button data-payment-method="wechat" class="payment-choice ${state.paymentMethod === 'wechat' ? 'selected' : ''}"><span>仅微信支付<small>不使用账户余额，接口尚未接通</small></span><b>${state.paymentMethod === 'wechat' ? '●' : '○'}</b></button></div><button id="confirm-payment" class="payment-button">${buttonText}</button></section></div>`;
}

function productCard(product) {
  const index = products.indexOf(product);
  const item = state.cart.find(i => i.index === index);
  const remaining = Math.max(Number(product.stock || 0) - (item?.qty || 0), 0);
  const controls = item ? `<div class="quantity-controls"><button data-minus="${index}" title="减少一份">−</button><b>${item.qty}</b><button data-add="${index}" title="增加一份" ${remaining < 1 ? 'disabled' : ''}>+</button></div>` : `<button class="add-button" data-add="${index}" title="加入订单" ${product.stock < 1 ? 'disabled' : ''}>+</button>`;
  const price = state.membership?.active ? `${product.memberPrice < product.price ? `<del>${money(product.price)}</del>` : ''}<strong>${money(product.memberPrice)}</strong><small>会员价</small>` : `<strong class="regular-price">${money(product.price)}</strong><small>会员价 ${money(product.referenceMemberPrice ?? product.price)}</small>`;
  return `<article class="product-card"><div class="product-art ${product.color}">${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="">` : `<span>${escapeHtml(product.tag || '')}</span><b>${escapeHtml(product.name.slice(0, 1))}</b>`}</div><div class="product-info"><div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.detail)}</p><small class="stock-label ${Number(product.stock) <= 5 ? 'stock-low' : ''}">剩余库存 ${product.stock} 件${item ? ` · 还可选 ${remaining} 件` : ''}</small></div><div class="product-buy"><div class="price-group">${price}</div>${controls}</div></div></article>`;
}

function upgradeSheet() {
  return `<div class="payment-backdrop"><section class="payment-sheet" role="dialog" aria-modal="true" aria-label="会员充值"><div class="sheet-heading"><h2>会员充值</h2><button id="close-upgrade" class="close-button" title="关闭">×</button></div>${state.packages.map(p => `<div class="payment-item"><div><strong>${escapeHtml(p.name)}</strong><p>储值 ${money(p.stored)} + 赠金 ${money(p.bonus)}</p><p>支付 ${money(p.pay)}</p></div><b>合计到账 ${money((Math.round(p.stored * 100) + Math.round(p.bonus * 100)) / 100)}</b></div>`).join('') || '<p>暂无储值套餐</p>'}<p>请到收银处办理充值，满足后台设置的升级条件后获得会员权益。线上充值暂未开放。</p></section></div>`;
}

async function changeCart(index, delta) {
  const item = state.cart.find(i => i.index === index);
  try {
    if (delta > 0) await api(`/sessions/${state.sessionId}/cart/items`, { method: 'POST', body: JSON.stringify({ productId: products[index].id, quantity: delta }) });
    else if (item) await api(`/sessions/${state.sessionId}/cart/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: Math.max(item.qty - 1, 0) }) });
    await refreshCart();
    renderCustomer();
  } catch (error) { showToast(error.message); }
}

async function removeFromCart(index) {
  const item = state.cart.find(i => i.index === index);
  if (!item) return;
  try {
    await api(`/sessions/${state.sessionId}/cart/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: 0 }) });
    await refreshCart();
    renderCustomer();
  } catch (error) { showToast(error.message); }
}

async function createOrder() {
  try {
    document.querySelector('#confirm-payment').disabled = true;
    state.orderNote = document.querySelector('#order-note')?.value.trim() || '';
    if (state.orderNote.length > 200) return showToast('订单备注不能超过 200 个字');
    const result = await api(`/sessions/${state.sessionId}/orders`, { method: 'POST', body: JSON.stringify({ paymentMethod: state.paymentMethod, note: state.orderNote }) });
    state.paymentOpen = false;
    await refreshCart();
    renderCustomer();
    showToast(result.payment.status === 'paid' ? `订单 ${result.order.order_no} 余额支付成功` : `订单 ${result.order.order_no} 待支付，微信需支付 ${result.order.wechatPaid || '0.00'} 元`);
  } catch (error) { renderCustomer(); showToast(error.message); }
}

const adminState = { section: 'dashboard', data: null, toast: '', dialog: null, account: null, memberPhone: '', storagePhone: '', reportRange: { start: '', end: '' }, pos: { phone: '', tableId: '', items: {}, method: 'cash', mode: 'order', packageId: '', requestId: crypto.randomUUID(), error: '' } };
let adminRenderVersion = 0;
let lastPendingOrderCount = null;
let adminPolling = false;
const adminModules = [['dashboard','经营概览'],['mini-page','小程序页面'],['pos','收银点单'],['orders','订单管理'],['tables','桌台管理'],['members','会员管理'],['storage','存酒管理'],['group-buy','团购核销'],['products','商品与库存'],['wallet','储值活动'],['rewards','积分兑换'],['reports','数据报表'],['losses','赠酒报损'],['accounts','账号管理'],['logs','操作日志'],['settings','接口配置']];
const adminApi = (path, options = {}) => api(`/admin${path}`, options);
const adminTitles = Object.fromEntries(adminModules);
const configLabels = { public_api_base_url:'小程序 API 正式 HTTPS 地址', wechat_app_id:'微信小程序 AppID', wechat_app_secret:'微信小程序 AppSecret', wechat_mch_id:'微信支付商户号', wechat_api_v3_key:'微信支付 API v3 密钥', wechat_merchant_serial:'微信支付商户证书序列号', wechat_private_key:'微信支付商户私钥', wechat_notify_url:'微信支付回调地址', meituan_client_id:'美团客户端 ID', meituan_client_secret:'美团客户端密钥', douyin_client_key:'抖音客户端 Key', douyin_client_secret:'抖音客户端密钥' };
const miniIconLabels = { gift:'礼 · 礼物', bottle:'酒 · 存酒', wallet:'¥ · 钱包', receipt:'单 · 订单', star:'★ · 星标', glass:'杯 · 酒杯', card:'卡 · 会员卡', bag:'兑 · 奖品' };
const miniEntryLabels = { app_name:'小程序显示名称', home_title:'首页欢迎标题', rewards:'兑换中心', storage:'我的存酒', recharge:'会员充值', orders:'我的订单' };
function adminMoney(value) { return `¥${Number(value || 0).toFixed(2)}`; }
function reportNumber(value) { return Number(String(value ?? 0).replace(/[^0-9.-]/g, '')) || 0; }
function reportTrendChart(daily) {
  const rows = daily.slice().reverse();
  const width = Math.max(620, rows.length * 86 + 64);
  const left = 42, right = width - 22, top = 18, bottom = 178;
  const values = rows.flatMap(row => [reportNumber(row.revenue), reportNumber(row.profit)]);
  const high = Math.max(1, ...values), low = Math.min(0, ...values);
  const y = value => top + (high - value) / (high - low) * (bottom - top);
  const x = index => left + (right - left) * (index + 0.5) / Math.max(rows.length, 1);
  const zero = y(0);
  const points = rows.map((row, index) => `${x(index)},${y(reportNumber(row.profit))}`).join(' ');
  return `<div class="trend-scroll"><svg class="trend-plot" width="${width}" height="260" viewBox="0 0 ${width} 260" role="img" aria-label="每日订单净销售额柱形图与净利润折线图，具体金额见下方每日经营明细">
    <line x1="${left}" x2="${right}" y1="${zero}" y2="${zero}" class="trend-zero"/>
    ${rows.map((row, index) => { const cx = x(index), revenue = reportNumber(row.revenue), profit = reportNumber(row.profit); return `<g>
      <rect class="trend-revenue" x="${cx - 12}" y="${Math.min(y(revenue), zero)}" width="24" height="${Math.max(Math.abs(zero - y(revenue)), 2)}"><title>${row.day} 订单净销售额 ${adminMoney(revenue)}</title></rect>
      <text class="trend-date" x="${cx}" y="201">${escapeHtml(row.day.slice(5))}</text>
      <text class="trend-revenue-value" x="${cx}" y="224">${adminMoney(revenue)}</text>
      <text class="trend-profit-value" x="${cx}" y="244">${adminMoney(profit)}</text>
    </g>`; }).join('')}
    ${rows.length > 1 ? `<polyline class="trend-profit-line" points="${points}"/>` : ''}
    ${rows.map((row, index) => `<circle class="trend-profit-point" cx="${x(index)}" cy="${y(reportNumber(row.profit))}" r="4"><title>${row.day} 净利润 ${adminMoney(row.profit)}</title></circle>`).join('')}
  </svg></div>`;
}
function localDateString(date = new Date()) { const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, '0'); const day = String(date.getDate()).padStart(2, '0'); return `${year}-${month}-${day}`; }
function reportPresetRange(preset) {
  const end = new Date();
  const start = new Date(end);
  if (preset === 'today') start.setDate(end.getDate());
  if (preset === '7d') start.setDate(end.getDate() - 6);
  if (preset === '30d') start.setDate(end.getDate() - 29);
  if (preset === 'month') start.setDate(1);
  return { start: localDateString(start), end: localDateString(end) };
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function adminTable(headers, rows) { return `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-cell">暂无数据</td></tr>`}</tbody></table></div>`; }
async function renderAdmin() {
  if (!adminState.account) return renderAdminLogin();
  const renderVersion = ++adminRenderVersion;
  const renderingSection = adminState.section;
  if (!adminState.account.permissions.includes(adminState.section)) adminState.section = adminState.account.permissions[0] || 'dashboard';
  let content = '<div class="admin-loading">正在加载...</div>';
  try { adminState.data = await adminApi(adminState.section === 'dashboard' ? '/summary' : adminState.section === 'products' ? '/products' : adminState.section === 'group-buy' ? '/group-buy' : adminState.section === 'wallet' ? '/wallet-packages' : adminState.section === 'members' ? `/members?phone=${encodeURIComponent(adminState.memberPhone)}` : adminState.section === 'storage' ? `/storage?phone=${encodeURIComponent(adminState.storagePhone)}` : adminState.section === 'pos' ? `/pos?phone=${encodeURIComponent(adminState.pos.phone)}` : adminState.section === 'reports' ? `/reports?start=${encodeURIComponent(adminState.reportRange.start)}&end=${encodeURIComponent(adminState.reportRange.end)}` : `/${adminState.section}`); content = adminContent(adminState.section, adminState.data); } catch (error) { content = `<div class="panel error-panel">${escapeHtml(error.message)}</div>`; }
  if (renderVersion !== adminRenderVersion || renderingSection !== adminState.section) return;
  document.querySelector('#app').innerHTML = `<main class="admin-shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">EH</span><div><strong>Echo HX</strong><small>运营管理台</small></div></div><div class="store-switcher">Echo HX Live Bar</div><nav class="side-nav">${adminModules.filter(([id]) => adminState.account.permissions.includes(id)).map(([id, label]) => `<a class="${adminState.section === id ? 'current' : ''}" data-admin-section="${id}"><span>${label}</span></a>`).join('')}</nav><div class="sidebar-footer"><div class="staff-avatar">${escapeHtml(adminState.account.displayName.slice(0,1))}</div><div><strong>${escapeHtml(adminState.account.displayName)}</strong><small>${{super:'超级管理员',manager:'管理员',staff:'店员'}[adminState.account.role]}</small></div></div></aside><section class="admin-content"><header class="admin-header"><div><span class="eyebrow">ECHO HX LIVE BAR · 运营中心</span><h1>${adminTitles[adminState.section]}</h1></div><div class="header-actions"><button class="outline-button" data-action="password">修改密码</button><button class="outline-button" data-action="logout">退出登录</button><button class="outline-button" data-action="refresh">刷新数据</button></div></header>${content}</section></main><div id="admin-dialog-root"></div>${adminState.toast ? `<div class="toast admin-toast">${escapeHtml(adminState.toast)}</div>` : ''}`;
  if (adminState.account.role === 'super' && adminState.section !== 'mini-page') {
    const shortcut = document.createElement('button');
    shortcut.className = 'outline-button';
    shortcut.textContent = '编辑小程序';
    shortcut.dataset.adminSection = 'mini-page';
    document.querySelector('.header-actions').prepend(shortcut);
  }
  document.querySelectorAll('[data-admin-section]').forEach(button => button.onclick = () => { adminState.section = button.dataset.adminSection; renderAdmin(); });
  document.querySelector('[data-action="refresh"]')?.addEventListener('click', renderAdmin);
  bindAdminActions();
}
function renderAdminLogin() {
  document.querySelector('#app').innerHTML = `<main class="admin-login"><form id="admin-login-form"><span class="eyebrow">ECHO HX LIVE BAR</span><h1>运营管理台</h1><label>账号<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><p class="dialog-error" aria-live="polite"></p><button class="primary-small">登录</button></form></main>`;
  document.querySelector('#admin-login-form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; try { const data = await adminApi('/login', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); sessionStorage.setItem('adminToken', data.token); adminState.account = data.account; renderAdmin(); } catch (error) { form.querySelector('.dialog-error').textContent = error.message; } };
}
async function initAdmin() { if (sessionStorage.getItem('adminToken')) { try { adminState.account = (await adminApi('/session')).account; } catch { sessionStorage.removeItem('adminToken'); } } renderAdmin(); }
function adminContent(section, data) {
  if (section === 'dashboard') { const canOrders = adminState.account.permissions.includes('orders'); const canProducts = adminState.account.permissions.includes('products'); const m = data.todayMetrics || {}; return `<section class="kpi-grid">${[['今日净销售额',adminMoney(m.revenue ?? data.todayRevenue),'今日'],['今日净利润',adminMoney(m.profit),'今日'],['营业桌台',`${data.activeTables} 桌`,'进行中'],['空闲桌台',`${data.idleTables} 桌`,'可安排']].map((k, i) => `<article class="kpi-card"><span>${k[0]}</span><strong data-kpi="${i}">${k[1]}</strong><small class="green">${k[2]}</small></article>`).join('')}</section><section class="panel daily-metrics"><div class="panel-heading"><div><h2>今日经营数据</h2><span>实时统计，赠金不计入净销售额</span></div></div><div class="metric-list compact-metrics">${[['今日充值收款',m.recharge],['线下收款',m.offline],['订单商品成本',m.orderCost],['赠酒报损成本',m.lossCost]].map(([label,value]) => `<div><span>${label}</span><strong>${adminMoney(value)}</strong></div>`).join('')}</div></section><section class="admin-grid"><article class="panel"><div class="panel-heading"><div><h2>运营提醒</h2><span>点击提醒可直接进入处理页面</span></div></div><div class="task-list">${canProducts ? `<button class="task-link" data-admin-section="products"><b class="status-dot red-dot"></b><div><strong>库存预警 ${data.lowStock} 项</strong><span>${data.outOfStock ? `其中 ${data.outOfStock} 项已自动下架，请及时补货` : '请到商品与库存调整安全库存'}</span></div></button>` : ''}${canOrders ? `<button class="task-link" data-admin-section="orders"><b class="status-dot orange"></b><div><strong>待送达订单 ${data.activeOrders} 笔</strong><span>查看商品清单并确认送达${data.pendingPayment ? ` · 另有 ${data.pendingPayment} 笔待支付` : ''}</span></div></button>` : ''}</div></article><article class="panel"><div class="panel-heading"><div><h2>快速入口</h2><span>常用运营动作</span></div></div><div class="quick-actions"><button data-admin-section="pos">收银点单</button><button data-admin-section="storage">登记存酒</button><button data-admin-section="group-buy">核销团购</button><button data-admin-section="wallet">配置储值</button></div></article></section><section class="panel dashboard-orders"><div class="panel-heading"><div><h2>新订单待处理</h2><span>支付成功后，店员送达才会完成</span></div><button class="outline-button" data-admin-section="orders">查看全部</button></div>${data.pendingOrders?.length ? data.pendingOrders.map(o => `<article class="pending-order"><div><strong>${escapeHtml(o.order_no)} · ${escapeHtml(o.table_no)}桌</strong><span>${escapeHtml(o.nickname)} · ${o.paid_at}</span></div><div class="pending-items">${o.items.map(item => `<span>${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="">` : ''}${escapeHtml(item.product_name)} × ${item.quantity}</span>`).join('')}</div></article>`).join('') : '<p class="empty-cell">暂无待送达订单</p>'}</section>`; }
  if (section === 'pos') return posContent(data);
  if (section === 'products') return `<div class="toolbar"><button class="primary-small" data-action="new-product">新增商品</button><span>商品资料、价格、赠金支付和库存统一管理</span></div>${adminTable(['商品','分类','原价','会员价','进货价','库存','赠金支付','状态','操作'], data.products.map(p => `<tr><td><div class="product-cell">${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="">` : ''}<div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.detail || '')}</small></div></div></td><td>${escapeHtml(p.category || '-')}</td><td>${adminMoney(p.price)}</td><td class="green-text">${p.memberPrice == null ? '-' : adminMoney(p.memberPrice)}</td><td>${p.cost_cents == null ? '-' : adminMoney(p.cost_cents / 100)}</td><td class="${p.stock <= 20 ? 'warning-text' : ''}">${p.stock}${p.stock <= 20 ? ' · 预警' : ''}</td><td>${p.allow_bonus ? '支持' : '不支持'}</td><td>${p.status === 'active' ? '在售' : '下架'}</td><td><button class="table-action" data-adjust-stock="${p.id}">调库存</button> <button class="table-action" data-edit-product="${p.id}">编辑</button> <button class="table-action" data-product-status="${p.id}" data-status="${p.status === 'active' ? 'inactive' : 'active'}">${p.status === 'active' ? '下架' : '上架'}</button></td></tr>`).join(''))}`;
  if (section === 'orders') return adminTable(['订单号','桌台','付款人','商品清单','订单备注','原价','优惠','实付','支付构成','净销售额','利润','状态','操作'], data.orders.map(o => `<tr><td>${o.order_no}</td><td>${o.table_no}</td><td>${escapeHtml(o.nickname)}</td><td class="order-items-cell">${o.items.map(item => `<span>${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="">` : ''}${escapeHtml(item.product_name)} × ${item.quantity}</span>`).join('')}</td><td class="order-note-cell">${o.note ? escapeHtml(o.note) : '<span class="muted-cell">无</span>'}</td><td>${adminMoney(o.originalAmount)}</td><td class="green-text">-${adminMoney(o.discountAmount)}</td><td><strong>${adminMoney(o.payableAmount)}</strong></td><td>${o.payment_method === 'mixed' ? `赠金 ${adminMoney(o.bonusPaid)} / 储值 ${adminMoney(o.storedPaid)} / 微信 ${adminMoney(o.wechatPaid)}` : o.payment_method === 'balance' ? `储值 ${adminMoney(o.storedPaid)} / 赠金 ${adminMoney(o.bonusPaid)}` : o.payment_method === 'wechat' ? `微信 ${adminMoney(Number(o.wechatPaid) > 0 ? o.wechatPaid : o.payableAmount)}` : '线下'}</td><td>${o.payment_status === 'paid' ? adminMoney(o.netSales) : '-'}</td><td>${adminState.account.role === 'super' && o.profit != null ? adminMoney(o.profit) : '-'}</td><td>${escapeHtml(o.statusLabel)}</td><td>${o.payment_status === 'pending' ? (o.payment_method === 'mixed' ? '等待微信支付' : `<button class="table-action" data-mark-paid="${o.id}">确认线下收款</button>`) : o.status === 'awaiting_delivery' ? `<button class="table-action" data-deliver="${o.id}">确认送达</button>` : '已完成'}</td></tr>`).join(''));
  if (section === 'tables') return `<div class="toolbar"><button class="primary-small" data-action="new-table">新增桌台</button><span>每桌独立小程序码；扫码后自动进入对应桌台</span></div>${adminTable(['桌号','小程序码','会话','已收金额','操作'], data.tables.map(t => `<tr><td><strong>${escapeHtml(t.table_no)}</strong></td><td><button class="table-action" data-table-code="${t.id}">预览 / 下载</button></td><td>${t.session_status === 'open' ? '进行中' : '空闲'}</td><td>${adminMoney(t.orderTotal)}</td><td>${t.session_status === 'open' ? `<button class="table-action" data-close-table="${t.id}">结束本桌</button>` : '-'}</td></tr>`).join(''))}`;
  if (section === 'members') return `<div class="toolbar member-toolbar"><form id="member-search"><input name="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="输入手机号搜索会员" value="${escapeHtml(adminState.memberPhone)}"><button class="outline-button">搜索</button></form><button class="primary-small" data-action="new-member">新增会员</button><button class="outline-button" data-action="new-tier">新增等级</button></div>${adminTable(['手机号','名称','微信绑定','会员等级','到期','积分','储值','赠金','操作'], data.members.map(m => `<tr><td>${escapeHtml(m.phone || '未绑定')}</td><td>${escapeHtml(m.nickname)}</td><td>${m.wechatBound ? '已绑定' : '未绑定'}</td><td>${escapeHtml(m.memberLevel)}</td><td>${m.memberExpiresAt ? escapeHtml(m.memberExpiresAt.slice(0,10)) : '长期'}</td><td>${m.points}</td><td>${adminMoney(m.stored)}</td><td>${adminMoney(m.bonus)}</td><td><button class="table-action" data-edit-member="${m.id}">管理</button></td></tr>`).join(''))}<section class="storage-history"><h2>等级与升级条件</h2><p class="member-note">累计消费在确认收款后自动判定；储值和月卡需接通正式支付后触发。微信手机号需用户单独授权。</p>${adminTable(['等级','升级方式','门槛','优惠','积分倍率','有效期','状态','操作'], data.tiers.map(t => `<tr><td>${escapeHtml(t.name)}</td><td>${{spend:'累计消费',recharge:'储值消费',monthly:'付费月卡'}[t.upgrade_type] || '-'}</td><td>${adminMoney(t.threshold_cents / 100)}</td><td>${Number(t.discount * 10).toFixed(1)} 折</td><td>${t.points_rate} 倍</td><td>${t.duration_days ? `${t.duration_days} 天` : '长期'}</td><td>${t.status === 'active' ? '启用' : '停用'}</td><td><button class="table-action" data-edit-tier="${t.id}">编辑</button></td></tr>`).join(''))}</section>`;
  if (section === 'storage') return `<div class="toolbar member-toolbar"><button class="primary-small" data-action="new-storage">登记存酒</button><form id="storage-search"><input name="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="按手机号查存酒" value="${escapeHtml(adminState.storagePhone)}"><button class="outline-button">搜索</button></form><span>有效存酒 ${data.stats.remaining} 件 · 7 天内到期 ${data.stats.expiring} 条</span></div>${adminTable(['手机号 / 用户','酒品','剩余数量','到期日期','状态','操作'], data.records.map(r => `<tr><td>${escapeHtml(r.phone || '未绑定')}<small>${escapeHtml(r.nickname)}</small></td><td>${escapeHtml(r.product_name)}</td><td>${r.quantity}</td><td class="${r.expired ? 'warning-text' : ''}">${escapeHtml(r.expires_at.slice(0, 10))}</td><td>${r.expired ? '已过期' : r.status === 'collected' ? '已取完' : '存放中'}</td><td>${!r.expired && r.status === 'stored' && r.quantity > 0 ? `<button class="table-action" data-withdraw="${r.id}">取酒</button>` : '-'}</td></tr>`).join(''))}<section class="storage-history"><h2>存取流水</h2>${adminTable(['时间','手机号','商品','类型','数量','操作员','备注'], data.movements.map(m => `<tr><td>${escapeHtml(m.created_at)}</td><td>${escapeHtml(m.phone || '未绑定')}</td><td>${escapeHtml(m.product_name)}</td><td>${m.type === 'deposit' ? '存入' : '取出'}</td><td>${m.quantity}</td><td>${escapeHtml(m.operator)}</td><td>${escapeHtml(m.note)}</td></tr>`).join(''))}</section>`;
  if (section === 'group-buy') return `<div class="toolbar"><button class="primary-small" data-action="verify-group">录入核销</button><span>当前保存内部核销记录；抖音/美团查券接口需配置商户授权</span></div>${adminTable(['平台','券码','套餐','金额','核销时间','操作员'], data.records.map(r => `<tr><td>${r.platform}</td><td>${r.voucher_no}</td><td>${r.package_name}</td><td>${adminMoney(r.amount_cents / 100)}</td><td>${r.verified_at}</td><td>${r.verified_by || '-'}</td></tr>`).join(''))}`;
  if (section === 'wallet') return `<section class="kpi-grid">${[['未使用储值金额',data.outstanding.stored],['未使用赠金',data.outstanding.bonus]].map(([label,value]) => `<article class="kpi-card"><span>${label}</span><strong>${adminMoney(value)}</strong></article>`).join('')}</section><div class="toolbar"><button class="primary-small" data-action="new-wallet">新增储值套餐</button><span>储值与赠金分账；赠金不计入订单收入</span></div>${adminTable(['套餐','支付金额','储值金额','赠金','状态'], data.packages.map(p => `<tr><td>${p.name}</td><td>${adminMoney(p.pay)}</td><td>${adminMoney(p.stored)}</td><td class="green-text">${adminMoney(p.bonus)}</td><td>${p.status}</td></tr>`).join(''))}`;
  if (section === 'rewards') return `<div class="toolbar"><button class="primary-small" data-action="new-reward">新增奖品</button></div>${adminTable(['奖品','来源','所需积分','可兑数量','状态','操作'], data.rewards.map(r => `<tr><td><div class="product-cell">${r.imageUrl ? `<img src="${escapeHtml(r.imageUrl)}" alt="">` : ''}<strong>${escapeHtml(r.name)}</strong></div></td><td>${r.product_id ? '现有商品' : '自定义奖品'}</td><td>${r.points}</td><td>${r.stock}</td><td>${r.status === 'active' ? '上架' : '下架'}</td><td><button class="table-action" data-edit-reward="${r.id}">编辑</button></td></tr>`).join(''))}<section class="storage-history"><h2>兑换记录</h2>${adminTable(['时间','手机号','会员','奖品','积分','状态','操作'], data.redemptions.map(r => `<tr><td>${escapeHtml(r.created_at)}</td><td>${escapeHtml(r.phone || '未绑定')}</td><td>${escapeHtml(r.nickname)}</td><td>${escapeHtml(r.reward_name)}</td><td>${r.points}</td><td>${r.status === 'fulfilled' ? '已领取' : '待领取'}</td><td>${r.status === 'pending' ? `<button class="table-action" data-fulfill="${r.id}">确认发放</button>` : '-'}</td></tr>`).join(''))}</section>`;
  if (section === 'mini-page') return `<section class="panel mini-page-panel"><h2>小程序首页</h2><p>修改后顾客下次打开即生效。微信搜索展示的正式名称仍需在微信公众平台修改。</p><form id="mini-page-form"><div class="mini-page-fields">${data.entries.filter(entry => entry.type === 'text').map(entry => `<label class="admin-field"><span>${miniEntryLabels[entry.key]}</span><input name="title-${entry.key}" maxlength="30" value="${escapeHtml(entry.title)}" required></label>`).join('')}</div><h2>会员中心入口</h2><div class="mini-page-fields">${data.entries.filter(entry => entry.type !== 'text').map(entry => `<div class="mini-entry-field"><strong>${miniEntryLabels[entry.key]}</strong><label class="admin-field"><span>显示名称</span><input name="title-${entry.key}" maxlength="8" value="${escapeHtml(entry.title)}" required></label><label class="admin-field"><span>图标</span><select name="icon-${entry.key}">${data.icons.map(icon => `<option value="${icon}" ${icon === entry.icon ? 'selected' : ''}>${miniIconLabels[icon]}</option>`).join('')}</select></label></div>`).join('')}</div><button class="primary-small">保存页面设置</button><p class="dialog-error"></p></form></section>`;
  if (section === 'reports') {
    const daily = data.daily || [];
    const activePreset = ['today','7d','30d','month'].find(preset => { const range = reportPresetRange(preset); return range.start === data.dateRange.start && range.end === data.dateRange.end; });
    return `<section class="panel report-toolbar"><form id="report-range"><div class="report-presets" role="group" aria-label="快捷日期范围">${[['today','当天'],['7d','近7天'],['30d','近30天'],['month','本月']].map(([value,label]) => `<button type="button" class="date-preset ${activePreset === value ? 'active' : ''}" data-report-preset="${value}">${label}</button>`).join('')}</div><label>开始日期<input type="date" name="start" value="${escapeHtml(data.dateRange.start)}"></label><label>结束日期<input type="date" name="end" value="${escapeHtml(data.dateRange.end)}"></label><button class="primary-small">查询</button><button type="button" class="outline-button" data-export-report>导出表格</button></form></section><section class="kpi-grid">${[['订单净销售额',data.today?.revenue],['净利润',data.today?.profit],['充值收款',data.today?.recharge],['线下收款',data.today?.offline],['订单商品成本',data.today?.orderCost],['赠酒报损成本',data.today?.lossCost]].map(([label,value]) => `<article class="kpi-card"><span>${label}</span><strong>${adminMoney(value)}</strong><small class="green">${data.today?.day || ''}</small></article>`).join('')}</section><section class="panel report-chart"><div class="panel-heading"><h2>净销售额与利润趋势</h2><div class="trend-legend"><span><i class="legend-revenue"></i>订单净销售额（柱）</span><span><i class="legend-profit"></i>净利润（线）</span></div></div>${daily.length ? reportTrendChart(daily) : '<p class="empty-cell">所选日期暂无数据</p>'}</section><section class="panel"><div class="panel-heading"><div><h2>每日经营明细</h2><span>${data.dateRange.start} 至 ${data.dateRange.end}</span></div></div>${adminTable(['日期','订单数','净销售额','净利润','充值收款','线下收款','商品成本','赠酒报损成本'], daily.map(r => `<tr><td>${r.day}</td><td>${r.orders}</td><td>${adminMoney(r.revenue)}</td><td class="green-text">${adminMoney(r.profit)}</td><td>${adminMoney(r.recharge)}</td><td>${adminMoney(r.offline)}</td><td>${adminMoney(r.orderCost)}</td><td>${adminMoney(r.lossCost)}</td></tr>`).join(''))}</section>`;
  }
  if (section === 'losses') return `<div class="toolbar"><button class="primary-small" data-action="new-loss">上报赠酒 / 报损</button></div>${adminTable(['时间','类型','商品','数量','成本','原因','操作人'], data.records.map(r => `<tr><td>${r.created_at}</td><td>${r.type === 'gift' ? '赠酒' : '报损'}</td><td>${escapeHtml(r.product_name)}</td><td>${r.quantity}</td><td>${adminState.account.role === 'super' ? adminMoney(r.cost) : '-'}</td><td>${escapeHtml(r.reason)}</td><td>${escapeHtml(r.operator)}</td></tr>`).join(''))}`;
  if (section === 'accounts') return `<div class="toolbar"><button class="primary-small" data-action="new-account">新增账号</button></div>${adminTable(['账号','名称','角色','状态','授权模块','操作'], data.accounts.map(a => `<tr><td>${escapeHtml(a.username)}</td><td>${escapeHtml(a.displayName)}</td><td>${{super:'超级管理员',manager:'管理员',staff:'店员'}[a.role]}</td><td>${a.status === 'active' ? '启用' : '停用'}</td><td>${a.role === 'super' ? '全部' : a.permissions.map(p => adminTitles[p]).join('、')}</td><td>${a.role === 'super' ? '-' : `<button class="table-action" data-edit-account="${a.id}">编辑权限</button>`}</td></tr>`).join(''))}`;
  if (section === 'logs') return adminTable(['时间','账号','操作','详情'], data.logs.map(l => `<tr><td>${l.created_at}</td><td>${escapeHtml(l.operator)}</td><td>${escapeHtml(l.action)}</td><td>${escapeHtml(l.detail)}</td></tr>`).join(''));
  if (section === 'settings') return `<section class="panel"><div class="panel-heading"><div><h2>第三方接口配置</h2><span>保存后会被服务端运行时读取；密钥建议通过服务器环境变量注入</span></div><button class="outline-button" id="check-integrations">检查配置</button></div><div class="integration-status">${Object.entries(data.groups || {}).map(([key, value]) => `<span class="status-chip ${value.configured ? 'ready' : 'warning'}">${key}: ${value.configured ? '配置完整' : `缺少 ${value.missing.length} 项`}</span>`).join('')}</div><form id="settings-form" class="settings-grid">${data.settings.map(s => `<label class="admin-field"><span>${escapeHtml(s.label || configLabels[s.key] || s.key)} ${s.configured ? `· 已配置（${s.source === 'environment' ? '环境变量' : '后台'}）` : ''}</span><input name="${s.key}" type="${s.secret ? 'password' : 'text'}" value="${escapeHtml(s.value)}" placeholder="${s.secret && s.configured ? '留空保持原值' : ''}"></label>`).join('')}<button class="primary-small">保存配置</button><p class="dialog-error"></p></form><p class="muted">完整性检查通过后，还需在微信、美团、抖音后台完成商户授权，并用真实回调地址做支付和核销联调。</p></section>`;
  return '<div class="panel">该模块已就绪，等待配置数据。</div>';
}
function bindAdminActions() {
  if (adminState.section === 'pos' && adminState.data?.tables) bindPosActions();
  const action = (selector, handler) => document.querySelectorAll(selector).forEach(button => button.onclick = async () => { button.disabled = true; try { await handler(button); await renderAdmin(); } catch (error) { adminNotice(error.message); button.disabled = false; } });
  action('[data-product-status]', button => adminApi(`/products/${button.dataset.productStatus}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) }));
  action('[data-mark-paid]', button => adminApi(`/orders/${button.dataset.markPaid}/mark-paid`, { method: 'POST', body: '{}' }));
  action('[data-deliver]', button => adminApi(`/orders/${button.dataset.deliver}/deliver`, { method: 'POST', body: '{}' }));
  action('[data-close-table]', button => adminApi(`/tables/${button.dataset.closeTable}/close`, { method: 'POST', body: '{}' }));
  document.querySelectorAll('[data-table-code]').forEach(button => button.onclick = () => openTableCode(adminState.data.tables.find(table => table.id === Number(button.dataset.tableCode))));
  action('[data-fulfill]', button => adminApi(`/rewards/redemptions/${button.dataset.fulfill}/fulfill`, { method: 'POST', body: '{}' }));
  document.querySelectorAll('[data-admin-section]').forEach(button => button.onclick = () => { adminState.section = button.dataset.adminSection; renderAdmin(); });
  document.querySelectorAll('[data-action="new-product"],[data-action="new-table"],[data-action="new-storage"],[data-action="verify-group"],[data-action="new-wallet"]').forEach(button => button.onclick = () => openAdminDialog(button.dataset.action));
  document.querySelectorAll('[data-withdraw]').forEach(button => button.onclick = () => openAdminDialog('withdraw', adminState.data.records.find(r => r.id === Number(button.dataset.withdraw))));
  document.querySelectorAll('[data-adjust-stock]').forEach(button => button.onclick = () => openAdminDialog('stock', adminState.data.products.find(p => p.id === Number(button.dataset.adjustStock))));
  document.querySelectorAll('[data-edit-product]').forEach(button => button.onclick = () => openAdminDialog('edit-product', adminState.data.products.find(p => p.id === Number(button.dataset.editProduct))));
  document.querySelectorAll('[data-edit-account]').forEach(button => button.onclick = () => openAdminDialog('edit-account', adminState.data.accounts.find(a => a.id === Number(button.dataset.editAccount))));
  document.querySelectorAll('[data-edit-member]').forEach(button => button.onclick = () => openAdminDialog('edit-member', adminState.data.members.find(m => m.id === Number(button.dataset.editMember))));
  document.querySelectorAll('[data-edit-tier]').forEach(button => button.onclick = () => openAdminDialog('edit-tier', adminState.data.tiers.find(t => t.id === Number(button.dataset.editTier))));
  document.querySelectorAll('[data-edit-reward]').forEach(button => button.onclick = () => openAdminDialog('edit-reward', adminState.data.rewards.find(r => r.id === Number(button.dataset.editReward))));
  document.querySelectorAll('[data-action="new-account"],[data-action="new-loss"],[data-action="password"],[data-action="new-member"],[data-action="new-tier"],[data-action="new-reward"]').forEach(button => button.onclick = () => openAdminDialog(button.dataset.action));
  document.querySelector('#member-search')?.addEventListener('submit', event => { event.preventDefault(); adminState.memberPhone = new FormData(event.currentTarget).get('phone').trim(); renderAdmin(); });
  document.querySelector('#storage-search')?.addEventListener('submit', event => { event.preventDefault(); adminState.storagePhone = new FormData(event.currentTarget).get('phone').trim(); renderAdmin(); });
  document.querySelector('#report-range')?.addEventListener('submit', event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); adminState.reportRange = { start: values.start, end: values.end }; renderAdmin(); });
  document.querySelectorAll('[data-report-preset]').forEach(button => button.onclick = () => { adminState.reportRange = reportPresetRange(button.dataset.reportPreset); renderAdmin(); });
  document.querySelector('[data-export-report]')?.addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; try { const query = new URLSearchParams(adminState.reportRange).toString(); const response = await fetch(`/api/admin/reports/export?${query}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminToken')}` } }); if (!response.ok) throw new Error('报表导出失败'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `经营报表-${adminState.reportRange.start || '开始'}-${adminState.reportRange.end || '结束'}.csv`; link.click(); URL.revokeObjectURL(url); } catch (error) { adminNotice(error.message); } finally { button.disabled = false; } });
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => { try { await adminApi('/logout', { method:'POST' }); } finally { sessionStorage.removeItem('adminToken'); adminState.account = null; renderAdminLogin(); } });
  document.querySelector('#settings-form')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true; try { await adminApi('/settings', { method:'PUT', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); await renderAdmin(); adminNotice('配置已保存，请继续完成平台授权和联调'); } catch (error) { form.querySelector('.dialog-error').textContent = error.message; button.disabled = false; } });
  document.querySelector('#check-integrations')?.addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; try { const result = await adminApi('/settings/check', { method:'POST' }); adminNotice(result.message); } catch (error) { adminNotice(error.message); } finally { button.disabled = false; } });
  document.querySelector('#mini-page-form')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); const entries = adminState.data.entries.map(({ key }) => ({ key, title: values[`title-${key}`], icon: values[`icon-${key}`] })); const button = form.querySelector('button'); button.disabled = true; try { await adminApi('/mini-page', { method:'PUT', body:JSON.stringify({ entries }) }); await renderAdmin(); adminNotice('页面设置已保存'); } catch (error) { form.querySelector('.dialog-error').textContent = error.message; button.disabled = false; } });
}

async function openTableCode(table) {
  const root = document.querySelector('#admin-dialog-root');
  root.innerHTML = `<div class="admin-dialog-backdrop"><section class="admin-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(table.table_no)} 桌台小程序码"><header><h2>${escapeHtml(table.table_no)} · 桌台小程序码</h2><button type="button" data-close-dialog aria-label="关闭">×</button></header><div class="dialog-fields" id="table-code-content"><p>正在向微信生成小程序码...</p></div><footer><button type="button" class="outline-button" data-close-dialog>关闭</button><a class="primary-small" id="table-code-download" hidden>下载 PNG</a></footer></section></div>`;
  let objectUrl;
  const close = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); root.innerHTML = ''; };
  root.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = close);
  root.querySelector('.admin-dialog-backdrop').onclick = event => { if (event.target.classList.contains('admin-dialog-backdrop')) close(); };
  try {
    const response = await fetch(`/api/admin/tables/${table.id}/mini-code`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminToken')}` } });
    if (!response.ok) { const error = await response.json(); throw new Error(error.message || '小程序码生成失败'); }
    const blob = await response.blob();
    if (!root.querySelector('#table-code-content')) return;
    objectUrl = URL.createObjectURL(blob);
    root.querySelector('#table-code-content').innerHTML = `<img class="table-code-image" src="${objectUrl}" alt="${escapeHtml(table.table_no)} 桌台小程序码"><p>打印并贴在 ${escapeHtml(table.table_no)} 桌；微信扫码后将自动绑定本桌。</p>`;
    const download = root.querySelector('#table-code-download');
    download.href = objectUrl;
    download.download = `桌台-${table.id}.png`;
    download.hidden = false;
  } catch (error) { if (root.querySelector('#table-code-content')) root.querySelector('#table-code-content').textContent = error.message; }
}

function posContent(data) {
  const pos = adminState.pos;
  const lines = data.products.filter(p => pos.items[p.id]).map(p => ({ ...p, quantity: pos.items[p.id] }));
  const original = lines.reduce((n,p) => n + p.price_cents * p.quantity,0) / 100;
  const payable = lines.reduce((n,p) => n + Math.round(p.memberPrice * 100) * p.quantity,0) / 100;
  const offer = data.packages.find(p => String(p.id) === pos.packageId);
  const amount = pos.mode === 'order' ? payable : offer?.pay || 0;
  return `<section class="pos-context"><div class="pos-tabs" role="tablist">${[['order','商品点单'],['recharge','会员储值']].map(([key,label]) => `<button role="tab" aria-selected="${pos.mode === key}" data-pos-mode="${key}" class="${pos.mode === key ? 'active' : ''}">${label}</button>`).join('')}</div><form id="pos-member-search"><label>会员手机号<input name="phone" type="tel" maxlength="11" pattern="1[3-9][0-9]{9}" placeholder="输入完整手机号" value="${escapeHtml(pos.phone)}" required></label><button class="outline-button">查找会员</button></form><div class="pos-member">${data.member ? `<strong>${escapeHtml(data.member.nickname)} · ${escapeHtml(data.member.level)}</strong><span>${escapeHtml(data.member.phone)} · 储值 ${adminMoney(data.member.stored)} · 赠金 ${adminMoney(data.member.bonus)}</span>` : `<span>${pos.phone ? '未找到会员，请先在会员管理中绑定手机号' : '尚未绑定会员'}</span>`}</div></section><div class="pos-layout"><section class="pos-catalog">${pos.mode === 'order' ? `<label class="admin-field pos-table"><span>绑定桌号</span><select id="pos-table"><option value="">请选择桌号</option>${data.tables.map(t => `<option value="${t.id}" ${String(t.id) === pos.tableId ? 'selected' : ''}>${escapeHtml(t.table_no)}</option>`).join('')}</select></label><div class="pos-products">${data.products.map(p => `<article class="pos-product">${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}">` : '<div class="pos-image-empty">暂无图片</div>'}<div><strong>${escapeHtml(p.name)}</strong><small>库存 ${p.stock}</small><span>${p.price !== p.memberPrice ? `<del>${adminMoney(p.price)}</del>` : ''}<b class="green-text">${adminMoney(p.memberPrice)}</b></span></div><button data-pos-add="${p.id}" title="添加 ${escapeHtml(p.name)}" aria-label="添加 ${escapeHtml(p.name)}" ${p.stock <= (pos.items[p.id] || 0) ? 'disabled' : ''}>+</button></article>`).join('')}</div>` : `<h2>储值套餐</h2><div class="pos-packages">${data.packages.map(p => `<label><input type="radio" name="pos-package" value="${p.id}" ${String(p.id) === pos.packageId ? 'checked' : ''}><span><strong>${escapeHtml(p.name)}</strong><small>储值 ${adminMoney(p.stored)} · 赠金 ${adminMoney(p.bonus)}</small></span><b>${adminMoney(p.pay)}</b></label>`).join('') || '<p>暂无在售储值套餐</p>'}</div>`}</section><aside class="pos-checkout"><h2>${pos.mode === 'order' ? '本次点单' : '充值确认'}</h2>${pos.mode === 'order' ? `<div class="pos-lines">${lines.map(p => `<div><span>${escapeHtml(p.name)}<small>${adminMoney(p.memberPrice)} / 件</small></span><div class="quantity-controls"><button data-pos-minus="${p.id}" title="减少 ${escapeHtml(p.name)}">−</button><b>${p.quantity}</b><button data-pos-add="${p.id}" title="增加 ${escapeHtml(p.name)}">+</button></div></div>`).join('') || '<p>尚未选择商品</p>'}</div><div class="pos-totals"><span>原价 <b>${adminMoney(original)}</b></span><span>会员优惠 <b class="green-text">-${adminMoney(original - payable)}</b></span></div>` : `<div class="pos-lines"><p>${offer ? `${escapeHtml(offer.name)}<br>储值 ${adminMoney(offer.stored)} · 赠金 ${adminMoney(offer.bonus)}` : '请选择储值套餐'}</p></div>`}<div class="pos-amount"><span>${pos.mode === 'order' ? '应付金额' : '收款金额'}</span><strong>${adminMoney(amount)}</strong></div><fieldset class="pos-methods"><legend>支付方式</legend>${(pos.mode === 'order' ? [['balance','会员余额'],['cash','现金'],['merchant_qr','商家收款码（微信 / 支付宝）']] : [['cash','现金'],['merchant_qr','商家收款码（微信 / 支付宝）']]).map(([key,label]) => `<label><input type="radio" name="pos-method" value="${key}" ${pos.method === key ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>${pos.method !== 'balance' ? '<label class="pos-confirm"><input type="checkbox" id="pos-received">已核实收到以上金额</label>' : ''}<p id="pos-error" class="pos-error" role="alert">${escapeHtml(pos.error)}</p><button class="primary-small pos-submit" id="pos-submit" ${!data.member || (pos.mode === 'order' ? !lines.length || !pos.tableId : !offer) ? 'disabled' : ''}>${pos.mode === 'order' ? '确认收款并下单' : '确认到账并充值'}</button></aside></div>`;
}

function bindPosActions() {
  const pos = adminState.pos;
  const redraw = () => { const area = document.querySelector('.pos-context'); const layout = document.querySelector('.pos-layout'); area.outerHTML = posContent(adminState.data); layout.remove(); bindPosActions(); };
  const changed = () => { pos.requestId = crypto.randomUUID(); pos.error = ''; };
  document.querySelector('#pos-member-search').onsubmit = event => { event.preventDefault(); pos.phone = new FormData(event.currentTarget).get('phone').trim(); changed(); renderAdmin(); };
  document.querySelectorAll('[data-pos-mode]').forEach(button => button.onclick = () => { pos.mode = button.dataset.posMode; if (pos.mode === 'recharge' && pos.method === 'balance') pos.method = 'cash'; changed(); redraw(); });
  document.querySelector('#pos-table')?.addEventListener('change', event => { pos.tableId = event.target.value; changed(); redraw(); });
  document.querySelectorAll('[data-pos-add],[data-pos-minus]').forEach(button => button.onclick = () => {
    const id = Number(button.dataset.posAdd || button.dataset.posMinus), p = adminState.data.products.find(p => p.id === id);
    const quantity = (pos.items[id] || 0) + (button.dataset.posAdd ? 1 : -1);
    if (quantity > Math.min(p.stock,999)) return adminNotice('商品库存不足');
    if (quantity <= 0) delete pos.items[id]; else pos.items[id] = quantity;
    changed(); redraw();
  });
  document.querySelectorAll('[name="pos-package"]').forEach(input => input.onchange = () => { pos.packageId = input.value; changed(); redraw(); });
  document.querySelectorAll('[name="pos-method"]').forEach(input => input.onchange = () => { pos.method = input.value; changed(); redraw(); });
  document.querySelector('#pos-submit').onclick = async event => {
    const button = event.currentTarget;
    if (pos.method !== 'balance' && !document.querySelector('#pos-received')?.checked) { document.querySelector('#pos-error').textContent = '请先核实收款并勾选到账确认'; return; }
    button.disabled = true;
    document.querySelectorAll('.pos-context input,.pos-context button,.pos-layout input,.pos-layout select,.pos-layout button').forEach(node => node.disabled = true);
    try {
      const data = await adminApi(`/pos/${pos.mode === 'order' ? 'orders' : 'recharges'}`, { method: 'POST', body: JSON.stringify({ phone: pos.phone, tableId: Number(pos.tableId), items: Object.entries(pos.items).map(([productId,quantity]) => ({ productId: Number(productId), quantity })), packageId: Number(pos.packageId), paymentMethod: pos.method, requestId: pos.requestId }) });
      if (pos.mode === 'order') pos.items = {};
      changed();
      await renderAdmin();
      adminNotice(data.orderNo ? `下单成功 ${data.orderNo} · ${adminMoney(data.payable)}` : `充值成功 · 储值 ${adminMoney(data.stored)} · 赠金 ${adminMoney(data.bonus)}`);
    } catch (error) { pos.error = error.message; redraw(); }
  };
}

function adminNotice(message) {
  document.querySelector('.admin-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast admin-toast';
  toast.textContent = message;
  document.querySelector('#app').append(toast);
  setTimeout(() => toast.remove(), 3000);
}

async function openAdminDialog(type, item) {
  const root = document.querySelector('#admin-dialog-root');
  const field = (label, name, input) => `<label class="admin-field"><span>${label}</span>${input || `<input name="${name}" required>`}</label>`;
  const number = (name, value = '', min = '0', step = '1') => `<input name="${name}" type="number" value="${value}" min="${min}" step="${step}" required>`;
  let title, fields, path, method = 'POST';
  try {
    if (type === 'new-storage') {
      const productsData = await adminApi('/products');
      title = '登记存酒'; path = '/storage';
      fields = field('会员手机号', 'phone', `<input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[3-9][0-9]{9}" value="${escapeHtml(adminState.storagePhone)}" required>`) + `<p class="dialog-hint" id="storage-member-match">输入已绑定手机号，确认会员后登记</p>` + field('现有商品', 'productId', `<select name="productId" required>${productsData.products.filter(p => p.status === 'active').map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>`) + field('存入数量', 'quantity', number('quantity', 1, 1)) + field('存放天数', 'days', number('days', 30, 1)) + field('备注', 'note', '<input name="note" placeholder="可选">');
    } else if (type === 'withdraw') {
      title = `取酒 · ${item.product_name}`; path = `/storage/${item.id}/withdraw`;
      fields = `<p class="dialog-hint">${escapeHtml(item.phone || '未绑定手机号')} · ${escapeHtml(item.nickname)} · 当前剩余 ${item.quantity} 件 · 到期 ${item.expires_at.slice(0, 10)}</p>` + field('取出数量', 'quantity', number('quantity', 1, 1)) + field('备注', 'note', '<input name="note" placeholder="可选">');
    } else if (type === 'new-member' || type === 'edit-member') {
      title = item ? `管理会员 · ${item.phone || item.nickname}` : '新增会员'; path = item ? `/members/${item.id}` : '/members'; method = item ? 'PATCH' : 'POST';
      const tierOptions = `<option value="">普通会员</option>${adminState.data.tiers.filter(t => t.status === 'active').map(t => `<option value="${t.id}" ${item?.memberTierId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}`;
      fields = field('手机号', 'phone', `<input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[3-9][0-9]{9}" value="${escapeHtml(item?.phone)}" required>`) + field('姓名 / 昵称', 'nickname', `<input name="nickname" maxlength="50" value="${escapeHtml(item?.nickname)}" required>`) + (item ? `<p class="dialog-hint">微信账号：${item.wechatBound ? '已绑定' : '未绑定'} · ID ${item.id}</p>` + field('会员等级', 'memberTierId', `<select name="memberTierId">${tierOptions}</select>`) + field('有效期', 'memberExpiresAt', `<input name="memberExpiresAt" type="date" value="${escapeHtml(item.memberExpiresAt?.slice(0,10))}">`) + field('积分余额', 'points', number('points', item.points, 0)) + field('储值余额（元）', 'stored', number('stored', item.stored, 0, '.01')) + field('赠金余额（元）', 'bonus', number('bonus', item.bonus, 0, '.01')) + field('调整原因', 'reason', '<input name="reason" placeholder="余额或积分调整时必填">') : '');
    } else if (type === 'new-tier' || type === 'edit-tier') {
      title = item ? `编辑等级 · ${item.name}` : '新增会员等级'; path = item ? `/member-tiers/${item.id}` : '/member-tiers'; method = item ? 'PATCH' : 'POST';
      fields = field('等级名称', 'name', `<input name="name" maxlength="30" value="${escapeHtml(item?.name)}" required>`) + field('升级方式', 'upgradeType', `<select name="upgradeType">${[['spend','累计消费'],['recharge','储值消费'],['monthly','付费月卡']].map(([value,label]) => `<option value="${value}" ${item?.upgrade_type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`) + field('升级门槛 / 月卡价格（元）', 'threshold', number('threshold', item ? item.threshold_cents / 100 : 1000, '.01', '.01')) + field('折扣系数（0.9 = 九折）', 'discount', number('discount', item?.discount ?? 0.9, '.01', '.01')) + field('积分倍率', 'pointsRate', number('pointsRate', item?.points_rate ?? 1, 0, '.1')) + field('有效天数（0 为长期）', 'durationDays', number('durationDays', item?.duration_days ?? 0, 0)) + field('状态', 'status', `<select name="status"><option value="active">启用</option><option value="inactive" ${item?.status === 'inactive' ? 'selected' : ''}>停用</option></select>`);
    } else if (type === 'new-reward' || type === 'edit-reward') {
      const productsData = await adminApi('/products');
      title = item ? `编辑奖品 · ${item.name}` : '新增积分奖品'; path = item ? `/rewards/${item.id}` : '/rewards'; method = item ? 'PATCH' : 'POST';
      fields = field('奖品来源', 'productId', `<select name="productId"><option value="">自定义奖品</option>${productsData.products.map(p => `<option value="${p.id}" ${item?.product_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>`) + field('自定义名称', 'name', `<input name="name" maxlength="50" value="${escapeHtml(item?.product_id ? '' : item?.name)}" placeholder="选择现有商品时可留空">`) + field('奖品图片', 'imageFile', `<input name="imageFile" type="file" accept="image/png,image/jpeg,image/webp">${item?.imageUrl ? `<img class="dialog-preview" src="${escapeHtml(item.imageUrl)}" alt="奖品图片">` : ''}`) + field('兑换积分', 'points', number('points', item?.points ?? 100, 1)) + field('可兑数量', 'stock', number('stock', item?.stock ?? 10, 0)) + field('状态', 'status', `<select name="status"><option value="active">上架</option><option value="inactive" ${item?.status === 'inactive' ? 'selected' : ''}>下架</option></select>`);
    } else if (type === 'stock') {
      title = `调整库存 · ${item.name}`; path = `/inventory/${item.id}/adjust`;
      fields = `<p class="dialog-hint">当前库存 ${item.stock} 件。增加填正数，减少填负数。</p>` + field('变动数量', 'change', '<input name="change" type="number" step="1" required>') + field('调整原因', 'reason');
    } else if (type === 'new-product' || type === 'edit-product') {
      const categories = (await adminApi('/products')).categories;
      title = item ? `编辑商品 · ${item.name}` : '新增商品'; path = item ? `/products/${item.id}` : '/products'; method = item ? 'PATCH' : 'POST';
      const value = (v) => escapeHtml(v ?? '');
      fields = field('商品名称', 'name', `<input name="name" value="${value(item?.name)}" required>`) + field('分类', 'categoryId', `<select name="categoryId">${categories.map(c => `<option value="${c.id}" ${item?.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>`) + field('简介', 'detail', `<textarea name="detail" maxlength="500" rows="4" placeholder="填写商品口味、规格、适合人数等介绍">${value(item?.detail)}</textarea>`) + field('商品图片', 'imageFile', `<input name="imageFile" type="file" accept="image/png,image/jpeg,image/webp">${item?.image_url ? `<img class="dialog-preview" src="${value(item.image_url)}" alt="当前商品图片">` : ''}`) + field('原价（元）', 'price', number('price', item?.price ?? '', 0, '.01')) + field('会员价（元）', 'memberPrice', number('memberPrice', item?.memberPrice ?? '', 0, '.01')) + (adminState.account.role === 'super' ? field('进货价（元）', 'cost', number('cost', item ? item.cost_cents / 100 : 0, 0, '.01')) : '') + field('库存数量', 'stock', number('stock', item?.stock ?? 0, 0)) + field('标签', 'tag', `<input name="tag" value="${value(item?.tag)}">`) + field('色系', 'color', `<select name="color">${['amber','teal','red','yellow','purple','pink'].map(c => `<option ${item?.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`) + field('赠金支付', 'allowBonus', `<select name="allowBonus"><option value="0">不支持</option><option value="1" ${item?.allow_bonus ? 'selected' : ''}>支持</option></select>`) + field('销售状态', 'status', `<select name="status"><option value="active">在售</option><option value="inactive" ${item?.status === 'inactive' ? 'selected' : ''}>下架</option></select>`);
    } else if (type === 'new-loss') {
      const data = await adminApi('/products'); title = '上报赠酒 / 报损'; path = '/losses';
      fields = field('类型', 'type', '<select name="type"><option value="gift">赠酒</option><option value="damage">报损</option></select>') + field('商品', 'productId', `<select name="productId" required>${data.products.map(p => `<option value="${p.id}">${escapeHtml(p.name)} · 库存 ${p.stock}</option>`).join('')}</select>`) + field('数量', 'quantity', number('quantity', 1, 1)) + field('原因', 'reason');
    } else if (type === 'new-account' || type === 'edit-account') {
      const data = await adminApi('/accounts'); title = item ? `编辑账号 · ${item.username}` : '新增账号'; path = item ? `/accounts/${item.id}` : '/accounts'; method = item ? 'PATCH' : 'POST';
      fields = (item ? `<p class="dialog-hint">账号：${escapeHtml(item.username)}</p>` : field('登录账号', 'username', '<input name="username" minlength="3" pattern="[a-zA-Z0-9_]+" required>')) + field('显示名称', 'displayName', `<input name="displayName" value="${escapeHtml(item?.displayName || '')}" required>`) + field(item ? '重设密码（留空不修改）' : '初始密码（至少 10 位）', 'password', `<input name="password" type="password" minlength="10" ${item ? '' : 'required'} autocomplete="new-password">`) + field('账号级别', 'role', `<select name="role"><option value="staff">店员</option><option value="manager" ${item?.role === 'manager' ? 'selected' : ''}>管理员</option></select>`) + (item ? field('状态', 'status', `<select name="status"><option value="active">启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select>`) : '') + `<fieldset class="permission-fields"><legend>授权模块</legend>${data.modules.map(m => `<label><input type="checkbox" name="permissions" value="${m}" ${item?.permissions.includes(m) ? 'checked' : ''}>${adminTitles[m]}</label>`).join('')}</fieldset>`;
    } else if (type === 'password') {
      title = '修改密码'; path = '/change-password'; fields = field('当前密码', 'oldPassword', '<input name="oldPassword" type="password" required>') + field('新密码（至少 10 位）', 'newPassword', '<input name="newPassword" type="password" minlength="10" required>');
    } else if (type === 'new-table') {
      title = '新增桌台'; path = '/tables'; fields = field('桌号', 'tableNo', '<input name="tableNo" placeholder="如 A-09" required>');
    } else if (type === 'verify-group') {
      title = '录入团购核销'; path = '/group-buy/verify'; fields = field('平台', 'platform', '<select name="platform"><option>美团</option><option>抖音</option></select>') + field('券码', 'voucherNo') + field('套餐名称', 'packageName') + field('金额（元）', 'amount', number('amount', 0, 0, '.01'));
    } else if (type === 'new-wallet') {
      title = '新增储值套餐'; path = '/wallet-packages'; fields = field('套餐名称', 'name') + field('支付金额（元）', 'pay', number('pay', '', 0, '.01')) + field('储值金额（元）', 'stored', number('stored', '', 0, '.01')) + field('赠金（元）', 'bonus', number('bonus', 0, 0, '.01'));
    }
  } catch (error) { adminNotice(error.message); return; }
  adminState.dialog = type;
  root.innerHTML = `<div class="admin-dialog-backdrop"><section class="admin-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header><h2>${escapeHtml(title)}</h2><button type="button" data-close-dialog aria-label="关闭">×</button></header><form id="admin-operation-form"><div class="dialog-fields">${fields}</div><p class="dialog-error" aria-live="polite"></p><footer><button type="button" class="outline-button" data-close-dialog>取消</button><button type="submit" class="primary-small">确认保存</button></footer></form></section></div>`;
  const close = () => { adminState.dialog = null; root.innerHTML = ''; };
  root.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = close);
  root.querySelector('.admin-dialog-backdrop').onclick = event => { if (event.target.classList.contains('admin-dialog-backdrop')) close(); };
  if (type === 'new-storage') {
    const input = root.querySelector('[name="phone"]'), match = root.querySelector('#storage-member-match');
    input.oninput = async () => { const phone = input.value.trim(); match.textContent = '输入已绑定手机号，确认会员后登记'; if (!/^1[3-9]\d{9}$/.test(phone)) return; try { const result = await adminApi(`/members?phone=${phone}`); if (input.value.trim() === phone) match.textContent = result.members.find(m => m.phone === phone) ? `已找到：${result.members.find(m => m.phone === phone).nickname}` : '未找到该手机号，请先在会员管理中绑定'; } catch (error) { match.textContent = error.message; } };
    if (input.value) input.oninput();
  }
  root.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      if (type === 'new-account' || type === 'edit-account') { payload.permissions = [...form.querySelectorAll('[name="permissions"]:checked')].map(input => input.value); if (item && !payload.password) delete payload.password; }
      if (type === 'edit-member' && payload.memberTierId !== String(item.memberTierId ?? '') && payload.memberExpiresAt === (item.memberExpiresAt?.slice(0, 10) || '')) delete payload.memberExpiresAt;
      if (type === 'edit-member' && (Number(payload.points) !== item.points || Number(payload.stored) !== item.stored || Number(payload.bonus) !== item.bonus) && !payload.reason.trim()) throw new Error('调整积分或钱包余额时请填写原因');
      if (type === 'new-product' || type === 'edit-product' || type === 'new-reward' || type === 'edit-reward') {
        payload.allowBonus = payload.allowBonus === '1';
        const file = form.querySelector('[name="imageFile"]').files[0]; delete payload.imageFile;
        if (file) {
          if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5MB');
          const response = await fetch('/api/admin/products/image', { method:'POST', headers:{ Authorization:`Bearer ${sessionStorage.getItem('adminToken')}`, 'Content-Type':file.type }, body:await file.arrayBuffer() });
          const result = await response.json(); if (!response.ok) throw new Error(result.message || '图片上传失败');
          payload.imageUrl = result.imageUrl;
        }
      }
      await adminApi(path, { method, body: JSON.stringify(payload) });
      close();
      await renderAdmin();
      adminNotice('操作已保存');
    } catch (error) { form.querySelector('.dialog-error').textContent = error.message; submit.disabled = false; }
  };
  root.querySelector('input, select')?.focus();
}

if (location.pathname.startsWith('/admin')) {
  setInterval(async () => {
    if (document.hidden || !adminState.account || adminState.dialog || adminPolling) return;
    adminPolling = true;
    try {
      if (adminState.section === 'dashboard' || adminState.section === 'orders') {
        const data = await adminApi('/summary');
        const pendingCount = Number(data.activeOrders || 0);
        const newOrderCount = lastPendingOrderCount !== null && pendingCount > lastPendingOrderCount ? pendingCount - lastPendingOrderCount : 0;
        lastPendingOrderCount = pendingCount;
        if (adminState.section === 'dashboard') {
          await renderAdmin();
        } else {
          await renderAdmin();
        }
        if (newOrderCount) adminNotice(`收到 ${newOrderCount} 笔新订单，请及时处理`);
      } else if (adminState.section === 'products' || adminState.section === 'tables' || adminState.section === 'storage' || adminState.section === 'members') {
        await renderAdmin();
      }
    } catch (error) { console.error('概览刷新失败', error); }
    finally { adminPolling = false; }
  }, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !adminState.dialog && adminState.account) renderAdmin(); });
}

function showToast(message) { state.toast = message; renderCustomer(); setTimeout(() => { state.toast = ''; renderCustomer(); }, 2200); }

if (location.pathname.startsWith('/admin')) initAdmin();
else {
  renderCustomer();
  loadData();
}
