import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Router } from 'express';
import multer from 'multer';
import { db, centsToMoney } from './db.js';
import { getIntegrationStatus, integrationDefinitions } from './config.js';
import { getUnlimitedMiniProgramCode, miniProgramCodeContentType } from './wechat-mini-code.js';
import { wechatLogin, getWechatPhoneNumber, createJsapiPayment, verifyNotification, queryPayment, closePayment, sendSubscribeMessage } from './integrations/wechat.js';
import { localImageDir, saveUpload, readUpload, isAllowedImageUrl } from './storage.js';
import { getBirthdayMatchInfo, normalizeBirthday } from './birthday.js';
import { backupSettings, listBackups, createBackup, restoreBackup, backupFile } from './backup.js';
import { beginRestore, endRestore } from './maintenance.js';

export const router = Router();
const backupUploadDir = path.resolve(process.env.DATA_DIR || 'data', '.backup-uploads');
fs.mkdirSync(backupUploadDir, { recursive: true });
const backupUpload = multer({
  storage: multer.diskStorage({
    destination: backupUploadDir,
    filename: (_req, _file, callback) => callback(null, `restore-${crypto.randomUUID()}.tar.gz`)
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype === 'application/gzip' || file.mimetype === 'application/x-gzip' || file.originalname.endsWith('.tar.gz'))
});
const PAYMENT_EXPIRY_MS = 10 * 60 * 1000;
const orderCreatedAt = order => {
  if (!order?.created_at) return null;
  const value = String(order.created_at).includes('T') ? String(order.created_at) : `${String(order.created_at).replace(' ', 'T')}Z`;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};
const orderExpiryAt = order => order?.payment_expire_at || (orderCreatedAt(order) ? new Date(orderCreatedAt(order) + PAYMENT_EXPIRY_MS).toISOString() : null);
const currentUserId = req => req.user?.id || (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEMO_USER !== 'false' ? Number(req.header('x-demo-user-id') || 1) : 0);
const todayLocalDate = () => db.prepare("SELECT date('now', 'localtime') AS day").get().day;
const parsePagination = (req, prefix = '') => {
  const pageKey = prefix ? `${prefix}Page` : 'page';
  const sizeKey = prefix ? `${prefix}PageSize` : 'pageSize';
  const requestedPage = Math.max(1, Number.parseInt(req.query[pageKey] || '1', 10) || 1);
  const requestedSize = Number.parseInt(req.query[sizeKey] || '20', 10) || 20;
  const pageSize = requestedSize === 50 ? 50 : 20;
  return { page: requestedPage, pageSize, offset: (requestedPage - 1) * pageSize };
};
const paginationView = (page, pageSize, total) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  return { page: safePage, pageSize, total, totalPages, hasNext: safePage < totalPages, hasPrevious: safePage > 1 };
};
const modules = ['dashboard','pos','orders','tables','members','storage','group-buy','products','wallet','rewards','coupons','messages','reports','losses','backups'];
const hashPassword = password => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; };
const verifyPassword = (password, stored) => { const [salt, hash] = stored.split(':'); const supplied = crypto.scryptSync(password, salt, 64); return hash?.length === 128 && crypto.timingSafeEqual(supplied, Buffer.from(hash, 'hex')); };
const normalizePermissions = permissions => [...new Set(permissions.map(permission => permission === 'inventory' ? 'products' : permission).filter(permission => modules.includes(permission) && permission !== 'reports'))];
const publicAccount = row => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, permissions: row.role === 'super' ? [...modules, 'accounts', 'settings', 'logs', 'mini-page'] : normalizePermissions(JSON.parse(row.permissions)), status: row.status });
const audit = (req, action, detail = '') => db.prepare('INSERT INTO operation_logs (operator, action, detail) VALUES (?, ?, ?)').run(req.staff.username, action, String(detail));
const syncProductAvailability = () => {
  db.prepare("UPDATE products SET status = 'inactive', auto_unlisted = 1 WHERE stock - reserved_stock <= 0 AND status = 'active'").run();
  db.prepare("UPDATE products SET status = 'active', auto_unlisted = 0 WHERE stock - reserved_stock > 0 AND status = 'inactive' AND auto_unlisted = 1").run();
};
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = row => {
  const tier = row.member_tier_id ? db.prepare('SELECT badge_color FROM member_tiers WHERE id = ?').get(row.member_tier_id) : null;
  return { id: row.id, nickname: row.nickname, phone: row.phone, avatarUrl: row.avatar_url, memberLevel: row.member_level, memberTierId: row.member_tier_id, memberColor: tier?.badge_color || '#C77F52', points: row.points, memberExpiresAt: row.member_expires_at, birthdayType: row.birthday_type || '', birthdayDate: row.birthday_date || '' };
};

