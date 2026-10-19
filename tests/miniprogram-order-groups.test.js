import test from 'node:test';
import assert from 'node:assert/strict';
import {miniappFixture} from './helpers/miniapp.mjs';

test('customer order and refund controls show one product while preserving exact cent-priced selections',async()=>{
  const order={orderNo:'GROUPED-ORDER',paymentStatus:'paid',originalAmount:30.01,payableAmount:30.01,refundableAmount:20.01,refundPaymentRemaining:30.01,canRefund:true,
    items:[{id:101,name:'啤酒（套餐）',productId:1,quantity:1,paidPrice:10.01,originalPrice:10.01,paidSubtotal:10.01,originalSubtotal:10.01,deliveredQuantity:0,refundAvailableQuantity:1,refundBaseQuantity:1,refundSelectable:true},
      {id:102,name:'啤酒（套餐）',productId:1,quantity:2,paidPrice:10,originalPrice:10,paidSubtotal:20,originalSubtotal:20,deliveredQuantity:1,refundAvailableQuantity:1,refundBaseQuantity:2,refundSelectable:true}],
    displayItems:[{id:101,itemIds:[101,102],name:'啤酒',productId:1,quantity:3,paidPrice:null,originalPrice:null,paidSubtotal:30.01,originalSubtotal:30.01,deliveredQuantity:1,refundAvailableQuantity:2,refundBaseQuantity:3,refundSelectable:true}]};
  const fixture=miniappFixture({request:async url=>{if(url==='/me/orders/GROUPED-ORDER')return{order};}}),page=fixture.loadPage('order-detail');
  page.setData({orderNo:'GROUPED-ORDER'});await page.loadOrder();
  assert.equal(page.data.order.displayItems.length,1);assert.equal(page.data.order.displayItems[0].quantity,3);assert.equal(page.data.order.displayItems[0].paidSubtotalText,'30.01');assert.equal(page.data.order.displayItems[0].hasUnitPrice,false);
  const change=delta=>page.changeRefundQuantity({currentTarget:{dataset:{index:0,delta}}});
  change(1);assert.deepEqual(page.data.refundItems,[{orderItemId:101,quantity:1}]);assert.equal(page.data.refundAmountText,'10.01');
  change(1);assert.deepEqual(page.data.refundItems,[{orderItemId:101,quantity:1},{orderItemId:102,quantity:1}]);assert.equal(page.data.refundAmountText,'20.01');
  change(1);assert.equal(page.data.order.displayItems[0].refundQuantity,2);assert.equal(page.data.order.items.length,2);
  change(-1);assert.equal(page.data.refundAmountText,'10.01');change(-1);assert.equal(page.data.refundAmountText,'0.00');
});
