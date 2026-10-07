import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beginRestore, endRestore, trackApiRequest, withBackgroundTask } from '../server/maintenance.js';

test('restore waits for active reconciliation and prevents new background tasks', async () => {
  const restoreResponse = new EventEmitter();
  trackApiRequest({}, restoreResponse, () => {});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reconciliation = withBackgroundTask(() => gate);
  let ready = false;
  const restore = beginRestore().then(() => { ready = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false);
    let ran = false;
    await withBackgroundTask(() => { ran = true; });
    assert.equal(ran, false);
    release(); await reconciliation; await restore;
    assert.equal(ready, true);
    await assert.rejects(beginRestore(), /已有备份恢复/);
  } finally { release(); await reconciliation; endRestore(); restoreResponse.emit('finish'); }
});
