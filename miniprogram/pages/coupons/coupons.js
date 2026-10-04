const api = require('../../utils/api');
Page({
  data: { tabs: ['可使用', '已使用', '已过期'], tab: 0, coupons: [], visible: [], usingId: '' },
  onShow() {
    api.request('/me/coupons').then(({ coupons = [], couponCount = 0 }) => {
      const count = Number.isFinite(Number(couponCount)) ? Number(couponCount) : coupons.filter(coupon => coupon.status === 'available' && coupon.usable !== false).length;
      this.setData({ coupons, couponCount: count });
      this.filter(coupons);
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  chooseTab(e) { this.setData({ tab: Number(e.currentTarget.dataset.index) }); this.filter(); },
  filter(coupons = this.data.coupons) {
    const groups = [['available'], ['used', 'locked'], ['expired', 'cancelled']];
    this.setData({ visible: coupons.filter(c => groups[this.data.tab].includes(c.status)).map(c => ({
      ...c,
      amountText: c.isProductVoucher ? '免费兑换 1 件' : c.type === 'fixed' ? `¥${Number(c.amount).toFixed(2)}` : `${(Number(c.discountRate) * 10).toFixed(1)}折`,
      expiryText: c.expiredAt ? String(c.expiredAt).slice(0, 10) : '长期有效',
      minimumText: Number(c.minOrder) ? `满 ¥${Number(c.minOrder).toFixed(2)} 可用` : '无门槛',
      image: api.imageUrl(c.iconUrl || c.giftProductImage || ''),
      actionText: c.notStarted ? '未生效' : '去使用',
      giftPriceText: c.isProductVoucher && c.giftProductPrice != null ? `商品原价 ¥${Number(c.giftProductPrice).toFixed(2)}` : ''
    })) });
  },
  useCoupon(e) {
    const coupon = this.data.coupons.find(item => Number(item.id) === Number(e.currentTarget.dataset.id));
    if (!coupon || coupon.status !== 'available' || coupon.usable === false || this.data.usingId) return;
    const app = getApp();
    const sessionId = app.globalData.sessionId;
    if (!sessionId) {
      return wx.showModal({
        title: '请先进入桌台',
        content: coupon.isProductVoucher ? '商品兑换券需要绑定桌台后才能加入购物车，请先扫描桌台二维码。' : '请先扫描桌台二维码进入点单页，再使用这张优惠券。',
        confirmText: '去点单',
        success: result => {
          if (!result.confirm) return;
          if (coupon.isProductVoucher) {
            app.globalData.pendingCouponId = coupon.id;
            app.globalData.pendingCouponMode = 'product';
          }
          wx.switchTab({ url: '/pages/menu/menu' });
        }
      });
    }
    this.setData({ usingId: String(coupon.id) });
    // Let the menu page own the product-voucher flow. Amount and discount
    // coupons simply open the catalog; the customer can choose them at checkout.
    if (coupon.isProductVoucher) {
      app.globalData.pendingCouponId = coupon.id;
      app.globalData.pendingCouponMode = 'product';
    }
    wx.switchTab({ url: '/pages/menu/menu', fail: error => {
      delete app.globalData.pendingCouponId;
      delete app.globalData.pendingCouponMode;
      wx.showToast({ title: error.errMsg || '无法打开点单页', icon: 'none' });
    }, complete: () => this.setData({ usingId: '' }) });
  }
});
