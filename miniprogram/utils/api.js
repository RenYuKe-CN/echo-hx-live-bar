const API_BASE_URL = 'http://localhost:3001/api';
let userId = 1;
function setUserId(id) { userId = id; }
function request(path, options = {}) { return new Promise((resolve, reject) => { wx.request({ url: API_BASE_URL + path, method: options.method || 'GET', data: options.data || {}, header: { 'content-type': 'application/json', 'x-demo-user-id': String(userId) }, success(res) { if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data); else reject(new Error(res.data.message || '请求失败')); }, fail: reject }); }); }
function imageUrl(path) { return path && path.charAt(0) === '/' ? API_BASE_URL.replace(/\/api$/, '') + path : path; }
module.exports = { request, setUserId, imageUrl };
