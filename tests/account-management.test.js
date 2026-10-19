import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-account-tests-'));
const password = 'account-fixture-password';
Object.assign(process.env, { DATA_DIR: work, ECHO_ENV_FILE: path.join(work, 'missing.env'), NODE_ENV: 'production', ALLOW_DEMO_USER: 'false', ADMIN_INITIAL_PASSWORD: password });
const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const nativeFetch = globalThis.fetch;
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const tokens = { owner: 'a'.repeat(64), otherDevice: 'b'.repeat(64), manager: 'c'.repeat(64), staff: 'd'.repeat(64), otherSuper: 'e'.repeat(64) };
let server, base;

before(async () => {
  const initialHash = db.prepare('SELECT password_hash FROM staff_accounts WHERE id=1').get().password_hash;
  for (const [id, username, role, permissions] of [[2, 'manager', 'manager', ['accounts']], [3, 'staff', 'staff', ['accounts']], [4, 'other_owner', 'super', []]]) {
    db.prepare('INSERT INTO staff_accounts(id,username,display_name,password_hash,role,permissions) VALUES(?,?,?,?,?,?)').run(id, username, username, initialHash, role, JSON.stringify(permissions));
  }
  server = await new Promise(resolve => { const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
beforeEach(() => {
  db.prepare("UPDATE staff_accounts SET username='admin',display_name='超级管理员' WHERE id=1").run();
  for (const table of ['staff_sessions', 'operation_logs', 'login_failures']) db.prepare(`DELETE FROM ${table}`).run();
  for (const [key, id] of [['owner', 1], ['otherDevice', 1], ['manager', 2], ['staff', 3], ['otherSuper', 4]]) {
    db.prepare('INSERT INTO staff_sessions(token_hash,account_id,expires_at) VALUES(?,?,?)').run(hash(tokens[key]), id, new Date(Date.now() + 3600000).toISOString());
  }
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(work, { recursive: true, force: true }); });

async function call(url, { token = tokens.owner, method = 'GET', body } = {}) {
  const response = await nativeFetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const edit = (body, token = tokens.owner, id = 1) => call(`/accounts/${id}`, { token, method: 'PATCH', body });
const owner = () => db.prepare('SELECT * FROM staff_accounts WHERE id=1').get();

test('a super administrator renames their own login without changing identity, password or privileges', async () => {
  const original = owner();
  const result = await edit({ username: ' owner_2026 ', displayName: ' 门店店主 ' });
  assert.equal(result.status, 200);
  assert.equal(result.body.account.username, 'owner_2026');
  assert.equal(result.body.account.displayName, '门店店主');
  assert.equal(result.body.account.password_hash, undefined);
  assert.deepEqual(owner(), { ...original, username: 'owner_2026', display_name: '门店店主' });
  assert.equal((await call('/session')).body.account.username, 'owner_2026');
  assert.equal((await call('/session', { token: tokens.otherDevice })).status, 401);
  assert.equal((await call('/session', { token: tokens.manager })).status, 200);
  assert.equal((await call('/session', { token: tokens.otherSuper })).status, 200);
  assert.equal((await call('/login', { token: null, method: 'POST', body: { username: 'admin', password } })).status, 401);
  const login = await call('/login', { token: null, method: 'POST', body: { username: 'owner_2026', password } });
  assert.equal(login.status, 200);
  assert.equal(login.body.account.id, original.id);
  const log = db.prepare("SELECT * FROM operation_logs WHERE action='修改超管账号'").get();
  assert.equal(log.operator, 'admin');
  assert.match(log.detail, /账号 ID 1.*admin → owner_2026/);
});

test('changing only the super administrator display name keeps both devices signed in', async () => {
  const original = owner();
  assert.equal((await edit({ displayName: ' 新的显示名 ' })).status, 200);
  assert.deepEqual(owner(), { ...original, display_name: '新的显示名' });
  for (const token of [tokens.owner, tokens.otherDevice]) {
    const session = await call('/session', { token });
    assert.equal(session.status, 200);
    assert.equal(session.body.account.displayName, '新的显示名');
  }
});

test('an existing username rejects the entire edit without revoking sessions or writing an audit event', async () => {
  const original = owner();
  const result = await edit({ username: 'manager', displayName: '不得部分保存' });
  assert.equal(result.status, 409);
  assert.match(result.body.message, /已存在/);
  assert.deepEqual(owner(), original);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM staff_sessions WHERE account_id=1').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operation_logs').get().n, 0);
});

test('invalid profile values and privilege or password edits cannot alter the super administrator', async () => {
  const original = owner();
  for (const body of [{}, { username: '' }, { username: 'ab' }, { username: 'x'.repeat(33) }, { username: '店主' }, { username: 'owner-name' }, { username: 123 }, { username: null }, { displayName: '  ' }, { displayName: '名'.repeat(51) }, { displayName: {} }, { displayName: null }, { username: 'new_owner', role: 'staff' }, { status: 'disabled' }, { permissions: [] }, { workspace: 'waiter' }, { password: 'another-valid-password' }]) {
    assert.equal((await edit(body)).status, 400, JSON.stringify(body));
    assert.deepEqual(owner(), original);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM staff_sessions WHERE account_id=1').get().n, 2);
});

test('other accounts cannot edit an owner even when granted the accounts module', async () => {
  const original = owner();
  for (const token of [tokens.manager, tokens.staff, tokens.otherSuper]) assert.equal((await edit({ username: 'takeover' }, token)).status, 403);
  assert.equal((await edit({ username: 'takeover' }, null)).status, 401);
  assert.equal((await edit({ username: 'other_renamed' }, tokens.owner, 4)).status, 403);
  assert.deepEqual(owner(), original);
  assert.equal((await edit({ username: 'valid_owner' }, tokens.owner, 99999)).status, 404);
});