router.post('/auth/wechat/login', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code || code.length > 256) return res.status(400).json({ message: '微信登录 code 无效' });
  try {
    const result = await wechatLogin(code);
    let user = db.prepare('SELECT * FROM users WHERE wechat_openid = ?').get(result.openid);
    if (!user) {
      const id = db.prepare('INSERT INTO users (nickname, wechat_openid) VALUES (?, ?)').run('微信用户', result.openid).lastInsertRowid;
      db.prepare('INSERT INTO wallet_accounts (user_id) VALUES (?)').run(id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO wechat_sessions (token_hash, user_id, openid, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(openid) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at').run(tokenHash(token), user.id, result.openid, new Date(Date.now() + 30 * 86400000).toISOString());
    res.json({ token, user: publicUser(user) });
  } catch (error) { res.status(error.status || 503).json({ message: error.message, code: error.code || 'WECHAT_LOGIN_ERROR' }); }
});

router.use((req, _res, next) => {
  const bearer = req.header('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (bearer) req.user = db.prepare("SELECT u.* FROM wechat_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?").get(tokenHash(bearer), new Date().toISOString());
  next();
});
// These routes are declared before the broad /me middleware below because the
// notification and coupon APIs are kept near their supporting helpers. Keep
// their authentication explicit so production requests cannot use the demo
// user fallback accidentally.
const requireWechatUser = (req, res, next) => {
  const demoAllowed = process.env.NODE_ENV !== 'production' && currentUserId(req) > 0;
  if (!req.user && !demoAllowed) return res.status(401).json({ message: '请先完成微信登录' });
  next();
};
router.get('/auth/me', (req, res) => req.user ? res.json({ user: publicUser(req.user) }) : res.status(401).json({ message: '请先完成微信登录' }));

router.post('/admin/login', (req, res) => {
  const account = db.prepare("SELECT * FROM staff_accounts WHERE username = ? AND status = 'active'").get(String(req.body?.username || '').trim());
  if (!account || !verifyPassword(String(req.body?.password || ''), account.password_hash)) return res.status(401).json({ message: '账号或密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO staff_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), account.id, new Date(Date.now() + 12 * 3600000).toISOString());
  db.prepare('INSERT INTO operation_logs (operator, action, detail) VALUES (?, ?, ?)').run(account.username, '登录后台', '');
  res.json({ token, account: publicAccount(account) });
});
router.use('/admin', (req, res, next) => {
  const token = req.header('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const row = token && db.prepare("SELECT a.* FROM staff_sessions s JOIN staff_accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ? AND a.status = 'active'").get(crypto.createHash('sha256').update(token).digest('hex'), new Date().toISOString());
  if (!row) return res.status(401).json({ message: '请先登录管理后台' });
  req.staff = row;
  const segment = req.path.split('/')[1];
  const section = ({ summary: 'dashboard', 'wallet-packages': 'wallet', 'member-rules': 'members', 'member-tiers': 'members', categories: 'products', 'session': null, 'logout': null, 'change-password': null })[segment] ?? segment;
  if (['session','logout','change-password'].includes(segment)) return next();
  const allowed = row.role === 'super' || JSON.parse(row.permissions).includes(section);
  if (!allowed) return res.status(403).json({ message: '当前账号没有此模块权限' });
  if (['backups', 'reports'].includes(section) && row.role !== 'super') return res.status(403).json({ message: '仅超级管理员可访问此模块' });
  if (req.method !== 'GET' && row.role !== 'super') {
    const managerOnly = ['accounts','settings','logs'];
    if (managerOnly.includes(section)) return res.status(403).json({ message: '仅超级管理员可修改此模块' });
  }
  next();
});
router.get('/admin/session', (req, res) => res.json({ account: publicAccount(req.staff) }));
router.post('/admin/logout', (req, res) => { db.prepare('DELETE FROM staff_sessions WHERE account_id = ?').run(req.staff.id); res.json({ ok: true }); });
router.post('/admin/change-password', (req, res) => {
  if (!verifyPassword(String(req.body?.oldPassword || ''), req.staff.password_hash) || String(req.body?.newPassword || '').length < 10) return res.status(400).json({ message: '原密码错误，或新密码少于 10 位' });
  db.prepare('UPDATE staff_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.newPassword), req.staff.id);
  audit(req, '修改密码'); res.json({ ok: true });
});
router.get('/admin/accounts', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const total = db.prepare('SELECT COUNT(*) AS value FROM staff_accounts').get().value; return res.json({ accounts: db.prepare('SELECT * FROM staff_accounts ORDER BY id LIMIT ? OFFSET ?').all(pageSize, offset).map(publicAccount), modules: modules.filter(module => module !== 'reports'), pagination: paginationView(page, pageSize, total) }); });
router.post('/admin/accounts', (req, res) => {
  const { username, displayName, password, role, permissions = [] } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username || '') || String(password || '').length < 10 || !['manager','staff'].includes(role) || !Array.isArray(permissions) || permissions.some(p => !modules.includes(p) || p === 'reports')) return res.status(400).json({ message: '账号、密码或权限无效（数据报表仅超管可见，密码至少 10 位）' });
  try { const r = db.prepare('INSERT INTO staff_accounts (username, display_name, password_hash, role, permissions) VALUES (?, ?, ?, ?, ?)').run(username, String(displayName || username), hashPassword(password), role, JSON.stringify(permissions)); audit(req, '创建账号', username); res.status(201).json({ account: publicAccount(db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(r.lastInsertRowid)) }); }
  catch (error) { res.status(409).json({ message: '账号名已存在' }); }
});
router.patch('/admin/accounts/:id', (req, res) => {
  const account = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(req.params.id);
  if (!account || account.role === 'super') return res.status(400).json({ message: '不可修改超级管理员账号' });
  const { role = account.role, status = account.status, permissions = JSON.parse(account.permissions), password, displayName = account.display_name } = req.body || {};
  if (!['manager','staff'].includes(role) || !['active','disabled'].includes(status) || !Array.isArray(permissions) || permissions.some(p => !modules.includes(p) || p === 'reports') || (password && String(password).length < 10)) return res.status(400).json({ message: '账号配置无效（数据报表仅超级管理员可见）' });
  db.prepare('UPDATE staff_accounts SET role = ?, status = ?, permissions = ?, display_name = ?, password_hash = ? WHERE id = ?').run(role, status, JSON.stringify(permissions.filter(p => p !== 'reports')), displayName, password ? hashPassword(password) : account.password_hash, account.id);
  if (status === 'disabled' || password) db.prepare('DELETE FROM staff_sessions WHERE account_id = ?').run(account.id);
  audit(req, '修改账号', account.username); res.json({ ok: true });
});
router.post('/admin/accounts/:id/reset-password', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可重置账号密码' });
  const account = db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(req.params.id);
  if (!account || account.role === 'super') return res.status(400).json({ message: '只能重置管理员或店员账号密码' });
  const password = String(req.body?.password || '');
  if (password.length < 10) return res.status(400).json({ message: '新密码至少需要 10 位' });
  db.prepare('UPDATE staff_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(password), account.id);
  db.prepare('DELETE FROM staff_sessions WHERE account_id = ?').run(account.id);
  audit(req, '重置账号密码', account.username);
  res.json({ ok: true });
});
router.get('/admin/logs', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const total = db.prepare('SELECT COUNT(*) AS value FROM operation_logs').get().value; return res.json({ logs: db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset), pagination: paginationView(page, pageSize, total) }); });
router.get('/admin/backups', (_req, res) => res.json({ settings: backupSettings(), backups: listBackups() }));
router.post('/admin/backups', async (req, res) => {
  try {
    const result = await createBackup();
    audit(req, '创建数据备份', result.name);
    res.status(201).json({ backup: { ...result, createdAt: new Date().toISOString() } });
  } catch (error) { res.status(409).json({ message: error.message }); }
});
router.patch('/admin/backups/settings', (req, res) => {
  const body = req.body || {};
  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' ? 1 : body.enabled === false || body.enabled === 0 || body.enabled === '0' ? 0 : null;
  const frequency = String(body.frequency || '');
  const runTime = String(body.runTime || '');
  const retentionDays = Number(body.retentionDays);
  if (enabled === null || !['daily', 'weekly'].includes(frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(runTime) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    return res.status(400).json({ message: '定时备份配置无效，请检查开关、频率、执行时间和保留天数' });
  }
  db.prepare('UPDATE backup_settings SET enabled = ?, frequency = ?, run_time = ?, retention_days = ? WHERE id = 1').run(enabled, frequency, runTime, retentionDays);
  audit(req, '更新备份计划', `${enabled ? '开启' : '关闭'} ${frequency} ${runTime}，保留 ${retentionDays} 天`);
  res.json({ settings: backupSettings() });
});
router.get('/admin/backups/:name/download', (req, res) => {
  const file = backupFile(req.params.name);
  if (!file) return res.status(404).json({ message: '备份文件不存在' });
  res.download(file, req.params.name, error => { if (error && !res.headersSent) res.status(500).json({ message: '备份下载失败' }); });
});
router.post('/admin/backups/restore', (req, res) => {
  backupUpload.single('backup')(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: error.message || '备份文件上传失败' });
    if (!req.file) return res.status(400).json({ message: '请选择 .tar.gz 备份文件' });
    let locked = false;
    try {
      await beginRestore();
      locked = true;
      const result = await restoreBackup(req.file.path);
      audit(req, '恢复数据备份', `${req.file.originalname}，安全备份 ${result.safetyBackup}`);
      res.json(result);
    } catch (restoreError) { res.status(400).json({ message: restoreError.message }); }
    finally { if (locked) endRestore(); fs.rmSync(req.file.path, { force: true }); }
  });
});
router.get('/admin/settings', (_req, res) => {
  const status = getIntegrationStatus();
  res.json({ settings: Object.entries(integrationDefinitions).map(([key, definition]) => ({ key, label: definition.label, value: definition.secret && status.values[key] ? '' : status.values[key], configured: Boolean(status.values[key]), secret: definition.secret, source: process.env[definition.env] ? 'environment' : 'admin' })), groups: status.groups, integrationsActive: false });
});
router.post('/admin/products/image', express.raw({ type: ['image/png','image/jpeg','image/webp'], limit: '5mb' }), async (req, res) => {
  const type = req.header('content-type')?.split(';')[0];
  const bytes = req.body;
  const extension = type === 'image/png' && bytes?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' : type === 'image/jpeg' && bytes?.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpg' : type === 'image/webp' && bytes?.subarray(0, 4).toString() === 'RIFF' && bytes?.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!extension) return res.status(400).json({ message: '仅支持 PNG、JPEG、WebP 图片，最大 5MB' });
  try {
    const upload = await saveUpload({ bytes, extension, contentType: type });
    audit(req, '上传商品图片', upload.name);
    res.status(201).json({ imageUrl: upload.url });
  } catch (error) { res.status(error.code === 'STORAGE_NOT_CONFIGURED' ? 503 : 502).json({ message: error.message }); }
});
router.get('/product-images/:name', async (req, res) => {
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(req.params.name)) return res.sendStatus(404);
  try {
    const upload = await readUpload(req.params.name);
    if (!upload) return res.sendStatus(404);
    res.type(upload.contentType).send(upload.body);
  } catch (error) { res.status(502).json({ message: error.message }); }
});
router.put('/admin/settings', (req, res) => {
  const values = req.body || {};
  if (Object.keys(values).some(key => !Object.hasOwn(integrationDefinitions, key))) return res.status(400).json({ message: '包含未知配置项' });
  db.transaction(() => Object.entries(values).forEach(([key, value]) => {
    const text = String(value ?? '').trim();
    if (text && !process.env[integrationDefinitions[key].env]) db.prepare('INSERT INTO integration_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(key, text);
  }))();
  audit(req, '更新接口配置', Object.keys(values).join(','));
  const status = getIntegrationStatus();
  res.json({ ok: true, integrationsActive: Boolean(status.groups.wechat?.configured && status.groups.wechatPay?.configured), groups: status.groups });
});
router.post('/admin/settings/check', (_req, res) => {
  const status = getIntegrationStatus();
  const checks = Object.fromEntries(Object.entries(status.groups).map(([group, value]) => [group, { status: value.configured ? 'ready_for_auth' : 'missing_config', missing: value.missing }]));
  res.json({ ok: true, checks, integrationsActive: Boolean(status.groups.wechat?.configured && status.groups.wechatPay?.configured), message: '配置完整性检查完成；美团和抖音仍需平台授权后进行真实券码联调' });
});

function renderMessageTemplate(template, values = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => String(values[key] ?? ''));
}
function createSiteMessage(userId, type, values = {}, relatedType = null, relatedId = null) {
  const template = db.prepare('SELECT * FROM message_templates WHERE template_key = ? AND enabled = 1').get(type) || db.prepare("SELECT * FROM message_templates WHERE template_key = 'system_notice' AND enabled = 1").get();
  if (!template) return null;
  const title = renderMessageTemplate(template.title_template, values);
  const content = renderMessageTemplate(template.content_template, values);
  return db.prepare('INSERT INTO user_messages (user_id, type, title, content, related_type, related_id) VALUES (?, ?, ?, ?, ?, ?)').run(userId, type, title, content, relatedType, relatedId).lastInsertRowid;
}
function queueUserMessage(userId, type, values = {}, relatedType = null, relatedId = null, campaignName = '') {
  if (!userId) return null;
  if (relatedType && relatedId != null) {
    const existing = db.prepare(`SELECT id FROM user_messages
      WHERE user_id = ? AND type = ? AND related_type = ? AND related_id = ? LIMIT 1`)
      .get(userId, type, relatedType, relatedId);
    if (existing) return existing.id;
  }
  const template = db.prepare('SELECT * FROM message_templates WHERE template_key = ? AND enabled = 1').get(type) || db.prepare("SELECT * FROM message_templates WHERE template_key = 'system_notice' AND enabled = 1").get();
  const messageId = createSiteMessage(userId, type, values, relatedType, relatedId);
  if (!template || !messageId) return null;
  const campaignId = db.prepare('INSERT INTO message_campaigns (name, message_template_id, audience_type, audience_filter, status) VALUES (?, ?, ?, ?, ?)')
    .run(campaignName || template.name, template.id, 'selected', JSON.stringify({ userIds: [userId], event: type }), 'sent').lastInsertRowid;
  db.prepare('INSERT INTO message_recipients (campaign_id, user_id, channel, status, sent_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
    .run(campaignId, userId, 'site', 'sent');
  // Site delivery is synchronous. WeChat is best-effort and must never delay or
  // roll back the business transaction if the user did not authorize a template.
  setImmediate(() => queueWechatCampaign(campaignId, template, [{ id: userId }], values).catch(error => console.error('微信订阅消息发送失败', error)));
  return messageId;
}
function couponUserView(row) {
  const definition = couponDefinitionView(row);
  const now = Date.now();
  const startsAt = row.valid_from ? new Date(row.valid_from).getTime() : 0;
  const expiresAt = row.expired_at || row.valid_until ? new Date(row.expired_at || row.valid_until).getTime() : 0;
  const expired = Boolean(expiresAt && Number.isFinite(expiresAt) && expiresAt <= now);
  const notStarted = Boolean(startsAt && Number.isFinite(startsAt) && startsAt > now);
  const definitionStatus = row.definition_status || definition.status;
  const status = definitionStatus === 'inactive'
    ? 'cancelled'
    : expired && row.status === 'available' ? 'expired' : row.status;
  return {
    ...definition,
    id: row.id,
    couponCode: row.coupon_code,
    definitionStatus,
    status,
    usable: status === 'available' && !notStarted,
    notStarted,
    issuedAt: row.issued_at,
    usedAt: row.used_at,
    expiredAt: row.expired_at || row.valid_until
  };
}

function availableCouponCount(userId) {
  const rows = db.prepare(`SELECT uc.*, cd.name, cd.type, cd.amount_cents, cd.discount_rate, cd.min_order_cents, cd.product_id, cd.category_id,
    cd.member_tier_id, cd.voucher_type, cd.gift_product_id, cd.total_quantity, cd.issued_quantity, cd.per_user_limit, cd.valid_from, cd.valid_until, cd.icon_url, cd.description, cd.status AS definition_status,
    gift.name AS gift_product_name, gift.image_url AS gift_product_image, gift.price_cents AS gift_product_price_cents
    FROM user_coupons uc JOIN coupon_definitions cd ON cd.id = uc.coupon_definition_id
    LEFT JOIN products gift ON gift.id = cd.gift_product_id
    WHERE uc.user_id = ? AND uc.status = 'available'`).all(userId);
  return rows.reduce((count, row) => {
    const coupon = couponUserView(row);
    return count + (coupon.usable ? 1 : 0);
  }, 0);
}

router.get('/me/notification-summary', requireWechatUser, (req, res) => {
  const userId = currentUserId(req);
  const couponCount = availableCouponCount(userId);
  // Keep the badge aligned with the order countdown. A scheduler may be a few
  // seconds late, so an expired pending order must not keep showing as unpaid
  // in the member centre while it is waiting to be closed.
  const pendingOrderCount = db.prepare(`SELECT COUNT(*) AS value FROM orders
    WHERE payer_user_id = ? AND payment_status = 'pending'
      AND ((payment_expire_at IS NOT NULL AND datetime(payment_expire_at) > datetime('now'))
        OR (payment_expire_at IS NULL AND datetime(created_at, '+10 minutes') > datetime('now')))`).get(userId).value;
  const unreadMessageCount = db.prepare('SELECT COUNT(*) AS value FROM user_messages WHERE user_id = ? AND read_at IS NULL AND hidden_at IS NULL').get(userId).value;
  const storageCount = db.prepare(`SELECT COUNT(*) AS value FROM storage_records
    WHERE user_id = ? AND status = 'stored' AND quantity > 0`).get(userId).value;
  res.json({ couponCount, pendingOrderCount, unreadMessageCount, storageCount });
});
router.get('/me/coupons', requireWechatUser, (req, res) => {
  const rows = db.prepare(`SELECT uc.*, cd.name, cd.type, cd.amount_cents, cd.discount_rate, cd.min_order_cents, cd.product_id, cd.category_id,
    cd.member_tier_id, cd.voucher_type, cd.gift_product_id, cd.total_quantity, cd.issued_quantity, cd.per_user_limit, cd.valid_from, cd.valid_until, cd.icon_url, cd.description, cd.status AS definition_status,
    gift.name AS gift_product_name, gift.image_url AS gift_product_image, gift.price_cents AS gift_product_price_cents
    FROM user_coupons uc JOIN coupon_definitions cd ON cd.id = uc.coupon_definition_id
    LEFT JOIN products gift ON gift.id = cd.gift_product_id
    WHERE uc.user_id = ? ORDER BY uc.id DESC`).all(currentUserId(req));
  const coupons = rows.map(couponUserView);
  res.json({ coupons, couponCount: coupons.filter(coupon => coupon.usable).length });
});
router.get('/me/messages', requireWechatUser, (req, res) => {
  const { page, pageSize, offset } = parsePagination(req);
  const total = db.prepare('SELECT COUNT(*) AS value FROM user_messages WHERE user_id = ? AND hidden_at IS NULL').get(currentUserId(req)).value;
  const messages = db.prepare('SELECT * FROM user_messages WHERE user_id = ? AND hidden_at IS NULL ORDER BY id DESC LIMIT ? OFFSET ?').all(currentUserId(req), pageSize, offset);
  res.json({ messages, pagination: paginationView(page, pageSize, total) });
});
router.patch('/me/messages/:id/read', requireWechatUser, (req, res) => { db.prepare('UPDATE user_messages SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = ? AND user_id = ?').run(req.params.id, currentUserId(req)); res.json({ ok: true }); });
router.patch('/me/messages/read-all', requireWechatUser, (req, res) => { db.prepare('UPDATE user_messages SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE user_id = ?').run(currentUserId(req)); res.json({ ok: true }); });
router.delete('/me/messages/:id', requireWechatUser, (req, res) => {
  const result = db.prepare('UPDATE user_messages SET hidden_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND read_at IS NOT NULL AND hidden_at IS NULL').run(req.params.id, currentUserId(req));
  if (!result.changes) return res.status(409).json({ message: '请先打开消息标记为已读，再删除消息' });
  res.json({ ok: true });
});
router.post('/me/subscription-authorizations', requireWechatUser, (req, res) => {
  const authorizations = Array.isArray(req.body?.authorizations) ? req.body.authorizations.slice(0, 50) : [];
  const userId = currentUserId(req);
  db.transaction(() => authorizations.forEach(item => {
    const templateKey = String(item?.templateKey || '').trim();
    const status = ['accept', 'reject', 'ban'].includes(String(item?.status)) ? String(item.status) : 'reject';
    const template = db.prepare('SELECT template_key, wechat_template_id FROM message_templates WHERE template_key = ?').get(templateKey);
    if (template && status === 'accept' && template.wechat_template_id) db.prepare(`INSERT INTO user_subscription_authorizations (user_id, template_key, wechat_template_id, status) VALUES (?, ?, ?, 'authorized')
      ON CONFLICT(user_id, template_key) DO UPDATE SET status = 'authorized', wechat_template_id = excluded.wechat_template_id, authorized_at = CURRENT_TIMESTAMP`).run(userId, template.template_key, String(item?.wechatTemplateId || template.wechat_template_id));
    else if (template) db.prepare(`INSERT INTO user_subscription_authorizations (user_id, template_key, wechat_template_id, status, last_checked_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, template_key) DO UPDATE SET status = excluded.status, last_checked_at = CURRENT_TIMESTAMP`).run(userId, template.template_key, String(item?.wechatTemplateId || template.wechat_template_id || ''), status);
  })());
  res.json({ ok: true });
});
router.get('/message-subscription-templates', (_req, res) => {
  const templates = db.prepare(`SELECT template_key AS templateKey, wechat_template_id AS wechatTemplateId
    FROM message_templates
    WHERE enabled = 1 AND wechat_template_id IS NOT NULL AND wechat_template_id != ''
    ORDER BY id`).all();
  res.json({ templates });
});

router.get('/admin/coupons', (req, res) => {
  const { page, pageSize, offset } = parsePagination(req);
  const total = db.prepare('SELECT COUNT(*) AS value FROM coupon_definitions').get().value;
  const definitions = db.prepare('SELECT * FROM coupon_definitions ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset).map(couponDefinitionView);
  const issued = db.prepare(`SELECT uc.*, u.nickname, u.phone, cd.name AS coupon_name FROM user_coupons uc JOIN users u ON u.id = uc.user_id JOIN coupon_definitions cd ON cd.id = uc.coupon_definition_id ORDER BY uc.id DESC LIMIT 50`).all();
  res.json({ coupons: definitions, issued, pagination: paginationView(page, pageSize, total) });
});
const couponInput = (body, current = {}) => {
  const name = String(body.name ?? current.name ?? '').trim();
  const voucherType = body.voucherType ?? current.voucher_type ?? 'discount';
  const type = voucherType === 'product' ? 'fixed' : (body.type ?? current.type ?? 'fixed');
  const amount = Number(body.amount ?? (Number(current.amount_cents || 0) / 100));
  const discountRate = Number(body.discountRate ?? current.discount_rate ?? 1);
  const minOrder = Number(body.minOrder ?? (Number(current.min_order_cents || 0) / 100));
  const totalQuantity = Number(body.totalQuantity ?? current.total_quantity ?? 0);
  const perUserLimit = Number(body.perUserLimit ?? current.per_user_limit ?? 1);
  const validDays = Number(body.validDays ?? current.valid_days ?? 0);
  const validFrom = body.validFrom ?? current.valid_from ?? null;
  const validUntil = body.validUntil ?? current.valid_until ?? null;
  const productId = body.productId === '' ? null : body.productId == null ? current.product_id || null : Number(body.productId);
  const giftProductId = voucherType !== 'product'
    ? null
    : body.giftProductId === '' ? null : body.giftProductId == null ? current.gift_product_id || null : Number(body.giftProductId);
  const categoryId = body.categoryId === '' ? null : body.categoryId == null ? current.category_id || null : Number(body.categoryId);
  const memberTierId = body.memberTierId === '' ? null : body.memberTierId == null ? current.member_tier_id || null : Number(body.memberTierId);
  const status = body.status ?? current.status ?? 'active';
  const validFromTime = validFrom ? new Date(validFrom).getTime() : null;
  const validUntilTime = validUntil ? new Date(validUntil).getTime() : null;
  const validDatesOk = (!validFrom || Number.isFinite(validFromTime)) && (!validUntil || Number.isFinite(validUntilTime)) && (!validFromTime || !validUntilTime || validFromTime < validUntilTime);
  const fixedAmountOk = voucherType === 'product' || type === 'discount' || (Number.isFinite(amount) && amount > 0);
  const discountRateOk = type === 'fixed' || (Number.isFinite(discountRate) && discountRate > 0 && discountRate < 1);
  const productOk = productId == null || Boolean(db.prepare('SELECT id FROM products WHERE id = ?').get(productId));
  const giftProductOk = giftProductId == null || Boolean(db.prepare("SELECT id FROM products WHERE id = ? AND store_id = 1").get(giftProductId));
  const categoryOk = categoryId == null || Boolean(db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId));
  const tierOk = memberTierId == null || Boolean(db.prepare('SELECT id FROM member_tiers WHERE id = ?').get(memberTierId));
  if (!name || name.length > 50 || !['discount', 'product'].includes(voucherType) || !['fixed', 'discount'].includes(type) || (voucherType === 'product' && (!Number.isSafeInteger(giftProductId) || !giftProductOk)) || (voucherType !== 'product' && !giftProductOk) || !fixedAmountOk || !discountRateOk || !Number.isFinite(minOrder) || minOrder < 0 || !Number.isInteger(totalQuantity) || totalQuantity < 0 || !Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 99 || !Number.isInteger(validDays) || validDays < 0 || validDays > 3650 || !validDatesOk || !productOk || !categoryOk || !tierOk || !['active', 'inactive'].includes(status)) return null;
  return {
    name,
    voucherType,
    type,
    amountCents: voucherType === 'product' ? 0 : Math.round(amount * 100),
    discountRate: voucherType === 'product' ? 1 : discountRate,
    minOrderCents: voucherType === 'product' ? 0 : Math.round(minOrder * 100),
    totalQuantity, perUserLimit, validDays, validFrom, validUntil,
    productId: voucherType === 'product' ? null : productId,
    categoryId: voucherType === 'product' ? null : categoryId,
    memberTierId, giftProductId: voucherType === 'product' ? giftProductId : null,
    iconUrl: String(body.iconUrl ?? current.icon_url ?? '').trim(),
    description: String(body.description ?? current.description ?? '').trim(), status
  };
};
router.post('/admin/coupons', (req, res) => {
  const item = couponInput(req.body || {});
  if (!item) return res.status(400).json({ message: '优惠券参数无效' });
  const id = db.prepare(`INSERT INTO coupon_definitions (store_id, name, type, voucher_type, gift_product_id, amount_cents, discount_rate, min_order_cents, product_id, category_id, member_tier_id, total_quantity, per_user_limit, valid_from, valid_until, valid_days, icon_url, description, status)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.name, item.type, item.voucherType, item.giftProductId, item.amountCents, item.discountRate, item.minOrderCents, item.productId, item.categoryId, item.memberTierId, item.totalQuantity, item.perUserLimit, item.validFrom, item.validUntil, item.validDays, item.iconUrl, item.description, item.status).lastInsertRowid;
  audit(req, '新增优惠券', item.name); res.status(201).json({ coupon: couponDefinitionView(db.prepare('SELECT * FROM coupon_definitions WHERE id = ?').get(id)) });
});
router.patch('/admin/coupons/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM coupon_definitions WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '优惠券不存在' });
  const item = couponInput(req.body || {}, current);
  if (!item) return res.status(400).json({ message: '优惠券参数无效' });
  db.prepare(`UPDATE coupon_definitions SET name=?, type=?, voucher_type=?, gift_product_id=?, amount_cents=?, discount_rate=?, min_order_cents=?, product_id=?, category_id=?, member_tier_id=?, total_quantity=?, per_user_limit=?, valid_from=?, valid_until=?, valid_days=?, icon_url=?, description=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(item.name, item.type, item.voucherType, item.giftProductId, item.amountCents, item.discountRate, item.minOrderCents, item.productId, item.categoryId, item.memberTierId, item.totalQuantity, item.perUserLimit, item.validFrom, item.validUntil, item.validDays, item.iconUrl, item.description, item.status, current.id);
  audit(req, '修改优惠券', item.name); res.json({ coupon: couponDefinitionView(db.prepare('SELECT * FROM coupon_definitions WHERE id = ?').get(current.id)) });
});
router.post('/admin/coupons/:id/issue', (req, res) => {
  const coupon = db.prepare('SELECT * FROM coupon_definitions WHERE id = ? AND status = \'active\'').get(req.params.id);
  if (!coupon) return res.status(404).json({ message: '优惠券不存在或已下架' });
  const audience = req.body?.audience === 'all' ? 'all' : 'selected';
  const ids = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.map(Number).filter(Number.isSafeInteger))] : [];
  if (audience === 'selected' && !ids.length) return res.status(400).json({ message: '请先搜索并选择要发券的会员，或改为全部会员' });
  const users = audience === 'all' ? db.prepare('SELECT id FROM users ORDER BY id').all() : db.prepare(`SELECT id FROM users WHERE id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})`).all(...ids);
  if (audience === 'selected' && users.length !== ids.length) return res.status(400).json({ message: '指定的会员不存在，请重新搜索并选择会员' });
  const issued = [];
  let campaignId;
  try {
    db.transaction(() => {
      const eligible = users.filter(user => db.prepare("SELECT COUNT(*) AS value FROM user_coupons WHERE user_id = ? AND coupon_definition_id = ? AND status != 'cancelled'").get(user.id, coupon.id).value < coupon.per_user_limit);
      if (audience === 'selected' && !eligible.length) throw new Error('所选会员已达到这张优惠券的领取上限，未重复发放');
      if (coupon.total_quantity > 0 && coupon.issued_quantity + eligible.length > coupon.total_quantity) throw new Error('优惠券剩余发放数量不足');
      const template = db.prepare("SELECT id FROM message_templates WHERE template_key = 'coupon_issued' AND enabled = 1").get();
      campaignId = db.prepare('INSERT INTO message_campaigns (name, message_template_id, audience_type, audience_filter, status, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(`发放优惠券：${coupon.name}`, template?.id || null, audience, JSON.stringify({ userIds: ids }), 'sent', req.staff.id).lastInsertRowid;
      for (const user of eligible) {
        const expiredAt = coupon.valid_days > 0 ? new Date(Date.now() + coupon.valid_days * 86400000).toISOString() : coupon.valid_until;
        const code = `CP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex')}`;
        const userCoupon = db.prepare('INSERT INTO user_coupons (user_id, coupon_definition_id, coupon_code, expired_at, source_id) VALUES (?, ?, ?, ?, ?)').run(user.id, coupon.id, code, expiredAt, campaignId);
        // Link the notification to this issued coupon, not the definition. A
        // member may receive the same coupon definition more than once.
        const messageId = createSiteMessage(user.id, 'coupon_issued', { couponName: coupon.name }, 'user_coupon', userCoupon.lastInsertRowid);
        db.prepare('INSERT INTO message_recipients (campaign_id, user_id, channel, status, sent_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(campaignId, user.id, 'site', messageId ? 'sent' : 'failed');
        issued.push(user.id);
      }
      db.prepare('UPDATE coupon_definitions SET issued_quantity = issued_quantity + ? WHERE id = ?').run(issued.length, coupon.id);
      audit(req, '发放优惠券', `${coupon.name}，成功 ${issued.length} 人`);
    })();
  } catch (error) { return res.status(409).json({ message: error.message }); }
  const notificationTemplate = db.prepare("SELECT * FROM message_templates WHERE template_key = 'coupon_issued' AND enabled = 1").get();
  if (notificationTemplate && issued.length) queueWechatCampaign(campaignId, notificationTemplate, issued.map(id => ({ id })), { couponName: coupon.name }).catch(error => console.error('优惠券微信通知失败', error));
  res.json({ ok: true, issued: issued.length, skipped: users.length - issued.length });
});

router.get('/admin/messages/templates', (_req, res) => res.json({ templates: db.prepare('SELECT * FROM message_templates ORDER BY id').all() }));
router.patch('/admin/messages/templates/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM message_templates WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '消息模板不存在' });
  const name = String(req.body?.name ?? current.name).trim();
  const title = String(req.body?.titleTemplate ?? current.title_template).trim();
  const content = String(req.body?.contentTemplate ?? current.content_template).trim();
  const wechatTemplateId = String(req.body?.wechatTemplateId ?? current.wechat_template_id).trim();
  const enabled = req.body?.enabled === undefined ? current.enabled : (req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1' ? 1 : 0);
  let fieldMapping = current.field_mapping || '{}';
  if (req.body?.fieldMapping !== undefined) {
    try {
      const parsed = typeof req.body.fieldMapping === 'string' ? JSON.parse(req.body.fieldMapping || '{}') : req.body.fieldMapping;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('字段映射必须是 JSON 对象');
      const entries = Object.entries(parsed).filter(([key, source]) => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(String(key)) && /^[A-Za-z0-9_]+$/.test(String(source)));
      if (entries.length !== Object.keys(parsed).length) throw new Error('字段映射的键和值只能使用字母、数字和下划线');
      fieldMapping = JSON.stringify(Object.fromEntries(entries));
    } catch (error) { return res.status(400).json({ message: error.message || '字段映射 JSON 无效' }); }
  }
  if (!name || !title || !content || name.length > 50 || title.length > 100 || content.length > 500) return res.status(400).json({ message: '模板内容无效' });
  db.prepare('UPDATE message_templates SET name=?, title_template=?, content_template=?, wechat_template_id=?, field_mapping=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, title, content, wechatTemplateId, fieldMapping, enabled, current.id);
  audit(req, '修改消息模板', current.template_key); res.json({ ok: true });
});
router.post('/admin/messages/send', (req, res) => {
  const template = db.prepare('SELECT * FROM message_templates WHERE enabled = 1 AND (id = ? OR template_key = ?)').get(req.body?.templateId || 0, req.body?.templateKey || 'system_notice');
  if (!template) return res.status(404).json({ message: '消息模板不存在' });
  const audience = req.body?.audience === 'all' ? 'all' : 'selected';
  const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number).filter(Number.isInteger) : [];
  const users = audience === 'all' ? db.prepare('SELECT id FROM users').all() : db.prepare(`SELECT id FROM users WHERE id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})`).all(...ids);
  const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : { content: String(req.body?.content || '').trim() };
  try {
    const campaignId = db.transaction(() => {
      const id = db.prepare('INSERT INTO message_campaigns (name, message_template_id, audience_type, audience_filter, status, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(String(req.body?.name || template.name), template.id, audience, JSON.stringify({ userIds: ids }), 'sent', req.staff.id).lastInsertRowid;
      for (const user of users) {
        const messageId = createSiteMessage(user.id, template.template_key, values, 'campaign', id);
        db.prepare('INSERT INTO message_recipients (campaign_id, user_id, channel, status, sent_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(id, user.id, 'site', messageId ? 'sent' : 'failed');
      }
      audit(req, '发送站内消息', `${template.name}，${users.length} 人`);
      return id;
    })();
    queueWechatCampaign(campaignId, template, users, values);
    res.status(201).json({ campaignId, sent: users.length });
  } catch (error) { res.status(409).json({ message: error.message }); }
});
async function queueWechatCampaign(campaignId, template, users, values) {
  if (!template.wechat_template_id) return;
  for (const user of users) {
    const authorization = db.prepare(`SELECT usa.*, u.wechat_openid FROM user_subscription_authorizations usa JOIN users u ON u.id = usa.user_id
      WHERE usa.user_id = ? AND usa.template_key = ? AND usa.status = 'authorized' AND usa.wechat_template_id = ? AND u.wechat_openid IS NOT NULL`).get(user.id, template.template_key, template.wechat_template_id);
    if (!authorization) continue;
    try {
      const mapping = (() => { try { return JSON.parse(template.field_mapping || '{}'); } catch { return {}; } })();
      const data = Object.fromEntries(Object.entries(mapping).map(([key, source]) => [key, { value: String(values[source] ?? values[key] ?? '') }]));
      if (!Object.keys(data).length) throw Object.assign(new Error('未配置微信订阅消息字段映射，请在后台填写与微信模板完全一致的字段 key'), { code: 'WECHAT_FIELD_MAPPING_MISSING' });
      const result = await sendSubscribeMessage({ openid: authorization.wechat_openid, templateId: template.wechat_template_id, data });
      db.prepare("UPDATE message_recipients SET channel = 'site,wechat', status = 'sent', wechat_message_id = ?, sent_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND user_id = ?").run(result?.msgid ? String(result.msgid) : null, campaignId, user.id);
      db.prepare('UPDATE user_subscription_authorizations SET status = \'consumed\', last_checked_at = CURRENT_TIMESTAMP WHERE id = ?').run(authorization.id);
    } catch (error) {
      db.prepare("UPDATE message_recipients SET channel = 'site,wechat', status = 'wechat_failed', error_code = ?, error_message = ? WHERE campaign_id = ? AND user_id = ?").run(String(error.code || 'WECHAT_MESSAGE_ERROR'), error.message, campaignId, user.id);
    }
  }
}
router.get('/admin/messages', (req, res) => {
  const { page, pageSize, offset } = parsePagination(req);
  const total = db.prepare('SELECT COUNT(*) AS value FROM message_campaigns').get().value;
  const campaigns = db.prepare(`SELECT mc.*, mt.name AS template_name, COUNT(mr.id) AS recipient_count FROM message_campaigns mc LEFT JOIN message_templates mt ON mt.id = mc.message_template_id LEFT JOIN message_recipients mr ON mr.campaign_id = mc.id GROUP BY mc.id ORDER BY mc.id DESC LIMIT ? OFFSET ?`).all(pageSize, offset);
  res.json({ templates: db.prepare('SELECT * FROM message_templates ORDER BY id').all(), campaigns, pagination: paginationView(page, pageSize, total) });
});
router.get('/admin/messages/campaigns', (req, res) => {
  const { page, pageSize, offset } = parsePagination(req);
  const total = db.prepare('SELECT COUNT(*) AS value FROM message_campaigns').get().value;
  const campaigns = db.prepare(`SELECT mc.*, mt.name AS template_name, COUNT(mr.id) AS recipient_count FROM message_campaigns mc LEFT JOIN message_templates mt ON mt.id = mc.message_template_id LEFT JOIN message_recipients mr ON mr.campaign_id = mc.id GROUP BY mc.id ORDER BY mc.id DESC LIMIT ? OFFSET ?`).all(pageSize, offset);
  res.json({ campaigns, pagination: paginationView(page, pageSize, total) });
});
router.get('/runtime-config', (_req, res) => {
  const { values } = getIntegrationStatus();
  const apiBaseUrl = values.public_api_base_url || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3001/api' : '');
  const isLocal = /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?\/api\/?$/i.test(apiBaseUrl || '');
  if (!apiBaseUrl || (!/^https:\/\//i.test(apiBaseUrl) && !(process.env.NODE_ENV !== 'production' && isLocal))) {
    return res.status(503).json({ message: process.env.NODE_ENV === 'production' ? '小程序 API 地址尚未配置为 HTTPS' : '小程序 API 地址尚未配置；开发环境可使用 http://localhost:3001/api，正式环境必须使用 HTTPS' });
  }
  res.json({ apiBaseUrl: apiBaseUrl.replace(/\/$/, '') });
});

router.use('/sessions', requireWechatUser);
router.use('/me', requireWechatUser);

function getOrCreateSession(storeId, tableId, userId) {
  let session = db.prepare("SELECT * FROM table_sessions WHERE store_id = ? AND table_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(storeId, tableId);
  if (!session) {
    const sessionNo = `S${Date.now().toString(36).toUpperCase()}`;
    const result = db.prepare('INSERT INTO table_sessions (store_id, table_id, session_no) VALUES (?, ?, ?)').run(storeId, tableId, sessionNo);
    session = db.prepare('SELECT * FROM table_sessions WHERE id = ?').get(result.lastInsertRowid);
  }
  db.prepare('INSERT OR IGNORE INTO session_members (session_id, user_id) VALUES (?, ?)').run(session.id, userId);
  return session;
}

function productView(row) {
  const availableStock = Math.max(Number(row.stock || 0) - Number(row.reserved_stock || 0), 0);
  const product = { ...row, stock: availableStock, physicalStock: Number(row.stock || 0), reservedStock: Number(row.reserved_stock || 0), availableStock, price: centsToMoney(row.price_cents), memberPrice: centsToMoney(row.member_price_cents ?? row.price_cents) };
  delete product.cost_cents;
  return product;
}

const validBadgeColor = value => /^#[0-9a-fA-F]{6}$/.test(String(value || ''));
const tierRequirements = tier => ({
  stored: Number(tier.stored_threshold_cents || (tier.upgrade_type === 'recharge' ? tier.threshold_cents : 0)),
  spend: Number(tier.spend_threshold_cents || (['spend', 'monthly'].includes(tier.upgrade_type) ? tier.threshold_cents : 0))
});
const tierConditionMet = (tier, storedCents, spendCents) => {
  const requirements = tierRequirements(tier);
  const storedMet = requirements.stored <= 0 || storedCents >= requirements.stored;
  const spendMet = requirements.spend <= 0 || spendCents >= requirements.spend;
  if (tier.condition_mode === 'all') return storedMet && spendMet;
  return (requirements.stored > 0 && storedCents >= requirements.stored) || (requirements.spend > 0 && spendCents >= requirements.spend);
};
const tierDuration = tier => tier.duration_days ? new Date(Date.now() + tier.duration_days * 86400000).toISOString() : null;
const paidSpendSince = (userId, since) => {
  if (!since) return Number(db.prepare("SELECT COALESCE(SUM(payable_amount_cents),0) AS amount FROM orders WHERE payer_user_id = ? AND payment_status = 'paid'").get(userId).amount);
  return Number(db.prepare("SELECT COALESCE(SUM(payable_amount_cents),0) AS amount FROM orders WHERE payer_user_id = ? AND payment_status = 'paid' AND datetime(paid_at) >= datetime(?)").get(userId, since).amount);
};
const availableStored = userId => {
  const wallet = db.prepare('SELECT stored_cents, stored_reserved_cents FROM wallet_accounts WHERE user_id = ?').get(userId);
  return Math.max(0, Number(wallet?.stored_cents || 0) - Number(wallet?.stored_reserved_cents || 0));
};
const activeTiers = () => db.prepare("SELECT * FROM member_tiers WHERE store_id = 1 AND status = 'active' ORDER BY sort, id").all();

// Membership changes are server-side and run whenever a user reaches a business boundary.
// Expired members move down one tier at a time; the previous tier is kept as a recovery target.
function syncMembership(userId) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const tiers = activeTiers();
  if (!tiers.length) return user;
  const stored = availableStored(userId);
  const allSpend = paidSpendSince(userId, null);
  const currentIndex = tiers.findIndex(tier => tier.id === user.member_tier_id);
  const now = new Date();
  const expiry = user.member_expires_at ? new Date(user.member_expires_at) : null;
  const expired = Boolean(expiry && Number.isFinite(expiry.getTime()) && expiry <= now);
  const updateTier = (tier, pendingTierId = null, cycleStartedAt = new Date().toISOString()) => {
    const level = tier?.name || '普通会员';
    db.prepare('UPDATE users SET member_tier_id = ?, member_pending_tier_id = ?, member_level = ?, member_discount = ?, member_expires_at = ?, member_cycle_started_at = ? WHERE id = ?').run(tier?.id || null, pendingTierId, level, tier?.discount || 1, tier ? tierDuration(tier) : null, cycleStartedAt, userId);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  };

  if (currentIndex < 0) {
    const recovery = user.member_pending_tier_id ? tiers.find(tier => tier.id === user.member_pending_tier_id) : null;
    if (recovery && tierConditionMet(recovery, stored, paidSpendSince(userId, user.member_cycle_started_at))) {
      updateTier(recovery, null);
      return user;
    }
    const target = !recovery ? [...tiers].reverse().find(tier => tierConditionMet(tier, stored, allSpend)) : null;
    if (target) updateTier(target);
    return user;
  }

  const currentTier = tiers[currentIndex];
  const recoveryTier = user.member_pending_tier_id ? tiers.find(tier => tier.id === user.member_pending_tier_id) : null;
  if (!expired) {
    if (recoveryTier && tierConditionMet(recoveryTier, stored, paidSpendSince(userId, user.member_cycle_started_at))) {
      updateTier(recoveryTier, null);
      return user;
    }
    const higher = recoveryTier ? null : tiers.slice(currentIndex + 1).filter(tier => tierConditionMet(tier, stored, allSpend)).pop();
    if (higher) updateTier(higher);
    return user;
  }

  const renewalSpend = paidSpendSince(userId, expiry?.toISOString() || user.member_cycle_started_at);
  if (currentTier && tierConditionMet(currentTier, stored, renewalSpend)) {
    updateTier(currentTier, recoveryTier?.id || null);
    return user;
  }
  const lower = tiers[currentIndex - 1] || null;
  updateTier(lower, recoveryTier?.id || currentTier?.id || null);
  return user;
}

function membershipProgress(userId) {
  const user = syncMembership(userId) || db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const tiers = activeTiers();
  const stored = availableStored(userId);
  const spend = user?.member_pending_tier_id ? paidSpendSince(userId, user.member_cycle_started_at) : paidSpendSince(userId, null);
  const currentIndex = tiers.findIndex(tier => tier.id === user?.member_tier_id);
  const target = user?.member_pending_tier_id ? tiers.find(tier => tier.id === user.member_pending_tier_id) : tiers[currentIndex + 1] || null;
  const requirements = target ? tierRequirements(target) : { stored: 0, spend: 0 };
  // Only configured upgrade conditions participate in the progress. An omitted
  // condition is not an already-completed condition, otherwise `any` would
  // incorrectly become 100% whenever one threshold is left blank.
  const progressValues = [];
  if (requirements.stored > 0) progressValues.push(Math.min(stored / requirements.stored, 1));
  if (requirements.spend > 0) progressValues.push(Math.min(spend / requirements.spend, 1));
  const progress = !target ? 1 : progressValues.length
    ? target.condition_mode === 'all' ? Math.min(...progressValues) : Math.max(...progressValues)
    : 0;
  return {
    currentStored: centsToMoney(stored), currentSpend: centsToMoney(spend),
    currentTierId: user?.member_tier_id || null, targetTierId: target?.id || null,
    progress: Number(progress.toFixed(4)), conditionMode: target?.condition_mode || 'any',
    targetTierName: target?.name || '',
    conditions: { stored: centsToMoney(requirements.stored), spend: centsToMoney(requirements.spend) },
    tiers: tiers.map(tier => ({ id: tier.id, name: tier.name, discount: tier.discount, discountLabel: `${Number(tier.discount * 10).toFixed(1)} 折`, pointsRate: tier.points_rate, durationDays: tier.duration_days, sort: tier.sort, badgeColor: validBadgeColor(tier.badge_color) ? tier.badge_color : '#C77F52', conditionMode: tier.condition_mode, storedThreshold: centsToMoney(tierRequirements(tier).stored), spendThreshold: centsToMoney(tierRequirements(tier).spend) }))
  };
}

function memberPricing(userId) {
  const user = syncMembership(userId);
  if (!user || user.member_level === '普通会员') return { active: false, discount: 1, pointsRate: 1, color: '#C77F52' };
  const active = !user.member_expires_at || new Date(user.member_expires_at) > new Date();
  const tier = user.member_tier_id && db.prepare("SELECT discount, points_rate, badge_color FROM member_tiers WHERE id = ? AND status = 'active'").get(user.member_tier_id);
  const eligible = Boolean(active && tier);
  return { active: eligible, discount: eligible ? tier.discount : 1, pointsRate: eligible ? tier.points_rate : 1, color: eligible && validBadgeColor(tier.badge_color) ? tier.badge_color : '#C77F52' };
}
function unitPrice(product, pricing) {
  if (!pricing.active) return product.price_cents;
  return Math.min(product.member_price_cents ?? product.price_cents, Math.round(product.price_cents * pricing.discount));
}

function couponDefinitionView(row) {
  const giftProduct = row.gift_product_id
    ? (row.gift_product_name !== undefined
      ? { name: row.gift_product_name, image_url: row.gift_product_image, price_cents: row.gift_product_price_cents }
      : db.prepare('SELECT name, image_url, price_cents FROM products WHERE id = ?').get(row.gift_product_id))
    : null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    voucherType: row.voucher_type || 'discount',
    isProductVoucher: (row.voucher_type || 'discount') === 'product',
    giftProductId: row.gift_product_id || null,
    giftProductName: giftProduct?.name || null,
    giftProductImage: giftProduct?.image_url || null,
    giftProductPrice: giftProduct?.price_cents == null ? null : centsToMoney(giftProduct.price_cents),
    amount: centsToMoney(row.amount_cents),
    discountRate: row.discount_rate,
    minOrder: centsToMoney(row.min_order_cents),
    productId: row.product_id,
    categoryId: row.category_id,
    memberTierId: row.member_tier_id,
    totalQuantity: row.total_quantity,
    issuedQuantity: row.issued_quantity,
    perUserLimit: row.per_user_limit,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    validDays: row.valid_days,
    iconUrl: row.icon_url,
    description: row.description,
    status: row.status
  };
}

function couponUsable(coupon, userId, items = [], options = {}) {
  if (!coupon || coupon.user_id !== userId || coupon.status !== 'available' || coupon.definition_status === 'inactive' || coupon.status === 'cancelled') return { ok: false, message: '优惠券不可用' };
  const now = Date.now();
  if (coupon.valid_from && new Date(coupon.valid_from).getTime() > now) return { ok: false, message: '优惠券尚未生效' };
  if (coupon.expired_at && new Date(coupon.expired_at).getTime() <= now) return { ok: false, message: '优惠券已过期' };
  if (coupon.valid_until && new Date(coupon.valid_until).getTime() <= now) return { ok: false, message: '优惠券已过期' };
  const definition = coupon;
  if (definition.member_tier_id) {
    const user = db.prepare('SELECT member_tier_id FROM users WHERE id = ?').get(userId);
    if (Number(user?.member_tier_id) !== Number(definition.member_tier_id)) return { ok: false, message: '当前会员等级不满足优惠券使用条件' };
  }
  const pricing = options.pricing || memberPricing(userId);
  const base = items.reduce((sum, item) => sum + unitPrice(item, pricing) * Number(item.quantity || 0), 0);
  if ((coupon.voucher_type || 'discount') === 'product') {
    // A product voucher must be bound to the cart row created by the
    // voucher-use endpoint. Matching by product alone would allow a payer to
    // apply someone else's voucher to an ordinary item of the same product.
    const giftItems = items.filter(item => Number(item.applied_coupon_id) === Number(coupon.id)
      && Number(item.product_id) === Number(coupon.gift_product_id));
    if (!giftItems.length || giftItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0) < 1) return { ok: false, message: '请先将兑换商品加入购物车' };
    const giftPrice = Math.max(...giftItems.map(item => unitPrice(item, pricing)));
    return { ok: true, discount: giftPrice, eligibleAmount: giftPrice, definition };
  }
  if (base < coupon.min_order_cents) return { ok: false, message: `订单满 ${centsToMoney(coupon.min_order_cents)} 元可用` };
  const eligibleItems = items.filter(item => (!definition.product_id || Number(item.product_id) === Number(definition.product_id)) && (!definition.category_id || Number(item.category_id) === Number(definition.category_id)));
  if (!eligibleItems.length) return { ok: false, message: '当前商品不满足优惠券使用范围' };
  const eligibleAmount = eligibleItems.reduce((sum, item) => sum + unitPrice(item, pricing) * Number(item.quantity || 0), 0);
  const discount = definition.type === 'discount'
    ? Math.min(eligibleAmount, Math.max(0, Math.round(eligibleAmount * (1 - Number(definition.discount_rate)))))
    : Math.min(eligibleAmount, Math.max(0, Number(definition.amount_cents)));
  if (discount <= 0) return { ok: false, message: '当前优惠券无法抵扣' };
  return { ok: true, discount, eligibleAmount, definition };
}

function getCouponForOrder(userId, userCouponId, items, options = {}) {
  if (!userCouponId) return null;
  const coupon = db.prepare(`SELECT uc.*, cd.name, cd.type, cd.voucher_type, cd.gift_product_id, cd.amount_cents, cd.discount_rate, cd.min_order_cents,
    cd.product_id, cd.category_id, cd.member_tier_id, cd.valid_from, cd.valid_until, cd.icon_url, cd.description, cd.status AS definition_status,
    gift.name AS gift_product_name, gift.image_url AS gift_product_image, gift.price_cents AS gift_product_price_cents
    FROM user_coupons uc JOIN coupon_definitions cd ON cd.id = uc.coupon_definition_id
    LEFT JOIN products gift ON gift.id = cd.gift_product_id
    WHERE uc.id = ?`).get(userCouponId);
  const result = couponUsable(coupon, userId, items, options);
  if (!result.ok) throw new Error(result.message);
  return { ...coupon, ...result };
}

function lockCoupon(orderId, couponId, userId) {
  if (!couponId) return;
  const changed = db.prepare("UPDATE user_coupons SET status = 'locked', order_id = ? WHERE id = ? AND user_id = ? AND status = 'available'").run(orderId, couponId, userId).changes;
  if (!changed) throw new Error('优惠券已被使用或锁定，请重新选择');
}

function consumeCoupon(order) {
  if (!order.coupon_id) return;
  const changed = db.prepare("UPDATE user_coupons SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ? AND order_id = ? AND status = 'locked'").run(order.coupon_id, order.id).changes;
  if (!changed) throw new Error('优惠券状态异常，无法完成订单');
}

function releaseCoupon(order) {
  if (!order?.coupon_id) return;
  db.prepare("UPDATE user_coupons SET status = 'available', order_id = NULL WHERE id = ? AND order_id = ? AND status = 'locked'").run(order.coupon_id, order.id);
}

function orderTotals(items, userId, selectedCouponId) {
  const pricing = memberPricing(userId);
  const original = items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
  const coupon = selectedCouponId ? getCouponForOrder(userId, selectedCouponId, items, { pricing }) : null;
  const productVoucher = coupon && (coupon.voucher_type || 'discount') === 'product';
  const member = items.reduce((sum, item) => sum + unitPrice(item, pricing) * item.quantity, 0);
  const couponDiscount = coupon?.discount || 0;
  const payable = Math.max(0, member - couponDiscount);
  return { pricing, original, member, payable, couponDiscount, coupon, usingCoupon: Boolean(coupon), productVoucher, giftProductId: productVoucher ? coupon.gift_product_id : null };
}

router.get('/products', (req, res) => {
  syncProductAvailability();
  const storeId = Number(req.query.storeId || 1);
  const rows = db.prepare("SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id WHERE p.store_id = ? AND p.status = 'active' AND p.stock - p.reserved_stock > 0 ORDER BY c.sort, p.sort, p.id").all(storeId);
  const pricing = memberPricing(currentUserId(req));
  res.json({ membership: pricing, products: rows.map(row => ({ ...productView(row), referenceMemberPrice: centsToMoney(Math.min(row.price_cents, row.member_price_cents ?? row.price_cents)), memberPrice: centsToMoney(unitPrice(row, pricing)) })), categories: [...new Set(rows.map(row => row.category))] });
});

router.get('/tables/resolve', (req, res) => {
  const scene = String(req.query.scene || '');
  const match = /^t_(\d{1,12})$/.exec(scene);
  if (!match) return res.status(400).json({ message: '桌台二维码参数无效' });
  const table = db.prepare("SELECT id, table_no FROM tables WHERE id = ? AND status != 'disabled'").get(Number(match[1]));
  if (!table) return res.status(404).json({ message: '桌台不存在或已停用' });
  res.json({ table: { id: table.id, tableNo: table.table_no } });
});

router.get('/tables/:tableNo/session', requireWechatUser, (req, res) => {
  const userId = currentUserId(req);
  const table = db.prepare('SELECT * FROM tables WHERE table_no = ? AND status != ?').get(req.params.tableNo, 'disabled');
  if (!table) return res.status(404).json({ message: '桌台不存在' });
  const session = getOrCreateSession(table.store_id, table.id, userId);
  const user = publicUser(db.prepare('SELECT id, nickname, phone, avatar_url, member_level, points, member_expires_at FROM users WHERE id = ?').get(userId));
  res.json({ table: { id: table.id, tableNo: table.table_no }, session, user, membership: memberPricing(userId) });
});

router.get('/sessions/:sessionId/cart', (req, res) => {
  const rows = db.prepare("SELECT ci.id, ci.product_id, ci.quantity, ci.added_by_user_id, ci.applied_coupon_id, p.name, p.detail, p.price_cents, p.member_price_cents, p.image_url, p.color, p.stock, p.reserved_stock FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? AND ci.status = 'pending' ORDER BY ci.id").all(req.params.sessionId);
  const pricing = memberPricing(currentUserId(req));
  const totals = rows.reduce((sum, row) => { sum.original += row.price_cents * row.quantity; sum.member += unitPrice(row, pricing) * row.quantity; return sum; }, { original: 0, member: 0 });
  res.json({ membership: pricing, items: rows.map(row => ({ ...row, stock: Math.max(row.stock - row.reserved_stock, 0), physicalStock: row.stock, reservedStock: row.reserved_stock, availableStock: Math.max(row.stock - row.reserved_stock, 0), price: centsToMoney(row.price_cents), referenceMemberPrice: centsToMoney(Math.min(row.price_cents, row.member_price_cents ?? row.price_cents)), memberPrice: centsToMoney(unitPrice(row, pricing)) })), totals: { original: centsToMoney(totals.original), member: centsToMoney(totals.member), discount: centsToMoney(totals.original - totals.member), points: Math.floor(totals.member / 100 * pricing.pointsRate) } });
});

router.post('/sessions/:sessionId/cart/items', (req, res) => {
  const userId = currentUserId(req);
  const { productId, quantity = 1 } = req.body || {};
  const requested = Number(quantity);
  if (!Number.isSafeInteger(Number(productId)) || !Number.isSafeInteger(requested) || requested < 1) return res.status(400).json({ message: '商品或数量无效' });
  try {
    db.transaction(() => {
      const session = db.prepare("SELECT * FROM table_sessions WHERE id = ? AND status = 'open'").get(req.params.sessionId);
      const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active' AND stock - reserved_stock > 0").get(productId);
      if (!session || !product) throw new Error('商品已下架或库存不足');
      const inCart = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM cart_items WHERE session_id = ? AND product_id = ? AND status = 'pending'").get(session.id, product.id).quantity;
      const available = Math.max(product.stock - product.reserved_stock, 0);
      if (inCart + requested > available) throw new Error(`库存不足，当前最多还可下单 ${Math.max(available - inCart, 0)} 件`);
      db.prepare('INSERT OR IGNORE INTO session_members (session_id, user_id) VALUES (?, ?)').run(session.id, userId);
      // Never merge a normal purchase into a product-voucher row. The
      // voucher row is a fixed one-unit gift and must remain traceable to the
      // specific user coupon through checkout.
      const existing = db.prepare("SELECT id FROM cart_items WHERE session_id = ? AND product_id = ? AND added_by_user_id = ? AND status = 'pending' AND applied_coupon_id IS NULL").get(session.id, product.id, userId);
      if (existing) db.prepare('UPDATE cart_items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(requested, existing.id);
      else db.prepare('INSERT INTO cart_items (session_id, product_id, quantity, added_by_user_id) VALUES (?, ?, ?, ?)').run(session.id, product.id, requested, userId);
    })();
    res.status(201).json({ ok: true });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

// Product vouchers only prepare the cart. The coupon is locked at checkout so
// abandoning or expiring an order never burns the customer's voucher.
router.post('/sessions/:sessionId/coupons/:userCouponId/use', (req, res) => {
  const userId = currentUserId(req);
  try {
    const result = db.transaction(() => {
      const session = db.prepare("SELECT * FROM table_sessions WHERE id = ? AND status = 'open'").get(req.params.sessionId);
      if (!session) throw new Error('桌台会话不存在或已结束');
      const coupon = db.prepare(`SELECT uc.*, cd.name, cd.voucher_type, cd.gift_product_id, cd.status AS definition_status,
        cd.valid_from, cd.valid_until, p.name AS gift_product_name
        FROM user_coupons uc JOIN coupon_definitions cd ON cd.id = uc.coupon_definition_id
        LEFT JOIN products p ON p.id = cd.gift_product_id
        WHERE uc.id = ? AND uc.user_id = ?`).get(req.params.userCouponId, userId);
      if (!coupon || coupon.status !== 'available' || coupon.definition_status !== 'active') throw new Error('优惠券不可用');
      if (coupon.voucher_type !== 'product' || !coupon.gift_product_id) throw new Error('这张券需要在结算时使用');
      const now = Date.now();
      if ((coupon.valid_from && new Date(coupon.valid_from).getTime() > now) || (coupon.valid_until && new Date(coupon.valid_until).getTime() <= now) || (coupon.expired_at && new Date(coupon.expired_at).getTime() <= now)) throw new Error('优惠券已过期或尚未生效');
      const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active' AND stock - reserved_stock > 0").get(coupon.gift_product_id);
      if (!product) throw new Error('兑换商品已下架或库存不足');
      const applied = db.prepare("SELECT id, quantity FROM cart_items WHERE session_id = ? AND applied_coupon_id = ? AND status = 'pending' LIMIT 1").get(session.id, coupon.id);
      if (applied) return { productId: product.id, productName: product.name, added: false, alreadyApplied: true, quantity: applied.quantity };
      const inCart = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM cart_items WHERE session_id = ? AND product_id = ? AND status = 'pending'").get(session.id, product.id).quantity;
      const available = Math.max(Number(product.stock) - Number(product.reserved_stock), 0);
      if (inCart + 1 > available) throw new Error(`库存不足，当前最多还可下单 ${Math.max(available - inCart, 0)} 件`);
      db.prepare('INSERT OR IGNORE INTO session_members (session_id, user_id) VALUES (?, ?)').run(session.id, userId);
      db.prepare('INSERT INTO cart_items (session_id, product_id, quantity, added_by_user_id, applied_coupon_id) VALUES (?, ?, 1, ?, ?)').run(session.id, product.id, userId, coupon.id);
      return { productId: product.id, productName: product.name, added: true, quantity: inCart + 1 };
    })();
    res.json({ ok: true, ...result });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

router.patch('/sessions/:sessionId/cart/items/:itemId', (req, res) => {
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ message: '数量无效' });
  try {
    db.transaction(() => {
      const item = db.prepare("SELECT ci.*, p.stock, p.reserved_stock, p.status AS product_status FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.id = ? AND ci.session_id = ? AND ci.status = 'pending'").get(req.params.itemId, req.params.sessionId);
      if (!item) throw new Error('购物车商品不存在或已下架');
      if (quantity > 0) {
        if (item.applied_coupon_id && quantity > 1) throw new Error('商品兑换券赠送数量固定为 1 件');
        const other = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM cart_items WHERE session_id = ? AND product_id = ? AND status = 'pending' AND id != ?").get(req.params.sessionId, item.product_id, item.id).quantity;
        const available = Math.max(item.stock - item.reserved_stock, 0);
        if (item.product_status !== 'active' || available <= 0 || other + quantity > available) throw new Error(`库存不足，当前最多可下单 ${Math.max(available - other, 0)} 件`);
        db.prepare("UPDATE cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(quantity, item.id);
      } else db.prepare("UPDATE cart_items SET status = 'removed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id);
    })();
    res.json({ ok: true });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

function settleOrder(order, method, req, reserved = true) {
  const items = db.prepare('SELECT product_id, quantity, cart_item_id FROM order_items WHERE order_id = ?').all(order.id);
  const quantities = new Map();
  for (const item of items) quantities.set(Number(item.product_id), (quantities.get(Number(item.product_id)) || 0) + Number(item.quantity));
  for (const [productId, quantity] of quantities) {
    const statement = reserved
      ? 'UPDATE products SET stock = stock - ?, reserved_stock = reserved_stock - ? WHERE id = ? AND stock >= ? AND reserved_stock >= ?'
      : 'UPDATE products SET stock = stock - ? WHERE id = ? AND stock - reserved_stock >= ?';
    const params = reserved
      ? [quantity, quantity, productId, quantity, quantity]
      : [quantity, productId, quantity];
    if (!db.prepare(statement).run(...params).changes) throw new Error('库存不足，无法完成支付');
  }
  const settleCartItem = db.prepare("UPDATE cart_items SET status = 'settled' WHERE id = ?");
  items.forEach(item => { if (item.cart_item_id) settleCartItem.run(item.cart_item_id); });
  db.prepare("UPDATE orders SET status = 'awaiting_delivery', payment_status = 'paid', payment_method = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(method, order.id);
  consumeCoupon(order);
  const points = Math.floor(order.payable_amount_cents / 100 * memberPricing(order.payer_user_id).pointsRate);
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(points, order.payer_user_id);
  db.prepare('INSERT INTO points_ledger (user_id, order_id, points, reason) VALUES (?, ?, ?, ?)').run(order.payer_user_id, order.id, points, '订单消费');
  const before = db.prepare('SELECT member_tier_id, member_level FROM users WHERE id = ?').get(order.payer_user_id);
  const after = syncMembership(order.payer_user_id);
  if (req.staff && before?.member_tier_id !== after?.member_tier_id) audit(req, '会员等级自动调整', `ID ${order.payer_user_id}: ${before?.member_level || '普通会员'} -> ${after?.member_level || '普通会员'}`);
  const orderNo = order.order_no || db.prepare('SELECT order_no FROM orders WHERE id = ?').get(order.id)?.order_no;
  queueUserMessage(order.payer_user_id, 'order_paid', { orderNo }, 'order', order.id, `订单已支付：${orderNo}`);
  queueUserMessage(order.payer_user_id, 'order_awaiting_delivery', { orderNo }, 'order_delivery', order.id, `订单待送达：${orderNo}`);
  if (before?.member_tier_id !== after?.member_tier_id && after?.member_tier_id) {
    queueUserMessage(order.payer_user_id, 'member_upgraded', { memberLevel: after.member_level }, 'member', after.member_tier_id, `会员升级：${after.member_level}`);
  }
}

function completeWechatOrder(orderNo, transactionId) {
  return db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
    if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
    if (order.payment_status === 'paid') return order;
    if (order.payment_status !== 'pending') throw Object.assign(new Error('订单当前不可支付'), { status: 409 });
    if (order.payment_method === 'mixed') {
      const wallet = db.prepare('SELECT stored_cents, bonus_cents, stored_reserved_cents, bonus_reserved_cents FROM wallet_accounts WHERE user_id = ?').get(order.payer_user_id);
      if (!wallet || wallet.stored_reserved_cents < order.stored_paid_cents || wallet.bonus_reserved_cents < order.bonus_paid_cents) throw new Error('余额冻结金额不足，请重新发起支付');
      db.prepare('UPDATE wallet_accounts SET stored_cents = stored_cents - ?, bonus_cents = bonus_cents - ?, stored_reserved_cents = stored_reserved_cents - ?, bonus_reserved_cents = bonus_reserved_cents - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(order.stored_paid_cents, order.bonus_paid_cents, order.stored_paid_cents, order.bonus_paid_cents, order.payer_user_id);
      db.prepare('INSERT INTO wallet_transactions (user_id, type, stored_cents, bonus_cents, remark) VALUES (?, ?, ?, ?, ?)').run(order.payer_user_id, 'order_payment', -order.stored_paid_cents, -order.bonus_paid_cents, order.order_no);
    }
    db.prepare('UPDATE orders SET wechat_transaction_id = ? WHERE id = ?').run(transactionId || null, order.id);
    settleOrder({ ...order, payable_amount_cents: order.payable_amount_cents }, order.payment_method, {}, true);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  })();
}

function releasePendingOrder(orderId, reason) {
  return db.transaction(() => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND payment_status = 'pending'").get(orderId);
    if (!order) return null;
    const items = db.prepare('SELECT cart_item_id, product_id, quantity FROM order_items WHERE order_id = ?').all(order.id);
    const quantities = new Map();
    for (const item of items) quantities.set(Number(item.product_id), (quantities.get(Number(item.product_id)) || 0) + Number(item.quantity));
    const releaseReserved = db.prepare('UPDATE products SET reserved_stock = MAX(reserved_stock - ?, 0) WHERE id = ?');
    quantities.forEach((quantity, productId) => releaseReserved.run(quantity, productId));
    if (order.payment_method === 'mixed') {
      db.prepare('UPDATE wallet_accounts SET stored_reserved_cents = MAX(stored_reserved_cents - ?, 0), bonus_reserved_cents = MAX(bonus_reserved_cents - ?, 0), updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(order.stored_paid_cents, order.bonus_paid_cents, order.payer_user_id);
    }
    const restoreCartItem = db.prepare("UPDATE cart_items SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'checking_out'");
    items.forEach(item => restoreCartItem.run(item.cart_item_id));
    db.prepare("UPDATE orders SET payment_status = 'closed', status = 'cancelled', payment_error = ? WHERE id = ? AND payment_status = 'pending'").run(reason, order.id);
    releaseCoupon(order);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  })();
}

async function closePendingWechatOrder(order, reason) {
  if (order.wechat_prepay_id) {
    let result;
    try {
      result = await queryPayment(order.order_no);
    } catch (error) {
      if (error.code === 'WECHAT_ORDER_NOT_FOUND') return { cancelled: releasePendingOrder(order.id, reason) };
      throw error;
    }
    if (result.trade_state === 'SUCCESS') {
      completeWechatOrder(order.order_no, result.transaction_id);
      return { paid: true };
    }
    if (result.trade_state === 'NOTPAY') {
      // Querying NOTPAY is only a snapshot. Close the trade at WeChat before
      // giving back the locally reserved money, coupon and cart items.
      try { await closePayment(order.order_no); }
      catch (error) {
        if (error.status === 404 || error.code === 'WECHAT_ORDER_NOT_FOUND') return { cancelled: releasePendingOrder(order.id, reason) };
        const latest = await queryPayment(order.order_no);
        if (latest.trade_state === 'SUCCESS') {
          completeWechatOrder(order.order_no, latest.transaction_id);
          return { paid: true };
        }
        if (!['CLOSED', 'REVOKED', 'PAYERROR'].includes(latest.trade_state)) throw error;
      }
    } else if (!['CLOSED', 'REVOKED', 'PAYERROR'].includes(result.trade_state)) {
      throw new Error('微信支付状态尚未确认，请稍后重试');
    }
  }
  return { cancelled: releasePendingOrder(order.id, reason) };
}

function reconcilePendingWalletReservations() {
  const resetAll = db.prepare('UPDATE wallet_accounts SET stored_reserved_cents = 0, bonus_reserved_cents = 0, updated_at = CURRENT_TIMESTAMP');
  const users = db.prepare("SELECT DISTINCT payer_user_id FROM orders WHERE payment_status = 'pending' AND payment_method = 'mixed'").all();
  const reset = db.prepare('UPDATE wallet_accounts SET stored_reserved_cents = ?, bonus_reserved_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?');
  const pending = db.prepare("SELECT COALESCE(SUM(stored_paid_cents), 0) AS stored, COALESCE(SUM(bonus_paid_cents), 0) AS bonus FROM orders WHERE payer_user_id = ? AND payment_status = 'pending' AND payment_method = 'mixed'");
  db.transaction(() => {
    resetAll.run();
    for (const user of users) {
      const amount = pending.get(user.payer_user_id);
      reset.run(amount.stored, amount.bonus, user.payer_user_id);
    }
  })();
}

router.post('/payments/wechat/notify', async (req, res) => {
  try {
    const payload = verifyNotification({ body: req.rawBody || JSON.stringify(req.body || {}), timestamp: req.header('Wechatpay-Timestamp'), nonce: req.header('Wechatpay-Nonce'), signature: req.header('Wechatpay-Signature'), serial: req.header('Wechatpay-Serial') });
    if (payload.trade_state === 'SUCCESS' && payload.out_trade_no) completeWechatOrder(payload.out_trade_no, payload.transaction_id);
    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (error) {
    res.status(error.code === 'WECHAT_SIGNATURE_INVALID' ? 401 : 500).json({ code: 'FAIL', message: error.message });
  }
});

router.post('/payments/wechat/:orderNo/query', async (req, res) => {
  if (!req.user) return res.status(401).json({ message: '请先登录' });
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND payer_user_id = ?').get(req.params.orderNo, req.user.id);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  try {
    const result = await queryPayment(order.order_no);
    if (result.trade_state === 'SUCCESS') completeWechatOrder(order.order_no, result.transaction_id);
    res.json({ order: db.prepare('SELECT payment_status, status FROM orders WHERE id = ?').get(order.id), tradeState: result.trade_state });
  } catch (error) { res.status(error.status || 503).json({ message: error.message, code: error.code || 'WECHAT_QUERY_ERROR' }); }
});

router.post('/me/orders/:orderNo/pay', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ message: '请先登录' });
  const order = db.prepare("SELECT * FROM orders WHERE order_no = ? AND payer_user_id = ?").get(req.params.orderNo, userId);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.payment_status !== 'pending') return res.status(409).json({ message: order.payment_status === 'paid' ? '订单已经支付' : '订单已关闭，无法继续支付' });
  if (!['wechat', 'mixed'].includes(order.payment_method) || order.wechat_paid_cents <= 0) return res.status(409).json({ message: '该订单不支持继续微信支付' });

  const paymentExpireAt = orderExpiryAt(order);
  if (paymentExpireAt && new Date(paymentExpireAt) <= new Date()) {
    try {
      const result = await closePendingWechatOrder(order, '微信支付订单已过期关闭');
      if (result.paid) {
        return res.json({ order: db.prepare('SELECT payment_status, status FROM orders WHERE id = ?').get(order.id), payment: null });
      }
      if (result.cancelled) queueUserMessage(userId, 'order_cancelled', { orderNo: order.order_no }, 'order', order.id);
      return res.status(409).json({ message: '订单已过期，请重新下单' });
    } catch (error) {
      return res.status(error.status || 503).json({ message: error.message, code: error.code || 'WECHAT_QUERY_ERROR' });
    }
  }

  try {
    const user = db.prepare('SELECT wechat_openid FROM users WHERE id = ?').get(userId);
    if (!user?.wechat_openid) return res.status(409).json({ message: '当前微信账号尚未完成登录绑定，请重新进入小程序' });
    const result = await createJsapiPayment({ orderNo: order.order_no, description: `酒吧订单 ${order.order_no}`, totalCents: order.wechat_paid_cents, openid: user.wechat_openid });
    db.prepare('UPDATE orders SET wechat_prepay_id = ?, payment_error = \'\' WHERE id = ? AND payment_status = \'pending\'').run(result.prepayId, order.id);
    res.json({ payment: result.payment, message: order.payment_method === 'mixed' ? `余额抵扣 ${centsToMoney(order.stored_paid_cents + order.bonus_paid_cents)}，请完成微信支付` : '请完成微信支付' });
  } catch (error) {
    res.status(error.status || 502).json({ message: error.message, code: error.code || 'WECHAT_PAYMENT_ERROR' });
  }
});

router.post('/me/orders/:orderNo/cancel', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ message: '请先登录' });
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ? AND payer_user_id = ?').get(req.params.orderNo, userId);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.payment_status !== 'pending') return res.status(409).json({ message: order.payment_status === 'paid' ? '已支付订单不能取消' : '订单已关闭，不能重复取消' });
  let result;
  try { result = await closePendingWechatOrder(order, '用户取消支付'); }
  catch (error) { return res.status(error.status || 503).json({ message: error.message, code: error.code || 'WECHAT_CLOSE_ERROR' }); }
  if (result.paid) return res.status(409).json({ message: '订单已经支付，不能取消' });
  const cancelled = result.cancelled;
  if (!cancelled) return res.status(409).json({ message: '订单状态已发生变化，请刷新订单列表' });
  queueUserMessage(userId, 'order_cancelled', { orderNo: cancelled.order_no }, 'order', cancelled.id, `订单已取消：${cancelled.order_no}`);
  res.json({ ok: true, order: { orderNo: cancelled.order_no, paymentStatus: cancelled.payment_status, status: cancelled.status } });
});

function releaseExpiredWechatOrders() {
  return Promise.all(db.prepare("SELECT * FROM orders WHERE payment_status = 'pending' AND ((payment_expire_at IS NOT NULL AND payment_expire_at < ?) OR (payment_expire_at IS NULL AND datetime(created_at, '+10 minutes') < datetime('now')))").all(new Date().toISOString()).map(async order => {
    try {
      const result = await closePendingWechatOrder(order, '微信支付超时关闭');
      if (result.cancelled) queueUserMessage(result.cancelled.payer_user_id, 'order_cancelled', { orderNo: order.order_no }, 'order', order.id, `订单已取消：${order.order_no}`);
    } catch (error) {
      // 本地演示环境没有微信商户配置，不能让测试订单永久卡在待支付。
      // 生产环境仍保留查询失败不自动关闭的保护，避免网络抖动误取消真实订单。
      const { groups } = getIntegrationStatus();
      if (!groups.wechatPay?.configured && !order.wechat_prepay_id) {
        const cancelled = releasePendingOrder(order.id, '微信支付未配置，订单超时关闭');
        if (cancelled) queueUserMessage(cancelled.payer_user_id, 'order_cancelled', { orderNo: cancelled.order_no }, 'order', cancelled.id, `订单已取消：${cancelled.order_no}`);
      } else {
        console.error(`[wechat] 查询超时订单 ${order.order_no} 失败: ${error.message}`);
      }
    }
  }));
}
reconcilePendingWalletReservations();
releaseExpiredWechatOrders().catch(error => console.error(`[wechat] 启动时检查超时订单失败: ${error.message}`));
setInterval(() => releaseExpiredWechatOrders(), 60 * 1000).unref();

function notifyExpiringStorage() {
  const now = new Date();
  const limit = new Date(now.getTime() + 3 * 86400000);
  const records = db.prepare(`SELECT id, user_id, product_name, quantity, expires_at
    FROM storage_records
    WHERE status = 'stored' AND quantity > 0
      AND datetime(expires_at) > datetime(?)
      AND datetime(expires_at) <= datetime(?)`).all(now.toISOString(), limit.toISOString());
  records.forEach(record => queueUserMessage(record.user_id, 'storage_expiring', {
    productName: record.product_name,
    quantity: record.quantity,
    remainingDays: Math.max(1, Math.ceil((new Date(record.expires_at).getTime() - now.getTime()) / 86400000)),
    expireAt: String(record.expires_at).slice(0, 10)
  }, 'storage_expiry', record.id, `存酒即将到期：${record.id}`));
}
notifyExpiringStorage();
setInterval(notifyExpiringStorage, 60 * 60 * 1000).unref();

const posMember = row => row && ({ id: row.id, phone: row.phone, nickname: row.nickname, level: row.member_level, stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) });
const posMemberSql = 'SELECT u.*, COALESCE(w.stored_cents,0) AS stored_cents, COALESCE(w.bonus_cents,0) AS bonus_cents FROM users u LEFT JOIN wallet_accounts w ON w.user_id = u.id WHERE u.phone = ?';
router.get('/admin/pos', (req, res) => {
  syncProductAvailability();
  const phone = String(req.query.phone || '').trim();
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ message: '请输入完整会员手机号' });
  const member = phone ? db.prepare(posMemberSql).get(phone) : null;
  res.json({ member: posMember(member), tables: db.prepare("SELECT id, table_no FROM tables WHERE status != 'disabled' ORDER BY table_no").all(), products: db.prepare("SELECT id, name, image_url, price_cents, member_price_cents, stock, reserved_stock, category_id FROM products WHERE status = 'active' AND stock - reserved_stock > 0 ORDER BY sort,id").all().map(row => ({ ...row, physicalStock: row.stock, reservedStock: row.reserved_stock, availableStock: Math.max(row.stock - row.reserved_stock, 0), stock: Math.max(row.stock - row.reserved_stock, 0), price: centsToMoney(row.price_cents), memberPrice: member ? centsToMoney(unitPrice(row, memberPricing(member.id))) : centsToMoney(row.price_cents) })), packages: db.prepare("SELECT id,name,pay_cents,stored_cents,bonus_cents FROM wallet_packages WHERE status = 'active' ORDER BY pay_cents").all().map(row => ({ ...row, pay: centsToMoney(row.pay_cents), stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) })) });
});

router.post('/admin/pos/orders', (req, res) => {
  const { tableId, phone, items, paymentMethod, requestId } = req.body || {};
  if (!['balance','cash','merchant_qr'].includes(paymentMethod) || !/^[a-f0-9-]{36}$/.test(String(requestId || '')) || !Array.isArray(items) || !items.length || items.length > 100 || items.some(i => !Number.isSafeInteger(i.productId) || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > 999) || new Set(items.map(i => i.productId)).size !== items.length) return res.status(400).json({ message: '商品、数量或支付方式无效' });
  const member = db.prepare(posMemberSql).get(String(phone || '').trim());
  const table = db.prepare("SELECT * FROM tables WHERE id = ? AND status != 'disabled'").get(tableId);
  if (!member || !table) return res.status(400).json({ message: '请选择有效桌号和已绑定手机号的会员' });
  try {
    const order = db.transaction(() => {
      const prior = db.prepare('SELECT * FROM orders WHERE pos_request_id = ?').get(requestId);
      if (prior) return prior;
      const rows = items.map(item => ({ ...item, product: db.prepare("SELECT * FROM products WHERE id = ? AND status = 'active'").get(item.productId) }));
      if (rows.some(i => !i.product || i.product.stock - i.product.reserved_stock < i.quantity)) throw new Error('商品已下架或可售库存不足');
      const pricing = memberPricing(member.id);
      const original = rows.reduce((n, i) => n + i.product.price_cents * i.quantity, 0);
      const payable = rows.reduce((n, i) => n + unitPrice(i.product, pricing) * i.quantity, 0);
      const eligible = rows.reduce((n, i) => n + (i.product.allow_bonus ? unitPrice(i.product, pricing) * i.quantity : 0), 0);
      const wallet = db.prepare('SELECT stored_cents,bonus_cents FROM wallet_accounts WHERE user_id = ?').get(member.id) || { stored_cents: 0, bonus_cents: 0 };
      const bonus = paymentMethod === 'balance' ? Math.min(wallet.bonus_cents, eligible, payable) : 0;
      const stored = paymentMethod === 'balance' ? payable - bonus : 0;
      if (wallet.stored_cents < stored) throw new Error('储值余额不足，请选择线下收款');
      const session = getOrCreateSession(table.store_id, table.id, member.id);
      const orderNo = `EH${Date.now()}${crypto.randomInt(100,999)}`;
      const method = paymentMethod === 'balance' ? 'balance' : 'offline';
      const id = db.prepare('INSERT INTO orders (order_no,session_id,payer_user_id,original_amount_cents,discount_amount_cents,payable_amount_cents,payment_method,stored_paid_cents,bonus_paid_cents,offline_paid_cents,pos_request_id,offline_channel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(orderNo, session.id, member.id, original, original - payable, payable, method, stored, bonus, method === 'offline' ? payable : 0, requestId, method === 'offline' ? paymentMethod : null).lastInsertRowid;
      const insert = db.prepare('INSERT INTO order_items (order_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents) VALUES (?,?,?,?,?,?,?)');
      rows.forEach(i => insert.run(id, i.product.id, i.product.name, i.quantity, i.product.price_cents, unitPrice(i.product, pricing), i.product.cost_cents));
      if (method === 'balance') {
        const changed = db.prepare('UPDATE wallet_accounts SET stored_cents = stored_cents - ?, bonus_cents = bonus_cents - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND stored_cents >= ? AND bonus_cents >= ?').run(stored, bonus, member.id, stored, bonus).changes;
        if (!changed) throw new Error('储值余额不足，请刷新后重试');
        db.prepare('INSERT INTO wallet_transactions (user_id,type,stored_cents,bonus_cents,remark) VALUES (?,?,?,?,?)').run(member.id, 'order_payment', -stored, -bonus, orderNo);
      }
      settleOrder({ id, payer_user_id: member.id, payable_amount_cents: payable }, method, req, false);
      audit(req, '收银点单', `${orderNo} 桌号 ${table.table_no} 手机尾号 ${member.phone.slice(-4)} ${paymentMethod}`);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    })();
    res.status(201).json({ orderNo: order.order_no, payable: centsToMoney(order.payable_amount_cents), storedPaid: centsToMoney(order.stored_paid_cents), bonusPaid: centsToMoney(order.bonus_paid_cents) });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

router.post('/admin/pos/recharges', (req, res) => {
  const { phone, packageId, paymentMethod, requestId } = req.body || {};
  if (!['cash','merchant_qr'].includes(paymentMethod) || !/^[a-f0-9-]{36}$/.test(String(requestId || ''))) return res.status(400).json({ message: '请选择线下收款方式' });
  const member = db.prepare(posMemberSql).get(String(phone || '').trim());
  const offer = db.prepare("SELECT * FROM wallet_packages WHERE id = ? AND status = 'active'").get(packageId);
  if (!member || !offer || offer.pay_cents <= 0 || offer.stored_cents < 0 || offer.bonus_cents < 0) return res.status(400).json({ message: '会员或储值套餐无效' });
  try {
    const transaction = db.transaction(() => {
      const prior = db.prepare('SELECT * FROM wallet_transactions WHERE pos_request_id = ?').get(requestId);
      if (prior) return prior;
      db.prepare('INSERT OR IGNORE INTO wallet_accounts (user_id) VALUES (?)').run(member.id);
      db.prepare('UPDATE wallet_accounts SET stored_cents = stored_cents + ?, bonus_cents = bonus_cents + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(offer.stored_cents, offer.bonus_cents, member.id);
      const id = db.prepare('INSERT INTO wallet_transactions (user_id,type,pay_cents,stored_cents,bonus_cents,remark,pos_request_id) VALUES (?,\'recharge\',?,?,?,?,?)').run(member.id, offer.pay_cents, offer.stored_cents, offer.bonus_cents, `${offer.name} · ${paymentMethod} · ${req.staff.username}`, requestId).lastInsertRowid;
      const before = db.prepare('SELECT member_tier_id, member_level FROM users WHERE id = ?').get(member.id);
      const after = syncMembership(member.id);
      if (before?.member_tier_id !== after?.member_tier_id) audit(req, '会员等级自动调整', `ID ${member.id}: ${before?.member_level || '普通会员'} -> ${after?.member_level || '普通会员'}`);
      audit(req, '收银储值', `${offer.name} 手机尾号 ${member.phone.slice(-4)} ${paymentMethod} ${centsToMoney(offer.pay_cents)}元`);
      return db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(id);
    })();
    queueUserMessage(member.id, 'wallet_recharged', { stored: centsToMoney(transaction.stored_cents), bonus: centsToMoney(transaction.bonus_cents) }, 'wallet_transaction', transaction.id, `储值到账：${transaction.id}`);
    res.status(201).json({ transactionId: transaction.id, pay: centsToMoney(transaction.pay_cents), stored: centsToMoney(transaction.stored_cents), bonus: centsToMoney(transaction.bonus_cents) });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

router.get('/sessions/:sessionId/checkout', (req, res) => {
  const session = db.prepare("SELECT id FROM table_sessions WHERE id = ? AND status = 'open'").get(req.params.sessionId);
  if (!session) return res.status(404).json({ message: '桌台会话不存在' });
  const userId = currentUserId(req);
  const rows = db.prepare("SELECT ci.id, ci.quantity, ci.applied_coupon_id, p.id AS product_id, p.category_id, p.price_cents, p.member_price_cents, p.allow_bonus FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? AND ci.status = 'pending'").all(session.id);
  let totals;
  try { totals = orderTotals(rows, userId, req.query.userCouponId ? Number(req.query.userCouponId) : null); }
  catch (error) { return res.status(409).json({ message: error.message }); }
  const pricing = totals.pricing;
  const payable = totals.payable;
  const bonusEligible = totals.usingCoupon ? 0 : rows.reduce((n, item) => n + (item.allow_bonus ? unitPrice(item, pricing) * item.quantity : 0), 0);
  const wallet = db.prepare('SELECT stored_cents, bonus_cents, stored_reserved_cents, bonus_reserved_cents FROM wallet_accounts WHERE user_id = ?').get(currentUserId(req)) || { stored_cents: 0, bonus_cents: 0, stored_reserved_cents: 0, bonus_reserved_cents: 0 };
  const bonusUsable = totals.usingCoupon ? 0 : Math.min(Math.max(wallet.bonus_cents - wallet.bonus_reserved_cents, 0), bonusEligible, payable);
  const storedUsable = Math.min(Math.max(wallet.stored_cents - wallet.stored_reserved_cents, 0), payable - bonusUsable);
  const balanceDeduction = bonusUsable + storedUsable;
  const wechatDue = payable - balanceDeduction;
  res.json({ original: centsToMoney(totals.original), member: centsToMoney(totals.member), payable: centsToMoney(payable), discount: centsToMoney(totals.original - payable), memberDiscount: centsToMoney(totals.original - totals.member), couponDiscount: centsToMoney(totals.couponDiscount), coupon: totals.coupon ? { id: totals.coupon.id, name: totals.coupon.name, discount: centsToMoney(totals.couponDiscount), voucherType: totals.coupon.voucher_type || 'discount', giftProductId: totals.coupon.gift_product_id || null, giftProductName: totals.coupon.gift_product_name || null } : null, usingCoupon: totals.usingCoupon, productVoucher: totals.productVoucher, giftProductId: totals.giftProductId, stored: centsToMoney(wallet.stored_cents), bonus: centsToMoney(wallet.bonus_cents), accountBalance: centsToMoney(wallet.stored_cents), accountBonus: centsToMoney(wallet.bonus_cents), bonusEligible: centsToMoney(bonusEligible), bonusUsable: centsToMoney(bonusUsable), storedUsable: centsToMoney(storedUsable), balanceDeduction: centsToMoney(balanceDeduction), wechatDue: centsToMoney(wechatDue), balanceAvailable: wechatDue === 0, mixedPaymentAvailable: balanceDeduction > 0 && wechatDue > 0, couponCannotUseBonus: totals.usingCoupon });
});

router.post('/sessions/:sessionId/orders', async (req, res) => {
  const userId = currentUserId(req);
  const method = req.body?.paymentMethod;
  const selectedCouponId = req.body?.userCouponId ? Number(req.body.userCouponId) : null;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (note.length > 200) return res.status(400).json({ message: '订单备注不能超过 200 个字' });
  if (!['balance','wechat','mixed'].includes(method)) return res.status(400).json({ message: '请选择支付方式' });
  const session = db.prepare("SELECT * FROM table_sessions WHERE id = ? AND status = 'open'").get(req.params.sessionId);
  const items = db.prepare("SELECT ci.*, p.name, p.price_cents, p.member_price_cents, p.cost_cents, p.stock, p.reserved_stock, p.allow_bonus, p.category_id FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? AND ci.status = 'pending'").all(req.params.sessionId);
  if (!session || !items.length) return res.status(400).json({ message: '桌台没有待支付商品' });
  const existing = db.prepare("SELECT o.* FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.session_id = ? AND o.payment_status = 'pending' AND oi.cart_item_id IN (SELECT id FROM cart_items WHERE session_id = ? AND status = 'pending') ORDER BY o.id DESC LIMIT 1").get(session.id, session.id);
  if (existing) return res.status(409).json({ message: `订单 ${existing.order_no} 正在等待支付，请勿重复提交` });
  const requestedQuantities = new Map();
  items.forEach(item => requestedQuantities.set(
    Number(item.product_id),
    (requestedQuantities.get(Number(item.product_id)) || 0) + Number(item.quantity)
  ));
  const insufficientItem = items.find(item => (requestedQuantities.get(Number(item.product_id)) || 0) > Math.max(item.stock - item.reserved_stock, 0));
  if (insufficientItem) return res.status(409).json({ message: `商品“${insufficientItem.name}”库存不足，请减少数量后重试` });
  let totals;
  try { totals = orderTotals(items, userId, selectedCouponId); }
  catch (error) { return res.status(409).json({ message: error.message }); }
  if (method !== 'balance' && totals.payable > 0) {
    const user = db.prepare('SELECT wechat_openid FROM users WHERE id = ?').get(userId);
    if (!user?.wechat_openid) return res.status(409).json({ message: '当前微信账号尚未完成登录绑定，请重新进入小程序' });
  }
  const pricing = totals.pricing;
  const eligible = totals.usingCoupon ? 0 : items.reduce((n, item) => n + (item.allow_bonus ? unitPrice(item, pricing) * item.quantity : 0), 0);
  const orderNo = `EH${Date.now()}${crypto.randomInt(100, 999)}`;
  try { const order = db.transaction(() => {
    const wallet = db.prepare('SELECT stored_cents, bonus_cents, stored_reserved_cents, bonus_reserved_cents FROM wallet_accounts WHERE user_id = ?').get(userId) || { stored_cents: 0, bonus_cents: 0, stored_reserved_cents: 0, bonus_reserved_cents: 0 };
    const bonus = totals.usingCoupon || method === 'wechat' ? 0 : Math.min(Math.max(wallet.bonus_cents - wallet.bonus_reserved_cents, 0), eligible, totals.payable);
    const stored = method === 'wechat' ? 0 : Math.min(Math.max(wallet.stored_cents - wallet.stored_reserved_cents, 0), totals.payable - bonus);
    const wechat = totals.payable - bonus - stored;
    if (method === 'balance' && wechat > 0) throw new Error('余额不足，请选择组合支付或微信支付');
    if (method === 'mixed' && (wechat <= 0 || bonus + stored <= 0)) throw new Error('当前订单不需要组合支付');
    const paymentExpireAt = method === 'balance' || totals.payable === 0 ? null : new Date(Date.now() + PAYMENT_EXPIRY_MS).toISOString();
    const result = db.prepare('INSERT INTO orders (order_no, session_id, payer_user_id, original_amount_cents, discount_amount_cents, payable_amount_cents, coupon_id, coupon_discount_cents, payment_method, stored_paid_cents, bonus_paid_cents, wechat_paid_cents, payment_expire_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(orderNo, session.id, userId, totals.original, totals.original - totals.payable, totals.payable, totals.coupon?.id || null, totals.couponDiscount, method, stored, bonus, wechat, paymentExpireAt, note);
    const insertItem = db.prepare('INSERT INTO order_items (order_id, cart_item_id, product_id, product_name, quantity, original_price_cents, paid_price_cents, cost_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const voucherGiftRowId = totals.productVoucher
      ? items.find(item => Number(item.applied_coupon_id) === Number(totals.coupon?.id)
        && Number(item.product_id) === Number(totals.giftProductId))?.id
      : null;
    let remainingGiftQuantity = totals.productVoucher ? 1 : 0;
    items.forEach(item => {
      // A product voucher is for one item per order. A product can be split
      // into several cart rows when multiple guests add it, so consume the
      // one free unit across rows instead of granting one free unit per row.
      const giftQuantity = totals.productVoucher && item.id === voucherGiftRowId && Number(item.product_id) === Number(totals.giftProductId)
        ? Math.min(remainingGiftQuantity, item.quantity)
        : 0;
      remainingGiftQuantity -= giftQuantity;
      const paidQuantity = item.quantity - giftQuantity;
      if (giftQuantity) insertItem.run(result.lastInsertRowid, item.id, item.product_id, `${item.name}（兑换券赠送）`, giftQuantity, item.price_cents, 0, item.cost_cents);
      if (paidQuantity) insertItem.run(result.lastInsertRowid, item.id, item.product_id, item.name, paidQuantity, item.price_cents, unitPrice(item, pricing), item.cost_cents);
    });
    lockCoupon(result.lastInsertRowid, totals.coupon?.id, userId);
    db.prepare(`UPDATE cart_items SET status = 'checking_out' WHERE session_id = ? AND status = 'pending'`).run(session.id);
    const reserve = db.prepare("UPDATE products SET reserved_stock = reserved_stock + ? WHERE id = ? AND status = 'active' AND stock - reserved_stock >= ?");
    for (const [productId, quantity] of requestedQuantities) {
      const item = items.find(row => Number(row.product_id) === productId);
      if (!reserve.run(quantity, productId, quantity).changes) throw new Error(`商品“${item?.name || '商品'}”库存不足，请刷新后重试`);
    }
    if (method === 'balance' || totals.payable === 0) {
      if (stored || bonus) {
        const changed = db.prepare('UPDATE wallet_accounts SET stored_cents = stored_cents - ?, bonus_cents = bonus_cents - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND stored_cents - stored_reserved_cents >= ? AND bonus_cents - bonus_reserved_cents >= ?').run(stored, bonus, userId, stored, bonus).changes;
        if (!changed) throw new Error('余额不足，请重新获取支付金额');
        db.prepare('INSERT INTO wallet_transactions (user_id, type, stored_cents, bonus_cents, remark) VALUES (?, ?, ?, ?, ?)').run(userId, 'order_payment', -stored, -bonus, orderNo);
      }
      settleOrder({ id: result.lastInsertRowid, payer_user_id: userId, payable_amount_cents: totals.payable, coupon_id: totals.coupon?.id || null }, method, req, true);
    }
    if (method === 'mixed') {
      const changed = db.prepare('UPDATE wallet_accounts SET stored_reserved_cents = stored_reserved_cents + ?, bonus_reserved_cents = bonus_reserved_cents + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND stored_cents - stored_reserved_cents >= ? AND bonus_cents - bonus_reserved_cents >= ?').run(stored, bonus, userId, stored, bonus).changes;
      if (!changed) throw new Error('余额不足，请重新获取支付金额');
    }
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  })();
  let payment = { provider: order.payable_amount_cents === 0 ? 'coupon' : 'balance', status: 'paid', message: order.payable_amount_cents === 0 ? '优惠券抵扣成功' : '余额支付成功' };
  if (method !== 'balance' && order.payable_amount_cents > 0) {
    try {
      const user = db.prepare('SELECT wechat_openid FROM users WHERE id = ?').get(userId);
      const result = await createJsapiPayment({ orderNo: order.order_no, description: `酒吧订单 ${order.order_no}`, totalCents: order.wechat_paid_cents, openid: user.wechat_openid });
      db.prepare('UPDATE orders SET wechat_prepay_id = ? WHERE id = ? AND payment_status = \'pending\'').run(result.prepayId, order.id);
      payment = { provider: 'wechat', status: 'pending', payment: result.payment, message: method === 'mixed' ? `余额抵扣 ${centsToMoney(order.stored_paid_cents + order.bonus_paid_cents)}，请完成微信支付` : '请完成微信支付' };
    } catch (error) {
      const cancelled = releasePendingOrder(order.id, error.message);
      if (cancelled) queueUserMessage(userId, 'order_cancelled', { orderNo: cancelled.order_no }, 'order', cancelled.id, `订单已取消：${cancelled.order_no}`);
      return res.status(error.code === 'INTEGRATION_NOT_CONFIGURED' ? 503 : 502).json({ message: error.message, code: error.code || 'WECHAT_PAYMENT_ERROR' });
    }
  }
  if (order.payment_status === 'pending') {
    queueUserMessage(userId, 'order_pending_payment', { orderNo: order.order_no, minutes: Math.ceil(PAYMENT_EXPIRY_MS / 60000) }, 'order_pending', order.id, `订单待支付：${order.order_no}`);
  }
  res.status(201).json({ order: { ...order, originalAmount: centsToMoney(order.original_amount_cents), discountAmount: centsToMoney(order.discount_amount_cents), payableAmount: centsToMoney(order.payable_amount_cents), storedPaid: centsToMoney(order.stored_paid_cents), bonusPaid: centsToMoney(order.bonus_paid_cents), wechatPaid: centsToMoney(order.wechat_paid_cents) }, payment });
  } catch (error) { res.status(409).json({ message: error.message }); }
});

// Management APIs. They intentionally stay small and REST-shaped so a real staff auth layer can be added in front later.
const adminRows = query => db.prepare(query).all();
const adminMoney = row => ({ ...row, price: row.price_cents == null ? undefined : centsToMoney(row.price_cents), memberPrice: row.member_price_cents == null ? undefined : centsToMoney(row.member_price_cents) });

function fulfillmentLabel(order) {
  return order.status === 'completed' ? '已送达' : order.payment_status === 'paid' ? '待送达' : order.payment_status === 'pending' ? '待支付' : '已取消';
}
function orderItems(orderIds) {
  if (!orderIds.length) return {};
  const grouped = {};
  const rows = db.prepare(`SELECT oi.order_id, oi.product_id, oi.product_name, oi.quantity, p.image_url FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY oi.id`).all(...orderIds);
  for (const row of rows) (grouped[row.order_id] ||= []).push(row);
  return grouped;
}
router.get('/admin/summary', (req, res) => {
  const pendingPayment = db.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'pending_payment'").get().value;
  const activeOrders = db.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'awaiting_delivery' AND payment_status = 'paid'").get().value;
  const activeTables = db.prepare("SELECT COUNT(*) AS value FROM table_sessions WHERE status = 'open'").get().value;
  const totalTables = db.prepare("SELECT COUNT(*) AS value FROM tables WHERE status != 'disabled'").get().value;
  const idleTables = Math.max(totalTables - activeTables, 0);
  const members = db.prepare("SELECT COUNT(*) AS value FROM users WHERE member_level != '普通会员'").get().value;
  const lowStock = db.prepare("SELECT COUNT(*) AS value FROM products WHERE stock - reserved_stock <= 0 OR (stock - reserved_stock <= 20 AND status = 'active')").get().value;
  const outOfStock = db.prepare('SELECT COUNT(*) AS value FROM products WHERE stock - reserved_stock <= 0').get().value;
  const canViewOrders = req.staff.role === 'super' || JSON.parse(req.staff.permissions).includes('orders');
  const pendingOrders = canViewOrders ? db.prepare("SELECT o.id, o.order_no, o.paid_at, o.note, t.table_no, u.nickname FROM orders o JOIN table_sessions ts ON ts.id = o.session_id JOIN tables t ON t.id = ts.table_id JOIN users u ON u.id = o.payer_user_id WHERE o.status = 'awaiting_delivery' AND o.payment_status = 'paid' ORDER BY o.paid_at, o.id LIMIT 50").all() : [];
  const items = orderItems(pendingOrders.map(o => o.id));
  const today = db.prepare("SELECT COALESCE(SUM(o.payable_amount_cents - o.bonus_paid_cents),0) AS revenue, COALESCE(SUM(CASE WHEN o.payment_method = 'offline' THEN o.offline_paid_cents ELSE 0 END),0) AS offline FROM orders o WHERE o.payment_status = 'paid' AND date(o.paid_at, 'localtime') = date('now','localtime')").get();
  const todayRecharge = db.prepare("SELECT COALESCE(SUM(pay_cents),0) AS value FROM wallet_transactions WHERE type = 'recharge' AND date(created_at, 'localtime') = date('now','localtime')").get().value;
  res.json({ todayRevenue: centsToMoney(today.revenue), activeOrders, pendingPayment, activeTables, idleTables, totalTables, members, lowStock, outOfStock, todayMetrics: { revenue: centsToMoney(today.revenue), recharge: centsToMoney(todayRecharge), offline: centsToMoney(today.offline) }, pendingOrders: pendingOrders.map(o => ({ ...o, items: items[o.id] || [] })), updatedAt: new Date().toISOString() });
});

router.get('/admin/products', (req, res) => { syncProductAvailability(); const { page, pageSize, offset } = parsePagination(req); const total = db.prepare('SELECT COUNT(*) AS value FROM products').get().value; const all = req.query.all === '1' || req.query.all === 'true'; const products = db.prepare(`SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC${all ? '' : ' LIMIT ? OFFSET ?'}`).all(...(all ? [] : [pageSize, offset])).map(row => { const product = { ...adminMoney(row), physicalStock: row.stock, reservedStock: row.reserved_stock, availableStock: Math.max(row.stock - row.reserved_stock, 0) }; if (req.staff.role !== 'super') delete product.cost_cents; return product; }); return res.json({ products, categories: adminRows('SELECT * FROM categories ORDER BY sort, id'), pagination: paginationView(page, pageSize, total) }); });
router.post('/admin/products', (req, res) => {
  const body = req.body || {};
  if (req.staff.role !== 'super' && body.cost != null) return res.status(403).json({ message: '仅超级管理员可设置进货价' });
  const category = db.prepare('SELECT id FROM categories WHERE id = ? OR name = ?').get(Number(body.categoryId) || 0, body.category || '啤酒');
  if (!body.name || !category) return res.status(400).json({ message: '商品名称和分类不能为空' });
  if (!Number.isInteger(Number(body.stock || 0)) || Number(body.stock || 0) < 0) return res.status(400).json({ message: '库存数量无效' });
  const result = db.prepare('INSERT INTO products (store_id, category_id, name, detail, image_url, price_cents, member_price_cents, cost_cents, tag, color, stock, allow_bonus, status, sort) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(category.id, body.name, body.detail || '', body.imageUrl || '', Math.round(Number(body.price || 0) * 100), body.memberPrice == null ? null : Math.round(Number(body.memberPrice) * 100), Math.round(Number(body.cost || 0) * 100), body.tag || '', body.color || 'amber', Number(body.stock || 0), body.allowBonus ? 1 : 0, body.status || 'active', Number(body.sort || 0));
  audit(req, '新增商品', body.name);
  const product = adminMoney(db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid));
  if (req.staff.role !== 'super') delete product.cost_cents;
  res.status(201).json({ product });
});
router.patch('/admin/products/:id', (req, res) => {
  const body = req.body || {};
  if (req.staff.role !== 'super' && body.cost != null) return res.status(403).json({ message: '仅超级管理员可设置进货价' });
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '商品不存在' });
  const category = body.categoryId ? db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(body.categoryId)) : null;
  if (body.stock != null && (!Number.isInteger(Number(body.stock)) || Number(body.stock) < 0)) return res.status(400).json({ message: '库存数量无效' });
  if (body.cost != null && (!Number.isFinite(Number(body.cost)) || Number(body.cost) < 0)) return res.status(400).json({ message: '进货价无效' });
  const nextStock = body.stock == null ? current.stock : Number(body.stock);
  const nextStatus = body.status ?? current.status;
  if (nextStock < current.reserved_stock) return res.status(409).json({ message: `实际库存不能低于待支付订单已占用的 ${current.reserved_stock} 件` });
  if (nextStatus === 'active' && nextStock - current.reserved_stock <= 0) return res.status(409).json({ message: '可售库存为零，请先补货或取消待支付订单' });
  db.prepare('UPDATE products SET name = ?, detail = ?, image_url = ?, price_cents = ?, member_price_cents = ?, cost_cents = ?, stock = ?, allow_bonus = ?, status = ?, auto_unlisted = 0, tag = ?, color = ?, category_id = COALESCE(?, category_id) WHERE id = ?').run(body.name ?? current.name, body.detail ?? current.detail, body.imageUrl == null ? current.image_url : body.imageUrl, body.price == null ? current.price_cents : Math.round(Number(body.price) * 100), body.memberPrice === '' ? null : body.memberPrice == null ? current.member_price_cents : Math.round(Number(body.memberPrice) * 100), body.cost == null ? current.cost_cents : Math.round(Number(body.cost) * 100), nextStock, body.allowBonus == null ? current.allow_bonus : (body.allowBonus ? 1 : 0), nextStatus, body.tag ?? current.tag, body.color ?? current.color, category?.id || null, req.params.id);
  audit(req, '修改商品', `${current.name} #${current.id}`);
  const product = adminMoney(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
  if (req.staff.role !== 'super') delete product.cost_cents;
  res.json({ product });
});
router.delete('/admin/products/:id', (req, res) => { db.prepare("UPDATE products SET status = 'inactive', auto_unlisted = 0 WHERE id = ?").run(req.params.id); audit(req, '下架商品', req.params.id); res.json({ ok: true }); });

router.get('/admin/categories', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const total = db.prepare('SELECT COUNT(*) AS value FROM categories').get().value; return res.json({ categories: db.prepare('SELECT c.*, COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id ORDER BY c.sort, c.id LIMIT ? OFFSET ?').all(pageSize, offset), pagination: paginationView(page, pageSize, total) }); });
router.post('/admin/categories', (req, res) => { if (!req.body.name) return res.status(400).json({ message: '分类名称不能为空' }); const r = db.prepare('INSERT INTO categories (store_id, name, sort) VALUES (1, ?, ?)').run(req.body.name, Number(req.body.sort || 0)); res.status(201).json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(r.lastInsertRowid) }); });
router.patch('/admin/categories/:id', (req, res) => { db.prepare('UPDATE categories SET name = COALESCE(?, name), sort = COALESCE(?, sort), status = COALESCE(?, status) WHERE id = ?').run(req.body.name, req.body.sort == null ? null : Number(req.body.sort), req.body.status, req.params.id); res.json({ ok: true }); });

router.get('/admin/tables', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const total = db.prepare("SELECT COUNT(*) AS value FROM tables WHERE status != 'disabled'").get().value; return res.json({ tables: db.prepare("SELECT t.*, ts.session_no, ts.status AS session_status, COALESCE(SUM(o.payable_amount_cents),0) AS order_total FROM tables t LEFT JOIN table_sessions ts ON ts.table_id = t.id AND ts.status = 'open' LEFT JOIN orders o ON o.session_id = ts.id AND o.payment_status = 'paid' WHERE t.status != 'disabled' GROUP BY t.id ORDER BY t.table_no LIMIT ? OFFSET ?").all(pageSize, offset).map(row => ({ ...row, orderTotal: centsToMoney(row.order_total) })), pagination: paginationView(page, pageSize, total) }); });
router.get('/admin/tables/:id/mini-code', async (req, res) => {
  const table = db.prepare("SELECT id, table_no FROM tables WHERE id = ? AND status != 'disabled'").get(req.params.id);
  if (!table) return res.status(404).json({ message: '桌台不存在或已停用' });
  try {
    const image = await getUnlimitedMiniProgramCode(`t_${table.id}`);
    const contentType = miniProgramCodeContentType(image);
    const extension = contentType === 'image/jpeg' ? 'jpg' : 'png';
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="table-${table.id}.${extension}"` });
    res.send(image);
  } catch (error) {
    res.status(502).json({ message: error.name === 'AbortError' ? '微信接口超时，请稍后重试' : error.message });
  }
});
router.post('/admin/tables', (req, res) => {
  const tableNo = String(req.body?.tableNo || '').trim();
  if (!tableNo || tableNo.length > 30) return res.status(400).json({ message: '桌号不能为空且不能超过 30 个字' });
  if (db.prepare('SELECT id FROM tables WHERE store_id = 1 AND table_no = ? AND status != ?').get(tableNo, 'disabled')) return res.status(409).json({ message: '这个桌号已经存在' });
  const token = `echo-${tableNo.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}`;
  const r = db.prepare('INSERT INTO tables (store_id, table_no, qr_token) VALUES (1, ?, ?)').run(tableNo, token);
  audit(req, '新增桌台', tableNo);
  res.status(201).json({ table: db.prepare('SELECT * FROM tables WHERE id = ?').get(r.lastInsertRowid) });
});
router.patch('/admin/tables/:id', (req, res) => {
  const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!table) return res.status(404).json({ message: '桌台不存在' });
  const tableNo = req.body?.tableNo == null ? table.table_no : String(req.body.tableNo).trim();
  const status = req.body?.status == null ? table.status : String(req.body.status);
  if (!tableNo || tableNo.length > 30) return res.status(400).json({ message: '桌号不能为空且不能超过 30 个字' });
  if (!['available', 'disabled'].includes(status)) return res.status(400).json({ message: '桌台状态无效' });
  if (status === 'disabled' && db.prepare("SELECT id FROM table_sessions WHERE table_id = ? AND status = 'open'").get(table.id)) return res.status(409).json({ message: '当前桌台正在使用，请先结束本桌后再停用' });
  if (db.prepare('SELECT id FROM tables WHERE store_id = ? AND table_no = ? AND id != ? AND status != ?').get(table.store_id, tableNo, table.id, 'disabled')) return res.status(409).json({ message: '这个桌号已经存在' });
  db.prepare('UPDATE tables SET table_no = ?, status = ? WHERE id = ?').run(tableNo, status, table.id);
  audit(req, status === 'disabled' ? '停用桌台' : '编辑桌台', `${table.table_no} -> ${tableNo}`);
  res.json({ ok: true });
});
router.delete('/admin/tables/:id', (req, res) => {
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND status != ?').get(req.params.id, 'disabled');
  if (!table) return res.status(404).json({ message: '桌台不存在或已停用' });
  if (db.prepare("SELECT id FROM table_sessions WHERE table_id = ? AND status = 'open'").get(table.id)) return res.status(409).json({ message: '当前桌台正在使用，请先结束本桌后再停用' });
  const hasHistory = db.prepare('SELECT id FROM table_sessions WHERE table_id = ? LIMIT 1').get(table.id);
  if (hasHistory) {
    db.prepare("UPDATE tables SET status = 'disabled' WHERE id = ?").run(table.id);
    audit(req, '删除桌台（保留历史记录）', table.table_no);
    return res.json({ ok: true, mode: 'archived', message: '桌台已从后台移除，历史订单仍保留' });
  }
  db.prepare('DELETE FROM tables WHERE id = ?').run(table.id);
  audit(req, '删除桌台', table.table_no);
  res.json({ ok: true, mode: 'deleted' });
});
router.post('/admin/tables/:id/close', (req, res) => { const session = db.prepare("SELECT id FROM table_sessions WHERE table_id = ? AND status = 'open'").get(req.params.id); if (session) { db.prepare("UPDATE table_sessions SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id); audit(req, '结束桌台', req.params.id); } res.json({ ok: true }); });

router.get('/admin/orders', (req, res) => {
  const { page, pageSize, offset } = parsePagination(req);
  const total = db.prepare('SELECT COUNT(*) AS value FROM orders').get().value;
  const rows = db.prepare("SELECT o.*, t.table_no, u.nickname, COALESCE((SELECT SUM(oi.quantity * oi.cost_price_cents) FROM order_items oi WHERE oi.order_id = o.id),0) AS cost_cents FROM orders o JOIN table_sessions ts ON ts.id = o.session_id JOIN tables t ON t.id = ts.table_id JOIN users u ON u.id = o.payer_user_id ORDER BY (o.status = 'awaiting_delivery') DESC, o.id DESC LIMIT ? OFFSET ?").all(pageSize, offset);
  const items = orderItems(rows.map(o => o.id));
  res.json({ orders: rows.map(row => { const order = { ...row, items: items[row.id] || [], statusLabel: fulfillmentLabel(row), originalAmount: centsToMoney(row.original_amount_cents), discountAmount: centsToMoney(row.discount_amount_cents), memberDiscount: centsToMoney(Math.max(0, row.discount_amount_cents - row.coupon_discount_cents)), couponDiscount: centsToMoney(row.coupon_discount_cents), payableAmount: centsToMoney(row.payable_amount_cents), storedPaid: centsToMoney(row.stored_paid_cents), bonusPaid: centsToMoney(row.bonus_paid_cents), wechatPaid: centsToMoney(row.wechat_paid_cents), netSales: centsToMoney(row.payable_amount_cents - row.bonus_paid_cents) }; delete order.cost_cents; if (req.staff.role === 'super') { order.cost = centsToMoney(row.cost_cents); order.profit = row.payment_status === 'paid' ? centsToMoney(row.payable_amount_cents - row.bonus_paid_cents - row.cost_cents) : null; } return order; }), pagination: paginationView(page, pageSize, total) });
});
router.post('/admin/orders/:id/deliver', (req, res) => {
  const result = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return { code: 404, message: '订单不存在' };
    if (order.status === 'completed') return { code: 200 };
    if (order.payment_status !== 'paid' || order.status !== 'awaiting_delivery') return { code: 409, message: '仅已支付的待送达订单可确认送达' };
    db.prepare("UPDATE orders SET status = 'completed', delivered_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
    audit(req, '确认订单送达', order.order_no);
    return { code: 200 };
  })();
  if (result.code === 200 && !result.message) {
    const order = db.prepare('SELECT payer_user_id, order_no FROM orders WHERE id = ?').get(req.params.id);
    if (order) queueUserMessage(order.payer_user_id, 'order_completed', { orderNo: order.order_no }, 'order_completed', req.params.id, `订单已送达：${order.order_no}`);
  }
  res.status(result.code).json(result.message ? { message: result.message } : { ok: true });
});
router.post('/admin/orders/:id/mark-paid', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.payment_status === 'paid') return res.json({ ok: true });
  if (order.payment_method === 'mixed') return res.status(409).json({ message: '组合支付订单需完成微信支付后再结算，不能直接确认线下收款' });
  if (order.payment_method === 'balance') return res.status(409).json({ message: '余额订单不能确认线下收款' });
  try { db.transaction(() => {
    settleOrder(order, 'offline', req);
    db.prepare('UPDATE orders SET offline_paid_cents = payable_amount_cents WHERE id = ?').run(order.id);
    audit(req, '确认线下收款', order.order_no);
  })(); res.json({ ok: true }); } catch (error) { res.status(409).json({ message: error.message }); }
});

const validPhone = phone => /^1[3-9]\d{9}$/.test(phone);
const birthdayView = row => {
  const match = getBirthdayMatchInfo(row.birthday_type, row.birthday_date);
  return { id: row.id, phone: row.phone, nickname: row.nickname, memberLevel: row.member_level, birthdayType: row.birthday_type || '', birthdayDate: row.birthday_date || '', adminNote: row.admin_note || '', daysUntil: match.daysUntil, birthdayLabel: match.label };
};
const memberView = row => ({ id: row.id, phone: row.phone, nickname: row.nickname, avatarUrl: row.avatar_url, wechatBound: Boolean(row.wechat_openid), memberTierId: row.member_tier_id, memberLevel: row.member_level, memberColor: row.member_tier_id ? (db.prepare('SELECT badge_color FROM member_tiers WHERE id = ?').get(row.member_tier_id)?.badge_color || '#C77F52') : '#C77F52', memberDiscount: row.member_discount, memberExpiresAt: row.member_expires_at, points: row.points, stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents), adminNote: row.admin_note || '', birthdayType: row.birthday_type || '', birthdayDate: row.birthday_date || '', createdAt: row.created_at });
const memberQuery = `SELECT u.*, COALESCE(w.stored_cents,0) AS stored_cents, COALESCE(w.bonus_cents,0) AS bonus_cents FROM users u LEFT JOIN wallet_accounts w ON w.user_id = u.id`;
const tiers = () => db.prepare('SELECT * FROM member_tiers WHERE store_id = 1 ORDER BY sort, id').all();
router.get('/admin/members', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (phone && !/^\d{1,11}$/.test(phone)) return res.status(400).json({ message: '请输入手机号数字' });
  const { page, pageSize, offset } = parsePagination(req);
  const where = phone ? ' WHERE u.phone LIKE ?' : '';
  const args = phone ? [`${phone}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS value FROM users u${where}`).get(...args).value;
  const rows = db.prepare(`${memberQuery}${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset);
  const birthdayRows = db.prepare(`${memberQuery} WHERE u.birthday_type IS NOT NULL AND u.birthday_date IS NOT NULL`).all();
  const birthdayMembers = birthdayRows.map(row => birthdayView({ ...row, ...syncMembership(row.id) })).filter(row => row.daysUntil != null && row.daysUntil <= 3).sort((a, b) => a.daysUntil - b.daysUntil || a.id - b.id);
  res.json({ members: rows.map(row => memberView({ ...row, ...syncMembership(row.id) })), tiers: tiers(), birthdays: { today: birthdayMembers.filter(row => row.daysUntil === 0), upcoming: birthdayMembers.filter(row => row.daysUntil > 0) }, pagination: paginationView(page, pageSize, total) });
});
router.post('/admin/members', (req, res) => {
  const phone = String(req.body?.phone || '').trim(), nickname = String(req.body?.nickname || '').trim();
  if (!validPhone(phone) || !nickname || nickname.length > 50) return res.status(400).json({ message: '请输入有效手机号和姓名' });
  try { const id = db.prepare('INSERT INTO users (phone, nickname) VALUES (?, ?)').run(phone, nickname).lastInsertRowid; audit(req, '创建会员', `ID ${id} 手机尾号 ${phone.slice(-4)}`); res.status(201).json({ member: memberView(db.prepare(`${memberQuery} WHERE u.id = ?`).get(id)) }); }
  catch { res.status(409).json({ message: '手机号已绑定其他会员' }); }
});
router.patch('/admin/members/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '会员不存在' });
  const b = req.body || {}, phone = String(b.phone ?? current.phone ?? '').trim(), nickname = String(b.nickname ?? current.nickname).trim();
  const tierId = b.memberTierId === '' ? null : b.memberTierId == null ? current.member_tier_id : Number(b.memberTierId);
  const tier = tierId == null ? null : db.prepare("SELECT * FROM member_tiers WHERE id = ? AND store_id = 1 AND status = 'active'").get(tierId);
  const points = b.points == null ? current.points : Number(b.points);
  const birthday = b.birthdayType == null && b.birthdayDate == null ? { type: current.birthday_type || '', date: current.birthday_date || '' } : normalizeBirthday(b.birthdayType, b.birthdayDate);
  const adminNote = b.adminNote == null ? current.admin_note || '' : String(b.adminNote).trim();
  const moneyInput = value => value == null ? null : value === '' || !Number.isFinite(Number(value)) || !Number.isSafeInteger(Number(value) * 100) ? NaN : Math.round(Number(value) * 100);
  const stored = moneyInput(b.stored), bonus = moneyInput(b.bonus);
  const walletBefore = db.prepare('SELECT stored_cents, bonus_cents FROM wallet_accounts WHERE user_id = ?').get(current.id) || { stored_cents: 0, bonus_cents: 0 };
  const moneyChanged = (stored != null && stored !== walletBefore.stored_cents) || (bonus != null && bonus !== walletBefore.bonus_cents);
  const manualTierSelection = b.memberTierId != null;
  const changedTier = tierId !== current.member_tier_id;
  const defaultExpiry = changedTier ? (tier?.duration_days ? new Date(Date.now() + tier.duration_days * 86400000) : null) : current.member_expires_at;
  const expiry = b.memberExpiresAt ? new Date(`${b.memberExpiresAt}T23:59:59.999+08:00`) : defaultExpiry;
  if ((phone && !validPhone(phone)) || !nickname || nickname.length > 50 || (tierId != null && !tier) || !birthday || adminNote.length > 500 || !Number.isSafeInteger(points) || points < 0 || [stored,bonus].some(v => v != null && (!Number.isSafeInteger(v) || v < 0)) || (expiry instanceof Date && Number.isNaN(expiry.getTime()))) return res.status(400).json({ message: '会员信息、等级、生日或余额无效' });
  if ((points !== current.points || moneyChanged) && !String(b.reason || '').trim()) return res.status(400).json({ message: '调整积分或钱包余额必须填写原因' });
  try {
    db.transaction(() => {
      db.prepare('UPDATE users SET phone = ?, nickname = ?, member_tier_id = ?, member_pending_tier_id = ?, member_level = ?, member_discount = ?, member_expires_at = ?, member_cycle_started_at = ?, points = ?, admin_note = ?, birthday_type = ?, birthday_date = ? WHERE id = ?').run(phone || null, nickname, tierId, manualTierSelection ? null : current.member_pending_tier_id, tier?.name || '普通会员', tier?.discount || 1, expiry instanceof Date ? expiry.toISOString() : expiry, manualTierSelection ? new Date().toISOString() : current.member_cycle_started_at, points, adminNote, birthday.type || null, birthday.date || null, current.id);
      if (points !== current.points) db.prepare('INSERT INTO points_ledger (user_id, points, reason) VALUES (?, ?, ?)').run(current.id, points - current.points, `后台调整：${String(b.reason || '').trim()}`);
      if (stored != null || bonus != null) {
        db.prepare('INSERT OR IGNORE INTO wallet_accounts (user_id) VALUES (?)').run(current.id);
        const wallet = db.prepare('SELECT * FROM wallet_accounts WHERE user_id = ?').get(current.id);
        const storedDelta = (stored ?? wallet.stored_cents) - wallet.stored_cents, bonusDelta = (bonus ?? wallet.bonus_cents) - wallet.bonus_cents;
        if (storedDelta || bonusDelta) {
          db.prepare('UPDATE wallet_accounts SET stored_cents = ?, bonus_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(stored ?? wallet.stored_cents, bonus ?? wallet.bonus_cents, current.id);
          db.prepare('INSERT INTO wallet_transactions (user_id, type, stored_cents, bonus_cents, remark) VALUES (?, ?, ?, ?, ?)').run(current.id, 'admin_adjustment', storedDelta, bonusDelta, `后台调整：${String(b.reason || '').trim()}`);
        }
      }
      audit(req, '修改会员', `ID ${current.id} 手机尾号 ${phone.slice(-4)}: ${String(b.reason || '').trim()}`);
    })();
    res.json({ member: memberView(db.prepare(`${memberQuery} WHERE u.id = ?`).get(current.id)) });
  } catch (error) { res.status(409).json({ message: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '手机号已绑定其他会员' : error.message }); }
});
router.delete('/admin/members/:id', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可删除会员' });
  const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!member) return res.status(404).json({ message: '会员不存在' });
  const blockers = [
    ['orders', '订单记录', 'payer_user_id'],
    ['cart_items', '购物车记录', 'added_by_user_id'],
    ['points_ledger', '积分流水', 'user_id'],
    ['storage_records', '存酒记录', 'user_id'],
    ['reward_redemptions', '积分兑换记录', 'user_id'],
    ['wallet_transactions', '储值流水', 'user_id']
  ];
  const usedBy = blockers.find(([table, _label, column]) => db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(member.id));
  if (usedBy) return res.status(409).json({ message: `该会员存在${usedBy[1]}，为保护账务和历史记录不能删除` });
  const wallet = db.prepare('SELECT stored_cents, bonus_cents, stored_reserved_cents, bonus_reserved_cents FROM wallet_accounts WHERE user_id = ?').get(member.id);
  if (wallet && [wallet.stored_cents, wallet.bonus_cents, wallet.stored_reserved_cents, wallet.bonus_reserved_cents].some(value => Number(value) > 0)) return res.status(409).json({ message: '该会员还有余额或冻结金额，不能删除' });
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM session_members WHERE user_id = ?').run(member.id);
      db.prepare('DELETE FROM wechat_sessions WHERE user_id = ?').run(member.id);
      db.prepare('DELETE FROM wallet_accounts WHERE user_id = ?').run(member.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(member.id);
      audit(req, '删除会员', `ID ${member.id} 手机尾号 ${member.phone?.slice(-4) || '未绑定'}`);
    })();
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ message: error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ? '该会员存在关联数据，无法删除' : error.message });
  }
});
const ownProfile = req => db.prepare('SELECT id, nickname, phone, avatar_url, member_level, member_tier_id, member_pending_tier_id, points, member_expires_at, birthday_type, birthday_date FROM users WHERE id = ?').get(currentUserId(req));
router.get('/me', (req, res) => { const row = ownProfile(req); if (!row) return res.status(404).json({ message: '用户不存在' }); const synced = syncMembership(row.id); const wallet = db.prepare('SELECT stored_cents, bonus_cents FROM wallet_accounts WHERE user_id = ?').get(row.id) || { stored_cents: 0, bonus_cents: 0 }; res.json({ user: publicUser(synced), wallet: { stored: centsToMoney(wallet.stored_cents), bonus: centsToMoney(wallet.bonus_cents) }, membership: membershipProgress(row.id) }); });
router.post('/me/avatar', express.raw({ type: ['application/octet-stream', 'multipart/form-data'], limit: '3mb' }), async (req, res) => {
  let bytes = req.body;
  const contentType = req.header('content-type') || '';
  if (Buffer.isBuffer(bytes) && contentType.startsWith('multipart/form-data')) {
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
    if (boundary) {
      const headerEnd = bytes.indexOf(Buffer.from('\r\n\r\n'));
      const fileEnd = bytes.lastIndexOf(Buffer.from(`\r\n--${boundary}`));
      if (headerEnd >= 0 && fileEnd > headerEnd) bytes = bytes.subarray(headerEnd + 4, fileEnd);
    }
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 100 || bytes.length > 2 * 1024 * 1024) return res.status(400).json({ message: '请选择小于 2MB 的头像' });
  const extension = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpg'
    : bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!extension) return res.status(400).json({ message: '头像仅支持 JPEG、PNG 或 WebP 图片' });
  try {
    const upload = await saveUpload({ bytes, extension, contentType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` });
    res.status(201).json({ avatarUrl: upload.url });
  } catch (error) { res.status(error.code === 'STORAGE_NOT_CONFIGURED' ? 503 : 502).json({ message: error.message }); }
});
router.patch('/me/profile', (req, res) => {
  const user = ownProfile(req);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  const body = req.body || {};
  const hasIdentity = Object.hasOwn(body, 'nickname') || Object.hasOwn(body, 'avatarUrl');
  const nickname = hasIdentity ? String(body.nickname || '').trim() : user.nickname;
  const avatarUrl = hasIdentity ? String(body.avatarUrl || '').trim() : user.avatar_url;
  if (hasIdentity && (!nickname || nickname === '微信用户' || nickname.length > 50 || !isAllowedImageUrl(avatarUrl))) return res.status(400).json({ message: '请填写昵称并选择有效头像' });
  db.prepare('UPDATE users SET nickname = ?, avatar_url = ? WHERE id = ?').run(nickname, avatarUrl, user.id);
  res.json({ user: publicUser(ownProfile(req)) });
});
router.patch('/me/birthday', (req, res) => {
  const user = ownProfile(req);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  if (user.birthday_type && user.birthday_date) return res.status(409).json({ message: '生日已经设置，不能重复修改；如需调整请联系管理员' });
  const birthday = normalizeBirthday(req.body?.birthdayType, req.body?.birthdayDate);
  if (!birthday?.type || !birthday.date) return res.status(400).json({ message: '请选择生日类型和日期' });
  db.prepare('UPDATE users SET birthday_type = ?, birthday_date = ? WHERE id = ?').run(birthday.type, birthday.date, user.id);
  res.json({ user: publicUser(ownProfile(req)) });
});
router.post('/me/phone', async (req, res) => {
  if (!req.user) return res.status(401).json({ message: '请先使用微信登录' });
  const code = String(req.body?.code || '').trim();
  if (!code || code.length > 256) return res.status(400).json({ message: '手机号授权 code 无效' });
  try {
    const info = await getWechatPhoneNumber(code);
    const phone = String(info.purePhoneNumber || '');
    if (!validPhone(phone) || info.countryCode !== '86') return res.status(422).json({ message: '目前仅支持绑定中国大陆手机号' });
    const other = db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, req.user.id);
    if (other) return res.status(409).json({ message: '此手机号已属于其他会员，请联系店员核对账户，避免余额或积分混用' });
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);
    res.json({ user: publicUser(ownProfile(req)) });
  } catch (error) { res.status(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : error.status || 502).json({ message: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? '此手机号已绑定其他会员' : error.message, code: error.code || 'WECHAT_PHONE_ERROR' }); }
});
const miniEntries = {
  app_name: { title: 'Echo HX Live Bar', type: 'text' },
  home_title: { title: '今晚喝点什么？', type: 'text' },
  rewards: { title: '兑换中心', icon: 'gift', type: 'entry' },
  storage: { title: '我的存酒', icon: 'bottle', type: 'entry' },
  recharge: { title: '会员充值', icon: 'wallet', type: 'entry' },
  orders: { title: '我的订单', icon: 'receipt', type: 'entry' },
  coupons: { title: '我的券包', icon: 'gift', type: 'entry' },
  messages: { title: '消息中心', icon: 'card', type: 'entry' }
};
const miniIcons = ['gift','bottle','wallet','receipt','star','glass','card','bag'];
router.get('/mini-page', (_req, res) => {
  const saved = Object.fromEntries(db.prepare('SELECT * FROM mini_page_settings').all().map(row => [row.key, row]));
  res.json({ entries: Object.entries(miniEntries).map(([key, defaults]) => ({ key, title: saved[key]?.title || defaults.title, icon: saved[key]?.icon || defaults.icon, type: defaults.type })) });
});
router.get('/wallet-packages', (_req, res) => res.json({ packages: db.prepare("SELECT id, name, pay_cents, stored_cents, bonus_cents FROM wallet_packages WHERE status = 'active' ORDER BY pay_cents").all().map(row => ({ id: row.id, name: row.name, pay: centsToMoney(row.pay_cents), stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) })) }));
const rewardQuery = 'SELECT r.*, p.image_url AS product_image, p.name AS product_name FROM reward_items r LEFT JOIN products p ON p.id = r.product_id';
const rewardView = row => ({ ...row, imageUrl: row.image_url || row.product_image || '', name: row.product_id ? row.product_name : row.name });
router.get('/rewards', (_req, res) => res.json({ rewards: db.prepare(`${rewardQuery} WHERE r.status = 'active' ORDER BY r.id DESC`).all().map(rewardView) }));
router.get('/me/redemptions', (req, res) => res.json({ redemptions: db.prepare('SELECT * FROM reward_redemptions WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(currentUserId(req)) }));
router.post('/rewards/:id/redeem', requireWechatUser, (req, res) => {
  try {
    const record = db.transaction(() => {
      const reward = db.prepare("SELECT * FROM reward_items WHERE id = ? AND status = 'active'").get(req.params.id);
      if (!reward) throw new Error('奖品已下架');
      if (reward.product_id) {
        const product = db.prepare("SELECT stock, reserved_stock FROM products WHERE id = ? AND status = 'active'").get(reward.product_id);
        if (!product || product.stock - product.reserved_stock < 1) throw new Error('商品可售库存不足');
      }
      const user = db.prepare('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?').run(reward.points, currentUserId(req), reward.points);
      if (!user.changes) throw new Error('积分不足');
      const stock = db.prepare('UPDATE reward_items SET stock = stock - 1 WHERE id = ? AND stock > 0').run(reward.id);
      if (!stock.changes) throw new Error('奖品库存不足');
      if (reward.product_id) {
        const changed = db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ? AND stock - reserved_stock >= 1').run(reward.product_id);
        if (!changed.changes) throw new Error('商品可售库存不足');
      }
      const id = db.prepare('INSERT INTO reward_redemptions (user_id, reward_id, reward_name, points) VALUES (?, ?, ?, ?)').run(currentUserId(req), reward.id, reward.name, reward.points).lastInsertRowid;
      db.prepare('INSERT INTO points_ledger (user_id, points, reason) VALUES (?, ?, ?)').run(currentUserId(req), -reward.points, `兑换奖品：${reward.name}`);
      return db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(id);
    })();
    queueUserMessage(currentUserId(req), 'reward_redeemed', { rewardName: record.reward_name }, 'redemption', record.id, `积分兑换成功：${record.reward_name}`);
    res.status(201).json({ redemption: record });
  } catch (error) { res.status(409).json({ message: error.message }); }
});
router.get('/me/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE payer_user_id = ? AND hidden_by_user = 0 ORDER BY id DESC LIMIT 100').all(currentUserId(req)).map(row => {
    const paymentExpireAt = orderExpiryAt(row);
    const isExpired = Boolean(row.payment_status === 'pending' && paymentExpireAt && new Date(paymentExpireAt) <= new Date());
    return { ...row, originalAmount: centsToMoney(row.original_amount_cents), discountAmount: centsToMoney(row.discount_amount_cents), memberDiscount: centsToMoney(row.discount_amount_cents - row.coupon_discount_cents), couponDiscount: centsToMoney(row.coupon_discount_cents), payableAmount: centsToMoney(row.payable_amount_cents), storedPaid: centsToMoney(row.stored_paid_cents), bonusPaid: centsToMoney(row.bonus_paid_cents), wechatPaid: centsToMoney(row.wechat_paid_cents), paymentMethodLabel: ({ balance: '余额支付', mixed: '余额 + 微信支付', wechat: '微信支付', offline: '线下收款' })[row.payment_method] || '其他', paymentStatusLabel: row.payment_status === 'paid' ? '已支付' : row.payment_status === 'pending' ? (isExpired ? '支付已过期' : '待支付') : '已取消', fulfillmentLabel: fulfillmentLabel(row), paymentExpireAt, isExpired, canPay: row.payment_status === 'pending' && !isExpired && ['wechat', 'mixed'].includes(row.payment_method), canCancel: row.payment_status === 'pending', canHide: row.payment_status !== 'pending' };
  });
  res.json({ orders });
});
router.post('/me/orders/:orderNo/hide', (req, res) => {
  const order = db.prepare('SELECT id, payment_status FROM orders WHERE order_no = ? AND payer_user_id = ?').get(req.params.orderNo, currentUserId(req));
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.payment_status === 'pending') return res.status(409).json({ message: '待支付订单不能隐藏，请先支付或取消' });
  db.prepare('UPDATE orders SET hidden_by_user = 1 WHERE id = ?').run(order.id);
  res.json({ ok: true });
});
function storageView(row) {
  const remainingDays = Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 86400000));
  const expiresDate = row.expires_at.slice(0, 10);
  return { ...row, expiresAt: row.expires_at, expiresDate, remainingDays, expired: new Date(row.expires_at) <= new Date(), statusLabel: row.status === 'collected' ? '已取完' : new Date(row.expires_at) <= new Date() ? '已过期' : '存放中' };
}
router.get('/me/storage', (req, res) => res.json({ records: db.prepare("SELECT s.*, p.image_url, p.color FROM storage_records s LEFT JOIN products p ON p.id = s.product_id WHERE s.user_id = ? AND s.status = 'stored' AND s.quantity > 0 ORDER BY s.id DESC").all(currentUserId(req)).map(storageView) }));
router.get('/admin/inventory', (_req, res) => res.json({ products: adminRows('SELECT id, name, stock, reserved_stock, status, allow_bonus FROM products ORDER BY stock - reserved_stock, id').map(row => ({ ...row, physicalStock: row.stock, reservedStock: row.reserved_stock, availableStock: Math.max(row.stock - row.reserved_stock, 0), warning: row.stock - row.reserved_stock <= 20 })) }));
router.post('/admin/inventory/:productId/adjust', (req, res) => {
  const product = db.prepare('SELECT stock, reserved_stock FROM products WHERE id = ?').get(req.params.productId);
  if (!product) return res.status(404).json({ message: '商品不存在' });
  const change = Number(req.body.change), reason = String(req.body.reason || '').trim();
  if (!Number.isInteger(change) || change === 0 || !reason) return res.status(400).json({ message: '请输入非零变动数量和原因' });
  try {
    const result = db.transaction(() => {
      const updated = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND (? > 0 OR stock - reserved_stock >= ?)').run(change, req.params.productId, change, Math.max(-change, 0));
      if (!updated.changes) {
        const latest = db.prepare('SELECT stock, reserved_stock FROM products WHERE id = ?').get(req.params.productId);
        throw new Error(`实际库存不能低于待支付订单已占用的 ${latest?.reserved_stock ?? product.reserved_stock} 件，或库存已被其他操作改变，请刷新后重试`);
      }
      const current = db.prepare('SELECT stock, reserved_stock FROM products WHERE id = ?').get(req.params.productId);
      db.prepare('INSERT INTO inventory_logs (product_id, change_quantity, stock_after, reason) VALUES (?, ?, ?, ?)').run(req.params.productId, change, current.stock, reason);
      audit(req, '调整库存', `${req.params.productId}: ${change}, ${reason}`);
      return current;
    })();
    res.json({ ok: true, stock: result.stock, physicalStock: result.stock, reservedStock: result.reserved_stock, availableStock: Math.max(result.stock - result.reserved_stock, 0) });
  } catch (error) { res.status(409).json({ message: error.message }); }
});
router.get('/admin/losses', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const total = db.prepare('SELECT COUNT(*) AS value FROM stock_losses').get().value; return res.json({ records: db.prepare('SELECT l.*, p.name AS product_name, a.display_name AS operator FROM stock_losses l JOIN products p ON p.id = l.product_id JOIN staff_accounts a ON a.id = l.operator_id ORDER BY l.id DESC LIMIT ? OFFSET ?').all(pageSize, offset).map(row => { const record = { ...row }; delete record.cost_cents; if (req.staff.role === 'super') record.cost = centsToMoney(row.cost_cents); return record; }), pagination: paginationView(page, pageSize, total) }); });
router.post('/admin/losses', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.body?.productId);
  const quantity = Number(req.body?.quantity), type = req.body?.type, reason = String(req.body?.reason || '').trim();
  if (!product || !Number.isInteger(quantity) || quantity < 1 || !['gift','damage'].includes(type) || !reason) return res.status(400).json({ message: '请选择商品、数量、类型并填写原因' });
  try { const record = db.transaction(() => { const updated = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock - reserved_stock >= ?').run(quantity, product.id, quantity); if (!updated.changes) throw new Error(`可售库存不足，已有 ${product.reserved_stock} 件被待支付订单占用`); const r = db.prepare('INSERT INTO stock_losses (product_id, quantity, cost_cents, type, reason, operator_id) VALUES (?, ?, ?, ?, ?, ?)').run(product.id, quantity, product.cost_cents * quantity, type, reason, req.staff.id); audit(req, type === 'gift' ? '上报赠酒' : '上报报损', `${product.name} x${quantity}: ${reason}`); return db.prepare('SELECT * FROM stock_losses WHERE id = ?').get(r.lastInsertRowid); })(); if (req.staff.role !== 'super') delete record.cost_cents; res.status(201).json({ record }); } catch (error) { res.status(409).json({ message: error.message }); }
});

router.get('/admin/storage', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (phone && !/^\d{1,11}$/.test(phone)) return res.status(400).json({ message: '请输入手机号数字' });
  const { page, pageSize, offset } = parsePagination(req);
  const where = phone ? ' AND u.phone LIKE ?' : '';
  const args = phone ? [`${phone}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS value FROM storage_records s JOIN users u ON u.id = s.user_id WHERE s.status = 'stored' AND s.quantity > 0${where}`).get(...args).value;
  const all = db.prepare(`SELECT s.*, u.nickname, u.phone FROM storage_records s JOIN users u ON u.id = s.user_id WHERE s.status = 'stored' AND s.quantity > 0${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset).map(row => ({ ...row, expired: new Date(row.expires_at) < new Date() }));
  const statsRows = db.prepare("SELECT quantity, expires_at FROM storage_records WHERE status = 'stored' AND quantity > 0").all();
  const movementPagination = parsePagination(req, 'movements');
  const movements = db.prepare(`SELECT m.*, s.product_name, u.nickname, u.phone FROM storage_movements m JOIN storage_records s ON s.id = m.record_id JOIN users u ON u.id = s.user_id WHERE 1 = 1${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(...args, movementPagination.pageSize, movementPagination.offset);
  const movementTotal = db.prepare(`SELECT COUNT(*) AS value FROM storage_movements m JOIN storage_records s ON s.id = m.record_id JOIN users u ON u.id = s.user_id WHERE 1 = 1${where}`).get(...args).value;
  res.json({ records: all, movements, stats: { remaining: statsRows.filter(r => new Date(r.expires_at) >= new Date()).reduce((n, r) => n + r.quantity, 0), expiring: statsRows.filter(r => new Date(r.expires_at) >= new Date() && new Date(r.expires_at) < new Date(Date.now() + 7 * 86400000)).length }, pagination: paginationView(page, pageSize, total), movementsPagination: paginationView(movementPagination.page, movementPagination.pageSize, movementTotal) });
});
router.post('/admin/storage', (req, res) => {
  const { productId, note = '' } = req.body || {};
  const phone = String(req.body?.phone || '').trim();
  const days = Number(req.body?.days);
  const quantity = Number(req.body?.quantity);
  const product = db.prepare("SELECT id, name FROM products WHERE id = ? AND status = 'active'").get(productId);
  const user = validPhone(phone) && db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  const expiry = new Date(Date.now() + days * 86400000);
  if (!product || !user || !Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ message: '请输入已绑定的会员手机号、在售商品及有效数量和天数' });
  const record = db.transaction(() => {
    const r = db.prepare('INSERT INTO storage_records (user_id, store_id, product_id, product_name, quantity, expires_at, note) VALUES (?, 1, ?, ?, ?, ?, ?)').run(user.id, product.id, product.name, quantity, expiry.toISOString(), String(note).trim());
    db.prepare('INSERT INTO storage_movements (record_id, type, quantity, operator, note) VALUES (?, ?, ?, ?, ?)').run(r.lastInsertRowid, 'deposit', quantity, req.staff.username, String(note).trim());
    audit(req, '登记存酒', `${user.id}: ${product.name} x${quantity}`);
    return db.prepare('SELECT * FROM storage_records WHERE id = ?').get(r.lastInsertRowid);
  })();
  queueUserMessage(user.id, 'storage_deposited', {
    productName: record.product_name,
    quantity: record.quantity,
    expireAt: String(record.expires_at).slice(0, 10)
  }, 'storage_deposit', record.id, `存酒成功：${record.product_name}`);
  res.status(201).json({ record: storageView(record), expiresAt: expiry.toISOString(), days });
});
router.post('/admin/storage/:id/withdraw', (req, res) => {
  const quantity = Number(req.body?.quantity);
  const record = db.prepare('SELECT * FROM storage_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ message: '存酒记录不存在' });
  if (record.status !== 'stored' || new Date(record.expires_at) < new Date()) return res.status(409).json({ message: '该存酒已取完或过期' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > record.quantity) return res.status(400).json({ message: `取酒数量须为 1 至 ${record.quantity}` });
  db.transaction(() => {
    db.prepare("UPDATE storage_records SET quantity = quantity - ?, status = CASE WHEN quantity = ? THEN 'collected' ELSE status END WHERE id = ?").run(quantity, quantity, record.id);
    db.prepare('INSERT INTO storage_movements (record_id, type, quantity, operator, note) VALUES (?, ?, ?, ?, ?)').run(record.id, 'withdraw', quantity, req.staff.username, String(req.body.note || '').trim());
    audit(req, '取酒', `${record.id}: ${record.product_name} x${quantity}`);
  })();
  const updated = db.prepare('SELECT * FROM storage_records WHERE id = ?').get(record.id);
  const movement = db.prepare("SELECT id FROM storage_movements WHERE record_id = ? AND type = 'withdraw' ORDER BY id DESC LIMIT 1").get(record.id);
  queueUserMessage(record.user_id, 'storage_withdrawn', {
    productName: record.product_name,
    quantity,
    remainingQuantity: updated.quantity,
    expireAt: String(record.expires_at).slice(0, 10)
  }, 'storage_withdraw', movement?.id || record.id, `取酒成功：${record.product_name}`);
  res.json({ record: updated });
});

router.get('/admin/group-buy', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const total = db.prepare('SELECT COUNT(*) AS value FROM group_buy_records').get().value; return res.json({ records: db.prepare('SELECT * FROM group_buy_records ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset), pagination: paginationView(page, pageSize, total) }); });
router.post('/admin/group-buy/verify', (req, res) => { if (!req.body.platform || !req.body.voucherNo) return res.status(400).json({ message: '平台和券码不能为空' }); const existing = db.prepare('SELECT id FROM group_buy_records WHERE platform = ? AND voucher_no = ?').get(req.body.platform, req.body.voucherNo); if (existing) return res.status(409).json({ message: '该券码已核销' }); const r = db.prepare('INSERT INTO group_buy_records (store_id, platform, voucher_no, package_name, amount_cents, verified_by) VALUES (1, ?, ?, ?, ?, ?)').run(req.body.platform, req.body.voucherNo, req.body.packageName || '团购套餐', Math.round(Number(req.body.amount || 0) * 100), req.staff.username); audit(req, '录入团购券', `${req.body.platform}: ${req.body.voucherNo}`); res.status(201).json({ record: db.prepare('SELECT * FROM group_buy_records WHERE id = ?').get(r.lastInsertRowid), message: '核销记录已保存，真实平台查券接口需配置商户授权' }); });

router.get('/admin/wallet-packages', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const balance = db.prepare('SELECT COALESCE(SUM(stored_cents),0) AS stored, COALESCE(SUM(bonus_cents),0) AS bonus FROM wallet_accounts').get(); const total = db.prepare('SELECT COUNT(*) AS value FROM wallet_packages').get().value; return res.json({ packages: db.prepare('SELECT * FROM wallet_packages ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset).map(row => ({ ...row, pay: centsToMoney(row.pay_cents), stored: centsToMoney(row.stored_cents), bonus: centsToMoney(row.bonus_cents) })), outstanding: { stored: centsToMoney(balance.stored), bonus: centsToMoney(balance.bonus) }, pagination: paginationView(page, pageSize, total) }); });
router.get('/admin/rewards', (req, res) => { const { page, pageSize, offset } = parsePagination(req); const redemptionPage = parsePagination(req, 'redemptions'); const total = db.prepare('SELECT COUNT(*) AS value FROM reward_items').get().value; const redemptionTotal = db.prepare('SELECT COUNT(*) AS value FROM reward_redemptions').get().value; return res.json({ rewards: db.prepare(`${rewardQuery} ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(pageSize, offset).map(rewardView), redemptions: db.prepare('SELECT rr.*, u.nickname, u.phone FROM reward_redemptions rr JOIN users u ON u.id = rr.user_id ORDER BY rr.id DESC LIMIT ? OFFSET ?').all(redemptionPage.pageSize, redemptionPage.offset), pagination: paginationView(page, pageSize, total), redemptionsPagination: paginationView(redemptionPage.page, redemptionPage.pageSize, redemptionTotal) }); });
router.post('/admin/rewards/redemptions/:id/fulfill', (req, res) => {
  const record = db.prepare('SELECT * FROM reward_redemptions WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ message: '兑换记录不存在' });
  if (record.status !== 'pending') return res.status(409).json({ message: '奖品已领取' });
  db.transaction(() => { db.prepare("UPDATE reward_redemptions SET status = 'fulfilled' WHERE id = ? AND status = 'pending'").run(record.id); audit(req, '发放积分奖品', `${record.reward_name} #${record.id}`); })();
  res.json({ ok: true });
});
const rewardInput = (body, current = {}) => {
  const productId = body.productId === '' ? null : body.productId == null ? current.product_id ?? null : Number(body.productId);
  const product = productId == null ? null : db.prepare('SELECT id, name, image_url FROM products WHERE id = ?').get(productId);
  const name = String(body.name ?? current.name ?? '').trim(), imageUrl = String(body.imageUrl ?? current.image_url ?? '').trim();
  const points = Number(body.points ?? current.points), stock = Number(body.stock ?? current.stock ?? 0), status = body.status ?? current.status ?? 'active';
  if ((productId != null && !product) || (!product && (!name || name.length > 50)) || !Number.isSafeInteger(points) || points < 1 || !Number.isSafeInteger(stock) || stock < 0 || !['active','inactive'].includes(status)) return null;
  return { productId, name: product?.name || name, imageUrl, points, stock, status };
};
router.post('/admin/rewards', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可配置积分奖品' });
  const item = rewardInput(req.body || {});
  if (!item) return res.status(400).json({ message: '奖品、积分或库存无效' });
  const id = db.prepare('INSERT INTO reward_items (product_id, name, image_url, points, stock, status) VALUES (?, ?, ?, ?, ?, ?)').run(item.productId, item.name, item.imageUrl, item.points, item.stock, item.status).lastInsertRowid;
  audit(req, '新增积分奖品', item.name); res.status(201).json({ reward: db.prepare('SELECT * FROM reward_items WHERE id = ?').get(id) });
});
router.patch('/admin/rewards/:id', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可配置积分奖品' });
  const current = db.prepare('SELECT * FROM reward_items WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ message: '奖品不存在' });
  const item = rewardInput(req.body || {}, current);
  if (!item) return res.status(400).json({ message: '奖品、积分或库存无效' });
  db.prepare('UPDATE reward_items SET product_id = ?, name = ?, image_url = ?, points = ?, stock = ?, status = ? WHERE id = ?').run(item.productId, item.name, item.imageUrl, item.points, item.stock, item.status, current.id);
  audit(req, '修改积分奖品', item.name); res.json({ ok: true });
});
router.get('/admin/mini-page', (_req, res) => res.json({ entries: Object.entries(miniEntries).map(([key, defaults]) => ({ key, ...defaults, ...db.prepare('SELECT title, icon FROM mini_page_settings WHERE key = ?').get(key) })), icons: miniIcons }));
router.put('/admin/mini-page', (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ message: '仅超级管理员可修改小程序页面' });
  const entries = req.body?.entries;
  const valid = Array.isArray(entries) && entries.length === Object.keys(miniEntries).length && new Set(entries.map(item => item.key)).size === entries.length && entries.every(item => {
    const definition = miniEntries[item.key];
    const title = String(item.title || '').trim();
    return definition && title && title.length <= (definition.type === 'text' ? 30 : 8) && (definition.type === 'text' || miniIcons.includes(item.icon));
  });
  if (!valid) return res.status(400).json({ message: '小程序名称、首页标题或页面入口配置无效' });
  db.transaction(() => { for (const item of entries) db.prepare('INSERT INTO mini_page_settings (key, title, icon) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET title = excluded.title, icon = excluded.icon').run(item.key, item.title.trim(), item.icon || miniEntries[item.key].icon || ''); audit(req, '修改小程序页面', entries.map(item => item.title).join('、')); })();
  res.json({ ok: true });
});
router.post('/admin/wallet-packages', (req, res) => { const r = db.prepare('INSERT INTO wallet_packages (store_id, name, pay_cents, stored_cents, bonus_cents, allow_bonus) VALUES (1, ?, ?, ?, ?, ?)').run(req.body.name, Math.round(Number(req.body.pay || 0) * 100), Math.round(Number(req.body.stored || 0) * 100), Math.round(Number(req.body.bonus || 0) * 100), req.body.allowBonus ? 1 : 0); audit(req, '新增储值套餐', req.body.name); res.status(201).json({ package: db.prepare('SELECT * FROM wallet_packages WHERE id = ?').get(r.lastInsertRowid) }); });

