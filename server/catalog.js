import { db, centsToMoney } from './db.js';

export const CART_HOLD_MS = 10 * 60 * 1000;
// Cart holds are independent of payment reservations. Expired/closed carts stop
// consuming stock immediately, even before the background cleanup runs.
const liveHoldsSql = `FROM cart_stock_holds h JOIN cart_items ci ON ci.id=h.cart_item_id
  JOIN table_sessions s ON s.id=ci.session_id
  WHERE ci.status='pending' AND s.status='open' AND h.expires_at>?`;
export function cartHeldStock(productId, excludeSessionId = 0) {
  return db.prepare(`SELECT COALESCE(SUM(h.quantity),0) AS quantity ${liveHoldsSql} AND h.product_id=? AND ci.session_id!=?`).get(Date.now(), productId, Number(excludeSessionId)).quantity;
}
export function cartHoldTotals() { return new Map(db.prepare(`SELECT h.product_id, SUM(h.quantity) AS quantity ${liveHoldsSql} GROUP BY h.product_id`).all(Date.now()).map(row => [row.product_id, row.quantity])); }
export const availableBasicStock = (product, excludeSessionId = 0) => Math.max(0, product.stock - product.reserved_stock - cartHeldStock(product.id, excludeSessionId));
export function cleanupCartHolds() {
  db.prepare(`DELETE FROM cart_stock_holds WHERE expires_at<=? OR cart_item_id IN (
    SELECT ci.id FROM cart_items ci JOIN table_sessions s ON s.id=ci.session_id WHERE ci.status!='pending' OR s.status!='open')`).run(Date.now());
}
export function releaseCartHolds(sessionId) {
  db.prepare('DELETE FROM cart_stock_holds WHERE cart_item_id IN (SELECT id FROM cart_items WHERE session_id=?)').run(sessionId);
}
export const pendingCartItems = sessionId => db.prepare("SELECT * FROM cart_items WHERE session_id=? AND status='pending' ORDER BY id").all(sessionId);
export function cartReservation(sessionId) {
  const items = pendingCartItems(sessionId);
  if (!items.length) return { reserved: true, expiresAt: null };
  let expiresAt = Infinity;
  try {
    for (const item of items) {
      const required = stockRequirements([item]);
      const held = db.prepare(`SELECT h.* ${liveHoldsSql} AND ci.id=?`).all(Date.now(), item.id);
      if (held.length !== required.size || held.some(h => required.get(h.product_id) !== h.quantity)) return { reserved: false, expiresAt: null };
      expiresAt = Math.min(expiresAt, ...held.map(h => h.expires_at));
    }
    return { reserved: true, expiresAt: new Date(expiresAt).toISOString() };
  } catch { return { reserved: false, expiresAt: null }; }
}
export function assertCartReservation(sessionId) {
  if (!cartReservation(sessionId).reserved) throw Object.assign(catalogError('购物车库存已释放或商品发生变化，请重新锁定库存后确认订单'), { code: 'CART_RESERVATION_EXPIRED' });
}
export function reserveCart(sessionId) {
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM table_sessions WHERE id=? AND status='open'").get(sessionId)) throw catalogError('桌台已结束，请重新选择');
    const items = pendingCartItems(sessionId);
    assertStock(items, sessionId);
    cleanupCartHolds();
    releaseCartHolds(sessionId);
    const expiresAt = Date.now() + CART_HOLD_MS;
    const insert = db.prepare('INSERT INTO cart_stock_holds(cart_item_id,product_id,quantity,expires_at) VALUES(?,?,?,?)');
    for (const item of items) for (const [id, quantity] of stockRequirements([item])) insert.run(item.id, id, quantity, expiresAt);
    return { reserved: true, expiresAt: items.length ? new Date(expiresAt).toISOString() : null };
  })();
}
// Reductions must remain possible for expired/unavailable items. Release only
// that row's old claims first; if the full cart cannot be renewed, keep the
// other valid claims with their original deadlines and report it as unreserved.
export function reduceCartHold(item, quantity) {
  if (quantity > 0) db.prepare('UPDATE cart_stock_holds SET quantity=quantity*?/? WHERE cart_item_id=?').run(quantity,item.quantity,item.id);
  else db.prepare('DELETE FROM cart_stock_holds WHERE cart_item_id=?').run(item.id);
  try { reserveCart(item.session_id); } catch { /* Keep reductions and the remaining original deadlines. */ }
}

