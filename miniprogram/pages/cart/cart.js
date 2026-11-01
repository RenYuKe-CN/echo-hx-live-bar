const api = require('../../utils/api');
const phoneBinding = require('../../utils/phone-binding');
const { reservationState } = require('../../utils/cart-reservation');
const emptyTotals = { originalText: '0.00', memberText: '0.00', payableText: '0.00', discountText: '0.00' };
Page({
  data: { tableNo: '', inventoryReserved: true, reservationExpiresAt: '', reservationText: '', reservingCart: false, items: [], totals: emptyTotals, isMember: false, checkout: null, coupons: [], selectedCouponId: '', method: 'balance', submitting: false, note: '', pendingItems: {}, cartBusy: false, refreshing: false, loadError: '', couponNotice: '' },
  onLoad(options) {
    if (options?.userCouponId) this.setData({ selectedCouponId: String(options.userCouponId) });
  },
  onShow() { this.stopPolling(); this.inventoryTimer=setInterval(() => this.pollInventory(),5000); return this.refresh(); },
  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); },
  stopPolling() { if(this.inventoryTimer) clearInterval(this.inventoryTimer); this.inventoryTimer=null; },
  pollInventory() { if(this.data.refreshing || this.data.cartBusy || this.data.submitting || this.data.reservingCart || this.inventoryPolling) return; this.inventoryPolling=true; return this.refresh({quiet:true}).finally(()=>{this.inventoryPolling=false;}); },
  async refresh(options = {}) {
    const app=getApp(),id=app.globalData.sessionId,version=app.globalData.tableVersion;
    const requestVersion = this.refreshVersion = (this.refreshVersion || 0) + 1;
    const current = () => id === app.globalData.sessionId && version === app.globalData.tableVersion && requestVersion === this.refreshVersion;
    if (!id) { this.setData({ items: [], checkout: null, totals: emptyTotals, loadError: '请返回点单页选择桌台', refreshing: false }); return false; }
    let selectedCouponId = this.data.selectedCouponId, couponNotice = this.data.couponNotice;
    if (!options.quiet) this.setData({ refreshing: true, loadError: '' });
    try {
      const [cart, couponData] = await Promise.all([api.request('/sessions/' + id + '/cart'), api.request('/me/coupons')]);
      if (!current()) return false;
      const availableCoupons = (couponData.coupons || []).filter(c => c.status === 'available' && c.usable !== false && (!c.isProductVoucher || cart.items.some(item => Number(item.applied_coupon_id) === Number(c.id))));
      if (selectedCouponId && (!cart.items.length || !availableCoupons.some(c => String(c.id) === String(selectedCouponId)))) {
        selectedCouponId = ''; couponNotice = '原优惠券已取消选择，请确认更新后的金额。';
      }
      let checkout;
      try { checkout = await api.request('/sessions/' + id + '/checkout' + (selectedCouponId ? `?userCouponId=${encodeURIComponent(selectedCouponId)}` : '')); }
      catch (error) {
        if (!current() || !selectedCouponId || error.code !== 'CHECKOUT_COUPON_INVALID') throw error;
        selectedCouponId = ''; couponNotice = `${error.message}，已取消选择，请确认更新后的金额。`;
        checkout = await api.request('/sessions/' + id + '/checkout');
      }
      if (!current()) return false;
      const normalizedCheckout = (() => { const bonusUsable = Number(checkout.bonusUsable ?? Math.min(Number(checkout.bonus || 0), Number(checkout.bonusEligible || 0), Number(checkout.payable || 0))); const storedUsable = Number(checkout.storedUsable ?? Math.min(Number(checkout.stored || 0), Math.max(Number(checkout.payable || 0) - bonusUsable, 0))); const balanceDeduction = Number(checkout.balanceDeduction ?? bonusUsable + storedUsable); const wechatDue = Number(checkout.wechatDue ?? Math.max(Number(checkout.payable || 0) - balanceDeduction, 0)); return { ...checkout, bonusUsable, storedUsable, balanceDeduction, wechatDue, balanceAvailable: checkout.balanceAvailable ?? wechatDue === 0, mixedPaymentAvailable: checkout.mixedPaymentAvailable ?? (balanceDeduction > 0 && wechatDue > 0), storedText: Number(checkout.stored || 0).toFixed(2), bonusText: Number(checkout.bonus || 0).toFixed(2), usableBonusText: bonusUsable.toFixed(2), storedUsableText: storedUsable.toFixed(2), balanceDeductionText: balanceDeduction.toFixed(2), wechatDueText: wechatDue.toFixed(2) }; })();
      const usingCoupon = Boolean(normalizedCheckout.usingCoupon);
      let remainingGiftQuantity = normalizedCheckout.productVoucher ? 1 : 0;
      this.setData({
        tableNo: cart.tableNo || app.globalData.tableNo || '', ...reservationState(cart.reservation, cart.items.length), loadError: '',
        isMember: Boolean(cart.membership.active),
        items: cart.items.map(i => {
          const giftQuantity = normalizedCheckout.productVoucher
            && Number(i.applied_coupon_id) === Number(selectedCouponId)
            && Number(i.product_id) === Number(normalizedCheckout.giftProductId)
            ? Math.min(remainingGiftQuantity, Number(i.quantity))
            : 0;
          remainingGiftQuantity -= giftQuantity;
          const paidQuantity = Math.max(Number(i.quantity) - giftQuantity, 0);
          const unitPrice = Number(i.memberPrice);
          const inCart = cart.items.filter(row => row.product_id === i.product_id).reduce((sum, row) => sum + Number(row.quantity), 0);
          const remaining = Math.max(0, Number(cart.remainingByProduct?.[i.product_id] ?? Math.max(0, Number(i.availableStock ?? i.stock ?? 0) - inCart)));
          return { ...i, remainingQuantity: remaining, canIncrease: !i.applied_coupon_id && remaining > 0, giftQuantity, paidQuantity, isGiftItem: giftQuantity > 0, showDiscount: cart.membership.active && i.memberPrice < i.price, usingCoupon, initial: i.name.charAt(0), image: api.imageUrl(i.image_url), originalText: (i.price * i.quantity).toFixed(2), memberText: (i.memberPrice * i.quantity).toFixed(2), paidOriginalText: (i.price * paidQuantity).toFixed(2), paidAmountText: (unitPrice * paidQuantity).toFixed(2), giftAmountText: (unitPrice * giftQuantity).toFixed(2), displayText: (unitPrice * paidQuantity).toFixed(2), referenceMemberText: ((i.referenceMemberPrice ?? i.price) * i.quantity).toFixed(2) };
        }),
        coupons: availableCoupons.map(c => ({ ...c, amountText: c.isProductVoucher ? '赠送 1 件' : c.type === 'fixed' ? `¥${Number(c.amount).toFixed(2)}` : `${(Number(c.discountRate) * 10).toFixed(1)}折`, minimumText: c.isProductVoucher ? `指定商品：${c.giftProductName || '兑换商品'}` : Number(c.minOrder) ? `满${Number(c.minOrder).toFixed(2)}可用` : '无门槛' })),
        totals: { ...cart.totals, originalText: Number(checkout.original ?? cart.totals.original).toFixed(2), memberText: Number(checkout.member ?? cart.totals.member).toFixed(2), payableText: Number(checkout.payable ?? cart.totals.member).toFixed(2), discountText: Number(checkout.discount ?? (checkout.original - checkout.payable)).toFixed(2) },
        checkout: normalizedCheckout,
        selectedCouponId, couponNotice,
        method: this.data.method === 'wechat' || (this.data.method === 'balance' && normalizedCheckout.balanceAvailable) || (this.data.method === 'mixed' && normalizedCheckout.mixedPaymentAvailable) ? this.data.method : normalizedCheckout.balanceAvailable ? 'balance' : normalizedCheckout.mixedPaymentAvailable ? 'mixed' : 'wechat'
      });
      return true;
    } catch (error) {
      if (current()) this.setData({ loadError: error.message || '订单金额更新失败，请重试', checkout: null });
      return false;
    } finally { if (current()) this.setData({ refreshing: false }); }
  },
  changeQuantity(e) {
    return this.updateCartItem(Number(e.currentTarget.dataset.id), { delta: Number(e.currentTarget.dataset.delta) });
  },
  async removeItem(e) {
    const id = Number(e.currentTarget.dataset.id), item = this.data.items.find(row => row.id === id);
    if (!item || this.data.submitting || this.data.pendingItems[id]) return;
    const sessionId = getApp().globalData.sessionId;
    const confirmed = await new Promise(resolve => wx.showModal({ title: '移除商品', content: `将“${item.name}”从本桌购物车移除？`, confirmText: '移除', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (confirmed && sessionId === getApp().globalData.sessionId) return this.updateCartItem(id, { quantity: 0 });
  },
  updateCartItem(id, change) {
    if (this.data.submitting || this.data.reservingCart || this.data.loadError || this.data.pendingItems[id]) return Promise.resolve(false);
    const app = getApp(), sessionId = app.globalData.sessionId, version = app.globalData.tableVersion;
    if (!sessionId) return Promise.resolve(false);
    const current = () => sessionId === app.globalData.sessionId && version === app.globalData.tableVersion;
    this.setData({ [`pendingItems[${id}]`]: true, cartBusy: true });
    const operation = (this.cartUpdateQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (!current() || this.data.loadError) return false;
      const item = this.data.items.find(row => row.id === id);
      if (!item || (change.delta > 0 && !item.canIncrease)) return false;
      this.refreshVersion = (this.refreshVersion || 0) + 1;
      let changed = false;
      try { await api.request(`/sessions/${sessionId}/cart/items/${id}`, { method: 'PATCH', data: change }); changed = true; }
      catch (error) { if (current()) wx.showToast({ title: error.message, icon: 'none' }); }
      // After an uncertain response, read the actual quantity instead of replaying a delta.
      const refreshed = current() && await this.refresh();
      return changed && refreshed;
    }).finally(() => {
      this.setData({ [`pendingItems[${id}]`]: false });
      this.setData({ cartBusy: Object.values(this.data.pendingItems).some(Boolean) });
    });
    this.cartUpdateQueue = operation;
    return operation;
  },
  async relockCart() {
    if (this.data.cartBusy || this.data.submitting || this.data.reservingCart) return;
    const id=getApp().globalData.sessionId; if(!id) return;
    this.setData({reservingCart:true});
    try { await api.request(`/sessions/${id}/cart/reserve`,{method:'POST'}); }
    catch(error) { wx.showToast({title:error.message,icon:'none'}); }
    finally { if(id===getApp().globalData.sessionId) await this.refresh(); this.setData({reservingCart:false}); }
  },
  backToMenu() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/menu/menu' }) });
  },
  chooseMethod(e) {
    if (this.data.submitting || this.data.cartBusy || this.data.refreshing || !this.data.checkout) return;
    const method = e.currentTarget.dataset.method;
    if (method === 'balance' && !this.data.checkout.balanceAvailable) return wx.showToast({ title: '余额不足，请选择组合支付或微信支付', icon: 'none' });
    if (method === 'mixed' && !this.data.checkout.mixedPaymentAvailable) return wx.showToast({ title: '当前订单不需要组合支付', icon: 'none' });
    this.setData({ method });
  },
  chooseCoupon(e) {
    if (this.data.submitting || this.data.cartBusy || this.data.refreshing) return;
    this.setData({ selectedCouponId: e.currentTarget.dataset.id || '', couponNotice: '' });
    return this.refresh();
  },
  upgrade() {
    wx.showModal({ title: '充值升级会员', content: '是否查看储值套餐？满足商家设置的升级条件后可享会员价。', confirmText: '查看套餐', success: result => { if (result.confirm) wx.navigateTo({ url: '/pages/recharge/recharge' }); } });
  },
  async pay() {
    if (!this.data.items.length || this.data.submitting || this.data.cartBusy || this.data.refreshing || this.data.loadError) return;
    if (!this.data.inventoryReserved || (this.data.reservationExpiresAt && Date.parse(this.data.reservationExpiresAt) <= Date.now())) { await this.refresh(); return wx.showToast({title:'库存锁定已失效，请重新锁定后确认',icon:'none'}); }
    const id = getApp().globalData.sessionId;
    getApp().globalData.checkoutInProgress=true;
    this.setData({ submitting: true });
    try {
      if (!await phoneBinding.ensureOrderPhone()) return;
      if (id !== getApp().globalData.sessionId) throw new Error('桌台已变化，请重新确认订单');
      const data = await api.request('/sessions/' + id + '/orders', { method: 'POST', data: { paymentMethod: this.data.method, userCouponId: this.data.selectedCouponId || undefined, note: this.data.note } });
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
    } catch (error) { await phoneBinding.handleOrderError(error); if(error.code !== 'PHONE_BINDING_REQUIRED') await this.refresh(); }
    finally { getApp().globalData.checkoutInProgress=false;this.setData({ submitting: false }); }
  },
  onNoteInput(e) { this.setData({ note: e.detail.value }); }
});
