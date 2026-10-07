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
      const selected = parseRefundItems(refund.items_json);
      for (const item of selected) {
        database.prepare('UPDATE order_items SET returned_quantity = MIN(quantity, returned_quantity + ?) WHERE id = ? AND order_id = ?')
          .run(item.quantity, item.orderItemId, refund.order_id);
      }
      if (!selected.length && refund.order_status === 'refunded' && !refund.delivered_at) {
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
    const remaining = Math.max(0, item.quantity - item.returned_quantity);
    const quantity = fullyRefunded ? remaining : Math.min(remaining, selected.get(item.id) || 0);
    if (!quantity) continue;
    database.prepare('UPDATE order_items SET returned_quantity = returned_quantity + ? WHERE id = ?').run(quantity, item.id);
    database.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(quantity, item.product_id);
    const product = database.prepare('SELECT stock FROM products WHERE id = ?').get(item.product_id);
    database.prepare('INSERT INTO inventory_logs (product_id, change_quantity, stock_after, reason) VALUES (?, ?, ?, ?)')
      .run(item.product_id, quantity, product.stock, `订单退款 ${order.order_no}`);
  }
}

export const orderCostSql = alias => `(SELECT COALESCE(SUM(MAX(oi.quantity - oi.returned_quantity, 0) * oi.cost_price_cents), 0) FROM order_items oi WHERE oi.order_id = ${alias}.id)`;