export const catalogError = (message, status = 409) => Object.assign(new Error(message), { status });
export function componentsFor(productId) {
  return db.prepare(`SELECT p.*,bc.quantity AS component_quantity FROM bundle_components bc JOIN products p ON p.id=bc.product_id WHERE bc.bundle_id=? ORDER BY p.id`).all(productId);
}
export function catalogProduct(row, costs = false, holds = cartHoldTotals()) {
  if (!row) return null;
  const components = row.kind === 'bundle' ? componentsFor(row.id) : [];
  const free = product => Math.max(0, product.stock - product.reserved_stock - (holds.get(product.id) || 0));
  const available = product => product.status === 'active' || product.auto_unlisted ? free(product) : 0;
  const availableStock = row.kind === 'bundle'
    ? (components.length ? Math.min(...components.map(p => Math.floor(available(p) / p.component_quantity))) : 0)
    : free(row);
  const cost = row.kind === 'bundle' ? components.reduce((n,p) => n + p.cost_cents * p.component_quantity, row.extra_cost_cents) : row.cost_cents;
  const product = { ...row, physicalStock: row.kind === 'bundle' ? null : row.stock,
    reservedStock: row.kind === 'bundle' ? null : row.reserved_stock + (holds.get(row.id) || 0), orderReservedStock: row.kind === 'bundle' ? null : row.reserved_stock, cartReservedStock: row.kind === 'bundle' ? null : (holds.get(row.id) || 0), availableStock,
    price: centsToMoney(row.price_cents), memberPrice: row.member_price_cents == null ? null : centsToMoney(row.member_price_cents),
    warning: row.kind === 'basic' && availableStock <= row.safety_stock,
    replenishQuantity: row.kind === 'basic' ? Math.max(0, row.target_stock - availableStock) : 0,
    components: components.map(p => ({ productId: p.id, name: p.name, quantity: p.component_quantity, unit: p.unit, availableStock: free(p), ...(costs ? { cost: centsToMoney(p.cost_cents) } : {}) })) };
  if (costs) { product.calculatedCost = centsToMoney(cost); product.cost_cents = cost; }
  else for (const key of ['cost_cents','extra_cost_cents','reference_cost_cents']) delete product[key];
  return product;
}
export const getCatalogProduct = (id, costs = false) => catalogProduct(db.prepare('SELECT p.*,c.name AS category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?').get(id), costs);

export function cartAvailability(sessionId) {
  const stockByProduct = {}, remainingByProduct = {};
  const reserved = cartReservation(sessionId), holds = cartHoldTotals();
  for (const p of db.prepare('SELECT * FROM products').all()) {
    const available = catalogProduct(p, false, holds).availableStock;
    stockByProduct[p.id] = available;
    remainingByProduct[p.id] = p.status === 'active' ? available : 0;
  }
  return { stockByProduct, remainingByProduct, reservation: reserved };
}

export function stockRequirements(items) {
  const required = new Map();
  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(item.product_id ?? item.productId);
    if (!product || product.status !== 'active') throw catalogError('商品已下架，请刷新菜单');
    const parts = product.kind === 'bundle' ? componentsFor(product.id) : [{ ...product, component_quantity: 1 }];
    if (!parts.length) throw catalogError(`套餐“${product.name}”尚未配置组成货品`);
    for (const part of parts) {
      if (part.kind !== 'basic' || (part.status !== 'active' && !part.auto_unlisted)) throw catalogError(`货品“${part.name}”暂不可用`);
      required.set(part.id, (required.get(part.id) || 0) + part.component_quantity * item.quantity);
    }
  }
  return required;
}
export function assertStock(items, excludeSessionId = 0) {
  const required = stockRequirements(items);
  for (const [id, quantity] of required) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (availableBasicStock(product, excludeSessionId) < quantity) throw catalogError(`货品“${product.name}”库存不足，需要 ${quantity} ${product.unit}，可售 ${availableBasicStock(product, excludeSessionId)} ${product.unit}`);
  }
  return required;
}
export function reserveStock(requirements) {
  for (const [id, quantity] of requirements) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (!product || availableBasicStock(product) < quantity) throw catalogError('库存发生变化，请重新查询');
    if (!db.prepare('UPDATE products SET reserved_stock=reserved_stock+? WHERE id=? AND kind=\'basic\' AND stock-reserved_stock>=?').run(quantity,id,quantity).changes) throw catalogError('库存发生变化，请重新查询');
  }
}