router.get('/admin/member-tiers', (_req, res) => res.json({ tiers: tiers() }));
const tierInput = (body, current = {}) => {
  const name = String(body.name ?? current.name ?? '').trim(), upgradeType = body.upgradeType ?? current.upgrade_type ?? 'spend';
  const moneyCents = (value, fallback = 0) => {
    const number = Number(value ?? fallback);
    return Number.isFinite(number) ? Math.round(number * 100) : NaN;
  };
  const legacyThreshold = moneyCents(body.threshold, centsToMoney(current.threshold_cents || 0));
  const storedThreshold = moneyCents(body.storedThreshold, centsToMoney(current.stored_threshold_cents || (upgradeType === 'recharge' ? current.threshold_cents : 0)));
  const spendThreshold = moneyCents(body.spendThreshold, centsToMoney(current.spend_threshold_cents || (['spend', 'monthly'].includes(upgradeType) ? current.threshold_cents : 0)));
  const threshold = spendThreshold || storedThreshold || legacyThreshold;
  const discount = Number(body.discount ?? current.discount ?? 1), pointsRate = Number(body.pointsRate ?? current.points_rate ?? 1);
  const duration = Number(body.durationDays ?? current.duration_days ?? 0), sort = Number(body.sort ?? current.sort ?? 0), conditionMode = body.conditionMode ?? current.condition_mode ?? 'any', status = body.status ?? current.status ?? 'active';
  const badgeColor = String(body.badgeColor ?? current.badge_color ?? '#C77F52').trim();
  if (!name || name.length > 30 || !['spend','recharge','monthly'].includes(upgradeType) || !Number.isSafeInteger(threshold) || threshold <= 0 || !Number.isSafeInteger(storedThreshold) || storedThreshold < 0 || !Number.isSafeInteger(spendThreshold) || spendThreshold < 0 || (storedThreshold <= 0 && spendThreshold <= 0) || !['any','all'].includes(conditionMode) || !validBadgeColor(badgeColor) || !Number.isFinite(discount) || discount <= 0 || discount > 1 || !Number.isFinite(pointsRate) || pointsRate < 0 || pointsRate > 100 || !Number.isInteger(duration) || duration < 0 || duration > 3650 || !Number.isInteger(sort) || sort < 0 || sort > 9999 || !['active','inactive'].includes(status)) return null;
  return { name, upgradeType, threshold, storedThreshold, spendThreshold, conditionMode, badgeColor, discount, pointsRate, duration, sort, status };
};
router.post('/admin/member-tiers', (req, res) => {
  const t = tierInput(req.body || {});
  if (!t) return res.status(400).json({ message: '等级名称、升级条件或优惠无效' });
  const id = db.prepare('INSERT INTO member_tiers (store_id, name, upgrade_type, threshold_cents, stored_threshold_cents, spend_threshold_cents, condition_mode, badge_color, discount, points_rate, duration_days, sort, status) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(t.name, t.upgradeType, t.threshold, t.storedThreshold, t.spendThreshold, t.conditionMode, t.badgeColor, t.discount, t.pointsRate, t.duration, t.sort, t.status).lastInsertRowid;
  audit(req, '新增会员等级', t.name); res.status(201).json({ tier: db.prepare('SELECT * FROM member_tiers WHERE id = ?').get(id) });
});
router.patch('/admin/member-tiers/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM member_tiers WHERE id = ? AND store_id = 1').get(req.params.id);
  if (!current) return res.status(404).json({ message: '等级不存在' });
  const t = tierInput(req.body || {}, current);
  if (!t) return res.status(400).json({ message: '等级名称、升级条件或优惠无效' });
  db.transaction(() => {
    db.prepare('UPDATE member_tiers SET name = ?, upgrade_type = ?, threshold_cents = ?, stored_threshold_cents = ?, spend_threshold_cents = ?, condition_mode = ?, badge_color = ?, discount = ?, points_rate = ?, duration_days = ?, sort = ?, status = ? WHERE id = ?').run(t.name, t.upgradeType, t.threshold, t.storedThreshold, t.spendThreshold, t.conditionMode, t.badgeColor, t.discount, t.pointsRate, t.duration, t.sort, t.status, current.id);
    db.prepare('UPDATE users SET member_level = ?, member_discount = ? WHERE member_tier_id = ?').run(t.name, t.discount, current.id);
    audit(req, '修改会员等级', `${current.name} -> ${t.name}`);
  })();
  res.json({ tier: db.prepare('SELECT * FROM member_tiers WHERE id = ?').get(current.id) });
});

