import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';

// Integration values are read at request time so an admin change takes effect
// without restarting the API. Environment variables remain the preferred
// source for secrets in production and override database values.
export const integrationDefinitions = {
  public_api_base_url: { label: '小程序 API 正式 HTTPS 地址', group: 'miniapp', required: true, secret: false, env: 'MINIPROGRAM_API_BASE_URL' },
  wechat_app_id: { label: '微信小程序 AppID', group: 'wechat', required: true, secret: false, env: 'WECHAT_APP_ID' },
  wechat_app_secret: { label: '微信小程序 AppSecret', group: 'wechat', required: true, secret: true, env: 'WECHAT_APP_SECRET' },
  wechat_mch_id: { label: '微信支付商户号', group: 'wechatPay', required: true, secret: false, env: 'WECHAT_MCH_ID' },
  wechat_api_v3_key: { label: '微信支付 API v3 密钥', group: 'wechatPay', required: true, secret: true, env: 'WECHAT_API_V3_KEY' },
  wechat_merchant_serial: { label: '微信支付商户证书序列号', group: 'wechatPay', required: true, secret: false, env: 'WECHAT_MERCHANT_SERIAL' },
  wechat_private_key: { label: '微信支付商户私钥', group: 'wechatPay', required: true, secret: true, env: 'WECHAT_PRIVATE_KEY' },
  wechat_notify_url: { label: '微信支付回调地址', group: 'wechatPay', required: true, secret: false, env: 'WECHAT_NOTIFY_URL' },
  wechat_platform_certificate: { label: '微信支付平台证书或公钥', group: 'wechatPay', required: true, secret: true, env: 'WECHAT_PLATFORM_CERTIFICATE' },
  meituan_client_id: { label: '美团客户端 ID', group: 'meituan', required: true, secret: false, env: 'MEITUAN_CLIENT_ID' },
  meituan_client_secret: { label: '美团客户端密钥', group: 'meituan', required: true, secret: true, env: 'MEITUAN_CLIENT_SECRET' },
  douyin_client_key: { label: '抖音客户端 Key', group: 'douyin', required: true, secret: false, env: 'DOUYIN_CLIENT_KEY' },
  douyin_client_secret: { label: '抖音客户端密钥', group: 'douyin', required: true, secret: true, env: 'DOUYIN_CLIENT_SECRET' }
};

const readDbValues = () => Object.fromEntries(db.prepare('SELECT key, value FROM integration_settings').all().map(row => [row.key, row.value]));
const envValue = definition => definition.env ? process.env[definition.env] : '';

export function getIntegrationValues() {
  const saved = readDbValues();
  return Object.fromEntries(Object.entries(integrationDefinitions).map(([key, definition]) => [key, String(envValue(definition) || saved[key] || '').trim()]));
}

export function getIntegrationStatus() {
  const values = getIntegrationValues();
  const groups = {};
  for (const [key, definition] of Object.entries(integrationDefinitions)) {
    const group = groups[definition.group] ||= { configured: true, missing: [], label: definition.group };
    if (definition.required && !values[key]) { group.configured = false; group.missing.push(key); }
  }
  return { values, groups };
}

export function readPrivateKey(value) {
  if (!value) return '';
  return value.includes('BEGIN') ? value.replace(/\\n/g, '\n') : fs.readFileSync(path.resolve(value), 'utf8');
}

export function requireIntegration(...keys) {
  const values = getIntegrationValues();
  const missing = keys.filter(key => !values[key]);
  if (missing.length) {
    const error = new Error(`接口尚未配置：${missing.join(', ')}`);
    error.code = 'INTEGRATION_NOT_CONFIGURED';
    error.missing = missing;
    throw error;
  }
  return values;
}
