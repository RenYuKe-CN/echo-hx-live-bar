const api = require('../../utils/api');
Page({
  data: { user: {}, wallet: {}, membership: {}, entries: [], notices: {}, couponCount: 0, expiry: '', avatar: '', initial: '会' },
  onShow() {
    Promise.all([api.request('/me'), api.request('/mini-page'), api.request('/me/notification-summary').catch(() => ({ couponCount: 0, pendingOrderCount: 0, unreadMessageCount: 0 })), api.request('/me/coupons').catch(() => null)]).then(([profile, page, notices, couponData]) => {
      // Prefer the full list when it loaded successfully, but keep the
      // summary count during a transient list request failure so a coupon
      // badge does not disappear just because one request timed out.
      const availableCouponCount = Array.isArray(couponData?.coupons)
        ? Number(couponData.couponCount ?? couponData.coupons.filter(coupon => coupon.status === 'available' && coupon.usable !== false).length)
        : Number(notices.couponCount || 0);
      // The coupon list is the source of truth for this badge. The summary
      // endpoint may be cached briefly while a newly issued coupon is being
      // read, so falling back to its old count can hide a usable coupon.
      const safeNotices = { ...notices, couponCount: availableCouponCount };
      const expiry = profile.user.memberExpiresAt;
      const symbols = { gift: '礼', bottle: '酒', wallet: '¥', receipt: '单', star: '★', glass: '杯', card: '卡', bag: '兑' };
      const membership = profile.membership || {};
      membership.progressPercent = Math.round(Number(membership.progress || 0) * 100);
      const fallbackEntries = [
        { key: 'rewards', title: '兑换中心', icon: 'gift', type: 'entry' },
        { key: 'storage', title: '我的存酒', icon: 'bottle', type: 'entry' },
        { key: 'recharge', title: '会员充值', icon: 'wallet', type: 'entry' },
        { key: 'orders', title: '我的订单', icon: 'receipt', type: 'entry' },
        { key: 'coupons', title: '我的券包', icon: 'gift', type: 'entry' },
        { key: 'messages', title: '消息中心', icon: 'card', type: 'entry' }
      ];
      const configuredEntries = (page.entries || []).filter(item => item.type !== 'text');
      const entryMap = new Map(configuredEntries.map(item => [item.key, item]));
      fallbackEntries.forEach(item => { if (!entryMap.has(item.key)) entryMap.set(item.key, item); });
      const entries = [...entryMap.values()].map(item => ({
        ...item,
        symbol: symbols[item.icon] || '会',
        badgeCount: item.key === 'orders'
          ? Number(safeNotices.pendingOrderCount || 0)
          : item.key === 'coupons'
            ? Number(availableCouponCount || 0)
            : item.key === 'messages'
              ? Number(safeNotices.unreadMessageCount || 0)
              : 0
      }));
      this.setData({ user: profile.user, wallet: profile.wallet, membership, notices: safeNotices, couponCount: availableCouponCount, entries, expiry: expiry && profile.user.memberLevel !== '普通会员' ? expiry.slice(0, 10) : '', avatar: profile.user.avatarUrl ? api.imageUrl(profile.user.avatarUrl) : '', initial: (profile.user.nickname || '会').charAt(0) });
      const pageEntries = Array.isArray(page.entries) ? page.entries : [];
      wx.setNavigationBarTitle({ title: pageEntries.find(item => item.key === 'app_name')?.title || 'Echo HX Live Bar' });
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  open(e) {
    const routes = { rewards: '/pages/rewards/rewards', storage: '/pages/storage/storage', recharge: '/pages/recharge/recharge', orders: '/pages/order/order', coupons: '/pages/coupons/coupons', messages: '/pages/messages/messages' };
    const url = routes[e.currentTarget.dataset.key];
    if (url) wx.navigateTo({ url });
  },
  openProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },
  openTierRules() {
    wx.navigateTo({ url: '/pages/member-tiers/member-tiers' });
  }
});
