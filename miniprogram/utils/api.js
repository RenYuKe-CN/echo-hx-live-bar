// This bootstrap URL must remain reachable and be included in WeChat's legal
// request domains. The admin-configured URL is fetched from it at launch.
// 微信开发者工具可访问本机 API；真机和正式版应通过后台配置切换到 HTTPS 域名。
const BOOTSTRAP_API_URL = 'https://www.9bar.cn/api';
let API_BASE_URL = wx.getStorageSync('echoApiBaseUrl') || BOOTSTRAP_API_URL;
let userId = 1;
let authToken = wx.getStorageSync('echoAuthToken') || '';
let pendingLogin = null;
function setUserId(id) { userId = id; }
function login() {
  if (pendingLogin) return pendingLogin;
  pendingLogin = new Promise((resolve, reject) => wx.login({ success: result => {
    if (!result.code) return reject(new Error('微信登录未获取到 code'));
    wx.request({ url: API_BASE_URL + '/auth/wechat/login', method: 'POST', data: { code: result.code }, header: { 'content-type': 'application/json' }, success(res) {
      if (res.statusCode >= 200 && res.statusCode < 300 && res.data?.token) { authToken = res.data.token; wx.setStorageSync('echoAuthToken', authToken); return resolve(res.data); }
      const detail = res.data?.message || `微信登录失败（HTTP ${res.statusCode}）`;
      reject(new Error(detail));
    }, fail(error) { reject(new Error(error.errMsg || '无法连接登录接口，请检查 API 地址和微信合法域名')); } });
  }, fail(error) { reject(new Error(error.errMsg || '微信登录调用失败，请确认已在微信开发者工具中启用微信 API')); } })).finally(() => { pendingLogin = null; });
  return pendingLogin;
}
function refreshApiBaseUrl() { return new Promise(resolve => wx.request({ url: `${BOOTSTRAP_API_URL}/runtime-config`, success(res) { const next = res.data?.apiBaseUrl; if (res.statusCode === 200 && /^(https?:\/\/)/i.test(next)) { API_BASE_URL = next; wx.setStorageSync('echoApiBaseUrl', next); } else if (res.statusCode >= 500) { API_BASE_URL = BOOTSTRAP_API_URL; wx.removeStorageSync('echoApiBaseUrl'); } resolve(API_BASE_URL); }, fail() { API_BASE_URL = BOOTSTRAP_API_URL; wx.removeStorageSync('echoApiBaseUrl'); resolve(API_BASE_URL); } })); }
function authHeaders() {
  if (authToken) return { authorization: `Bearer ${authToken}` };
  return /localhost|127\.0\.0\.1/i.test(API_BASE_URL) ? { 'x-demo-user-id': String(userId) } : {};
}
function renewLogin(previousToken) { return authToken !== previousToken ? Promise.resolve() : login(); }
function request(path, options = {}, retried = false) {
  const previousToken = authToken;
  return new Promise((resolve, reject) => wx.request({
    url: API_BASE_URL + path, method: options.method || 'GET', data: options.data || {},
    header: { 'content-type': 'application/json', ...authHeaders() },
    success(res) {
      if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
      if (res.statusCode === 401 && !retried) return renewLogin(previousToken).then(() => request(path, options, true)).then(resolve, reject);
      reject(new Error(res.data?.message || '请求失败'));
    },
    fail(error) { reject(new Error(error.errMsg || '网络请求失败，请稍后重试')); }
  }));
}
function uploadAvatar(filePath, retried = false) {
  const previousToken = authToken;
  return new Promise((resolve, reject) => wx.uploadFile({
    url: API_BASE_URL + '/me/avatar', filePath, name: 'avatar', header: authHeaders(),
    success(res) {
      if (res.statusCode === 401 && !retried) return renewLogin(previousToken).then(() => uploadAvatar(filePath, true)).then(resolve, reject);
      let body;
      try { body = JSON.parse(res.data); } catch { return reject(new Error(`头像上传响应无效（HTTP ${res.statusCode}）`)); }
      if (res.statusCode === 201 && body.avatarUrl) resolve(body.avatarUrl);
      else reject(new Error(body.message || `头像上传失败（HTTP ${res.statusCode}）`));
    },
    fail(error) { reject(new Error(error.errMsg || '头像上传请求失败，请检查 uploadFile 合法域名')); }
  }));
}
async function confirmPayment(orderNo) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await request(`/payments/wechat/${encodeURIComponent(orderNo)}/query`, { method: 'POST' });
      if (result.order?.payment_status === 'paid') return true;
      if (result.order?.payment_status === 'closed') return false;
    } catch { /* Keep the order page available while the server reconciles. */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}
function payWithWechat(payment, orderNo) {
  return new Promise((resolve, reject) => wx.requestPayment({
    ...payment, success: resolve,
    fail(error) { reject(new Error(error.errMsg?.includes('cancel') ? '已取消支付' : '支付未完成')); }
  })).then(() => confirmPayment(orderNo));
}
function imageUrl(path) { return path && path.charAt(0) === '/' ? API_BASE_URL.replace(/\/api$/, '') + path : path; }
module.exports = { request, login, setUserId, imageUrl, uploadAvatar, refreshApiBaseUrl, confirmPayment, payWithWechat };
