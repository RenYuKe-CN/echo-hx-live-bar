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

const state = { cart: [], category: '推荐', toast: '', paymentOpen: false, upgradeOpen: false, packages: [], coupons: [], selectedCouponId: '', paymentMethod: 'balance', checkout: null, sessionId: null, user: null, membership: null, table: null, miniPage: {}, loading: true };

function money(value) { return `¥${Number(value || 0).toFixed(2)}`; }

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
    const couponData = await api('/me/coupons').catch(error => {
      console.warn('优惠券加载失败，继续展示点单页', error);
      return { coupons: [] };
    });
    state.miniPage = Object.fromEntries(pageData.entries.map(entry => [entry.key, entry.title]));
    products = productData.products.filter(product => product.status === 'active' && Number(product.stock) > 0);
    state.sessionId = sessionData.session.id;
    state.user = sessionData.user;
    state.membership = sessionData.membership;
    state.table = sessionData.table;
    state.coupons = (couponData.coupons || []).filter(coupon => coupon.status === 'available');
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
        <div class="member-mark">${state.user?.memberLevel?.slice(0, 1) || '会'}</div>
        <div><strong>${state.membership?.active ? state.user?.memberLevel : '普通会员'}${state.membership?.active && state.user?.memberExpiresAt ? ` · 有效期至 ${state.user.memberExpiresAt.slice(0, 10).replaceAll('-', '.')}` : ''}</strong><span>${state.membership?.active ? '本单享会员价，' : ''}支付后预计获得 ${cartTotals().points} 积分</span></div>
        <button class="text-button">查看权益 →</button>
      </section>
      ${!state.loading && !state.membership?.active ? '<div class="upgrade-banner"><span>当前按原价结算，是否充值余额并升级会员？</span><button class="text-button" data-upgrade>查看储值套餐</button></div>' : ''}
      <nav class="category-tabs">${['推荐', '啤酒', '鸡尾酒', '小吃', '套餐'].map(c => `<button class="${state.category === c ? 'active' : ''}" data-category="${c}">${c}</button>`).join('')}</nav>
      <section class="product-list">${products.filter(p => state.category === '推荐' || p.category === state.category).map(productCard).join('')}</section>
      <section class="order-dock">
        <div class="dock-total"><span class="muted">本桌待支付${state.membership?.active ? ` · ${escapeHtml(state.user?.memberLevel)}价` : ' · 原价'}</span><div>${state.membership?.active && cartTotals().discount ? `<del>${money(cartTotals().original)}</del>` : ''}<strong>${money(cartTotals().member)}</strong></div><small>${state.membership?.active ? `已优惠 ${money(cartTotals().discount)}` : '充值余额升级后享会员价'}</small></div>
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
      await refreshCheckout();
      state.paymentMethod = state.checkout.balanceAvailable ? 'balance' : state.checkout.mixedPaymentAvailable ? 'mixed' : 'wechat';
      state.paymentOpen = true;
      renderCustomer();
    } catch (error) { showToast(error.message); }
  };
  document.querySelector('#close-payment')?.addEventListener('click', () => { state.paymentOpen = false; renderCustomer(); });
  document.querySelectorAll('[data-select-coupon]').forEach(button => button.onclick = async () => {
    state.selectedCouponId = button.dataset.selectCoupon || '';
    try {
      await refreshCheckout();
      state.paymentMethod = state.checkout.balanceAvailable ? 'balance' : state.checkout.mixedPaymentAvailable ? 'mixed' : 'wechat';
      renderCustomer();
    } catch (error) { showToast(error.message); }
  });
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

function normalizeCheckout(checkout) {
  const bonusUsable = Number(checkout.bonusUsable ?? Math.min(Number(checkout.bonus || 0), Number(checkout.bonusEligible || 0), Number(checkout.payable || 0)));
  const storedUsable = Number(checkout.storedUsable ?? Math.min(Number(checkout.stored || 0), Math.max(Number(checkout.payable || 0) - bonusUsable, 0)));
  const balanceDeduction = Number(checkout.balanceDeduction ?? bonusUsable + storedUsable);
  const wechatDue = Number(checkout.wechatDue ?? Math.max(Number(checkout.payable || 0) - balanceDeduction, 0));
  return { ...checkout, accountBalance: Number(checkout.accountBalance ?? checkout.stored ?? 0), accountBonus: Number(checkout.accountBonus ?? checkout.bonus ?? 0), bonusUsable, storedUsable, balanceDeduction, wechatDue, balanceAvailable: checkout.balanceAvailable ?? wechatDue === 0, mixedPaymentAvailable: checkout.mixedPaymentAvailable ?? (balanceDeduction > 0 && wechatDue > 0) };
}

async function refreshCheckout() {
  const query = state.selectedCouponId ? `?userCouponId=${encodeURIComponent(state.selectedCouponId)}` : '';
  state.checkout = normalizeCheckout(await api(`/sessions/${state.sessionId}/checkout${query}`));
  return state.checkout;
}

