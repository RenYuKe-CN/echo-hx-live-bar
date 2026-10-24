import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-report-permissions-'));
const password = 'report-permissions-fixture';
Object.assign(process.env, { DATA_DIR: work, ECHO_ENV_FILE: path.join(work, 'missing.env'), NODE_ENV: 'production', ALLOW_DEMO_USER: 'false', ADMIN_INITIAL_PASSWORD: password });
const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const nativeFetch = globalThis.fetch, ownerToken = 'a'.repeat(64);
let server, base, sequence = 0;

before(async () => {
  server = await new Promise(resolve => { const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
beforeEach(() => {
  db.prepare('DELETE FROM staff_sessions').run();
  db.prepare('DELETE FROM staff_accounts WHERE id>1').run();
  db.prepare('INSERT INTO staff_sessions(token_hash,account_id,expires_at) VALUES(?,1,?)').run(crypto.createHash('sha256').update(ownerToken).digest('hex'), new Date(Date.now() + 3600000).toISOString());
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(work, { recursive: true, force: true }); });

async function call(url, { token = ownerToken, method = 'GET', body, binary = false } = {}) {
  const response = await nativeFetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: binary && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json() };
}
async function createAccount(role, permissions, workspace = 'admin') {
  const username = `report_user_${++sequence}`;
  const result = await call('/accounts', { method: 'POST', body: { username, displayName: username, password, role, workspace, ...(permissions === undefined ? {} : { permissions }) } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const login = await call('/login', { token: null, method: 'POST', body: { username, password } });
  assert.equal(login.status, 200);
  return { ...result.body.account, token: login.body.token };
}

test('dashboard and reports can be granted independently to either managed role, including both export formats', async () => {
  const modules = (await call('/accounts')).body.modules;
  assert.ok(modules.includes('dashboard') && modules.includes('reports'));
  for (const role of ['manager', 'staff']) {
    for (const permissions of [['dashboard'], ['reports'], ['dashboard', 'reports'], ['workdesk']]) {
      const account = await createAccount(role, permissions), token = account.token;
      assert.deepEqual((await call('/session', { token })).body.account.permissions, permissions);
      assert.equal((await call('/summary', { token })).status, permissions.includes('dashboard') ? 200 : 403);
      const allowed = permissions.includes('reports'), report = await call('/reports?date=2026-10-13', { token });
      assert.equal(report.status, allowed ? 200 : 403);
      assert.equal((await call('/reports/details?date=2026-10-13', { token })).status, allowed ? 200 : 403);
      assert.equal((await call('/reports/orders/999999?date=2026-10-13', { token })).status, allowed ? 404 : 403);
      if (allowed) {
        assert.equal(report.body.canConfigure, false);
        assert.ok(Object.hasOwn(report.body.totals, 'orderCost'));
        assert.ok(Object.hasOwn(report.body.totals, 'profit'));
      }
      assert.equal((await call('/reports/settings', { token })).status, allowed ? 200 : 403);
      for (const format of ['xlsx', 'csv']) {
        const exported = await call(`/reports/export?date=2026-10-13&format=${format}`, { token, binary: true });
        assert.equal(exported.status, allowed ? 200 : 403);
        if (allowed) assert.ok(format === 'xlsx' ? exported.body.subarray(0, 2).equals(Buffer.from('PK')) : exported.body.toString('utf8').includes('商品毛利估算'));
      }
    }
  }
});

test('granting, switching and revoking the two permissions takes effect for an existing session', async () => {
  const account = await createAccount('manager', ['dashboard']), token = account.token;
  for (const permissions of [['reports'], ['dashboard', 'reports'], ['dashboard'], []]) {
    assert.equal((await call(`/accounts/${account.id}`, { method: 'PATCH', body: { permissions } })).status, 200);
    assert.deepEqual((await call('/session', { token })).body.account.permissions, permissions);
    assert.equal((await call('/summary', { token })).status, permissions.includes('dashboard') ? 200 : 403);
    assert.equal((await call('/reports', { token })).status, permissions.includes('reports') ? 200 : 403);
    assert.equal((await call('/reports/export?date=2026-10-13', { token, binary: true })).status, permissions.includes('reports') ? 200 : 403);
  }
});

test('report readers cannot change global business rules while the super administrator still can', async () => {
  const original = (await call('/reports/settings')).body.settings;
  for (const role of ['manager', 'staff']) {
    const account = await createAccount(role, ['reports']);
    assert.equal((await call('/reports/settings', { token: account.token, method: 'PUT', body: { ...original, exportTitle: '不得保存' } })).status, 403);
    assert.deepEqual((await call('/reports/settings')).body.settings, original);
    assert.equal((await call('/printing', { token: account.token })).status, 403);
    assert.equal((await call('/backups', { token: account.token })).status, 403);
    assert.equal((await call('/orders', { token: account.token })).status, 403);
  }
  assert.equal((await call('/reports')).body.canConfigure, true);
  assert.equal((await call('/summary')).status, 200);
  assert.equal((await call('/reports/settings', { method: 'PUT', body: { ...original, exportTitle: '授权报表测试' } })).status, 200);
});

test('workspace defaults do not grant reports and ordinary accounts cannot grant it to themselves', async () => {
  for (const workspace of ['admin', 'cashier', 'waiter']) {
    const account = await createAccount('staff', undefined, workspace);
    assert.equal(account.permissions.includes('reports'), false);
    assert.equal((await call('/reports', { token: account.token })).status, 403);
    assert.equal((await call(`/accounts/${account.id}`, { token: account.token, method: 'PATCH', body: { permissions: ['reports'] } })).status, 403);
    assert.equal((await call('/session', { token: account.token })).body.account.permissions.includes('reports'), false);
  }
  assert.equal((await call('/reports', { token: null })).status, 401);
  assert.equal((await call('/summary', { token: null })).status, 401);
});
