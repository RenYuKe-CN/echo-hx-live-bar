// Expand one product quantity back into the original source lines in stable ID
// order, so partial preparation still uses the existing server-side checks.
export function distributeQuantities(groups, quantities, rows, available) {
  const source=new Map(rows.map(row=>[row.id,row])),result=[];
  for(const group of groups){
    let remaining=Number(quantities[group.id]??0);
    if(!Number.isSafeInteger(remaining)||remaining<0)throw new Error('商品数量须为非负整数');
    for(const id of group.itemIds||[group.id]){
      const row=source.get(id);if(!row)throw new Error('商品明细已变化，请刷新后核对');
      const quantity=Math.min(remaining,Math.max(0,available(row)));
      if(quantity){result.push({orderItemId:id,quantity});remaining-=quantity;}
    }
    if(remaining)throw new Error('商品可处理数量已变化，请刷新后核对');
  }
  return result;
}
