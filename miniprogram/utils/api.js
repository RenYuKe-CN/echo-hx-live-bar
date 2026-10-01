// This bootstrap URL must remain reachable and be included in WeChat's legal
// request domains. The admin-configured URL is fetched from it at launch.
// 微信开发者工具可访问本机 API；真机和正式版应通过后台配置切换到 HTTPS 域名。
const BOOTSTRAP_API_URL = 'https://www.9bar.cn/api';
let API_BASE_URL = wx.getStorageSync('echoApiBaseUrl') || BOOTSTRAP_API_URL;
let userId = 1;
let authToken = wx.getStorageSync('echoAuthToken') || '';
function setUserId(id) { userId = id; }
function login() {
  return new Promise((resolve, reject) => wx.login({ success: result => {
    if (!result.code) return reject(new Error('微信登录未获取到 code'));
    wx.request({ url: API_BASE_URL + '/auth/wechat/login', method: 'POST', data: { code: result.code }, header: { 'content-type': 'application/json' }, success(res) {
      if (res.statusCode >= 200 && res.statusCode < 300 && res.data?.token) { authToken = res.data.token; wx.setStorageSync('echoAuthToken', authToken); return resolve(res.data); }
      const detail = res.data?.message || `微信登录失败（HTTP ${res.statusCode}）`;
      reject(new Error(detail));
    }, fail(error) { reject(new Error(error.errMsg || '无法连接登录接口，请检查 API 地址和微信合法域名')); } });
  }, fail(error) { reject(new Error(error.errMsg || '微信登录调用失败，请确认已在微信开发者工具中启用微信 API')); } }));
}
function refreshApiBaseUrl() { return new Promise(resolve => wx.request({ url: `${BOOTSTRAP_API_URL}/runtime-config`, success(res) { const next = res.data?.apiBaseUrl; if (res.statusCode === 200 && /^(https?:\/\/)/i.test(next)) { API_BASE_URL = next; wx.setStorageSync('echoApiBaseUrl', next); } else if (res.statusCode >= 500) { API_BASE_URL = BOOTSTRAP_API_URL; wx.removeStorageSync('echoApiBaseUrl'); } resolve(API_BASE_URL); }, fail() { API_BASE_URL = BOOTSTRAP_API_URL; wx.removeStorageSync('echoApiBaseUrl'); resolve(API_BASE_URL); } })); }
function request(path, options = {}) { return new Promise((resolve, reject) => { const header = { 'content-type': 'application/json' }; if (authToken) header.authorization = `Bearer ${authToken}`; else if (/localhost|127\.0\.0\.1/i.test(API_BASE_URL)) header['x-demo-user-id'] = String(userId); wx.request({ url: API_BASE_URL + path, method: options.method || 'GET', data: options.data || {}, header, success(res) { if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data); else reject(new Error(res.data?.message || '请求失败')); }, fail: reject }); }); }
function uploadAvatar(filePath) { return new Promise((resolve, reject) => { const header = {}; if (authToken) header.authorization = `Bearer ${authToken}`; else if (/localhost|127\.0\.0\.1/i.test(API_BASE_URL)) header['x-demo-user-id'] = String(userId); wx.uploadFile({ url: API_BASE_URL + '/me/avatar', filePath, name: 'avatar', header, success(res) { let body; try { body = JSON.parse(res.data); } catch { return reject(new Error(`头像上传响应无效（HTTP ${res.statusCode}）`)); } if (res.statusCode === 201 && body.avatarUrl) resolve(body.avatarUrl); else reject(new Error(body.message || `头像上传失败（HTTP ${res.statusCode}）`)); }, fail(error) { reject(new Error(error.errMsg || '头像上传请求失败，请检查 uploadFile 合法域名')); } }); }); }
function imageUrl(path) { return path && path.charAt(0) === '/' ? API_BASE_URL.replace(/\/api$/, '') + path : path; }
module.exports = { request, login, setUserId, imageUrl, uploadAvatar, refreshApiBaseUrl };
