const api = require('../../utils/api');

Page({
  data: { user: {}, membership: {}, progressPercent: 0 },
  onShow() {
    api.request('/me').then(profile => {
      const membership = profile.membership || {};
      const progressPercent = Math.round(Number(membership.progress || 0) * 100);
      this.setData({ user: profile.user || {}, membership, progressPercent });
    }).catch(error => wx.showToast({ title: error.message, icon: 'none' }));
  }
});
