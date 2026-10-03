const api = require('../../utils/api');

Page({
  data: { orders: [], busyOrderNo: '' },

  onShow() {
    this.loadOrders();
  },

  onHide() {
    this.stopCountdown();
  },

  onUnload() {
    this.stopCountdown();
  },

  stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  },

  startCountdown() {
    this.stopCountdown();
    this._countdownTimer = setInterval(() => this.refreshCountdown(), 1000);
  },

  formatExpireText(expireAt, now = Date.now()) {
    if (!expireAt) return '';
    const expireTime = new Date(expireAt).getTime();
    if (!Number.isFinite(expireTime)) return '';
    const totalSeconds = Math.max(0, Math.floor((expireTime - now) / 1000));
    return totalSeconds > 0
      ? `还剩 ${Math.floor(totalSeconds / 60)} 分钟 ${totalSeconds % 60} 秒自动取消订单`
      : '订单即将自动取消';
  },

  refreshCountdown() {
    const now = Date.now();
    let expired = false;
    const orders = this.data.orders.map(item => {
      if (item.payment_status !== 'pending' || !item.paymentExpireAt) return item;
      const remaining = Math.max(0, new Date(item.paymentExpireAt).getTime() - now);
      if (!remaining) expired = true;
      return { ...item, expireText: this.formatExpireText(item.paymentExpireAt, now) };
    });
    this.setData({ orders });
    if (expired && (!this._lastExpiryRefreshAt || now - this._lastExpiryRefreshAt >= 5000)) {
      this._lastExpiryRefreshAt = now;
      this.loadOrders();
    }
  },

  loadOrders() {
    return api.request('/me/orders').then(data => {
      const now = Date.now();
      this.setData({ orders: data.orders.map(item => ({
        ...item,
        fulfillmentLabel: item.status === 'completed' ? '已送达' : item.paymentStatusLabel === '已支付' ? '待送达' : item.paymentStatusLabel,
        payableText: Number(item.payableAmount).toFixed(2),
        discountText: Number(item.discountAmount).toFixed(2),
        memberDiscountText: Number(item.memberDiscount || 0).toFixed(2),
        couponDiscountText: Number(item.couponDiscount || 0).toFixed(2),
        originalText: Number(item.originalAmount).toFixed(2),
        storedText: Number(item.storedPaid).toFixed(2),
        bonusText: Number(item.bonusPaid).toFixed(2),
        wechatText: Number(item.wechatPaid).toFixed(2),
        expireText: item.payment_status === 'pending' ? this.formatExpireText(item.paymentExpireAt, now) : ''
      })) });
      this.refreshCountdown();
      this.startCountdown();
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },

  continuePay(event) {
    const orderNo = event.currentTarget.dataset.orderNo;
    if (!orderNo || this.data.busyOrderNo) return;
    this.setData({ busyOrderNo: orderNo });
    api.request(`/me/orders/${encodeURIComponent(orderNo)}/pay`, { method: 'POST' }).then(data => {
      if (!data.payment) return this.loadOrders();
      wx.requestPayment({
        ...data.payment,
        success: () => {
          wx.showToast({ title: '支付成功', icon: 'success' });
          this.loadOrders();
        },
        fail: error => wx.showToast({ title: error.errMsg?.includes('cancel') ? '已取消支付' : '支付未完成', icon: 'none' })
      });
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ busyOrderNo: '' }));
  },

  cancelOrder(event) {
    const orderNo = event.currentTarget.dataset.orderNo;
    if (!orderNo || this.data.busyOrderNo) return;
    wx.showModal({
      title: '取消订单',
      content: '确定取消这个待支付订单吗？商品会回到本桌购物车。',
      confirmText: '确认取消',
      success: result => {
        if (!result.confirm) return;
        this.setData({ busyOrderNo: orderNo });
        api.request(`/me/orders/${encodeURIComponent(orderNo)}/cancel`, { method: 'POST' }).then(() => {
          wx.showToast({ title: '订单已取消', icon: 'success' });
          this.loadOrders();
        }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ busyOrderNo: '' }));
      }
    });
  },

  hideOrder(event) {
    const orderNo = event.currentTarget.dataset.orderNo;
    if (!orderNo || this.data.busyOrderNo) return;
    wx.showModal({ title: '删除订单记录', content: '只会从你的订单列表隐藏，不会删除订单和支付记录。', confirmText: '隐藏', success: result => {
      if (!result.confirm) return;
      this.setData({ busyOrderNo: orderNo });
      api.request(`/me/orders/${encodeURIComponent(orderNo)}/hide`, { method: 'POST' }).then(() => {
        wx.showToast({ title: '已隐藏', icon: 'success' });
        this.loadOrders();
      }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ busyOrderNo: '' }));
    } });
  }
});
