function displayItems(order) {
  return order.displayItems || (order.items || []).map(item=>({...item,itemIds:[item.id]}));
}
function refundSelection(order, groups) {
  const rows=new Map(order.items.map(item=>[item.id,item])),result=[];
  for(const group of groups){
    let left=Number(group.refundQuantity||0);
    for(const id of group.itemIds||[group.id]){
      const row=rows.get(id),quantity=row?.refundSelectable?Math.min(left,Number(row.refundAvailableQuantity)||0):0;
      if(quantity){result.push({orderItemId:id,quantity});left-=quantity;}
    }
    if(left)throw new Error('可退款数量已变化，请刷新订单后核对');
  }
  return result;
}
module.exports={displayItems,refundSelection};
