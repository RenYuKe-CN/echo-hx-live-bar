const api = require('./utils/api');
App({
  globalData: { sessionId: null, tableNo: 'A-08', user: null },
  onLaunch() { const scene = wx.getLaunchOptionsSync().query || {}; if (scene.table) this.globalData.tableNo = scene.table; api.setUserId(1); api.refreshApiBaseUrl(); }
});
