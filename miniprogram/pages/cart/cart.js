const api = require('../../utils/api');
const emptyTotals = { originalText: '0.00', memberText: '0.00', payableText: '0.00', discountText: '0.00' };
Page({
  data: { items: [], totals: emptyTotals, isMember: false, checkout: null, coupons: [], selectedCouponId: '', method: 'balance', submitting: false, note: '' },
  onLoad(options) {
    if (options?.userCouponId) this.setData({ selectedCouponId: String(options.userCouponId) });
  },
  onShow() { this.refresh(); },
  refresh() {
    const id = getApp().globalData.sessionId;
    if (!id) return;
    const couponQuery = this.data.selectedCouponId ? `?userCouponId=${encodeURIComponent(this.data.selectedCouponId)}` : '';
    Promise.all([api.request('/sessions/' + id + '/cart'), api.request('/me/coupons'), api.request('/sessions/' + id + '/checkout' + couponQuery)]).then(([cart, couponData, checkout]) => {
      const normalizedCheckout = (() => { const bonusUsable = Number(checkout.bonusUsable ?? Math.min(Number(checkout.bonus || 0), Number(checkout.bonusEligible || 0), Number(checkout.payable || 0))); const storedUsable = Number(checkout.storedUsable ?? Math.min(Number(checkout.stored || 0), Math.max(Number(checkout.payable || 0) - bonusUsable, 0))); const balanceDeduction = Number(checkout.balanceDeduction ?? bonusUsable + storedUsable); const wechatDue = Number(checkout.wechatDue ?? Math.max(Number(checkout.payable || 0) - balanceDeduction, 0)); return { ...checkout, bonusUsable, storedUsable, balanceDeduction, wechatDue, balanceAvailable: checkout.balanceAvailable ?? wechatDue === 0, mixedPaymentAvailable: checkout.mixedPaymentAvailable ?? (balanceDeduction > 0 && wechatDue > 0), storedText: Number(checkout.stored || 0).toFixed(2), bonusText: Number(checkout.bonus || 0).toFixed(2), usableBonusText: bonusUsable.toFixed(2), storedUsableText: storedUsable.toFixed(2), balanceDeductionText: balanceDeduction.toFixed(2), wechatDueText: wechatDue.toFixed(2) }; })();
      const usingCoupon = Boolean(normalizedCheckout.usingCoupon);
      let remainingGiftQuantity = normalizedCheckout.productVoucher ? 1 : 0;
      this.setData({
        isMember: Boolean(cart.membership.active),
        items: cart.items.map(i => {
          const giftQuantity = normalizedCheckout.productVoucher
            && Number(i.applied_coupon_id) === Number(this.data.selectedCouponId)
            && Number(i.product_id) === Number(normalizedCheckout.giftProductId)
            ? Math.min(remainingGiftQuantity, Number(i.quantity))
            : 0;
          remainingGiftQuantity -= giftQuantity;
          const paidQuantity = Math.max(Number(i.quantity) - giftQuantity, 0);
          const unitPrice = Number(i.memberPrice);
          return { ...i, giftQuantity, paidQuantity, isGiftItem: giftQuantity > 0, showDiscount: cart.membership.active && i.memberPrice < i.price, usingCoupon, initial: i.name.charAt(0), image: api.imageUrl(i.image_url), originalText: (i.price * i.quantity).toFixed(2), memberText: (i.memberPrice * i.quantity).toFixed(2), paidOriginalText: (i.price * paidQuantity).toFixed(2), paidAmountText: (unitPrice * paidQuantity).toFixed(2), giftAmountText: (unitPrice * giftQuantity).toFixed(2), displayText: (unitPrice * paidQuantity).toFixed(2), referenceMemberText: ((i.referenceMemberPrice ?? i.price) * i.quantity).toFixed(2) };
        }),
        coupons: (couponData.coupons || []).filter(c => c.status === 'available' && c.usable !== false && (!c.isProductVoucher || cart.items.some(item => Number(item.applied_coupon_id) === Number(c.id)))).map(c => ({ ...c, amountText: c.isProductVoucher ? '赠送 1 件' : c.type === 'fixed' ? `¥${Number(c.amount).toFixed(2)}` : `${(Number(c.discountRate) * 10).toFixed(1)}折`, minimumText: c.isProductVoucher ? `指定商品：${c.giftProductName || '兑换商品'}` : Number(c.minOrder) ? `满${Number(c.minOrder).toFixed(2)}可用` : '无门槛' })),
        totals: { ...cart.totals, originalText: Number(checkout.original ?? cart.totals.original).toFixed(2), memberText: Number(checkout.member ?? cart.totals.member).toFixed(2), payableText: Number(checkout.payable ?? cart.totals.member).toFixed(2), discountText: Number(checkout.discount ?? (checkout.original - checkout.payable)).toFixed(2) },
        checkout: normalizedCheckout,
        method: normalizedCheckout.balanceAvailable ? 'balance' : normalizedCheckout.mixedPaymentAvailable ? 'mixed' : 'wechat'
      });
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  chooseMethod(e) {
    const method = e.currentTarget.dataset.method;
    if (method === 'balance' && !this.data.checkout.balanceAvailable) return wx.showToast({ title: '余额不足，请选择组合支付或微信支付', icon: 'none' });
    this.setData({ method });
  },
  chooseCoupon(e) {
    this.setData({ selectedCouponId: e.currentTarget.dataset.id || '' });
    this.refresh();
  },
  upgrade() {
    wx.showModal({ title: '充值升级会员', content: '是否查看储值套餐？满足商家设置的升级条件后可享会员价。', confirmText: '查看套餐', success: result => { if (result.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' }); } });
  },
  pay() {
    if (!this.data.items.length || this.data.submitting) return;
    const id = getApp().globalData.sessionId;
    this.setData({ submitting: true });
    api.request('/sessions/' + id + '/orders', { method: 'POST', data: { paymentMethod: this.data.method, userCouponId: this.data.selectedCouponId || undefined, note: this.data.note } }).then(async data => {
      if (data.payment.status === 'paid') {
        this.setData({ items: [], totals: emptyTotals, selectedCouponId: '', note: '' });
        wx.showToast({ title: data.order.payable_amount_cents === 0 ? '优惠券抵扣成功' : '余额支付成功', icon: 'success' });
        wx.navigateTo({ url: '/pages/order/order' });
      } else {
        const confirmed = await api.payWithWechat(data.payment.payment, data.order.order_no);
        this.setData({ items: [], totals: emptyTotals, selectedCouponId: '', note: '' });
        wx.showToast({ title: confirmed ? '支付成功' : '支付状态核对中', icon: confirmed ? 'success' : 'none' });
        wx.navigateTo({ url: '/pages/order/order' });
      }
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ submitting: false }));
  },
  onNoteInput(e) { this.setData({ note: e.detail.value }); }
});
