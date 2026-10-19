import test from 'node:test';
import assert from 'node:assert/strict';
import {distributeQuantities} from '../src/order-quantities.js';
import {refundStockSelection} from '../src/refund-stock-view.js';

test('a combined preparation quantity expands across only its original available lines',()=>{
  const groups=[{id:10,itemIds:[10,11,12]},{id:13,itemIds:[13]}],rows=[{id:10,available:0},{id:11,available:2},{id:12,available:3},{id:13,available:4}];
  assert.deepEqual(distributeQuantities(groups,{10:4,13:1},rows,row=>row.available),[{orderItemId:11,quantity:2},{orderItemId:12,quantity:2},{orderItemId:13,quantity:1}]);
  for(const quantity of [6,-1,1.5,NaN])assert.throws(()=>distributeQuantities(groups,{10:quantity},rows,row=>row.available));
  assert.throws(()=>distributeQuantities([{id:99,itemIds:[99]}],{99:1},rows,row=>row.available));
});
test('grouped refund stock selection respects delivery and per-source return limits',()=>{
  const order={items:[{id:1,quantity:1,delivered_quantity:1},{id:2,quantity:3,delivered_quantity:1}]},groups=[{id:1,itemIds:[1,2]}];
  const options={cancelQuantities:{1:1},returnQuantities:{1:3},restock:true};
  assert.deepEqual(refundStockSelection(order,groups,options),{cancelItems:[{orderItemId:2,quantity:1}],returnItems:[{orderItemId:1,quantity:1},{orderItemId:2,quantity:2}]});
  assert.throws(()=>refundStockSelection(order,groups,{...options,returnQuantities:{1:4}}));
  assert.deepEqual(refundStockSelection(order,groups,{...options,cancelQuantities:{1:0},returnQuantities:{1:4},full:true}).returnItems,[{orderItemId:1,quantity:1},{orderItemId:2,quantity:3}]);
});
test('approving a grouped refund preserves the exact source lines requested by the customer',()=>{
  const order={items:[{id:1,quantity:2},{id:2,quantity:2}]},groups=[{id:1,itemIds:[1,2]}];
  const selection=refundStockSelection(order,groups,{cancelQuantities:{1:1},returnQuantities:{1:1},requested:[{orderItemId:2,quantity:1}],restock:true});
  assert.deepEqual(selection,{cancelItems:[{orderItemId:2,quantity:1}],returnItems:[{orderItemId:2,quantity:1}]});
});
