const api = require('./utils/api');
App({
  globalData: { sessionId: null, tableNo: 'A-08', pendingScene: '', tableVersion: 0, user: null },
  onLaunch(options) {
    api.setUserId(1);
    this.apiReady = api.refreshApiBaseUrl().then(() => api.request('/mini-page')).then(page => {
      this.globalData.miniPage = page.entries;
      const appName = page.entries.find(item => item.key === 'app_name')?.title;
      if (appName) wx.setNavigationBarTitle({ title: appName });
      return page;
    }).catch(() => null);
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
