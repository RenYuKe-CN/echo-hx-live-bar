import { distributeQuantities } from './order-quantities.js';

export const refundGroups=order=>order.displayItems||(order.items||[]).map(row=>({id:row.id,name:row.product_name,quantity:row.quantity,deliveredQuantity:row.delivered_quantity||0,cancelledQuantity:row.cancelled_quantity||0,returnedQuantity:(row.returned_quantity||0)+(row.returned_delivered_quantity||0),itemIds:[row.id]}));
export function refundStockSelection(order,groups,{cancelQuantities,returnQuantities,requested=null,full=false,restock=false}) {
  const rows=order.items||[],remaining=row=>Math.max(0,row.quantity-(row.delivered_quantity||0)-(row.cancelled_quantity||0));
  // Approval must retain the customer's exact cent-priced source selection.
  const cancelItems=requested?requested.map(row=>({orderItemId:row.orderItemId,quantity:row.quantity})):distributeQuantities(groups,cancelQuantities,rows,remaining);
  const stopped=new Map(cancelItems.map(row=>[row.orderItemId,row.quantity]));
  const returnItems=restock?distributeQuantities(groups,returnQuantities,rows,row=>Math.max(0,Math.min(row.quantity-(row.returned_quantity||0)-(row.returned_delivered_quantity||0),(full?remaining(row):stopped.get(row.id)||0)+(row.delivered_quantity||0)-(row.returned_delivered_quantity||0)))):[];
  return {cancelItems,returnItems};
}
