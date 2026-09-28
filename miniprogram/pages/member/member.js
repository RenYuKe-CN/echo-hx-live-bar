const api = require('../../utils/api');
Page({
  data: { user: {}, wallet: {}, entries: [], expiry: '', avatar: '', initial: '会' },
  onShow() {
    Promise.all([api.request('/me'), api.request('/mini-page')]).then(([profile, page]) => {
      const expiry = profile.user.member_expires_at;
      const symbols = { gift: '礼', bottle: '酒', wallet: '¥', receipt: '单', star: '★', glass: '杯', card: '卡', bag: '兑' };
      this.setData({ user: profile.user, wallet: profile.wallet, entries: page.entries.map(item => ({ ...item, symbol: symbols[item.icon] || '会' })), expiry: expiry && profile.user.member_level !== '普通会员' ? expiry.slice(0, 10) : '', avatar: profile.user.avatar_url ? api.imageUrl(profile.user.avatar_url) : '', initial: (profile.user.nickname || '会').charAt(0) });
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  open(e) {
    const routes = { rewards: '/pages/rewards/rewards', storage: '/pages/storage/storage', recharge: '/pages/recharge/recharge', orders: '/pages/order/order' };
    const url = routes[e.currentTarget.dataset.key];
    if (url) wx.navigateTo({ url });
  }
});
