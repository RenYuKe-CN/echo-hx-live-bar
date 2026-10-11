const api = require('../../utils/api');
const branding = require('../../utils/branding');
const service = require('../../utils/service');
const { moneyText, productIcon } = require('../../utils/presentation');
Page({
  data: { ...service.initialData, products: [], visibleProducts: [], categories: [], sections: [], category: '', targetSection: '', sidebarTarget: '', catalogTailHeight: 0, cart: [], cartMap: {}, pendingProducts: {}, totals: { original: 0, member: 0, originalText: '0.00', memberText: '0.00', discount: 0 }, couponCheckout: null, selectedCouponId: '', totalQty: 0, user: {}, isMember: false, memberInitial: '会', tableNo: '', ...branding.readSettings(), loading: true, loadError: '', cartBusy: false, detailProduct: null, authVisible: false, authBusy: false, authError: '', authStep: 'profile', authAvatarPath: '', authAvatarUrl: '', authNickname: '' },
  ...service.methods,
  onLoad() { this.tableVersion = -1; },
  onReady() { this.measureCatalog(); },
  onHide() { this.stopServicePolling(); },
  onUnload() { this.stopServicePolling(); },
  onShow() { this.startServicePolling(); return this.load().then(() => this.refreshServices()); },
  load() {
    const app = getApp();
    const version = app.globalData.tableVersion;
    const requestVersion = this.loadVersion = (this.loadVersion || 0) + 1;
    this.setData({ loading: true, loadError: '' });
    if (this.tableVersion !== version) {
      this.tableVersion = version;
      this.pendingCartActions = new Map();
      this.setData({ ...service.initialData, cart: [], cartMap: {}, pendingProducts: {}, cartBusy: false, totalQty: 0 });
    }
    return Promise.resolve(app.apiReady).then(() => app.globalData.pendingScene ? api.request('/tables/resolve?scene=' + encodeURIComponent(app.globalData.pendingScene)).then(result => result.table.tableNo) : app.globalData.tableNo).then(tableNo => {
      if (version !== app.globalData.tableVersion || requestVersion !== this.loadVersion) return null;
      app.globalData.tableNo = tableNo;
      this.setData({ tableNo });
      return Promise.all([api.request('/products?storeId=1'), tableNo && app.globalData.hasScannedTable ? api.request('/tables/' + encodeURIComponent(tableNo) + '/session') : Promise.resolve({ session: { id: null }, user: app.globalData.user || {} }), api.request('/mini-page')]);
    }).then(result => {
      if (!result || version !== app.globalData.tableVersion || requestVersion !== this.loadVersion) return;
      const [products, session, page] = result;
      branding.applySettings(this, page);
      app.globalData.miniPage = page.entries;
      app.globalData.sessionId = session.session.id;
      app.globalData.user = session.user;
      const profileReady = Boolean(session.user.phone && session.user.avatarUrl && session.user.nickname && session.user.nickname !== '微信用户') || !session.session.id;
      this.setData({ products: products.products, categories: ['推荐'].concat(products.categories.filter(c => c !== '推荐')), user: session.user, isMember: Boolean(products.membership.active), memberInitial: (session.user.memberLevel || '会').charAt(0), authVisible: !profileReady && !this.authPostponed, authStep: session.user.avatarUrl && session.user.nickname && session.user.nickname !== '微信用户' ? 'phone' : 'profile', authAvatarPath: session.user.avatarUrl ? api.imageUrl(session.user.avatarUrl) : '', authAvatarUrl: session.user.avatarUrl || '', authNickname: session.user.nickname === '微信用户' ? '' : (session.user.nickname || ''), authError: '' });
      this.filter();
      return this.refreshCart().then(() => this.consumePendingCoupon());
    }).catch(error => {
      if (requestVersion === this.loadVersion) this.setData({ loadError: error.message || '网络暂时不可用，请稍后重试' });
    }).finally(() => { if (requestVersion === this.loadVersion) this.setData({ loading: false }); });
  },
  retryLoad() { const app = getApp(); if (app.globalData.loginError && app.initialize) app.initialize(); return this.load(); },
  filter() {
    const list = this.data.products.map(p => ({ ...p, initial: (p.name || '商品').charAt(0), imageUrl: p.image_url && this.failedImages?.[p.id] !== api.imageUrl(p.image_url) ? api.imageUrl(p.image_url) : '', placeholderIcon: productIcon(p), remainingQuantity: Math.max(0, Number(p.stock) - (this.data.cartMap[p.id] || 0)), priceText: moneyText(p.price), memberPriceText: moneyText(p.memberPrice), referenceMemberPriceText: moneyText(p.referenceMemberPrice ?? p.price), showDiscount: this.data.isMember && p.memberPrice < p.price, componentsText: (p.components || []).map(c => `${c.name} × ${c.quantity}${c.unit}`).join(' · ') }));
    const categories = [...new Set(this.data.categories.concat(list.map(p => p.category)))].filter(c => list.some(p => p.category === c));
    const sections = categories.map((name,index) => ({ name, id: `section-${index}`, categoryId: `category-${index}`, productIndexes: list.map((p,i) => p.category === name ? i : -1).filter(i => i >= 0) }));
    this.setData({ visibleProducts: list, categories, sections, category: categories.includes(this.data.category) ? this.data.category : categories[0] || '' }, () => this.measureCatalog());
    if (this.data.detailProduct) this.setData({ detailProduct: list.find(item => item.id === this.data.detailProduct.id) || this.data.detailProduct });
  },
  onProductImageError(e) { const id = Number(e.currentTarget.dataset.id); this.failedImages = { ...this.failedImages, [id]: e.currentTarget.dataset.src }; this.filter(); },
  openTierRules() { wx.navigateTo({ url: '/pages/member-tiers/member-tiers' }); },
  selectCategory(e) {
    const category = e.currentTarget.dataset.category, index = this.data.categories.indexOf(category);
    if (index < 0) return;
    this.categoryJump = { index, until: Date.now() + 1000 };
    this.setData({ category, sidebarTarget: `category-${index}`, targetSection: '' }, () => this.setData({ targetSection: `section-${index}` }));
  },
  measureCatalog() {
    const query = this.createSelectorQuery?.() || wx.createSelectorQuery?.().in(this);
    if (!query || !this.data.sections.length) return;
    query.select('.product-scroll').boundingClientRect();
    query.selectAll('.catalog-section').boundingClientRect();
    query.select('.product-scroll').scrollOffset();
    query.exec(result => {
      const [viewport, sections, position] = result || [];
      if (!viewport || !sections?.length) return;
      this.catalogHeight = viewport.height;
      this.sectionOffsets = sections.map(r => r.top - viewport.top + (position?.scrollTop ?? this.lastCatalogScroll ?? 0));
      const tail = Math.max(0, Math.ceil(viewport.height - sections[sections.length - 1].height));
      if (tail !== this.data.catalogTailHeight) this.setData({ catalogTailHeight: tail });
    });
  },
  onCatalogTouch() { this.categoryJump = null; },
  onCatalogScroll(e) {
    const top = Math.max(0,e.detail.scrollTop || 0); this.lastCatalogScroll = top;
    if (!this.sectionOffsets?.length) return;
    if (this.categoryJump) {
      const target = this.sectionOffsets[this.categoryJump.index];
      if (Math.abs(top-target)<3 || Date.now()>this.categoryJump.until) this.categoryJump = null;
      else return;
    }
    let index = 0;
    this.sectionOffsets.forEach((offset,i) => { if (offset <= top + 12) index=i; });
    const category = this.data.categories[index];
    if (category && category !== this.data.category) this.setData({ category, sidebarTarget: `category-${index}` });
  },
  onResize() { this.measureCatalog(); },
  openGroupBuy() { wx.navigateTo({ url: '/pages/group-buy/group-buy' }); },
  showDetail(e) { const product = this.data.visibleProducts.find(item => item.id === Number(e.currentTarget.dataset.id)); if (product) this.setData({ detailProduct: product }); },
  closeDetail() { this.setData({ detailProduct: null }); },
  noop() {},
  addFromDetail() { const product = this.data.detailProduct; if (!product) return; return this.updateProductQuantity(product.id, 1).then(changed => { if (changed) this.setData({ detailProduct: null }); }); },
  cartContext() { const app = getApp(); return { sessionId: app.globalData.sessionId, tableVersion: app.globalData.tableVersion }; },
  isCurrentCart(context) { const current = this.cartContext(); return current.sessionId === context.sessionId && current.tableVersion === context.tableVersion; },
  refreshCart(context = this.cartContext()) {
    if (!context.sessionId || !this.isCurrentCart(context)) return Promise.resolve(null);
    const version = this.cartRefreshVersion = (this.cartRefreshVersion || 0) + 1;
    return api.request('/sessions/' + context.sessionId + '/cart').then(data => {
      if (!this.isCurrentCart(context) || version !== this.cartRefreshVersion) return null;
      // A product voucher creates a separate cart row. Keep the visible
      // quantity aggregated, but preserve ordinary rows for decrementing.
      const cartMap = {}; data.items.forEach(i => { cartMap[i.product_id] = (cartMap[i.product_id] || 0) + i.quantity; });
      const updates = { cart: data.items, cartMap, totals: { ...data.totals, originalText: moneyText(data.totals.original), memberText: moneyText(data.totals.member) }, totalQty: data.items.reduce((n, i) => n + i.quantity, 0) };
      // Quantity changes must not replace the product rows or their photos.
      const availability = new Map(data.items.map(item => [Number(item.product_id), Number(item.availableStock ?? item.stock)]));
      Object.entries(data.stockByProduct || {}).forEach(([id,stock])=>availability.set(Number(id),Number(stock)));
      this.data.products.forEach((product, index) => {
        const stock = availability.get(product.id);
        if (Number.isFinite(stock) && stock !== product.stock) updates[`products[${index}].stock`] = stock;
      });
      this.data.visibleProducts.forEach((product, index) => {
        const stock = Number.isFinite(availability.get(product.id)) ? availability.get(product.id) : product.stock;
        const remaining = data.remainingByProduct?.[product.id] ?? Math.max(0, Number(stock) - (cartMap[product.id] || 0));
        if (stock !== product.stock) updates[`visibleProducts[${index}].stock`] = stock;
        if (remaining !== product.remainingQuantity) updates[`visibleProducts[${index}].remainingQuantity`] = remaining;
        if (this.data.detailProduct?.id === product.id) {
          if (stock !== this.data.detailProduct.stock) updates['detailProduct.stock'] = stock;
          if (remaining !== this.data.detailProduct.remainingQuantity) updates['detailProduct.remainingQuantity'] = remaining;
        }
      });
      this.setData(updates, () => this.measureCatalog());
      if (this.data.selectedCouponId) return this.refreshCouponCheckout(this.data.selectedCouponId, context);
      return data;
    }).catch(error => { if (this.isCurrentCart(context)) throw error; return null; });
  },
  refreshCouponCheckout(couponId = this.data.selectedCouponId, context = this.cartContext()) {
    const sid = context.sessionId;
    if (!couponId || !sid) return Promise.resolve(null);
    const version = this.couponRefreshVersion = (this.couponRefreshVersion || 0) + 1;
    return api.request(`/sessions/${sid}/checkout?userCouponId=${encodeURIComponent(couponId)}`).then(checkout => {
      if (!this.isCurrentCart(context) || version !== this.couponRefreshVersion) return null;
      this.setData({ selectedCouponId: String(couponId), couponCheckout: {
        ...checkout,
        originalText: Number(checkout.original || 0).toFixed(2),
        payableText: Number(checkout.payable || 0).toFixed(2),
        couponDiscountText: Number(checkout.couponDiscount || 0).toFixed(2),
        memberDiscountText: Number(checkout.memberDiscount || 0).toFixed(2)
      } });
      return checkout;
    }).catch(error => {
      if (!this.isCurrentCart(context) || version !== this.couponRefreshVersion) return null;
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
    return select.then(() => this.refreshCart()).then(() => this.refreshCouponCheckout(couponId)).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  change(e) {
    const id = Number(e.currentTarget.dataset.id), delta = Number(e.currentTarget.dataset.delta);
    return this.updateProductQuantity(id, delta);
  },
  updateProductQuantity(id, delta) {
    if (!getApp().globalData.sessionId) { wx.showToast({ title: '请先用微信扫描桌台码', icon: 'none' }); return Promise.resolve(false); }
    this.pendingCartActions = this.pendingCartActions || new Map();
    if (this.pendingCartActions.has(id)) return Promise.resolve(false);
    const product = this.data.visibleProducts.find(item => item.id === id);
    if (delta > 0 && product?.remainingQuantity <= 0) return Promise.resolve(false);
    const context = this.cartContext();
    this.pendingCartActions.set(id, context);
    this.setData({ pendingProducts: { ...this.data.pendingProducts, [id]: true }, cartBusy: true });
    // Accept taps on other products, but serialize mutations and refreshes so
    // an older cart snapshot can never overwrite a newer quantity or total.
    const operation = (this.cartUpdateQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.isCurrentCart(context)) return false;
      try {
        const current = this.data.visibleProducts.find(row => row.id === id);
        if (delta > 0 && current?.remainingQuantity <= 0) return false;
        // Ordinary purchases and voucher gifts remain separate rows.
        const item = this.data.cart.find(row => row.product_id === id && !row.applied_coupon_id)
          || this.data.cart.find(row => row.product_id === id);
        if (delta > 0) await api.request(`/sessions/${context.sessionId}/cart/items`, { method: 'POST', data: { productId: id, quantity: 1 } });
        else if (item) await api.request(`/sessions/${context.sessionId}/cart/items/${item.id}`, { method: 'PATCH', data: { quantity: item.quantity - 1 } });
        else return false;
        await this.refreshCart(context);
        return this.isCurrentCart(context);
      } catch (error) {
        if (this.isCurrentCart(context)) wx.showToast({ title: error.message, icon: 'none' });
        return false;
      }
    }).finally(() => {
      if (this.pendingCartActions.get(id) !== context) return;
      this.pendingCartActions.delete(id);
      this.setData({ pendingProducts: { ...this.data.pendingProducts, [id]: false }, cartBusy: this.pendingCartActions.size > 0 });
    });
    this.cartUpdateQueue = operation;
    return operation;
  },
  upgrade() {
    wx.showModal({ title: '充值升级会员', content: '是否查看储值套餐？满足商家设置的升级条件后可享会员价，具体以充值后的会员等级为准。', confirmText: '查看套餐', success: result => { if (result.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' }); } });
  },
  preview() { if (this.data.cartBusy) return wx.showToast({ title: '正在更新购物车，请稍等', icon: 'none' }); if (!this.data.totalQty) return wx.showToast({ title: '请先选择商品', icon: 'none' }); const query = this.data.selectedCouponId ? `?userCouponId=${encodeURIComponent(this.data.selectedCouponId)}` : ''; wx.navigateTo({ url: `/pages/cart/cart${query}` }); },
  closeAuth() { this.authPostponed = true; this.setData({ authVisible: false, authError: '' }); },
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
