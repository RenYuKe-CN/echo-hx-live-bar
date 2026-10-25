import test from 'node:test';
import assert from 'node:assert/strict';
import {miniappFixture} from './helpers/miniapp.mjs';
test('category clicks keep complete product rows, scroll highlights the matching section and touching interrupts a jump',async()=>{
  const fixture=miniappFixture(),page=fixture.loadPage('menu');await page.onShow();const rows=page.data.visibleProducts;
  assert.equal(page.data.sections.length,4);assert.equal(page.data.categories.includes('套餐'),false);
  page.sectionOffsets=[0,250,510,750];fixture.updates.length=0;
  page.selectCategory({currentTarget:{dataset:{category:'小吃'}}});assert.equal(page.data.targetSection,'section-2');assert.equal(page.data.visibleProducts,rows);
  page.onCatalogScroll({detail:{scrollTop:100}});assert.equal(page.data.category,'小吃');
  page.onCatalogScroll({detail:{scrollTop:510}});assert.equal(page.data.category,'小吃');
  page.onCatalogTouch();page.onCatalogScroll({detail:{scrollTop:260}});assert.equal(page.data.category,'鸡尾酒');assert.equal(page.data.sidebarTarget,'category-1');
  assert.ok(fixture.updates.every(update=>!Object.hasOwn(update,'visibleProducts')));
});
test('shared component availability updates bundle controls without replacing product rows',async()=>{
  const fixture=miniappFixture({request:async url=>url==='/sessions/1/cart'?{items:[{product_id:1,quantity:1}],totals:{original:38,member:34},stockByProduct:{1:10,2:4},remainingByProduct:{1:9,2:0}}:undefined}),page=fixture.loadPage('menu');await page.onShow();
  assert.equal(page.data.visibleProducts[1].stock,4);assert.equal(page.data.visibleProducts[1].remainingQuantity,0);assert.equal(await page.updateProductQuantity(2,1),false);
});
test('customer menu no longer exposes or requests online group redemption',async()=>{
  const fs=await import('node:fs');
  const config=JSON.parse(fs.readFileSync(new URL('../miniprogram/app.json',import.meta.url),'utf8'));
  assert.ok(!config.pages.some(page=>page.includes('group-buy')));
  const fixture=miniappFixture(),page=fixture.loadPage('menu');await page.onShow();
  assert.equal(page.openGroupBuy,undefined);assert.ok(!fixture.calls.some(c=>c.url?.includes('/group-buy')));
  const markup=fs.readFileSync(new URL('../miniprogram/pages/menu/menu.wxml',import.meta.url),'utf8');assert.ok(!markup.includes('团购兑换'));
});
