import { getIntegrationValues } from './config.js';

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const CODE_URL = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit';
const REQUEST_TIMEOUT = 12000;
let tokenCache = { value: '', expiresAt: 0 };
let tokenRequest = null;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`微信接口返回格式异常（HTTP ${response.status}）`); }
}

export async function getAccessToken() {
  const { wechat_app_id: appId, wechat_app_secret: appSecret } = getIntegrationValues();
  if (!appId || !appSecret) throw new Error('请先在超级管理员后台配置微信小程序 AppID 和 AppSecret');
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
    const response = await fetchWithTimeout(`${TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`);
    const data = await readJson(response);
    if (!response.ok || data.errcode || !data.access_token) throw new Error(`微信 access_token 获取失败：${data.errmsg || `HTTP ${response.status}`}`);
    tokenCache = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 7200) * 1000 };
    return tokenCache.value;
  })();
  try { return await tokenRequest; } finally { tokenRequest = null; }
}

export async function getUnlimitedMiniProgramCode(scene) {
  if (!/^[a-zA-Z0-9:_-]{1,32}$/.test(scene)) throw new Error('桌台二维码场景参数无效');
  const page = 'pages/menu/menu';
  const request = async token => fetchWithTimeout(`${CODE_URL}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scene, page, check_path: false, env_version: process.env.WECHAT_MINIPROGRAM_ENV_VERSION || 'release', width: 430 })
  });
  let token = await getAccessToken();
  let response = await request(token);
  let bytes = Buffer.from(await response.arrayBuffer());
  if (response.headers.get('content-type')?.includes('application/json')) {
    const data = JSON.parse(bytes.toString('utf8'));
    if (data.errcode === 40001 || data.errcode === 42001) {
      tokenCache = { value: '', expiresAt: 0 };
      token = await getAccessToken();
      response = await request(token);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (response.headers.get('content-type')?.includes('application/json')) {
      let error = data;
      try { error = JSON.parse(bytes.toString('utf8')); } catch {}
      throw new Error(`微信小程序码生成失败：${error.errmsg || `HTTP ${response.status}`}`);
    }
  }
  if (!response.ok || bytes.length < 100 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error(`微信小程序码返回异常：HTTP ${response.status}`);
  return bytes;
}
