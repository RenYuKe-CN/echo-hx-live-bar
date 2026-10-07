import test from 'node:test';
import assert from 'node:assert/strict';
import { miniappFixture } from './helpers/miniapp.mjs';

test('menu and membership refresh every visible store name from backend settings', async () => {
  const fixture = miniappFixture({ brandName: '新店名 · LIVE & BAR' });
  const menu = fixture.loadPage('menu'), member = fixture.loadPage('member'), profile = fixture.loadPage('profile');
  await menu.onShow(); await member.onShow(); await profile.onShow();
  assert.equal(menu.data.appName, '新店名 · LIVE & BAR'); assert.equal(member.data.appName, menu.data.appName);
  assert.equal(profile.data.appName, menu.data.appName);
  assert.ok(fixture.titles.every(title => title === menu.data.appName));
  fixture.configuration.entries[0].title = '后台再次修改后的店名';
  await menu.onShow(); await member.onShow(); await profile.onShow();
  assert.equal(menu.data.appName, '后台再次修改后的店名'); assert.equal(member.data.appName, menu.data.appName);
  assert.equal(profile.data.appName, menu.data.appName);
  assert.equal(fixture.store.get('echoMiniPageSettings').appName, menu.data.appName);
});

test('zero balances and coupon counts stay zero rather than fallback examples', async () => {
  const fixture = miniappFixture({ profile: { user: { id: 1, nickname: '会员', points: 0 }, wallet: { stored: 0, bonus: 0 } }, notices: { couponCount: 7 } });
  const member = fixture.loadPage('member'); await member.onShow();
  assert.equal(member.data.storedText, '0.00'); assert.equal(member.data.bonusText, '0.00'); assert.equal(member.data.pointsText, '0');
  assert.equal(member.data.serviceEntries.find(entry => entry.key === 'coupons').badgeCount, 0);
});

test('available quantities account for all shared cart rows and prevent an extra add', async () => {
  const fixture = miniappFixture(); fixture.products[0].stock = 2;
  const menu = fixture.loadPage('menu'); await menu.onShow();
  assert.equal(menu.data.visibleProducts[0].remainingQuantity, 0);
  assert.equal(await menu.updateProductQuantity(1, 1), false);
  assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 0);
});

test('decreasing a product still preserves its separate voucher row', async () => {
  const fixture = miniappFixture({ cart: [{ id: 10, product_id: 1, quantity: 1, applied_coupon_id: 9 }, { id: 11, product_id: 1, quantity: 2 }] });
  const menu = fixture.loadPage('menu'); await menu.onShow(); await menu.updateProductQuantity(1, -1);
  const patch = fixture.calls.find(call => call.method === 'PATCH');
  assert.equal(patch.url, '/sessions/1/cart/items/11'); assert.equal(patch.data.quantity, 1);
});

test('failure has a retry path and does not turn unknown balances into zero', async () => {
  let unavailable = true;
  const fixture = miniappFixture({ request: async url => { if (unavailable && url === '/me') throw new Error('offline'); } });
  const member = fixture.loadPage('member'); await member.onShow();
  assert.equal(member.data.loadError, 'offline'); assert.equal(member.data.storedText, '—');
  unavailable = false; await member.load(); assert.equal(member.data.loadError, ''); assert.equal(member.data.storedText, '500.00');
});

test('failed product photos fall back to an icon and newly uploaded photos are retried', async () => {
  const fixture = miniappFixture(); fixture.products[0].image_url = '/api/product-images/old.png';
  const menu = fixture.loadPage('menu'); await menu.onShow();
  menu.onProductImageError({ currentTarget: { dataset: { id: 1, src: '/api/product-images/old.png' } } });
  assert.equal(menu.data.visibleProducts[0].imageUrl, '');
  assert.equal(menu.data.visibleProducts[0].placeholderIcon, '/assets/icons/beer-muted.png');
  fixture.products[0].image_url = '/api/product-images/new.png'; await menu.onShow();
  assert.equal(menu.data.visibleProducts[0].imageUrl, '/api/product-images/new.png');
});

