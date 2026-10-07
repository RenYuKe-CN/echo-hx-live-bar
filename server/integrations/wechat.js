import crypto from 'node:crypto';
import { getIntegrationValues, readPrivateKey, requireIntegration } from '../config.js';

const wechatFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) });

const json = response => response.text().then(text => {
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) { const error = new Error(body.message || body.errmsg || `微信接口请求失败 (${response.status})`); error.status = response.status; error.body = body; throw error; }
  return body;
});

export async function wechatLogin(code) {
  const values = requireIntegration('wechat_app_id', 'wechat_app_secret');
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid: values.wechat_app_id, secret: values.wechat_app_secret, js_code: code, grant_type: 'authorization_code' });
  const data = await wechatFetch(url).then(json);
  if (data.errcode || !data.openid) { const error = new Error(data.errmsg || '微信登录失败'); error.code = data.errcode || 'WECHAT_LOGIN_FAILED'; throw error; }
  return data;
}

let phoneAccessToken = null;
let phoneAccessTokenExpiresAt = 0;
let appAccessToken = null;
let appAccessTokenExpiresAt = 0;
async function getAppAccessToken() {
  const values = requireIntegration('wechat_app_id', 'wechat_app_secret');
  if (!appAccessToken || Date.now() >= appAccessTokenExpiresAt) {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.search = new URLSearchParams({ grant_type: 'client_credential', appid: values.wechat_app_id, secret: values.wechat_app_secret });
    const token = await wechatFetch(url).then(json);
    if (token.errcode || !token.access_token) throw Object.assign(new Error(token.errmsg || '获取微信接口令牌失败'), { code: token.errcode || 'WECHAT_TOKEN_ERROR' });
    appAccessToken = token.access_token;
    appAccessTokenExpiresAt = Date.now() + Math.max(Number(token.expires_in || 7200) - 300, 60) * 1000;
  }
  return appAccessToken;
}
export async function sendSubscribeMessage({ openid, templateId, page = 'pages/member/member', data }) {
  const accessToken = await getAppAccessToken();
  const result = await wechatFetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ touser: openid, template_id: templateId, page, data })
  }).then(json);
  if (result.errcode) {
    if ([40001, 42001].includes(result.errcode)) { appAccessToken = null; appAccessTokenExpiresAt = 0; }
    throw Object.assign(new Error(result.errmsg || '微信订阅消息发送失败'), { code: result.errcode });
  }
  return result;
}
export async function getWechatPhoneNumber(code) {
  const values = requireIntegration('wechat_app_id', 'wechat_app_secret');
  if (!phoneAccessToken || Date.now() >= phoneAccessTokenExpiresAt) {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.search = new URLSearchParams({ grant_type: 'client_credential', appid: values.wechat_app_id, secret: values.wechat_app_secret });
    const token = await wechatFetch(url).then(json);
    if (token.errcode || !token.access_token) throw Object.assign(new Error(token.errmsg || '获取微信接口令牌失败'), { code: token.errcode || 'WECHAT_TOKEN_ERROR' });
    phoneAccessToken = token.access_token;
    phoneAccessTokenExpiresAt = Date.now() + Math.max(Number(token.expires_in || 7200) - 300, 60) * 1000;
  }
  const response = await wechatFetch(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(phoneAccessToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
  }).then(json);
  if (response.errcode || !response.phone_info?.purePhoneNumber) {
    if ([40001, 42001].includes(response.errcode)) { phoneAccessToken = null; phoneAccessTokenExpiresAt = 0; }
    throw Object.assign(new Error(response.errmsg || '微信手机号授权失败'), { code: response.errcode || 'WECHAT_PHONE_ERROR' });
  }
  return response.phone_info;
}

function signMessage(message, privateKey) {
  return crypto.createSign('RSA-SHA256').update(message).end().sign(privateKey, 'base64');
}

export async function createJsapiPayment({ orderNo, description, totalCents, openid }) {
  const values = requireIntegration('wechat_app_id', 'wechat_mch_id', 'wechat_merchant_serial', 'wechat_private_key', 'wechat_notify_url');
  const privateKey = readPrivateKey(values.wechat_private_key);
  const body = JSON.stringify({ appid: values.wechat_app_id, mchid: values.wechat_mch_id, description, out_trade_no: orderNo, notify_url: values.wechat_notify_url, amount: { total: totalCents, currency: 'CNY' }, payer: { openid } });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `POST\n/v3/pay/transactions/jsapi\n${timestamp}\n${nonce}\n${body}\n`;
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${values.wechat_mch_id}",nonce_str="${nonce}",signature="${signMessage(message, privateKey)}",timestamp="${timestamp}",serial_no="${values.wechat_merchant_serial}"`;
  const data = await wechatFetch('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi', { method: 'POST', headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'echo-hx-live-bar/1.0' }, body }).then(json);
  if (!data.prepay_id) throw new Error('微信未返回 prepay_id');
  const payTimestamp = Math.floor(Date.now() / 1000).toString();
  const payNonce = crypto.randomBytes(16).toString('hex');
  const payPackage = `prepay_id=${data.prepay_id}`;
  const paySignature = signMessage(`${values.wechat_app_id}\n${payTimestamp}\n${payNonce}\n${payPackage}\n`, privateKey);
  return { prepayId: data.prepay_id, payment: { timeStamp: payTimestamp, nonceStr: payNonce, package: payPackage, signType: 'RSA', paySign: paySignature } };
}

