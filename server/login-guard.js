import crypto from 'node:crypto';
import { db } from './db.js';
const windowMs = 10 * 60 * 1000;
const keys = req => [
  ['account:' + crypto.createHash('sha256').update(String(req.body?.username || '').trim()).digest('hex'), 10],
  ['ip:' + crypto.createHash('sha256').update(req.ip || req.socket.remoteAddress || 'unknown').digest('hex'), 50]
];
export function loginGuard(req, res, next) {
  db.prepare('DELETE FROM login_failures WHERE expires_at<=?').run(Date.now());
  for (const [key, limit] of keys(req)) {
    const row = db.prepare('SELECT * FROM login_failures WHERE key=?').get(key);
    if (row?.attempts >= limit) {
      res.set('Retry-After', String(Math.ceil((row.expires_at - Date.now()) / 1000)));
      return res.status(429).json({ message: '登录失败次数过多，请10分钟后重试' });
    }
  }
  next();
}
export function loginFailed(req) {
  for (const [key,limit] of keys(req)) db.prepare('INSERT INTO login_failures(key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1,expires_at=CASE WHEN attempts+1>=? THEN excluded.expires_at ELSE login_failures.expires_at END').run(key,Date.now()+windowMs,limit);
}
export function loginSucceeded(req) { db.prepare('DELETE FROM login_failures WHERE key=?').run(keys(req)[0][0]); }
