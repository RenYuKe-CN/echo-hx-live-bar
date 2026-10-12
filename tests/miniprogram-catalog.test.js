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
test('unconfigured platforms show a real pending state and cannot submit mock redemption',async()=>{
  const fixture=miniappFixture({request:async url=>url==='/sessions/1/group-buy'?{platforms:{meituan:{ready:false,message:'待开通'}},records:[]}:undefined}),page=fixture.loadPage('group-buy');await page.onShow();page.onCode({detail:{value:'000012345'}});await page.query();
  assert.equal(page.data.error,'待开通');assert.equal(fixture.calls.some(c=>c.url.endsWith('/group-buy/query')),false);
});
test('redemption retries reuse the same durable command and stale table results cannot change the new table',async()=>{
  let complete,fail=true;
  const fixture=miniappFixture({request:async (url,request)=>{
    if(url.endsWith('/group-buy'))return {platforms:{douyin:{ready:true}},records:[]};
    if(url.endsWith('/consume')){if(fail)throw new Error('timeout');return new Promise(resolve=>{complete=resolve;});}
  }}),page=fixture.loadPage('group-buy');await page.onShow();page.data.preview=[{id:'r-1',state:'prepared'}];
  const event={currentTarget:{dataset:{id:'r-1'}}};await page.consume(event);const first=fixture.calls.find(c=>c.url.endsWith('/consume')).data.requestId;
  fail=false;const pending=page.consume(event);await Promise.resolve();const attempts=fixture.calls.filter(c=>c.url.endsWith('/consume'));assert.equal(attempts[1].data.requestId,first);
  fixture.app.globalData.tableVersion++;fixture.app.globalData.sessionId=2;await page.onShow();complete({record:{id:'r-1',state:'success',name:'旧桌套餐',amount:99}});await pending;
  assert.equal(page.data.preview.length,0);assert.equal(page.data.code,'');
});
test('a recovered redemption updates both the preview and history and exposes its delivery order',async()=>{
  const record={id:'mt-recovery',platform:'meituan',state:'success',name:'双人套餐',amount:89.99,orderNo:'GBMT-recovered'};
  const fixture=miniappFixture({request:async url=>url.endsWith('/group-buy')?{platforms:{meituan:{ready:true}},records:[record]}:undefined});
  const page=fixture.loadPage('group-buy');page.data.preview=[{...record,state:'unknown',orderNo:null}];page.data.code='000012345678';page.data.error='结果尚未确认';
  await page.onShow();assert.equal(page.data.preview[0].state,'success');assert.equal(page.data.preview[0].orderNo,'GBMT-recovered');assert.equal(page.data.records[0].state,'success');assert.equal(page.data.code,'');assert.equal(page.data.error,'');
});
test('a client timeout immediately refreshes server status so an in-progress redemption starts polling',async()=>{
  let dispatched=false;
  const fixture=miniappFixture({request:async url=>{
    if(url.endsWith('/consume')){dispatched=true;throw new Error('client timeout');}
    if(url.endsWith('/group-buy'))return {platforms:{meituan:{ready:true}},records:dispatched?[{id:'mt-slow',state:'verifying',name:'双人套餐',amount:89.99}]:[]};
  }}),page=fixture.loadPage('group-buy');await page.onShow();page.data.preview=[{id:'mt-slow',state:'prepared'}];
  await page.consume({currentTarget:{dataset:{id:'mt-slow'}}});
  assert.equal(page.data.preview[0].state,'verifying');assert.equal(page.data.records[0].state,'verifying');assert.equal(page.data.busy,false);
});
