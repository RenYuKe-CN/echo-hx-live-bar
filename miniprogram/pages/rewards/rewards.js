const api = require('../../utils/api');
Page({
  data: { rewards: [], redemptions: [], points: 0, busy: false },
  onShow() { this.load(); },
  load() {
    Promise.all([api.request('/rewards'), api.request('/me'), api.request('/me/redemptions')]).then(([catalog, profile, history]) => this.setData({ rewards: catalog.rewards.map(item => ({ ...item, image: api.imageUrl(item.imageUrl) })), points: profile.user.points, redemptions: history.redemptions.map(item => ({ ...item, statusLabel: item.status === 'fulfilled' ? '已领取' : '待领取' })) })).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  },
  redeem(e) {
    if (this.data.busy) return;
    const item = this.data.rewards.find(row => row.id === Number(e.currentTarget.dataset.id));
    if (!item) return;
    wx.showModal({ title: '确认兑换', content: `使用 ${item.points} 积分兑换 ${item.name}？`, success: result => {
      if (!result.confirm) return;
      this.setData({ busy: true });
      api.request(`/rewards/${item.id}/redeem`, { method: 'POST' }).then(() => { wx.showToast({ title: '兑换成功' }); this.load(); }).catch(error => wx.showToast({ title: error.message, icon: 'none' })).finally(() => this.setData({ busy: false }));
    } });
  }
});