function paymentSheet() {
  const totals = cartTotals();
  const checkout = state.checkout || {};
  const usingCoupon = Boolean(checkout.usingCoupon);
  const original = Number(checkout.original ?? totals.original);
  const payable = Number(checkout.payable ?? totals.member);
  const items = state.cart.map(item => {
    const product = products[item.index];
    const itemPrice = state.membership?.active ? product.memberPrice : product.price;
    const itemDiscounted = state.membership?.active && product.memberPrice < product.price;
    return `<div class="payment-item"><div class="payment-product"><div class="mini-product-art ${product.color}">${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="">` : escapeHtml(product.name.slice(0, 1))}</div><div><strong>${escapeHtml(product.name)}</strong><small>${itemDiscounted ? `<del>${money(product.price * item.qty)}</del>` : ''}<b class="${itemDiscounted ? '' : 'regular-price'}">${money(itemPrice * item.qty)}</b></small>${!state.membership?.active ? `<small class="reference-price">会员价 ${money((product.referenceMemberPrice ?? product.price) * item.qty)}</small>` : ''}</div></div><div class="payment-item-actions"><div class="quantity-controls compact"><button data-minus="${item.index}" title="减少一份">−</button><b>${item.qty}</b><button data-add="${item.index}" title="增加一份">+</button></div><button class="remove-button" data-remove="${item.index}" title="移除商品">删除</button></div></div>`;
  }).join('');
  const balanceDetail = `账户储值 ${money(checkout.accountBalance ?? checkout.stored ?? 0)} · 本单抵扣 ${money(checkout.balanceDeduction ?? 0)}`;
  const buttonText = state.paymentMethod === 'balance' ? `确认余额支付 ${money(payable)}` : state.paymentMethod === 'mixed' ? `余额抵扣 ${money(checkout.balanceDeduction ?? 0)}，微信支付 ${money(checkout.wechatDue ?? 0)}` : `创建待支付订单 ${money(checkout.wechatDue ?? payable)}`;
  const couponOptions = state.coupons.length ? `<div class="coupon-picker"><strong>优惠券</strong><div class="coupon-options"><button data-select-coupon="" class="coupon-choice ${!state.selectedCouponId ? 'selected' : ''}"><span>不使用优惠券</span><small>${state.membership?.active ? '按会员价结算' : '按原价结算'}</small></button>${state.coupons.map(coupon => `<button data-select-coupon="${coupon.id}" class="coupon-choice ${String(state.selectedCouponId) === String(coupon.id) ? 'selected' : ''}"><span>${escapeHtml(coupon.name)}</span><small>${coupon.isProductVoucher ? '赠送指定商品 1 件' : coupon.type === 'fixed' ? `立减 ${money(coupon.amount)}` : `${(Number(coupon.discountRate) * 10).toFixed(1)} 折`} · 可叠加会员价</small></button>`).join('')}</div></div>` : '';
  const discountRows = `${state.membership?.active ? `<div><span>会员优惠</span><strong class="discount">-${money(checkout.memberDiscount ?? totals.discount)}</strong></div>` : '<div><span>当前身份</span><strong>普通会员</strong></div>'}${usingCoupon ? `<div><span>${checkout.productVoucher ? '商品兑换券赠送' : '优惠券优惠'}</span><strong class="discount">-${money(checkout.couponDiscount)}</strong></div><small class="payment-rule-note">优惠券可叠加会员价，不可使用赠金，可使用储值本金</small>` : ''}`;
  return `<div class="payment-backdrop"><section class="payment-sheet"><div class="sheet-heading"><div><span class="eyebrow">ORDER PREVIEW</span><h2>确认本桌订单</h2><p>请确认商品、数量和优惠</p></div><button id="close-payment" class="close-button" title="关闭">×</button></div><div class="payment-table"><div class="payment-table-head"><span>商品清单</span><span>结算价</span></div>${items}</div>${couponOptions}<div class="payment-summary"><div><span>商品原价</span><strong>${money(original)}</strong></div>${discountRows}<div class="payable-row"><span>应付金额</span><strong>${money(payable)}</strong></div>${Number(checkout.balanceDeduction || 0) > 0 ? `<div><span>储值本金抵扣</span><strong>-${money(checkout.storedUsable || 0)}</strong></div>${Number(checkout.bonusUsable || 0) > 0 ? `<div><span>赠金抵扣</span><strong>-${money(checkout.bonusUsable)}</strong></div>` : ''}<div><span>微信支付</span><strong>${money(checkout.wechatDue || 0)}</strong></div>` : ''}</div><div class="payment-methods"><strong>支付方式</strong><button data-payment-method="mixed" class="payment-choice ${state.paymentMethod === 'mixed' ? 'selected' : ''}" ${!checkout.mixedPaymentAvailable ? 'disabled' : ''}><span>余额 + 微信支付<small>${balanceDetail} · 微信支付 ${money(checkout.wechatDue ?? 0)} · ${usingCoupon ? '赠金不可用' : `赠金抵扣 ${money(checkout.bonusUsable ?? 0)}`}</small></span><b>${state.paymentMethod === 'mixed' ? '●' : '○'}</b></button><button data-payment-method="balance" class="payment-choice ${state.paymentMethod === 'balance' ? 'selected' : ''}" ${!checkout.balanceAvailable ? 'disabled' : ''}><span>余额支付<small>储值本金 ${money(checkout.accountBalance ?? checkout.stored ?? 0)} · ${usingCoupon ? '赠金不可用' : `赠金 ${money(checkout.accountBonus ?? checkout.bonus ?? 0)}`} · 本单最多抵扣 ${money(checkout.balanceDeduction ?? 0)}</small></span><b>${state.paymentMethod === 'balance' ? '●' : '○'}</b></button><button data-payment-method="wechat" class="payment-choice ${state.paymentMethod === 'wechat' ? 'selected' : ''}"><span>仅微信支付<small>不使用账户余额，支付 ${money(checkout.payable ?? payable)}</small></span><b>${state.paymentMethod === 'wechat' ? '●' : '○'}</b></button></div><button id="confirm-payment" class="payment-button">${buttonText}</button></section></div>`;
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
    const result = await api(`/sessions/${state.sessionId}/orders`, { method: 'POST', body: JSON.stringify({ paymentMethod: state.paymentMethod, userCouponId: state.selectedCouponId || undefined, note: state.orderNote }) });
    state.paymentOpen = false;
    state.selectedCouponId = '';
    state.checkout = null;
    await refreshCart();
    renderCustomer();
    showToast(result.payment.status === 'paid' ? `订单 ${result.order.order_no} 余额支付成功` : `订单 ${result.order.order_no} 待支付，微信需支付 ${result.order.wechatPaid || '0.00'} 元`);
  } catch (error) { renderCustomer(); showToast(error.message); }
}

const adminState = { section: 'dashboard', data: null, toast: '', dialog: null, account: null, memberPhone: '', storagePhone: '', reportRange: { start: '', end: '' }, pages: { accounts: 1, logs: 1, products: 1, tables: 1, orders: 1, members: 1, storage: 1, storageMovements: 1, groupBuy: 1, wallet: 1, rewards: 1, coupons: 1, messages: 1, redemptions: 1, losses: 1, reportDaily: 1 }, pageSizes: { accounts: 20, logs: 20, products: 20, tables: 20, orders: 20, members: 20, storage: 20, storageMovements: 20, groupBuy: 20, wallet: 20, rewards: 20, coupons: 20, messages: 20, redemptions: 20, losses: 20, reportDaily: 20 }, pos: { phone: '', tableId: '', items: {}, method: 'cash', mode: 'order', packageId: '', requestId: crypto.randomUUID(), error: '' } };
let adminRenderVersion = 0;
let lastPendingOrderCount = null;
let lastPendingRefundCount = null;
let adminPolling = false;
const adminModules = [['dashboard','经营概览'],['mini-page','小程序页面'],['pos','收银点单'],['orders','订单管理'],['tables','桌台管理'],['members','会员管理'],['storage','存酒管理'],['group-buy','团购核销'],['products','商品与库存'],['wallet','储值活动'],['rewards','积分兑换'],['coupons','优惠券管理'],['messages','消息中心'],['reports','数据报表'],['losses','赠酒报损'],['accounts','账号管理'],['logs','操作日志'],['settings','接口配置'],['backups','备份与恢复']];
const adminApi = (path, options = {}) => api(`/admin${path}`, options);
const adminTitles = Object.fromEntries(adminModules);
const adminGroups = [
  { title: '经营中心', sections: ['dashboard', 'reports'] },
  { title: '收银与订单', sections: ['pos', 'orders', 'group-buy'] },
  { title: '桌台管理', sections: ['tables'] },
  { title: '会员中心', sections: ['members', 'storage', 'wallet', 'rewards', 'coupons', 'messages'] },
  { title: '商品与库存', sections: ['products', 'losses'] },
  { title: '系统设置', sections: ['mini-page', 'accounts', 'logs', 'settings', 'backups'] }
];

function organizeAdminNavigation() {
  const permissions = adminState.account.permissions;
  const groups = adminGroups.map(group => ({ ...group, sections: group.sections.filter(id => permissions.includes(id)) })).filter(group => group.sections.length);
  const current = groups.find(group => group.sections.includes(adminState.section));
  document.querySelector('.side-nav').innerHTML = groups.map(group => `<button type="button" class="admin-group-link ${group === current ? 'current' : ''}" data-admin-section="${group === current ? adminState.section : group.sections[0]}" ${group === current ? 'aria-current="true"' : ''}>${group.title}</button>`).join('');
  if (current?.sections.length > 1) document.querySelector('.admin-header').insertAdjacentHTML('afterend', `<nav class="admin-section-tabs" aria-label="${current.title}">${current.sections.map(id => `<button type="button" class="${id === adminState.section ? 'active' : ''}" data-admin-section="${id}" ${id === adminState.section ? 'aria-current="page"' : ''}>${adminTitles[id]}</button>`).join('')}</nav>`);
  document.querySelectorAll('[data-admin-section]').forEach(button => {
    if (!permissions.includes(button.dataset.adminSection)) button.remove();
  });
}

function adminDataSummary(section, data) {
  let values = [];
  if (section === 'reports' && data.daily) {
    const total = key => data.daily.reduce((sum, row) => sum + reportNumber(row[key]), 0);
    values = [['区间净销售额', adminMoney(total('revenue'))], ['区间净利润', adminMoney(total('profit'))], ['区间充值收款', adminMoney(total('recharge'))], ['区间订单数', `${total('orders')} 笔`]];
  }
  if (section === 'orders') {
    const orders = data.orders || [];
    values = [['已加载订单', `${orders.length} 笔`], ['待支付', `${orders.filter(o => o.payment_status === 'pending').length} 笔`], ['待送达', `${orders.filter(o => o.payment_status === 'paid' && o.status === 'awaiting_delivery').length} 笔`], ['已取消', `${orders.filter(o => o.status === 'cancelled').length} 笔`]];
  }
  if (section === 'products') {
    const products = data.products || [];
    values = [['商品种类', `${products.length} 种`], ['在售', `${products.filter(p => p.status === 'active' && adminAvailableStock(p) > 0).length} 种`], ['缺货', `${products.filter(p => adminAvailableStock(p) <= 0).length} 种`], ['可售库存', products.reduce((sum, p) => sum + adminAvailableStock(p), 0)]];
  }
  return values.length ? `<section class="admin-data-summary" aria-label="当前列表汇总">${values.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</section>` : '';
}
const configLabels = { public_api_base_url:'小程序 API 正式 HTTPS 地址', wechat_app_id:'微信小程序 AppID', wechat_app_secret:'微信小程序 AppSecret', wechat_mch_id:'微信支付商户号', wechat_api_v3_key:'微信支付 API v3 密钥', wechat_merchant_serial:'微信支付商户证书序列号', wechat_private_key:'微信支付商户私钥', wechat_notify_url:'微信支付回调地址', meituan_client_id:'美团客户端 ID', meituan_client_secret:'美团客户端密钥', douyin_client_key:'抖音客户端 Key', douyin_client_secret:'抖音客户端密钥', storage_provider:'对象存储类型（local 或 s3）', storage_endpoint:'对象存储 S3 Endpoint', storage_region:'对象存储区域', storage_bucket:'对象存储 Bucket', storage_access_key:'对象存储 Access Key', storage_secret_key:'对象存储 Secret Key', storage_public_base_url:'对象存储公开访问地址', storage_path_prefix:'对象存储目录前缀' };
const miniIconLabels = { gift:'礼 · 礼物', bottle:'酒 · 存酒', wallet:'¥ · 钱包', receipt:'单 · 订单', star:'★ · 星标', glass:'杯 · 酒杯', card:'卡 · 会员卡', bag:'兑 · 奖品' };
const miniEntryLabels = { app_name:'小程序显示名称', home_title:'首页欢迎标题', rewards:'兑换中心', storage:'我的存酒', recharge:'会员充值', orders:'我的订单' };
function adminMoney(value) { return `¥${Number(value || 0).toFixed(2)}`; }
function adminPhysicalStock(product) { return Number(product?.physicalStock ?? product?.stock ?? 0); }
function adminReservedStock(product) { return Number(product?.reservedStock ?? product?.reserved_stock ?? 0); }
function adminAvailableStock(product) { return Math.max(Number(product?.availableStock ?? (adminPhysicalStock(product) - adminReservedStock(product))), 0); }
function orderPaymentSummary(order) {
  if (order.payment_method === 'mixed') return `赠金 ${adminMoney(order.bonusPaid)} / 储值 ${adminMoney(order.storedPaid)} / 微信 ${adminMoney(order.wechatPaid)}`;
  if (order.payment_method === 'balance') return `储值 ${adminMoney(order.storedPaid)} / 赠金 ${adminMoney(order.bonusPaid)}`;
  if (order.payment_method === 'wechat') return `微信 ${adminMoney(Number(order.wechatPaid) > 0 ? order.wechatPaid : order.payableAmount)}`;
  return '线下';
}
function refundStatusLabel(status) { return ({ pending: '待审核', approved: '已通过', rejected: '已拒绝', processing: '退款处理中', success: '退款成功', failed: '退款失败' })[status] || status || ''; }
function adminRefundCell(order) {
  const request = order.refundRequest;
  const transaction = order.refundTransaction;
  const parts = [];
  if (Number(order.refundedAmount) > 0) parts.push(`<span>已退款 ${adminMoney(order.refundedAmount)}</span>`);
  if (Number(order.refundableAmount) > 0 && order.payment_status === 'paid') parts.push(`<span>可退 ${adminMoney(order.refundableAmount)}</span>`);
  if (request) parts.push(`<span class="refund-chip ${request.status}">申请${refundStatusLabel(request.status)} ${adminMoney(request.amount)}</span>`);
  if (transaction) parts.push(`<span class="refund-chip ${transaction.status}">${refundStatusLabel(transaction.status)} ${adminMoney(transaction.amount)}</span>`);
  if (request?.reason) parts.push(`<small>原因：${escapeHtml(request.reason)}</small>`);
  if (request?.rejectReason) parts.push(`<small class="warning-text">拒绝：${escapeHtml(request.rejectReason)}</small>`);
  return parts.length ? `<div class="admin-refund-cell">${parts.join('')}</div>` : '<span class="muted-cell">无</span>';
}
function adminRefundActions(order) {
  if (!['super', 'manager'].includes(adminState.account.role)) return '';
  const request = order.refundRequest;
  const transaction = order.refundTransaction;
  const buttons = [];
  if (request?.status === 'pending') buttons.push(`<button class="table-action" data-review-refund="${request.id}">审核退款</button>`);
  if (transaction && ['pending', 'processing'].includes(transaction.status) && transaction.wechatCents) buttons.push(`<button class="table-action" data-query-refund="${transaction.id}">查询退款</button>`);
  if (order.payment_status === 'paid' && ['awaiting_delivery', 'completed'].includes(order.status) && Number(order.refundableAmount) > 0 && request?.status !== 'pending' && !['pending', 'processing'].includes(transaction?.status)) buttons.push(`<button class="table-action" data-admin-refund="${order.id}">退款</button>`);
  return buttons.join(' ');
}
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
function messageTemplateValueKeys(template) {
  if (!template) return [];
  const keys = new Set();
  const source = `${template.title_template || ''} ${template.content_template || ''}`;
  for (const match of source.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) keys.add(match[1]);
  try {
    const mapping = JSON.parse(template.field_mapping || '{}');
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
      Object.values(mapping).forEach(value => {
        if (/^[a-zA-Z0-9_]+$/.test(String(value))) keys.add(String(value));
      });
    }
  } catch { /* An invalid mapping is reported when the template is saved. */ }
  return [...keys];
}
function messageTemplateValues(template) {
  return JSON.stringify(Object.fromEntries(messageTemplateValueKeys(template).map(key => [key, ''])), null, 2);
}
function adminTable(headers, rows) { return `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-cell">暂无数据</td></tr>`}</tbody></table></div>`; }
function adminPageQuery(key) { return `page=${adminState.pages[key] || 1}&pageSize=${adminState.pageSizes[key] || 20}`; }
function adminPagination(key, pagination) {
  if (!pagination) return '';
  const current = Math.max(1, Math.min(Number(pagination.page) || 1, Number(pagination.totalPages) || 1));
  const total = Math.max(1, Number(pagination.totalPages) || 1);
  const visible = new Set([1, total]);
  for (let page = Math.max(1, current - 2); page <= Math.min(total, current + 2); page++) visible.add(page);
  const pages = [...visible].sort((a, b) => a - b);
  const numbers = pages.map((page, index) => `${index && page - pages[index - 1] > 1 ? '<span class="page-gap" aria-hidden="true">…</span>' : ''}<button type="button" class="page-number ${page === current ? 'active' : ''}" data-page-jump="${key}" data-page="${page}" aria-label="第 ${page} 页" ${page === current ? 'aria-current="page"' : ''}>${page}</button>`).join('');
  return `<nav class="admin-pagination" aria-label="列表分页"><span class="page-total">共 ${pagination.total} 条 · 第 ${current} / ${total} 页</span><div class="page-controls"><button type="button" data-page-prev="${key}" ${current > 1 ? '' : 'disabled'}>上一页</button>${numbers}<button type="button" data-page-next="${key}" ${current < total ? '' : 'disabled'}>下一页</button></div><select data-page-size="${key}" aria-label="每页条数"><option value="20" ${pagination.pageSize === 20 ? 'selected' : ''}>每页 20 条</option><option value="50" ${pagination.pageSize === 50 ? 'selected' : ''}>每页 50 条</option></select></nav>`;
}
function adminListPath(section) {
  const query = key => adminPageQuery(key);
  if (section === 'accounts') return `/accounts?${query('accounts')}`;
  if (section === 'logs') return `/logs?${query('logs')}`;
  if (section === 'products') return `/products?${query('products')}`;
  if (section === 'group-buy') return `/group-buy?${query('groupBuy')}`;
  if (section === 'wallet') return `/wallet-packages?${query('wallet')}`;
  if (section === 'orders') return `/orders?${query('orders')}`;
  if (section === 'tables') return `/tables?${query('tables')}`;
  if (section === 'members') return `/members?phone=${encodeURIComponent(adminState.memberPhone)}&${query('members')}`;
  if (section === 'storage') return `/storage?phone=${encodeURIComponent(adminState.storagePhone)}&${query('storage')}&movementsPage=${adminState.pages.storageMovements || 1}&movementsPageSize=${adminState.pageSizes.storageMovements || 20}`;
  if (section === 'rewards') return `/rewards?${query('rewards')}&redemptionsPage=${adminState.pages.redemptions || 1}&redemptionsPageSize=${adminState.pageSizes.redemptions || 20}`;
  if (section === 'coupons') return `/coupons?${query('coupons')}`;
  if (section === 'messages') return `/messages?${query('messages')}`;
  if (section === 'losses') return `/losses?${query('losses')}`;
  if (section === 'backups') return '/backups';
  return `/${section}`;
}
function adminPaginationKey(section) {
  return { accounts: 'accounts', logs: 'logs', products: 'products', 'group-buy': 'groupBuy', wallet: 'wallet', orders: 'orders', tables: 'tables', members: 'members', storage: 'storage', rewards: 'rewards', coupons: 'coupons', messages: 'messages', losses: 'losses' }[section];
}
async function renderAdmin() {
  if (!adminState.account) return renderAdminLogin();
  const renderVersion = ++adminRenderVersion;
  if (!adminState.account.permissions.includes(adminState.section)) adminState.section = adminState.account.permissions[0] || 'dashboard';
  const renderingSection = adminState.section;
  let content = '<div class="admin-loading">正在加载...</div>';
  try {
    adminState.data = await adminApi(adminState.section === 'dashboard' ? '/summary' : adminState.section === 'pos' ? `/pos?phone=${encodeURIComponent(adminState.pos.phone)}` : adminState.section === 'reports' ? `/reports?start=${encodeURIComponent(adminState.reportRange.start)}&end=${encodeURIComponent(adminState.reportRange.end)}&dailyPage=${adminState.pages.reportDaily}&dailyPageSize=${adminState.pageSizes.reportDaily}` : adminListPath(adminState.section));
    const pageKey = adminPaginationKey(adminState.section);
    const pagination = pageKey ? adminState.data.pagination : adminState.data.dailyPagination;
    if (pagination && pagination.page !== adminState.pages[pageKey || 'reportDaily']) {
      adminState.pages[pageKey || 'reportDaily'] = pagination.page;
      return renderAdmin();
    }
    content = adminContent(adminState.section, adminState.data);
  } catch (error) { content = `<div class="panel error-panel">${escapeHtml(error.message)}</div>`; }
  if (renderVersion !== adminRenderVersion || renderingSection !== adminState.section) return;
  document.querySelector('#app').innerHTML = `<main class="admin-shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">EH</span><div><strong>Echo HX</strong><small>运营管理台</small></div></div><div class="store-switcher">Echo HX Live Bar</div><nav class="side-nav">${adminModules.filter(([id]) => adminState.account.permissions.includes(id)).map(([id, label]) => `<a class="${adminState.section === id ? 'current' : ''}" data-admin-section="${id}"><span>${label}</span></a>`).join('')}</nav><div class="sidebar-footer"><div class="staff-avatar">${escapeHtml(adminState.account.displayName.slice(0,1))}</div><div><strong>${escapeHtml(adminState.account.displayName)}</strong><small>${{super:'超级管理员',manager:'管理员',staff:'店员'}[adminState.account.role]}</small></div></div></aside><section class="admin-content"><header class="admin-header"><div><span class="eyebrow">ECHO HX LIVE BAR · 运营中心</span><h1>${adminTitles[adminState.section]}</h1></div><div class="header-actions"><button class="outline-button" data-action="password">修改密码</button><button class="outline-button" data-action="logout">退出登录</button><button class="outline-button" data-action="refresh">刷新数据</button></div></header>${content}</section></main><div id="admin-dialog-root"></div>${adminState.toast ? `<div class="toast admin-toast">${escapeHtml(adminState.toast)}</div>` : ''}`;
  organizeAdminNavigation();
  (document.querySelector('.admin-section-tabs') || document.querySelector('.admin-header')).insertAdjacentHTML('afterend', adminDataSummary(adminState.section, adminState.data || {}));
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
  if (section === 'dashboard') { const canOrders = adminState.account.permissions.includes('orders'); const canProducts = adminState.account.permissions.includes('products'); const canReviewRefunds = canOrders && ['super', 'manager'].includes(adminState.account.role); const m = data.todayMetrics || {}; const quickActions = [['pos','收银点单'],['storage','登记存酒'],['group-buy','核销团购'],['wallet','配置储值']].filter(([id]) => adminState.account.permissions.includes(id)); return `<section class="kpi-grid">${[['今日净销售额',adminMoney(m.revenue ?? data.todayRevenue),'今日'],['今日充值收款',adminMoney(m.recharge),'今日'],['营业桌台',`${data.activeTables} 桌`,'进行中'],['空闲桌台',`${data.idleTables} 桌`,'可安排']].map((k, i) => `<article class="kpi-card"><span>${k[0]}</span><strong data-kpi="${i}">${k[1]}</strong><small class="green">${k[2]}</small></article>`).join('')}</section><section class="panel daily-metrics"><div class="panel-heading"><div><h2>今日收款</h2><span>实时统计，赠金不计入净销售额</span></div></div><div class="metric-list"><div><span>线下收款</span><strong>${adminMoney(m.offline)}</strong></div></div></section><section class="admin-grid"><article class="panel"><div class="panel-heading"><div><h2>运营提醒</h2><span>点击提醒可直接进入处理页面</span></div></div><div class="task-list">${canProducts ? `<button class="task-link" data-admin-section="products"><b class="status-dot red-dot"></b><div><strong>库存预警 ${data.lowStock} 项</strong><span>${data.outOfStock ? `其中 ${data.outOfStock} 项已自动下架，请及时补货` : '请到商品与库存调整安全库存'}</span></div></button>` : ''}${canOrders ? `<button class="task-link" data-admin-section="orders"><b class="status-dot orange"></b><div><strong>待送达订单 ${data.activeOrders} 笔</strong><span>查看商品清单并确认送达${data.pendingPayment ? ` · 另有 ${data.pendingPayment} 笔待支付` : ''}</span></div></button>` : ''}${canReviewRefunds && Number(data.pendingRefunds || 0) > 0 ? `<button class="task-link" data-admin-section="orders"><b class="status-dot red-dot"></b><div><strong>待审核退款 ${Number(data.pendingRefunds)} 笔</strong><span>请及时审核用户退款申请</span></div></button>` : ''}</div></article><article class="panel"><div class="panel-heading"><div><h2>快速入口</h2><span>常用运营动作</span></div></div><div class="quick-actions">${quickActions.map(([id, label]) => `<button data-admin-section="${id}">${label}</button>`).join('')}</div></article></section><section class="panel dashboard-orders"><div class="panel-heading"><div><h2>新订单待处理</h2><span>支付成功后，店员送达才会完成</span></div>${canOrders ? '<button class="outline-button" data-admin-section="orders">查看全部</button>' : ''}</div>${data.pendingOrders?.length ? data.pendingOrders.map(o => `<article class="pending-order"><div><strong>${escapeHtml(o.order_no)} · ${escapeHtml(o.table_no)}桌</strong><span>${escapeHtml(o.nickname)} · ${o.paid_at}</span></div><div class="pending-items">${o.items.map(item => `<span>${escapeHtml(item.product_name)} × ${item.quantity}</span>`).join('')}</div></article>`).join('') : '<p class="empty-cell">暂无待送达订单</p>'}</section>`; }
  if (section === 'pos') return posContent(data);
  if (section === 'products') return `<div class="toolbar"><button class="primary-small" data-action="new-product">新增商品</button><span>商品资料、价格、赠金支付和库存统一管理；待支付订单会暂时占用可售库存</span></div>${adminTable(['商品','分类','原价','会员价','进货价','库存（实际 / 预占 / 可售）','赠金支付','状态','操作'], data.products.map(p => { const physical = adminPhysicalStock(p); const reserved = adminReservedStock(p); const available = adminAvailableStock(p); return `<tr><td><div class="product-cell">${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="">` : ''}<div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.detail || '')}</small></div></div></td><td>${escapeHtml(p.category || '-')}</td><td>${adminMoney(p.price)}</td><td class="green-text">${p.memberPrice == null ? '-' : adminMoney(p.memberPrice)}</td><td>${p.cost_cents == null ? '-' : adminMoney(p.cost_cents / 100)}</td><td class="${available <= 20 ? 'warning-text' : ''}"><span title="实际库存">${physical}</span> / <span title="待支付预占">${reserved}</span> / <strong title="可售库存">${available}</strong>${available <= 20 ? ' · 预警' : ''}</td><td>${p.allow_bonus ? '支持' : '不支持'}</td><td>${p.status === 'active' ? '在售' : '下架'}</td><td><button class="table-action" data-adjust-stock="${p.id}">调库存</button> <button class="table-action" data-edit-product="${p.id}">编辑</button> <button class="table-action" data-product-status="${p.id}" data-status="${p.status === 'active' ? 'inactive' : 'active'}">${p.status === 'active' ? '下架' : '上架'}</button></td></tr>`; }).join(''))}${adminPagination('products', data.pagination)}`;
  if (section === 'orders') return `${adminTable(['订单号','桌台','付款人','商品清单','订单备注','原价','会员优惠','优惠券优惠','实付','支付构成','净销售额','利润','退款信息','状态','操作'], data.orders.map(o => `<tr><td>${escapeHtml(o.order_no)}</td><td>${escapeHtml(o.table_no)}</td><td>${escapeHtml(o.nickname)}</td><td class="order-items-cell">${o.items.map(item => `<span>${escapeHtml(item.product_name)} × ${item.quantity}</span>`).join('')}</td><td class="order-note-cell">${o.note ? escapeHtml(o.note) : '<span class="muted-cell">无</span>'}</td><td>${adminMoney(o.originalAmount)}</td><td class="green-text">-${adminMoney(o.memberDiscount)}</td><td class="green-text">-${adminMoney(o.couponDiscount)}</td><td><strong>${adminMoney(o.payableAmount)}</strong></td><td>${orderPaymentSummary(o)}</td><td>${o.payment_status === 'paid' ? adminMoney(o.netSales) : '-'}</td><td>${adminState.account.role === 'super' && o.profit != null ? adminMoney(o.profit) : '-'}</td><td>${adminRefundCell(o)}</td><td>${escapeHtml(o.statusLabel)}</td><td>${o.payment_status === 'pending' ? (['wechat', 'mixed'].includes(o.payment_method) ? '等待微信支付' : `<button class="table-action" data-mark-paid="${o.id}">确认线下收款</button>`) : o.status === 'awaiting_delivery' ? `<button class="table-action" data-deliver="${o.id}">确认送达</button>` : '已完成'} ${adminRefundActions(o)}</td></tr>`).join(''))}${adminPagination('orders', data.pagination)}`;
  if (section === 'tables') return `<div class="toolbar"><button class="primary-small" data-action="new-table">新增桌台</button><span>每桌独立小程序码；扫码后自动进入对应桌台。删除后不再显示，已有历史订单仍会保留。</span></div>${adminTable(['桌号','小程序码','会话','已收金额','操作'], data.tables.map(t => `<tr><td><strong>${escapeHtml(t.table_no)}</strong></td><td><button class="table-action" data-table-code="${t.id}">预览 / 下载</button></td><td>${t.session_status === 'open' ? '进行中' : '空闲'}</td><td>${adminMoney(t.orderTotal)}</td><td><button class="table-action" data-edit-table="${t.id}">编辑</button> ${t.session_status === 'open' ? `<button class="table-action" data-close-table="${t.id}">结束本桌</button>` : `<button class="table-action danger-action" data-delete-table="${t.id}">删除</button>`}</td></tr>`).join(''))}${adminPagination('tables', data.pagination)}`;
  if (section === 'members') {
    const tierRows = data.tiers.map(t => {
      const stored = Number(t.stored_threshold_cents || (t.upgrade_type === 'recharge' ? t.threshold_cents : 0)) / 100;
      const spend = Number(t.spend_threshold_cents || (['spend', 'monthly'].includes(t.upgrade_type) ? t.threshold_cents : 0)) / 100;
      const relation = t.condition_mode === 'all' ? '同时满足' : '满足任一';
      return `<tr><td><span class="tier-color-dot" style="background:${escapeHtml(t.badge_color || '#C77F52')}"></span><strong>${escapeHtml(t.sort ?? 0)} · ${escapeHtml(t.name)}</strong></td><td>${stored ? adminMoney(stored) : '不限制'}</td><td>${spend ? adminMoney(spend) : '不限制'}</td><td>${stored && spend ? relation : '单条件'}</td><td>${Number(t.discount * 10).toFixed(1)} 折</td><td>${t.points_rate} 倍</td><td>${t.duration_days ? `${t.duration_days} 天` : '长期'}</td><td>${t.status === 'active' ? '启用' : '停用'}</td><td><button class="table-action" data-edit-tier="${t.id}">编辑</button></td></tr>`;
    }).join('');
    const birthdayCard = (title, rows, empty) => `<section class="birthday-reminder"><h3>${title}</h3>${rows.length ? `<div class="birthday-reminder-list">${rows.map(row => `<div class="birthday-reminder-item"><span><strong>${escapeHtml(row.nickname)}</strong><small>${escapeHtml(row.phone || '未绑定')} · ${escapeHtml(row.birthdayType === 'lunar' ? '农历' : '阳历')} ${escapeHtml(row.birthdayDate)}</small></span><em>${escapeHtml(row.birthdayLabel)}</em></div>`).join('')}</div>` : `<p class="empty-cell">${empty}</p>`}</section>`;
    return `<div class="toolbar member-toolbar"><form id="member-search"><input name="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="输入手机号搜索会员" value="${escapeHtml(adminState.memberPhone)}"><button class="outline-button">搜索</button></form><button class="primary-small" data-action="new-member">新增会员</button><button class="outline-button" data-action="new-tier">新增等级</button></div><div class="birthday-reminders">${birthdayCard('今日生日会员', data.birthdays?.today || [], '今天没有生日会员')}${birthdayCard('未来三日生日会员', data.birthdays?.upcoming || [], '未来三日没有生日会员')}</div>${adminTable(['会员','手机号','微信绑定','会员等级','到期','生日','后台备注','积分','储值','赠金','操作'], data.members.map(m => `<tr><td class="member-cell">${m.avatarUrl ? `<img class="member-avatar" src="${escapeHtml(m.avatarUrl)}" alt="">` : '<span class="member-avatar member-avatar-fallback">会</span>'}<span>${escapeHtml(m.nickname)}</span></td><td>${escapeHtml(m.phone || '未绑定')}</td><td>${m.wechatBound ? '已绑定' : '未绑定'}</td><td><span class="tier-color-dot" style="background:${escapeHtml(m.memberColor || '#C77F52')}"></span>${escapeHtml(m.memberLevel)}</td><td>${m.memberExpiresAt ? escapeHtml(m.memberExpiresAt.slice(0,10)) : '长期'}</td><td>${m.birthdayDate ? `${m.birthdayType === 'lunar' ? '农历' : '阳历'} ${escapeHtml(m.birthdayDate)}` : '-'}</td><td class="member-note-cell">${m.adminNote ? escapeHtml(m.adminNote) : '<span class="muted-cell">无</span>'}</td><td>${m.points}</td><td>${adminMoney(m.stored)}</td><td>${adminMoney(m.bonus)}</td><td><button class="table-action" data-edit-member="${m.id}">管理</button> <button class="table-action" data-member-coupon="${m.id}">发券</button> <button class="table-action" data-member-message="${m.id}">发消息</button>${adminState.account.role === 'super' ? ` <button class="table-action danger-action" data-delete-member="${m.id}">删除</button>` : ''}</td></tr>`).join(''))}${adminPagination('members', data.pagination)}<section class="storage-history"><h2>等级与升级条件</h2><p class="member-note">储值条件只计算储值余额，不含赠金；消费条件只计算已支付订单。到期后达标会续期，未达标按等级逐级下降。</p>${adminTable(['等级排序','储值余额条件','累计消费条件','条件关系','优惠','积分倍率','有效期','状态','操作'], tierRows)}</section>`;
  }
  if (section === 'storage') return `<div class="toolbar member-toolbar"><button class="primary-small" data-action="new-storage">登记存酒</button><form id="storage-search"><input name="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="按手机号查存酒" value="${escapeHtml(adminState.storagePhone)}"><button class="outline-button">搜索</button></form><span>有效存酒 ${data.stats.remaining} 件 · 7 天内到期 ${data.stats.expiring} 条</span></div>${adminTable(['手机号 / 用户','酒品','剩余数量','到期日期','状态','操作'], data.records.map(r => `<tr><td>${escapeHtml(r.phone || '未绑定')}<small>${escapeHtml(r.nickname)}</small></td><td>${escapeHtml(r.product_name)}</td><td>${r.quantity}</td><td class="${r.expired ? 'warning-text' : ''}">${escapeHtml(r.expires_at.slice(0, 10))}</td><td>${r.expired ? '已过期' : r.status === 'collected' ? '已取完' : '存放中'}</td><td>${!r.expired && r.status === 'stored' && r.quantity > 0 ? `<button class="table-action" data-withdraw="${r.id}">取酒</button>` : '-'}</td></tr>`).join(''))}${adminPagination('storage', data.pagination)}<section class="storage-history"><h2>存取流水</h2>${adminTable(['时间','手机号','商品','类型','数量','操作员','备注'], data.movements.map(m => `<tr><td>${escapeHtml(m.created_at)}</td><td>${escapeHtml(m.phone || '未绑定')}</td><td>${escapeHtml(m.product_name)}</td><td>${m.type === 'deposit' ? '存入' : '取出'}</td><td>${m.quantity}</td><td>${escapeHtml(m.operator)}</td><td>${escapeHtml(m.note)}</td></tr>`).join(''))}${adminPagination('storageMovements', data.movementsPagination)}</section>`;
  if (section === 'group-buy') return `<div class="toolbar"><button class="primary-small" data-action="verify-group">录入核销</button><span>当前保存内部核销记录；抖音/美团查券接口需配置商户授权</span></div>${adminTable(['平台','券码','套餐','金额','核销时间','操作员'], data.records.map(r => `<tr><td>${r.platform}</td><td>${r.voucher_no}</td><td>${r.package_name}</td><td>${adminMoney(r.amount_cents / 100)}</td><td>${r.verified_at}</td><td>${r.verified_by || '-'}</td></tr>`).join(''))}${adminPagination('groupBuy', data.pagination)}`;
  if (section === 'wallet') return `<section class="kpi-grid">${[['未使用储值金额',data.outstanding.stored],['未使用赠金',data.outstanding.bonus]].map(([label,value]) => `<article class="kpi-card"><span>${label}</span><strong>${adminMoney(value)}</strong></article>`).join('')}</section><div class="toolbar"><button class="primary-small" data-action="new-wallet">新增储值套餐</button><span>储值与赠金分账；赠金不计入订单收入</span></div>${adminTable(['套餐','支付金额','储值金额','赠金','状态'], data.packages.map(p => `<tr><td>${p.name}</td><td>${adminMoney(p.pay)}</td><td>${adminMoney(p.stored)}</td><td class="green-text">${adminMoney(p.bonus)}</td><td>${p.status}</td></tr>`).join(''))}${adminPagination('wallet', data.pagination)}`;
  if (section === 'rewards') return `<div class="toolbar"><button class="primary-small" data-action="new-reward">新增奖品</button></div>${adminTable(['奖品','来源','所需积分','可兑数量','状态','操作'], data.rewards.map(r => `<tr><td><div class="product-cell">${r.imageUrl ? `<img src="${escapeHtml(r.imageUrl)}" alt="">` : ''}<strong>${escapeHtml(r.name)}</strong></div></td><td>${r.product_id ? '现有商品' : '自定义奖品'}</td><td>${r.points}</td><td>${r.stock}</td><td>${r.status === 'active' ? '上架' : '下架'}</td><td><button class="table-action" data-edit-reward="${r.id}">编辑</button></td></tr>`).join(''))}${adminPagination('rewards', data.pagination)}<section class="storage-history"><h2>兑换记录</h2>${adminTable(['时间','手机号','会员','奖品','积分','状态','操作'], data.redemptions.map(r => `<tr><td>${escapeHtml(r.created_at)}</td><td>${escapeHtml(r.phone || '未绑定')}</td><td>${escapeHtml(r.nickname)}</td><td>${escapeHtml(r.reward_name)}</td><td>${r.points}</td><td>${r.status === 'fulfilled' ? '已领取' : '待领取'}</td><td>${r.status === 'pending' ? `<button class="table-action" data-fulfill="${r.id}">确认发放</button>` : '-'}</td></tr>`).join(''))}${adminPagination('redemptions', data.redemptionsPagination)}</section>`;
  if (section === 'coupons') return `<div class="toolbar"><button class="primary-small" data-action="new-coupon">新增优惠券</button><span>先计算会员价，再计算优惠券；优惠券不可使用赠金。商品兑换券会扣库存并按进货价计入成本。</span></div>${adminTable(['优惠券','类型 / 优惠','门槛','发放数','每人限领','有效期','状态','操作'], data.coupons.map(c => `<tr><td><strong>${escapeHtml(c.name)}</strong><small>${c.isProductVoucher ? `赠送：${escapeHtml(c.giftProductName || '指定商品')}` : escapeHtml(c.description || '')}</small></td><td>${c.isProductVoucher ? '<span class="green-text">商品兑换券 · 1 件</span>' : c.type === 'fixed' ? adminMoney(c.amount) : `${(Number(c.discountRate) * 10).toFixed(1)} 折`}</td><td>${c.isProductVoucher ? '-' : adminMoney(c.minOrder)}</td><td>${c.issuedQuantity} / ${c.totalQuantity || '不限'}</td><td>${c.perUserLimit}</td><td>${c.validDays ? `领取后 ${c.validDays} 天` : escapeHtml(c.validUntil || '长期有效')}</td><td>${c.status === 'active' ? '启用' : '停用'}</td><td><button class="table-action" data-edit-coupon="${c.id}">编辑</button> <button class="table-action" data-issue-coupon="${c.id}" ${c.status !== 'active' ? 'disabled' : ''}>发放</button> <button class="table-action" data-coupon-status="${c.id}" data-status="${c.status === 'active' ? 'inactive' : 'active'}">${c.status === 'active' ? '停用' : '启用'}</button></td></tr>`).join(''))}${adminPagination('coupons', data.pagination)}<section class="panel"><h2>最近发放记录</h2>${adminTable(['会员','手机号','优惠券','状态','发放时间','有效期'], (data.issued || []).map(r => `<tr><td>${escapeHtml(r.nickname)}</td><td>${escapeHtml(r.phone || '未绑定')}</td><td>${escapeHtml(r.coupon_name)}</td><td>${escapeHtml(({ available:'可使用', locked:'订单占用', used:'已使用', expired:'已过期', cancelled:'已作废' })[r.status] || r.status)}</td><td>${escapeHtml(r.issued_at)}</td><td>${escapeHtml(r.expired_at || '长期')}</td></tr>`).join(''))}</section>`;
  if (section === 'messages') return `<div class="toolbar"><button class="primary-small" data-action="send-message">发送消息</button><span>站内消息始终发送；微信订阅消息需要用户一次性授权。微信失败不影响站内消息。</span></div><section class="panel"><h2>消息模板</h2>${adminTable(['模板','标识','微信模板 ID','字段映射','状态','操作'], data.templates.map(t => `<tr><td><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(t.title_template)}</small></td><td><code>${escapeHtml(t.template_key)}</code></td><td>${escapeHtml(t.wechat_template_id || '未配置')}</td><td><code>${escapeHtml(t.field_mapping || '{}')}</code></td><td>${t.enabled ? '启用' : '停用'}</td><td><button class="table-action" data-edit-message-template="${t.id}">编辑</button></td></tr>`).join(''))}</section><section class="panel"><h2>发送记录</h2>${adminTable(['时间','名称','模板','范围','接收人数','状态'], data.campaigns.map(c => `<tr><td>${escapeHtml(c.created_at)}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.template_name || '优惠券发放')}</td><td>${c.audience_type === 'all' ? '全部会员' : '指定会员'}</td><td>${c.recipient_count}</td><td>${escapeHtml(c.status)}</td></tr>`).join(''))}${adminPagination('messages', data.pagination)}</section>`;
  if (section === 'mini-page') return `<section class="panel mini-page-panel"><h2>小程序首页</h2><p>修改后顾客下次打开即生效。微信搜索展示的正式名称仍需在微信公众平台修改。</p><form id="mini-page-form"><div class="mini-page-fields">${data.entries.filter(entry => entry.type === 'text').map(entry => `<label class="admin-field"><span>${miniEntryLabels[entry.key]}</span><input name="title-${entry.key}" maxlength="30" value="${escapeHtml(entry.title)}" required></label>`).join('')}</div><h2>会员中心入口</h2><div class="mini-page-fields">${data.entries.filter(entry => entry.type !== 'text').map(entry => `<div class="mini-entry-field"><strong>${miniEntryLabels[entry.key]}</strong><label class="admin-field"><span>显示名称</span><input name="title-${entry.key}" maxlength="8" value="${escapeHtml(entry.title)}" required></label><label class="admin-field"><span>图标</span><select name="icon-${entry.key}">${data.icons.map(icon => `<option value="${icon}" ${icon === entry.icon ? 'selected' : ''}>${miniIconLabels[icon]}</option>`).join('')}</select></label></div>`).join('')}</div><button class="primary-small">保存页面设置</button><p class="dialog-error"></p></form></section>`;
  if (section === 'reports') {
    const daily = data.daily || [];
    const activePreset = ['today','7d','30d','month'].find(preset => { const range = reportPresetRange(preset); return range.start === data.dateRange.start && range.end === data.dateRange.end; });
    return `<section class="panel report-toolbar"><form id="report-range"><div class="report-presets" role="group" aria-label="快捷日期范围">${[['today','当天'],['7d','近7天'],['30d','近30天'],['month','本月']].map(([value,label]) => `<button type="button" class="date-preset ${activePreset === value ? 'active' : ''}" data-report-preset="${value}">${label}</button>`).join('')}</div><label>开始日期<input type="date" name="start" value="${escapeHtml(data.dateRange.start)}"></label><label>结束日期<input type="date" name="end" value="${escapeHtml(data.dateRange.end)}"></label><button class="primary-small">查询</button><button type="button" class="outline-button" data-export-report>导出表格</button></form></section><section class="kpi-grid">${[['订单净销售额',data.today?.revenue],['净利润',data.today?.profit],['充值收款',data.today?.recharge],['线下收款',data.today?.offline],['订单商品成本',data.today?.orderCost],['赠酒报损成本',data.today?.lossCost]].map(([label,value]) => `<article class="kpi-card"><span>${label}</span><strong>${adminMoney(value)}</strong><small class="green">${data.today?.day || ''}</small></article>`).join('')}</section><section class="panel report-chart"><div class="panel-heading"><h2>净销售额与利润趋势</h2><div class="trend-legend"><span><i class="legend-revenue"></i>订单净销售额（柱）</span><span><i class="legend-profit"></i>净利润（线）</span></div></div>${daily.length ? reportTrendChart(daily) : '<p class="empty-cell">所选日期暂无数据</p>'}</section><section class="panel"><div class="panel-heading"><div><h2>每日经营明细</h2><span>${data.dateRange.start} 至 ${data.dateRange.end}</span></div></div>${adminTable(['日期','订单数','净销售额','净利润','充值收款','线下收款','商品成本','赠酒报损成本'], (data.dailyRows || []).map(r => `<tr><td>${r.day}</td><td>${r.orders}</td><td>${adminMoney(r.revenue)}</td><td class="green-text">${adminMoney(r.profit)}</td><td>${adminMoney(r.recharge)}</td><td>${adminMoney(r.offline)}</td><td>${adminMoney(r.orderCost)}</td><td>${adminMoney(r.lossCost)}</td></tr>`).join(''))}${adminPagination('reportDaily', data.dailyPagination)}</section>`;
  }
  if (section === 'losses') return `<div class="toolbar"><button class="primary-small" data-action="new-loss">上报赠酒 / 报损</button></div>${adminTable(['时间','类型','商品','数量','成本','原因','操作人'], data.records.map(r => `<tr><td>${r.created_at}</td><td>${r.type === 'gift' ? '赠酒' : '报损'}</td><td>${escapeHtml(r.product_name)}</td><td>${r.quantity}</td><td>${adminState.account.role === 'super' ? adminMoney(r.cost) : '-'}</td><td>${escapeHtml(r.reason)}</td><td>${escapeHtml(r.operator)}</td></tr>`).join(''))}${adminPagination('losses', data.pagination)}`;
  if (section === 'accounts') return `<div class="toolbar"><button class="primary-small" data-action="new-account">新增账号</button><span>管理员和店员可单独重置密码；重置后其已登录设备需要重新登录。</span></div>${adminTable(['账号','名称','角色','状态','授权模块','操作'], data.accounts.map(a => `<tr><td>${escapeHtml(a.username)}</td><td>${escapeHtml(a.displayName)}</td><td>${{super:'超级管理员',manager:'管理员',staff:'店员'}[a.role]}</td><td>${a.status === 'active' ? '启用' : '停用'}</td><td>${a.role === 'super' ? '全部' : a.permissions.map(p => adminTitles[p]).join('、')}</td><td>${a.role === 'super' ? '-' : `<button class="table-action" data-edit-account="${a.id}">编辑权限</button> <button class="table-action" data-reset-account="${a.id}">重置密码</button>`}</td></tr>`).join(''))}${adminPagination('accounts', data.pagination)}`;
  if (section === 'logs') return `${adminTable(['时间','账号','操作','详情'], data.logs.map(l => `<tr><td>${l.created_at}</td><td>${escapeHtml(l.operator)}</td><td>${escapeHtml(l.action)}</td><td>${escapeHtml(l.detail)}</td></tr>`).join(''))}${adminPagination('logs', data.pagination)}`;
  if (section === 'settings') return `<section class="panel"><div class="panel-heading"><div><h2>第三方接口配置</h2><span>保存后会被服务端运行时读取；密钥建议通过服务器环境变量注入</span></div><button class="outline-button" id="check-integrations">检查配置</button></div><div class="integration-status">${Object.entries(data.groups || {}).map(([key, value]) => `<span class="status-chip ${value.configured ? 'ready' : 'warning'}">${key}: ${value.configured ? '配置完整' : `缺少 ${value.missing.length} 项`}</span>`).join('')}</div><form id="settings-form" class="settings-grid">${data.settings.map(s => `<label class="admin-field"><span>${escapeHtml(s.label || configLabels[s.key] || s.key)} ${s.configured ? `· 已配置（${s.source === 'environment' ? '环境变量' : '后台'}）` : ''}</span>${s.key === 'wechat_miniprogram_env_version' ? `<select name="${s.key}"><option value="release" ${s.value === 'release' || !s.value ? 'selected' : ''}>release · 正式版</option><option value="trial" ${s.value === 'trial' ? 'selected' : ''}>trial · 体验版</option><option value="develop" ${s.value === 'develop' ? 'selected' : ''}>develop · 开发版</option></select>` : `<input name="${s.key}" type="${s.secret ? 'password' : 'text'}" value="${escapeHtml(s.value)}" placeholder="${s.secret && s.configured ? '留空保持原值' : ''}">`}</label>`).join('')}<button class="primary-small">保存配置</button><p class="dialog-error"></p></form><p class="muted">完整性检查通过后，还需在微信、美团、抖音后台完成商户授权，并用真实回调地址做支付和核销联调。</p></section>`;
  if (section === 'backups') {
    const settings = data.settings || {};
    const size = bytes => { const value = Number(bytes || 0); return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; };
    const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
    return `<section class="backup-intro"><div><span class="eyebrow">DATA SAFETY</span><h2>备份你的营业数据</h2><p>备份包含营业数据库、商品图片和会员头像；接口密钥与登录会话会自动排除。更换服务器时，安装新版本后上传备份即可恢复。</p></div><button class="primary-small" data-action="create-backup">立即备份</button></section>
      <section class="panel backup-settings-panel"><div class="panel-heading"><div><h2>自动备份计划</h2><span>由 API 服务进程执行，宝塔 Node 项目需要保持运行</span></div><span class="backup-last-run">最近执行：${escapeHtml(date(settings.lastRunAt))}</span></div><form id="backup-settings-form" class="backup-settings-form"><label class="backup-toggle"><input type="checkbox" name="enabled" value="1" ${settings.enabled ? 'checked' : ''}><span>开启自动备份</span></label><label class="admin-field"><span>备份频率</span><select name="frequency"><option value="daily" ${settings.frequency === 'daily' ? 'selected' : ''}>每天</option><option value="weekly" ${settings.frequency === 'weekly' ? 'selected' : ''}>每周一</option></select></label><label class="admin-field"><span>执行时间</span><input type="time" name="runTime" value="${escapeHtml(settings.runTime || '04:00')}" required></label><label class="admin-field"><span>保留天数</span><input type="number" name="retentionDays" value="${Number(settings.retentionDays || 30)}" min="1" max="3650" required></label><button class="outline-button">保存计划</button><p class="dialog-error"></p></form></section>
      <section class="panel"><div class="panel-heading"><div><h2>备份历史</h2><span>旧备份会按保留天数自动清理</span></div></div>${adminTable(['文件名','大小','生成时间','操作'], (data.backups || []).map(item => `<tr><td><code>${escapeHtml(item.name)}</code></td><td>${size(item.size)}</td><td>${escapeHtml(date(item.createdAt))}</td><td><button class="table-action" data-download-backup="${escapeHtml(item.name)}">下载</button></td></tr>`).join(''))}</section>
      <section class="panel backup-restore-panel"><div class="panel-heading"><div><h2>从备份恢复</h2><span>适用于更换服务器或回滚数据</span></div></div><p class="backup-warning">恢复会覆盖当前数据库和本地上传文件。系统会先自动保存当前数据，恢复完成后当前登录会话将失效，请重新登录。</p><form id="backup-restore-form" class="backup-restore-form"><label class="backup-file-picker"><span>选择备份文件</span><input type="file" name="backup" accept=".tar.gz,application/gzip,application/x-gzip" required><small>仅支持系统生成的 .tar.gz 文件，最大 1GB</small></label><button class="danger-button">上传并恢复</button><p class="dialog-error"></p></form></section>`;
  }
  return '<div class="panel">该模块已就绪，等待配置数据。</div>';
}
function bindAdminActions() {
  if (adminState.section === 'pos' && adminState.data?.tables) bindPosActions();
  document.querySelectorAll('[data-page-prev]').forEach(button => button.onclick = () => {
    const key = button.dataset.pagePrev;
    adminState.pages[key] = Math.max(1, (adminState.pages[key] || 1) - 1);
    renderAdmin();
  });
  document.querySelectorAll('[data-page-next]').forEach(button => button.onclick = () => {
    const key = button.dataset.pageNext;
    adminState.pages[key] = (adminState.pages[key] || 1) + 1;
    renderAdmin();
  });
  document.querySelectorAll('[data-page-jump]').forEach(button => button.onclick = () => {
    adminState.pages[button.dataset.pageJump] = Number(button.dataset.page);
    renderAdmin();
  });
  document.querySelectorAll('[data-page-size]').forEach(select => select.onchange = () => {
    const key = select.dataset.pageSize;
    adminState.pageSizes[key] = Number(select.value) === 50 ? 50 : 20;
    adminState.pages[key] = 1;
    renderAdmin();
  });
  const action = (selector, handler) => document.querySelectorAll(selector).forEach(button => button.onclick = async () => { button.disabled = true; try { await handler(button); await renderAdmin(); } catch (error) { adminNotice(error.message); button.disabled = false; } });
  action('[data-product-status]', button => adminApi(`/products/${button.dataset.productStatus}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) }));
  action('[data-coupon-status]', button => adminApi(`/coupons/${button.dataset.couponStatus}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) }));
  action('[data-mark-paid]', button => adminApi(`/orders/${button.dataset.markPaid}/mark-paid`, { method: 'POST', body: '{}' }));
  action('[data-deliver]', button => adminApi(`/orders/${button.dataset.deliver}/deliver`, { method: 'POST', body: '{}' }));
  document.querySelectorAll('[data-review-refund]').forEach(button => button.onclick = () => {
    const requestId = Number(button.dataset.reviewRefund);
    const order = adminState.data.orders.find(item => Number(item.refundRequest?.id) === requestId);
    if (order) openAdminDialog('review-refund', order);
  });
  document.querySelectorAll('[data-admin-refund]').forEach(button => button.onclick = () => {
    const order = adminState.data.orders.find(item => Number(item.id) === Number(button.dataset.adminRefund));
    if (order) openAdminDialog('admin-refund', order);
  });
  document.querySelectorAll('[data-query-refund]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    try {
      const result = await adminApi(`/refunds/${button.dataset.queryRefund}/query`, { method: 'POST', body: '{}' });
      await renderAdmin();
      const status = String(result.status || '').toLowerCase();
      adminNotice(['success', 'succeeded'].includes(status) ? '退款已成功到账' : `微信退款状态：${refundStatusLabel(status) || result.status || '处理中'}`);
    } catch (error) { adminNotice(error.message); button.disabled = false; }
  });
  action('[data-close-table]', button => adminApi(`/tables/${button.dataset.closeTable}/close`, { method: 'POST', body: '{}' }));
  document.querySelectorAll('[data-edit-table]').forEach(button => button.onclick = () => openAdminDialog('edit-table', adminState.data.tables.find(table => table.id === Number(button.dataset.editTable))));
  document.querySelectorAll('[data-delete-table]').forEach(button => button.onclick = async () => {
    if (!window.confirm('确定删除这个桌台吗？删除后将不再显示。')) return;
    button.disabled = true;
    try { await adminApi(`/tables/${button.dataset.deleteTable}`, { method: 'DELETE' }); await renderAdmin(); adminNotice('桌台已删除'); }
    catch (error) { adminNotice(error.message); button.disabled = false; }
  });
  document.querySelectorAll('[data-table-code]').forEach(button => button.onclick = () => openTableCode(adminState.data.tables.find(table => table.id === Number(button.dataset.tableCode))));
  action('[data-fulfill]', button => adminApi(`/rewards/redemptions/${button.dataset.fulfill}/fulfill`, { method: 'POST', body: '{}' }));
  document.querySelectorAll('[data-admin-section]').forEach(button => button.onclick = () => { adminState.section = button.dataset.adminSection; renderAdmin(); });
  document.querySelectorAll('[data-action="new-product"],[data-action="new-table"],[data-action="new-storage"],[data-action="verify-group"],[data-action="new-wallet"]').forEach(button => button.onclick = () => openAdminDialog(button.dataset.action));
  document.querySelectorAll('[data-withdraw]').forEach(button => button.onclick = () => openAdminDialog('withdraw', adminState.data.records.find(r => r.id === Number(button.dataset.withdraw))));
  document.querySelectorAll('[data-adjust-stock]').forEach(button => button.onclick = () => openAdminDialog('stock', adminState.data.products.find(p => p.id === Number(button.dataset.adjustStock))));
  document.querySelectorAll('[data-edit-product]').forEach(button => button.onclick = () => openAdminDialog('edit-product', adminState.data.products.find(p => p.id === Number(button.dataset.editProduct))));
  document.querySelectorAll('[data-edit-account]').forEach(button => button.onclick = () => openAdminDialog('edit-account', adminState.data.accounts.find(a => a.id === Number(button.dataset.editAccount))));
  document.querySelectorAll('[data-reset-account]').forEach(button => button.onclick = () => openAdminDialog('reset-account', adminState.data.accounts.find(a => a.id === Number(button.dataset.resetAccount))));
  document.querySelectorAll('[data-edit-member]').forEach(button => button.onclick = () => openAdminDialog('edit-member', adminState.data.members.find(m => m.id === Number(button.dataset.editMember))));
  document.querySelectorAll('[data-member-coupon]').forEach(button => button.onclick = () => openAdminDialog('issue-coupon', { userId: Number(button.dataset.memberCoupon) }));
  document.querySelectorAll('[data-member-message]').forEach(button => button.onclick = () => openAdminDialog('send-message', { userId: Number(button.dataset.memberMessage) }));
  document.querySelectorAll('[data-delete-member]').forEach(button => button.onclick = async () => {
    if (!window.confirm('确定删除这个会员吗？有订单、余额、积分或存酒记录的会员不能删除。')) return;
    button.disabled = true;
    try { await adminApi(`/members/${button.dataset.deleteMember}`, { method: 'DELETE' }); await renderAdmin(); adminNotice('会员已删除'); }
    catch (error) { adminNotice(error.message); button.disabled = false; }
  });
  document.querySelectorAll('[data-edit-tier]').forEach(button => button.onclick = () => openAdminDialog('edit-tier', adminState.data.tiers.find(t => t.id === Number(button.dataset.editTier))));
  document.querySelectorAll('[data-edit-reward]').forEach(button => button.onclick = () => openAdminDialog('edit-reward', adminState.data.rewards.find(r => r.id === Number(button.dataset.editReward))));
  document.querySelectorAll('[data-edit-coupon]').forEach(button => button.onclick = () => openAdminDialog('edit-coupon', adminState.data.coupons.find(c => c.id === Number(button.dataset.editCoupon))));
  document.querySelectorAll('[data-issue-coupon]').forEach(button => button.onclick = () => openAdminDialog('issue-coupon', { couponId: Number(button.dataset.issueCoupon) }));
  document.querySelectorAll('[data-edit-message-template]').forEach(button => button.onclick = () => openAdminDialog('edit-message-template', adminState.data.templates.find(t => t.id === Number(button.dataset.editMessageTemplate))));
  document.querySelectorAll('[data-action="new-account"],[data-action="new-loss"],[data-action="password"],[data-action="new-member"],[data-action="new-tier"],[data-action="new-reward"],[data-action="new-coupon"],[data-action="send-message"]').forEach(button => button.onclick = () => openAdminDialog(button.dataset.action));
  document.querySelector('#member-search')?.addEventListener('submit', event => { event.preventDefault(); adminState.memberPhone = new FormData(event.currentTarget).get('phone').trim(); adminState.pages.members = 1; renderAdmin(); });
  document.querySelector('#storage-search')?.addEventListener('submit', event => { event.preventDefault(); adminState.storagePhone = new FormData(event.currentTarget).get('phone').trim(); adminState.pages.storage = 1; adminState.pages.storageMovements = 1; renderAdmin(); });
  document.querySelector('#report-range')?.addEventListener('submit', event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); adminState.reportRange = { start: values.start, end: values.end }; adminState.pages.reportDaily = 1; renderAdmin(); });
  document.querySelectorAll('[data-report-preset]').forEach(button => button.onclick = () => { adminState.reportRange = reportPresetRange(button.dataset.reportPreset); adminState.pages.reportDaily = 1; renderAdmin(); });
  document.querySelector('[data-export-report]')?.addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; try { const query = new URLSearchParams(adminState.reportRange).toString(); const response = await fetch(`/api/admin/reports/export?${query}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminToken')}` } }); if (!response.ok) throw new Error('报表导出失败'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `经营报表-${adminState.reportRange.start || '开始'}-${adminState.reportRange.end || '结束'}.csv`; link.click(); URL.revokeObjectURL(url); } catch (error) { adminNotice(error.message); } finally { button.disabled = false; } });
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => { try { await adminApi('/logout', { method:'POST' }); } finally { sessionStorage.removeItem('adminToken'); adminState.account = null; renderAdminLogin(); } });
  document.querySelector('#settings-form')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true; try { await adminApi('/settings', { method:'PUT', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); await renderAdmin(); adminNotice('配置已保存，请继续完成平台授权和联调'); } catch (error) { form.querySelector('.dialog-error').textContent = error.message; button.disabled = false; } });
  document.querySelector('#check-integrations')?.addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; try { const result = await adminApi('/settings/check', { method:'POST' }); adminNotice(result.message); } catch (error) { adminNotice(error.message); } finally { button.disabled = false; } });
  document.querySelector('#mini-page-form')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); const entries = adminState.data.entries.map(({ key }) => ({ key, title: values[`title-${key}`], icon: values[`icon-${key}`] })); const button = form.querySelector('button'); button.disabled = true; try { await adminApi('/mini-page', { method:'PUT', body:JSON.stringify({ entries }) }); await renderAdmin(); adminNotice('页面设置已保存'); } catch (error) { form.querySelector('.dialog-error').textContent = error.message; button.disabled = false; } });
  document.querySelector('[data-action="create-backup"]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { const result = await adminApi('/backups', { method: 'POST', body: '{}' }); await renderAdmin(); adminNotice(`备份完成：${result.backup.name}`); }
    catch (error) { adminNotice(error.message); button.disabled = false; }
  });
  document.querySelectorAll('[data-download-backup]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    try {
      const response = await fetch(`/api/admin/backups/${encodeURIComponent(button.dataset.downloadBackup)}/download`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminToken')}` } });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.message || '备份下载失败'); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = button.dataset.downloadBackup; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { adminNotice(error.message); }
    finally { button.disabled = false; }
  });
  document.querySelector('#backup-settings-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    values.enabled = form.elements.enabled.checked ? 1 : 0;
    const button = form.querySelector('button'); button.disabled = true;
    try { await adminApi('/backups/settings', { method: 'PATCH', body: JSON.stringify(values) }); await renderAdmin(); adminNotice('自动备份计划已保存'); }
    catch (error) { form.querySelector('.dialog-error').textContent = error.message; button.disabled = false; }
  });
  document.querySelector('#backup-restore-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.backup.files[0];
    if (!file) return;
    if (!window.confirm('恢复会覆盖当前数据库和上传文件，系统会先保留当前安全备份。确定继续吗？')) return;
    const button = form.querySelector('button'); button.disabled = true; form.querySelector('.dialog-error').textContent = '正在上传并校验备份，请不要关闭页面...';
    try {
      const formData = new FormData(); formData.append('backup', file);
      const response = await fetch('/api/admin/backups/restore', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('adminToken')}` }, body: formData });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '备份恢复失败');
      form.querySelector('.dialog-error').textContent = `恢复成功，安全备份为 ${result.safetyBackup}。页面即将重新登录。`;
      setTimeout(() => { sessionStorage.removeItem('adminToken'); location.reload(); }, 1400);
    } catch (error) { form.querySelector('.dialog-error').textContent = error.message; button.disabled = false; }
  });
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
    download.download = `桌台-${table.id}.${response.headers.get('content-type') === 'image/jpeg' ? 'jpg' : 'png'}`;
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
  let title, fields, path, method = 'POST', messageData = null;
  try {
    if (type === 'review-refund') {
      const request = item?.refundRequest;
      title = `审核退款 · ${item.order_no}`;
      const refundItems = Array.isArray(request?.items) ? request.items : [];
      const itemSummary = refundItems.length
        ? `<div class="refund-item-summary"><strong>申请商品</strong>${refundItems.map(refundItem => `<span>${escapeHtml(refundItem.name || '商品')} × ${Number(refundItem.quantity || 0)}</span>`).join('')}</div>`
        : '<p>历史申请未记录商品明细，本次按金额审核。</p>';
      fields = `<div class="refund-review-summary"><strong>订单 ${escapeHtml(item.order_no)}</strong>${itemSummary}<span>申请退款 ${adminMoney(request?.amount)}</span><span>当前可退款 ${adminMoney(item.refundableAmount)}</span><p>${request?.reason ? `用户原因：${escapeHtml(request.reason)}` : '用户未填写退款原因'}</p></div>`
        + field('拒绝原因（点击拒绝时必填）', 'rejectReason', '<textarea name="rejectReason" rows="4" maxlength="200" placeholder="请填写拒绝退款的具体原因"></textarea>');
    } else if (type === 'admin-refund') {
      title = `订单退款 · ${item.order_no}`;
      path = `/orders/${item.id}/refund`;
      fields = `<div class="refund-review-summary"><strong>订单 ${escapeHtml(item.order_no)}</strong><span>原订单实付 ${adminMoney(item.payableAmount)}</span><span>当前可退款 ${adminMoney(item.refundableAmount)}</span><p>退款会按赠金、储值余额、微信支付的原支付渠道顺序退回；微信部分可能需要稍后查询状态。</p></div>`
        + field('退款金额（元）', 'amount', `<input name="amount" type="number" value="${escapeHtml(item.refundableAmount)}" min="0.01" max="${escapeHtml(item.refundableAmount)}" step="0.01" required>`)
        + field('退款原因', 'reason', '<textarea name="reason" rows="3" maxlength="200" placeholder="例如：商品缺货、服务异常"></textarea>');
    } else if (type === 'new-storage') {
      const productsData = await adminApi('/products?all=1');
      title = '登记存酒'; path = '/storage';
      fields = field('会员手机号', 'phone', `<input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[3-9][0-9]{9}" value="${escapeHtml(adminState.storagePhone)}" required>`) + `<p class="dialog-hint" id="storage-member-match">输入已绑定手机号，确认会员后登记</p>` + field('现有商品', 'productId', `<select name="productId" required>${productsData.products.filter(p => p.status === 'active').map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>`) + field('存入数量', 'quantity', number('quantity', 1, 1)) + field('存放天数', 'days', number('days', 30, 1)) + field('备注', 'note', '<input name="note" placeholder="可选">');
    } else if (type === 'withdraw') {
      title = `取酒 · ${item.product_name}`; path = `/storage/${item.id}/withdraw`;
      fields = `<p class="dialog-hint">${escapeHtml(item.phone || '未绑定手机号')} · ${escapeHtml(item.nickname)} · 当前剩余 ${item.quantity} 件 · 到期 ${item.expires_at.slice(0, 10)}</p>` + field('取出数量', 'quantity', number('quantity', 1, 1)) + field('备注', 'note', '<input name="note" placeholder="可选">');
    } else if (type === 'new-member' || type === 'edit-member') {
      title = item ? `管理会员 · ${item.phone || item.nickname}` : '新增会员'; path = item ? `/members/${item.id}` : '/members'; method = item ? 'PATCH' : 'POST';
      const tierOptions = `<option value="">普通会员</option>${adminState.data.tiers.filter(t => t.status === 'active').map(t => `<option value="${t.id}" ${item?.memberTierId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}`;
      fields = field('手机号', 'phone', `<input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[3-9][0-9]{9}" value="${escapeHtml(item?.phone)}" required>`) + field('姓名 / 昵称', 'nickname', `<input name="nickname" maxlength="50" value="${escapeHtml(item?.nickname)}" required>`) + (item ? `<p class="dialog-hint">微信账号：${item.wechatBound ? '已绑定' : '未绑定'} · ID ${item.id}</p>` + field('会员等级', 'memberTierId', `<select name="memberTierId">${tierOptions}</select>`) + field('有效期', 'memberExpiresAt', `<input name="memberExpiresAt" type="date" value="${escapeHtml(item.memberExpiresAt?.slice(0,10))}">`) + field('生日类型', 'birthdayType', `<select name="birthdayType"><option value="" ${!item.birthdayType ? 'selected' : ''}>不设置</option><option value="solar" ${item.birthdayType === 'solar' ? 'selected' : ''}>阳历</option><option value="lunar" ${item.birthdayType === 'lunar' ? 'selected' : ''}>农历</option></select>`) + field('生日月日', 'birthdayDate', `<input name="birthdayDate" type="text" maxlength="5" pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" placeholder="例如 08-18" value="${escapeHtml(item.birthdayDate || '')}">`) + field('积分余额', 'points', number('points', item.points, 0)) + field('储值余额（元）', 'stored', number('stored', item.stored, 0, '.01')) + field('赠金余额（元）', 'bonus', number('bonus', item.bonus, 0, '.01')) + field('后台备注', 'adminNote', `<textarea name="adminNote" maxlength="500" rows="3">${escapeHtml(item.adminNote || '')}</textarea>`) + field('调整原因', 'reason', '<input name="reason" placeholder="余额或积分调整时必填">') : '');
    } else if (type === 'new-tier' || type === 'edit-tier') {
      title = item ? `编辑等级 · ${item.name}` : '新增会员等级'; path = item ? `/member-tiers/${item.id}` : '/member-tiers'; method = item ? 'PATCH' : 'POST';
      const storedValue = item ? (Number(item.stored_threshold_cents || (item.upgrade_type === 'recharge' ? item.threshold_cents : 0)) / 100) : '';
      const spendValue = item ? (Number(item.spend_threshold_cents || (['spend', 'monthly'].includes(item.upgrade_type) ? item.threshold_cents : 0)) / 100) : '';
      fields = field('等级名称', 'name', `<input name="name" maxlength="30" value="${escapeHtml(item?.name)}" required>`)
        + field('等级排序（数字越小越靠前）', 'sort', number('sort', item?.sort ?? 0, 0))
        + field('储值余额升级条件（元，不含赠金）', 'storedThreshold', number('storedThreshold', storedValue, 0, '.01'))
        + field('累计消费升级条件（元）', 'spendThreshold', number('spendThreshold', spendValue, 0, '.01'))
        + field('条件关系', 'conditionMode', `<select name="conditionMode"><option value="any" ${item?.condition_mode !== 'all' ? 'selected' : ''}>满足任一条件</option><option value="all" ${item?.condition_mode === 'all' ? 'selected' : ''}>同时满足两个条件</option></select>`)
        + field('等级标签颜色', 'badgeColor', `<input name="badgeColor" type="color" value="${escapeHtml(item?.badge_color || '#C77F52')}">`)
        + field('折扣系数（0.9 = 九折）', 'discount', number('discount', item?.discount ?? 0.9, '.01', '.01'))
        + field('积分倍率', 'pointsRate', number('pointsRate', item?.points_rate ?? 1, 0, '.1'))
        + field('有效天数（0 为长期）', 'durationDays', number('durationDays', item?.duration_days ?? 0, 0))
        + field('状态', 'status', `<select name="status"><option value="active" ${item?.status !== 'inactive' ? 'selected' : ''}>启用</option><option value="inactive" ${item?.status === 'inactive' ? 'selected' : ''}>停用</option></select>`)
        + `<input type="hidden" name="upgradeType" value="spend"><input type="hidden" name="threshold" value="${spendValue || storedValue || 0}">`;
    } else if (type === 'new-reward' || type === 'edit-reward') {
      const productsData = await adminApi('/products?all=1');
      title = item ? `编辑奖品 · ${item.name}` : '新增积分奖品'; path = item ? `/rewards/${item.id}` : '/rewards'; method = item ? 'PATCH' : 'POST';
      fields = field('奖品来源', 'productId', `<select name="productId"><option value="">自定义奖品</option>${productsData.products.map(p => `<option value="${p.id}" ${item?.product_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>`) + field('自定义名称', 'name', `<input name="name" maxlength="50" value="${escapeHtml(item?.product_id ? '' : item?.name)}" placeholder="选择现有商品时可留空">`) + field('奖品图片', 'imageFile', `<input name="imageFile" type="file" accept="image/png,image/jpeg,image/webp">${item?.imageUrl ? `<img class="dialog-preview" src="${escapeHtml(item.imageUrl)}" alt="奖品图片">` : ''}`) + field('兑换积分', 'points', number('points', item?.points ?? 100, 1)) + field('可兑数量', 'stock', number('stock', item?.stock ?? 10, 0)) + field('状态', 'status', `<select name="status"><option value="active">上架</option><option value="inactive" ${item?.status === 'inactive' ? 'selected' : ''}>下架</option></select>`);
    } else if (type === 'new-coupon' || type === 'edit-coupon') {
      const [productData, memberData] = await Promise.all([adminApi('/products?all=1'), adminApi('/members?page=1&pageSize=20')]);
      title = item ? `编辑优惠券 · ${item.name}` : '新增优惠券'; path = item ? `/coupons/${item.id}` : '/coupons'; method = item ? 'PATCH' : 'POST';
      const voucherType = item?.voucherType || 'discount';
      fields = `<p class="dialog-hint">商品兑换券会赠送绑定商品 1 件，点击小程序“去使用”后自动加入购物车；商品仍会扣库存，赠送商品按进货价计入后台成本。</p>`
        + field('名称', 'name', `<input name="name" maxlength="50" value="${escapeHtml(item?.name)}" required>`)
        + field('券类型', 'voucherType', `<select name="voucherType" data-coupon-voucher-type><option value="discount" ${voucherType !== 'product' ? 'selected' : ''}>金额 / 折扣优惠券</option><option value="product" ${voucherType === 'product' ? 'selected' : ''}>商品兑换券</option></select>`)
        + field('优惠方式', 'type', `<select name="type" data-coupon-discount-field><option value="fixed" ${item?.type !== 'discount' ? 'selected' : ''}>固定金额</option><option value="discount" ${item?.type === 'discount' ? 'selected' : ''}>折扣</option></select>`)
        + field('固定抵扣（元）', 'amount', `<input data-coupon-discount-field name="amount" type="number" value="${escapeHtml(item?.amount ?? 10)}" min="0.01" step=".01" required>`)
        + field('折扣系数（0.9 = 九折）', 'discountRate', `<input data-coupon-discount-field name="discountRate" type="number" value="${escapeHtml(item?.discountRate ?? 0.9)}" min="0.01" max="0.99" step=".01" required>`)
        + field('最低订单金额（元）', 'minOrder', `<input data-coupon-discount-field name="minOrder" type="number" value="${escapeHtml(item?.minOrder ?? 0)}" min="0" step=".01" required>`)
        + field('赠送商品', 'giftProductId', `<select name="giftProductId" data-coupon-gift-product><option value="">请选择商品</option>${productData.products.filter(p => p.status !== 'inactive').map(p => `<option value="${p.id}" ${Number(item?.giftProductId) === Number(p.id) ? 'selected' : ''}>${escapeHtml(p.name)} · 可售 ${adminAvailableStock(p)} 件</option>`).join('')}</select>`)
        + field('总发行量（0 为不限）', 'totalQuantity', number('totalQuantity', item?.totalQuantity ?? 0, 0))
        + field('每人限领', 'perUserLimit', number('perUserLimit', item?.perUserLimit ?? 1, 1))
        + field('领取后有效天数（0 为按截止时间）', 'validDays', number('validDays', item?.validDays ?? 0, 0))
        + field('开始时间', 'validFrom', `<input name="validFrom" type="datetime-local" value="${escapeHtml(item?.validFrom?.slice(0, 16) || '')}">`)
        + field('截止时间', 'validUntil', `<input name="validUntil" type="datetime-local" value="${escapeHtml(item?.validUntil?.slice(0, 16) || '')}">`)
        + field('指定商品', 'productId', `<select name="productId" data-coupon-discount-field><option value="">全部商品</option>${productData.products.map(p => `<option value="${p.id}" ${item?.productId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>`)
        + field('指定分类', 'categoryId', `<select name="categoryId" data-coupon-discount-field><option value="">全部分类</option>${productData.categories.map(c => `<option value="${c.id}" ${item?.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>`)
        + field('指定等级', 'memberTierId', `<select name="memberTierId"><option value="">所有会员</option>${memberData.tiers.map(t => `<option value="${t.id}" ${item?.memberTierId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>`)
        + field('券图标 URL', 'iconUrl', `<input name="iconUrl" value="${escapeHtml(item?.iconUrl || '')}" placeholder="可选 HTTPS 图片地址">`)
        + field('使用说明', 'description', `<textarea name="description" rows="3">${escapeHtml(item?.description || '')}</textarea>`)
        + field('状态', 'status', `<select name="status"><option value="active" ${item?.status !== 'inactive' ? 'selected' : ''}>启用</option><option value="inactive" ${item?.status === 'inactive' ? 'selected' : ''}>停用</option></select>`);
    } else if (type === 'issue-coupon' || type === 'send-message') {
      const couponData = await adminApi('/coupons?page=1&pageSize=50');
      messageData = type === 'send-message' ? await adminApi('/messages/templates') : null;
      const recipient = item?.userId ? `<p class="dialog-hint">指定会员 ID ${item.userId}</p>` : '';
      title = type === 'issue-coupon' ? '发放优惠券' : '发送消息';
      path = type === 'issue-coupon' ? `/coupons/${item?.couponId || couponData.coupons[0]?.id}/issue` : '/messages/send';
      fields = recipient + (type === 'issue-coupon'
        ? field('优惠券', 'couponId', `<select name="couponId" required>${couponData.coupons.filter(c => c.status === 'active').map(c => `<option value="${c.id}" ${item?.couponId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}${c.isProductVoucher ? ` · 商品券：${escapeHtml(c.giftProductName || '指定商品')}` : ''}</option>`).join('')}</select>`)
        : field('消息模板', 'templateId', `<select name="templateId" required>${messageData.templates.filter(t => t.enabled).map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>`) + field('发送名称', 'name', '<input name="name" maxlength="50" placeholder="例如 周末会员活动" required>') + field('模板变量 JSON', 'values', `<textarea name="values" rows="5" required>${escapeHtml(messageTemplateValues(messageData.templates.find(t => t.enabled)))}</textarea>`))
        + field('发送范围', 'audience', `<select name="audience"><option value="selected" ${item?.userId ? 'selected' : ''}>指定会员</option><option value="all">全部会员</option></select>`)
        + (type === 'issue-coupon'
          ? `<div class="admin-field coupon-member-picker"><span>指定会员</span><div class="coupon-member-search"><input name="memberPhone" type="tel" inputmode="numeric" maxlength="11" placeholder="输入手机号搜索"><button type="button" class="outline-button" data-find-coupon-member>搜索</button></div><div id="coupon-member-results" class="coupon-member-results"><span class="dialog-hint">请输入手机号搜索后选择会员</span></div><input type="hidden" name="userIds" value="${item?.userId || ''}"></div>`
          : field('指定会员 ID（多个用逗号分隔）', 'userIds', `<input name="userIds" value="${item?.userId || ''}" placeholder="例如 12,15">`))
        + '<p class="dialog-hint">商品券会在会员点击“去使用”时自动加入绑定商品；全员发送请明确选择“全部会员”。微信消息只发送给已授权该模板的会员。</p>';
    } else if (type === 'edit-message-template') {
      title = `编辑消息模板 · ${item.name}`; path = `/messages/templates/${item.id}`; method = 'PATCH';
      fields = `<p class="dialog-hint">模板标识 ${escapeHtml(item.template_key)}。微信字段 key 必须与微信公众平台已审核模板一致；无映射只发送站内消息。</p><p class="dialog-hint">订单通知可用：<code>orderNo</code> 订单号、<code>tableNo</code> 桌号、<code>productList</code> 完整商品清单、<code>productSummary</code> 微信短商品摘要、<code>amount</code> 原价、<code>payableAmount</code> 实付金额、<code>discountAmount</code> 优惠金额。其他模板字段以模板变量 JSON 中显示的字段为准。</p>`
        + field('名称', 'name', `<input name="name" maxlength="50" value="${escapeHtml(item.name)}" required>`)
        + field('站内标题', 'titleTemplate', `<input name="titleTemplate" maxlength="100" value="${escapeHtml(item.title_template)}" required>`)
        + field('站内内容', 'contentTemplate', `<textarea name="contentTemplate" rows="4" maxlength="500" required>${escapeHtml(item.content_template)}</textarea>`)
        + field('微信订阅模板 ID', 'wechatTemplateId', `<input name="wechatTemplateId" value="${escapeHtml(item.wechat_template_id || '')}">`)
        + field('微信字段映射 JSON', 'fieldMapping', `<textarea name="fieldMapping" rows="4" required>${escapeHtml(item.field_mapping || '{}')}</textarea>`)
        + field('状态', 'enabled', `<select name="enabled"><option value="1" ${item.enabled ? 'selected' : ''}>启用</option><option value="0" ${!item.enabled ? 'selected' : ''}>停用</option></select>`);
    } else if (type === 'stock') {
      title = `调整库存 · ${item.name}`; path = `/inventory/${item.id}/adjust`;
      fields = `<p class="dialog-hint">实际库存 ${adminPhysicalStock(item)} 件 · 待支付预占 ${adminReservedStock(item)} 件 · 当前可售 ${adminAvailableStock(item)} 件。增加填正数，减少填负数。</p>` + field('变动数量', 'change', '<input name="change" type="number" step="1" required>') + field('调整原因', 'reason');
    } else if (type === 'new-product' || type === 'edit-product') {
      const categories = (await adminApi('/products?all=1')).categories;
      title = item ? `编辑商品 · ${item.name}` : '新增商品'; path = item ? `/products/${item.id}` : '/products'; method = item ? 'PATCH' : 'POST';
      const value = (v) => escapeHtml(v ?? '');
      fields = field('商品名称', 'name', `<input name="name" value="${value(item?.name)}" required>`) + field('分类', 'categoryId', `<select name="categoryId">${categories.map(c => `<option value="${c.id}" ${item?.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>`) + field('简介', 'detail', `<textarea name="detail" maxlength="500" rows="4" placeholder="填写商品口味、规格、适合人数等介绍">${value(item?.detail)}</textarea>`) + field('商品图片', 'imageFile', `<input name="imageFile" type="file" accept="image/png,image/jpeg,image/webp">${item?.image_url ? `<img class="dialog-preview" src="${value(item.image_url)}" alt="当前商品图片">` : ''}`) + field('原价（元）', 'price', number('price', item?.price ?? '', 0, '.01')) + field('会员价（元）', 'memberPrice', number('memberPrice', item?.memberPrice ?? '', 0, '.01')) + (adminState.account.role === 'super' ? field('进货价（元）', 'cost', number('cost', item ? item.cost_cents / 100 : 0, 0, '.01')) : '') + field('库存数量', 'stock', number('stock', item?.stock ?? 0, 0)) + field('标签', 'tag', `<input name="tag" value="${value(item?.tag)}">`) + field('色系', 'color', `<select name="color">${['amber','teal','red','yellow','purple','pink'].map(c => `<option ${item?.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`) + field('赠金支付', 'allowBonus', `<select name="allowBonus"><option value="0">不支持</option><option value="1" ${item?.allow_bonus ? 'selected' : ''}>支持</option></select>`) + field('销售状态', 'status', `<select name="status"><option value="active">在售</option><option value="inactive" ${item?.status === 'inactive' ? 'selected' : ''}>下架</option></select>`);
    } else if (type === 'new-loss') {
      const data = await adminApi('/products?all=1'); title = '上报赠酒 / 报损'; path = '/losses';
      fields = field('类型', 'type', '<select name="type"><option value="gift">赠酒</option><option value="damage">报损</option></select>') + field('商品', 'productId', `<select name="productId" required>${data.products.map(p => `<option value="${p.id}">${escapeHtml(p.name)} · 可售 ${adminAvailableStock(p)}（实际 ${adminPhysicalStock(p)}）</option>`).join('')}</select>`) + field('数量', 'quantity', number('quantity', 1, 1)) + field('原因', 'reason');
    } else if (type === 'reset-account') {
      title = `重置密码 · ${item.username}`; path = `/accounts/${item.id}/reset-password`;
      fields = `<p class="dialog-hint">账号：${escapeHtml(item.username)} · 当前已登录设备将在保存后退出，请将新密码安全告知账号使用人。</p>` + field('新密码（至少 10 位）', 'password', '<input name="password" type="password" minlength="10" autocomplete="new-password" required>') + field('确认新密码', 'confirmPassword', '<input name="confirmPassword" type="password" minlength="10" autocomplete="new-password" required>');
    } else if (type === 'new-account' || type === 'edit-account') {
      const data = await adminApi('/accounts'); title = item ? `编辑账号 · ${item.username}` : '新增账号'; path = item ? `/accounts/${item.id}` : '/accounts'; method = item ? 'PATCH' : 'POST';
      fields = (item ? `<p class="dialog-hint">账号：${escapeHtml(item.username)}</p>` : field('登录账号', 'username', '<input name="username" minlength="3" pattern="[a-zA-Z0-9_]+" required>')) + field('显示名称', 'displayName', `<input name="displayName" value="${escapeHtml(item?.displayName || '')}" required>`) + field(item ? '重设密码（留空不修改）' : '初始密码（至少 10 位）', 'password', `<input name="password" type="password" minlength="10" ${item ? '' : 'required'} autocomplete="new-password">`) + field('账号级别', 'role', `<select name="role"><option value="staff">店员</option><option value="manager" ${item?.role === 'manager' ? 'selected' : ''}>管理员</option></select>`) + (item ? field('状态', 'status', `<select name="status"><option value="active">启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select>`) : '') + `<fieldset class="permission-fields"><legend>授权模块</legend>${data.modules.filter(module => module !== 'reports').map(m => `<label><input type="checkbox" name="permissions" value="${m}" ${item?.permissions.includes(m) ? 'checked' : ''}>${adminTitles[m]}</label>`).join('')}<p class="dialog-hint">数据报表仅超级管理员可访问</p></fieldset>`;
    } else if (type === 'password') {
      title = '修改密码'; path = '/change-password'; fields = field('当前密码', 'oldPassword', '<input name="oldPassword" type="password" required>') + field('新密码（至少 10 位）', 'newPassword', '<input name="newPassword" type="password" minlength="10" required>');
    } else if (type === 'new-table' || type === 'edit-table') {
      title = item ? `编辑桌台 · ${item.table_no}` : '新增桌台'; path = item ? `/tables/${item.id}` : '/tables'; method = item ? 'PATCH' : 'POST';
      fields = field('桌号', 'tableNo', `<input name="tableNo" maxlength="30" placeholder="如 A-09" value="${escapeHtml(item?.table_no)}" required>`) + (item ? '<p class="dialog-hint">空闲桌台可修改桌号；正在使用的桌台请先结束本桌。</p>' : '');
    } else if (type === 'verify-group') {
      title = '录入团购核销'; path = '/group-buy/verify'; fields = field('平台', 'platform', '<select name="platform"><option>美团</option><option>抖音</option></select>') + field('券码', 'voucherNo') + field('套餐名称', 'packageName') + field('金额（元）', 'amount', number('amount', 0, 0, '.01'));
    } else if (type === 'new-wallet') {
      title = '新增储值套餐'; path = '/wallet-packages'; fields = field('套餐名称', 'name') + field('支付金额（元）', 'pay', number('pay', '', 0, '.01')) + field('储值金额（元）', 'stored', number('stored', '', 0, '.01')) + field('赠金（元）', 'bonus', number('bonus', 0, 0, '.01'));
    }
  } catch (error) { adminNotice(error.message); return; }
  adminState.dialog = type;
  const dialogFooter = type === 'review-refund'
    ? '<button type="button" class="outline-button" data-close-dialog>取消</button><button type="button" class="danger-button" data-refund-review="reject">拒绝退款</button><button type="button" class="primary-small" data-refund-review="approve">同意退款</button>'
    : '<button type="button" class="outline-button" data-close-dialog>取消</button><button type="submit" class="primary-small">确认保存</button>';
  root.innerHTML = `<div class="admin-dialog-backdrop"><section class="admin-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header><h2>${escapeHtml(title)}</h2><button type="button" data-close-dialog aria-label="关闭">×</button></header><form id="admin-operation-form"><div class="dialog-fields">${fields}</div><p class="dialog-error" aria-live="polite"></p><footer>${dialogFooter}</footer></form></section></div>`;
  const close = () => { adminState.dialog = null; root.innerHTML = ''; };
  root.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = close);
  root.querySelector('.admin-dialog-backdrop').onclick = event => { if (event.target.classList.contains('admin-dialog-backdrop')) close(); };
  if (type === 'review-refund') {
    root.querySelectorAll('[data-refund-review]').forEach(button => button.onclick = async () => {
      const form = root.querySelector('form');
      const errorBox = form.querySelector('.dialog-error');
      const actionType = button.dataset.refundReview;
      const reason = form.querySelector('[name="rejectReason"]').value.trim();
      if (actionType === 'reject' && !reason) { errorBox.textContent = '拒绝退款必须填写原因'; return; }
      root.querySelectorAll('[data-refund-review]').forEach(itemButton => { itemButton.disabled = true; });
      try {
        const result = await adminApi(`/refunds/${item.refundRequest.id}/${actionType}`, { method: 'POST', body: JSON.stringify(actionType === 'reject' ? { reason } : {}) });
        close();
        await renderAdmin();
        adminNotice(actionType === 'reject' ? '已拒绝退款申请' : (['processing', 'PROCESSING'].includes(result.status) ? '退款请求已提交，微信退款处理中' : '退款已处理'));
      } catch (error) {
        errorBox.textContent = error.message;
        root.querySelectorAll('[data-refund-review]').forEach(itemButton => { itemButton.disabled = false; });
      }
    });
  }
  if (type === 'new-storage') {
    const input = root.querySelector('[name="phone"]'), match = root.querySelector('#storage-member-match');
    input.oninput = async () => { const phone = input.value.trim(); match.textContent = '输入已绑定手机号，确认会员后登记'; if (!/^1[3-9]\d{9}$/.test(phone)) return; try { const result = await adminApi(`/members?phone=${phone}`); if (input.value.trim() === phone) match.textContent = result.members.find(m => m.phone === phone) ? `已找到：${result.members.find(m => m.phone === phone).nickname}` : '未找到该手机号，请先在会员管理中绑定'; } catch (error) { match.textContent = error.message; } };
    if (input.value) input.oninput();
  }
  if (type === 'new-coupon' || type === 'edit-coupon') {
    const selector = root.querySelector('[data-coupon-voucher-type]');
    const giftProduct = root.querySelector('[name="giftProductId"]');
    const discountFields = [...root.querySelectorAll('[data-coupon-discount-field]')];
    const syncCouponFields = () => {
      const productVoucher = selector.value === 'product';
      discountFields.forEach(input => {
        const wrapper = input.closest('.admin-field');
        if (wrapper) wrapper.hidden = productVoucher;
        input.disabled = productVoucher;
      });
      giftProduct.required = productVoucher;
      const giftWrapper = giftProduct.closest('.admin-field');
      if (giftWrapper) giftWrapper.hidden = !productVoucher;
      if (productVoucher) discountFields.forEach(input => { if (input.tagName === 'SELECT') input.value = input.name === 'type' ? 'fixed' : ''; });
    };
    selector.addEventListener('change', syncCouponFields);
    syncCouponFields();
  }
  if (type === 'issue-coupon') {
    const audience = root.querySelector('[name="audience"]');
    const phone = root.querySelector('[name="memberPhone"]');
    const userIds = root.querySelector('[name="userIds"]');
    const results = root.querySelector('#coupon-member-results');
    const search = root.querySelector('[data-find-coupon-member]');
    const syncAudience = () => {
      const picker = root.querySelector('.coupon-member-picker');
      if (picker) picker.hidden = audience.value === 'all';
      if (audience.value === 'all') userIds.value = '';
    };
    const renderMembers = members => {
      results.innerHTML = members.length
        ? members.map(member => `<label class="coupon-member-option"><input type="checkbox" data-coupon-member-id="${member.id}" ${userIds.value.split(',').includes(String(member.id)) ? 'checked' : ''}><span><strong>${escapeHtml(member.nickname)}</strong><small>${escapeHtml(member.phone || '未绑定手机号')} · ${escapeHtml(member.memberLevel)}</small></span></label>`).join('')
        : '<span class="dialog-hint">没有找到匹配会员，请确认手机号已绑定。</span>';
      results.querySelectorAll('[data-coupon-member-id]').forEach(input => input.onchange = () => {
        userIds.value = [...results.querySelectorAll('[data-coupon-member-id]:checked')].map(item => item.dataset.couponMemberId).join(',');
      });
    };
    search.onclick = async () => {
      const value = phone.value.trim();
      if (!/^\d{1,11}$/.test(value)) { results.innerHTML = '<span class="dialog-hint">请输入手机号数字后搜索。</span>'; return; }
      search.disabled = true;
      try { const data = await adminApi(`/members?phone=${encodeURIComponent(value)}&page=1&pageSize=20`); renderMembers(data.members || []); }
      catch (error) { results.innerHTML = `<span class="dialog-hint">${escapeHtml(error.message)}</span>`; }
      finally { search.disabled = false; }
    };
    audience.onchange = syncAudience;
    syncAudience();
    if (item?.userId) { phone.value = ''; results.innerHTML = '<span class="dialog-hint">已预选当前会员，可直接确认发放。</span>'; }
  }
  if (type === 'send-message') {
    const templateSelect = root.querySelector('[name="templateId"]');
    const valuesInput = root.querySelector('[name="values"]');
    const syncMessageValues = () => {
      const selected = messageData.templates.find(template => String(template.id) === String(templateSelect.value));
      valuesInput.value = messageTemplateValues(selected);
    };
    templateSelect.addEventListener('change', syncMessageValues);
    syncMessageValues();
  }
  root.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    if (type === 'review-refund') return;
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      if (type === 'reset-account') {
        if (payload.password !== payload.confirmPassword) throw new Error('两次输入的新密码不一致');
        delete payload.confirmPassword;
      }
      if (type === 'new-account' || type === 'edit-account') { payload.permissions = [...form.querySelectorAll('[name="permissions"]:checked')].map(input => input.value); if (item && !payload.password) delete payload.password; }
      if (type === 'new-coupon' || type === 'edit-coupon') {
        if (payload.voucherType === 'product' && !payload.giftProductId) throw new Error('请选择商品兑换券绑定的赠送商品');
        if (payload.voucherType !== 'product') delete payload.giftProductId;
      }
      if (type === 'edit-member' && payload.memberTierId !== String(item.memberTierId ?? '') && payload.memberExpiresAt === (item.memberExpiresAt?.slice(0, 10) || '')) delete payload.memberExpiresAt;
      if (type === 'edit-member' && (Number(payload.points) !== item.points || Number(payload.stored) !== item.stored || Number(payload.bonus) !== item.bonus) && !payload.reason.trim()) throw new Error('调整积分或钱包余额时请填写原因');
      if (type === 'issue-coupon' || type === 'send-message') {
        payload.userIds = payload.userIds.split(/[,，\s]+/).filter(Boolean).map(Number);
        if (payload.audience === 'selected' && (!payload.userIds.length || payload.userIds.some(id => !Number.isInteger(id) || id < 1))) throw new Error('请输入有效的指定会员 ID');
        if (payload.audience === 'all') payload.userIds = [];
        if (type === 'issue-coupon') path = `/coupons/${payload.couponId}/issue`;
        else {
          try { payload.values = JSON.parse(payload.values); }
          catch { throw new Error('模板变量必须是有效 JSON'); }
          if (!payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) throw new Error('模板变量必须是 JSON 对象');
        }
        delete payload.couponId;
      }
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
        const pendingRefundCount = Number(data.pendingRefunds || 0);
        const newRefundCount = lastPendingRefundCount !== null && pendingRefundCount > lastPendingRefundCount ? pendingRefundCount - lastPendingRefundCount : 0;
        lastPendingRefundCount = pendingRefundCount;
        if (adminState.section === 'dashboard') {
          await renderAdmin();
        } else {
          await renderAdmin();
        }
        if (newOrderCount) adminNotice(`收到 ${newOrderCount} 笔新订单，请及时处理`);
        if (newRefundCount && ['super', 'manager'].includes(adminState.account.role)) adminNotice(`收到 ${newRefundCount} 笔新的退款申请，请及时审核`);
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
else if (import.meta.env.PROD) {
  // The production website is for administration only. Customer ordering is
  // available through the WeChat mini program, while Vite dev keeps its preview.
  document.querySelector('#app').innerHTML = '<main class="phone-shell"><section class="empty-state"><h1>请使用微信小程序点单</h1><p>网页点单入口已关闭，请扫描桌台小程序码进入。</p></section></main>';
}
else {
  renderCustomer();
  loadData();
}