test('slow cart updates lock only the selected product and preserve all product rows', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = miniappFixture({ request: async (_url, request, { cart }) => {
    if (request.method === 'POST') { await gate; cart[0].quantity++; return { ok: true }; }
  } });
  const menu = fixture.loadPage('menu'); await menu.onShow();
  const untouchedRow = menu.data.visibleProducts[1]; fixture.updates.length = 0;
  const operation = menu.updateProductQuantity(1, 1);
  assert.equal(menu.data.pendingProducts[1], true);
  assert.equal(Boolean(menu.data.pendingProducts[2]), false);
  assert.equal(menu.data.cartBusy, true);
  menu.preview(); assert.equal(fixture.calls.some(call => call.navigate), false);
  release(); assert.equal(await operation, true);
  assert.equal(menu.data.visibleProducts[1], untouchedRow);
  assert.ok(fixture.updates.every(update => !Object.hasOwn(update, 'visibleProducts')));
  assert.equal(menu.data.pendingProducts[1], false);
  assert.equal(menu.data.cartMap[1], 3); assert.equal(menu.data.cartBusy, false);
});

test('different products can be tapped while a request is pending and are processed in order', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = miniappFixture({ request: async (_url, request, { cart }) => {
    if (request.method === 'POST') {
      if (request.data.productId === 1) await gate;
      cart.find(row => row.product_id === request.data.productId).quantity++;
      return { ok: true };
    }
  } });
  const menu = fixture.loadPage('menu'); await menu.onShow();
  const first = menu.updateProductQuantity(1, 1);
  const second = menu.updateProductQuantity(2, 1);
  assert.equal(await menu.updateProductQuantity(1, 1), false);
  assert.equal(menu.data.pendingProducts[1], true); assert.equal(menu.data.pendingProducts[2], true);
  assert.equal(Boolean(menu.data.pendingProducts[3]), false);
  release(); assert.ok((await Promise.all([first, second])).every(Boolean));
  assert.equal(menu.data.cartMap[1], 3); assert.equal(menu.data.cartMap[2], 2);
  assert.equal(menu.data.totalQty, 5); assert.equal(menu.data.cartBusy, false);
  assert.deepEqual(fixture.calls.filter(call => call.method === 'POST').map(call => call.data.productId), [1, 2]);
});

test('a failed item update releases its own lock and does not block the next product', async () => {
  const fixture = miniappFixture({ request: async (_url, request, { cart }) => {
    if (request.method === 'POST') {
      if (request.data.productId === 1) throw new Error('network unavailable');
      cart[1].quantity++; return { ok: true };
    }
  } });
  const menu = fixture.loadPage('menu'); await menu.onShow();
  const first = menu.updateProductQuantity(1, 1), second = menu.updateProductQuantity(2, 1);
  assert.equal(await first, false); assert.equal(await second, true);
  assert.equal(menu.data.pendingProducts[1], false); assert.equal(menu.data.pendingProducts[2], false);
  assert.equal(menu.data.cartBusy, false); assert.equal(menu.data.cartMap[1], 2); assert.equal(menu.data.cartMap[2], 2);
});

test('old cart responses cannot overwrite a later snapshot or a different table', async () => {
  let slow = false, resolveOld;
  const fixture = miniappFixture({ request: async (url) => {
    if (slow && url === '/sessions/1/cart') { slow = false; return new Promise(resolve => { resolveOld = resolve; }); }
  } });
  const menu = fixture.loadPage('menu'); await menu.onShow();
  slow = true; const old = menu.refreshCart();
  fixture.cart[0].quantity = 4; await menu.refreshCart();
  resolveOld({ items: [{ id: 1, product_id: 1, quantity: 1 }], totals: { original: 38, member: 34 } });
  await old; assert.equal(menu.data.cartMap[1], 4);
  slow = true; const previousTable = menu.refreshCart();
  fixture.app.globalData.tableVersion++;
  resolveOld({ items: [{ id: 1, product_id: 1, quantity: 9 }], totals: { original: 342, member: 306 } });
  await previousTable; assert.equal(menu.data.cartMap[1], 4);
});
