import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import Database from 'better-sqlite3';
import { db, dataDir, databasePath, reopenDatabase } from './db.js';
import { integrationDefinitions } from './config.js';
import { localImageDir } from './storage.js';

const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
const filenamePattern = /^echo-hx-\d{8}-\d{6}-[a-f0-9]{8}\.tar\.gz$/;
const uploadPattern = /^[a-f0-9-]+\.(png|jpg|webp)$/;
const MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024;
const MAX_EXTRACTED_SIZE = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100000;
const sensitiveIntegrationKeys = Object.entries(integrationDefinitions)
  .filter(([, definition]) => definition.secret)
  .map(([key]) => key);
let busy = false;

fs.mkdirSync(backupDir, { recursive: true });

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const stamp = date => `${dateKey(date).replaceAll('-', '')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;

function sanitizeDatabaseSnapshot(destination) {
  const snapshot = new Database(destination);
  try {
    snapshot.transaction(() => {
      snapshot.prepare(`DELETE FROM integration_settings WHERE key IN (${sensitiveIntegrationKeys.map(() => '?').join(',')})`).run(...sensitiveIntegrationKeys);
      // Sessions are machine/process credentials, not business data. Requiring
      // a fresh login also prevents a downloaded backup from reviving access.
      snapshot.prepare('DELETE FROM staff_sessions').run();
      snapshot.prepare('DELETE FROM wechat_sessions').run();
    })();
  } finally {
    snapshot.close();
  }
}

async function createDatabaseSnapshot(destination) {
  await db.backup(destination);
  sanitizeDatabaseSnapshot(destination);
}

export function backupSettings() {
  return db.prepare('SELECT enabled, frequency, run_time AS runTime, retention_days AS retentionDays, last_run_at AS lastRunAt FROM backup_settings WHERE id = 1').get();
}

export function listBackups() {
  return fs.readdirSync(backupDir).filter(name => filenamePattern.test(name)).map(name => {
    const stat = fs.statSync(path.join(backupDir, name));
    return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

function pruneBackups(days) {
  const cutoff = Date.now() - days * 86400000;
  for (const item of listBackups()) {
    if (new Date(item.createdAt).getTime() < cutoff) fs.rmSync(path.join(backupDir, item.name));
  }
}

export async function createBackup({ automated = false } = {}) {
  if (busy) throw new Error('备份或恢复正在进行，请稍后重试');
  busy = true;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-hx-backup-'));
  const name = `echo-hx-${stamp(new Date())}-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
  const destination = path.join(backupDir, name);
  try {
    await createDatabaseSnapshot(path.join(work, 'database.sqlite'));
    const uploadDir = path.join(work, 'uploads');
    fs.mkdirSync(uploadDir);
    const files = {};
    for (const filename of fs.readdirSync(localImageDir)) {
      if (!uploadPattern.test(filename)) continue;
      const source = path.join(localImageDir, filename);
      if (!fs.statSync(source).isFile()) continue;
      const bytes = fs.readFileSync(source);
      fs.writeFileSync(path.join(uploadDir, filename), bytes);
      files[`uploads/${filename}`] = digest(bytes);
    }
    files['database.sqlite'] = digest(fs.readFileSync(path.join(work, 'database.sqlite')));
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ format: 'echo-hx-backup', version: 1, createdAt: new Date().toISOString(), files }));
    await tar.c({ gzip: true, cwd: work, file: destination, portable: true }, ['manifest.json', 'database.sqlite', 'uploads']);
    if (automated) db.prepare('UPDATE backup_settings SET last_run_at = ? WHERE id = 1').run(new Date().toISOString());
    pruneBackups(backupSettings().retentionDays);
    return { name, size: fs.statSync(destination).size };
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    busy = false;
  }
}

