import crypto from 'node:crypto';
import { getIntegrationValues, readPrivateKey, requireIntegration } from '../config.js';

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
  const data = await fetch(url).then(json);
  if (data.errcode || !data.openid) { const error = new Error(data.errmsg || '微信登录失败'); error.code = data.errcode || 'WECHAT_LOGIN_FAILED'; throw error; }
  return data;
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
  const data = await fetch('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi', { method: 'POST', headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'echo-hx-live-bar/1.0' }, body }).then(json);
  if (!data.prepay_id) throw new Error('微信未返回 prepay_id');
  const payTimestamp = Math.floor(Date.now() / 1000).toString();
  const payNonce = crypto.randomBytes(16).toString('hex');
  const payPackage = `prepay_id=${data.prepay_id}`;
  const paySignature = signMessage(`${values.wechat_app_id}\n${payTimestamp}\n${payNonce}\n${payPackage}\n`, privateKey);
  return { prepayId: data.prepay_id, payment: { timeStamp: payTimestamp, nonceStr: payNonce, package: payPackage, signType: 'RSA', paySign: paySignature } };
}

function certificate(value) {
  if (!value) return null;
  return value.includes('BEGIN') ? value.replace(/\\n/g, '\n') : null;
}

export function verifyNotification({ body, timestamp, nonce, signature, serial }) {
  const values = requireIntegration('wechat_api_v3_key');
  const platform = certificate(values.wechat_platform_certificate);
  if (!platform) throw Object.assign(new Error('未配置微信支付平台证书或公钥，无法验签回调'), { code: 'WECHAT_PLATFORM_CERT_MISSING' });
  const verifier = crypto.createVerify('RSA-SHA256').update(`${timestamp}\n${nonce}\n${body}\n`);
  if (!verifier.verify(platform, signature, 'base64')) throw Object.assign(new Error('微信支付回调签名无效'), { code: 'WECHAT_SIGNATURE_INVALID' });
  if (serial && values.wechat_platform_certificate && !values.wechat_platform_certificate.includes(serial)) {
    throw Object.assign(new Error('微信支付回调证书序列号不匹配'), { code: 'WECHAT_SERIAL_MISMATCH' });
  }
  const encrypted = JSON.parse(body);
  const resource = encrypted.resource;
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(values.wechat_api_v3_key), Buffer.from(resource.nonce));
  decipher.setAuthTag(Buffer.from(resource.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(resource.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

export async function queryPayment(orderNo) {
  const values = requireIntegration('wechat_mch_id', 'wechat_merchant_serial', 'wechat_private_key');
  const privateKey = readPrivateKey(values.wechat_private_key);
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(values.wechat_mch_id)}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signMessage(`GET\n${path}\n${timestamp}\n${nonce}\n\n`, privateKey);
  return fetch(`https://api.mch.weixin.qq.com${path}`, { headers: { Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${values.wechat_mch_id}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${values.wechat_merchant_serial}"`, Accept: 'application/json' } }).then(json);
}
