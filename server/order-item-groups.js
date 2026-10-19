import { db, centsToMoney } from './db.js';

// Display groups keep the immutable source IDs. Money, stock and delivery
// continue to be posted against the original cent-allocated order lines.
export function displayOrderItems(orderId, rows, { prices=false }={}) {
  if(!rows.length)return [];
  const recipes=new Map(db.prepare('SELECT id,components_json FROM order_bundle_groups WHERE order_id=?').all(orderId).map(group=>{
    let parts=[];try{parts=JSON.parse(group.components_json);}catch{}
    return [group.id,new Map((Array.isArray(parts)?parts:[]).filter(part=>part&&typeof part==='object').map(part=>[Number(part.id??part.productId),part.name]))];
  }));
  const groups=new Map();
  for(const row of rows) {
    const productId=row.productId??row.product_id,unit=row.unit||row.unit_snapshot||'件';
    const key=JSON.stringify([productId,unit]);
    const name=recipes.get(row.bundleGroupId??row.bundle_group_id)?.get(productId)||row.name||row.product_name;
    let group=groups.get(key);
    if(!group){group={id:row.id,productId,name,unit,quantity:0,deliveredQuantity:0,cancelledQuantity:0,returnedQuantity:0,readyQuantity:0,deliveringQuantity:0,unpreparedQuantity:0,refundedQuantity:0,refundAvailableQuantity:0,refundBaseQuantity:0,refundSelectable:false,itemIds:[],imageUrl:row.imageUrl||row.image_url||''};if(prices)Object.assign(group,{originalCents:0,paidCents:0,originalPrices:new Set(),paidPrices:new Set()});groups.set(key,group);}
    const quantity=Number(row.quantity)||0,delivered=row.deliveredQuantity??row.delivered_quantity??0,cancelled=row.cancelledQuantity??row.cancelled_quantity??0,ready=row.readyQuantity??row.ready_quantity??0,delivering=row.deliveringQuantity??row.delivering_quantity??0;
    group.quantity+=quantity;group.deliveredQuantity+=delivered;group.cancelledQuantity+=cancelled;
    group.returnedQuantity+=row.returnedQuantity??((row.returned_quantity||0)+(row.returned_delivered_quantity||0));
    group.readyQuantity+=ready;group.deliveringQuantity+=delivering;
    group.unpreparedQuantity+=row.unpreparedQuantity??Math.max(0,quantity-delivered-cancelled-ready-delivering);
    group.refundedQuantity+=row.refundedQuantity||0;group.refundAvailableQuantity+=row.refundAvailableQuantity||0;group.refundBaseQuantity+=row.refundBaseQuantity||0;group.refundSelectable ||= !!row.refundSelectable;
    group.itemIds.push(row.id);
    if(prices){const original=row.original_price_cents??Math.round(row.originalPrice*100),paid=row.paid_price_cents??Math.round(row.paidPrice*100);group.originalCents+=original*quantity;group.paidCents+=paid*quantity;group.originalPrices.add(original);group.paidPrices.add(paid);}
  }
  return [...groups.values()].map(group=>{
    if(prices){group.originalSubtotal=centsToMoney(group.originalCents);group.paidSubtotal=centsToMoney(group.paidCents);group.originalPrice=group.originalPrices.size===1?centsToMoney([...group.originalPrices][0]):null;group.paidPrice=group.paidPrices.size===1?centsToMoney([...group.paidPrices][0]):null;delete group.originalCents;delete group.paidCents;delete group.originalPrices;delete group.paidPrices;}
    return group;
  });
}
