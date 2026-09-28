// This bootstrap URL must remain reachable and be included in WeChat's legal
// request domains. The admin-configured URL is fetched from it at launch.
const BOOTSTRAP_API_URL = 'http://localhost:3001/api';
let API_BASE_URL = wx.getStorageSync('echoApiBaseUrl') || BOOTSTRAP_API_URL;
let userId = 1;
function setUserId(id) { userId = id; }
function refreshApiBaseUrl() { return new Promise(resolve => wx.request({ url: `${BOOTSTRAP_API_URL}/runtime-config`, success(res) { const next = res.data?.apiBaseUrl; if (res.statusCode === 200 && /^https:\/\//i.test(next)) { API_BASE_URL = next; wx.setStorageSync('echoApiBaseUrl', next); } resolve(API_BASE_URL); }, fail() { resolve(API_BASE_URL); } })); }
function request(path, options = {}) { return new Promise((resolve, reject) => { wx.request({ url: API_BASE_URL + path, method: options.method || 'GET', data: options.data || {}, header: { 'content-type': 'application/json', 'x-demo-user-id': String(userId) }, success(res) { if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data); else reject(new Error(res.data.message || '请求失败')); }, fail: reject }); }); }
function imageUrl(path) { return path && path.charAt(0) === '/' ? API_BASE_URL.replace(/\/api$/, '') + path : path; }
module.exports = { request, setUserId, imageUrl, refreshApiBaseUrl };
