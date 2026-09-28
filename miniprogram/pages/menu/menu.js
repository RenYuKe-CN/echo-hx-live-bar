const api = require('../../utils/api');
Page({
  data: { products: [], visibleProducts: [], categories: ['推荐'], category: '推荐', cart: [], cartMap: {}, totals: { original: 0, member: 0, originalText: '0.00', memberText: '0.00', discount: 0 }, totalQty: 0, user: {}, isMember: false, memberInitial: '会', tableNo: 'A-08', appName: 'Echo HX Live Bar', homeTitle: '今晚喝点什么？', detailProduct: null },
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
      this.setData({ products: products.products, categories: ['推荐'].concat(products.categories.filter(c => c !== '推荐')), user: session.user, isMember: Boolean(products.membership.active), memberInitial: (session.user.member_level || '会').charAt(0), appName: settings.app_name || 'Echo HX Live Bar', homeTitle: settings.home_title || '今晚喝点什么？' });
      wx.setNavigationBarTitle({ title: settings.app_name || 'Echo HX Live Bar' });
      this.filter(); this.refreshCart();
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
    api.request('/sessions/' + id + '/cart').then(data => {
      const cartMap = {}; data.items.forEach(i => { cartMap[i.product_id] = i.quantity; });
      this.setData({ cart: data.items, cartMap, totals: { ...data.totals, originalText: Number(data.totals.original).toFixed(2), memberText: Number(data.totals.member).toFixed(2) }, totalQty: data.items.reduce((n, i) => n + i.quantity, 0) });
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  change(e) {
    const id = Number(e.currentTarget.dataset.id), delta = Number(e.currentTarget.dataset.delta);
    const item = this.data.cart.find(i => i.product_id === id), sid = getApp().globalData.sessionId;
    const action = delta > 0 ? api.request('/sessions/' + sid + '/cart/items', { method: 'POST', data: { productId: id, quantity: 1 } }) : item ? api.request('/sessions/' + sid + '/cart/items/' + item.id, { method: 'PATCH', data: { quantity: item.quantity - 1 } }) : Promise.resolve();
    action.then(() => this.refreshCart()).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  upgrade() {
    wx.showModal({ title: '充值升级会员', content: '是否查看储值套餐？满足商家设置的升级条件后可享会员价，具体以充值后的会员等级为准。', confirmText: '查看套餐', success: result => { if (result.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' }); } });
  },
  preview() { if (!this.data.totalQty) return wx.showToast({ title: '请先选择商品', icon: 'none' }); wx.navigateTo({ url: '/pages/cart/cart' }); }
});
