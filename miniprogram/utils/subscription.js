const api = require('./api');

// 微信订阅授权必须由用户点击触发，不能在 onHide/onUnload 中自动弹窗。
// 统一封装模板读取和授权回传，会员页与消息中心共用同一套逻辑。
function loadTemplates() {
  return api.request('/message-subscription-templates').then(({ templates }) =>
    (templates || []).filter(item => item.wechatTemplateId).slice(0, 3)
  );
}

function getSubscriptionSettings() {
  return new Promise(resolve => {
    if (typeof wx.getSetting !== 'function') return resolve({});
    wx.getSetting({
      withSubscriptions: true,
      success: result => resolve(result.subscriptionsSetting || {}),
      fail: () => resolve({})
    });
  });
}

function needsAuthorization(templates, settings) {
  return templates.some(item => settings[item.wechatTemplateId] !== 'accept');
}

function requestAuthorization(templates) {
  if (!templates.length) return Promise.reject(new Error('商家暂未配置微信订阅消息模板'));
  return new Promise((resolve, reject) => wx.requestSubscribeMessage({
    tmplIds: templates.map(item => item.wechatTemplateId),
    success: result => resolve(result),
    fail: reject
  })).then(result => api.request('/me/subscription-authorizations', {
    method: 'POST',
    data: {
      authorizations: templates.map(item => ({
        templateKey: item.templateKey,
        wechatTemplateId: item.wechatTemplateId,
        status: result[item.wechatTemplateId] || 'reject'
      }))
    }
  }).then(() => result));
}

function promptKey(userId) {
  return `echoSubscribePromptShown:${userId || 'current'}`;
}

function hasShownPrompt(userId) {
  return wx.getStorageSync(promptKey(userId)) === '1';
}

function markPromptShown(userId) {
  wx.setStorageSync(promptKey(userId), '1');
}

function clearPromptShown(userId) {
  wx.removeStorageSync(promptKey(userId));
}

module.exports = {
  loadTemplates,
  getSubscriptionSettings,
  needsAuthorization,
  requestAuthorization,
  hasShownPrompt,
  markPromptShown,
  clearPromptShown
};
