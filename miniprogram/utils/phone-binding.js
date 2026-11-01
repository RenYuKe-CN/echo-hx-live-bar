const api = require('./api');
let pendingPrompt = null;

function promptPhoneBinding() {
  if (pendingPrompt) return pendingPrompt;
  pendingPrompt = new Promise(resolve => wx.showModal({
    title: '下单前请绑定手机号',
    content: '手机号用于查询订单和处理售后。绑定后返回继续操作，已选商品会保留。',
    confirmText: '去绑定', cancelText: '暂不绑定',
    success: result => {
      if (!result.confirm) return resolve(false);
      wx.navigateTo({ url: '/pages/profile/profile?focus=phone',
        fail: () => wx.showToast({ title: '绑定页面打开失败，请重试', icon: 'none' }),
        complete: () => resolve(false)
      });
    },
    fail: () => resolve(false)
  })).finally(() => { pendingPrompt = null; });
  return pendingPrompt;
}

async function ensureOrderPhone() {
  // Read the current account: a cached profile cannot authorize an order.
  const { user } = await api.request('/me');
  getApp().globalData.user = user;
  getApp().globalData.profileComplete = Boolean(user?.phone && user?.avatarUrl && user?.nickname && user.nickname !== '微信用户');
  if (/^1[3-9]\d{9}$/.test(user?.phone || '')) return true;
  return promptPhoneBinding();
}

function handleOrderError(error) {
  if (error.code === 'PHONE_BINDING_REQUIRED') return promptPhoneBinding();
  wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' });
}

function phoneAuthorizationError(detail = '') {
  if (/no permission/i.test(detail)) return '当前小程序暂未获得微信手机号授权接口权限，请联系门店管理员检查微信平台配置。';
  if (/deny|cancel/i.test(detail)) return '你没有同意手机号授权，可以点击按钮重新授权';
  return '未获得手机号授权，请稍后重试；仍无法绑定时请联系门店工作人员。';
}
module.exports = { ensureOrderPhone, handleOrderError, phoneAuthorizationError };
