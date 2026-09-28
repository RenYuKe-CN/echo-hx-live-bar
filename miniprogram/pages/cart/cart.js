const api = require('../../utils/api');
const emptyTotals = { originalText: '0.00', memberText: '0.00', discountText: '0.00' };
Page({
  data: { items: [], totals: emptyTotals, isMember: false, checkout: null, method: 'balance', submitting: false },
  onShow() { this.refresh(); },
  refresh() {
    const id = getApp().globalData.sessionId;
    if (!id) return;
    Promise.all([api.request('/sessions/' + id + '/cart'), api.request('/sessions/' + id + '/checkout')]).then(([cart, checkout]) => {
      const normalizedCheckout = (() => { const bonusUsable = Number(checkout.bonusUsable ?? Math.min(Number(checkout.bonus || 0), Number(checkout.bonusEligible || 0), Number(checkout.payable || 0))); const storedUsable = Number(checkout.storedUsable ?? Math.min(Number(checkout.stored || 0), Math.max(Number(checkout.payable || 0) - bonusUsable, 0))); const balanceDeduction = Number(checkout.balanceDeduction ?? bonusUsable + storedUsable); const wechatDue = Number(checkout.wechatDue ?? Math.max(Number(checkout.payable || 0) - balanceDeduction, 0)); return { ...checkout, bonusUsable, storedUsable, balanceDeduction, wechatDue, balanceAvailable: checkout.balanceAvailable ?? wechatDue === 0, mixedPaymentAvailable: checkout.mixedPaymentAvailable ?? (balanceDeduction > 0 && wechatDue > 0), storedText: Number(checkout.stored || 0).toFixed(2), bonusText: Number(checkout.bonus || 0).toFixed(2), usableBonusText: bonusUsable.toFixed(2), storedUsableText: storedUsable.toFixed(2), balanceDeductionText: balanceDeduction.toFixed(2), wechatDueText: wechatDue.toFixed(2) }; })();
      this.setData({
        isMember: Boolean(cart.membership.active),
        items: cart.items.map(i => ({ ...i, showDiscount: cart.membership.active && i.memberPrice < i.price, initial: i.name.charAt(0), image: api.imageUrl(i.image_url), originalText: (i.price * i.quantity).toFixed(2), memberText: (i.memberPrice * i.quantity).toFixed(2), referenceMemberText: ((i.referenceMemberPrice ?? i.price) * i.quantity).toFixed(2) })),
        totals: { ...cart.totals, originalText: cart.totals.original.toFixed(2), memberText: cart.totals.member.toFixed(2), discountText: cart.totals.discount.toFixed(2) },
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
  upgrade() {
    wx.showModal({ title: '充值升级会员', content: '是否查看储值套餐？满足商家设置的升级条件后可享会员价。', confirmText: '查看套餐', success: result => { if (result.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' }); } });
  },
  pay() {
    if (!this.data.items.length || this.data.submitting) return;
    const id = getApp().globalData.sessionId;
    this.setData({ submitting: true });
    api.request('/sessions/' + id + '/orders', { method: 'POST', data: { paymentMethod: this.data.method } }).then(data => {
      if (data.payment.status === 'paid') {
        this.setData({ items: [], totals: emptyTotals });
        wx.showToast({ title: '余额支付成功', icon: 'success' });
        wx.navigateTo({ url: '/pages/order/order' });
      } else {
        wx.showModal({ title: data.payment.statusLabel || '待微信支付', content: data.payment.message + '；请勿重复下单，可联系店员处理。', showCancel: false, success: () => wx.navigateTo({ url: '/pages/order/order' }) });
      }
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ submitting: false }));
  }
});
