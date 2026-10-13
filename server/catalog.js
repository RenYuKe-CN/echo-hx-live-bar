import { db, centsToMoney } from './db.js';

export const catalogError = (message, status = 409) => Object.assign(new Error(message), { status });
export function componentsFor(productId) {
  return db.prepare(`SELECT p.*,bc.quantity AS component_quantity FROM bundle_components bc JOIN products p ON p.id=bc.product_id WHERE bc.bundle_id=? ORDER BY p.id`).all(productId);
}
export function catalogProduct(row, costs = false) {
  if (!row) return null;
  const components = row.kind === 'bundle' ? componentsFor(row.id) : [];
  const available = product => product.status === 'active' || product.auto_unlisted ? Math.max(product.stock - product.reserved_stock, 0) : 0;
  const availableStock = row.kind === 'bundle'
    ? (components.length ? Math.min(...components.map(p => Math.floor(available(p) / p.component_quantity))) : 0)
    : Math.max(row.stock - row.reserved_stock, 0);
  const cost = row.kind === 'bundle' ? components.reduce((n,p) => n + p.cost_cents * p.component_quantity, row.extra_cost_cents) : row.cost_cents;
  const product = { ...row, physicalStock: row.kind === 'bundle' ? null : row.stock,
    reservedStock: row.kind === 'bundle' ? null : row.reserved_stock, availableStock,
    price: centsToMoney(row.price_cents), memberPrice: row.member_price_cents == null ? null : centsToMoney(row.member_price_cents),
    warning: row.kind === 'basic' && availableStock <= row.safety_stock,
    replenishQuantity: row.kind === 'basic' ? Math.max(0, row.target_stock - availableStock) : 0,
    components: components.map(p => ({ productId: p.id, name: p.name, quantity: p.component_quantity, unit: p.unit, availableStock: Math.max(p.stock-p.reserved_stock,0), ...(costs ? { cost: centsToMoney(p.cost_cents) } : {}) })) };
  if (costs) { product.calculatedCost = centsToMoney(cost); product.cost_cents = cost; }
  else for (const key of ['cost_cents','extra_cost_cents','reference_cost_cents']) delete product[key];
  return product;
}
export const getCatalogProduct = (id, costs = false) => catalogProduct(db.prepare('SELECT p.*,c.name AS category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?').get(id), costs);

export function cartAvailability(items) {
  const demand=new Map(),rows=db.prepare('SELECT * FROM products').all();
  const parts=p=>p.kind==='bundle'?componentsFor(p.id):[{...p,component_quantity:1}];
  for(const item of items){const p=rows.find(p=>p.id===item.product_id);if(p)for(const part of parts(p))demand.set(part.id,(demand.get(part.id)||0)+part.component_quantity*item.quantity);}
  const stockByProduct={},remainingByProduct={};
  for(const p of rows){const components=parts(p);stockByProduct[p.id]=catalogProduct(p).availableStock;remainingByProduct[p.id]=components.length && p.status==='active'?Math.max(0,Math.min(...components.map(c=>Math.floor((Math.max(0,c.stock-c.reserved_stock)-(demand.get(c.id)||0))/c.component_quantity)))):0;}
  return {stockByProduct,remainingByProduct};
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
export function assertStock(items) {
  const required = stockRequirements(items);
  for (const [id, quantity] of required) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (product.stock - product.reserved_stock < quantity) throw catalogError(`货品“${product.name}”库存不足，需要 ${quantity} ${product.unit}，可售 ${Math.max(0,product.stock-product.reserved_stock)} ${product.unit}`);
  }
  return required;
}
export function reserveStock(requirements) {
  for (const [id, quantity] of requirements) {
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
