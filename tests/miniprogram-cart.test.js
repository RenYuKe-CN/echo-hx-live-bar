import test from 'node:test';
import assert from 'node:assert/strict';
import { miniappFixture } from './helpers/miniapp.mjs';
const tap=(id,delta)=>({currentTarget:{dataset:{id,delta}}});
function fixture(options={}) {
  let expired=false, failRead=false;
  const fx=miniappFixture({cart:options.cart||[{id:1,product_id:1,quantity:2},{id:2,product_id:2,quantity:1}],coupons:options.coupons,request:async(url,request,state)=>{
    const custom=await options.request?.(url,request,state);if(custom!==undefined)return custom;
    if(url==='/sessions/1/cart') {
      if(failRead)throw new Error('网络中断');
      const items=state.cart.map(i=>({...state.products.find(p=>p.id===i.product_id),...i}));
      const remaining=Object.fromEntries(state.products.map(p=>[p.id,Math.max(0,p.stock-items.filter(i=>i.product_id===p.id).reduce((n,i)=>n+i.quantity,0))]));
      return {items,tableNo:'A-08',membership:{active:true},stockByProduct:remaining,remainingByProduct:remaining,reservation:{reserved:!expired,expiresAt:expired?null:new Date(Date.now()+600000).toISOString()},totals:{original:items.reduce((n,i)=>n+i.price*i.quantity,0),member:items.reduce((n,i)=>n+i.memberPrice*i.quantity,0)}};
    }
    if(url.startsWith('/sessions/1/checkout')) {
      const member=state.cart.reduce((n,i)=>n+state.products.find(p=>p.id===i.product_id).memberPrice*i.quantity,0);
      const original=state.cart.reduce((n,i)=>n+state.products.find(p=>p.id===i.product_id).price*i.quantity,0);
      if(url.includes('?')&&member<100)throw Object.assign(new Error('未达到优惠券使用门槛'),{code:'CHECKOUT_COUPON_INVALID'});
      return {original,member,payable:member,stored:0,bonus:0,usingCoupon:url.includes('?')};
    }
    if(request.method==='PATCH') {
      const id=Number(url.split('/').at(-1)),index=state.cart.findIndex(i=>i.id===id);
      if(index<0)throw new Error('商品已被同桌移除');
      const row=state.cart[index];row.quantity=request.data.delta?row.quantity+request.data.delta:request.data.quantity;
      if(row.quantity===0)state.cart.splice(index,1);return {ok:true};
    }
    if(url==='/sessions/1/cart/reserve'){expired=false;return {ok:true};}
  }});
  fx.wx.showModal=options=>options.success({confirm:true});
  fx.wx.navigateBack=()=>{};
  fx.wx.hideTabBar=()=>fx.calls.push({tabs:'hide'});fx.wx.showTabBar=()=>fx.calls.push({tabs:'show'});
  return {...fx,expire:()=>{expired=true;},failRead:value=>{failRead=value;}};
}

test('confirmation shows the server table number and quantity edits recalculate totals while retaining note and payment selection',async()=>{
  const fx=fixture(),page=fx.loadPage('cart');await page.onShow();page.setData({note:'少冰',method:'wechat'});
  assert.equal(page.data.tableNo,'A-08');assert.equal(page.data.totals.payableText,'129.00');
  assert.equal(await page.changeQuantity(tap(1,1)),true);
  assert.equal(page.data.items[0].quantity,3);assert.equal(page.data.totals.payableText,'163.00');
  assert.equal(page.data.note,'少冰');assert.equal(page.data.method,'wechat');
  assert.equal(await page.changeQuantity(tap(1,-1)),true);assert.equal(page.data.totals.payableText,'129.00');
  assert.equal(fx.calls.filter(c=>c.url?.endsWith('/orders')).length,0);
  page.onHide();assert.equal(fx.timers.size,0);
});

test('confirmation queues different rows, blocks duplicate taps and payment, and preserves voucher quantity limits',async()=>{
  let release,waiting=true;const gate=new Promise(resolve=>{release=resolve;});
  const fx=fixture({cart:[{id:1,product_id:1,quantity:2},{id:2,product_id:2,quantity:1},{id:3,product_id:1,quantity:1,applied_coupon_id:9}],request:async(url,r)=>{if(r.method==='PATCH'&&waiting){waiting=false;await gate;}}}),page=fx.loadPage('cart');await page.onShow();
  const first=page.changeQuantity(tap(1,1)),second=page.changeQuantity(tap(2,1));
  assert.equal(await page.changeQuantity(tap(1,1)),false);await page.pay();
  assert.equal(fx.calls.some(c=>c.url?.endsWith('/orders')),false);assert.equal(page.data.cartBusy,true);
  release();assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(page.data.items[0].quantity,3);assert.equal(page.data.items[1].quantity,2);
  assert.equal(await page.changeQuantity(tap(3,1)),false);assert.equal(page.data.items[2].quantity,1);
  assert.equal(page.data.cartBusy,false);
});

