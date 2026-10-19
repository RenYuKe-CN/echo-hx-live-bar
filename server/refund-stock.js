export function parseRefundItems(value) {
  try {
    const items = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(items)) return [];
    return items.map(item => ({
      orderItemId: Number(item?.orderItemId ?? item?.order_item_id ?? item?.id), quantity: Number(item?.quantity)
    })).filter(item => Number.isSafeInteger(item.orderItemId) && Number.isSafeInteger(item.quantity) && item.quantity > 0);
  } catch { return []; }
}

// Run once when upgrading a database. Record previously returned units without
// changing physical stock; old amount-only refunds cannot identify partial returns.
export function backfillReturnedQuantities(database) {
  database.transaction(() => {
    const refunds = database.prepare("SELECT rt.*, o.status AS order_status, o.delivered_at FROM refund_transactions rt JOIN orders o ON o.id = rt.order_id WHERE rt.status = 'success' ORDER BY rt.id").all();
    for (const refund of refunds) {
      const selected = refund.stock_plan_json == null ? parseRefundItems(refund.items_json) : parseRefundItems(JSON.parse(refund.stock_plan_json).returnItems);
      for (const item of selected) {
        database.prepare('UPDATE order_items SET returned_quantity = MIN(quantity, returned_quantity + ?) WHERE id = ? AND order_id = ?')
          .run(item.quantity, item.orderItemId, refund.order_id);
      }
      if (refund.stock_plan_json == null && !selected.length && refund.order_status === 'refunded' && !refund.delivered_at) {
        database.prepare('UPDATE order_items SET returned_quantity = quantity WHERE order_id = ?').run(refund.order_id);
      }
    }
  })();
}

// The caller owns the transaction, so wallet refund, returned quantities and
// physical inventory either all commit or all roll back.
export function returnOrderStock(database, order, selectedItems, fullyRefunded) {
  if (order.status !== 'awaiting_delivery') return;
  const items = database.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const selected = new Map(selectedItems.map(item => [item.orderItemId, item.quantity]));
  for (const item of items) {
    const remaining = Math.max(0, item.quantity - item.returned_quantity - (item.delivered_quantity || 0));
    const quantity = fullyRefunded ? remaining : Math.min(remaining, selected.get(item.id) || 0);
    if (!quantity) continue;
    database.prepare('UPDATE order_items SET returned_quantity = returned_quantity + ? WHERE id = ?').run(quantity, item.id);
    database.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(quantity, item.product_id);
    const product = database.prepare('SELECT stock,unit FROM products WHERE id = ?').get(item.product_id);
    database.prepare('INSERT INTO inventory_logs (product_id, change_quantity, stock_after, reason,order_id,channel,unit_snapshot) VALUES (?, ?, ?, ?,?,?,?)')
      .run(item.product_id, quantity, product.stock, `订单退款 ${order.order_no}`,order.id,'refund',product.unit);
  }
}

export const orderCostSql = alias => `(SELECT COALESCE(SUM(MAX(oi.quantity - oi.returned_quantity - oi.returned_delivered_quantity, 0) * oi.cost_price_cents), 0) FROM order_items oi WHERE oi.order_id = ${alias}.id)`;

export function refundStockPlan(database, order, input = {}, requested = [], full = false) {
  const rows = database.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
  const strictItems = (value, label) => {
    if (!Array.isArray(value) || value.length > 200 || parseRefundItems(value).length !== value.length) throw new Error(`${label}数量无效`);
    const seen = new Set();
    return parseRefundItems(value).map(item => {
      if (seen.has(item.orderItemId) || !rows.some(row => row.id === item.orderItemId)) throw new Error(`${label}商品重复或不属于本订单`);
      seen.add(item.orderItemId); return item;
    });
  };
  const cancelItems = strictItems(requested.length ? requested : input.cancelItems || [], '停止配送');
  const mode = input.stockMode || 'no_restock';
  if (!['no_restock', 'restock'].includes(mode)) throw new Error('请选择库存处理方式');
  const returnItems = strictItems(input.returnItems || [], '回库');
  if (mode === 'no_restock' && returnItems.length) throw new Error('退款不回库时不能填写回库数量');
  if (mode === 'restock' && (!returnItems.length || input.stockConfirmed !== true)) throw new Error('请填写回库数量并确认货品未开封、可再次销售');
  for (const row of rows) {
    const remaining = Math.max(0, row.quantity - row.delivered_quantity - row.cancelled_quantity);
    let cancel = cancelItems.find(item => item.orderItemId === row.id);
    if (full && remaining) { if (cancel) cancel.quantity = remaining; else cancelItems.push(cancel = { orderItemId: row.id, quantity: remaining }); }
    if ((cancel?.quantity || 0) > remaining) throw new Error(`“${row.product_name}”停止配送数量超出未送达数量`);
    const returned = returnItems.find(item => item.orderItemId === row.id)?.quantity || 0;
    if (returned > row.quantity - row.returned_quantity - row.returned_delivered_quantity || returned > (cancel?.quantity || 0) + row.delivered_quantity - row.returned_delivered_quantity) throw new Error(`“${row.product_name}”回库数量超出本次停止配送及已送达货品数量`);
  }
  return { mode, cancelItems, returnItems };
}

export function applyRefundStockPlan(database, order, plan) {
  for (const item of plan.cancelItems) {
    if (!database.prepare('UPDATE order_items SET cancelled_quantity=cancelled_quantity+? WHERE id=? AND order_id=? AND quantity-delivered_quantity-cancelled_quantity>=?')
      .run(item.quantity,item.orderItemId,order.id,item.quantity).changes) throw new Error('停止配送数量已变化，请核对');
  }
  for (const item of plan.returnItems) {
    const row = database.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(item.orderItemId,order.id);
    const unserved=Math.min(item.quantity,plan.cancelItems.find(line=>line.orderItemId===row.id)?.quantity || 0,Math.max(0,row.quantity-row.delivered_quantity-row.returned_quantity));
    const delivered=item.quantity-unserved;
    if (!database.prepare('UPDATE order_items SET returned_quantity=returned_quantity+?,returned_delivered_quantity=returned_delivered_quantity+? WHERE id=? AND delivered_quantity-returned_delivered_quantity>=?').run(unserved,delivered,row.id,delivered).changes) throw new Error('回库数量已变化，请核对');
    database.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,row.product_id);
    const product = database.prepare('SELECT stock,unit FROM products WHERE id=?').get(row.product_id);
    database.prepare('INSERT INTO inventory_logs(product_id,change_quantity,stock_after,reason,order_id,channel,unit_snapshot) VALUES(?,?,?,?,?,?,?)')
      .run(row.product_id,item.quantity,product.stock,`订单退款 ${order.order_no}`,order.id,'refund',product.unit);
  }
}
