const api = require('../../utils/api');

Page({
  data: { orderNo: '', order: null, loading: true, refundItems: [], refundAmountText: '0.00', submittingRefund: false, focusRefund: false },

  onLoad(options) {
    this.setData({
      orderNo: options.orderNo ? decodeURIComponent(options.orderNo) : '',
      focusRefund: options.refund === '1'
    });
  },

  onShow() {
    if (this.data.orderNo) this.loadOrder();
  },

  loadOrder() {
    this.setData({ loading: true });
    api.request(`/me/orders/${encodeURIComponent(this.data.orderNo)}`).then(data => {
      const order = data.order;
      const items = (order.items || []).map(item => ({
        ...item,
        initial: item.name ? item.name.charAt(0) : '酒',
        image: api.imageUrl(item.imageUrl || ''),
        originalPriceText: Number(item.originalPrice).toFixed(2),
        paidPriceText: Number(item.paidPrice).toFixed(2),
        originalSubtotalText: Number(item.originalSubtotal).toFixed(2),
        paidSubtotalText: Number(item.paidSubtotal).toFixed(2),
        refundQuantity: 0,
        refundAvailableText: String(item.refundAvailableQuantity || 0)
      }));
      this.setData({
        order: {
          ...order,
          originalText: Number(order.originalAmount).toFixed(2),
          discountText: Number(order.discountAmount).toFixed(2),
          memberDiscountText: Number(order.memberDiscount || 0).toFixed(2),
          couponDiscountText: Number(order.couponDiscount || 0).toFixed(2),
          payableText: Number(order.payableAmount).toFixed(2),
          storedText: Number(order.storedPaid || 0).toFixed(2),
          bonusText: Number(order.bonusPaid || 0).toFixed(2),
          wechatText: Number(order.wechatPaid || 0).toFixed(2),
          refundedText: Number(order.refundedAmount || 0).toFixed(2),
          items
        },
        refundItems: [],
        refundAmountText: '0.00',
        loading: false
      });
      if (this.data.focusRefund && order.canRefund) {
        setTimeout(() => wx.pageScrollTo({ selector: '#refund-panel', duration: 260 }), 80);
      }
    }).catch(error => {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    });
  },

  changeRefundQuantity(event) {
    const index = Number(event.currentTarget.dataset.index);
    const delta = Number(event.currentTarget.dataset.delta);
    const items = this.data.order?.items ? this.data.order.items.map(item => ({ ...item })) : [];
    const item = items[index];
    if (!item || !item.refundSelectable) return;
    const quantity = Math.max(0, Math.min(Number(item.refundAvailableQuantity || 0), Number(item.refundQuantity || 0) + delta));
    item.refundQuantity = quantity;
    const refundItems = items.filter(row => row.refundQuantity > 0).map(row => ({ orderItemId: row.id, quantity: row.refundQuantity }));
    this.setData({ 'order.items': items, refundItems }, this.calculateRefundEstimate);
  },

  calculateRefundEstimate() {
    const order = this.data.order;
    if (!order) return;
    const eligible = order.items.filter(item => item.refundSelectable);
    const totalBase = eligible.reduce((sum, item) => sum + Number(item.paidPrice || 0) * Number(item.refundAvailableQuantity || 0), 0);
    const selectedBase = this.data.refundItems.reduce((sum, selected) => {
      const item = order.items.find(row => row.id === selected.orderItemId);
      return sum + (item ? Number(item.paidPrice || 0) * selected.quantity : 0);
    }, 0);
    const remaining = Number(order.refundableAmount || 0);
    const selectedById = new Map(this.data.refundItems.map(item => [Number(item.orderItemId), Number(item.quantity)]));
    const selectedAllRemaining = eligible.length > 0 && eligible.every(item => selectedById.get(Number(item.id)) === Number(item.refundAvailableQuantity || 0));
    const amount = selectedAllRemaining
      ? remaining
      : totalBase > 0 ? Math.min(remaining, Math.round(remaining * selectedBase * 100 / totalBase) / 100) : 0;
    this.setData({ refundAmountText: amount.toFixed(2) });
  },

  submitRefund() {
    if (!this.data.orderNo || !this.data.refundItems.length || this.data.submittingRefund) {
      return wx.showToast({ title: '请选择要退款的商品数量', icon: 'none' });
    }
    this.setData({ submittingRefund: true });
    api.request(`/me/orders/${encodeURIComponent(this.data.orderNo)}/refund-requests`, {
      method: 'POST',
      data: { items: this.data.refundItems }
    }).then(() => {
      wx.showToast({ title: '退款申请已提交', icon: 'success' });
      this.loadOrder();
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }))
      .finally(() => this.setData({ submittingRefund: false }));
  }
});