test('removing a row invalidates an unusable coupon, refreshes the quote, and allows removing the last item',async()=>{
  const fx=fixture({coupons:{coupons:[{id:7,status:'available',usable:true,name:'满减券',type:'fixed',amount:10,minOrder:100}]} }),page=fx.loadPage('cart');await page.onShow();
  await page.chooseCoupon({currentTarget:{dataset:{id:'7'}}});
  assert.equal(page.data.selectedCouponId,'7');
  await page.removeItem(tap(2));
  assert.equal(page.data.selectedCouponId,'');assert.match(page.data.couponNotice,/门槛/);assert.equal(page.data.totals.payableText,'68.00');
  await page.removeItem(tap(1));assert.equal(page.data.items.length,0);assert.equal(page.data.totals.payableText,'0.00');
});

test('uncertain mutation response reconciles server quantity once and a read failure prevents payment until retry',async()=>{
  let failPatch=true;
  const fx=fixture({request:async(_url,r,state)=>{if(r.method==='PATCH'&&failPatch){failPatch=false;state.cart[0].quantity++;throw new Error('响应超时');}}}),page=fx.loadPage('cart');await page.onShow();
  assert.equal(await page.changeQuantity(tap(1,1)),false);assert.equal(page.data.items[0].quantity,3);
  assert.equal(fx.calls.filter(c=>c.method==='PATCH').length,1);
  fx.failRead(true);await page.pollInventory();assert.match(page.data.loadError,/网络/);assert.equal(page.data.checkout,null);
  await page.pay();assert.equal(fx.calls.some(c=>c.url?.endsWith('/orders')),false);
  fx.failRead(false);await page.refresh();assert.equal(page.data.loadError,'');assert.equal(page.data.items[0].quantity,3);
});

test('expired holds retain the list and require an explicit relock without submitting an order',async()=>{
  const fx=fixture(),page=fx.loadPage('cart');await page.onShow();page.setData({note:'少冰'});fx.expire();await page.pollInventory();
  assert.equal(page.data.inventoryReserved,false);assert.equal(page.data.items.length,2);assert.match(page.data.reservationText,/重新锁定/);
  await page.pay();assert.equal(fx.calls.some(c=>c.url?.endsWith('/orders')),false);
  await page.relockCart();assert.equal(page.data.inventoryReserved,true);assert.equal(page.data.note,'少冰');
  assert.equal(fx.calls.filter(c=>c.url==='/sessions/1/cart/reserve').length,1);assert.equal(fx.calls.some(c=>c.url?.endsWith('/orders')),false);
});

test('cart drawer previews shared rows, edits quantities, refreshes menu stock without replacing rows, and restores native tabs',async()=>{
  const fx=fixture(),page=fx.loadPage('menu');await page.onShow();await page.openCartPreview();
  assert.equal(page.data.cartPreviewVisible,true);assert.equal(page.data.cartPreviewItems[0].name,'精酿啤酒');assert.equal(fx.calls.at(-2)?.tabs==='hide'||fx.calls.some(c=>c.tabs==='hide'),true);
  const rows=page.data.visibleProducts;fx.updates.length=0;
  assert.equal(await page.changePreviewQuantity(tap(1,1)),true);assert.equal(page.data.cartMap[1],3);assert.equal(page.data.cartPreviewItems[0].quantity,3);assert.equal(page.data.visibleProducts[0].remainingQuantity,97);
  assert.equal(page.data.visibleProducts,rows);assert.ok(!fx.updates.some(p=>Object.hasOwn(p,'visibleProducts')));
  fx.products[0].stock=5;await page.pollInventory();assert.equal(page.data.visibleProducts[0].remainingQuantity,2);assert.equal(page.data.cartPreviewItems[0].canIncrease,true);
  page.preview();assert.equal(page.data.cartPreviewVisible,false);assert.equal(fx.calls.at(-1).navigate,'/pages/cart/cart');assert.ok(fx.calls.some(c=>c.tabs==='show'));
  await page.openCartPreview();page.onHide();assert.equal(page.data.cartPreviewVisible,false);assert.equal(fx.timers.size,0);
});

test('phone permission failures are readable and do not send a bogus binding request',async()=>{
  const fx=fixture(),menu=fx.loadPage('menu'),profile=fx.loadPage('profile');
  const event={detail:{errMsg:'getPhoneNumber:fail operateWXData:fail jsapi has no permission'}};
  menu.onPhone(event);await profile.onPhone(event);
  assert.match(menu.data.authError,/微信手机号授权接口权限/);assert.match(profile.data.error,/门店管理员/);assert.ok(!fx.calls.some(c=>c.url==='/me/phone'));
});