export function verifyNotification({ body, timestamp, nonce, signature, serial }) {
  const values = requireIntegration('wechat_api_v3_key');
  const failure = (message, code) => Object.assign(new Error(message), { code });
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !nonce || !signature || !serial) {
    throw failure('微信支付回调签名头缺失或时间戳已过期', 'WECHAT_SIGNATURE_INVALID');
  }
  if (!values.wechat_platform_certificate) throw failure('未配置微信支付平台证书或公钥，无法验签回调', 'WECHAT_PLATFORM_CERT_MISSING');
  const platform = readPrivateKey(values.wechat_platform_certificate);
  const x509 = platform.includes('BEGIN CERTIFICATE') ? new crypto.X509Certificate(platform) : null;
  const expectedSerial = x509 ? x509.serialNumber : values.wechat_platform_serial;
  if (!expectedSerial) throw failure('使用微信支付公钥时须配置对应的公钥 ID', 'WECHAT_PLATFORM_SERIAL_MISSING');
  const normalizeSerial = value => String(value).replaceAll(':', '').replace(/^0+(?=[0-9a-f])/i, '').toUpperCase();
  if (normalizeSerial(serial) !== normalizeSerial(expectedSerial)) {
    throw Object.assign(new Error('微信支付回调证书序列号不匹配'), { code: 'WECHAT_SERIAL_MISMATCH' });
  }
  const verifier = crypto.createVerify('RSA-SHA256').update(`${timestamp}\n${nonce}\n${body}\n`);
  if (!verifier.verify(x509 ? x509.publicKey : platform, signature, 'base64')) throw failure('微信支付回调签名无效', 'WECHAT_SIGNATURE_INVALID');
  const encrypted = JSON.parse(body);
  const resource = encrypted.resource;
  if (resource?.algorithm !== 'AEAD_AES_256_GCM' || typeof resource.ciphertext !== 'string' || typeof resource.nonce !== 'string') {
    throw failure('微信支付回调加密格式无效', 'WECHAT_RESOURCE_INVALID');
  }
  const ciphertext = Buffer.from(resource.ciphertext, 'base64');
  if (ciphertext.length <= 16 || Buffer.byteLength(values.wechat_api_v3_key) !== 32) throw failure('微信支付回调密文或 API v3 密钥无效', 'WECHAT_RESOURCE_INVALID');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(values.wechat_api_v3_key), Buffer.from(resource.nonce));
  decipher.setAuthTag(ciphertext.subarray(-16));
  decipher.setAAD(Buffer.from(resource.associated_data || ''));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

export async function queryPayment(orderNo) {
  const values = requireIntegration('wechat_mch_id', 'wechat_merchant_serial', 'wechat_private_key');
  const privateKey = readPrivateKey(values.wechat_private_key);
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(values.wechat_mch_id)}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signMessage(`GET\n${path}\n${timestamp}\n${nonce}\n\n`, privateKey);
  try {
    return await wechatFetch(`https://api.mch.weixin.qq.com${path}`, { headers: { Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${values.wechat_mch_id}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${values.wechat_merchant_serial}"`, Accept: 'application/json' } }).then(json);
  } catch (error) {
    // 微信商户侧可能已经清理了未支付交易。这个状态不是网络故障，
    // 调用方可以据此释放本地订单占用的余额、优惠券和购物车商品。
    if (error.status === 404) error.code = 'WECHAT_ORDER_NOT_FOUND';
    throw error;
  }
}

export async function closePayment(orderNo) {
  const values = requireIntegration('wechat_mch_id', 'wechat_merchant_serial', 'wechat_private_key');
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`;
  const body = JSON.stringify({ mchid: values.wechat_mch_id });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signMessage(`POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`, readPrivateKey(values.wechat_private_key));
  return wechatFetch(`https://api.mch.weixin.qq.com${path}`, { method: 'POST', headers: {
    Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${values.wechat_mch_id}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${values.wechat_merchant_serial}"`,
    Accept: 'application/json', 'Content-Type': 'application/json'
  }, body }).then(json);
}

export async function createRefund({ outTradeNo, outRefundNo, reason, refundCents, totalCents }) {
  const values = requireIntegration('wechat_mch_id', 'wechat_merchant_serial', 'wechat_private_key');
  const path = '/v3/refund/domestic/refunds';
  const notifyUrl = values.wechat_refund_notify_url || (values.wechat_notify_url ? new URL('refund/notify', values.wechat_notify_url).href : undefined);
  const body = JSON.stringify({ out_trade_no: outTradeNo, out_refund_no: outRefundNo, reason, notify_url: notifyUrl, amount: { refund: refundCents, total: totalCents, currency: 'CNY' } });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signMessage(`POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`, readPrivateKey(values.wechat_private_key));
  return wechatFetch(`https://api.mch.weixin.qq.com${path}`, { method: 'POST', headers: {
    Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${values.wechat_mch_id}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${values.wechat_merchant_serial}"`,
    Accept: 'application/json', 'Content-Type': 'application/json'
  }, body }).then(json);
}

export async function queryRefund(outRefundNo) {
  const values = requireIntegration('wechat_mch_id', 'wechat_merchant_serial', 'wechat_private_key');
  const path = `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signMessage(`GET\n${path}\n${timestamp}\n${nonce}\n\n`, readPrivateKey(values.wechat_private_key));
  return wechatFetch(`https://api.mch.weixin.qq.com${path}`, { headers: {
    Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${values.wechat_mch_id}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${values.wechat_merchant_serial}"`, Accept: 'application/json'
  } }).then(json);
}
