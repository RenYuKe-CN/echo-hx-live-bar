const api = require('./utils/api');
App({
  globalData: { sessionId: null, tableNo: 'A-08', pendingScene: '', pendingCouponId: '', pendingCouponMode: '', tableVersion: 0, user: null },
  onLaunch(options) {
    api.setUserId(1);
    this.apiReady = api.refreshApiBaseUrl().then(() => api.login()).then(login => { this.globalData.user = login.user; return Promise.all([api.request('/mini-page'), api.request('/me')]); }).then(([page, profile]) => {
      this.globalData.miniPage = page.entries;
      this.globalData.user = profile.user;
      this.globalData.profileComplete = Boolean(profile.user.phone && profile.user.avatarUrl && profile.user.nickname && profile.user.nickname !== '微信用户');
      const appName = page.entries.find(item => item.key === 'app_name')?.title;
      if (appName) wx.setNavigationBarTitle({ title: appName });
      return page;
    }).catch(error => {
      this.globalData.loginError = error.message;
      wx.showToast({ title: error.message, icon: 'none', duration: 3500 });
      throw error;
    });
    this.applyLaunchOptions(options || wx.getLaunchOptionsSync());
  },
  onShow(options) { this.applyLaunchOptions(options); },
  applyLaunchOptions(options = {}) {
    const query = options.query || {};
    if (query.scene) {
      let scene = query.scene;
      try { scene = decodeURIComponent(scene); } catch {}
      if (scene !== this.globalData.pendingScene) {
        this.globalData.pendingScene = scene;
        this.globalData.sessionId = null;
        this.globalData.tableVersion++;
      }
    } else if (query.table && query.table !== this.globalData.tableNo) {
      this.globalData.pendingScene = '';
      this.globalData.tableNo = query.table;
      this.globalData.sessionId = null;
      this.globalData.tableVersion++;
    }
  }
});
