import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../server/env.js', import.meta.url).href;
test('environment loader preserves process values and supports optional files and multiline PEM', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-env-test-'));
  try {
    const file = path.join(work, '.env');
    fs.writeFileSync(file, 'NODE_ENV=production\nECHO_TEST_VALUE=from-file\nECHO_TEST_PEM="line1\nline2"\n');
    const code = `await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({mode:process.env.NODE_ENV,value:process.env.ECHO_TEST_VALUE,pem:process.env.ECHO_TEST_PEM}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ECHO_ENV_FILE: file, ECHO_TEST_VALUE: 'from-process' }, encoding: 'utf8', cwd: work });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { mode: process.env.NODE_ENV || 'production', value: 'from-process', pem: 'line1\nline2' });
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`], { env: { ...process.env, ECHO_ENV_FILE: path.join(work, 'missing.env') }, encoding: 'utf8' });
    assert.equal(missing.status, 0, missing.stderr);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('direct API startup loads .env before opening its database', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-startup-test-'));
  const { spawn } = await import('node:child_process');
  const filename = path.join(work, '.env');
  const dataDir = path.join(work, 'data');
  fs.writeFileSync(filename, `NODE_ENV=production\nHOST=127.0.0.1\nPORT=0\nDATA_DIR="${dataDir}"\nADMIN_INITIAL_PASSWORD=test-password-only\n`);
  const env = { ...process.env, ECHO_ENV_FILE: filename };
  for (const key of ['NODE_ENV', 'HOST', 'PORT', 'DATA_DIR', 'ADMIN_INITIAL_PASSWORD']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`API failed to start: ${output}`)), 10000);
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('Echo HX API listening')) { clearTimeout(timeout); resolve(); } });
      child.stderr.on('data', bytes => { output += bytes; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`API exited early: ${code}, ${output}`)); });
    });
    assert.ok(fs.existsSync(path.join(dataDir, 'echo-hx.sqlite')));
    assert.ok(!fs.existsSync(path.join(work, 'echo-hx.sqlite')));
  } finally { child.kill('SIGTERM'); await exited; fs.rmSync(work, { recursive: true, force: true }); }
});