function validateArchive(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'echo-hx-backup' || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('备份格式或版本不受支持');
  const actual = ['database.sqlite', ...fs.readdirSync(path.join(dir, 'uploads')).map(name => `uploads/${name}`)].sort();
  const expected = Object.keys(manifest.files).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error('备份文件清单不匹配');
  for (const name of actual) {
    if (name !== 'database.sqlite' && !/^uploads\/[a-f0-9-]+\.(png|jpg|webp)$/.test(name)) throw new Error('备份包含无效图片文件');
    if (digest(fs.readFileSync(path.join(dir, name))) !== manifest.files[name]) throw new Error(`备份文件校验失败：${name}`);
  }
  const restored = new Database(path.join(dir, 'database.sqlite'), { readonly: true, fileMustExist: true });
  try {
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('备份数据库完整性检查失败');
    for (const table of ['users', 'orders', 'products', 'staff_accounts', 'backup_settings']) {
      if (!restored.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error(`备份缺少数据表：${table}`);
    }
  } finally { restored.close(); }
  return manifest;
}

export async function restoreBackup(archivePath) {
  if (busy) throw new Error('备份或恢复正在进行，请稍后重试');
  if (fs.statSync(archivePath).size > MAX_ARCHIVE_SIZE) throw new Error('备份文件超过 1GB，请联系服务器管理员迁移');
  busy = true;
  const work = fs.mkdtempSync(path.join(dataDir, '.restore-'));
  const extracted = path.join(work, 'incoming');
  const previous = path.join(work, 'previous');
  fs.mkdirSync(extracted);
  fs.mkdirSync(previous);
  try {
    let count = 0;
    let extractedSize = 0;
    await tar.x({ file: archivePath, cwd: extracted, strict: true, filter: (name, entry) => {
      count += 1;
      extractedSize += Number(entry.size || 0);
      if (count > MAX_ARCHIVE_ENTRIES || extractedSize > MAX_EXTRACTED_SIZE) throw new Error('备份解压后的文件数量或体积超过安全限制');
      if (!['File', 'Directory'].includes(entry.type)) throw new Error('备份包含不支持的文件类型');
      const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
      if (name.includes('\\') || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('备份包含不安全的文件路径');
      if (!['manifest.json', 'database.sqlite', 'uploads'].includes(normalized) && !/^uploads\/[a-f0-9-]+\.(png|jpg|webp)$/.test(normalized)) throw new Error('备份包含未知文件');
      return true;
    } });
    validateArchive(extracted);
    // Older backups may predate sensitive-field stripping. Do not re-import
    // credentials merely because an administrator uploaded an old archive.
    sanitizeDatabaseSnapshot(path.join(extracted, 'database.sqlite'));
    // Keep a recoverable copy even if disk writes fail partway through a swap.
    await db.backup(path.join(previous, 'database.sqlite'));
    fs.cpSync(localImageDir, path.join(previous, 'uploads'), { recursive: true });
    // This persistent safety copy survives a process or machine failure during restore.
    const safetyName = `echo-hx-${stamp(new Date())}-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
    const safetyDir = path.join(work, 'safety');
    fs.mkdirSync(safetyDir);
    fs.copyFileSync(path.join(previous, 'database.sqlite'), path.join(safetyDir, 'database.sqlite'));
    sanitizeDatabaseSnapshot(path.join(safetyDir, 'database.sqlite'));
    fs.cpSync(path.join(previous, 'uploads'), path.join(safetyDir, 'uploads'), { recursive: true });
    const files = { 'database.sqlite': digest(fs.readFileSync(path.join(safetyDir, 'database.sqlite'))) };
    for (const filename of fs.readdirSync(path.join(safetyDir, 'uploads'))) {
      if (uploadPattern.test(filename)) files[`uploads/${filename}`] = digest(fs.readFileSync(path.join(safetyDir, 'uploads', filename)));
    }
    fs.writeFileSync(path.join(safetyDir, 'manifest.json'), JSON.stringify({ format: 'echo-hx-backup', version: 1, createdAt: new Date().toISOString(), files }));
    await tar.c({ gzip: true, cwd: safetyDir, file: path.join(backupDir, safetyName), portable: true }, ['manifest.json', 'database.sqlite', 'uploads']);
    db.close();
    try {
      fs.copyFileSync(path.join(extracted, 'database.sqlite'), databasePath);
      fs.rmSync(`${databasePath}-wal`, { force: true });
      fs.rmSync(`${databasePath}-shm`, { force: true });
      fs.rmSync(localImageDir, { recursive: true, force: true });
      fs.cpSync(path.join(extracted, 'uploads'), localImageDir, { recursive: true });
      reopenDatabase();
    } catch (error) {
      fs.copyFileSync(path.join(previous, 'database.sqlite'), databasePath);
      fs.rmSync(`${databasePath}-wal`, { force: true });
      fs.rmSync(`${databasePath}-shm`, { force: true });
      fs.rmSync(localImageDir, { recursive: true, force: true });
      fs.cpSync(path.join(previous, 'uploads'), localImageDir, { recursive: true });
      reopenDatabase();
      throw error;
    }
    return { ok: true, restoredAt: new Date().toISOString(), safetyBackup: safetyName };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    busy = false;
  }
}

export function backupFile(name) {
  if (!filenamePattern.test(name)) return null;
  const file = path.join(backupDir, name);
  return fs.existsSync(file) ? file : null;
}

export function startBackupScheduler() {
  const tick = async () => {
    try {
      const settings = backupSettings();
      if (!settings.enabled || busy) return;
      const now = new Date();
      const today = dateKey(now);
      const scheduled = settings.frequency === 'weekly' ? now.getDay() === 1 : true;
      const due = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` >= settings.runTime;
      if (scheduled && due && (!settings.lastRunAt || dateKey(new Date(settings.lastRunAt)) !== today)) {
        const result = await createBackup({ automated: true });
        console.log(`Automatic backup created: ${result.name}`);
      }
    } catch (error) { console.error('Automatic backup failed:', error); }
  };
  setTimeout(tick, 1000).unref();
  setInterval(tick, 60000).unref();
}
