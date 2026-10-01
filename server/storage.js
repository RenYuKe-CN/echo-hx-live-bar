import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getIntegrationValues } from './config.js';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
export const localImageDir = path.join(dataDir, 'uploads');
fs.mkdirSync(localImageDir, { recursive: true });

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encodePath = value => String(value).split('/').map(part => encodeURIComponent(part)).join('/');
const normalizedPrefix = value => {
  const prefix = String(value || 'uploads/').replace(/^\/+|\s+/g, '');
  return prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
};

function storageConfig() {
  const values = getIntegrationValues();
  return {
    provider: String(values.storage_provider || 'local').toLowerCase(),
    endpoint: String(values.storage_endpoint || '').replace(/\/$/, ''),
    region: values.storage_region || 'auto',
    bucket: values.storage_bucket || '',
    accessKey: values.storage_access_key || '',
    secretKey: values.storage_secret_key || '',
    publicBaseUrl: String(values.storage_public_base_url || '').replace(/\/$/, ''),
    prefix: normalizedPrefix(values.storage_path_prefix)
  };
}

export function isObjectStorageEnabled() {
  const config = storageConfig();
  return config.provider !== 'local';
}

function requireObjectStorage() {
  const config = storageConfig();
  const missing = ['storage_endpoint', 'storage_bucket', 'storage_access_key', 'storage_secret_key'].filter(key => !config[{ storage_endpoint: 'endpoint', storage_bucket: 'bucket', storage_access_key: 'accessKey', storage_secret_key: 'secretKey' }[key]]);
  if (config.provider !== 'local' && missing.length) {
    const error = new Error(`对象存储配置不完整：${missing.join('、')}`);
    error.code = 'STORAGE_NOT_CONFIGURED';
    throw error;
  }
  return config;
}

function objectKey(name, config = storageConfig()) {
  return `${config.prefix}${name}`;
}

function objectUrl(name, config = storageConfig()) {
  if (config.publicBaseUrl) return `${config.publicBaseUrl}/${encodePath(objectKey(name, config))}`;
  return objectRequestUrl(name, config);
}

function objectRequestUrl(name, config = storageConfig()) {
  const endpoint = new URL(config.endpoint);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${encodePath(config.bucket)}/${encodePath(objectKey(name, config))}`;
  return endpoint;
}

function signedRequest(method, name, body, contentType) {
  const config = requireObjectStorage();
  const key = objectKey(name, config);
  const url = objectRequestUrl(name, config);
  const host = url.host;
  const payloadHash = hash(body || '');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const service = 's3';
  const canonicalUri = url.pathname;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${config.region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, date), config.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const headers = {
    Host: host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
  if (contentType) headers['Content-Type'] = contentType;
  return { url, headers, body };
}

export function publicUploadUrl(name) {
  const config = storageConfig();
  return config.provider !== 'local' && config.publicBaseUrl
    ? String(objectUrl(name, config))
    : `/api/product-images/${name}`;
}

export function isAllowedImageUrl(value) {
  if (/^\/api\/product-images\/[a-f0-9-]+\.(png|jpg|webp)$/.test(value)) return true;
  const config = storageConfig();
  if (config.provider === 'local' || !config.publicBaseUrl) return false;
  try {
    const candidate = new URL(value);
    const base = new URL(config.publicBaseUrl);
    return candidate.origin === base.origin && candidate.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`);
  } catch {
    return false;
  }
}

export async function saveUpload({ bytes, extension, contentType }) {
  const filename = `${crypto.randomUUID()}.${extension}`;
  const config = storageConfig();
  if (config.provider === 'local') {
    fs.writeFileSync(path.join(localImageDir, filename), bytes);
    return { name: filename, url: publicUploadUrl(filename) };
  }
  const request = signedRequest('PUT', filename, bytes, contentType);
  const response = await fetch(request.url, { method: 'PUT', headers: request.headers, body: request.body });
  if (!response.ok) throw new Error(`对象存储上传失败（HTTP ${response.status}）`);
  return { name: filename, url: publicUploadUrl(filename) };
}

export async function readUpload(name) {
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(name)) return null;
  const localPath = path.join(localImageDir, name);
  if (fs.existsSync(localPath)) return { body: fs.readFileSync(localPath), contentType: contentTypeFor(name) };
  if (!isObjectStorageEnabled()) return null;
  const request = signedRequest('GET', name);
  const response = await fetch(request.url, { headers: request.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`对象存储读取失败（HTTP ${response.status}）`);
  return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || contentTypeFor(name) };
}

export function contentTypeFor(name) {
  return name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
}