router.get('/admin/reports', (req, res) => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const today = todayLocalDate();
  const end = datePattern.test(String(req.query.end || '')) ? String(req.query.end) : today;
  const start = datePattern.test(String(req.query.start || '')) ? String(req.query.start) : db.prepare("SELECT date(?, '-29 day') AS day").get(today).day;
  if (start > end) return res.status(400).json({ message: '开始日期不能晚于结束日期' });
  const totals = db.prepare("SELECT COALESCE(SUM(payable_amount_cents - bonus_paid_cents),0) AS revenue, COALESCE(SUM(bonus_paid_cents),0) AS bonus, COALESCE(SUM(stored_paid_cents),0) AS stored, COALESCE(SUM(wechat_paid_cents),0) AS wechat, COALESCE(SUM(CASE WHEN payment_method = 'offline' THEN payable_amount_cents ELSE offline_paid_cents END),0) AS offline, COALESCE(SUM((SELECT SUM(quantity * cost_price_cents) FROM order_items WHERE order_id = o.id)),0) AS cost FROM orders o WHERE payment_status = 'paid'").get();
  const losses = db.prepare('SELECT COALESCE(SUM(cost_cents),0) AS cost FROM stock_losses').get().cost;
  const balance = db.prepare('SELECT COALESCE(SUM(stored_cents),0) AS stored, COALESCE(SUM(bonus_cents),0) AS bonus FROM wallet_accounts').get();
  const recharge = db.prepare("SELECT COALESCE(SUM(pay_cents),0) AS amount FROM wallet_transactions WHERE type = 'recharge'").get().amount;
  const daily = db.prepare(`SELECT days.day, COALESCE(o.orders,0) AS orders, COALESCE(o.revenue,0) AS revenue, COALESCE(o.order_cost,0) AS order_cost, COALESCE(o.offline,0) AS offline, COALESCE(r.recharge,0) AS recharge, COALESCE(l.loss_cost,0) AS loss_cost FROM (WITH RECURSIVE dates(day) AS (SELECT date(?) UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date(?)) SELECT day FROM dates) days LEFT JOIN (SELECT date(paid_at, 'localtime') AS day, COUNT(*) AS orders, SUM(payable_amount_cents - bonus_paid_cents) AS revenue, SUM((SELECT COALESCE(SUM(quantity * cost_price_cents),0) FROM order_items WHERE order_id = orders.id)) AS order_cost, SUM(CASE WHEN payment_method = 'offline' THEN offline_paid_cents ELSE 0 END) AS offline FROM orders WHERE payment_status = 'paid' AND date(paid_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(paid_at, 'localtime')) o ON o.day = days.day LEFT JOIN (SELECT date(created_at, 'localtime') AS day, SUM(pay_cents) AS recharge FROM wallet_transactions WHERE type = 'recharge' AND date(created_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(created_at, 'localtime')) r ON r.day = days.day LEFT JOIN (SELECT date(created_at, 'localtime') AS day, SUM(cost_cents) AS loss_cost FROM stock_losses WHERE date(created_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(created_at, 'localtime')) l ON l.day = days.day ORDER BY days.day DESC`).all(start, end, start, end, start, end, start, end).map(row => ({ day: row.day, orders: row.orders, revenue: centsToMoney(row.revenue), profit: centsToMoney(row.revenue - row.order_cost - row.loss_cost), recharge: centsToMoney(row.recharge), offline: centsToMoney(row.offline), orderCost: centsToMoney(row.order_cost), lossCost: centsToMoney(row.loss_cost) }));
  const dailyPage = parsePagination(req, 'daily');
  const dailyRows = daily.slice(dailyPage.offset, dailyPage.offset + dailyPage.pageSize);
  res.json({ dateRange: { start, end }, today: daily.find(row => row.day === today) || daily[0], ...(req.staff.role === 'super' ? { totals: { revenue: centsToMoney(totals.revenue), bonusUsed: centsToMoney(totals.bonus), storedUsed: centsToMoney(totals.stored), wechatReceived: centsToMoney(totals.wechat), offlineReceived: centsToMoney(totals.offline), rechargeReceived: centsToMoney(recharge), outstandingStored: centsToMoney(balance.stored), outstandingBonus: centsToMoney(balance.bonus), orderCost: centsToMoney(totals.cost), lossCost: centsToMoney(losses), profit: centsToMoney(totals.revenue - totals.cost - losses) } } : {}), daily, dailyRows, dailyPagination: paginationView(dailyPage.page, dailyPage.pageSize, daily.length), byProduct: adminRows("SELECT product_name, SUM(quantity) AS quantity, SUM(paid_price_cents * quantity) AS amount FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.payment_status = 'paid' GROUP BY product_id ORDER BY quantity DESC LIMIT 20").map(row => ({ ...row, amount: centsToMoney(row.amount) })) });
});