// Allocate whole cents, then split only rounding residues into stable lines.
// The existing refund and fulfillment code continues to use integer unit prices.
function allocate(total, weights) {
  const sum = weights.reduce((n,w) => n+w,0);
  const values = weights.map(w => Math.floor(total*w/sum));
  const ranked = weights.map((w,i) => ({ i, remainder: total*w/sum-values[i] })).sort((a,b) => b.remainder-a.remainder || a.i-b.i);
  for (let n=total-values.reduce((s,v) => s+v,0), i=0; i<n; i++) values[ranked[i].i]++;
  return values;
}
export function insertSaleItems(orderId, productId, quantity, { cartItemId = null, paidPrice, originalPrice, name, snapshot } = {}) {
  const product = snapshot?.product || db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  const insert = db.prepare('INSERT INTO order_items(order_id,cart_item_id,product_id,product_name,quantity,original_price_cents,paid_price_cents,cost_price_cents,bundle_group_id,unit_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const original = originalPrice ?? product.price_cents, paid = paidPrice ?? original;
  if (product.kind !== 'bundle') { insert.run(orderId,cartItemId,product.id,name || product.name,quantity,original,paid,product.cost_cents,null,product.unit); return; }
  const components = snapshot?.components || componentsFor(productId);
  if (!components.length) throw catalogError('套餐组成不能为空');
  const totalCost = components.reduce((n,p) => n+p.cost_cents*p.component_quantity*quantity, product.extra_cost_cents*quantity);
  const groupId = db.prepare('INSERT INTO order_bundle_groups(order_id,product_id,name,quantity,recipe_version,original_cents,paid_cents,cost_cents,components_json) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(orderId,productId,name || product.name,quantity,product.recipe_version,original*quantity,paid*quantity,totalCost,JSON.stringify(components)).lastInsertRowid;
  const weights = components.map(p => Math.max(1,p.price_cents)*p.component_quantity);
  const originalAmounts = allocate(original*quantity,weights), paidAmounts = allocate(paid*quantity,weights);
  components.forEach((part,index) => {
    const count = part.component_quantity*quantity;
    const amounts = [originalAmounts[index],paidAmounts[index],part.cost_cents*count+(index===0 ? product.extra_cost_cents*quantity : 0)];
    const floors = amounts.map(a => Math.floor(a/count)), remainders = amounts.map(a => a%count);
    const cuts = [...new Set([0,...remainders,count])].sort((a,b) => a-b);
    for (let i=1;i<cuts.length;i++) {
      const prices = floors.map((v,j) => v+(cuts[i-1]<remainders[j] ? 1 : 0));
      insert.run(orderId,cartItemId,part.id,`${part.name}（${name || product.name}）`,cuts[i]-cuts[i-1],...prices,groupId,part.unit);
    }
  });
}
export function recipeSnapshot(productId) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product || product.kind !== 'bundle') throw catalogError('请选择已配置组成货品的套餐');
  return { product, components: componentsFor(productId) };
}
export function logStock(productId, change, reason, { orderId = null, channel = 'adjustment', operator = '' } = {}) {
  const product = db.prepare('SELECT stock,unit FROM products WHERE id=?').get(productId);
  db.prepare('INSERT INTO inventory_logs(product_id,change_quantity,stock_after,reason,order_id,channel,operator,unit_snapshot) VALUES(?,?,?,?,?,?,?,?)').run(productId,change,product.stock,reason,orderId,channel,operator,product.unit);
}
