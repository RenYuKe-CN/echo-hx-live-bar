const api = require('../../utils/api');
Page({
  data: { tabs: ['可使用', '已使用', '已过期'], tab: 0, coupons: [], visible: [] },
  onShow() { api.request('/me/coupons').then(({ coupons }) => { this.setData({ coupons }); this.filter(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })); },
  chooseTab(e) { this.setData({ tab: Number(e.currentTarget.dataset.index) }); this.filter(); },
  filter() {
    const groups = [['available'], ['used', 'locked'], ['expired', 'cancelled']];
    this.setData({ visible: this.data.coupons.filter(c => groups[this.data.tab].includes(c.status)).map(c => ({ ...c, amountText: c.type === 'fixed' ? `¥${Number(c.amount).toFixed(2)}` : `${(Number(c.discountRate) * 10).toFixed(1)}折`, expiryText: c.expiredAt ? String(c.expiredAt).slice(0, 10) : '长期有效', minimumText: Number(c.minOrder) ? `满 ¥${Number(c.minOrder).toFixed(2)} 可用` : '无门槛', image: api.imageUrl(c.iconUrl) })) });
  }
});
