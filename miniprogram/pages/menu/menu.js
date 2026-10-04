const api = require('../../utils/api');
Page({
  data: { products: [], visibleProducts: [], categories: ['推荐'], category: '推荐', cart: [], cartMap: {}, totals: { original: 0, member: 0, originalText: '0.00', memberText: '0.00', discount: 0 }, couponCheckout: null, selectedCouponId: '', totalQty: 0, user: {}, isMember: false, memberInitial: '会', tableNo: 'A-08', appName: 'Echo HX Live Bar', homeTitle: '今晚喝点什么？', detailProduct: null, authVisible: false, authBusy: false, authError: '', authStep: 'profile', authAvatarPath: '', authAvatarUrl: '', authNickname: '' },
  onLoad() { this.tableVersion = -1; },
  onShow() { this.load(); },
  load() {
    const app = getApp();
    const version = app.globalData.tableVersion;
    if (this.tableVersion !== version) {
      this.tableVersion = version;
      this.setData({ cart: [], cartMap: {}, totalQty: 0 });
    }
    Promise.resolve(app.apiReady).then(() => app.globalData.pendingScene ? api.request('/tables/resolve?scene=' + encodeURIComponent(app.globalData.pendingScene)).then(result => result.table.tableNo) : app.globalData.tableNo).then(tableNo => {
      if (version !== app.globalData.tableVersion) return null;
      app.globalData.tableNo = tableNo;
      this.setData({ tableNo });
      return Promise.all([api.request('/products?storeId=1'), api.request('/tables/' + encodeURIComponent(tableNo) + '/session'), api.request('/mini-page')]);
    }).then(result => {
      if (!result || version !== app.globalData.tableVersion) return;
      const [products, session, page] = result;
      const settings = Object.fromEntries(page.entries.map(item => [item.key, item.title]));
      app.globalData.sessionId = session.session.id;
      app.globalData.user = session.user;
      const profileReady = Boolean(session.user.phone && session.user.avatarUrl && session.user.nickname && session.user.nickname !== '微信用户');
      this.setData({ products: products.products, categories: ['推荐'].concat(products.categories.filter(c => c !== '推荐')), user: session.user, isMember: Boolean(products.membership.active), memberInitial: (session.user.memberLevel || '会').charAt(0), appName: settings.app_name || 'Echo HX Live Bar', homeTitle: settings.home_title || '今晚喝点什么？', authVisible: !profileReady, authStep: session.user.avatarUrl && session.user.nickname && session.user.nickname !== '微信用户' ? 'phone' : 'profile', authAvatarPath: session.user.avatarUrl ? api.imageUrl(session.user.avatarUrl) : '', authAvatarUrl: session.user.avatarUrl || '', authNickname: session.user.nickname === '微信用户' ? '' : (session.user.nickname || ''), authError: '' });
      wx.setNavigationBarTitle({ title: settings.app_name || 'Echo HX Live Bar' });
      this.filter(); this.refreshCart().then(() => this.consumePendingCoupon());
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  filter() {
    const list = (this.data.category === '推荐' ? this.data.products : this.data.products.filter(p => p.category === this.data.category)).map(p => ({ ...p, initial: p.name.charAt(0), imageUrl: p.image_url ? api.imageUrl(p.image_url) : '', priceText: Number(p.price).toFixed(2), memberPriceText: Number(p.memberPrice).toFixed(2), referenceMemberPriceText: Number(p.referenceMemberPrice ?? p.price).toFixed(2), showDiscount: this.data.isMember && p.memberPrice < p.price }));
    this.setData({ visibleProducts: list });
  },
  selectCategory(e) { this.setData({ category: e.currentTarget.dataset.category }); this.filter(); },
  showDetail(e) { const product = this.data.visibleProducts.find(item => item.id === Number(e.currentTarget.dataset.id)); if (product) this.setData({ detailProduct: product }); },
  closeDetail() { this.setData({ detailProduct: null }); },
  noop() {},
  addFromDetail() { const product = this.data.detailProduct; if (!product) return; const sid = getApp().globalData.sessionId; api.request('/sessions/' + sid + '/cart/items', { method: 'POST', data: { productId: product.id, quantity: 1 } }).then(() => { this.setData({ detailProduct: null }); this.refreshCart(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  refreshCart() {
    const id = getApp().globalData.sessionId;
    return api.request('/sessions/' + id + '/cart').then(data => {
      // A product voucher creates a separate cart row. Keep the visible
      // quantity aggregated, but preserve ordinary rows for decrementing.
      const cartMap = {}; data.items.forEach(i => { cartMap[i.product_id] = (cartMap[i.product_id] || 0) + i.quantity; });
      this.setData({ cart: data.items, cartMap, totals: { ...data.totals, originalText: Number(data.totals.original).toFixed(2), memberText: Number(data.totals.member).toFixed(2) }, totalQty: data.items.reduce((n, i) => n + i.quantity, 0) });
      if (this.data.selectedCouponId) return this.refreshCouponCheckout();
      return data;
    }).catch(error => { wx.showToast({ title: error.message, icon: 'none' }); throw error; });
  },
  refreshCouponCheckout(couponId = this.data.selectedCouponId) {
    const sid = getApp().globalData.sessionId;
    if (!couponId || !sid) return Promise.resolve(null);
    return api.request(`/sessions/${sid}/checkout?userCouponId=${encodeURIComponent(couponId)}`).then(checkout => {
      this.setData({ selectedCouponId: String(couponId), couponCheckout: {
        ...checkout,
        originalText: Number(checkout.original || 0).toFixed(2),
        payableText: Number(checkout.payable || 0).toFixed(2),
        couponDiscountText: Number(checkout.couponDiscount || 0).toFixed(2)
      } });
      return checkout;
    }).catch(error => {
      this.setData({ selectedCouponId: '', couponCheckout: null });
      wx.showToast({ title: error.message, icon: 'none' });
      return null;
    });
  },
  consumePendingCoupon() {
    const app = getApp();
    const couponId = app.globalData.pendingCouponId;
    if (!couponId || !app.globalData.sessionId) return;
    const mode = app.globalData.pendingCouponMode || 'product';
    delete app.globalData.pendingCouponId;
    delete app.globalData.pendingCouponMode;
    const select = mode === 'product'
      ? api.request(`/sessions/${app.globalData.sessionId}/coupons/${couponId}/use`, { method: 'POST' }).then(() => {
        wx.showToast({ title: '兑换商品已加入购物车', icon: 'success' });
      })
      : Promise.resolve();
    select.then(() => this.refreshCart()).then(() => this.refreshCouponCheckout(couponId)).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  change(e) {
    const id = Number(e.currentTarget.dataset.id), delta = Number(e.currentTarget.dataset.delta);
    // Reduce a paid row first. The voucher row is fixed at one and must not
    // be removed when the customer decreases an ordinary purchase.
    const item = this.data.cart.find(i => i.product_id === id && !i.applied_coupon_id)
      || this.data.cart.find(i => i.product_id === id);
    const sid = getApp().globalData.sessionId;
    const action = delta > 0 ? api.request('/sessions/' + sid + '/cart/items', { method: 'POST', data: { productId: id, quantity: 1 } }) : item ? api.request('/sessions/' + sid + '/cart/items/' + item.id, { method: 'PATCH', data: { quantity: item.quantity - 1 } }) : Promise.resolve();
    action.then(() => this.refreshCart()).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  upgrade() {
    wx.showModal({ title: '充值升级会员', content: '是否查看储值套餐？满足商家设置的升级条件后可享会员价，具体以充值后的会员等级为准。', confirmText: '查看套餐', success: result => { if (result.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' }); } });
  },
  preview() { if (!this.data.totalQty) return wx.showToast({ title: '请先选择商品', icon: 'none' }); const query = this.data.selectedCouponId ? `?userCouponId=${encodeURIComponent(this.data.selectedCouponId)}` : ''; wx.navigateTo({ url: `/pages/cart/cart${query}` }); },
  closeAuth() { this.setData({ authVisible: false, authError: '' }); },
  onAuthAvatar(e) {
    const avatarPath = e.detail?.avatarUrl;
    if (avatarPath) this.setData({ authAvatarPath: avatarPath, authAvatarUrl: '', authError: '' });
    else this.setData({ authError: e.detail?.errMsg || '微信没有返回头像，请重新点击头像区域授权' });
  },
  onAuthNickname(e) {
    this.setData({ authNickname: e.detail?.value || '', authError: '' });
  },
  saveAuthProfile() {
    if (this.data.authBusy) return;
    const nickname = String(this.data.authNickname || '').trim();
    if (!this.data.authAvatarPath) return this.setData({ authError: '请点击头像区域，使用微信官方组件选择头像' });
    if (!nickname || nickname === '微信用户') return this.setData({ authError: '请使用昵称输入框填写有效昵称' });
    this.setData({ authBusy: true, authError: '' });
    const upload = this.data.authAvatarUrl ? Promise.resolve(this.data.authAvatarUrl) : api.uploadAvatar(this.data.authAvatarPath);
    upload.then(avatarUrl => api.request('/me/profile', { method: 'PATCH', data: { nickname, avatarUrl } })).then(({ user }) => {
      getApp().globalData.user = user;
      getApp().globalData.profileComplete = Boolean(user.phone && user.avatarUrl && user.nickname && user.nickname !== '微信用户');
      this.setData({ user, memberInitial: (user.memberLevel || '会').charAt(0), authAvatarPath: api.imageUrl(user.avatarUrl || ''), authAvatarUrl: user.avatarUrl || '', authNickname: user.nickname, authStep: user.phone ? '' : 'phone', authError: '' });
      if (user.phone) this.setData({ authVisible: false });
    }).catch(error => this.setData({ authError: error.message || '头像昵称保存失败，请重试' })).finally(() => this.setData({ authBusy: false }));
  },
  onPhone(e) {
    if (this.data.authBusy) return;
    if (!e.detail?.code) {
      const detail = e.detail?.errMsg || '';
      return this.setData({ authError: detail.includes('deny') || detail.includes('cancel') ? '你没有同意手机号授权，可以点击按钮重新授权' : `未获得手机号授权${detail ? `：${detail}` : '，请点击按钮重试'}` });
    }
    this.setData({ authBusy: true, authError: '' });
    api.request('/me/phone', { method: 'POST', data: { code: e.detail.code } }).then(({ user }) => {
      getApp().globalData.user = user;
      getApp().globalData.profileComplete = true;
      this.setData({ user, authVisible: false, authStep: '', authError: '' });
    }).catch(error => this.setData({ authError: error.message || '手机号绑定失败，请重试' })).finally(() => this.setData({ authBusy: false }));
  }
});
