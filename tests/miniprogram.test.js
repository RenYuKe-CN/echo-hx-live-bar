import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../miniprogram/utils/api.js', import.meta.url), 'utf8');
function client(wx) {
  const store = new Map([['echoAuthToken', 'expired-token']]);
  const context = { module: { exports: {} }, setTimeout: callback => setTimeout(callback, 0), wx: {
    getStorageSync: key => store.get(key), setStorageSync: (key, value) => store.set(key, value), removeStorageSync: key => store.delete(key), ...wx
  } };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

test('simultaneous expired-session requests share a single login and retry only once', async () => {
  let logins = 0;
  const api = client({
    login: options => { logins++; setTimeout(() => options.success({ code: 'new-code' }), 0); },
    request: options => {
      setTimeout(() => {
        if (options.url.endsWith('/auth/wechat/login')) options.success({ statusCode: 200, data: { token: 'fresh-token' } });
        else if (options.header.authorization === 'Bearer fresh-token') options.success({ statusCode: 200, data: { ok: true } });
        else options.success({ statusCode: 401, data: { message: 'expired' } });
      }, 0);
    }
  });
  const results = await Promise.all([api.request('/me'), api.request('/me/orders')]);
  assert.equal(logins, 1); assert.ok(results.every(result => result.ok));
});

test('persistent unauthorized responses stop after one login retry', async () => {
  let logins = 0, requests = 0;
  const api = client({
    login: options => { logins++; options.success({ code: 'new-code' }); },
    request: options => {
      if (options.url.endsWith('/auth/wechat/login')) options.success({ statusCode: 200, data: { token: 'fresh-token' } });
      else { requests++; options.success({ statusCode: 401, data: { message: 'expired' } }); }
    }
  });
  await assert.rejects(api.request('/me'), /expired/);
  assert.equal(logins, 1); assert.equal(requests, 2);
});

test('client payment success waits for server confirmation', async () => {
  let queries = 0;
  const api = client({
    requestPayment: options => options.success({}),
    request: options => { queries++; options.success({ statusCode: 200, data: { order: { payment_status: queries === 2 ? 'paid' : 'pending' } } }); }
  });
  assert.equal(await api.payWithWechat({}, 'ORDER-1'), true); assert.equal(queries, 2);
});

test('unconfirmed payment stays unconfirmed and cancellation never queries', async () => {
  let queries = 0;
  const api = client({
    requestPayment: options => options.success({}),
    request: options => { queries++; options.success({ statusCode: 200, data: { order: { payment_status: 'pending' } } }); }
  });
  assert.equal(await api.payWithWechat({}, 'ORDER-1'), false); assert.equal(queries, 3);
  const cancelled = client({ requestPayment: options => options.fail({ errMsg: 'requestPayment:fail cancel' }) });
  await assert.rejects(cancelled.payWithWechat({}, 'ORDER-2'), /已取消支付/);
});