router.get('/admin/reports/export', (req, res) => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const today = todayLocalDate();
  const end = datePattern.test(String(req.query.end || '')) ? String(req.query.end) : today;
  const start = datePattern.test(String(req.query.start || '')) ? String(req.query.start) : end;
  if (start > end) return res.status(400).send('开始日期不能晚于结束日期');
  const rows = db.prepare(`WITH RECURSIVE dates(day) AS (SELECT date(?) UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date(?)) SELECT dates.day, COALESCE(o.orders, 0) AS orders, COALESCE(o.revenue, 0) AS revenue, COALESCE(o.offline, 0) AS offline, COALESCE(o.order_cost, 0) AS order_cost, COALESCE(r.recharge, 0) AS recharge FROM dates LEFT JOIN (SELECT date(paid_at, 'localtime') AS day, COUNT(*) AS orders, SUM(payable_amount_cents - bonus_paid_cents) AS revenue, SUM(CASE WHEN payment_method = 'offline' THEN offline_paid_cents ELSE 0 END) AS offline, SUM((SELECT COALESCE(SUM(quantity * cost_price_cents),0) FROM order_items WHERE order_id = orders.id)) AS order_cost FROM orders WHERE payment_status = 'paid' AND date(paid_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(paid_at, 'localtime')) o ON o.day = dates.day LEFT JOIN (SELECT date(created_at, 'localtime') AS day, SUM(pay_cents) AS recharge FROM wallet_transactions WHERE type = 'recharge' AND date(created_at, 'localtime') BETWEEN date(?) AND date(?) GROUP BY date(created_at, 'localtime')) r ON r.day = dates.day ORDER BY dates.day`).all(start, end, start, end, start, end);
  const csv = ['日期,订单数,订单净销售额,充值收款,线下收款,订单商品成本,赠酒报损成本,净利润', ...rows.map(row => { const loss = db.prepare("SELECT COALESCE(SUM(cost_cents),0) AS value FROM stock_losses WHERE date(created_at, 'localtime') = date(?)").get(row.day).value; return [row.day, row.orders, (row.revenue / 100).toFixed(2), (row.recharge / 100).toFixed(2), (row.offline / 100).toFixed(2), (row.order_cost / 100).toFixed(2), (loss / 100).toFixed(2), ((row.revenue - row.order_cost - loss) / 100).toFixed(2)].join(','); })].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="report-${start}-${end}.csv"; filename*=UTF-8''${encodeURIComponent(`经营报表-${start}-${end}.csv`)}`); res.send(`\ufeff${csv}`);
});
