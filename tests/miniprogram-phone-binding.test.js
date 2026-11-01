import test from 'node:test';
import assert from 'node:assert/strict';
import { miniappFixture } from './helpers/miniapp.mjs';

function checkoutFixture(options = {}) {
  const fixture = miniappFixture(options);
  const page = fixture.loadPage('cart');
  page.setData({ items: [{ id: 1, name: '商品', quantity: 2 }], selectedCouponId: '7', note: '少冰' });
  return { ...fixture, page };
}
const unbound = () => ({ user: { id: 1, phone: '', nickname: '微信用户', avatarUrl: '' } });

test('checkout checks the live profile, cancellation retains the order and repeated taps do not submit', async () => {
  const fixture = checkoutFixture({ profile: unbound() });
  fixture.app.globalData.user = { phone: '13800138000' };
  let modal;
  fixture.wx.showModal = options => { modal = options; };
  const pending = fixture.page.pay();
  await new Promise(resolve => setImmediate(resolve));
  await fixture.page.pay();
  assert.equal(fixture.calls.filter(c => c.url === '/me').length, 1);
  modal.success({ confirm: false }); await pending;
  assert.equal(fixture.calls.some(c => c.method === 'POST'), false);
  assert.equal(fixture.page.data.items.length, 1);
  assert.equal(fixture.page.data.note, '少冰');
  assert.equal(fixture.page.data.selectedCouponId, '7');
  assert.equal(fixture.page.data.submitting, false);
  assert.equal(fixture.app.globalData.checkoutInProgress, false);
});

test('binding goes straight to the phone entry and returns without automatically ordering', async () => {
  const fixture = checkoutFixture({ profile: unbound(), request: async (url, options, { profile }) => {
    if (url === '/me/phone') { profile.user.phone = '13800138001'; return profile; }
    if (url === '/sessions/1/orders') return { order: { payable_amount_cents: 3000 }, payment: { status: 'paid' } };
  } });
  fixture.wx.showModal = options => options.success({ confirm: true });
  fixture.wx.navigateTo = options => { fixture.calls.push({ navigate: options.url }); options.complete?.(); };
  let returned = 0;
  fixture.wx.navigateBack = () => { returned++; };
  await fixture.page.pay();
  assert.equal(fixture.calls.find(c => c.navigate).navigate, '/pages/profile/profile?focus=phone');
  const profile = fixture.loadPage('profile'); await profile.onLoad({ focus: 'phone' });
  assert.equal(profile.data.phoneOnly, true);
  assert.equal(profile.data.profileSaved, false);
  await profile.onPhone({ detail: { code: 'official-authorization-code' } });
  assert.equal(returned, 1);
  assert.equal(fixture.app.globalData.user.phone, '13800138001');
  assert.equal(fixture.app.globalData.profileComplete, false);
  assert.equal(fixture.calls.some(c => c.url === '/sessions/1/orders'), false);
  assert.equal(fixture.page.data.note, '少冰');
  await fixture.page.pay();
  const order = fixture.calls.find(c => c.url === '/sessions/1/orders');
  assert.equal(order.data.note, '少冰'); assert.equal(order.data.userCouponId, '7');
  assert.equal(fixture.page.data.items.length, 0);
});

test('phone authorization denial and binding conflicts keep the entry open for retry', async () => {
  const fixture = miniappFixture({ profile: unbound(), request: async url => {
    if (url === '/me/phone') throw new Error('此手机号已属于其他会员');
  } });
  fixture.wx.navigateBack = () => { throw new Error('must not leave on failure'); };
  const page = fixture.loadPage('profile'); await page.onLoad({ focus: 'phone' });
  await page.onPhone({ detail: { errMsg: 'getPhoneNumber:fail user deny' } });
  assert.match(page.data.error, /没有同意/);
  assert.equal(fixture.calls.some(c => c.url === '/me/phone'), false);
  await page.onPhone({ detail: { code: 'conflicting-phone-code' } });
  assert.match(page.data.error, /其他会员/);
  assert.equal(page.data.busy, false); assert.equal(page.data.phone, '');
});

test('server phone rejection after preflight prompts binding without clearing the checkout', async () => {
  const fixture = checkoutFixture({ request: async url => {
    if (url === '/sessions/1/orders') throw Object.assign(new Error('请先绑定手机号'), { code: 'PHONE_BINDING_REQUIRED' });
  } });
  let prompts = 0;
  fixture.wx.showModal = options => { prompts++; options.success({ confirm: false }); };
  await fixture.page.pay();
  assert.equal(prompts, 1); assert.equal(fixture.page.data.items.length, 1);
  assert.equal(fixture.page.data.note, '少冰'); assert.equal(fixture.page.data.submitting, false);
});

test('profile lookup failure stops checkout without mistaking it for an unbound account', async () => {
  const fixture = checkoutFixture({ request: async url => { if (url === '/me') throw new Error('网络中断'); } });
  const notices = [];
  fixture.wx.showToast = options => notices.push(options.title);
  fixture.wx.showModal = () => { throw new Error('must not prompt on a network failure'); };
  await fixture.page.pay();
  assert.deepEqual(notices, ['网络中断']);
  assert.equal(fixture.calls.some(c => c.method === 'POST'), false);
  assert.equal(fixture.page.data.submitting, false);
});

test('continuing an unpaid order also requires binding and releases its busy state', async () => {
  const fixture = miniappFixture({ profile: unbound() });
  fixture.wx.showModal = options => options.success({ confirm: false });
  const page = fixture.loadPage('order');
  await page.continuePay({ currentTarget: { dataset: { orderNo: 'OLD-ORDER' } } });
  assert.equal(fixture.calls.some(c => c.url?.endsWith('/pay')), false);
  assert.equal(page.data.busyOrderNo, '');
});
