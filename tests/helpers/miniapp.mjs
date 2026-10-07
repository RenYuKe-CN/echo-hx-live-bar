import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../miniprogram/', import.meta.url));
const clone = value => JSON.parse(JSON.stringify(value));

export function miniappFixture(options = {}) {
  const store = new Map(), modules = new Map(), calls = [], titles = [], updates = [];
  const profile = options.profile || { user: { id: 1, nickname: 'Luna', phone: '13800138000', avatarUrl: 'https://example.test/avatar.png', memberLevel: '金卡会员', memberColor: '#debd8c', memberExpiresAt: '2026-10-28T23:59:59.000Z', points: 1280 }, wallet: { stored: 500, bonus: 100 }, membership: {} };
  const configuration = { entries: [
    { key: 'app_name', title: options.brandName || '示例酒馆', type: 'text' }, { key: 'home_title', title: '今晚喝点什么？', type: 'text' },
    ...[['orders','我的订单','receipt'],['storage','我的存酒','bottle'],['coupons','我的券包','ticket'],['rewards','兑换中心','gift'],['recharge','会员充值','wallet'],['messages','消息中心','bell']].map(([key,title,icon]) => ({key,title,icon,type:'entry'}))
  ] };
  const products = [
    { id: 1, name: '精酿啤酒', category: '啤酒', detail: '冷藏 330ml', price: 38, memberPrice: 34, referenceMemberPrice: 34, stock: 100, tag: '热销' },
    { id: 2, name: '金汤力', category: '鸡尾酒', detail: '杜松子酒 · 汤力水', price: 68, memberPrice: 61, referenceMemberPrice: 61, stock: 100 },
    { id: 3, name: '芝士薯条', category: '小吃', detail: '现炸小食', price: 42, memberPrice: 38, referenceMemberPrice: 38, stock: 100 },
    { id: 4, name: '西柚气泡', category: '无酒精', detail: '无酒精特调', price: 32, memberPrice: 29, referenceMemberPrice: 29, stock: 100 }
  ];
  const cart = options.cart || [{ id: 1, product_id: 1, quantity: 2 }, { id: 2, product_id: 2, quantity: 1 }];
  const app = { globalData: { tableVersion: 0, tableNo: 'A-08', sessionId: 1 }, apiReady: Promise.resolve() };
  const wx = { getStorageSync: key => store.get(key), setStorageSync: (key, value) => store.set(key, value), setNavigationBarTitle: ({title}) => titles.push(title), showToast() {}, navigateTo: data => calls.push({ navigate: data.url }) };
  const api = {
    imageUrl: value => value,
    request: async (url, request = {}) => {
      calls.push({ url, ...request });
      if (options.request) { const result = await options.request(url, request, { profile, configuration, products, cart }); if (result !== undefined) return clone(result); }
      if (url === '/me') return clone(profile);
      if (url === '/mini-page') return clone(configuration);
      if (url === '/me/notification-summary') return clone(options.notices || {});
      if (url === '/me/coupons') return clone(options.coupons || { coupons: [], couponCount: 0 });
      if (url.startsWith('/products')) return { products: clone(products), categories: ['推荐', '啤酒', '鸡尾酒', '小吃', '套餐', '无酒精'], membership: { active: options.isMember !== false } };
      if (url.startsWith('/tables/')) return { session: { id: 1 }, user: clone(profile.user) };
      if (url === '/sessions/1/cart') return { items: clone(cart), totals: { original: 144, member: options.isMember === false ? 144 : 129, discount: options.isMember === false ? 0 : 15 } };
      if (request.method === 'POST' || request.method === 'PATCH') return { ok: true };
      throw new Error('Unexpected mock request: ' + url);
    }
  };
  function loadModule(filename) {
    filename = path.resolve(filename);
    if (filename.endsWith('/utils/api.js')) return api;
    if (filename.endsWith('/utils/subscription.js')) return { hasShownPrompt: () => true };
    if (modules.has(filename)) return modules.get(filename);
    const module = { exports: {} };
    const context = { module, wx, getApp: () => app, console, require: name => loadModule(path.resolve(path.dirname(filename), name + '.js')) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    modules.set(filename, module.exports); return module.exports;
  }
  function loadPage(name) {
    const filename = path.join(root, 'pages', name, name + '.js');
    let definition;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { wx, getApp: () => app, console, Page: value => { definition = value; }, require: name => loadModule(path.resolve(path.dirname(filename), name + '.js')) }, { filename });
    const instance = { ...definition, data: clone(definition.data), setData(value, callback) {
      const patch = clone(value); updates.push(patch);
      for (const [key, entry] of Object.entries(patch)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = entry;
      }
      if (callback) callback.call(this);
    } };
    instance.onLoad?.(); return instance;
  }
  return { loadPage, loadModule, app, api, wx, store, calls, titles, updates, profile, products, cart, configuration };
}
