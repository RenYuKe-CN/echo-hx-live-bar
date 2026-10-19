import test from 'node:test';
import assert from 'node:assert/strict';
import {miniappFixture} from './helpers/miniapp.mjs';

test('manual selection moves only the chosen cart and resets table-specific coupon and service state',async()=>{
  const fixture=miniappFixture({cart:[{id:1,product_id:1,quantity:2,added_by_user_id:1}],request:async(url,options)=>{
    if(url==='/tables')return{tables:[{id:1,tableNo:'A-08',occupied:true},{id:2,tableNo:'A-09',occupied:false}]};
    if(url==='/tables/select')return{table:{id:2,tableNo:'A-09'},session:{id:2}};
    if(url==='/tables/A-09/session')return{session:{id:2},user:{id:1,nickname:'会员',phone:'13800138000',avatarUrl:'fixture.png'}};
    if(url==='/sessions/2/cart')return{items:[],totals:{original:0,member:0,discount:0}};
    if(url==='/sessions/2/services')return{types:{help:'呼叫服务员'},requests:[]};
  }});
  fixture.wx.showModal=options=>options.success({confirm:true});fixture.wx.showActionSheet=options=>options.success({tapIndex:1});
  const page=fixture.loadPage('menu');await page.onShow();page.setData({selectedCouponId:'old-coupon',couponCheckout:{payable:1},serviceNote:'原桌需求'});
  await page.openTables();await page.chooseTable({currentTarget:{dataset:{id:2}}});
  const selected=fixture.calls.find(call=>call.url==='/tables/select');assert.equal(selected.data.currentSessionId,1);assert.equal(selected.data.cartAction,'move');
  assert.equal(fixture.app.globalData.sessionId,2);assert.equal(fixture.app.globalData.tableNo,'A-09');assert.equal(page.data.selectedCouponId,'');assert.equal(page.data.serviceNote,'');assert.equal(page.data.totalQty,0);
});
test('selection failure preserves current table and reuses the command when retrying an uncertain result',async()=>{
  let attempt=0;const fixture=miniappFixture({request:async(url)=>{
    if(url==='/tables/select'){attempt++;if(attempt===1)throw new Error('连接中断');return{table:{id:2,tableNo:'A-09'},session:{id:2}};}
  }});
  fixture.wx.showModal=options=>options.success({confirm:true});
  const page=fixture.loadPage('menu');await page.onShow();
  assert.equal(await page.switchTable({id:2,tableNo:'A-09',occupied:true}),false);assert.equal(fixture.app.globalData.sessionId,1);assert.equal(fixture.app.globalData.tableNo,'A-08');
  assert.equal(await page.switchTable({id:2,tableNo:'A-09',occupied:true}),true);
  const requests=fixture.calls.filter(call=>call.url==='/tables/select');assert.equal(requests[0].data.requestId,requests[1].data.requestId);
});
test('cancelled occupied-table confirmation and active checkout never switch the customer context',async()=>{
  const fixture=miniappFixture();fixture.wx.showModal=options=>options.success({confirm:false});const page=fixture.loadPage('menu');await page.onShow();
  assert.equal(await page.switchTable({id:2,tableNo:'A-09',occupied:true}),false);assert.equal(fixture.app.globalData.sessionId,1);
  fixture.app.globalData.checkoutInProgress=true;fixture.wx.showModal=()=>{throw new Error('must not reach confirmation during payment');};
  assert.equal(await page.switchTable({id:2,tableNo:'A-09',occupied:false}),false);assert.equal(fixture.calls.some(call=>call.url==='/tables/select'),false);
});
test('late responses from the original table cannot populate the destination cart',async()=>{
  const fixture=miniappFixture();
  const page=fixture.loadPage('cart');const original=fixture.api.request;let release;
  fixture.api.request=async(url,options)=>url==='/sessions/1/cart'?new Promise(resolve=>{release=resolve;}):url.includes('/checkout')?{payable:30,original:30,member:30,stored:0,bonus:0}:{coupons:[]};
  page.refresh();fixture.app.globalData.sessionId=2;fixture.app.globalData.tableVersion++;
  release({items:[{id:1,name:'原桌商品',quantity:1,price:30,memberPrice:30}],membership:{active:false},totals:{original:30,member:30}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(page.data.items.length,0);fixture.api.request=original;
});

test('an ended session clears stale cart state and allows choosing a table again',async()=>{
  const fixture=miniappFixture({request:async url=>{if(url==='/tables/A-08/session')throw Object.assign(new Error('请先选择并确认桌台'),{status:409});}});
  const page=fixture.loadPage('menu');await page.onShow();assert.equal(fixture.app.globalData.sessionId,null);assert.equal(fixture.app.globalData.tableNo,'');assert.equal(page.data.totalQty,0);assert.equal(page.data.tableNo,'');
});
